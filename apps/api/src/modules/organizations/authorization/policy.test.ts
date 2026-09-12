import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { NextFunction, Request, Response } from 'express'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { OrganizationModel } from '../models/organization.model.js'
import { OrganizationMembershipModel } from '../models/organization-membership.model.js'
import { resolveOrganizationContext, requirePermission } from './policy.js'
import { PERMISSIONS } from './permissions.js'
import { ForbiddenError, UnauthenticatedError } from '../../../lib/http-errors.js'
import { ZodError } from 'zod'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_002_policy_test' })
  await Promise.all([OrganizationModel.init(), OrganizationMembershipModel.init()])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([OrganizationModel.deleteMany({}), OrganizationMembershipModel.deleteMany({})])
})

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return { params: {}, ...overrides } as Request
}

function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
  req: Request,
): Promise<{ error?: unknown }> {
  return new Promise((resolve) => {
    const next: NextFunction = ((error?: unknown) => resolve({ error })) as NextFunction
    void middleware(req, {} as Response, next)
  })
}

async function createOrgWithMembership(
  status: 'ACTIVE' | 'SUSPENDED',
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
) {
  const organization = await OrganizationModel.create({
    name: 'Test Org',
    status,
    activeOwnerCount: 1,
  })
  const userId = new Types.ObjectId()
  await OrganizationMembershipModel.create({
    organizationId: organization._id,
    userId,
    role,
    status: 'ACTIVE',
  })
  return { organization, userId }
}

test('resolveOrganizationContext attaches membership context for a valid ACTIVE org + ACTIVE membership', async () => {
  const { organization, userId } = await createOrgWithMembership('ACTIVE', 'ADMIN')
  const req = fakeRequest({
    params: { organizationId: organization._id.toString() },
    auth: { userId: userId.toString(), sessionId: 's1' },
  })

  const { error } = await runMiddleware(resolveOrganizationContext, req)

  assert.equal(error, undefined)
  assert.equal(req.membership?.organizationId, organization._id.toString())
  assert.equal(req.membership?.role, 'ADMIN')
  assert.ok(req.membership?.membershipId)
})

test('resolveOrganizationContext rejects a malformed organizationId with a 422 before any DB lookup', async () => {
  const req = fakeRequest({
    params: { organizationId: 'not-an-object-id' },
    auth: { userId: new Types.ObjectId().toString(), sessionId: 's1' },
  })
  const { error } = await runMiddleware(resolveOrganizationContext, req)
  assert.ok(error instanceof ZodError)
})

test('resolveOrganizationContext gives a generic ForbiddenError for a nonexistent organization', async () => {
  const req = fakeRequest({
    params: { organizationId: new Types.ObjectId().toString() },
    auth: { userId: new Types.ObjectId().toString(), sessionId: 's1' },
  })
  const { error } = await runMiddleware(resolveOrganizationContext, req)
  assert.ok(error instanceof ForbiddenError)
})

test('resolveOrganizationContext gives the identical generic ForbiddenError for a SUSPENDED organization, even for an OWNER', async () => {
  const { organization, userId } = await createOrgWithMembership('SUSPENDED', 'OWNER')
  const req = fakeRequest({
    params: { organizationId: organization._id.toString() },
    auth: { userId: userId.toString(), sessionId: 's1' },
  })
  const { error } = await runMiddleware(resolveOrganizationContext, req)
  assert.ok(error instanceof ForbiddenError)
})

test('resolveOrganizationContext gives a generic ForbiddenError when the caller has no ACTIVE membership', async () => {
  const { organization } = await createOrgWithMembership('ACTIVE', 'MEMBER')
  const req = fakeRequest({
    params: { organizationId: organization._id.toString() },
    auth: { userId: new Types.ObjectId().toString(), sessionId: 's1' }, // different user, not a member
  })
  const { error } = await runMiddleware(resolveOrganizationContext, req)
  assert.ok(error instanceof ForbiddenError)
})

test('the three distinct rejection reasons produce byte-identical error responses (no enumeration)', async () => {
  const { organization: activeOrg } = await createOrgWithMembership('ACTIVE', 'MEMBER')
  const { organization: suspendedOrg, userId: suspendedOwnerId } = await createOrgWithMembership(
    'SUSPENDED',
    'OWNER',
  )

  const notFoundReq = fakeRequest({
    params: { organizationId: new Types.ObjectId().toString() },
    auth: { userId: new Types.ObjectId().toString(), sessionId: 's1' },
  })
  const suspendedReq = fakeRequest({
    params: { organizationId: suspendedOrg._id.toString() },
    auth: { userId: suspendedOwnerId.toString(), sessionId: 's1' },
  })
  const notMemberReq = fakeRequest({
    params: { organizationId: activeOrg._id.toString() },
    auth: { userId: new Types.ObjectId().toString(), sessionId: 's1' },
  })

  const [r1, r2, r3] = await Promise.all([
    runMiddleware(resolveOrganizationContext, notFoundReq),
    runMiddleware(resolveOrganizationContext, suspendedReq),
    runMiddleware(resolveOrganizationContext, notMemberReq),
  ])

  const err1 = r1.error as ForbiddenError
  const err2 = r2.error as ForbiddenError
  const err3 = r3.error as ForbiddenError
  assert.ok(err1 instanceof ForbiddenError)
  assert.ok(err2 instanceof ForbiddenError)
  assert.ok(err3 instanceof ForbiddenError)
  assert.equal(err1.message, err2.message)
  assert.equal(err2.message, err3.message)
  assert.equal(err1.statusCode, err2.statusCode)
  assert.equal(err2.statusCode, err3.statusCode)
})

test('resolveOrganizationContext throws UnauthenticatedError if req.auth is missing (defensive)', async () => {
  const req = fakeRequest({ params: { organizationId: new Types.ObjectId().toString() } })
  const { error } = await runMiddleware(resolveOrganizationContext, req)
  assert.ok(error instanceof UnauthenticatedError)
})

// requirePermission — pure unit tests, no DB needed.

test('requirePermission allows a role that holds the permission', async () => {
  const req = fakeRequest({
    membership: { membershipId: 'm1', organizationId: 'o1', role: 'OWNER' },
  })
  const { error } = await runMiddleware(requirePermission(PERMISSIONS.ROLE_MANAGE), req)
  assert.equal(error, undefined)
})

test('requirePermission rejects a role that lacks the permission', async () => {
  const req = fakeRequest({
    membership: { membershipId: 'm1', organizationId: 'o1', role: 'MEMBER' },
  })
  const { error } = await runMiddleware(requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE), req)
  assert.ok(error instanceof ForbiddenError)
})

test('requirePermission rejects when req.membership is entirely absent (defensive)', async () => {
  const req = fakeRequest()
  const { error } = await runMiddleware(requirePermission(PERMISSIONS.ORGANIZATION_READ), req)
  assert.ok(error instanceof ForbiddenError)
})

test('ADMIN holds organization.read/update/membership.read but not membership.manage/role.manage', async () => {
  const req = fakeRequest({
    membership: { membershipId: 'm1', organizationId: 'o1', role: 'ADMIN' },
  })
  const readResult = await runMiddleware(requirePermission(PERMISSIONS.ORGANIZATION_READ), req)
  const updateResult = await runMiddleware(requirePermission(PERMISSIONS.ORGANIZATION_UPDATE), req)
  const membershipReadResult = await runMiddleware(
    requirePermission(PERMISSIONS.MEMBERSHIP_READ),
    req,
  )
  const membershipManageResult = await runMiddleware(
    requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE),
    req,
  )
  const roleManageResult = await runMiddleware(requirePermission(PERMISSIONS.ROLE_MANAGE), req)

  assert.equal(readResult.error, undefined)
  assert.equal(updateResult.error, undefined)
  assert.equal(membershipReadResult.error, undefined)
  assert.ok(membershipManageResult.error instanceof ForbiddenError)
  assert.ok(roleManageResult.error instanceof ForbiddenError)
})

test('MEMBER holds only organization.read', async () => {
  const req = fakeRequest({
    membership: { membershipId: 'm1', organizationId: 'o1', role: 'MEMBER' },
  })
  const readResult = await runMiddleware(requirePermission(PERMISSIONS.ORGANIZATION_READ), req)
  const updateResult = await runMiddleware(requirePermission(PERMISSIONS.ORGANIZATION_UPDATE), req)

  assert.equal(readResult.error, undefined)
  assert.ok(updateResult.error instanceof ForbiddenError)
})

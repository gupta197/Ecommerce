import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import type { Express } from 'express'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { loadConfig } from '../../../config/env.js'
import { createLogger } from '../../../lib/logger.js'
import { createApp } from '../../../app.js'
import { UserModel } from '../../auth/models/user.model.js'
import { SecuritySessionModel } from '../../auth/models/security-session.model.js'
import { LoginAttemptModel } from '../../auth/models/login-attempt.model.js'
import { OrganizationModel } from '../models/organization.model.js'
import { OrganizationMembershipModel } from '../models/organization-membership.model.js'

// POST /organizations triggers the atomic org+owner-membership transaction —
// a real (even single-node) replica set is required, not a standalone server.
let replSet: MongoMemoryReplSet
let app: Express

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'sec_002_org_route_test' })

  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'sec_002_org_route_test',
    JWT_ACCESS_TOKEN_SECRET: 'x'.repeat(32),
    AUTH_RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_MAX: '1000',
  } as NodeJS.ProcessEnv)
  const logger = createLogger(config)
  app = createApp(config, logger)
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SecuritySessionModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    OrganizationMembershipModel.deleteMany({}),
  ])
})

function extractCookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

async function registerAndLogin(email: string, password: string): Promise<string> {
  await request(app).post('/api/v1/auth/register').send({ email, password })
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password })
  return extractCookieHeader(loginRes)
}

const PASSWORD = 'correct-password-123'

// ---------------------------------------------------------------------------
// Organization creation
// ---------------------------------------------------------------------------

test('POST /organizations creates an organization and makes the caller its OWNER', async () => {
  const cookie = await registerAndLogin('creator@example.com', PASSWORD)

  const res = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookie)
    .send({ name: 'Acme Inc' })

  assert.equal(res.status, 201)
  assert.equal(res.body.data.name, 'Acme Inc')
  assert.equal(res.body.data.activeOwnerCount, 1)

  const membership = await OrganizationMembershipModel.findOne({
    organizationId: res.body.data._id,
  })
  assert.equal(membership?.role, 'OWNER')
})

test('POST /organizations requires authentication', async () => {
  const res = await request(app).post('/api/v1/organizations').send({ name: 'No Auth Org' })
  assert.equal(res.status, 401)
})

test('POST /organizations rejects an empty or whitespace-only name', async () => {
  const cookie = await registerAndLogin('emptyname@example.com', PASSWORD)

  const empty = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookie)
    .send({ name: '' })
  assert.equal(empty.status, 422)

  const whitespace = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookie)
    .send({ name: '   ' })
  assert.equal(whitespace.status, 422)
})

test('POST /organizations rejects an unknown extra field (strict schema)', async () => {
  const cookie = await registerAndLogin('strictorg@example.com', PASSWORD)

  const res = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookie)
    .send({ name: 'Strict Org', activeOwnerCount: 999 })

  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// GET /organizations
// ---------------------------------------------------------------------------

test("GET /organizations returns only the caller's own organizations, derived from req.auth.userId", async () => {
  const cookieA = await registerAndLogin('listA@example.com', PASSWORD)
  const cookieB = await registerAndLogin('listB@example.com', PASSWORD)

  await request(app).post('/api/v1/organizations').set('Cookie', cookieA).send({ name: 'Org A' })
  await request(app).post('/api/v1/organizations').set('Cookie', cookieB).send({ name: 'Org B' })

  const res = await request(app).get('/api/v1/organizations').set('Cookie', cookieA)

  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 1)
  assert.equal(res.body.data[0].name, 'Org A')
})

test('GET /organizations never accepts userId from the query string', async () => {
  const cookieA = await registerAndLogin('queryA@example.com', PASSWORD)
  const cookieB = await registerAndLogin('queryB@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieB)
    .send({ name: 'Org For B' })

  const userB = await UserModel.findOne({ email: 'queryB@example.com' })

  const res = await request(app)
    .get(`/api/v1/organizations?userId=${userB!._id.toString()}`)
    .set('Cookie', cookieA)

  assert.equal(res.status, 200)
  assert.equal(
    res.body.data.length,
    0,
    "A's own organizations list must stay empty regardless of the query string",
  )
})

// ---------------------------------------------------------------------------
// Organization context resolution / suspension / permission matrix
// ---------------------------------------------------------------------------

test('GET /organizations/:id requires an ACTIVE membership; a non-member gets a generic 403', async () => {
  const cookieOwner = await registerAndLogin('ctxowner@example.com', PASSWORD)
  const cookieOutsider = await registerAndLogin('ctxoutsider@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Context Org' })
  const organizationId = createRes.body.data._id

  const memberRes = await request(app)
    .get(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieOwner)
  assert.equal(memberRes.status, 200)

  const outsiderRes = await request(app)
    .get(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieOutsider)
  assert.equal(outsiderRes.status, 403)
  assert.equal(outsiderRes.body.error.code, 'FORBIDDEN')
})

test('GET /organizations/:id with a malformed id returns 422 before touching the database', async () => {
  const cookie = await registerAndLogin('malformed@example.com', PASSWORD)
  const res = await request(app)
    .get('/api/v1/organizations/not-a-valid-object-id')
    .set('Cookie', cookie)
  assert.equal(res.status, 422)
})

test('a SUSPENDED organization returns 403 for every role, including its own OWNER', async () => {
  const cookieOwner = await registerAndLogin('suspowner@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Suspend Org' })
  const organizationId = createRes.body.data._id

  const suspendRes = await request(app)
    .patch(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieOwner)
    .send({ status: 'SUSPENDED' })
  assert.equal(suspendRes.status, 200)
  assert.equal(suspendRes.body.data.status, 'SUSPENDED')

  const ownerReadAfterSuspend = await request(app)
    .get(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieOwner)
  assert.equal(ownerReadAfterSuspend.status, 403)

  // There is intentionally no owner-reactivation bypass: even the OWNER's
  // own attempt to flip status back to ACTIVE is blocked once suspended.
  const reactivateAttempt = await request(app)
    .patch(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieOwner)
    .send({ status: 'ACTIVE' })
  assert.equal(reactivateAttempt.status, 403)
})

test('permission matrix: MEMBER can read the organization but cannot update it or manage memberships', async () => {
  const cookieOwner = await registerAndLogin('matrixowner@example.com', PASSWORD)
  const cookieMember = await registerAndLogin('matrixmember@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Matrix Org' })
  const organizationId = createRes.body.data._id
  const memberUser = await UserModel.findOne({ email: 'matrixmember@example.com' })

  await request(app)
    .post(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieOwner)
    .send({ userId: memberUser!._id.toString() })

  const readRes = await request(app)
    .get(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieMember)
  assert.equal(readRes.status, 200)

  const updateRes = await request(app)
    .patch(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieMember)
    .send({ name: 'Hijacked Name' })
  assert.equal(updateRes.status, 403)

  const membershipReadRes = await request(app)
    .get(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieMember)
  assert.equal(membershipReadRes.status, 403)

  const addMemberRes = await request(app)
    .post(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieMember)
    .send({ userId: memberUser!._id.toString() })
  assert.equal(addMemberRes.status, 403)
})

test('permission matrix: ADMIN can read/update the organization and read memberships, but cannot manage memberships or roles', async () => {
  const cookieOwner = await registerAndLogin('matrixowner2@example.com', PASSWORD)
  const cookieAdmin = await registerAndLogin('matrixadmin@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Matrix Org 2' })
  const organizationId = createRes.body.data._id
  const adminUser = await UserModel.findOne({ email: 'matrixadmin@example.com' })

  const addRes = await request(app)
    .post(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieOwner)
    .send({ userId: adminUser!._id.toString() })
  await request(app)
    .patch(`/api/v1/organizations/${organizationId}/memberships/${addRes.body.data._id}`)
    .set('Cookie', cookieOwner)
    .send({ role: 'ADMIN' })

  const updateRes = await request(app)
    .patch(`/api/v1/organizations/${organizationId}`)
    .set('Cookie', cookieAdmin)
    .send({ name: 'Admin Renamed' })
  assert.equal(updateRes.status, 200)

  const membershipReadRes = await request(app)
    .get(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieAdmin)
  assert.equal(membershipReadRes.status, 200)

  const roleChangeRes = await request(app)
    .patch(`/api/v1/organizations/${organizationId}/memberships/${addRes.body.data._id}`)
    .set('Cookie', cookieAdmin)
    .send({ role: 'OWNER' })
  assert.equal(roleChangeRes.status, 403)

  const anotherUser = await UserModel.create({
    email: 'anothertarget@example.com',
    passwordHash: 'x',
  })
  const addMemberRes = await request(app)
    .post(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieAdmin)
    .send({ userId: anotherUser._id.toString() })
  assert.equal(addMemberRes.status, 403)
})

// ---------------------------------------------------------------------------
// Membership mass-assignment
// ---------------------------------------------------------------------------

test('POST .../memberships rejects client-supplied role/status/organizationId (strict schema, mass-assignment protection)', async () => {
  const cookieOwner = await registerAndLogin('massowner@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Mass Assignment Org' })
  const organizationId = createRes.body.data._id
  const targetUser = await UserModel.create({ email: 'masstarget@example.com', passwordHash: 'x' })

  const res = await request(app)
    .post(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieOwner)
    .send({
      userId: targetUser._id.toString(),
      organizationId: new Types.ObjectId().toString(),
      role: 'OWNER',
      status: 'ACTIVE',
    })

  assert.equal(res.status, 422)
})

test('a newly added member is always role=MEMBER regardless of any attempted override', async () => {
  const cookieOwner = await registerAndLogin('cleanowner@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Clean Add Org' })
  const organizationId = createRes.body.data._id
  const targetUser = await UserModel.create({ email: 'cleantarget@example.com', passwordHash: 'x' })

  const res = await request(app)
    .post(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieOwner)
    .send({ userId: targetUser._id.toString() })

  assert.equal(res.status, 201)
  assert.equal(res.body.data.role, 'MEMBER')
  assert.equal(res.body.data.status, 'ACTIVE')
})

// ---------------------------------------------------------------------------
// IDOR: membership ids across organizations
// ---------------------------------------------------------------------------

test('IDOR: a membership id from a different organization cannot be role-changed or removed', async () => {
  const cookieOwner1 = await registerAndLogin('idorowner1@example.com', PASSWORD)
  const cookieOwner2 = await registerAndLogin('idorowner2@example.com', PASSWORD)
  const org1Res = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner1)
    .send({ name: 'IDOR Org 1' })
  const org2Res = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner2)
    .send({ name: 'IDOR Org 2' })

  const org2OwnerMembership = await OrganizationMembershipModel.findOne({
    organizationId: org2Res.body.data._id,
  })

  const roleChangeRes = await request(app)
    .patch(
      `/api/v1/organizations/${org1Res.body.data._id}/memberships/${org2OwnerMembership!._id.toString()}`,
    )
    .set('Cookie', cookieOwner1)
    .send({ role: 'ADMIN' })
  assert.equal(roleChangeRes.status, 404)

  const removeRes = await request(app)
    .delete(
      `/api/v1/organizations/${org1Res.body.data._id}/memberships/${org2OwnerMembership!._id.toString()}`,
    )
    .set('Cookie', cookieOwner1)
  assert.equal(removeRes.status, 404)

  const stillActive = await OrganizationMembershipModel.findById(org2OwnerMembership!._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

// ---------------------------------------------------------------------------
// Membership removal / role change (route-level, mirroring service tests)
// ---------------------------------------------------------------------------

test('DELETE .../memberships/:id removes a member', async () => {
  const cookieOwner = await registerAndLogin('removeowner@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Removal Org' })
  const organizationId = createRes.body.data._id
  const targetUser = await UserModel.create({
    email: 'removetarget@example.com',
    passwordHash: 'x',
  })
  const addRes = await request(app)
    .post(`/api/v1/organizations/${organizationId}/memberships`)
    .set('Cookie', cookieOwner)
    .send({ userId: targetUser._id.toString() })

  const removeRes = await request(app)
    .delete(`/api/v1/organizations/${organizationId}/memberships/${addRes.body.data._id}`)
    .set('Cookie', cookieOwner)
  assert.equal(removeRes.status, 200)

  const afterRemoval = await OrganizationMembershipModel.findById(addRes.body.data._id)
  assert.equal(afterRemoval?.status, 'REMOVED')
})

test('the sole OWNER cannot be removed via the route (last-owner protection end-to-end)', async () => {
  const cookieOwner = await registerAndLogin('lastownerroute@example.com', PASSWORD)
  const createRes = await request(app)
    .post('/api/v1/organizations')
    .set('Cookie', cookieOwner)
    .send({ name: 'Last Owner Route Org' })
  const organizationId = createRes.body.data._id
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId })

  const res = await request(app)
    .delete(
      `/api/v1/organizations/${organizationId}/memberships/${ownerMembership!._id.toString()}`,
    )
    .set('Cookie', cookieOwner)

  assert.equal(res.status, 403)
})

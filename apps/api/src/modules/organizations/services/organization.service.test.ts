import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import pino from 'pino'
import { OrganizationModel } from '../models/organization.model.js'
import { OrganizationMembershipModel } from '../models/organization-membership.model.js'
import { AuditEventModel } from '../../audit/models/audit-event.model.js'
import {
  createOrganization,
  listOrganizationsForUser,
  getOrganization,
  updateOrganization,
} from './organization.service.js'
import { NotFoundError } from '../../../lib/http-errors.js'

// withTransaction() requires a replica set — a standalone MongoMemoryServer
// cannot run the atomic org+owner bootstrap transaction at all.
let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'sec_002_org_service_test' })
  await Promise.all([
    OrganizationModel.init(),
    OrganizationMembershipModel.init(),
    AuditEventModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([
    OrganizationModel.deleteMany({}),
    OrganizationMembershipModel.deleteMany({}),
    AuditEventModel.deleteMany({}),
  ])
})

const silentLogger = pino({ level: 'silent' })

test('createOrganization atomically creates the organization and the creator OWNER membership', async () => {
  const userId = new Types.ObjectId()
  const organization = await createOrganization({ name: 'Acme Inc' }, userId, silentLogger)

  assert.equal(organization.name, 'Acme Inc')
  assert.equal(organization.status, 'ACTIVE')
  assert.equal(organization.activeOwnerCount, 1)

  const membership = await OrganizationMembershipModel.findOne({ organizationId: organization._id })
  assert.equal(membership?.userId.toString(), userId.toString())
  assert.equal(membership?.role, 'OWNER')
  assert.equal(membership?.status, 'ACTIVE')
})

test('createOrganization rolls back and leaves no orphan organization if membership creation fails', async () => {
  const userId = new Types.ObjectId()

  // Force the membership half of the transaction to fail: pre-seed an
  // ACTIVE membership for this exact (org, user) pair is impossible before
  // the organization even exists, so instead we simulate the failure by
  // temporarily breaking OrganizationMembershipModel.create via a duplicate
  // _id collision, which is unrelated to real production code paths but
  // deterministically forces the transaction's second write to reject.
  const originalCreate = OrganizationMembershipModel.create.bind(OrganizationMembershipModel)
  OrganizationMembershipModel.create = (async () => {
    throw new Error('deliberate membership-creation failure')
  }) as typeof OrganizationMembershipModel.create

  try {
    await assert.rejects(() =>
      createOrganization({ name: 'Should Not Persist' }, userId, silentLogger),
    )
  } finally {
    OrganizationMembershipModel.create = originalCreate
  }

  const orphan = await OrganizationModel.findOne({ name: 'Should Not Persist' })
  assert.equal(
    orphan,
    null,
    'the organization must not survive when its first-owner membership fails',
  )
})

test('listOrganizationsForUser returns only organizations the user has an ACTIVE membership in', async () => {
  const userA = new Types.ObjectId()
  const userB = new Types.ObjectId()
  const orgA = await createOrganization({ name: 'Org A' }, userA, silentLogger)
  await createOrganization({ name: 'Org B' }, userB, silentLogger)

  const results = await listOrganizationsForUser(userA)
  assert.equal(results.length, 1)
  assert.equal(results[0]?._id.toString(), orgA._id.toString())
})

test('listOrganizationsForUser excludes organizations from a REMOVED membership', async () => {
  const userId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Leaving Org' }, userId, silentLogger)
  const membership = await OrganizationMembershipModel.findOne({ organizationId: org._id, userId })
  const session = await mongoose.startSession()
  try {
    await OrganizationMembershipModel.updateOne(
      { _id: membership!._id },
      { $set: { status: 'REMOVED' } },
      { session },
    )
  } finally {
    await session.endSession()
  }

  const results = await listOrganizationsForUser(userId)
  assert.equal(results.length, 0)
})

test('getOrganization returns the organization', async () => {
  const userId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Gettable' }, userId, silentLogger)
  const found = await getOrganization(org._id)
  assert.equal(found.name, 'Gettable')
})

test('getOrganization throws NotFoundError for a nonexistent id', async () => {
  await assert.rejects(() => getOrganization(new Types.ObjectId()), NotFoundError)
})

test('updateOrganization patches name/status but never activeOwnerCount (not part of the input type)', async () => {
  const userId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Original' }, userId, silentLogger)

  const updated = await updateOrganization(
    org._id,
    { name: 'Renamed', status: 'SUSPENDED' },
    silentLogger,
  )
  assert.equal(updated.name, 'Renamed')
  assert.equal(updated.status, 'SUSPENDED')
  assert.equal(updated.activeOwnerCount, 1)
})

// ---------------------------------------------------------------------------
// SEC-003: audit events (additive — does not modify any assertion above)
// ---------------------------------------------------------------------------

test('createOrganization produces an organization.created AuditEvent only after the transaction commits', async () => {
  const userId = new Types.ObjectId()
  const organization = await createOrganization({ name: 'Audited Org' }, userId, silentLogger)

  const events = await AuditEventModel.find({ action: 'organization.created' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.severity, 'INFO')
  assert.equal(events[0]?.entityType, 'Organization')
  assert.equal(events[0]?.entityId?.toString(), organization._id.toString())
  assert.equal(events[0]?.organizationId?.toString(), organization._id.toString())
  assert.equal(events[0]?.actorUserId?.toString(), userId.toString())
})

test('createOrganization rollback produces NO organization.created AuditEvent', async () => {
  const userId = new Types.ObjectId()
  const originalCreate = OrganizationMembershipModel.create.bind(OrganizationMembershipModel)
  OrganizationMembershipModel.create = (async () => {
    throw new Error('deliberate membership-creation failure')
  }) as typeof OrganizationMembershipModel.create

  try {
    await assert.rejects(() =>
      createOrganization({ name: 'Rollback Audit Org' }, userId, silentLogger),
    )
  } finally {
    OrganizationMembershipModel.create = originalCreate
  }

  const events = await AuditEventModel.find({ action: 'organization.created' })
  assert.equal(events.length, 0, 'no audit event may exist for an operation that never committed')
})

test('updateOrganization with status SUSPENDED produces an organization.suspended AuditEvent', async () => {
  const userId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Suspend Audit Org' }, userId, silentLogger)

  await updateOrganization(org._id, { status: 'SUSPENDED' }, silentLogger)

  const events = await AuditEventModel.find({ action: 'organization.suspended' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.entityType, 'Organization')
  assert.equal(events[0]?.entityId?.toString(), org._id.toString())
})

test('updateOrganization with a redundant status:ACTIVE (no genuine reactivation possible) produces NO additional AuditEvent', async () => {
  const userId = new Types.ObjectId()
  const org = await createOrganization({ name: 'No Reactivation Org' }, userId, silentLogger)
  // Exactly one event exists so far: organization.created from setup above.
  const beforeCount = await AuditEventModel.countDocuments({})
  assert.equal(beforeCount, 1)

  // org is already ACTIVE — this is the only reachable trigger for the
  // pre-existing 'ACTIVE' branch, and it is not a genuine transition.
  // "organization.reactivated" is not even a valid value of the AuditAction
  // enum (see models/audit-event.model.ts) — it was deliberately never
  // added, precisely because it can never genuinely occur.
  await updateOrganization(org._id, { status: 'ACTIVE' }, silentLogger)

  const afterCount = await AuditEventModel.countDocuments({})
  assert.equal(afterCount, 1, 'the no-op ACTIVE branch must not produce any new audit event')
})

test('updateOrganization with a name-only patch produces no AuditEvent', async () => {
  const userId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Rename Only Org' }, userId, silentLogger)

  await updateOrganization(org._id, { name: 'Renamed Only' }, silentLogger)

  const events = await AuditEventModel.find({})
  assert.equal(events.length, 1, 'only the organization.created event from setup should exist')
  assert.equal(events[0]?.action, 'organization.created')
})

test('an audit-write failure never prevents createOrganization from succeeding (best-effort, non-blocking)', async () => {
  const userId = new Types.ObjectId()
  const original = AuditEventModel.create.bind(AuditEventModel)
  AuditEventModel.create = (async () => {
    throw new Error('deliberate audit write failure')
  }) as typeof AuditEventModel.create

  try {
    const organization = await createOrganization({ name: 'Resilient Org' }, userId, silentLogger)
    assert.equal(organization.name, 'Resilient Org')
  } finally {
    AuditEventModel.create = original
  }
})

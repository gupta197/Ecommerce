import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import pino from 'pino'
import { OrganizationModel } from '../models/organization.model.js'
import { OrganizationMembershipModel } from '../models/organization-membership.model.js'
import { UserModel } from '../../auth/models/user.model.js'
import { AuditEventModel } from '../../audit/models/audit-event.model.js'
import { createOrganization } from './organization.service.js'
import { addMember, listMembers, changeRole, removeMember } from './membership.service.js'
import { ForbiddenError, NotFoundError } from '../../../lib/http-errors.js'

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'sec_002_membership_service_test' })
  await Promise.all([
    OrganizationModel.init(),
    OrganizationMembershipModel.init(),
    UserModel.init(),
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
    UserModel.deleteMany({}),
    AuditEventModel.deleteMany({}),
  ])
})

const silentLogger = pino({ level: 'silent' })

async function createRealUser(email: string) {
  return UserModel.create({ email, passwordHash: 'irrelevant-for-this-test' })
}

test('addMember requires the target user to actually exist', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Org' }, ownerId, silentLogger)

  await assert.rejects(() => addMember(org._id, new Types.ObjectId(), silentLogger), NotFoundError)
})

test('addMember always creates role=MEMBER, status=ACTIVE regardless of caller intent', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Org' }, ownerId, silentLogger)
  const newUser = await createRealUser('newmember@example.com')

  const membership = await addMember(org._id, newUser._id, silentLogger)
  assert.equal(membership.role, 'MEMBER')
  assert.equal(membership.status, 'ACTIVE')
})

test('listMembers returns only ACTIVE memberships for the organization', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Org' }, ownerId, silentLogger)
  const user2 = await createRealUser('member2@example.com')
  await addMember(org._id, user2._id, silentLogger)

  const members = await listMembers(org._id)
  assert.equal(members.length, 2)
})

test('changeRole from MEMBER to ADMIN does not change activeOwnerCount', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Org' }, ownerId, silentLogger)
  const user2 = await createRealUser('promote@example.com')
  const membership = await addMember(org._id, user2._id, silentLogger)

  await changeRole(org._id, membership._id, 'ADMIN', silentLogger)

  const afterOrg = await OrganizationModel.findById(org._id)
  assert.equal(afterOrg?.activeOwnerCount, 1)
  const afterMembership = await OrganizationMembershipModel.findById(membership._id)
  assert.equal(afterMembership?.role, 'ADMIN')
})

test('changeRole promoting to OWNER increments activeOwnerCount', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Org' }, ownerId, silentLogger)
  const user2 = await createRealUser('promote2@example.com')
  const membership = await addMember(org._id, user2._id, silentLogger)

  await changeRole(org._id, membership._id, 'OWNER', silentLogger)

  const afterOrg = await OrganizationModel.findById(org._id)
  assert.equal(afterOrg?.activeOwnerCount, 2)
})

test('changeRole is a no-op (no counter change) when the role is unchanged', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'Org' }, ownerId, silentLogger)
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId: org._id })

  await changeRole(org._id, ownerMembership!._id, 'OWNER', silentLogger)

  const afterOrg = await OrganizationModel.findById(org._id)
  assert.equal(afterOrg?.activeOwnerCount, 1)
})

test('changeRole scopes membershipId lookup by organizationId (IDOR: a membership id from another org is rejected)', async () => {
  const owner1 = new Types.ObjectId()
  const owner2 = new Types.ObjectId()
  const org1 = await createOrganization({ name: 'Org1' }, owner1, silentLogger)
  const org2 = await createOrganization({ name: 'Org2' }, owner2, silentLogger)
  const org2OwnerMembership = await OrganizationMembershipModel.findOne({
    organizationId: org2._id,
  })

  await assert.rejects(
    () => changeRole(org1._id, org2OwnerMembership!._id, 'ADMIN', silentLogger),
    NotFoundError,
  )
})

// ---------------------------------------------------------------------------
// Last-owner protection — Cases A-D (Case E, the true concurrency case,
// lives in last-owner-protection.test.ts alongside the atomic-bootstrap
// rollback test, per the approved plan's file structure).
// ---------------------------------------------------------------------------

test('Case A: sole owner cannot remove self', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'SoleOwnerOrg' }, ownerId, silentLogger)
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId: org._id })

  await assert.rejects(
    () => removeMember(org._id, ownerMembership!._id, silentLogger),
    ForbiddenError,
  )

  const afterOrg = await OrganizationModel.findById(org._id)
  assert.equal(afterOrg?.activeOwnerCount, 1)
  const afterMembership = await OrganizationMembershipModel.findById(ownerMembership!._id)
  assert.equal(afterMembership?.status, 'ACTIVE')
  assert.equal(afterMembership?.role, 'OWNER')
})

test('Case B: sole owner cannot demote self', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'SoleOwnerOrg2' }, ownerId, silentLogger)
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId: org._id })

  await assert.rejects(
    () => changeRole(org._id, ownerMembership!._id, 'ADMIN', silentLogger),
    ForbiddenError,
  )

  const afterOrg = await OrganizationModel.findById(org._id)
  assert.equal(afterOrg?.activeOwnerCount, 1)
  const afterMembership = await OrganizationMembershipModel.findById(ownerMembership!._id)
  assert.equal(afterMembership?.role, 'OWNER')
})

test('Case C: with two owners, one may be removed and the other remains OWNER', async () => {
  const ownerAId = new Types.ObjectId()
  const org = await createOrganization({ name: 'TwoOwnerOrgC' }, ownerAId, silentLogger)
  const ownerAMembership = await OrganizationMembershipModel.findOne({
    organizationId: org._id,
    userId: ownerAId,
  })

  const userB = await createRealUser('ownerBc@example.com')
  const membershipB = await addMember(org._id, userB._id, silentLogger)
  await changeRole(org._id, membershipB._id, 'OWNER', silentLogger)

  await removeMember(org._id, ownerAMembership!._id, silentLogger)

  const afterOrg = await OrganizationModel.findById(org._id)
  assert.equal(afterOrg?.activeOwnerCount, 1)
  const afterA = await OrganizationMembershipModel.findById(ownerAMembership!._id)
  assert.equal(afterA?.status, 'REMOVED')
  const afterB = await OrganizationMembershipModel.findById(membershipB._id)
  assert.equal(afterB?.role, 'OWNER')
  assert.equal(afterB?.status, 'ACTIVE')
})

test('Case D: with two owners, one may be demoted and the other remains OWNER', async () => {
  const ownerAId = new Types.ObjectId()
  const org = await createOrganization({ name: 'TwoOwnerOrgD' }, ownerAId, silentLogger)
  const ownerAMembership = await OrganizationMembershipModel.findOne({
    organizationId: org._id,
    userId: ownerAId,
  })

  const userB = await createRealUser('ownerBd@example.com')
  const membershipB = await addMember(org._id, userB._id, silentLogger)
  await changeRole(org._id, membershipB._id, 'OWNER', silentLogger)

  await changeRole(org._id, ownerAMembership!._id, 'ADMIN', silentLogger)

  const afterOrg = await OrganizationModel.findById(org._id)
  assert.equal(afterOrg?.activeOwnerCount, 1)
  const afterA = await OrganizationMembershipModel.findById(ownerAMembership!._id)
  assert.equal(afterA?.role, 'ADMIN')
  const afterB = await OrganizationMembershipModel.findById(membershipB._id)
  assert.equal(afterB?.role, 'OWNER')
})

// ---------------------------------------------------------------------------
// Self-management edge cases (approved plan §16 / §7 of the second-revision review)
// ---------------------------------------------------------------------------

test('self-management: OWNER removes self while another OWNER exists -> allowed', async () => {
  const ownerAId = new Types.ObjectId()
  const org = await createOrganization({ name: 'SelfRemoveOrg' }, ownerAId, silentLogger)
  const ownerAMembership = await OrganizationMembershipModel.findOne({
    organizationId: org._id,
    userId: ownerAId,
  })
  const userB = await createRealUser('selfremoveB@example.com')
  const membershipB = await addMember(org._id, userB._id, silentLogger)
  await changeRole(org._id, membershipB._id, 'OWNER', silentLogger)

  // OwnerA removes their own membership.
  await removeMember(org._id, ownerAMembership!._id, silentLogger)

  const afterA = await OrganizationMembershipModel.findById(ownerAMembership!._id)
  assert.equal(afterA?.status, 'REMOVED')
})

test('self-management: sole OWNER removing self is blocked (final-owner protection)', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'SelfRemoveSoleOrg' }, ownerId, silentLogger)
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId: org._id })

  await assert.rejects(
    () => removeMember(org._id, ownerMembership!._id, silentLogger),
    ForbiddenError,
  )
})

// ---------------------------------------------------------------------------
// SEC-003: audit events (additive — does not modify any assertion above)
// ---------------------------------------------------------------------------

test('addMember produces a membership.added AuditEvent', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'AuditAddOrg' }, ownerId, silentLogger)
  const newUser = await createRealUser('audit-add@example.com')

  const membership = await addMember(org._id, newUser._id, silentLogger)

  const events = await AuditEventModel.find({ action: 'membership.added' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.entityType, 'OrganizationMembership')
  assert.equal(events[0]?.entityId?.toString(), membership._id.toString())
  assert.equal(events[0]?.organizationId?.toString(), org._id.toString())
})

test('changeRole (genuine transition) produces a membership.role_changed AuditEvent only after the transaction commits', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'AuditRoleOrg' }, ownerId, silentLogger)
  const user2 = await createRealUser('audit-role@example.com')
  const membership = await addMember(org._id, user2._id, silentLogger)

  await changeRole(org._id, membership._id, 'ADMIN', silentLogger)

  const events = await AuditEventModel.find({ action: 'membership.role_changed' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.entityType, 'OrganizationMembership')
  const metadata = events[0]?.metadata as Record<string, unknown>
  assert.equal(metadata.fromRole, 'MEMBER')
  assert.equal(metadata.toRole, 'ADMIN')
})

test('changeRole no-op (same role requested) produces NO membership.role_changed AuditEvent', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'AuditNoOpOrg' }, ownerId, silentLogger)
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId: org._id })

  await changeRole(org._id, ownerMembership!._id, 'OWNER', silentLogger)

  const events = await AuditEventModel.find({ action: 'membership.role_changed' })
  assert.equal(events.length, 0)
})

test('changeRole rejected by last-owner protection produces NO membership.role_changed AuditEvent', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'AuditLastOwnerRoleOrg' }, ownerId, silentLogger)
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId: org._id })

  await assert.rejects(() => changeRole(org._id, ownerMembership!._id, 'ADMIN', silentLogger))

  const events = await AuditEventModel.find({ action: 'membership.role_changed' })
  assert.equal(
    events.length,
    0,
    'a rejected (non-committed) role change must not produce an audit event',
  )
})

test('removeMember produces a membership.removed AuditEvent only after the transaction commits', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'AuditRemoveOrg' }, ownerId, silentLogger)
  const user2 = await createRealUser('audit-remove@example.com')
  const membership = await addMember(org._id, user2._id, silentLogger)

  await removeMember(org._id, membership._id, silentLogger)

  const events = await AuditEventModel.find({ action: 'membership.removed' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.entityId?.toString(), membership._id.toString())
})

test('removeMember rejected by last-owner protection produces NO membership.removed AuditEvent', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'AuditLastOwnerRemoveOrg' }, ownerId, silentLogger)
  const ownerMembership = await OrganizationMembershipModel.findOne({ organizationId: org._id })

  await assert.rejects(() => removeMember(org._id, ownerMembership!._id, silentLogger))

  const events = await AuditEventModel.find({ action: 'membership.removed' })
  assert.equal(
    events.length,
    0,
    'a rejected (non-committed) removal must not produce an audit event',
  )
})

test('an audit-write failure never prevents addMember from succeeding (best-effort, non-blocking)', async () => {
  const ownerId = new Types.ObjectId()
  const org = await createOrganization({ name: 'AuditResilientAddOrg' }, ownerId, silentLogger)
  const newUser = await createRealUser('audit-resilient@example.com')

  const original = AuditEventModel.create.bind(AuditEventModel)
  AuditEventModel.create = (async () => {
    throw new Error('deliberate audit write failure')
  }) as typeof AuditEventModel.create
  try {
    const membership = await addMember(org._id, newUser._id, silentLogger)
    assert.equal(membership.role, 'MEMBER')
  } finally {
    AuditEventModel.create = original
  }
})

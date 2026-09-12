import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import pino from 'pino'
import { OrganizationModel } from '../models/organization.model.js'
import { OrganizationMembershipModel } from '../models/organization-membership.model.js'
import { UserModel } from '../../auth/models/user.model.js'
import { createOrganization } from './organization.service.js'
import { addMember, changeRole, removeMember } from './membership.service.js'
import { ForbiddenError } from '../../../lib/http-errors.js'

// Dedicated concurrency + atomicity suite for last-owner protection and the
// atomic organization-bootstrap transaction. Requires a real replica set —
// a standalone MongoMemoryServer cannot run multi-document transactions.

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'sec_002_last_owner_test' })
  await Promise.all([
    OrganizationModel.init(),
    OrganizationMembershipModel.init(),
    UserModel.init(),
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
  ])
})

const silentLogger = pino({ level: 'silent' })

async function createRealUser(email: string) {
  return UserModel.create({ email, passwordHash: 'irrelevant-for-this-test' })
}

async function createTwoOwnerOrg(name: string) {
  const ownerAId = new Types.ObjectId()
  const org = await createOrganization({ name }, ownerAId, silentLogger)
  const ownerAMembership = await OrganizationMembershipModel.findOne({
    organizationId: org._id,
    userId: ownerAId,
  })

  const userB = await createRealUser(`${name.toLowerCase()}-ownerB@example.com`)
  const ownerBMembership = await addMember(org._id, userB._id, silentLogger)
  await changeRole(org._id, ownerBMembership._id, 'OWNER', silentLogger)

  return { org, ownerAMembership: ownerAMembership!, ownerBMembership }
}

test('CONCURRENCY (Case E, remove): two concurrent removals of two different owners — exactly one succeeds, the organization never ends with zero ACTIVE owners', async () => {
  const { org, ownerAMembership, ownerBMembership } = await createTwoOwnerOrg('ConcurrentRemove')

  const results = await Promise.allSettled([
    removeMember(org._id, ownerAMembership._id, silentLogger),
    removeMember(org._id, ownerBMembership._id, silentLogger),
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1, 'exactly one concurrent removal should succeed')
  assert.equal(rejected.length, 1, 'exactly one concurrent removal should fail')
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ForbiddenError)

  const finalOrg = await OrganizationModel.findById(org._id)
  assert.equal(finalOrg?.activeOwnerCount, 1, 'activeOwnerCount must never reach zero')

  const activeOwners = await OrganizationMembershipModel.countDocuments({
    organizationId: org._id,
    role: 'OWNER',
    status: 'ACTIVE',
  })
  assert.equal(
    activeOwners,
    1,
    'exactly one ACTIVE owner membership must remain — counter and membership state agree',
  )
})

test('CONCURRENCY (Case E, demote): two concurrent demotions of two different owners — exactly one succeeds, never zero ACTIVE owners', async () => {
  const { org, ownerAMembership, ownerBMembership } = await createTwoOwnerOrg('ConcurrentDemote')

  const results = await Promise.allSettled([
    changeRole(org._id, ownerAMembership._id, 'ADMIN', silentLogger),
    changeRole(org._id, ownerBMembership._id, 'MEMBER', silentLogger),
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1, 'exactly one concurrent demotion should succeed')
  assert.equal(rejected.length, 1, 'exactly one concurrent demotion should fail')
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ForbiddenError)

  const finalOrg = await OrganizationModel.findById(org._id)
  assert.equal(finalOrg?.activeOwnerCount, 1, 'activeOwnerCount must never reach zero')

  const activeOwners = await OrganizationMembershipModel.countDocuments({
    organizationId: org._id,
    role: 'OWNER',
    status: 'ACTIVE',
  })
  assert.equal(
    activeOwners,
    1,
    'exactly one ACTIVE owner membership must remain — counter and membership state agree',
  )
})

test('atomic bootstrap rollback: a forced membership-creation failure leaves no orphan Organization', async () => {
  const userId = new Types.ObjectId()
  const originalCreate = OrganizationMembershipModel.create.bind(OrganizationMembershipModel)
  OrganizationMembershipModel.create = (async () => {
    throw new Error('deliberate membership-creation failure')
  }) as typeof OrganizationMembershipModel.create

  try {
    await assert.rejects(() =>
      createOrganization({ name: 'RollbackCheckOrg' }, userId, silentLogger),
    )
  } finally {
    OrganizationMembershipModel.create = originalCreate
  }

  const orphan = await OrganizationModel.findOne({ name: 'RollbackCheckOrg' })
  assert.equal(orphan, null)
  const orphanMembershipCount = await OrganizationMembershipModel.countDocuments({ userId })
  assert.equal(orphanMembershipCount, 0)
})

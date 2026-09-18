import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { OrganizationMembershipModel } from '../models/organization-membership.model.js'
import * as membershipRepository from './organization-membership.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_002_membership_repo_test' })
  await OrganizationMembershipModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await OrganizationMembershipModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a membership', async () => {
  const organizationId = oid()
  const userId = oid()
  const membership = await membershipRepository.create({
    organizationId,
    userId,
    role: 'OWNER',
    status: 'ACTIVE',
  })
  assert.equal(membership.role, 'OWNER')
  assert.equal(membership.status, 'ACTIVE')
})

test('creating a second ACTIVE membership for the same org+user is rejected', async () => {
  const organizationId = oid()
  const userId = oid()
  await membershipRepository.create({ organizationId, userId, role: 'MEMBER', status: 'ACTIVE' })
  await assert.rejects(
    () => membershipRepository.create({ organizationId, userId, role: 'MEMBER', status: 'ACTIVE' }),
    ValidationError,
  )
})

test('a REMOVED membership can coexist with a newly created ACTIVE membership for the same org+user', async () => {
  const organizationId = oid()
  const userId = oid()
  const original = await membershipRepository.create({
    organizationId,
    userId,
    role: 'MEMBER',
    status: 'ACTIVE',
  })

  const session = await mongoose.startSession()
  try {
    await membershipRepository.markRemoved(organizationId, original._id, session)
  } finally {
    await session.endSession()
  }

  const readded = await membershipRepository.create({
    organizationId,
    userId,
    role: 'MEMBER',
    status: 'ACTIVE',
  })

  assert.notEqual(readded._id.toString(), original._id.toString())

  const originalAfter = await OrganizationMembershipModel.findById(original._id)
  assert.equal(originalAfter?.status, 'REMOVED')

  const count = await OrganizationMembershipModel.countDocuments({ organizationId, userId })
  assert.equal(count, 2)
})

test('findActiveByOrgAndUser only matches ACTIVE memberships', async () => {
  const organizationId = oid()
  const userId = oid()
  const membership = await membershipRepository.create({
    organizationId,
    userId,
    role: 'ADMIN',
    status: 'ACTIVE',
  })
  const found = await membershipRepository.findActiveByOrgAndUser(organizationId, userId)
  assert.equal(found?._id.toString(), membership._id.toString())

  const session = await mongoose.startSession()
  try {
    await membershipRepository.markRemoved(organizationId, membership._id, session)
  } finally {
    await session.endSession()
  }
  const afterRemoval = await membershipRepository.findActiveByOrgAndUser(organizationId, userId)
  assert.equal(afterRemoval, null)
})

test('findActiveById scopes by organizationId (cross-org lookup returns null)', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const membership = await membershipRepository.create({
    organizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  const wrongOrg = await membershipRepository.findActiveById(otherOrganizationId, membership._id)
  assert.equal(wrongOrg, null)

  const rightOrg = await membershipRepository.findActiveById(organizationId, membership._id)
  assert.equal(rightOrg?._id.toString(), membership._id.toString())
})

test('listActiveForOrganization only returns ACTIVE memberships for that organization', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const active = await membershipRepository.create({
    organizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  const removedTarget = await membershipRepository.create({
    organizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  await membershipRepository.create({
    organizationId: otherOrganizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })

  const session = await mongoose.startSession()
  try {
    await membershipRepository.markRemoved(organizationId, removedTarget._id, session)
  } finally {
    await session.endSession()
  }

  const results = await membershipRepository.listActiveForOrganization(organizationId)
  assert.equal(results.length, 1)
  assert.equal(results[0]?._id.toString(), active._id.toString())
})

test('listActiveForUser only returns ACTIVE memberships for that user', async () => {
  const userId = oid()
  const otherUserId = oid()
  const membership = await membershipRepository.create({
    organizationId: oid(),
    userId,
    role: 'OWNER',
    status: 'ACTIVE',
  })
  await membershipRepository.create({
    organizationId: oid(),
    userId: otherUserId,
    role: 'OWNER',
    status: 'ACTIVE',
  })

  const results = await membershipRepository.listActiveForUser(userId)
  assert.equal(results.length, 1)
  assert.equal(results[0]?._id.toString(), membership._id.toString())
})

test('updateRole changes the role field when organizationId matches', async () => {
  const organizationId = oid()
  const membership = await membershipRepository.create({
    organizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  const session = await mongoose.startSession()
  try {
    const updated = await membershipRepository.updateRole(
      organizationId,
      membership._id,
      'ADMIN',
      session,
    )
    assert.equal(updated?.role, 'ADMIN')
  } finally {
    await session.endSession()
  }
})

test('updateRole is a no-op (returns null, does not mutate) when organizationId does not match — defense-in-depth tenant scoping', async () => {
  const organizationId = oid()
  const wrongOrganizationId = oid()
  const membership = await membershipRepository.create({
    organizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  const session = await mongoose.startSession()
  try {
    const result = await membershipRepository.updateRole(
      wrongOrganizationId,
      membership._id,
      'ADMIN',
      session,
    )
    assert.equal(result, null, 'a membership from another organization must not be mutated')
  } finally {
    await session.endSession()
  }

  const unchanged = await OrganizationMembershipModel.findById(membership._id)
  assert.equal(unchanged?.role, 'MEMBER', 'the role must remain unchanged')
})

test('markRemoved sets status to REMOVED when organizationId matches', async () => {
  const organizationId = oid()
  const membership = await membershipRepository.create({
    organizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  const session = await mongoose.startSession()
  try {
    const updated = await membershipRepository.markRemoved(organizationId, membership._id, session)
    assert.equal(updated?.status, 'REMOVED')
  } finally {
    await session.endSession()
  }
})

test('markRemoved is a no-op (returns null, does not mutate) when organizationId does not match — defense-in-depth tenant scoping', async () => {
  const organizationId = oid()
  const wrongOrganizationId = oid()
  const membership = await membershipRepository.create({
    organizationId,
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  const session = await mongoose.startSession()
  try {
    const result = await membershipRepository.markRemoved(
      wrongOrganizationId,
      membership._id,
      session,
    )
    assert.equal(result, null, 'a membership from another organization must not be removed')
  } finally {
    await session.endSession()
  }

  const unchanged = await OrganizationMembershipModel.findById(membership._id)
  assert.equal(unchanged?.status, 'ACTIVE', 'the status must remain unchanged')
})

test('toJSON output never includes __v', async () => {
  const membership = await membershipRepository.create({
    organizationId: oid(),
    userId: oid(),
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  const json = membership.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist, including the partial-unique membership index', async () => {
  const indexes = await OrganizationMembershipModel.collection.indexes()

  const uniqueIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, userId: 1 }),
  )
  assert.ok(uniqueIndex, 'expected an {organizationId: 1, userId: 1} index')
  assert.equal(uniqueIndex?.unique, true)
  assert.deepEqual(uniqueIndex?.partialFilterExpression, { status: 'ACTIVE' })

  const userStatusIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ userId: 1, status: 1 }),
  )
  assert.ok(userStatusIndex, 'expected a {userId: 1, status: 1} index')

  const orgRoleStatusIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, role: 1, status: 1 }),
  )
  assert.ok(orgRoleStatusIndex, 'expected an {organizationId: 1, role: 1, status: 1} index')
})

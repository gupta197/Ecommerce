import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import pino from 'pino'
import { OrganizationModel } from '../models/organization.model.js'
import { OrganizationMembershipModel } from '../models/organization-membership.model.js'
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
  await Promise.all([OrganizationModel.init(), OrganizationMembershipModel.init()])
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([OrganizationModel.deleteMany({}), OrganizationMembershipModel.deleteMany({})])
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

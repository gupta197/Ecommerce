import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { OrganizationModel } from '../models/organization.model.js'
import * as organizationRepository from './organization.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_002_org_repo_test' })
  await OrganizationModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await OrganizationModel.deleteMany({})
})

test('creates an organization with the given activeOwnerCount', async () => {
  const organization = await organizationRepository.create({
    name: 'Acme Inc',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  assert.equal(organization.name, 'Acme Inc')
  assert.equal(organization.status, 'ACTIVE')
  assert.equal(organization.activeOwnerCount, 1)
})

test('findById returns null for a nonexistent id', async () => {
  const found = await organizationRepository.findById(new Types.ObjectId())
  assert.equal(found, null)
})

test('findByIds returns only the requested organizations', async () => {
  const a = await organizationRepository.create({
    name: 'A',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  await organizationRepository.create({ name: 'B', status: 'ACTIVE', activeOwnerCount: 1 })
  const results = await organizationRepository.findByIds([a._id])
  assert.equal(results.length, 1)
  assert.equal(results[0]?.name, 'A')
})

test('update patches only the provided fields', async () => {
  const organization = await organizationRepository.create({
    name: 'Original',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  const updated = await organizationRepository.update(organization._id, { name: 'Renamed' })
  assert.equal(updated?.name, 'Renamed')
  assert.equal(updated?.status, 'ACTIVE')
})

test('update cannot change activeOwnerCount (not part of UpdateOrganizationData)', async () => {
  const organization = await organizationRepository.create({
    name: 'Original',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  // UpdateOrganizationData's type has no activeOwnerCount field at all —
  // this is a compile-time guarantee, not just a runtime one. Confirm the
  // runtime value is unaffected by an unrelated update.
  const updated = await organizationRepository.update(organization._id, { name: 'Renamed Again' })
  assert.equal(updated?.activeOwnerCount, 1)
})

// These repository-level tests exercise the atomic single-document
// findOneAndUpdate operations directly, passing a plain (non-transactional)
// client session — a standalone MongoMemoryServer supports sessions, just
// not multi-document transactions (session.withTransaction()), so these
// intentionally do not wrap calls in an actual transaction. Genuine
// multi-document-transaction and concurrency behavior is covered by the
// service-level last-owner-protection.test.ts using MongoMemoryReplSet.

test('incrementActiveOwnerCount always succeeds', async () => {
  const organization = await organizationRepository.create({
    name: 'Inc Test',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  const session = await mongoose.startSession()
  try {
    await organizationRepository.incrementActiveOwnerCount(organization._id, session)
  } finally {
    await session.endSession()
  }
  const after1 = await OrganizationModel.findById(organization._id)
  assert.equal(after1?.activeOwnerCount, 2)
})

test('decrementActiveOwnerCountIfSafe succeeds when count > 1', async () => {
  const organization = await organizationRepository.create({
    name: 'Dec Test',
    status: 'ACTIVE',
    activeOwnerCount: 2,
  })
  const session = await mongoose.startSession()
  try {
    const result = await organizationRepository.decrementActiveOwnerCountIfSafe(
      organization._id,
      session,
    )
    assert.ok(result)
    assert.equal(result?.activeOwnerCount, 1)
  } finally {
    await session.endSession()
  }
})

test('decrementActiveOwnerCountIfSafe returns null (and does not decrement) when count is 1', async () => {
  const organization = await organizationRepository.create({
    name: 'Dec Test Guard',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  const session = await mongoose.startSession()
  try {
    const result = await organizationRepository.decrementActiveOwnerCountIfSafe(
      organization._id,
      session,
    )
    assert.equal(result, null)
  } finally {
    await session.endSession()
  }
  const after1 = await OrganizationModel.findById(organization._id)
  assert.equal(after1?.activeOwnerCount, 1)
})

test('a negative activeOwnerCount is rejected by normal model validation (min: 0)', async () => {
  await assert.rejects(() =>
    organizationRepository.create({
      name: 'Negative Count Org',
      status: 'ACTIVE',
      activeOwnerCount: -1,
    }),
  )
  const persisted = await OrganizationModel.findOne({ name: 'Negative Count Org' })
  assert.equal(persisted, null, 'the document must not be persisted')
})

test('toJSON output never includes __v', async () => {
  const organization = await organizationRepository.create({
    name: 'JSON Test',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  const json = organization.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { LocationModel } from '../models/location.model.js'
import * as locationRepository from './location.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'inv_001_location_repo_test' })
  await LocationModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await LocationModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a location without a code', async () => {
  const organizationId = oid()
  const location = await locationRepository.create({
    organizationId,
    name: 'Main Warehouse',
    status: 'ACTIVE',
  })
  assert.equal(location.name, 'Main Warehouse')
  assert.equal(location.status, 'ACTIVE')
  assert.equal(location.code, undefined)
})

test('creates a location with a code', async () => {
  const organizationId = oid()
  const location = await locationRepository.create({
    organizationId,
    name: 'Warehouse 1',
    code: 'WH-1',
    status: 'ACTIVE',
  })
  assert.equal(location.code, 'WH-1')
})

test('organizations are isolated: findById scopes by organizationId', async () => {
  const orgA = oid()
  const orgB = oid()
  const location = await locationRepository.create({
    organizationId: orgA,
    name: 'A',
    status: 'ACTIVE',
  })
  const foundByOwner = await locationRepository.findById(orgA, location._id)
  const foundByOther = await locationRepository.findById(orgB, location._id)
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('findByCode does not return a location belonging to a different organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await locationRepository.create({
    organizationId: orgA,
    name: 'A',
    code: 'SCOPED',
    status: 'ACTIVE',
  })
  const foundByOwner = await locationRepository.findByCode(orgA, 'SCOPED')
  const foundByOther = await locationRepository.findByCode(orgB, 'SCOPED')
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('list only returns locations belonging to the caller organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await locationRepository.create({ organizationId: orgA, name: 'A', status: 'ACTIVE' })
  await locationRepository.create({ organizationId: orgB, name: 'B', status: 'ACTIVE' })
  const result = await locationRepository.list(orgA, {}, { page: 1, limit: 20 })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.name, 'A')
})

test('the organizationId+code unique index rejects a duplicate at the database level', async () => {
  const organizationId = oid()
  await locationRepository.create({ organizationId, name: 'First', code: 'DUP', status: 'ACTIVE' })
  await assert.rejects(
    () =>
      locationRepository.create({ organizationId, name: 'Second', code: 'DUP', status: 'ACTIVE' }),
    ValidationError,
  )
})

test('the same code is allowed across two different organizations', async () => {
  const orgA = oid()
  const orgB = oid()
  await locationRepository.create({
    organizationId: orgA,
    name: 'A',
    code: 'SHARED',
    status: 'ACTIVE',
  })
  await assert.doesNotReject(() =>
    locationRepository.create({
      organizationId: orgB,
      name: 'B',
      code: 'SHARED',
      status: 'ACTIVE',
    }),
  )
})

test('two locations with no code can coexist (partial unique index)', async () => {
  const organizationId = oid()
  await assert.doesNotReject(async () => {
    await locationRepository.create({ organizationId, name: 'No Code 1', status: 'ACTIVE' })
    await locationRepository.create({ organizationId, name: 'No Code 2', status: 'ACTIVE' })
  })
})

test('concurrent creates with the same code: exactly one succeeds, the database index rejects the other', async () => {
  const organizationId = oid()
  const attempt = () =>
    locationRepository.create({ organizationId, name: 'Race', code: 'RACE-CODE', status: 'ACTIVE' })

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)
})

test('update cannot set organizationId (not part of UpdateLocationData)', async () => {
  const organizationId = oid()
  const location = await locationRepository.create({
    organizationId,
    name: 'Original',
    status: 'ACTIVE',
  })
  const updated = await locationRepository.update(organizationId, location._id, { name: 'Renamed' })
  assert.equal(updated?.organizationId.toString(), organizationId.toString())
  assert.equal(updated?.name, 'Renamed')
})

test('cross-organization update does not affect the location', async () => {
  const orgA = oid()
  const orgB = oid()
  const location = await locationRepository.create({
    organizationId: orgA,
    name: 'Protected',
    status: 'ACTIVE',
  })
  const result = await locationRepository.update(orgB, location._id, { name: 'Hijacked' })
  assert.equal(result, null)
  const stillOriginal = await locationRepository.findById(orgA, location._id)
  assert.equal(stillOriginal?.name, 'Protected')
})

test('archiving sets status to ARCHIVED and never deletes the document', async () => {
  const organizationId = oid()
  const location = await locationRepository.create({
    organizationId,
    name: 'To Archive',
    status: 'ACTIVE',
  })
  const archived = await locationRepository.archive(organizationId, location._id)
  assert.equal(archived?.status, 'ARCHIVED')
  const stillExists = await LocationModel.findById(location._id)
  assert.ok(stillExists)
})

test('cross-organization archive does not affect the location', async () => {
  const orgA = oid()
  const orgB = oid()
  const location = await locationRepository.create({
    organizationId: orgA,
    name: 'Not Yours',
    status: 'ACTIVE',
  })
  const result = await locationRepository.archive(orgB, location._id)
  assert.equal(result, null)
  const stillActive = await locationRepository.findById(orgA, location._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

test('toJSON output never includes __v', async () => {
  const organizationId = oid()
  const location = await locationRepository.create({
    organizationId,
    name: 'JSON Test',
    status: 'ACTIVE',
  })
  const json = location.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared index exists on the Location collection, including uniqueness and the code partial filter', async () => {
  const indexes = await LocationModel.collection.indexes()
  const codeIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, code: 1 }),
  )
  assert.ok(codeIndex, 'expected an {organizationId: 1, code: 1} index')
  assert.equal(codeIndex?.unique, true)
  assert.deepEqual(codeIndex?.partialFilterExpression, { code: { $exists: true } })
})

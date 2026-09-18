import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { LocationModel } from '../models/location.model.js'
import { createLocation, updateLocation, archiveLocation } from './location.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'inv_001_location_service_test' })
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

test('creates a valid location without a code', async () => {
  const organizationId = oid()
  const location = await createLocation(organizationId, { name: 'Main Warehouse' })
  assert.equal(location.name, 'Main Warehouse')
  assert.equal(location.status, 'ACTIVE')
  assert.equal(location.code, undefined)
})

test('creates a valid location with a code', async () => {
  const organizationId = oid()
  const location = await createLocation(organizationId, { name: 'Warehouse 1', code: 'WH-1' })
  assert.equal(location.code, 'WH-1')
})

test('trims a supplied code', async () => {
  const organizationId = oid()
  const location = await createLocation(organizationId, { name: 'Trim Test', code: '  WH-2  ' })
  assert.equal(location.code, 'WH-2')
})

test('an empty-string code is rejected by validation', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => createLocation(organizationId, { name: 'Empty Code', code: '' }),
    ZodError,
  )
})

test('a code exceeding the bounded length is rejected', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => createLocation(organizationId, { name: 'Too Long', code: 'X'.repeat(51) }),
    ZodError,
  )
})

test('an explicitly duplicate code is rejected, not silently mutated', async () => {
  const organizationId = oid()
  await createLocation(organizationId, { name: 'First', code: 'TAKEN' })
  await assert.rejects(
    () => createLocation(organizationId, { name: 'Second', code: 'TAKEN' }),
    ValidationError,
  )
})

test('no DRAFT status is accepted', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => createLocation(organizationId, { name: 'Draft Attempt', status: 'DRAFT' }),
    ZodError,
  )
})

test('strict validation rejects unknown fields on create', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => createLocation(organizationId, { name: 'Extra', quantityOnHand: 100 }),
    ZodError,
  )
})

test('strict validation rejects unknown fields on update', async () => {
  const organizationId = oid()
  const location = await createLocation(organizationId, { name: 'Target' })
  await assert.rejects(() => updateLocation(organizationId, location._id, { sku: 'X' }), ZodError)
})

test('updating to a duplicate code is rejected', async () => {
  const organizationId = oid()
  await createLocation(organizationId, { name: 'First', code: 'EXISTING' })
  const second = await createLocation(organizationId, { name: 'Second' })
  await assert.rejects(
    () => updateLocation(organizationId, second._id, { code: 'EXISTING' }),
    ValidationError,
  )
})

test('updating a non-existent location throws NotFoundError', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => updateLocation(organizationId, oid(), { name: 'Ghost' }),
    NotFoundError,
  )
})

test('updating a cross-organization location throws NotFoundError', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const location = await createLocation(organizationId, { name: 'Not Yours' })
  await assert.rejects(
    () => updateLocation(otherOrganizationId, location._id, { name: 'Hijacked' }),
    NotFoundError,
  )
})

test('archiving sets status to ARCHIVED and never deletes the document', async () => {
  const organizationId = oid()
  const location = await createLocation(organizationId, { name: 'To Archive' })
  const archived = await archiveLocation(organizationId, location._id)
  assert.equal(archived.status, 'ARCHIVED')
  const stillExists = await LocationModel.findById(location._id)
  assert.ok(stillExists)
})

test('archiving a non-existent (or cross-organization) location throws NotFoundError', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const location = await createLocation(organizationId, { name: 'Protected' })

  await assert.rejects(() => archiveLocation(organizationId, oid()), NotFoundError)
  await assert.rejects(() => archiveLocation(otherOrganizationId, location._id), NotFoundError)
})

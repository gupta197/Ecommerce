import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { CustomerModel } from '../models/customer.model.js'
import { AuditEventModel } from '../../audit/models/audit-event.model.js'
import {
  createCustomerProfile,
  getCustomerProfile,
  updateCustomerProfile,
  archiveCustomerProfile,
  restoreCustomerProfile,
} from './customer.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cust_001_customer_service_test' })
  await CustomerModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await CustomerModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a valid customer profile', async () => {
  const userId = oid()
  const customer = await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  assert.equal(customer.firstName, 'Ada')
  assert.equal(customer.status, 'ACTIVE')
  assert.equal(customer.userId.toString(), userId.toString())
})

test('creates a profile with optional displayName and phone', async () => {
  const userId = oid()
  const customer = await createCustomerProfile(userId, {
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: 'Ada L.',
    phone: '555-0100',
  })
  assert.equal(customer.displayName, 'Ada L.')
  assert.equal(customer.phone, '555-0100')
})

test('a second profile for the same user is rejected', async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  await assert.rejects(
    () => createCustomerProfile(userId, { firstName: 'Someone', lastName: 'Else' }),
    ValidationError,
  )
})

test('a different user can create their own profile independently', async () => {
  const userA = oid()
  const userB = oid()
  await createCustomerProfile(userA, { firstName: 'A', lastName: 'A' })
  await assert.doesNotReject(() => createCustomerProfile(userB, { firstName: 'B', lastName: 'B' }))
})

test('strict validation rejects unknown fields on create', async () => {
  const userId = oid()
  await assert.rejects(
    () => createCustomerProfile(userId, { firstName: 'A', lastName: 'B', isAdmin: true }),
    ZodError,
  )
})

test('create rejects attempts to inject userId, _id, status, createdAt, updatedAt', async () => {
  const userId = oid()
  const forbiddenFields = {
    userId: oid().toString(),
    _id: oid().toString(),
    status: 'ARCHIVED',
    createdAt: new Date('2000-01-01'),
    updatedAt: new Date('2000-01-01'),
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () => createCustomerProfile(userId, { firstName: 'A', lastName: 'B', [field]: value }),
      ZodError,
    )
  }
})

test('Mongo-operator-shaped values are rejected for firstName/lastName', async () => {
  const userId = oid()
  const operatorPayload = { $gt: '' }
  await assert.rejects(
    () => createCustomerProfile(userId, { firstName: operatorPayload, lastName: 'B' }),
    ZodError,
  )
})

test("getCustomerProfile returns the caller's own profile", async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  const found = await getCustomerProfile(userId)
  assert.equal(found.firstName, 'Ada')
})

test('getCustomerProfile throws NotFoundError when no profile exists yet', async () => {
  await assert.rejects(() => getCustomerProfile(oid()), NotFoundError)
})

test("getCustomerProfile never returns another user's profile", async () => {
  const userA = oid()
  const userB = oid()
  await createCustomerProfile(userA, { firstName: 'A', lastName: 'A' })
  await assert.rejects(() => getCustomerProfile(userB), NotFoundError)
})

test('updateCustomerProfile patches only the provided fields', async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace', phone: '555-0100' })
  const updated = await updateCustomerProfile(userId, { firstName: 'Augusta' })
  assert.equal(updated.firstName, 'Augusta')
  assert.equal(updated.lastName, 'Lovelace')
  assert.equal(updated.phone, '555-0100')
})

test('strict validation rejects unknown fields on update', async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  await assert.rejects(() => updateCustomerProfile(userId, { role: 'admin' }), ZodError)
})

test('update cannot change status through the general profile PATCH', async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  await assert.rejects(() => updateCustomerProfile(userId, { status: 'ARCHIVED' }), ZodError)
})

test('updateCustomerProfile throws NotFoundError for a user with no profile', async () => {
  await assert.rejects(() => updateCustomerProfile(oid(), { firstName: 'X' }), NotFoundError)
})

test("a different user cannot update another user's profile", async () => {
  const userA = oid()
  const userB = oid()
  await createCustomerProfile(userA, { firstName: 'A', lastName: 'A' })
  // updateCustomerProfile always resolves the target via the given userId,
  // so calling it with userB (who has no profile) can never reach userA's data.
  await assert.rejects(() => updateCustomerProfile(userB, { firstName: 'Hijacked' }), NotFoundError)
  const stillOriginal = await getCustomerProfile(userA)
  assert.equal(stillOriginal.firstName, 'A')
})

test('archive then restore round-trips correctly', async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  const archived = await archiveCustomerProfile(userId)
  assert.equal(archived.status, 'ARCHIVED')
  const restored = await restoreCustomerProfile(userId)
  assert.equal(restored.status, 'ACTIVE')
})

test('archiving never deletes the profile document', async () => {
  const userId = oid()
  const customer = await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  await archiveCustomerProfile(userId)
  const stillExists = await CustomerModel.findById(customer._id)
  assert.ok(stillExists)
})

test('an archived profile cannot be updated via the general PATCH', async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  await archiveCustomerProfile(userId)
  await assert.rejects(() => updateCustomerProfile(userId, { firstName: 'X' }), ValidationError)
})

test('an archived profile can still be read', async () => {
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  await archiveCustomerProfile(userId)
  const found = await getCustomerProfile(userId)
  assert.equal(found.status, 'ARCHIVED')
})

test('archiveCustomerProfile/restoreCustomerProfile throw NotFoundError for a user with no profile', async () => {
  await assert.rejects(() => archiveCustomerProfile(oid()), NotFoundError)
  await assert.rejects(() => restoreCustomerProfile(oid()), NotFoundError)
})

// NOTE: customer.archived/customer.restored are NOT wired into SEC-003's
// AuditEvent in this implementation — adding them would require extending
// AUDIT_ACTIONS/AUDIT_ENTITY_TYPES in modules/audit/models/audit-event.model.ts,
// which conflicts with the explicit "Do NOT modify SEC-003" boundary for this
// task. This is flagged in the implementation report as requiring your
// decision, not silently resolved. This test documents the current state
// (no audit event exists for any CUST-001 action) rather than leaving it
// unverified.
test('no AuditEvent is created for any customer profile lifecycle action (audit wiring not implemented — see report)', async () => {
  await AuditEventModel.deleteMany({})
  const userId = oid()
  await createCustomerProfile(userId, { firstName: 'Ada', lastName: 'Lovelace' })
  await updateCustomerProfile(userId, { firstName: 'Augusta' })
  await archiveCustomerProfile(userId)
  await restoreCustomerProfile(userId)
  const count = await AuditEventModel.countDocuments({})
  assert.equal(count, 0)
})

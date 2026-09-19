import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { CustomerModel } from '../models/customer.model.js'
import { AddressModel } from '../models/address.model.js'
import { createCustomerProfile, archiveCustomerProfile } from './customer.service.js'
import {
  createAddress,
  listAddresses,
  updateAddress,
  archiveAddress,
  setDefaultAddress,
} from './address.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

// Requires a real replica set — setDefaultAddress() uses withTransaction(),
// which a standalone MongoMemoryServer cannot run.
let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'cust_001_address_service_test' })
  await Promise.all([CustomerModel.init(), AddressModel.init()])
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([CustomerModel.deleteMany({}), AddressModel.deleteMany({})])
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

async function createRealCustomer() {
  return createCustomerProfile(oid(), { firstName: 'Ada', lastName: 'Lovelace' })
}

function validAddressInput(overrides: Record<string, unknown> = {}) {
  return {
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    city: 'London',
    state: 'London',
    postalCode: 'AB1 2CD',
    country: 'UK',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// CRUD / validation
// ---------------------------------------------------------------------------

test('creates a valid address', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  assert.equal(address.recipientName, 'Ada Lovelace')
  assert.equal(address.isDefaultBilling, false)
  assert.equal(address.isDefaultShipping, false)
  assert.equal(address.status, 'ACTIVE')
})

test('an address can have its own recipientName/phone independent of the customer', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(
    customer._id,
    validAddressInput({ recipientName: 'Gift Recipient', phone: '555-0199' }),
  )
  assert.equal(address.recipientName, 'Gift Recipient')
  assert.equal(address.phone, '555-0199')
})

test('strict validation rejects unknown fields on create', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () => createAddress(customer._id, validAddressInput({ isDefaultBilling: true })),
    ZodError,
  )
})

test('create rejects attempts to inject customerId, _id, status, isDefaultBilling, isDefaultShipping', async () => {
  const customer = await createRealCustomer()
  const forbiddenFields = {
    customerId: oid().toString(),
    _id: oid().toString(),
    status: 'ARCHIVED',
    isDefaultBilling: true,
    isDefaultShipping: true,
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () => createAddress(customer._id, validAddressInput({ [field]: value })),
      ZodError,
    )
  }
})

test('Mongo-operator-shaped values are rejected for address fields', async () => {
  const customer = await createRealCustomer()
  const operatorPayload = { $gt: '' }
  await assert.rejects(
    () => createAddress(customer._id, validAddressInput({ city: operatorPayload })),
    ZodError,
  )
})

test("listAddresses only returns the caller's own addresses", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createCustomerProfile(oid(), { firstName: 'B', lastName: 'B' })
  await createAddress(customerA._id, validAddressInput())
  await createAddress(customerB._id, validAddressInput())
  const results = await listAddresses(customerA._id)
  assert.equal(results.length, 1)
})

test('updateAddress patches only the provided fields', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  const updated = await updateAddress(customer._id, address._id, { city: 'Manchester' })
  assert.equal(updated.city, 'Manchester')
  assert.equal(updated.line1, '1 Analytical Engine Way')
})

test('strict validation rejects unknown fields on update', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  await assert.rejects(() => updateAddress(customer._id, address._id, { foo: 'bar' }), ZodError)
})

test('update cannot change isDefaultBilling/isDefaultShipping/status through the general PATCH', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  await assert.rejects(
    () => updateAddress(customer._id, address._id, { isDefaultBilling: true }),
    ZodError,
  )
  await assert.rejects(
    () => updateAddress(customer._id, address._id, { status: 'ARCHIVED' }),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// Cross-customer IDOR
// ---------------------------------------------------------------------------

test("a different customer cannot read, update, archive, or set-default another customer's address", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createCustomerProfile(oid(), { firstName: 'B', lastName: 'B' })
  const address = await createAddress(customerA._id, validAddressInput())

  const listForB = await listAddresses(customerB._id)
  assert.equal(listForB.length, 0)

  await assert.rejects(
    () => updateAddress(customerB._id, address._id, { city: 'Hijacked' }),
    NotFoundError,
  )
  await assert.rejects(() => archiveAddress(customerB._id, address._id), NotFoundError)
  await assert.rejects(
    () => setDefaultAddress(customerB._id, address._id, { type: 'billing' }),
    NotFoundError,
  )

  const stillOriginal = await listAddresses(customerA._id)
  assert.equal(stillOriginal[0]?.city, 'London')
})

// ---------------------------------------------------------------------------
// Archived customer / archived address write-blocking
// ---------------------------------------------------------------------------

test('an archived customer cannot create, update, archive, or set-default an address', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  await archiveCustomerProfile(customer.userId)

  await assert.rejects(() => createAddress(customer._id, validAddressInput()), ValidationError)
  await assert.rejects(
    () => updateAddress(customer._id, address._id, { city: 'X' }),
    ValidationError,
  )
  await assert.rejects(() => archiveAddress(customer._id, address._id), ValidationError)
  await assert.rejects(
    () => setDefaultAddress(customer._id, address._id, { type: 'billing' }),
    ValidationError,
  )
})

test('an archived customer can still read their addresses', async () => {
  const customer = await createRealCustomer()
  await createAddress(customer._id, validAddressInput())
  await archiveCustomerProfile(customer.userId)
  const results = await listAddresses(customer._id)
  assert.equal(results.length, 1)
})

test('an archived address cannot be updated or made default', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  await archiveAddress(customer._id, address._id)

  await assert.rejects(
    () => updateAddress(customer._id, address._id, { city: 'X' }),
    ValidationError,
  )
  await assert.rejects(
    () => setDefaultAddress(customer._id, address._id, { type: 'billing' }),
    ValidationError,
  )
})

test('archiving an address never deletes it', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  await archiveAddress(customer._id, address._id)
  const stillExists = await AddressModel.findById(address._id)
  assert.ok(stillExists)
})

// ---------------------------------------------------------------------------
// Default billing / default shipping
// ---------------------------------------------------------------------------

test('setDefaultAddress sets the requested address as default billing', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  const updated = await setDefaultAddress(customer._id, address._id, { type: 'billing' })
  assert.equal(updated.isDefaultBilling, true)
  assert.equal(updated.isDefaultShipping, false)
})

test('setDefaultAddress switches the default from one address to another', async () => {
  const customer = await createRealCustomer()
  const addressA = await createAddress(customer._id, validAddressInput())
  const addressB = await createAddress(customer._id, validAddressInput({ line1: 'Line B' }))

  await setDefaultAddress(customer._id, addressA._id, { type: 'shipping' })
  await setDefaultAddress(customer._id, addressB._id, { type: 'shipping' })

  const results = await listAddresses(customer._id)
  const a = results.find((r) => r._id.toString() === addressA._id.toString())
  const b = results.find((r) => r._id.toString() === addressB._id.toString())
  assert.equal(a?.isDefaultShipping, false)
  assert.equal(b?.isDefaultShipping, true)
})

test('default billing and default shipping are independent', async () => {
  const customer = await createRealCustomer()
  const addressA = await createAddress(customer._id, validAddressInput())
  const addressB = await createAddress(customer._id, validAddressInput({ line1: 'Line B' }))

  await setDefaultAddress(customer._id, addressA._id, { type: 'billing' })
  await setDefaultAddress(customer._id, addressB._id, { type: 'shipping' })

  const results = await listAddresses(customer._id)
  const a = results.find((r) => r._id.toString() === addressA._id.toString())
  const b = results.find((r) => r._id.toString() === addressB._id.toString())
  assert.equal(a?.isDefaultBilling, true)
  assert.equal(a?.isDefaultShipping, false)
  assert.equal(b?.isDefaultBilling, false)
  assert.equal(b?.isDefaultShipping, true)
})

test('setDefaultAddress on a nonexistent address throws NotFoundError', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () => setDefaultAddress(customer._id, oid(), { type: 'billing' }),
    NotFoundError,
  )
})

test('setDefaultAddress rejects a malformed type', async () => {
  const customer = await createRealCustomer()
  const address = await createAddress(customer._id, validAddressInput())
  await assert.rejects(
    () => setDefaultAddress(customer._id, address._id, { type: 'invalid' }),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// Transaction rollback
// ---------------------------------------------------------------------------

test('setDefaultAddress on an archived target rolls back cleanly (no partial default change)', async () => {
  const customer = await createRealCustomer()
  const addressA = await createAddress(customer._id, validAddressInput())
  const addressB = await createAddress(customer._id, validAddressInput({ line1: 'Line B' }))
  await setDefaultAddress(customer._id, addressA._id, { type: 'billing' })
  await archiveAddress(customer._id, addressB._id)

  await assert.rejects(
    () => setDefaultAddress(customer._id, addressB._id, { type: 'billing' }),
    ValidationError,
  )

  // addressA must still be the default — the attempted swap must not have
  // partially cleared the old default before failing.
  const results = await listAddresses(customer._id)
  const a = results.find((r) => r._id.toString() === addressA._id.toString())
  const b = results.find((r) => r._id.toString() === addressB._id.toString())
  assert.equal(a?.isDefaultBilling, true)
  assert.equal(b?.isDefaultBilling, false)
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('CONCURRENCY: two concurrent setDefaultAddress calls for different addresses of the same customer resolve to exactly one default, never both', async () => {
  const customer = await createRealCustomer()
  const addressA = await createAddress(customer._id, validAddressInput())
  const addressB = await createAddress(customer._id, validAddressInput({ line1: 'Line B' }))

  const results = await Promise.allSettled([
    setDefaultAddress(customer._id, addressA._id, { type: 'shipping' }),
    setDefaultAddress(customer._id, addressB._id, { type: 'shipping' }),
  ])

  assert.ok(
    results.every((r) => r.status === 'fulfilled'),
    'both calls should complete without error',
  )

  const finalAddresses = await listAddresses(customer._id)
  const defaults = finalAddresses.filter((a) => a.isDefaultShipping)
  assert.equal(
    defaults.length,
    1,
    'exactly one address must end up as the default shipping address',
  )
})

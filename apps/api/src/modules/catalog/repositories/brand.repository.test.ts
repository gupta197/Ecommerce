import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { BrandModel } from '../models/brand.model.js'
import * as brandRepository from './brand.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_002_repo_test' })
  await BrandModel.init() // wait for index builds so index-dependent tests never flake
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await BrandModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a brand', async () => {
  const org = oid()
  const brand = await brandRepository.create({
    organizationId: org,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  assert.equal(brand.name, 'Nike')
  assert.equal(brand.slug, 'nike')
})

test('brands are isolated by organization', async () => {
  const orgA = oid()
  const orgB = oid()

  await brandRepository.create({
    organizationId: orgA,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  const foundInA = await BrandModel.find({ organizationId: orgA })
  const foundInB = await BrandModel.find({ organizationId: orgB })

  assert.equal(foundInA.length, 1)
  assert.equal(foundInB.length, 0)
})

test('findById does not return a brand belonging to a different organization', async () => {
  const orgA = oid()
  const orgB = oid()
  const created = await brandRepository.create({
    organizationId: orgA,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  const foundAsOwner = await brandRepository.findById(orgA, created._id)
  const foundAsOther = await brandRepository.findById(orgB, created._id)

  assert.ok(foundAsOwner)
  assert.equal(foundAsOther, null)
})

test('findBySlug does not return a brand belonging to a different organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await brandRepository.create({
    organizationId: orgA,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  const foundAsOwner = await brandRepository.findBySlug(orgA, 'nike')
  const foundAsOther = await brandRepository.findBySlug(orgB, 'nike')

  assert.ok(foundAsOwner)
  assert.equal(foundAsOther, null)
})

test('list only returns brands belonging to the caller organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await brandRepository.create({
    organizationId: orgA,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })
  await brandRepository.create({
    organizationId: orgB,
    name: 'Adidas',
    slug: 'adidas',
    status: 'ACTIVE',
  })

  const resultA = await brandRepository.list(orgA, {}, { page: 1, limit: 20 })

  assert.equal(resultA.total, 1)
  assert.equal(resultA.items[0]?.name, 'Nike')
})

test('the organizationId+slug unique index rejects a duplicate at the database level', async () => {
  const org = oid()
  await brandRepository.create({
    organizationId: org,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  await assert.rejects(
    () =>
      brandRepository.create({
        organizationId: org,
        name: 'Nike Duplicate',
        slug: 'nike',
        status: 'ACTIVE',
      }),
    ValidationError,
  )
})

test('the same slug is allowed across two different organizations', async () => {
  const orgA = oid()
  const orgB = oid()
  await brandRepository.create({
    organizationId: orgA,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  await assert.doesNotReject(() =>
    brandRepository.create({ organizationId: orgB, name: 'Nike', slug: 'nike', status: 'ACTIVE' }),
  )
})

test('concurrent creates with the same slug: exactly one succeeds, the database index rejects the other', async () => {
  const org = oid()
  const attempt = () =>
    brandRepository.create({ organizationId: org, name: 'Puma', slug: 'puma', status: 'ACTIVE' })

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  const rejection = rejected[0] as PromiseRejectedResult
  assert.ok(rejection.reason instanceof ValidationError)
})

test('update cannot set organizationId (not part of UpdateBrandData)', async () => {
  const org = oid()
  const created = await brandRepository.create({
    organizationId: org,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  const updated = await brandRepository.update(org, created._id, { name: 'Nike Renamed' })

  assert.equal(updated?.organizationId.toString(), org.toString())
  assert.equal(updated?.name, 'Nike Renamed')
})

test('cross-organization update does not affect the brand', async () => {
  const orgA = oid()
  const orgB = oid()
  const created = await brandRepository.create({
    organizationId: orgA,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  const result = await brandRepository.update(orgB, created._id, { name: 'Hacked' })
  assert.equal(result, null)

  const stillOriginal = await brandRepository.findById(orgA, created._id)
  assert.equal(stillOriginal?.name, 'Nike')
})

test('archived brands remain directly queryable', async () => {
  const org = oid()
  const created = await brandRepository.create({
    organizationId: org,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  await brandRepository.archive(org, created._id)
  const found = await brandRepository.findById(org, created._id)

  assert.ok(found)
  assert.equal(found?.status, 'ARCHIVED')
})

test('cross-organization archive does not affect the brand', async () => {
  const orgA = oid()
  const orgB = oid()
  const created = await brandRepository.create({
    organizationId: orgA,
    name: 'Nike',
    slug: 'nike',
    status: 'ACTIVE',
  })

  const result = await brandRepository.archive(orgB, created._id)
  assert.equal(result, null)

  const stillActive = await brandRepository.findById(orgA, created._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

test('the declared index exists on the Brand collection, including uniqueness', async () => {
  const indexes = await BrandModel.collection.indexes()
  const slugIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, slug: 1 }),
  )

  assert.ok(slugIndex, 'expected an {organizationId, slug} index')
  assert.equal(slugIndex?.unique, true)
})

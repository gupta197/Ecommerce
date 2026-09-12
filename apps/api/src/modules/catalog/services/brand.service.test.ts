import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ZodError } from 'zod'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { BrandModel } from '../models/brand.model.js'
import * as brandRepository from '../repositories/brand.repository.js'
import { createBrand, updateBrand, archiveBrand } from './brand.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_002_service_test' })
  await BrandModel.init()
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

test('creates a valid brand with an auto-generated slug', async () => {
  const org = oid()
  const brand = await createBrand(org, { name: 'Nike' })

  assert.equal(brand.name, 'Nike')
  assert.equal(brand.slug, 'nike')
  assert.equal(brand.status, 'DRAFT')
  assert.equal(brand.organizationId.toString(), org.toString())
})

test('auto-generated slug gets a numeric suffix on collision', async () => {
  const org = oid()
  await createBrand(org, { name: 'Nike' })
  const second = await createBrand(org, { name: 'Nike' })
  const third = await createBrand(org, { name: 'Nike' })

  assert.equal(second.slug, 'nike-2')
  assert.equal(third.slug, 'nike-3')
})

test('an explicitly supplied duplicate slug is rejected, not silently mutated', async () => {
  const org = oid()
  await createBrand(org, { name: 'Nike', slug: 'nike' })

  await assert.rejects(
    () => createBrand(org, { name: 'Something Else', slug: 'nike' }),
    ValidationError,
  )
})

test('renaming a brand does not change its slug', async () => {
  const org = oid()
  const brand = await createBrand(org, { name: 'Nike' })

  const updated = await updateBrand(org, brand._id, { name: 'Nike Inc.' })

  assert.equal(updated.name, 'Nike Inc.')
  assert.equal(updated.slug, 'nike')
})

test('archiving sets status to ARCHIVED and never deletes the document', async () => {
  const org = oid()
  const brand = await createBrand(org, { name: 'Nike' })

  const archived = await archiveBrand(org, brand._id)
  assert.equal(archived.status, 'ARCHIVED')

  const stillExists = await brandRepository.findById(org, brand._id)
  assert.ok(stillExists)
})

test('archiving a non-existent (or cross-organization) brand throws NotFoundError', async () => {
  const org = oid()
  await assert.rejects(() => archiveBrand(org, oid()), NotFoundError)
})

test('updating a non-existent (or cross-organization) brand throws NotFoundError', async () => {
  const orgA = oid()
  const orgB = oid()
  const brand = await createBrand(orgB, { name: 'Nike' })

  await assert.rejects(() => updateBrand(orgA, brand._id, { name: 'Hacked' }), NotFoundError)
})

test('strict validation rejects unknown fields on create', async () => {
  const org = oid()
  await assert.rejects(() => createBrand(org, { name: 'Nike', notARealField: 'x' }), ZodError)
})

test('strict validation rejects unknown fields on update', async () => {
  const org = oid()
  const brand = await createBrand(org, { name: 'Nike' })
  await assert.rejects(
    () => updateBrand(org, brand._id, { organizationId: oid().toString() }),
    ZodError,
  )
})

test('an invalid logo URL is rejected', async () => {
  const org = oid()
  await assert.rejects(
    () => createBrand(org, { name: 'Nike', logo: { url: 'not-a-url' } }),
    ZodError,
  )
})

test('an invalid status value is rejected', async () => {
  const org = oid()
  await assert.rejects(() => createBrand(org, { name: 'Nike', status: 'PUBLISHED' }), ZodError)
})

test('a partial update preserves untouched fields', async () => {
  const org = oid()
  const brand = await createBrand(org, { name: 'Nike', description: 'Original description' })

  const updated = await updateBrand(org, brand._id, { name: 'Nike Renamed' })

  assert.equal(updated.name, 'Nike Renamed')
  assert.equal(updated.description, 'Original description')
})

test('a valid logo is accepted and persisted', async () => {
  const org = oid()
  const brand = await createBrand(org, {
    name: 'Nike',
    logo: { url: 'https://example.com/nike-logo.png', altText: 'Nike logo' },
  })

  assert.equal(brand.logo?.url, 'https://example.com/nike-logo.png')
  assert.equal(brand.logo?.altText, 'Nike logo')
})

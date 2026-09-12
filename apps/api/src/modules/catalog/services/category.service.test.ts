import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ZodError } from 'zod'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { CategoryModel } from '../models/category.model.js'
import * as categoryRepository from '../repositories/category.repository.js'
import { createCategory, updateCategory, archiveCategory } from './category.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import { paginationSchema, objectIdSchema } from '../validation/common.schema.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_001_service_test' })
  await CategoryModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await CategoryModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a valid category with an auto-generated slug', async () => {
  const org = oid()
  const category = await createCategory(org, { name: 'Men' })

  assert.equal(category.name, 'Men')
  assert.equal(category.slug, 'men')
  assert.equal(category.status, 'DRAFT')
  assert.equal(category.organizationId.toString(), org.toString())
})

test('auto-generated slug gets a numeric suffix on collision', async () => {
  const org = oid()
  await createCategory(org, { name: 'Vests' })
  const second = await createCategory(org, { name: 'Vests' })
  const third = await createCategory(org, { name: 'Vests' })

  assert.equal(second.slug, 'vests-2')
  assert.equal(third.slug, 'vests-3')
})

test('an explicitly supplied duplicate slug is rejected, not silently mutated', async () => {
  const org = oid()
  await createCategory(org, { name: 'Vests', slug: 'vests' })

  await assert.rejects(
    () => createCategory(org, { name: 'Something Else', slug: 'vests' }),
    ValidationError,
  )
})

test('creating with a parentId in a different organization is rejected', async () => {
  const orgA = oid()
  const orgB = oid()
  const parentInB = await createCategory(orgB, { name: 'Men' })

  await assert.rejects(
    () => createCategory(orgA, { name: 'Innerwear', parentId: parentInB._id.toString() }),
    ValidationError,
  )
})

test('creating with a non-existent parentId is rejected', async () => {
  const org = oid()
  await assert.rejects(
    () => createCategory(org, { name: 'Innerwear', parentId: oid().toString() }),
    ValidationError,
  )
})

test('creating with an archived parentId is rejected', async () => {
  const org = oid()
  const parent = await createCategory(org, { name: 'Men' })
  await archiveCategory(org, parent._id)

  await assert.rejects(
    () => createCategory(org, { name: 'Innerwear', parentId: parent._id.toString() }),
    ValidationError,
  )
})

test('a category cannot be updated to be its own parent', async () => {
  const org = oid()
  const category = await createCategory(org, { name: 'Men' })

  await assert.rejects(
    () => updateCategory(org, category._id, { parentId: category._id.toString() }),
    ValidationError,
  )
})

test('a hierarchy cycle is rejected', async () => {
  const org = oid()
  const men = await createCategory(org, { name: 'Men' })
  const innerwear = await createCategory(org, { name: 'Innerwear', parentId: men._id.toString() })
  const vests = await createCategory(org, { name: 'Vests', parentId: innerwear._id.toString() })

  // Men -> Innerwear -> Vests already exists; making Men a child of Vests
  // would close the loop.
  await assert.rejects(
    () => updateCategory(org, men._id, { parentId: vests._id.toString() }),
    ValidationError,
  )
})

test('a valid hierarchy update succeeds', async () => {
  const org = oid()
  const men = await createCategory(org, { name: 'Men' })
  const women = await createCategory(org, { name: 'Women' })
  const innerwear = await createCategory(org, { name: 'Innerwear', parentId: men._id.toString() })

  const moved = await updateCategory(org, innerwear._id, { parentId: women._id.toString() })

  assert.equal(moved.parentId?.toString(), women._id.toString())
})

test('archiving sets status to ARCHIVED and never deletes the document', async () => {
  const org = oid()
  const category = await createCategory(org, { name: 'Men' })

  const archived = await archiveCategory(org, category._id)
  assert.equal(archived.status, 'ARCHIVED')

  const stillExists = await categoryRepository.findById(org, category._id)
  assert.ok(stillExists)
})

test('archiving a parent does not cascade to its children', async () => {
  const org = oid()
  const men = await createCategory(org, { name: 'Men' })
  const innerwear = await createCategory(org, {
    name: 'Innerwear',
    parentId: men._id.toString(),
    status: 'ACTIVE',
  })

  await archiveCategory(org, men._id)

  const child = await categoryRepository.findById(org, innerwear._id)
  assert.equal(child?.status, 'ACTIVE')
})

test('archiving a non-existent (or cross-organization) category throws NotFoundError', async () => {
  const org = oid()
  await assert.rejects(() => archiveCategory(org, oid()), NotFoundError)
})

test('updating a non-existent category throws NotFoundError', async () => {
  const org = oid()
  await assert.rejects(() => updateCategory(org, oid(), { name: 'New Name' }), NotFoundError)
})

test('strict validation rejects unknown fields on create', async () => {
  const org = oid()
  await assert.rejects(() => createCategory(org, { name: 'Men', notARealField: 'x' }), ZodError)
})

test('strict validation rejects unknown fields on update', async () => {
  const org = oid()
  const category = await createCategory(org, { name: 'Men' })
  await assert.rejects(
    () => updateCategory(org, category._id, { organizationId: oid().toString() }),
    ZodError,
  )
})

test('a malformed ObjectId as parentId is rejected by validation', async () => {
  const org = oid()
  await assert.rejects(
    () => createCategory(org, { name: 'Innerwear', parentId: 'not-a-real-id' }),
    ZodError,
  )
})

test('updates only persist allowlisted fields', async () => {
  const org = oid()
  const category = await createCategory(org, { name: 'Men', description: 'Original' })

  const updated = await updateCategory(org, category._id, { name: 'Men Renamed' })

  assert.equal(updated.name, 'Men Renamed')
  assert.equal(updated.description, 'Original') // untouched, not wiped by the patch
})

test('pagination schema applies sensible defaults and enforces bounds', () => {
  const defaults = paginationSchema.parse({})
  assert.equal(defaults.page, 1)
  assert.equal(defaults.limit, 20)

  assert.throws(() => paginationSchema.parse({ page: 0 }), ZodError)
  assert.throws(() => paginationSchema.parse({ limit: 101 }), ZodError)

  const atMax = paginationSchema.parse({ limit: 100 })
  assert.equal(atMax.limit, 100)
})

test('objectIdSchema rejects a 12-character non-hex string that ObjectId.isValid would otherwise accept', () => {
  assert.throws(() => objectIdSchema.parse('notarealidxx'), ZodError)
})

test('objectIdSchema accepts a real 24-character hex ObjectId string', () => {
  const id = oid().toString()
  assert.equal(objectIdSchema.parse(id), id)
})

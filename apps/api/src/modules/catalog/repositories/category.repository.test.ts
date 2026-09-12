import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { CategoryModel } from '../models/category.model.js'
import * as categoryRepository from './category.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_001_repo_test' })
  await CategoryModel.init() // wait for index builds so index-dependent tests never flake
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

test('categories are isolated by organization', async () => {
  const orgA = oid()
  const orgB = oid()

  await categoryRepository.create({
    organizationId: orgA,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  const foundInA = await CategoryModel.find({ organizationId: orgA })
  const foundInB = await CategoryModel.find({ organizationId: orgB })

  assert.equal(foundInA.length, 1)
  assert.equal(foundInB.length, 0)
})

test('findById does not return a category belonging to a different organization', async () => {
  const orgA = oid()
  const orgB = oid()
  const created = await categoryRepository.create({
    organizationId: orgA,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  const foundAsOwner = await categoryRepository.findById(orgA, created._id)
  const foundAsOther = await categoryRepository.findById(orgB, created._id)

  assert.ok(foundAsOwner)
  assert.equal(foundAsOther, null)
})

test('findBySlug does not return a category belonging to a different organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await categoryRepository.create({
    organizationId: orgA,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  const foundAsOwner = await categoryRepository.findBySlug(orgA, 'men')
  const foundAsOther = await categoryRepository.findBySlug(orgB, 'men')

  assert.ok(foundAsOwner)
  assert.equal(foundAsOther, null)
})

test('findChildren returns children ordered by sortOrder', async () => {
  const org = oid()
  const parent = await categoryRepository.create({
    organizationId: org,
    name: 'Innerwear',
    slug: 'innerwear',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  await categoryRepository.create({
    organizationId: org,
    name: 'Briefs',
    slug: 'briefs',
    parentId: parent._id,
    status: 'ACTIVE',
    sortOrder: 2,
  })
  await categoryRepository.create({
    organizationId: org,
    name: 'Vests',
    slug: 'vests',
    parentId: parent._id,
    status: 'ACTIVE',
    sortOrder: 1,
  })

  const children = await categoryRepository.findChildren(org, parent._id)

  assert.deepEqual(
    children.map((c) => c.name),
    ['Vests', 'Briefs'],
  )
})

test('root categories are found via findChildren(org, null) whether parentId is explicitly null or entirely absent', async () => {
  const org = oid()

  await categoryRepository.create({
    organizationId: org,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  // Inserted directly through the model with parentId entirely omitted, to
  // prove findChildren(org, null) doesn't merely work by coincidence of
  // every document also storing an explicit null.
  await CategoryModel.create({
    organizationId: org,
    name: 'Women',
    slug: 'women',
    status: 'ACTIVE',
    sortOrder: 1,
  })

  const roots = await categoryRepository.findChildren(org, null)

  assert.deepEqual(roots.map((c) => c.name).sort(), ['Men', 'Women'])
})

test('the organizationId+slug unique index rejects a duplicate at the database level', async () => {
  const org = oid()
  await categoryRepository.create({
    organizationId: org,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  await assert.rejects(
    () =>
      categoryRepository.create({
        organizationId: org,
        name: 'Men Duplicate',
        slug: 'men',
        parentId: null,
        status: 'ACTIVE',
        sortOrder: 0,
      }),
    ValidationError,
  )
})

test('the same slug is allowed across two different organizations', async () => {
  const orgA = oid()
  const orgB = oid()
  await categoryRepository.create({
    organizationId: orgA,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  await assert.doesNotReject(() =>
    categoryRepository.create({
      organizationId: orgB,
      name: 'Men',
      slug: 'men',
      parentId: null,
      status: 'ACTIVE',
      sortOrder: 0,
    }),
  )
})

test('concurrent creates with the same slug: exactly one succeeds, the database index rejects the other', async () => {
  const org = oid()
  const attempt = () =>
    categoryRepository.create({
      organizationId: org,
      name: 'Vests',
      slug: 'vests',
      parentId: null,
      status: 'ACTIVE',
      sortOrder: 0,
    })

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  const rejection = rejected[0] as PromiseRejectedResult
  assert.ok(rejection.reason instanceof ValidationError)
})

test('archived categories remain directly queryable', async () => {
  const org = oid()
  const created = await categoryRepository.create({
    organizationId: org,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  await categoryRepository.archive(org, created._id)
  const found = await categoryRepository.findById(org, created._id)

  assert.ok(found)
  assert.equal(found?.status, 'ARCHIVED')
})

test('update cannot set organizationId (not part of UpdateCategoryData)', async () => {
  const org = oid()
  const created = await categoryRepository.create({
    organizationId: org,
    name: 'Men',
    slug: 'men',
    parentId: null,
    status: 'ACTIVE',
    sortOrder: 0,
  })

  const updated = await categoryRepository.update(org, created._id, { name: 'Men Renamed' })

  assert.equal(updated?.organizationId.toString(), org.toString())
  assert.equal(updated?.name, 'Men Renamed')
})

test('the declared indexes exist on the Category collection, including uniqueness', async () => {
  const indexes = await CategoryModel.collection.indexes()
  const bySlugIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, slug: 1 }),
  )
  const hierarchyIndex = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, parentId: 1, sortOrder: 1 }),
  )

  assert.ok(bySlugIndex, 'expected an {organizationId, slug} index')
  assert.equal(bySlugIndex?.unique, true)
  assert.ok(hierarchyIndex, 'expected an {organizationId, parentId, sortOrder} index')
})

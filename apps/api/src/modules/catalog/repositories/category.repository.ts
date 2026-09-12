import { Types } from 'mongoose'
import {
  CategoryModel,
  type CategoryAttrs,
  type CategoryDocument,
  type CategoryStatus,
} from '../models/category.model.js'
import { ValidationError } from '../../../lib/http-errors.js'

export interface CreateCategoryData {
  organizationId: Types.ObjectId
  name: string
  slug: string
  description?: string
  parentId?: Types.ObjectId | null
  status: CategoryStatus
  sortOrder: number
}

export interface UpdateCategoryData {
  name?: string
  slug?: string
  description?: string
  parentId?: Types.ObjectId | null
  status?: CategoryStatus
  sortOrder?: number
}

export interface ListCategoriesFilter {
  parentId?: Types.ObjectId | null
  status?: CategoryStatus
}

export interface ListCategoriesOptions {
  page: number
  limit: number
}

export interface ListCategoriesResult {
  items: CategoryDocument[]
  total: number
}

const DUPLICATE_KEY_ERROR_CODE = 11000
const DUPLICATE_SLUG_MESSAGE = 'A category with this slug already exists in this organization.'

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}

function duplicateSlugError(): ValidationError {
  return new ValidationError(DUPLICATE_SLUG_MESSAGE, [
    { path: 'slug', message: 'Slug must be unique within the organization' },
  ])
}

export async function create(data: CreateCategoryData): Promise<CategoryDocument> {
  try {
    return await CategoryModel.create(data)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicateSlugError()
    }
    throw error
  }
}

export async function findById(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<CategoryDocument | null> {
  return CategoryModel.findOne({ _id: id, organizationId })
}

export async function findBySlug(
  organizationId: Types.ObjectId,
  slug: string,
): Promise<CategoryDocument | null> {
  return CategoryModel.findOne({ organizationId, slug })
}

export async function existsWithSlug(
  organizationId: Types.ObjectId,
  slug: string,
  excludeId?: Types.ObjectId,
): Promise<boolean> {
  const filter: Record<string, unknown> = { organizationId, slug }
  if (excludeId) {
    filter._id = { $ne: excludeId }
  }
  const match = await CategoryModel.exists(filter)
  return match !== null
}

/** `parentId: null` matches both categories with parentId explicitly null
 *  and categories where the field is entirely absent — standard MongoDB
 *  equality-with-null semantics, verified by a dedicated repository test
 *  rather than assumed. */
export async function findChildren(
  organizationId: Types.ObjectId,
  parentId: Types.ObjectId | null,
): Promise<CategoryDocument[]> {
  return CategoryModel.find({ organizationId, parentId }).sort({ sortOrder: 1, _id: 1 })
}

export async function list(
  organizationId: Types.ObjectId,
  filter: ListCategoriesFilter,
  options: ListCategoriesOptions,
): Promise<ListCategoriesResult> {
  const query: Record<string, unknown> = { organizationId }
  if (filter.parentId !== undefined) {
    query.parentId = filter.parentId
  }
  if (filter.status) {
    query.status = filter.status
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    CategoryModel.find(query).sort({ sortOrder: 1, _id: 1 }).skip(skip).limit(options.limit),
    CategoryModel.countDocuments(query),
  ])

  return { items, total }
}

export async function update(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  patch: UpdateCategoryData,
): Promise<CategoryDocument | null> {
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }

  try {
    return await CategoryModel.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: setDoc },
      { returnDocument: 'after' },
    )
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicateSlugError()
    }
    throw error
  }
}

export async function archive(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<CategoryDocument | null> {
  return CategoryModel.findOneAndUpdate(
    { _id: id, organizationId },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

/** True if `candidateAncestorId` is `categoryId` itself, or one of its
 *  existing ancestors — used to reject a parentId change that would create
 *  a hierarchy cycle, before the change is ever persisted. */
export async function isDescendantOf(
  organizationId: Types.ObjectId,
  candidateAncestorId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<boolean> {
  let currentId: Types.ObjectId | null | undefined = candidateAncestorId
  const visited = new Set<string>()

  while (currentId) {
    if (currentId.equals(categoryId)) {
      return true
    }
    const idStr = currentId.toString()
    if (visited.has(idStr)) {
      // Defensive only: an existing corrupt cycle must not hang this loop.
      return true
    }
    visited.add(idStr)

    const current: Pick<CategoryAttrs, 'parentId'> | null = await CategoryModel.findOne({
      _id: currentId,
      organizationId,
    })
      .select('parentId')
      .lean()
    currentId = current?.parentId ?? null
  }

  return false
}

import { Types } from 'mongoose'
import * as categoryRepository from '../repositories/category.repository.js'
import type { UpdateCategoryData } from '../repositories/category.repository.js'
import { slugify } from '../lib/slugify.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from '../validation/category.schema.js'
import type { CategoryDocument } from '../models/category.model.js'

const MAX_SLUG_SUFFIX_ATTEMPTS = 50
const FALLBACK_SLUG_BASE = 'category'

function slugConflictError(): ValidationError {
  return new ValidationError('This slug is already in use in this organization.', [
    { path: 'slug', message: 'Slug already exists' },
  ])
}

/** Validates that `parentId` exists in this organization, is not archived,
 *  and — when `selfId` is given (an update) — would not create a self-
 *  reference or a hierarchy cycle. Never trusts that a syntactically valid
 *  ObjectId implies a real, owned, usable parent. */
async function assertValidParent(
  organizationId: Types.ObjectId,
  parentId: Types.ObjectId,
  selfId?: Types.ObjectId,
): Promise<void> {
  const parent = await categoryRepository.findById(organizationId, parentId)
  if (!parent) {
    throw new ValidationError(
      'parentId does not reference an existing category in this organization.',
      [{ path: 'parentId', message: 'Parent category not found' }],
    )
  }
  if (parent.status === 'ARCHIVED') {
    throw new ValidationError('An archived category cannot be used as a parent.', [
      { path: 'parentId', message: 'Parent category is archived' },
    ])
  }
  if (selfId) {
    if (parentId.equals(selfId)) {
      throw new ValidationError('A category cannot be its own parent.', [
        { path: 'parentId', message: 'Category cannot be its own parent' },
      ])
    }
    const wouldCycle = await categoryRepository.isDescendantOf(organizationId, parentId, selfId)
    if (wouldCycle) {
      throw new ValidationError('This parent assignment would create a hierarchy cycle.', [
        { path: 'parentId', message: 'Would create a hierarchy cycle' },
      ])
    }
  }
}

export async function createCategory(
  organizationId: Types.ObjectId,
  input: unknown,
): Promise<CategoryDocument> {
  const parsed: CreateCategoryInput = createCategorySchema.parse(input)

  let parentId: Types.ObjectId | undefined
  if (parsed.parentId) {
    parentId = new Types.ObjectId(parsed.parentId)
    await assertValidParent(organizationId, parentId)
  }

  const baseData = {
    organizationId,
    name: parsed.name,
    description: parsed.description,
    parentId: parentId ?? null,
    status: parsed.status,
    sortOrder: parsed.sortOrder,
  }

  if (parsed.slug) {
    if (await categoryRepository.existsWithSlug(organizationId, parsed.slug)) {
      throw slugConflictError()
    }
    return categoryRepository.create({ ...baseData, slug: parsed.slug })
  }

  // Auto-generate: retry with the next numeric suffix on a real conflict
  // (either a pre-existing sibling, or a concurrent create that won a race)
  // rather than relying solely on a pre-check that could itself race.
  const base = slugify(parsed.name) || FALLBACK_SLUG_BASE
  let attempt = 0
  for (;;) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    try {
      return await categoryRepository.create({ ...baseData, slug: candidate })
    } catch (error) {
      attempt += 1
      if (!(error instanceof ValidationError) || attempt > MAX_SLUG_SUFFIX_ATTEMPTS) {
        throw error
      }
    }
  }
}

export async function updateCategory(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  input: unknown,
): Promise<CategoryDocument> {
  const parsed: UpdateCategoryInput = updateCategorySchema.parse(input)

  const existing = await categoryRepository.findById(organizationId, id)
  if (!existing) {
    throw new NotFoundError('Category not found.')
  }

  const patch: UpdateCategoryData = {}

  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.description !== undefined) patch.description = parsed.description
  if (parsed.status !== undefined) patch.status = parsed.status
  if (parsed.sortOrder !== undefined) patch.sortOrder = parsed.sortOrder

  if (parsed.parentId !== undefined) {
    if (parsed.parentId === null) {
      patch.parentId = null
    } else {
      const parentId = new Types.ObjectId(parsed.parentId)
      await assertValidParent(organizationId, parentId, id)
      patch.parentId = parentId
    }
  }

  if (parsed.slug !== undefined) {
    if (await categoryRepository.existsWithSlug(organizationId, parsed.slug, id)) {
      throw slugConflictError()
    }
    patch.slug = parsed.slug
  }

  const updated = await categoryRepository.update(organizationId, id, patch)
  if (!updated) {
    throw new NotFoundError('Category not found.')
  }
  return updated
}

/** Soft-archives a category. Never deletes, never cascades to children —
 *  children keep whatever status they already have. */
export async function archiveCategory(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<CategoryDocument> {
  const archived = await categoryRepository.archive(organizationId, id)
  if (!archived) {
    throw new NotFoundError('Category not found.')
  }
  return archived
}

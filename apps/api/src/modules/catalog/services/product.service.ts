import { Types } from 'mongoose'
import * as productRepository from '../repositories/product.repository.js'
import type { UpdateProductData } from '../repositories/product.repository.js'
// Read-only use of Category's and Brand's already-public repositories to
// validate a reference — no modification to either module. Mirrors
// organizations' one-directional dependency on auth's userRepository.
import * as categoryRepository from '../repositories/category.repository.js'
import * as brandRepository from '../repositories/brand.repository.js'
import { slugify } from '../lib/slugify.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createProductSchema,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from '../validation/product.schema.js'
import type { ProductDocument } from '../models/product.model.js'

const MAX_SLUG_SUFFIX_ATTEMPTS = 50
const FALLBACK_SLUG_BASE = 'product'

function slugConflictError(): ValidationError {
  return new ValidationError('This slug is already in use in this organization.', [
    { path: 'slug', message: 'Slug already exists' },
  ])
}

/** Validates that `categoryId` exists in this organization and is not
 *  archived. Never trusts that a syntactically valid ObjectId implies a
 *  real, owned, usable category — mirrors category.service.ts's own
 *  assertValidParent() exactly, applied to a cross-collection reference
 *  instead of a self-reference. */
async function assertValidCategory(
  organizationId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<void> {
  const category = await categoryRepository.findById(organizationId, categoryId)
  if (!category) {
    throw new ValidationError(
      'categoryId does not reference an existing category in this organization.',
      [{ path: 'categoryId', message: 'Category not found' }],
    )
  }
  if (category.status === 'ARCHIVED') {
    throw new ValidationError('An archived category cannot be assigned to a product.', [
      { path: 'categoryId', message: 'Category is archived' },
    ])
  }
}

/** Same validation as assertValidCategory, for brandId. Kept as a separate,
 *  near-identical function rather than a generic "assertValidReference<T>"
 *  helper — two concrete call sites don't justify a generic abstraction,
 *  and a genuine future difference between the two rules stays easy to see. */
async function assertValidBrand(
  organizationId: Types.ObjectId,
  brandId: Types.ObjectId,
): Promise<void> {
  const brand = await brandRepository.findById(organizationId, brandId)
  if (!brand) {
    throw new ValidationError(
      'brandId does not reference an existing brand in this organization.',
      [{ path: 'brandId', message: 'Brand not found' }],
    )
  }
  if (brand.status === 'ARCHIVED') {
    throw new ValidationError('An archived brand cannot be assigned to a product.', [
      { path: 'brandId', message: 'Brand is archived' },
    ])
  }
}

export async function createProduct(
  organizationId: Types.ObjectId,
  input: unknown,
): Promise<ProductDocument> {
  const parsed: CreateProductInput = createProductSchema.parse(input)

  let categoryId: Types.ObjectId | undefined
  if (parsed.categoryId) {
    categoryId = new Types.ObjectId(parsed.categoryId)
    await assertValidCategory(organizationId, categoryId)
  }

  let brandId: Types.ObjectId | undefined
  if (parsed.brandId) {
    brandId = new Types.ObjectId(parsed.brandId)
    await assertValidBrand(organizationId, brandId)
  }

  const baseData = {
    organizationId,
    name: parsed.name,
    description: parsed.description,
    categoryId,
    brandId,
    media: parsed.media,
    status: parsed.status,
  }

  if (parsed.slug) {
    if (await productRepository.existsWithSlug(organizationId, parsed.slug)) {
      throw slugConflictError()
    }
    return productRepository.create({ ...baseData, slug: parsed.slug })
  }

  // Auto-generate: retry with the next numeric suffix on a real conflict
  // (either a pre-existing sibling, or a concurrent create that won a race)
  // rather than relying solely on a pre-check that could itself race.
  const base = slugify(parsed.name) || FALLBACK_SLUG_BASE
  let attempt = 0
  for (;;) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    try {
      return await productRepository.create({ ...baseData, slug: candidate })
    } catch (error) {
      attempt += 1
      if (!(error instanceof ValidationError) || attempt > MAX_SLUG_SUFFIX_ATTEMPTS) {
        throw error
      }
    }
  }
}

export async function updateProduct(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  input: unknown,
): Promise<ProductDocument> {
  const parsed: UpdateProductInput = updateProductSchema.parse(input)

  const existing = await productRepository.findById(organizationId, id)
  if (!existing) {
    throw new NotFoundError('Product not found.')
  }

  const patch: UpdateProductData = {}

  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.description !== undefined) patch.description = parsed.description
  if (parsed.media !== undefined) patch.media = parsed.media
  if (parsed.status !== undefined) patch.status = parsed.status

  if (parsed.categoryId !== undefined) {
    if (parsed.categoryId === null) {
      patch.categoryId = null
    } else {
      const categoryId = new Types.ObjectId(parsed.categoryId)
      await assertValidCategory(organizationId, categoryId)
      patch.categoryId = categoryId
    }
  }

  if (parsed.brandId !== undefined) {
    if (parsed.brandId === null) {
      patch.brandId = null
    } else {
      const brandId = new Types.ObjectId(parsed.brandId)
      await assertValidBrand(organizationId, brandId)
      patch.brandId = brandId
    }
  }

  if (parsed.slug !== undefined) {
    if (await productRepository.existsWithSlug(organizationId, parsed.slug, id)) {
      throw slugConflictError()
    }
    patch.slug = parsed.slug
  }

  const updated = await productRepository.update(organizationId, id, patch)
  if (!updated) {
    throw new NotFoundError('Product not found.')
  }
  return updated
}

/** Soft-archives a product. Never deletes. Archiving a product's referenced
 *  category/brand independently (later, elsewhere) never cascades back onto
 *  the product — see catalog/README.md's Product section. */
export async function archiveProduct(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<ProductDocument> {
  const archived = await productRepository.archive(organizationId, id)
  if (!archived) {
    throw new NotFoundError('Product not found.')
  }
  return archived
}

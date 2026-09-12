import { Types } from 'mongoose'
import * as brandRepository from '../repositories/brand.repository.js'
import type { UpdateBrandData } from '../repositories/brand.repository.js'
import { slugify } from '../lib/slugify.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createBrandSchema,
  updateBrandSchema,
  type CreateBrandInput,
  type UpdateBrandInput,
} from '../validation/brand.schema.js'
import type { BrandDocument } from '../models/brand.model.js'

const MAX_SLUG_SUFFIX_ATTEMPTS = 50
const FALLBACK_SLUG_BASE = 'brand'

function slugConflictError(): ValidationError {
  return new ValidationError('This slug is already in use in this organization.', [
    { path: 'slug', message: 'Slug already exists' },
  ])
}

export async function createBrand(
  organizationId: Types.ObjectId,
  input: unknown,
): Promise<BrandDocument> {
  const parsed: CreateBrandInput = createBrandSchema.parse(input)

  const baseData = {
    organizationId,
    name: parsed.name,
    description: parsed.description,
    logo: parsed.logo,
    status: parsed.status,
  }

  if (parsed.slug) {
    if (await brandRepository.existsWithSlug(organizationId, parsed.slug)) {
      throw slugConflictError()
    }
    return brandRepository.create({ ...baseData, slug: parsed.slug })
  }

  // Auto-generate: retry with the next numeric suffix on a real conflict
  // (either a pre-existing sibling, or a concurrent create that won a race)
  // rather than relying solely on a pre-check that could itself race.
  const base = slugify(parsed.name) || FALLBACK_SLUG_BASE
  let attempt = 0
  for (;;) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    try {
      return await brandRepository.create({ ...baseData, slug: candidate })
    } catch (error) {
      attempt += 1
      if (!(error instanceof ValidationError) || attempt > MAX_SLUG_SUFFIX_ATTEMPTS) {
        throw error
      }
    }
  }
}

export async function updateBrand(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  input: unknown,
): Promise<BrandDocument> {
  const parsed: UpdateBrandInput = updateBrandSchema.parse(input)

  const existing = await brandRepository.findById(organizationId, id)
  if (!existing) {
    throw new NotFoundError('Brand not found.')
  }

  const patch: UpdateBrandData = {}

  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.description !== undefined) patch.description = parsed.description
  if (parsed.logo !== undefined) patch.logo = parsed.logo
  if (parsed.status !== undefined) patch.status = parsed.status

  if (parsed.slug !== undefined) {
    if (await brandRepository.existsWithSlug(organizationId, parsed.slug, id)) {
      throw slugConflictError()
    }
    patch.slug = parsed.slug
  }

  const updated = await brandRepository.update(organizationId, id, patch)
  if (!updated) {
    throw new NotFoundError('Brand not found.')
  }
  return updated
}

/** Soft-archives a brand. Never deletes. */
export async function archiveBrand(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<BrandDocument> {
  const archived = await brandRepository.archive(organizationId, id)
  if (!archived) {
    throw new NotFoundError('Brand not found.')
  }
  return archived
}

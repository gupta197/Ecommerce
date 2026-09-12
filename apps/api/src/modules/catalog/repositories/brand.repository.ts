import { Types } from 'mongoose'
import {
  BrandModel,
  type BrandDocument,
  type BrandLogo,
  type BrandStatus,
} from '../models/brand.model.js'
import { ValidationError } from '../../../lib/http-errors.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CreateBrandData {
  organizationId: Types.ObjectId
  name: string
  slug: string
  description?: string
  logo?: BrandLogo
  status: BrandStatus
}

export interface UpdateBrandData {
  name?: string
  slug?: string
  description?: string
  logo?: BrandLogo
  status?: BrandStatus
}

export interface ListBrandsFilter {
  status?: BrandStatus
}

export interface ListBrandsOptions {
  page: number
  limit: number
}

export interface ListBrandsResult {
  items: BrandDocument[]
  total: number
}

const DUPLICATE_SLUG_MESSAGE = 'A brand with this slug already exists in this organization.'

function duplicateSlugError(): ValidationError {
  return new ValidationError(DUPLICATE_SLUG_MESSAGE, [
    { path: 'slug', message: 'Slug must be unique within the organization' },
  ])
}

export async function create(data: CreateBrandData): Promise<BrandDocument> {
  try {
    return await BrandModel.create(data)
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
): Promise<BrandDocument | null> {
  return BrandModel.findOne({ _id: id, organizationId })
}

export async function findBySlug(
  organizationId: Types.ObjectId,
  slug: string,
): Promise<BrandDocument | null> {
  return BrandModel.findOne({ organizationId, slug })
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
  const match = await BrandModel.exists(filter)
  return match !== null
}

export async function list(
  organizationId: Types.ObjectId,
  filter: ListBrandsFilter,
  options: ListBrandsOptions,
): Promise<ListBrandsResult> {
  const query: Record<string, unknown> = { organizationId }
  if (filter.status) {
    query.status = filter.status
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    BrandModel.find(query).sort({ _id: 1 }).skip(skip).limit(options.limit),
    BrandModel.countDocuments(query),
  ])

  return { items, total }
}

export async function update(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  patch: UpdateBrandData,
): Promise<BrandDocument | null> {
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }

  try {
    return await BrandModel.findOneAndUpdate(
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
): Promise<BrandDocument | null> {
  return BrandModel.findOneAndUpdate(
    { _id: id, organizationId },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

import { Types } from 'mongoose'
import {
  ProductModel,
  type ProductDocument,
  type ProductMedia,
  type ProductStatus,
} from '../models/product.model.js'
import { ValidationError } from '../../../lib/http-errors.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CreateProductData {
  organizationId: Types.ObjectId
  name: string
  slug: string
  description?: string
  categoryId?: Types.ObjectId
  brandId?: Types.ObjectId
  media?: ProductMedia[]
  status: ProductStatus
}

export interface UpdateProductData {
  name?: string
  slug?: string
  description?: string
  categoryId?: Types.ObjectId | null
  brandId?: Types.ObjectId | null
  media?: ProductMedia[]
  status?: ProductStatus
}

export interface ListProductsFilter {
  categoryId?: Types.ObjectId
  brandId?: Types.ObjectId
  status?: ProductStatus
}

export interface ListProductsOptions {
  page: number
  limit: number
}

export interface ListProductsResult {
  items: ProductDocument[]
  total: number
}

const DUPLICATE_SLUG_MESSAGE = 'A product with this slug already exists in this organization.'

function duplicateSlugError(): ValidationError {
  return new ValidationError(DUPLICATE_SLUG_MESSAGE, [
    { path: 'slug', message: 'Slug must be unique within the organization' },
  ])
}

export async function create(data: CreateProductData): Promise<ProductDocument> {
  try {
    return await ProductModel.create(data)
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
): Promise<ProductDocument | null> {
  return ProductModel.findOne({ _id: id, organizationId })
}

export async function findBySlug(
  organizationId: Types.ObjectId,
  slug: string,
): Promise<ProductDocument | null> {
  return ProductModel.findOne({ organizationId, slug })
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
  const match = await ProductModel.exists(filter)
  return match !== null
}

export async function list(
  organizationId: Types.ObjectId,
  filter: ListProductsFilter,
  options: ListProductsOptions,
): Promise<ListProductsResult> {
  const query: Record<string, unknown> = { organizationId }
  if (filter.categoryId) {
    query.categoryId = filter.categoryId
  }
  if (filter.brandId) {
    query.brandId = filter.brandId
  }
  if (filter.status) {
    query.status = filter.status
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    ProductModel.find(query).sort({ _id: 1 }).skip(skip).limit(options.limit),
    ProductModel.countDocuments(query),
  ])

  return { items, total }
}

export async function update(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  patch: UpdateProductData,
): Promise<ProductDocument | null> {
  // Matches category.repository.ts's exact convention: a `null` value (used
  // by categoryId/brandId to mean "remove this reference") is included in
  // $set directly — undefined (omitted field) means "don't change" and is
  // the only thing filtered out.
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }

  try {
    return await ProductModel.findOneAndUpdate(
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
): Promise<ProductDocument | null> {
  return ProductModel.findOneAndUpdate(
    { _id: id, organizationId },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

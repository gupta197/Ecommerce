import { Types } from 'mongoose'
import {
  ProductVariantModel,
  type ProductVariantAttribute,
  type ProductVariantDocument,
  type ProductVariantStatus,
} from '../models/product-variant.model.js'
import { ValidationError } from '../../../lib/http-errors.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CreateProductVariantData {
  organizationId: Types.ObjectId
  productId: Types.ObjectId
  sku: string
  barcode?: string
  price: number
  compareAtPrice?: number
  cost?: number
  attributes?: ProductVariantAttribute[]
  status: ProductVariantStatus
}

// productId is intentionally absent — a variant's product relationship is
// immutable once created (locked CAT-004 decision).
export interface UpdateProductVariantData {
  sku?: string
  barcode?: string
  price?: number
  compareAtPrice?: number
  cost?: number
  attributes?: ProductVariantAttribute[]
  status?: ProductVariantStatus
}

export interface ListProductVariantsFilter {
  productId?: Types.ObjectId
  status?: ProductVariantStatus
}

export interface ListProductVariantsOptions {
  page: number
  limit: number
}

export interface ListProductVariantsResult {
  items: ProductVariantDocument[]
  total: number
}

const DUPLICATE_SKU_MESSAGE = 'A variant with this SKU already exists in this organization.'
const DUPLICATE_BARCODE_MESSAGE = 'A variant with this barcode already exists in this organization.'
const DUPLICATE_UNKNOWN_MESSAGE =
  'A variant with this SKU or barcode already exists in this organization.'

function duplicateSkuError(): ValidationError {
  return new ValidationError(DUPLICATE_SKU_MESSAGE, [
    { path: 'sku', message: 'SKU must be unique within the organization' },
  ])
}

function duplicateBarcodeError(): ValidationError {
  return new ValidationError(DUPLICATE_BARCODE_MESSAGE, [
    { path: 'barcode', message: 'Barcode must be unique within the organization' },
  ])
}

/** MongoDB's E11000 error includes `keyPattern` naming the offending index's
 *  fields — used here only to pick the more specific, friendlier error
 *  message. If a future MongoDB version ever omits it, DUPLICATE_UNKNOWN_MESSAGE
 *  is a safe, still-correct fallback; isDuplicateKeyError() alone remains the
 *  actual conflict detection. */
function duplicateKeyField(error: unknown): 'sku' | 'barcode' | undefined {
  if (typeof error !== 'object' || error === null || !('keyPattern' in error)) {
    return undefined
  }
  const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern
  if (!keyPattern) return undefined
  if ('sku' in keyPattern) return 'sku'
  if ('barcode' in keyPattern) return 'barcode'
  return undefined
}

function toDuplicateError(error: unknown): ValidationError {
  const field = duplicateKeyField(error)
  if (field === 'sku') return duplicateSkuError()
  if (field === 'barcode') return duplicateBarcodeError()
  return new ValidationError(DUPLICATE_UNKNOWN_MESSAGE, [
    { path: 'sku', message: 'SKU or barcode must be unique within the organization' },
  ])
}

export async function create(data: CreateProductVariantData): Promise<ProductVariantDocument> {
  try {
    return await ProductVariantModel.create(data)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw toDuplicateError(error)
    }
    throw error
  }
}

export async function findById(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<ProductVariantDocument | null> {
  return ProductVariantModel.findOne({ _id: id, organizationId })
}

export async function findBySku(
  organizationId: Types.ObjectId,
  sku: string,
): Promise<ProductVariantDocument | null> {
  return ProductVariantModel.findOne({ organizationId, sku })
}

export async function existsWithSku(
  organizationId: Types.ObjectId,
  sku: string,
  excludeId?: Types.ObjectId,
): Promise<boolean> {
  const filter: Record<string, unknown> = { organizationId, sku }
  if (excludeId) {
    filter._id = { $ne: excludeId }
  }
  const match = await ProductVariantModel.exists(filter)
  return match !== null
}

export async function existsWithBarcode(
  organizationId: Types.ObjectId,
  barcode: string,
  excludeId?: Types.ObjectId,
): Promise<boolean> {
  const filter: Record<string, unknown> = { organizationId, barcode }
  if (excludeId) {
    filter._id = { $ne: excludeId }
  }
  const match = await ProductVariantModel.exists(filter)
  return match !== null
}

export async function findByProductId(
  organizationId: Types.ObjectId,
  productId: Types.ObjectId,
): Promise<ProductVariantDocument[]> {
  return ProductVariantModel.find({ organizationId, productId }).sort({ _id: 1 })
}

export async function list(
  organizationId: Types.ObjectId,
  filter: ListProductVariantsFilter,
  options: ListProductVariantsOptions,
): Promise<ListProductVariantsResult> {
  const query: Record<string, unknown> = { organizationId }
  if (filter.productId) {
    query.productId = filter.productId
  }
  if (filter.status) {
    query.status = filter.status
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    ProductVariantModel.find(query).sort({ _id: 1 }).skip(skip).limit(options.limit),
    ProductVariantModel.countDocuments(query),
  ])

  return { items, total }
}

export async function update(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  patch: UpdateProductVariantData,
): Promise<ProductVariantDocument | null> {
  // Matches category.repository.ts/product.repository.ts's exact convention:
  // only `undefined` (an omitted field) is filtered out of $set.
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }

  try {
    return await ProductVariantModel.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: setDoc },
      { returnDocument: 'after' },
    )
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw toDuplicateError(error)
    }
    throw error
  }
}

export async function archive(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<ProductVariantDocument | null> {
  return ProductVariantModel.findOneAndUpdate(
    { _id: id, organizationId },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

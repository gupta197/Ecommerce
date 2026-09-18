import { Types } from 'mongoose'
import * as productVariantRepository from '../repositories/product-variant.repository.js'
import type { UpdateProductVariantData } from '../repositories/product-variant.repository.js'
// Read-only use of Product's already-public repository to validate a
// reference — no modification to product.repository.ts. Mirrors
// product.service.ts's own one-directional dependency on category/brand
// repositories.
import * as productRepository from '../repositories/product.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createProductVariantSchema,
  updateProductVariantSchema,
  type CreateProductVariantInput,
  type UpdateProductVariantInput,
} from '../validation/product-variant.schema.js'
import type { ProductVariantDocument } from '../models/product-variant.model.js'

function skuConflictError(): ValidationError {
  return new ValidationError('This SKU is already in use in this organization.', [
    { path: 'sku', message: 'SKU already exists' },
  ])
}

function barcodeConflictError(): ValidationError {
  return new ValidationError('This barcode is already in use in this organization.', [
    { path: 'barcode', message: 'Barcode already exists' },
  ])
}

/** Validates that `productId` exists in this organization and is not
 *  archived. Never trusts that a syntactically valid ObjectId implies a
 *  real, owned, usable product — mirrors product.service.ts's own
 *  assertValidCategory()/assertValidBrand() exactly, applied to the
 *  Variant -> Product parent reference. Only called on create: productId is
 *  immutable, so no update-time re-validation is ever needed. */
async function assertValidProduct(
  organizationId: Types.ObjectId,
  productId: Types.ObjectId,
): Promise<void> {
  const product = await productRepository.findById(organizationId, productId)
  if (!product) {
    throw new ValidationError(
      'productId does not reference an existing product in this organization.',
      [{ path: 'productId', message: 'Product not found' }],
    )
  }
  if (product.status === 'ARCHIVED') {
    throw new ValidationError('A variant cannot be created for an archived product.', [
      { path: 'productId', message: 'Product is archived' },
    ])
  }
}

export async function createVariant(
  organizationId: Types.ObjectId,
  input: unknown,
): Promise<ProductVariantDocument> {
  const parsed: CreateProductVariantInput = createProductVariantSchema.parse(input)

  const productId = new Types.ObjectId(parsed.productId)
  await assertValidProduct(organizationId, productId)

  if (await productVariantRepository.existsWithSku(organizationId, parsed.sku)) {
    throw skuConflictError()
  }
  if (
    parsed.barcode &&
    (await productVariantRepository.existsWithBarcode(organizationId, parsed.barcode))
  ) {
    throw barcodeConflictError()
  }

  return productVariantRepository.create({
    organizationId,
    productId,
    sku: parsed.sku,
    barcode: parsed.barcode,
    price: parsed.price,
    compareAtPrice: parsed.compareAtPrice,
    cost: parsed.cost,
    attributes: parsed.attributes,
    status: parsed.status,
  })
}

export async function updateVariant(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  input: unknown,
): Promise<ProductVariantDocument> {
  const parsed: UpdateProductVariantInput = updateProductVariantSchema.parse(input)

  const existing = await productVariantRepository.findById(organizationId, id)
  if (!existing) {
    throw new NotFoundError('Product variant not found.')
  }

  const patch: UpdateProductVariantData = {}

  if (parsed.price !== undefined) patch.price = parsed.price
  if (parsed.compareAtPrice !== undefined) patch.compareAtPrice = parsed.compareAtPrice
  if (parsed.cost !== undefined) patch.cost = parsed.cost
  if (parsed.attributes !== undefined) patch.attributes = parsed.attributes
  if (parsed.status !== undefined) patch.status = parsed.status

  if (parsed.sku !== undefined) {
    if (await productVariantRepository.existsWithSku(organizationId, parsed.sku, id)) {
      throw skuConflictError()
    }
    patch.sku = parsed.sku
  }

  if (parsed.barcode !== undefined) {
    if (await productVariantRepository.existsWithBarcode(organizationId, parsed.barcode, id)) {
      throw barcodeConflictError()
    }
    patch.barcode = parsed.barcode
  }

  const updated = await productVariantRepository.update(organizationId, id, patch)
  if (!updated) {
    throw new NotFoundError('Product variant not found.')
  }
  return updated
}

/** Soft-archives a variant. Never deletes. Archiving a variant's product
 *  independently (later, elsewhere) never cascades back onto the variant,
 *  and archiving this variant never cascades onto its product — see
 *  catalog/README.md's ProductVariant section. */
export async function archiveVariant(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<ProductVariantDocument> {
  const archived = await productVariantRepository.archive(organizationId, id)
  if (!archived) {
    throw new NotFoundError('Product variant not found.')
  }
  return archived
}

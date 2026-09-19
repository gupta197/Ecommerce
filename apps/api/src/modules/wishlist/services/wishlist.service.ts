import { Types } from 'mongoose'
import * as wishlistItemRepository from '../repositories/wishlist-item.repository.js'
import { NotFoundError } from '../../../lib/http-errors.js'
import {
  createWishlistItemSchema,
  type CreateWishlistItemInput,
} from '../validation/wishlist.schema.js'
import type { WishlistItemDocument } from '../models/wishlist-item.model.js'
import {
  assertCustomerActive,
  assertValidOrganization,
  assertValidVariant,
} from './shared-validation.js'

export async function createWishlistItem(
  customerId: Types.ObjectId,
  input: unknown,
): Promise<WishlistItemDocument> {
  const parsed: CreateWishlistItemInput = createWishlistItemSchema.parse(input)
  await assertCustomerActive(customerId)

  const organizationId = new Types.ObjectId(parsed.organizationId)
  const variantId = new Types.ObjectId(parsed.variantId)

  await assertValidOrganization(organizationId)
  await assertValidVariant(organizationId, variantId)

  return wishlistItemRepository.create({
    customerId,
    organizationId,
    variantId,
    status: 'ACTIVE',
  })
}

export async function listWishlistItems(
  customerId: Types.ObjectId,
): Promise<WishlistItemDocument[]> {
  return wishlistItemRepository.findActiveByCustomerId(customerId)
}

/** Soft-removes an item (ACTIVE -> ARCHIVED). Never deletes, never
 *  cascades. Once archived, the same customer may add the same variant
 *  again (the partial unique index only constrains ACTIVE rows). */
export async function archiveWishlistItem(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<WishlistItemDocument> {
  await assertCustomerActive(customerId)
  const archived = await wishlistItemRepository.archive(customerId, id)
  if (!archived) {
    throw new NotFoundError('Wishlist item not found.')
  }
  return archived
}

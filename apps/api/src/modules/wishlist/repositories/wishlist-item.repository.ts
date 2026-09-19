import { Types } from 'mongoose'
import {
  WishlistItemModel,
  type WishlistItemDocument,
  type WishlistItemStatus,
} from '../models/wishlist-item.model.js'
import { ValidationError } from '../../../lib/http-errors.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CreateWishlistItemData {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  variantId: Types.ObjectId
  status: WishlistItemStatus
}

const DUPLICATE_ACTIVE_ITEM_MESSAGE = 'This variant is already on the wishlist.'

function duplicateActiveItemError(): ValidationError {
  return new ValidationError(DUPLICATE_ACTIVE_ITEM_MESSAGE, [
    { path: 'variantId', message: 'An active wishlist item for this variant already exists' },
  ])
}

export async function create(data: CreateWishlistItemData): Promise<WishlistItemDocument> {
  try {
    return await WishlistItemModel.create(data)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicateActiveItemError()
    }
    throw error
  }
}

// customerId is a mandatory parameter on every function in this file — the
// same IDOR-prevention convention every other module uses, anchored on
// customerId instead of organizationId (Customer has no organizationId).
export async function findById(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<WishlistItemDocument | null> {
  return WishlistItemModel.findOne({ _id: id, customerId })
}

// Only ACTIVE items — a removed (ARCHIVED) item is no longer "on the
// wishlist" from the customer's point of view.
export async function findActiveByCustomerId(
  customerId: Types.ObjectId,
): Promise<WishlistItemDocument[]> {
  return WishlistItemModel.find({ customerId, status: 'ACTIVE' }).sort({ _id: 1 })
}

// The filter includes status:'ACTIVE' so archiving an already-archived (or
// nonexistent) item returns null rather than silently no-op succeeding —
// the service layer turns that into a NotFoundError.
export async function archive(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<WishlistItemDocument | null> {
  return WishlistItemModel.findOneAndUpdate(
    { _id: id, customerId, status: 'ACTIVE' },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

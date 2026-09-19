import { Types } from 'mongoose'
import {
  BackInStockRequestModel,
  type BackInStockRequestDocument,
  type BackInStockRequestStatus,
} from '../models/back-in-stock-request.model.js'
import { ValidationError } from '../../../lib/http-errors.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CreateBackInStockRequestData {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  variantId: Types.ObjectId
  status: BackInStockRequestStatus
}

const DUPLICATE_PENDING_REQUEST_MESSAGE =
  'A pending back-in-stock request for this variant already exists.'

function duplicatePendingRequestError(): ValidationError {
  return new ValidationError(DUPLICATE_PENDING_REQUEST_MESSAGE, [
    { path: 'variantId', message: 'A pending request for this variant already exists' },
  ])
}

export async function create(
  data: CreateBackInStockRequestData,
): Promise<BackInStockRequestDocument> {
  try {
    return await BackInStockRequestModel.create(data)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicatePendingRequestError()
    }
    throw error
  }
}

export async function findById(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<BackInStockRequestDocument | null> {
  return BackInStockRequestModel.findOne({ _id: id, customerId })
}

// Both PENDING and CANCELLED — unlike WishlistItem, a customer's own
// request history (including past cancellations) is meaningful to show.
export async function findByCustomerId(
  customerId: Types.ObjectId,
): Promise<BackInStockRequestDocument[]> {
  return BackInStockRequestModel.find({ customerId }).sort({ _id: 1 })
}

// The filter includes status:'PENDING' so cancelling an already-cancelled
// (or nonexistent) request returns null rather than silently no-op
// succeeding — the service layer turns that into a NotFoundError.
export async function cancel(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<BackInStockRequestDocument | null> {
  return BackInStockRequestModel.findOneAndUpdate(
    { _id: id, customerId, status: 'PENDING' },
    { $set: { status: 'CANCELLED' } },
    { returnDocument: 'after' },
  )
}

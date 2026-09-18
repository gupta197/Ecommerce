import { Types } from 'mongoose'
import {
  LocationModel,
  type LocationDocument,
  type LocationStatus,
} from '../models/location.model.js'
import { ValidationError } from '../../../lib/http-errors.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CreateLocationData {
  organizationId: Types.ObjectId
  name: string
  code?: string
  status: LocationStatus
}

export interface UpdateLocationData {
  name?: string
  code?: string
  status?: LocationStatus
}

export interface ListLocationsFilter {
  status?: LocationStatus
}

export interface ListLocationsOptions {
  page: number
  limit: number
}

export interface ListLocationsResult {
  items: LocationDocument[]
  total: number
}

const DUPLICATE_CODE_MESSAGE = 'A location with this code already exists in this organization.'

function duplicateCodeError(): ValidationError {
  return new ValidationError(DUPLICATE_CODE_MESSAGE, [
    { path: 'code', message: 'Code must be unique within the organization' },
  ])
}

export async function create(data: CreateLocationData): Promise<LocationDocument> {
  try {
    return await LocationModel.create(data)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicateCodeError()
    }
    throw error
  }
}

export async function findById(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<LocationDocument | null> {
  return LocationModel.findOne({ _id: id, organizationId })
}

export async function findByCode(
  organizationId: Types.ObjectId,
  code: string,
): Promise<LocationDocument | null> {
  return LocationModel.findOne({ organizationId, code })
}

export async function existsWithCode(
  organizationId: Types.ObjectId,
  code: string,
  excludeId?: Types.ObjectId,
): Promise<boolean> {
  const filter: Record<string, unknown> = { organizationId, code }
  if (excludeId) {
    filter._id = { $ne: excludeId }
  }
  const match = await LocationModel.exists(filter)
  return match !== null
}

export async function list(
  organizationId: Types.ObjectId,
  filter: ListLocationsFilter,
  options: ListLocationsOptions,
): Promise<ListLocationsResult> {
  const query: Record<string, unknown> = { organizationId }
  if (filter.status) {
    query.status = filter.status
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    LocationModel.find(query).sort({ _id: 1 }).skip(skip).limit(options.limit),
    LocationModel.countDocuments(query),
  ])

  return { items, total }
}

export async function update(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  patch: UpdateLocationData,
): Promise<LocationDocument | null> {
  // Matches category.repository.ts/product.repository.ts's exact convention:
  // only `undefined` (an omitted field) is filtered out of $set.
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }

  try {
    return await LocationModel.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: setDoc },
      { returnDocument: 'after' },
    )
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicateCodeError()
    }
    throw error
  }
}

export async function archive(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<LocationDocument | null> {
  return LocationModel.findOneAndUpdate(
    { _id: id, organizationId },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

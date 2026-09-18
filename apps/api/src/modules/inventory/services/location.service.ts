import { Types } from 'mongoose'
import * as locationRepository from '../repositories/location.repository.js'
import type { UpdateLocationData } from '../repositories/location.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createLocationSchema,
  updateLocationSchema,
  type CreateLocationInput,
  type UpdateLocationInput,
} from '../validation/location.schema.js'
import type { LocationDocument } from '../models/location.model.js'

function codeConflictError(): ValidationError {
  return new ValidationError('This code is already in use in this organization.', [
    { path: 'code', message: 'Code already exists' },
  ])
}

export async function createLocation(
  organizationId: Types.ObjectId,
  input: unknown,
): Promise<LocationDocument> {
  const parsed: CreateLocationInput = createLocationSchema.parse(input)

  if (parsed.code && (await locationRepository.existsWithCode(organizationId, parsed.code))) {
    throw codeConflictError()
  }

  return locationRepository.create({
    organizationId,
    name: parsed.name,
    code: parsed.code,
    status: parsed.status,
  })
}

export async function updateLocation(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
  input: unknown,
): Promise<LocationDocument> {
  const parsed: UpdateLocationInput = updateLocationSchema.parse(input)

  const existing = await locationRepository.findById(organizationId, id)
  if (!existing) {
    throw new NotFoundError('Location not found.')
  }

  const patch: UpdateLocationData = {}

  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.status !== undefined) patch.status = parsed.status

  if (parsed.code !== undefined) {
    if (await locationRepository.existsWithCode(organizationId, parsed.code, id)) {
      throw codeConflictError()
    }
    patch.code = parsed.code
  }

  const updated = await locationRepository.update(organizationId, id, patch)
  if (!updated) {
    throw new NotFoundError('Location not found.')
  }
  return updated
}

/** Soft-archives a location. Never deletes, never cascades: existing
 *  StockBalance/InventoryTransaction history is untouched. An archived
 *  location simply becomes ineligible for *new* transactions (enforced by
 *  inventory.service.ts's assertValidLocation), not modified or hidden. */
export async function archiveLocation(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<LocationDocument> {
  const archived = await locationRepository.archive(organizationId, id)
  if (!archived) {
    throw new NotFoundError('Location not found.')
  }
  return archived
}

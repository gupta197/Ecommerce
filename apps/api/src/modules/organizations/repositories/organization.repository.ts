import type { ClientSession, Types } from 'mongoose'
import {
  OrganizationModel,
  type OrganizationDocument,
  type OrganizationStatus,
} from '../models/organization.model.js'

export interface CreateOrganizationData {
  name: string
  status: OrganizationStatus
  activeOwnerCount: number
}

export interface UpdateOrganizationData {
  name?: string
  status?: OrganizationStatus
}

export async function create(
  data: CreateOrganizationData,
  session?: ClientSession,
): Promise<OrganizationDocument> {
  const [organization] = await OrganizationModel.create([data], { session })
  if (!organization) {
    throw new Error('OrganizationModel.create unexpectedly returned no document')
  }
  return organization
}

export async function findById(id: Types.ObjectId): Promise<OrganizationDocument | null> {
  return OrganizationModel.findById(id)
}

export async function findByIds(ids: Types.ObjectId[]): Promise<OrganizationDocument[]> {
  return OrganizationModel.find({ _id: { $in: ids } })
}

export async function update(
  id: Types.ObjectId,
  patch: UpdateOrganizationData,
): Promise<OrganizationDocument | null> {
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }
  return OrganizationModel.findOneAndUpdate(
    { _id: id },
    { $set: setDoc },
    { returnDocument: 'after' },
  )
}

/** Always safe — increasing the owner count can never violate the
 *  last-owner invariant, so no guard is needed. */
export async function incrementActiveOwnerCount(
  id: Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  await OrganizationModel.updateOne({ _id: id }, { $inc: { activeOwnerCount: 1 } }, { session })
}

/** Atomic compare-and-swap: the current activeOwnerCount is part of the
 *  filter, so the decrement only takes effect if at least one OTHER active
 *  owner would remain. Returns null (and performs no write) if this would
 *  leave the organization with zero active owners — callers must treat
 *  `null` as "last-owner protection triggered", not as "organization not
 *  found" (existence is already established by the time this is called). */
export async function decrementActiveOwnerCountIfSafe(
  id: Types.ObjectId,
  session: ClientSession,
): Promise<OrganizationDocument | null> {
  return OrganizationModel.findOneAndUpdate(
    { _id: id, activeOwnerCount: { $gt: 1 } },
    { $inc: { activeOwnerCount: -1 } },
    { session, returnDocument: 'after' },
  )
}

import type { Types } from 'mongoose'
import {
  SecuritySessionModel,
  type SecuritySessionDocument,
} from '../models/security-session.model.js'

export interface CreateSecuritySessionData {
  userId: Types.ObjectId
  familyId: Types.ObjectId
  familyCreatedAt: Date
  refreshTokenHash: string
  ipAddress?: string
  userAgent?: string
  lastUsedAt: Date
  expiresAt: Date
}

export async function create(data: CreateSecuritySessionData): Promise<SecuritySessionDocument> {
  return SecuritySessionModel.create({ ...data, status: 'ACTIVE' })
}

export async function findByRefreshTokenHash(
  hash: string,
): Promise<SecuritySessionDocument | null> {
  return SecuritySessionModel.findOne({ refreshTokenHash: hash })
}

/**
 * The atomic ACTIVE -> ROTATED transition (§2 of the approved plan). This is
 * a single MongoDB findOneAndUpdate with the current status as part of the
 * filter — a compare-and-swap, not a separate read-then-write. Of two
 * concurrent calls with the same hash, exactly one can match `status:
 * 'ACTIVE'` and flip it; the other matches nothing and gets `null`.
 *
 * Returns the PRE-update document (the winning claim) so the caller has
 * familyId/familyCreatedAt/userId to build the next session generation.
 */
export async function claimActiveByHash(
  hash: string,
  rotatedAt: Date,
): Promise<SecuritySessionDocument | null> {
  return SecuritySessionModel.findOneAndUpdate(
    { refreshTokenHash: hash, status: 'ACTIVE' },
    { $set: { status: 'ROTATED', rotatedAt, lastUsedAt: rotatedAt } },
    { returnDocument: 'before' },
  )
}

export async function revokeFamily(familyId: Types.ObjectId, revokedAt: Date): Promise<void> {
  await SecuritySessionModel.updateMany(
    { familyId, status: { $ne: 'REVOKED' } },
    { $set: { status: 'REVOKED', revokedAt } },
  )
}

export async function revokeById(
  userId: Types.ObjectId,
  id: Types.ObjectId,
  revokedAt: Date,
): Promise<SecuritySessionDocument | null> {
  return SecuritySessionModel.findOneAndUpdate(
    { _id: id, userId },
    { $set: { status: 'REVOKED', revokedAt } },
    { returnDocument: 'after' },
  )
}

export async function revokeOthers(
  userId: Types.ObjectId,
  exceptId: Types.ObjectId,
  revokedAt: Date,
): Promise<void> {
  await SecuritySessionModel.updateMany(
    { userId, _id: { $ne: exceptId }, status: 'ACTIVE' },
    { $set: { status: 'REVOKED', revokedAt } },
  )
}

export async function listActiveForUser(
  userId: Types.ObjectId,
): Promise<SecuritySessionDocument[]> {
  return SecuritySessionModel.find({ userId, status: 'ACTIVE' }).sort({ createdAt: -1 })
}

import type { ClientSession, Types } from 'mongoose'
import {
  OrganizationMembershipModel,
  type MembershipRole,
  type OrganizationMembershipDocument,
} from '../models/organization-membership.model.js'
import { ValidationError } from '../../../lib/http-errors.js'

export interface CreateMembershipData {
  organizationId: Types.ObjectId
  userId: Types.ObjectId
  role: MembershipRole
  status: 'ACTIVE'
}

const DUPLICATE_KEY_ERROR_CODE = 11000
const DUPLICATE_MEMBERSHIP_MESSAGE = 'This user is already an active member of this organization.'

// Deliberately NOT imported from modules/catalog's or modules/auth's own
// copies — each module keeps this check local, per established convention.
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}

export async function create(
  data: CreateMembershipData,
  session?: ClientSession,
): Promise<OrganizationMembershipDocument> {
  try {
    const [membership] = await OrganizationMembershipModel.create([data], { session })
    if (!membership) {
      throw new Error('OrganizationMembershipModel.create unexpectedly returned no document')
    }
    return membership
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ValidationError(DUPLICATE_MEMBERSHIP_MESSAGE)
    }
    throw error
  }
}

export async function findActiveByOrgAndUser(
  organizationId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<OrganizationMembershipDocument | null> {
  return OrganizationMembershipModel.findOne({ organizationId, userId, status: 'ACTIVE' })
}

export async function findActiveById(
  organizationId: Types.ObjectId,
  membershipId: Types.ObjectId,
  session?: ClientSession,
): Promise<OrganizationMembershipDocument | null> {
  return OrganizationMembershipModel.findOne(
    { _id: membershipId, organizationId, status: 'ACTIVE' },
    null,
    { session },
  )
}

export async function listActiveForOrganization(
  organizationId: Types.ObjectId,
): Promise<OrganizationMembershipDocument[]> {
  return OrganizationMembershipModel.find({ organizationId, status: 'ACTIVE' }).sort({
    createdAt: 1,
  })
}

export async function listActiveForUser(
  userId: Types.ObjectId,
): Promise<OrganizationMembershipDocument[]> {
  return OrganizationMembershipModel.find({ userId, status: 'ACTIVE' })
}

export async function updateRole(
  membershipId: Types.ObjectId,
  role: MembershipRole,
  session: ClientSession,
): Promise<OrganizationMembershipDocument | null> {
  return OrganizationMembershipModel.findOneAndUpdate(
    { _id: membershipId },
    { $set: { role } },
    { session, returnDocument: 'after' },
  )
}

export async function markRemoved(
  membershipId: Types.ObjectId,
  session: ClientSession,
): Promise<OrganizationMembershipDocument | null> {
  return OrganizationMembershipModel.findOneAndUpdate(
    { _id: membershipId },
    { $set: { status: 'REMOVED' } },
    { session, returnDocument: 'after' },
  )
}

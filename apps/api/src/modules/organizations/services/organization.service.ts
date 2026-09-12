import type { Types } from 'mongoose'
import { withTransaction } from '../../../db/transaction.js'
import * as organizationRepository from '../repositories/organization.repository.js'
import * as membershipRepository from '../repositories/organization-membership.repository.js'
import { NotFoundError } from '../../../lib/http-errors.js'
import type { OrganizationDocument } from '../models/organization.model.js'
import type {
  CreateOrganizationInput,
  UpdateOrganizationInput,
} from '../validation/organization.schema.js'
import type { Logger } from '../../../lib/logger.js'

/**
 * Organization creation and the creator's first OWNER membership are one
 * atomic unit (§1/§7 of the approved plan) — if membership creation fails
 * for any reason, the organization must not be left behind as an orphan
 * with activeOwnerCount=1 and zero real OWNER memberships.
 */
export async function createOrganization(
  input: CreateOrganizationInput,
  creatorUserId: Types.ObjectId,
  logger: Logger,
): Promise<OrganizationDocument> {
  return withTransaction(async (session) => {
    const organization = await organizationRepository.create(
      { name: input.name, status: 'ACTIVE', activeOwnerCount: 1 },
      session,
    )
    await membershipRepository.create(
      { organizationId: organization._id, userId: creatorUserId, role: 'OWNER', status: 'ACTIVE' },
      session,
    )
    logger.info(
      { organizationId: organization._id.toString(), userId: creatorUserId.toString() },
      'Organization created',
    )
    return organization
  })
}

export async function listOrganizationsForUser(
  userId: Types.ObjectId,
): Promise<OrganizationDocument[]> {
  const memberships = await membershipRepository.listActiveForUser(userId)
  const organizationIds = memberships.map((membership) => membership.organizationId)
  return organizationRepository.findByIds(organizationIds)
}

// The organization's existence and ACTIVE status were already verified by
// resolveOrganizationContext() before this is ever called; re-fetching here
// (rather than threading the earlier document through) keeps req.membership
// limited to exactly the approved {membershipId, organizationId, role}
// shape. NotFoundError below is therefore defensive, not an expected path.
export async function getOrganization(
  organizationId: Types.ObjectId,
): Promise<OrganizationDocument> {
  const organization = await organizationRepository.findById(organizationId)
  if (!organization) {
    throw new NotFoundError('Organization not found.')
  }
  return organization
}

export async function updateOrganization(
  organizationId: Types.ObjectId,
  patch: UpdateOrganizationInput,
  logger: Logger,
): Promise<OrganizationDocument> {
  const organization = await organizationRepository.update(organizationId, patch)
  if (!organization) {
    throw new NotFoundError('Organization not found.')
  }
  if (patch.status === 'SUSPENDED') {
    logger.info({ organizationId: organizationId.toString() }, 'Organization suspended')
  } else if (patch.status === 'ACTIVE') {
    logger.info({ organizationId: organizationId.toString() }, 'Organization reactivated')
  }
  return organization
}

import type { Types } from 'mongoose'
import { withTransaction } from '../../../db/transaction.js'
import * as organizationRepository from '../repositories/organization.repository.js'
import * as membershipRepository from '../repositories/organization-membership.repository.js'
// One-directional dependency: modules/organizations reads modules/auth's
// already-public User lookup to confirm a target user exists before adding
// them to an organization. modules/auth never imports anything from
// modules/organizations — no circular dependency, and findById() already
// exists exactly as needed, so no change to modules/auth is required.
import { findById as findUserById } from '../../auth/repositories/user.repository.js'
import { ForbiddenError, NotFoundError } from '../../../lib/http-errors.js'
import type {
  MembershipRole,
  OrganizationMembershipDocument,
} from '../models/organization-membership.model.js'
import type { Logger } from '../../../lib/logger.js'

const LAST_OWNER_MESSAGE = 'Cannot remove or demote the last owner of an organization.'

export async function listMembers(
  organizationId: Types.ObjectId,
): Promise<OrganizationMembershipDocument[]> {
  return membershipRepository.listActiveForOrganization(organizationId)
}

/** Body accepts only {userId} — role/status are never client-controlled.
 *  New members always start as role=MEMBER, status=ACTIVE. */
export async function addMember(
  organizationId: Types.ObjectId,
  userId: Types.ObjectId,
  logger: Logger,
): Promise<OrganizationMembershipDocument> {
  const user = await findUserById(userId)
  if (!user) {
    throw new NotFoundError('User not found.')
  }

  const membership = await membershipRepository.create({
    organizationId,
    userId,
    role: 'MEMBER',
    status: 'ACTIVE',
  })
  logger.info(
    { organizationId: organizationId.toString(), userId: userId.toString() },
    'Member added to organization',
  )
  return membership
}

export async function changeRole(
  organizationId: Types.ObjectId,
  membershipId: Types.ObjectId,
  newRole: MembershipRole,
  logger: Logger,
): Promise<OrganizationMembershipDocument> {
  return withTransaction(async (session) => {
    const membership = await membershipRepository.findActiveById(
      organizationId,
      membershipId,
      session,
    )
    if (!membership) {
      throw new NotFoundError('Membership not found.')
    }

    const fromRole = membership.role
    if (fromRole === newRole) {
      return membership
    }

    // Required transitions (§14 of the approved plan):
    //   MEMBER<->ADMIN: no counter change
    //   *->OWNER: activeOwnerCount += 1 (always safe)
    //   OWNER->*: activeOwnerCount -= 1, guarded (last-owner protection)
    if (fromRole === 'OWNER' && newRole !== 'OWNER') {
      const organization = await organizationRepository.decrementActiveOwnerCountIfSafe(
        organizationId,
        session,
      )
      if (!organization) {
        throw new ForbiddenError(LAST_OWNER_MESSAGE)
      }
    } else if (fromRole !== 'OWNER' && newRole === 'OWNER') {
      await organizationRepository.incrementActiveOwnerCount(organizationId, session)
    }

    const updated = await membershipRepository.updateRole(
      organizationId,
      membershipId,
      newRole,
      session,
    )
    if (!updated) {
      // Defensive only: findActiveById() above already confirmed this exact
      // (organizationId, membershipId) pair within the same transaction.
      throw new NotFoundError('Membership not found.')
    }
    logger.info(
      {
        organizationId: organizationId.toString(),
        membershipId: membershipId.toString(),
        fromRole,
        toRole: newRole,
      },
      'Membership role changed',
    )
    return updated
  })
}

export async function removeMember(
  organizationId: Types.ObjectId,
  membershipId: Types.ObjectId,
  logger: Logger,
): Promise<void> {
  await withTransaction(async (session) => {
    const membership = await membershipRepository.findActiveById(
      organizationId,
      membershipId,
      session,
    )
    if (!membership) {
      throw new NotFoundError('Membership not found.')
    }

    if (membership.role === 'OWNER') {
      const organization = await organizationRepository.decrementActiveOwnerCountIfSafe(
        organizationId,
        session,
      )
      if (!organization) {
        throw new ForbiddenError(LAST_OWNER_MESSAGE)
      }
    }

    const removed = await membershipRepository.markRemoved(organizationId, membershipId, session)
    if (!removed) {
      // Defensive only: findActiveById() above already confirmed this exact
      // (organizationId, membershipId) pair within the same transaction.
      throw new NotFoundError('Membership not found.')
    }
    logger.info(
      { organizationId: organizationId.toString(), membershipId: membershipId.toString() },
      'Member removed from organization',
    )
  })
}

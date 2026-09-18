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
// One-directional dependency: reports sensitive-action outcomes to
// modules/audit, same as organization.service.ts and auth.service.ts.
import * as auditService from '../../audit/services/audit.service.js'
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
  // actorUserId is intentionally omitted — this function does not currently
  // receive the acting owner's id (no signature change was approved for
  // this file); `userId` here is the target being added, not the actor.
  await auditService.record(
    {
      organizationId,
      action: 'membership.added',
      entityType: 'OrganizationMembership',
      entityId: membership._id,
      outcome: 'SUCCESS',
      severity: 'INFO',
      metadata: { addedUserId: userId.toString() },
    },
    logger,
  )
  return membership
}

interface ChangeRoleResult {
  membership: OrganizationMembershipDocument
  changed: boolean
  fromRole?: MembershipRole
}

export async function changeRole(
  organizationId: Types.ObjectId,
  membershipId: Types.ObjectId,
  newRole: MembershipRole,
  logger: Logger,
): Promise<OrganizationMembershipDocument> {
  const result = await withTransaction<ChangeRoleResult>(async (session) => {
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
      return { membership, changed: false }
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
    return { membership: updated, changed: true, fromRole }
    // No audit call inside this callback — see below, only reached once
    // withTransaction() has resolved (transaction actually committed).
  })

  if (result.changed) {
    await auditService.record(
      {
        organizationId,
        action: 'membership.role_changed',
        entityType: 'OrganizationMembership',
        entityId: membershipId,
        outcome: 'SUCCESS',
        severity: 'INFO',
        metadata: { fromRole: result.fromRole as string, toRole: newRole },
      },
      logger,
    )
  }

  return result.membership
}

export async function removeMember(
  organizationId: Types.ObjectId,
  membershipId: Types.ObjectId,
  logger: Logger,
): Promise<void> {
  const removedRole = await withTransaction<MembershipRole>(async (session) => {
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
    return membership.role
    // No audit call inside this callback — see below, only reached once
    // withTransaction() has resolved (transaction actually committed).
  })

  await auditService.record(
    {
      organizationId,
      action: 'membership.removed',
      entityType: 'OrganizationMembership',
      entityId: membershipId,
      outcome: 'SUCCESS',
      severity: 'INFO',
      metadata: { role: removedRole },
    },
    logger,
  )
}

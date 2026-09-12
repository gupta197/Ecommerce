import type { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import * as organizationRepository from '../repositories/organization.repository.js'
import * as membershipRepository from '../repositories/organization-membership.repository.js'
import { ForbiddenError, UnauthenticatedError } from '../../../lib/http-errors.js'
import { objectIdSchema } from '../validation/organization.schema.js'
import { roleHasPermission, type Permission } from './permissions.js'

const GENERIC_FORBIDDEN_MESSAGE = 'You do not have access to this organization.'

/**
 * Resolves and verifies organization context from the untrusted URL segment
 * req.params.organizationId. Never copies it into req.membership directly —
 * every step (existence, ACTIVE status, ACTIVE membership) is re-verified
 * server-side on every request, deliberately with no caching.
 *
 * "Organization not found", "organization suspended", and "no active
 * membership" all produce the exact same generic 403 — the caller must never
 * be able to distinguish which of the three occurred (no organization
 * existence/suspension/membership enumeration).
 */
export async function resolveOrganizationContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }

    const organizationIdRaw = objectIdSchema.parse(req.params.organizationId)
    const organizationId = new Types.ObjectId(organizationIdRaw)

    const organization = await organizationRepository.findById(organizationId)
    if (!organization || organization.status !== 'ACTIVE') {
      // No owner/role bypass: a SUSPENDED organization blocks every role,
      // including OWNER. SEC-002 has no platform-admin capability to
      // reactivate it — this is an accepted, documented limitation, not an
      // oversight.
      throw new ForbiddenError(GENERIC_FORBIDDEN_MESSAGE)
    }

    const membership = await membershipRepository.findActiveByOrgAndUser(
      organizationId,
      new Types.ObjectId(req.auth.userId),
    )
    if (!membership) {
      throw new ForbiddenError(GENERIC_FORBIDDEN_MESSAGE)
    }

    req.membership = {
      membershipId: membership._id.toString(),
      organizationId: organization._id.toString(),
      role: membership.role,
    }
    next()
  } catch (error) {
    next(error)
  }
}

/** Must run after resolveOrganizationContext. */
export function requirePermission(permission: Permission) {
  return function requirePermissionMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    if (!req.membership || !roleHasPermission(req.membership.role, permission)) {
      next(new ForbiddenError(GENERIC_FORBIDDEN_MESSAGE))
      return
    }
    next()
  }
}

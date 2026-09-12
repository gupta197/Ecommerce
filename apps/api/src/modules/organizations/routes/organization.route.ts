import { Router } from 'express'
import { Types } from 'mongoose'
import * as organizationService from '../services/organization.service.js'
import * as membershipService from '../services/membership.service.js'
import { resolveOrganizationContext, requirePermission } from '../authorization/policy.js'
import { PERMISSIONS } from '../authorization/permissions.js'
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  addMemberSchema,
  changeRoleSchema,
  objectIdSchema,
} from '../validation/organization.schema.js'
import { sendSuccess } from '../../../lib/response.js'
import { UnauthenticatedError } from '../../../lib/http-errors.js'
import { createAuthenticateMiddleware } from '../../../middleware/authenticate.js'
import type { Logger } from '../../../lib/logger.js'

export interface CreateOrganizationsRouterOptions {
  jwtSecret: string
  logger: Logger
}

export function createOrganizationsRouter(options: CreateOrganizationsRouterOptions): Router {
  const router = Router()
  const authenticate = createAuthenticateMiddleware(options.jwtSecret)
  const { logger } = options

  router.use(authenticate)

  router.post('/', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const input = createOrganizationSchema.parse(req.body)
    const organization = await organizationService.createOrganization(
      input,
      new Types.ObjectId(req.auth.userId),
      logger,
    )
    sendSuccess(res, organization, {}, 201)
  })

  router.get('/', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const organizations = await organizationService.listOrganizationsForUser(
      new Types.ObjectId(req.auth.userId),
    )
    sendSuccess(res, organizations)
  })

  router.get(
    '/:organizationId',
    resolveOrganizationContext,
    requirePermission(PERMISSIONS.ORGANIZATION_READ),
    async (req, res) => {
      const organization = await organizationService.getOrganization(
        new Types.ObjectId(req.membership!.organizationId),
      )
      sendSuccess(res, organization)
    },
  )

  router.patch(
    '/:organizationId',
    resolveOrganizationContext,
    requirePermission(PERMISSIONS.ORGANIZATION_UPDATE),
    async (req, res) => {
      const input = updateOrganizationSchema.parse(req.body)
      const organization = await organizationService.updateOrganization(
        new Types.ObjectId(req.membership!.organizationId),
        input,
        logger,
      )
      sendSuccess(res, organization)
    },
  )

  router.get(
    '/:organizationId/memberships',
    resolveOrganizationContext,
    requirePermission(PERMISSIONS.MEMBERSHIP_READ),
    async (req, res) => {
      const members = await membershipService.listMembers(
        new Types.ObjectId(req.membership!.organizationId),
      )
      sendSuccess(res, members)
    },
  )

  router.post(
    '/:organizationId/memberships',
    resolveOrganizationContext,
    requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE),
    async (req, res) => {
      const input = addMemberSchema.parse(req.body)
      const membership = await membershipService.addMember(
        new Types.ObjectId(req.membership!.organizationId),
        new Types.ObjectId(input.userId),
        logger,
      )
      sendSuccess(res, membership, {}, 201)
    },
  )

  router.patch(
    '/:organizationId/memberships/:membershipId',
    resolveOrganizationContext,
    requirePermission(PERMISSIONS.ROLE_MANAGE),
    async (req, res) => {
      const membershipId = objectIdSchema.parse(req.params.membershipId)
      const input = changeRoleSchema.parse(req.body)
      const membership = await membershipService.changeRole(
        new Types.ObjectId(req.membership!.organizationId),
        new Types.ObjectId(membershipId),
        input.role,
        logger,
      )
      sendSuccess(res, membership)
    },
  )

  router.delete(
    '/:organizationId/memberships/:membershipId',
    resolveOrganizationContext,
    requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE),
    async (req, res) => {
      const membershipId = objectIdSchema.parse(req.params.membershipId)
      await membershipService.removeMember(
        new Types.ObjectId(req.membership!.organizationId),
        new Types.ObjectId(membershipId),
        logger,
      )
      sendSuccess(res, { removed: true })
    },
  )

  return router
}

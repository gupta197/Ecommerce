import type { MembershipRole } from '../models/organization-membership.model.js'

export const PERMISSIONS = {
  ORGANIZATION_READ: 'organization.read',
  ORGANIZATION_UPDATE: 'organization.update',
  MEMBERSHIP_READ: 'membership.read',
  MEMBERSHIP_MANAGE: 'membership.manage',
  ROLE_MANAGE: 'role.manage',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

// Static, code-defined role -> permission map. No Role/Permission MongoDB
// collections exist in SEC-002 — see modules/organizations/README.md for why.
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  OWNER: [
    PERMISSIONS.ORGANIZATION_READ,
    PERMISSIONS.ORGANIZATION_UPDATE,
    PERMISSIONS.MEMBERSHIP_READ,
    PERMISSIONS.MEMBERSHIP_MANAGE,
    PERMISSIONS.ROLE_MANAGE,
  ],
  ADMIN: [
    PERMISSIONS.ORGANIZATION_READ,
    PERMISSIONS.ORGANIZATION_UPDATE,
    PERMISSIONS.MEMBERSHIP_READ,
  ],
  MEMBER: [PERMISSIONS.ORGANIZATION_READ],
}

export function roleHasPermission(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

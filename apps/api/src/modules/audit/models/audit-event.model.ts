import mongoose, { Schema, type Types } from 'mongoose'

// Locked action matrix (SEC-003 approved plan §3) — only actions that are
// genuinely reachable in the current codebase. Do not add an action here
// without also confirming (and documenting) that it can actually occur.
export const AUDIT_ACTIONS = [
  'auth.registration.success',
  'auth.registration.failure',
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.refresh_token_reuse',
  'auth.session.revoke',
  'auth.session.revoke_others',
  'organization.created',
  'organization.suspended',
  'membership.added',
  'membership.removed',
  'membership.role_changed',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_ENTITY_TYPES = [
  'User',
  'SecuritySession',
  'Organization',
  'OrganizationMembership',
] as const
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number]

export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE'] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

export const AUDIT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number]

// Scalars only — deliberately not Record<string, unknown>. This is the
// primary, type-level control preventing a request body or a Mongoose
// document from ever being spread into metadata (see audit.service.ts's
// stripForbiddenKeys() for the secondary, defense-in-depth control).
export type SafeMetadata = Record<string, string | number | boolean | null>

export interface AuditEventAttrs {
  actorUserId?: Types.ObjectId
  organizationId?: Types.ObjectId
  action: AuditAction
  entityType: AuditEntityType
  entityId?: Types.ObjectId
  outcome: AuditOutcome
  severity: AuditSeverity
  ipAddress?: string
  userAgent?: string
  metadata?: SafeMetadata
  createdAt: Date
}

const auditEventSchema = new Schema<AuditEventAttrs>(
  {
    actorUserId: { type: Schema.Types.ObjectId },
    organizationId: { type: Schema.Types.ObjectId },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    entityType: { type: String, enum: AUDIT_ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId },
    outcome: { type: String, enum: AUDIT_OUTCOMES, required: true },
    severity: { type: String, enum: AUDIT_SEVERITIES, required: true },
    ipAddress: { type: String },
    userAgent: { type: String },
    metadata: { type: Schema.Types.Mixed },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    collection: 'audit_events',
    // No timestamps:true — createdAt is explicit and there is deliberately
    // no updatedAt: audit rows are immutable and never modified after
    // creation (see repositories/audit-event.repository.ts — create() only).
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

auditEventSchema.index({ organizationId: 1, createdAt: -1 })
auditEventSchema.index({ actorUserId: 1, createdAt: -1 })

export type AuditEventDocument = mongoose.HydratedDocument<AuditEventAttrs>

export const AuditEventModel = mongoose.model<AuditEventAttrs>('AuditEvent', auditEventSchema)

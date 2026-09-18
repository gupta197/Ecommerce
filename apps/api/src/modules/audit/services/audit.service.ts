import type { Types } from 'mongoose'
import * as auditEventRepository from '../repositories/audit-event.repository.js'
import type {
  AuditAction,
  AuditEntityType,
  AuditOutcome,
  AuditSeverity,
  SafeMetadata,
} from '../models/audit-event.model.js'
import type { Logger } from '../../../lib/logger.js'

export interface RecordAuditEventInput {
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
}

// Defense-in-depth only — NOT a substitute for callers explicitly
// constructing allowlisted metadata (every call site in auth.service.ts /
// organization.service.ts / membership.service.ts builds a small literal
// object by hand; none ever spreads a request body or a Mongoose document).
// Case-insensitive key-name match; values are never inspected.
const FORBIDDEN_METADATA_KEYS = [
  'password',
  'passwordhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'cookie',
]

function stripForbiddenKeys(metadata: SafeMetadata | undefined): SafeMetadata | undefined {
  if (!metadata) {
    return metadata
  }
  const clean: SafeMetadata = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!FORBIDDEN_METADATA_KEYS.includes(key.toLowerCase())) {
      clean[key] = value
    }
  }
  return clean
}

/**
 * Best-effort, non-blocking: this function NEVER throws, regardless of
 * where a failure originates (input handling or the underlying write).
 * Callers must never `await` this expecting a rejection to signal a
 * problem — an audit-write failure must never fail the sensitive operation
 * that triggered it. If `logger` is supplied, a failure is logged as a
 * warning; if not, it is silently swallowed (see SEC-003's approved plan —
 * no new request-context/logger plumbing is introduced merely to guarantee
 * failure visibility everywhere).
 */
export async function record(input: RecordAuditEventInput, logger?: Logger): Promise<void> {
  try {
    await auditEventRepository.create({
      ...input,
      metadata: stripForbiddenKeys(input.metadata),
    })
  } catch (error) {
    logger?.warn({ err: error, action: input.action }, 'Audit event write failed')
  }
}

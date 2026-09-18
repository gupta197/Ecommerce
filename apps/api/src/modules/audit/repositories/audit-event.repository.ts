import {
  AuditEventModel,
  type AuditEventAttrs,
  type AuditEventDocument,
} from '../models/audit-event.model.js'

export type CreateAuditEventData = Omit<AuditEventAttrs, 'createdAt'>

/**
 * The ONLY exported function in this file, intentionally. AuditEvent rows
 * are immutable and append-only — there is no update/delete/patch/replace
 * function here, and none should ever be added.
 */
export async function create(data: CreateAuditEventData): Promise<AuditEventDocument> {
  return AuditEventModel.create(data)
}

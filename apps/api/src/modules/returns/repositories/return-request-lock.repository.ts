import type { Types, ClientSession } from 'mongoose'
import { ReturnRequestLockModel } from '../models/return-request-lock.model.js'

/**
 * Atomically touches (creates if absent, no-ops if present) the lock
 * document for this orderId, inside the caller's transaction session. Must
 * always be called BEFORE reading existing ReturnRequests for the same
 * order within the same transaction — see return-request-lock.model.ts for
 * the full concurrency reasoning. No duplicate-key catch is needed here
 * (unlike a bare, non-transactional upsert elsewhere in this codebase):
 * inside a transaction, two concurrent touches for the same orderId
 * surface as a write conflict, which the MongoDB driver's
 * session.withTransaction() already retries automatically.
 */
export async function touch(orderId: Types.ObjectId, session: ClientSession): Promise<void> {
  await ReturnRequestLockModel.findOneAndUpdate(
    { orderId },
    { $setOnInsert: { orderId } },
    { upsert: true, session },
  )
}

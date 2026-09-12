import mongoose, { type ClientSession } from 'mongoose'

/**
 * Runs `fn` inside a MongoDB multi-document transaction.
 *
 * Requires the connected deployment to be a replica set or sharded cluster —
 * this does NOT work against a standalone mongod. Local/dev MongoDB must be
 * initiated as a (even single-node) replica set for this to function at all.
 *
 * IMPORTANT — this is a MongoDB-only transaction helper. It makes MongoDB
 * writes performed via `session` atomic with each other. It has no knowledge
 * of, and provides no atomicity guarantee whatsoever for, external side
 * effects performed inside `fn` — payment-provider calls, email/SMS sends,
 * webhook deliveries, etc. are NOT rolled back if the transaction aborts.
 * Do not call such external side effects from within `fn`; perform them
 * after the transaction has committed instead (e.g. via a background job).
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.connection.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result as T
  } finally {
    await session.endSession()
  }
}

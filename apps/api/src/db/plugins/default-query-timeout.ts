import mongoose from 'mongoose'

let registeredTimeoutMs: number | undefined

/**
 * Applies a default `maxTimeMS` to find/count/aggregate-style operations on
 * every schema registered from this point on, unless a query explicitly
 * sets its own. Protects against unbounded/runaway queries (CLAUDE.md §13).
 * Idempotent — safe to call once per process even before any connect retry.
 */
export function registerDefaultQueryTimeoutPlugin(timeoutMs: number): void {
  if (registeredTimeoutMs === timeoutMs) {
    return
  }
  registeredTimeoutMs = timeoutMs

  mongoose.plugin((schema) => {
    schema.pre(/^find/, function (this: mongoose.Query<unknown, unknown>) {
      if (this.getOptions().maxTimeMS === undefined) {
        this.maxTimeMS(timeoutMs)
      }
    })

    schema.pre('countDocuments', function (this: mongoose.Query<unknown, unknown>) {
      if (this.getOptions().maxTimeMS === undefined) {
        this.maxTimeMS(timeoutMs)
      }
    })

    schema.pre('aggregate', function (this: mongoose.Aggregate<unknown>) {
      if (this.options.maxTimeMS === undefined) {
        this.option({ maxTimeMS: timeoutMs })
      }
    })
  })
}

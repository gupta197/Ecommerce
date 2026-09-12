# Database Conventions

This directory holds the MongoDB/Mongoose connection foundation (DB-001). It
intentionally contains **no business schemas** — these conventions are for
the modules that add them (CAT-001 onward).

## Connection

- One singleton Mongoose default connection for the whole app. Any module
  can `import mongoose from 'mongoose'` and define a model — no connection
  object needs to be passed around or injected.
- `connectDatabase()` is called once at boot, before the HTTP server starts
  listening. If it fails after its retry budget, the process exits — the
  app never accepts HTTP traffic without a working database connection.
- Never log `MONGODB_URI` or any value derived from it. Only the configured
  database name is safe to log.

## Dev vs. production

- `autoIndex` / `autoCreate` are `true` outside production (convenient for
  local development) and `false` in production — index/collection creation
  in production must be a deliberate, reviewed action, not a side effect of
  process boot.
- Production startup fails fast if `MONGODB_URI` points at
  `localhost`/`127.0.0.1`, or doesn't indicate TLS (`mongodb+srv://` or an
  explicit `tls=true`/`ssl=true`). This is a startup safety guard against
  misconfiguration, not a substitute for correct infrastructure-level TLS.
- Use a dedicated, least-privilege MongoDB user per environment (readWrite
  scoped to this app's specific database) — never a cluster-admin/root user.
  This must be configured at the database/Atlas level; it cannot be
  enforced from application code.

## Schema conventions (for future modules)

- One model file per module, inside that module's own folder
  (e.g. `modules/catalog/product.model.ts`) — never a shared global
  `models/` dump. Keeps module boundaries intact (CLAUDE.md §3.1).
- Explicit schemas only, `{ timestamps: true }` on every schema (Mongoose
  manages `createdAt`/`updatedAt`) instead of hand-rolled timestamp fields.
- Set an explicit `collection` name per schema rather than relying on
  Mongoose's auto-pluralization.
- Access models only through that module's own repository files —
  controllers/services never import another module's model directly.
  A generic `BaseRepository<T>` is deliberately **not** introduced yet;
  write a concrete repository per module once its first real schema exists.

## Tenant (organization) conventions

- Every business-owned schema must include
  `organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true }`
  and, where useful, as part of a compound index with other frequently
  filtered fields.
- Every repository query function must apply the organization filter
  server-side. `organizationId` is never trusted from the client (ADR-002,
  CLAUDE.md §3.3).

## Indexes

- `autoIndex: true` in dev/test builds indexes automatically from schema
  definitions — convenient locally, but never relied on in production.
- In production, indexes are created deliberately via `Model.syncIndexes()`
  run during a maintenance/deploy window — not implicitly at every boot.
- Every important collection's indexes must be reviewed (CLAUDE.md §6.1).

## Money and dates

- Money fields use integer minor units (`Number`), per ADR-008.
  `Schema.Types.Decimal128` only where the domain genuinely requires
  decimal precision. This is a documented/code-review convention — it
  isn't (yet) enforced by an automated lint rule.
- Use Mongoose's native `Date` type only. MongoDB stores BSON dates in UTC
  internally regardless of input, so CLAUDE.md §6.5 is satisfied as long as
  no manual timezone conversion happens before storage.

## ObjectId and external identifiers

- `_id` stays the native MongoDB `ObjectId` for every document.
- Any identifier that needs to be exposed externally (order-tracking
  numbers, idempotency keys) is a separate explicit field, generated with
  `crypto.randomUUID()` (the same pattern already used for request IDs in
  `middleware/request-context.ts`) — not a replacement for `_id`.

## Transactions

See `transaction.ts`'s `withTransaction()` helper. Requires a replica set
(even single-node) — local/dev MongoDB must be initiated as one; a plain
standalone `mongod` cannot run transactions at all. Keep transactions short
(no external network calls inside them) and MongoDB-only — see the
prominent warning in `transaction.ts` about external side effects.

## Migrations

No migration tool is installed yet — there are no schemas to migrate.
The choice of tool (e.g. `migrate-mongo` vs. a custom script + tracking
collection) is recorded as an open decision (`DEC-006` in
`Planning/OPEN_DECISIONS.md`), to be resolved when the first schema-changing
task actually needs it.

## Testing

`connection.test.ts` uses `mongodb-memory-server`'s `MongoMemoryServer` for
connection lifecycle tests. `transaction.test.ts` uses `MongoMemoryReplSet`
(transactions require a replica set, which a plain `MongoMemoryServer`
instance is not). The first test run downloads a real `mongod` binary
(cached afterward) — this needs network access once.

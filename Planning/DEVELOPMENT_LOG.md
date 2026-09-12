# Development Log

## Purpose
Chronological record of implementation work, reviews, decisions, testing and releases.

## Development Protocol
1. Select one task from `MASTER_TASK_LIST.xlsx`.
2. Read the task, dependencies and acceptance criteria.
3. Inspect existing code before changing anything.
4. Explain the implementation approach.
5. Implement only the approved scope.
6. Run typecheck, lint and relevant unit/integration/security tests.
7. Perform a security and tenant-isolation review.
8. Update `DEVELOPMENT_PROGRESS.xlsx`.
9. Add significant changes to `CHANGE_LOG.xlsx`.
10. Update architecture/decision documentation when required.
11. Commit changes to Git with a meaningful commit message.
12. Mark the task `COMPLETED` only when acceptance criteria and tests pass.

## Status Values
- NOT_STARTED
- READY
- IN_PROGRESS
- BLOCKED
- IN_REVIEW
- TESTING
- COMPLETED
- CANCELLED

## Entries

### 2026-09-10
- Initialized file-driven project management structure.
- Defined phased implementation task list.
- Established architecture decision records.
- Established development logging protocol.
- FOUND-001 (repository/monorepo scaffold) implemented and committed (commits `d025c01`, `7ffbc53`): npm workspaces monorepo, `apps/web`/`apps/admin` (Vite + React + TS placeholders), `apps/api` (TypeScript skeleton, no Express yet), `packages/config` and `packages/shared-types`. Git initialized. `DEVELOPMENT_PROGRESS.xlsx` was updated at the time, but the `Status` column in `MASTER_TASK_LIST.xlsx` was not — see the 2026-09-11 correction below.

### 2026-09-11
- **Correction:** `MASTER_TASK_LIST.xlsx` Status column for FOUND-001 changed from `NOT_STARTED` to `COMPLETED`. FOUND-001 was fully implemented, validated and committed on 2026-09-10 (see above); the Status column was simply never updated at the time. Data-integrity fix only, no code impact. Recorded as `CHG-002` in `CHANGE_LOG.xlsx`.
- FOUND-002 (Backend / Express API foundation) implemented and marked `COMPLETED` (commit `f0ff3a4`): Express 5 app (ESM/NodeNext) with the standardized success/error response envelope, request-ID middleware, pino/pino-http structured logging with Authorization/Cookie header redaction, zod-validated environment config (production startup fails fast without a valid, non-wildcard `CORS_ORIGIN`; no `dotenv` dependency — Node's native env-file loading, `.env` optional), in-memory rate-limit foundation (documented as single-instance-only, not yet wired to any route), liveness-only `GET /api/v1/health` (no DB/Redis dependency), and bounded graceful shutdown on `SIGTERM`/`SIGINT`. No MongoDB, Redis, authentication, RBAC, or business modules — deferred to DB-001/SEC-001 and later. 9 automated tests added, all passing. Recorded as `CHG-001` in `CHANGE_LOG.xlsx`.

### 2026-09-12
- DB-001 (MongoDB connection foundation) implemented and marked `COMPLETED` (commit `0ce5ed8`): singleton Mongoose connection (`apps/api/src/db/connection.ts`) with bounded initial-connect retry, `sanitizeFilter`/`strictQuery` hardening, dev-only `autoIndex`/`autoCreate`, and safe logging (connection string/credentials never logged, verified by a dedicated test). Graceful shutdown now closes the real MongoDB connection after in-flight HTTP requests finish, within FOUND-002's existing bounded timeout. Environment config extended with MongoDB variables and two production startup guards: reject `localhost`/`127.0.0.1`, and require `mongodb+srv://` or explicit `tls=true`/`ssl=true` — a startup safety net, not a substitute for infrastructure-level TLS. Added a global `maxTimeMS` query-timeout plugin and a `withTransaction()` helper, explicitly documented as MongoDB-only — it does not make external side effects (payment/email/SMS/webhook calls) atomic. Added `GET /api/v1/ready`, reflecting real MongoDB connection state via the standard envelope (503 when not ready); `GET /api/v1/health` remains liveness-only. No business schemas, auth, RBAC, or Redis — conventions for future schemas (tenant scoping, indexes, money/date types, ObjectId/UUID, migrations) are documented in `apps/api/src/db/README.md` rather than implemented. Migration tool choice deliberately deferred, recorded as `DEC-006` in `OPEN_DECISIONS.md`. 14 new tests added using `mongodb-memory-server` (`MongoMemoryServer` for connection lifecycle, `MongoMemoryReplSet` for transaction commit/rollback — transactions require a replica set). 23/23 tests passing. Recorded as `CHG-003` in `CHANGE_LOG.xlsx`.

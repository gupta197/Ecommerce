# Audit Module — Audit Event Infrastructure (SEC-003)

This module implements **SEC-003: Audit logging / audit-security event
infrastructure** from `Planning/MASTER_TASK_LIST.xlsx`. It is write-side
infrastructure only — a single, append-only `AuditEvent` collection, wired
into the sensitive actions that already exist in SEC-001 (`modules/auth`)
and SEC-002 (`modules/organizations`).

## One collection, not two

`AuditEvent` is the only collection this module creates. CLAUDE.md
describes "audit logging" (§4.4) and "security events" (§4.5) as related
but separately-numbered concerns; this module treats a security-relevant
event (e.g. refresh-token reuse) as an `AuditEvent` with `severity:
'WARNING'`, not as a member of a second, parallel collection. A dedicated
`SecurityEvent` collection was considered and rejected — there is no
distinct query pattern that would justify it, and this project's standing
discipline is not to add a second structure until a real, current need
exists (the same reasoning SEC-002 applied to not building a separate
`Role`/`Permission` collection).

## Repository is `create()`-only

`repositories/audit-event.repository.ts` exports exactly one function.
There is no `update`, `delete`, `patch`, or `replace` — audit rows are
immutable and append-only by construction, not by convention. Nothing in
this codebase should ever need to modify a persisted `AuditEvent`.

## Best-effort, non-blocking writes

`services/audit.service.ts`'s `record()` never throws, regardless of
whether the failure originates in its own input handling or the underlying
database write. An audit-write failure must never fail the sensitive
operation that triggered it — availability of the primary security action
(login, logout, an organization mutation) takes priority over audit
durability. If a `Logger` is supplied, a failure is logged as a warning;
callers that don't have one in scope (see below) simply proceed silently.

## Transaction timing — after commit, never inside

For the three SEC-002 operations that use `withTransaction()`
(`createOrganization`, `changeRole`, `removeMember`), the audit call
happens strictly **after** the transaction has resolved, never inside the
callback passed to `withTransaction()`. This isn't just style: MongoDB's
`session.withTransaction()` can silently retry its callback on a transient
error, and a "record one audit event" write is not naturally idempotent —
embedding it inside the retryable callback risks duplicate audit rows on
retry, unlike the transaction's own guarded counter operations (which are
safe to re-run). If the transaction fails or rolls back for any reason —
including a failure specifically during the commit phase — the calling
service function rejects before ever reaching the audit call, so no audit
event is created for an operation that didn't actually commit.

## Metadata safety — three layered controls, not just discipline

1. **Type-level restriction**: `metadata?: SafeMetadata` where
   `SafeMetadata = Record<string, string | number | boolean | null>` —
   scalars only, no nested objects or arrays. A request body or a Mongoose
   document can never satisfy this type, so `metadata: req.body` is a
   compile error by construction, not merely a rule someone has to remember.
2. **Explicit, hand-written construction at every call site**: every one of
   the 13 instrumented call sites builds its own small literal object
   (e.g. `{ reason, email }`, `{ fromRole, toRole }`) — none ever spreads an
   existing object.
3. **A small runtime backstop** (`stripForbiddenKeys()` in
   `audit.service.ts`) that drops any metadata key case-insensitively
   matching a short fixed list (`password`, `passwordhash`, `token`,
   `refreshtoken`, `accesstoken`, `secret`, `cookie`) before persisting.
   This is defense-in-depth only — it is not a substitute for (1) and (2).

## Instrumented actions (locked, SEC-003 approved plan §3)

`auth.registration.success` · `auth.registration.failure` ·
`auth.login.success` · `auth.login.failure` · `auth.logout` ·
`auth.refresh_token_reuse` · `auth.session.revoke` ·
`auth.session.revoke_others` · `organization.created` ·
`organization.suspended` · `membership.added` · `membership.removed` ·
`membership.role_changed`.

**`organization.reactivated` is deliberately not instrumented.**
`resolveOrganizationContext()` blocks every request — including the very
`PATCH` that would set `status: 'ACTIVE'` — once an organization is
`SUSPENDED`, so a genuine suspended→active transition can never actually
occur through any endpoint. The only reachable trigger for
`organization.service.ts`'s existing `patch.status === 'ACTIVE'` branch is
a no-op (an already-`ACTIVE` organization redundantly patched to `ACTIVE`
again) — auditing that as "reactivated" would misrepresent what happened.
This capability belongs to a future task that adds a genuine reactivation
path (e.g. a platform-admin capability), which SEC-002 explicitly deferred.

`membership.role_changed` is recorded only when a genuine transition
occurs (`fromRole !== newRole`) — `changeRole()`'s existing same-role
no-op early-return produces no audit event, matching its existing (no
log line either) behavior.

## `auth.login.failure` — locked actor semantics

Per the approved plan, `auth.login.failure` **never** populates
`actorUserId` or `entityId`, for any of its four failure branches (unknown
email, throttled, disabled, wrong password) — the targeted account must
never be represented as the verified actor of a failed attempt. The four
branches collapse into one action, differentiated by `metadata.reason`,
reusing `LoginAttemptReason` (`'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED' |
'THROTTLED'`) rather than inventing a second taxonomy.

## Coexistence with `LoginAttempt`

`LoginAttempt` (SEC-001) is unchanged — it remains the narrow, 90-day-TTL'd
signal that exclusively feeds the progressive-login-delay throttle, written
on every attempt exactly as it always has been. `AuditEvent` is the
separate, durable, general-purpose security history. Both are written on a
login failure; neither replaces the other.

## `actorUserId` is not always available — and that's documented, not hidden

`organization.service.ts`/`membership.service.ts` needed **no signature
change** to add audit calls (`logger` was already a parameter everywhere a
mutation happens), which was an explicit constraint of the approved plan.
The tradeoff: none of `createOrganization`, `updateOrganization`,
`addMember`, `changeRole`, or `removeMember` currently receive the
_acting_ user's id as a parameter (only, where relevant, the _target's_
id) — so `actorUserId` is omitted from every organization-module audit
event. This is a documented, consistent limitation, not an oversight;
threading the caller's identity through these functions is a larger,
separate change this task deliberately did not make.

## Severity policy

`WARNING` is reserved for signals that specifically suggest a possible
attack (`auth.login.failure`, `auth.refresh_token_reuse`). Every other
instrumented action — including administrative ones with real impact, like
suspending an organization — is `INFO`, since it represents an intended,
authorized action rather than a suspicious one. `CRITICAL` is not used by
any action instrumented in this task.

## Indexes

`{organizationId: 1, createdAt: -1}` and `{actorUserId: 1, createdAt: -1}`
— justified even without a read API yet, since these are the audit trail's
unavoidable eventual query shapes ("everything in organization X",
"everything actor Y did"), and building the collection without them would
mean re-indexing an already-populated collection later. No TTL index — see
"Explicitly out of scope" below. No unique index — distinct-looking events
(e.g. two failed logins) are legitimate, separate records.

## Explicitly out of scope (approved plan)

A read/query API (no `GET /audit-events`, no dashboard, no pagination) —
write-side infrastructure only. `requestId`/`correlationId` — no new
request-context plumbing is introduced. Retention/TTL — no automatic
expiry; a future task must decide this explicitly rather than inheriting a
silently-chosen default. `SecurityEvent`, GeoIP, device fingerprinting,
anomaly detection, mass-export detection, automated alerting — none of
these have an existing signal source in this codebase. Rate-limit-violation
auditing — would require modifying the shared, multi-consumer
`middleware/rate-limit.ts`, deferred to a future task.

## Testing

`mongodb-memory-server`'s standalone `MongoMemoryServer` for the audit
module's own repository/service tests (a single-document insert needs no
transaction). Additive tests in `auth.service.test.ts`,
`organization.service.test.ts`, `membership.service.test.ts`, and
`organization.route.test.ts` prove each instrumented action produces the
correct `AuditEvent`, that a rolled-back transaction produces none, that a
committed transaction's audit write happens after commit, and that an
audit-write failure never fails the primary operation.

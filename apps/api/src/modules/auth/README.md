# Auth Module — Authentication Foundation (SEC-001)

This module implements **SEC-001: Authentication foundation** from
`Planning/MASTER_TASK_LIST.xlsx`. It is authentication and session-ownership
only — no RBAC, no organization membership, no permissions. Those are later
SEC-series tasks and are deliberately not started here.

## Layering

```
Route → Service → Repository → Mongoose Model
```

Unlike `modules/catalog`, this module **does** have a route layer, even
though no authorization system exists yet. Catalog deferred routes because
there was no authenticated context to enforce tenant checks against; auth's
own endpoints are the thing that _creates_ that context, so the
chicken-and-egg problem catalog had doesn't apply here — register/login are
inherently public, and the rest self-authenticate via the tokens this module
issues.

No controller layer: route handlers are thin (parse → call one service
function → respond), so a separate controller layer would be a pass-through
with no behavior of its own.

## Hybrid token architecture

Short-lived signed **JWT access token** (`jose`, HS256, default 15 minutes)

- long-lived opaque **DB-backed refresh token** (`SecuritySession`). Pure
  stateless JWT alone can't support "list active sessions" / "revoke one" /
  "revoke others" / reuse detection — those require a server-side record.
  Pure DB-session-per-request would mean a MongoDB round trip on every
  authenticated request. The hybrid keeps the common case (verifying an
  access token) stateless while keeping session management genuinely
  possible.

### JWT claims

`sub` (userId), `sid` (SecuritySession id), `jti` (unique per-token id),
`iat`, `exp`, `iss` (`ecommerce-api`), `aud` (`ecommerce-platform`).
Deliberately **no** `organizationId`/roles/permissions — those belong to a
future authorization layer and don't belong on a token this module issues
before that layer exists.

`token.service.ts`'s `verifyAccessToken` validates: signature, an explicit
algorithm allowlist (`['HS256']` — never trusts the token's own `alg`
header beyond that allowlist), issuer, audience, expiration, and that
`sub`/`sid`/`jti` are all present non-empty strings.

## `authenticate()` middleware — no per-request DB lookup

`middleware/authenticate.ts` cryptographically verifies the access token
and attaches `req.auth = { userId, sessionId }`. It does **not** query
MongoDB. This is intentional: the access token is short-lived specifically
so stateless verification stays safe — a revoked session's already-issued
access token remains valid until its own natural (short) expiry. Immediate
revocation enforcement and step-up re-authentication for sensitive
operations are explicitly future work, layered on top of this middleware
for specific routes, not built here.

## Refresh rotation — atomic claim, not read-then-write

`security-session.repository.ts`'s `claimActiveByHash` is the core
operation: a single `findOneAndUpdate` with `{refreshTokenHash, status:
'ACTIVE'}` as the filter and `{$set: {status: 'ROTATED', rotatedAt}}` as the
update, returning the pre-update document. Using the current state as part
of the filter makes this a MongoDB-native compare-and-swap — there is no
separate find-then-check-then-write sequence for a second concurrent
request to race inside of.

When the claim fails (returns `null`), `auth.service.ts`'s `refresh()`
can't distinguish _why_ from the caller's perspective — missing hash,
already-rotated, already-revoked, and true reuse all produce the same
generic "Invalid or expired session" response. Internally, if a session
document is found for that hash at all, the entire `familyId` is revoked
and a `logger.warn` (no plaintext token, ever) is emitted — reuse of an
already-rotated token is the signal that a previously-issued refresh token
has leaked.

A dedicated concurrency test
(`services/auth.service.test.ts` — `CONCURRENCY: two simultaneous refresh
attempts...`) proves: of two truly simultaneous `refresh()` calls with the
same token, exactly one succeeds and one fails, and exactly one replacement
session is ever created (only the winner calls `issueNewSession` — the
loser's code path never does), so there is never a scenario where both
concurrent requests successfully rotate.

## Session family & expiry

`familyId` groups a linear chain of rotations (no `parentSessionId` — every
session in a family already shares the same `familyId`, so a second
back-reference field would be redundant). `familyCreatedAt` is denormalized
onto **every** generation in the family, not just the first, because the
original document can be TTL-deleted once superseded — querying "the
oldest surviving member" for the absolute deadline would break once that
happens.

Refresh expiry is computed as:

```
newExpiresAt = min(now + REFRESH_TOKEN_TTL_MS, familyCreatedAt + ABSOLUTE_SESSION_LIFETIME_MS)
```

Defaults: `REFRESH_TOKEN_TTL_MS` = 30 days (sliding),
`ABSOLUTE_SESSION_LIFETIME_MS` = 90 days (hard cap from the family's
creation). Once the absolute deadline passes, refresh fails outright and
the user must log in again — a family is never indefinitely renewable
purely by staying active.

## Registration — no enumeration, no auto-login

`register()` always parses input, always hashes the password (even when
the email turns out to already exist — the hash is simply discarded), and
returns `void` regardless of outcome. The route always responds with the
same generic message and status, and never sets any auth cookie from
register — issuing a session on registration would turn cookie-presence
itself into an account-existence side channel. A duplicate-email call
leaves the existing account completely untouched (verified by asserting
its `passwordHash` and document count are unchanged, not merely that no
error was thrown).

## Login — progressive delay, not a hard lockout

Every login failure mode (unknown email, wrong password, disabled account,
currently throttled) throws the same `UnauthenticatedError` with the same
message. A fixed "N failures → locked for M minutes" design would let an
attacker who only knows a victim's email lock that victim out on demand —
a targeted denial-of-service vector. Instead:

- The first `LOGIN_GRACE_ATTEMPTS` (default 3) failures cost nothing beyond
  the existing IP-based rate limiter.
- Each failure past that sets `nextAttemptAllowedAt` to `now + delay`,
  where `delay = min(LOGIN_BASE_DELAY_MS * 2^(failures - grace),
LOGIN_MAX_DELAY_MS)` — doubling, capped, never infinite.
- A **correct** password always resets `failedLoginAttempts` to 0 and
  clears `nextAttemptAllowedAt` — there is no separate "locked" state to
  get permanently stuck in; the account is only ever temporarily slowed
  down, never denied indefinitely.

This lives alongside, not instead of, the existing IP-based rate limiter
(`AUTH_RATE_LIMIT_*`) applied to `/register` and `/login` — no Redis
involved, per the approved scope.

## LoginAttempt

A minimal record (`email`, `userId?`, `success`, `reason?`, `ipAddress?`,
`userAgent?`, `createdAt`) — not the full SEC-003 security-event/audit
framework, which is future work. 90-day TTL index on `createdAt`; no
GeoIP-derived fields are stored (out of scope for this task).

## Cookies

`access_token` — `path=/`. `refresh_token` — `path=/api/v1/auth` only,
so it is never sent on unrelated requests. `xsrf_token` — `path=/`,
deliberately **not** `HttpOnly` (the double-submit pattern requires
client-side JS to read it and echo it back in a header). All three:
`Secure` in production, `SameSite=Lax`.

Request-cookie parsing uses the `cookie` package directly (`lib/cookies.ts`)
rather than `cookie-parser` — Express 5.2.1 was verified (not assumed) to
not parse request cookies itself; `cookie` is the same mature dependency
Express already relies on internally, just imported directly. Note:
`cookie@2.x` renamed its exports from `parse`/`serialize` to
`parseCookie`/`stringifyCookie` — `lib/cookies.ts` uses the new names
deliberately, verified against the actually-installed package rather than
assumed from older documentation.

## CSRF

Double-submit cookie (`xsrf_token` cookie must match the `x-xsrf-token`
header) as the primary, mandatory control, plus `Origin` validation
(falling back to `Referer`'s origin when `Origin` is absent) as
defense-in-depth. Neither header being present is not itself a hard
failure — the double-submit token remains the control that's actually
enforced unconditionally.

Applied to exactly: `POST /logout`, `POST /refresh`, `POST
/sessions/:id/revoke`, `POST /sessions/revoke-others`. **Not** applied to
`/register` or `/login` — there is no pre-existing authenticated
session/cookie for CSRF to ride on at that point.

## Sessions — ownership-scoped

`GET /sessions`, `POST /sessions/:id/revoke`, `POST
/sessions/revoke-others`, `POST /logout` all operate only on the
authenticated caller's own sessions. `revokeById`/`revokeSession` include
`userId` in their query filter — a session ID belonging to another user is
indistinguishable from a nonexistent one (`NotFoundError`), never a
distinguishing "forbidden" response.

## Indexes

| Model           | Index                       | Unique | Supports                                  |
| --------------- | --------------------------- | ------ | ----------------------------------------- |
| User            | `{email: 1}`                | yes    | Login lookup; one account per email       |
| SecuritySession | `{refreshTokenHash: 1}`     | yes    | Refresh-token lookup and the atomic claim |
| SecuritySession | `{userId: 1, status: 1}`    | no     | Listing a user's active sessions          |
| SecuritySession | `{familyId: 1}`             | no     | Family-wide revocation                    |
| SecuritySession | `{expiresAt: 1}` (TTL)      | no     | Automatic cleanup of expired sessions     |
| LoginAttempt    | `{email: 1, createdAt: -1}` | no     | Recent-attempts lookup for a given email  |
| LoginAttempt    | `{createdAt: 1}` (TTL, 90d) | no     | Automatic retention cleanup               |

## Explicitly out of scope here

RBAC, permissions, organization membership, MFA, password reset, email
verification, GeoIP lookup/schema fields, Redis, the SEC-003 audit/security
event framework, marketplace identity, Product/ProductVariant, and payment
security. The architecture (separate `AuthConfig`, no roles on the JWT,
service functions that don't assume a single organization) is intended to
remain compatible with all of these without requiring rework, but none of
them are implemented by this task.

## Testing

`mongodb-memory-server` (standalone `MongoMemoryServer`, no replica set —
no transactions are needed for this domain) plus `supertest` for the
route-level integration tests. Covers password hashing, token verification
(including wrong issuer/audience/algorithm/malformed claims), registration
(including non-leaking duplicate behavior), login (including lockout
progression and reset), refresh (including the atomic-rotation concurrency
test), sessions (including cross-user isolation), the `authenticate` and
CSRF middleware in isolation, cookie parsing, and database indexes.

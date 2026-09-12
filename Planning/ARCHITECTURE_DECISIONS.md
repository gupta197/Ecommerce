# Architecture Decisions

## ADR-001 — Modular Monolith First
**Status:** Accepted

Build the platform as a modular monolith initially. Do not introduce microservices until scale, team boundaries, or operational requirements justify them.

## ADR-002 — Organization-First Multi-Tenancy
**Status:** Accepted

Every business-owned document must carry `organizationId` and backend authorization must enforce organization isolation.

## ADR-003 — MERN + TypeScript
**Status:** Accepted

Use React + TypeScript, Node.js + Express + TypeScript, MongoDB + Mongoose, Redis/BullMQ, and S3-compatible object storage.

## ADR-004 — Inventory Ledger
**Status:** Accepted

Inventory changes are represented by immutable transactions. Current balances are derived/materialized for fast reads.

## ADR-005 — Server-Authoritative Commerce
**Status:** Accepted

Prices, discounts, permissions, stock and checkout totals are validated on the backend. The frontend is never trusted for security-sensitive business values.

## ADR-006 — Security as a Platform Layer
**Status:** Accepted

Authentication, sessions, tenant isolation, RBAC, object-level authorization, audit logging, security events, rate limiting and webhook verification are foundational platform capabilities.

## ADR-007 — File-Driven Development Management
**Status:** Accepted

Development planning and progress are maintained in repository files and Excel workbooks. Git is used for code history. No external project-management system is required.

## ADR-008 — Money Representation
**Status:** Accepted

Use integer minor units consistently for monetary amounts where practical. Never use binary floating-point for financial calculations.

## ADR-009 — Category Is Organization-Owned
**Status:** Accepted

Category (and, by the same reasoning, Brand when CAT-002 is implemented) is organization-owned, not global/shared, until real multi-organization/marketplace requirements are known. Every category requires `organizationId`, enforced as a mandatory parameter on every repository function. A shared/global category registry is a marketplace concern (MKT-002) to revisit later; starting org-scoped and adding sharing later is a safe additive change, whereas starting global and retrofitting isolation onto already-shared data is not.

## ADR-010 — Category Hierarchy via parentId
**Status:** Accepted

Category hierarchy is represented with a simple self-referencing `parentId`, not a materialized path or nested sets. This is the simplest approach appropriate for the realistically shallow (2–4 level) category trees this project needs. Deep ancestor/descendant queries, if ever needed, use MongoDB's `$graphLookup` without requiring a schema change.

## ADR-011 — Catalog Lifecycle: DRAFT/ACTIVE/ARCHIVED, Soft Archive, No Cascade
**Status:** Accepted

Catalog entities (starting with Category) use a `DRAFT | ACTIVE | ARCHIVED` status. Archiving is always soft (status change only, never a hard delete) and never cascades — archiving a parent category does not archive its children. Archived entities remain directly queryable; only default listing views (once they exist) exclude them.

## ADR-012 — Catalog HTTP Routes Deferred Until SEC-002
**Status:** Accepted

Catalog modules (starting with CAT-001/Category) stop at Service → Repository → Model until SEC-001 (authentication) and SEC-002 (organizations/RBAC) exist. No HTTP routes or controllers are added before then, and no temporary/placeholder authentication or authorization system is introduced to work around the gap. Every repository function requires `organizationId` as a mandatory parameter, so the eventual route layer is a thin wrapper over an already tenant-safe service layer.

## ADR-013 — Hybrid JWT + DB-Backed Refresh Session Architecture
**Status:** Accepted

Authentication uses a short-lived, stateless, signed JWT access token (`jose`, HS256, ~15 minutes) for per-request verification, plus a long-lived, opaque, DB-backed refresh token (`SecuritySession`, SHA-256 hash at rest) for session management. A pure stateless-JWT design cannot support CLAUDE.md's session requirements (list active sessions, revoke one/others, family reuse detection) without a server-side record; a pure DB-session-per-request design would require a MongoDB round trip on every authenticated request. The JWT carries only `sub`/`sid`/`jti`/`iat`/`exp`/`iss`/`aud` — never roles, permissions, or `organizationId` — keeping it compatible with, but not anticipating, SEC-002's authorization layer.

## ADR-014 — Atomic Refresh-Token Rotation with Family-Wide Reuse Revocation
**Status:** Accepted

Refresh-token rotation is implemented as a single atomic MongoDB `findOneAndUpdate` compare-and-swap (`{refreshTokenHash, status: 'ACTIVE'}` → `{status: 'ROTATED', ...}`), not a separate find-then-update sequence, so two concurrent refresh attempts with the same token can never both succeed. Sessions are grouped by a `familyId` only (no `parentSessionId` — every session in a family already carries the same `familyId`, so a back-reference would be redundant). If a claim fails because the token is found but not `ACTIVE`, the entire family is revoked (reuse detection) and a generic, non-distinguishing error is returned regardless of the underlying cause. `familyCreatedAt` is denormalized onto every generation (not just the first) so an absolute session lifetime (default 90 days) can be enforced even after earlier generations are TTL-deleted, independent of the 30-day sliding refresh window.

## ADR-015 — Progressive Login Delay Instead of Hard Account Lockout
**Status:** Accepted

Login failure handling uses a progressive, doubling delay (`nextAttemptAllowedAt`) after an initial grace period, capped at a maximum, always reset to zero by a correct password — never a fixed "N failures → locked for M minutes" hard lockout. A hard, account-wide lockout keyed only on a known/guessable email is itself a targeted denial-of-service vector: it lets an attacker who does not have the victim's password lock the victim out on demand. This lives alongside, not instead of, the existing IP-based rate limiter, and requires no Redis.

## ADR-016 — Fixed Role Enum and Static Permission Map, No Role/Permission Collections
**Status:** Accepted

`OrganizationMembership.role` is a fixed `OWNER | ADMIN | MEMBER` enum, and permissions are a static, code-defined role→permission map (`organization.read`, `organization.update`, `membership.read`, `membership.manage`, `role.manage`) — no separate `Role` or `Permission` MongoDB collection. SEC-002's actual requirements (tenant isolation, authorization tests passing) don't call for dynamic or per-organization-custom roles; a fixed enum plus a static map is the simplest model that satisfies them, and remains an additive, non-breaking migration path if genuine custom roles are ever required later.

## ADR-017 — Organization Context via URL Parameter, Re-Verified Every Request
**Status:** Accepted

Organization context is carried in the URL (`/api/v1/organizations/:organizationId/...`), never in the JWT or session, and is re-resolved from the database on every request (organization existence, `ACTIVE` status, then the caller's `ACTIVE` membership) rather than cached anywhere. All three failure reasons (organization missing, suspended, or caller not a member) produce a byte-identical generic 403, so none can be enumerated. This costs one extra indexed read per organization-scoped request compared to `authenticate()`'s stateless JWT verification — an accepted, necessary tradeoff, since authorization must reflect a revoked membership immediately, unlike pure authentication's bounded staleness.

## ADR-018 — Last-Owner Protection via an Atomically-Guarded Owner Counter
**Status:** Accepted

`Organization.activeOwnerCount` is a denormalized counter, mutated only through a guarded `findOneAndUpdate` (`{activeOwnerCount: {$gt: 1}}` → `$inc: -1`) rather than a "count documents, then decide, then write" sequence — even inside a multi-document transaction, the latter does not prevent a write-skew race where two concurrent operations each target a *different* one of two owners and each independently observes "2 owners, safe to proceed." Routing every owner-count change through one shared counter field forces MongoDB's single-document write serialization to arbitrate the race, proven by a dedicated concurrency test covering exactly that two-different-owners scenario.

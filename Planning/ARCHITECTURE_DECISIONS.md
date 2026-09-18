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

## ADR-019 — Single Append-Only AuditEvent Collection, Written Post-Commit, Best-Effort
**Status:** Accepted

Audit/security-event infrastructure (SEC-003) uses exactly one MongoDB collection, `AuditEvent`, with a repository that exposes only `create()` — no `SecurityEvent` collection, no update/delete path, ever. A security-relevant event (e.g. refresh-token reuse) is simply an `AuditEvent` with `severity: 'WARNING'`, not a member of a second, parallel structure — there is no distinct query pattern yet that would justify one, the same reasoning ADR-016 already applied to not building a separate `Role`/`Permission` collection. For the transactional operations that produce audit events (`createOrganization`, `changeRole`, `removeMember`), the audit write happens strictly *after* the surrounding `withTransaction()` call resolves, never inside its callback — MongoDB's automatic retry of that callback on a transient error could otherwise duplicate a non-idempotent "record one event" write, unlike the transaction's own guarded counter operations, which are safe to re-run. Audit writes are best-effort and non-blocking throughout: `audit.service.ts`'s `record()` never throws, so an audit-subsystem failure can never fail the sensitive operation (login, logout, an organization mutation) that triggered it — audit durability is intentionally subordinate to the availability of the security-critical action itself.

## ADR-020 — Product References Category and Brand: Organization-Scoped Validation, No Archived-Reference Cascade
**Status:** Accepted

Product's `categoryId` and `brandId` (both optional; `categoryId` is a single reference, not multi-category) are validated by the same pattern Category's own `parentId` already established for CAT-001: re-fetch the referenced document scoped by `organizationId` (a cross-organization reference is indistinguishable from nonexistent — never trusted from a syntactically valid ObjectId alone) and reject the reference if the target is `ARCHIVED`. This resolves the open question CAT-002's own documentation explicitly deferred to CAT-003 ("whether CAT-003 allows a Product to reference an archived Brand"). Symmetrically with `ADR-011`'s "archiving never cascades" principle: if a Category or Brand already referenced by an existing Product is archived *afterward*, the Product is never retroactively modified, cascaded, or auto-archived — the reference simply persists, and any resulting display/business decision is left to a future task. `assertValidCategory`/`assertValidBrand` remain two small, separate functions in `product.service.ts` rather than a generic `assertValidReference<T>` abstraction, consistent with this project's standing avoidance of premature generic abstractions for only two concrete call sites.

## ADR-021 — ProductVariant Identity, SKU Uniqueness, and Attribute Safety
**Status:** Accepted

CAT-004 (`ProductVariant`) extends the Category/Brand/Product reference-validation and no-cascade patterns to a child-to-parent (`productId`) relationship instead of a self-reference or sibling cross-reference: `assertValidProduct` re-fetches the target Product scoped by `organizationId` and rejects if missing, cross-organization, or `ARCHIVED` — a Variant cannot be newly created under an archived Product, but a Product archived *afterward* never cascades onto its existing Variants (`ADR-011`/`ADR-020`'s no-cascade principle, extended a third time). `productId` is required and immutable — absent from the update schema entirely, not merely nullable — since moving a Variant to a different Product is really a new variant identity.

`sku` is the Variant's own identity: required, unique per `{organizationId, sku}` (not platform-wide — a cross-organization SKU collision must never be possible, consistent with `ADR-002`/`ADR-009`'s tenant-isolation principle), normalized to uppercase after trimming *before* any duplicate check or persistence, so `"sku-1"` and `"SKU-1"` cannot coexist as distinct values. Unlike `slug`, there is no auto-generation — a Variant has no free-text `name` field to derive one from, so `sku` is always caller-supplied. The database's unique index remains the ultimate concurrency guarantee (proven by a concurrent-create race test identical in shape to Product's own); an `existsWithSku` pre-check exists only to produce a friendlier error, not as the actual guarantee.

`barcode` is optional, unique per `{organizationId, barcode}` among Variants that actually have one — enforced via a **partial** index (`partialFilterExpression: {barcode: {$exists: true}}`), the same technique `organization-membership.model.ts` already uses for its own status-scoped uniqueness. A plain `sparse: true` index was tried first and found, via a failing test, not to behave as intended: on a **compound** index, `sparse` only excludes a document missing *every* indexed field, and `organizationId` is always present, so it never excluded a barcode-less Variant — two such Variants collided on `barcode: null` until the index was corrected to a partial filter. No digits-only or checksum/symbology (UPC/EAN) validation is enforced — deferred to a future scanning/inventory task.

`price` (required), `compareAtPrice` and `cost` (both optional) reuse the existing `ADR-008` integer-minor-units convention (`Number`, not `Decimal128`) — this is not new financial architecture, only its first real application. No relational constraint between `compareAtPrice` and `price` is enforced yet (an inverted value is currently accepted) and no `currency` field exists on Variant — both explicitly deferred: no per-organization currency setting exists anywhere in the codebase yet, and inventing one field-first without that backing setting would be a half-implemented feature.

`attributes` is an array of `{key: string, value: string | number | boolean}` pairs, deliberately not `Record<string, unknown>` — a dynamic-object-key shape risks prototype pollution (`{"__proto__": {...}}`) and cannot be meaningfully typed per key. The array-of-pairs shape never uses a key's *content* as an actual object property name anywhere in this codebase, which structurally rules out prototype pollution regardless of what string a caller sends; `__proto__`/`constructor`/`prototype` are additionally blocked as key *values* as an explicit belt-and-suspenders layer. Keys are restricted to an allowlist (letters/digits/space/hyphen/underscore), which also excludes MongoDB's special `$`/`.` characters, on top of the platform-wide `sanitizeFilter: true` already active since DB-001. Values reject `null`, arrays, and nested objects. Duplicate keys (case-insensitive) are rejected; the array is capped at 30 items and carries no index, matching this project's standing discipline of not adding a speculative index before a real query pattern needs one.

Lifecycle (`DRAFT | ACTIVE | ARCHIVED`) keeps the same unrestricted transition behavior Category/Brand/Product already have, including an `ARCHIVED → ACTIVE` "resurrection" via ordinary update — kept consistent across all four catalog entities rather than introducing a stricter, Variant-only state machine. No inventory placeholder field, no variant-specific media, and no variant display name/title exist on `ProductVariant` — all explicitly deferred, not oversights. `product.model.ts` and its sibling files gain no `variantIds`/`hasVariants`/`defaultVariantId` field — the child (`ProductVariant.productId`) holds the pointer, not the parent.

## ADR-022 — Inventory Engine: Ledger/Balance Split, Atomic Guarded Mutation, Dedicated Transfer Operation
**Status:** Accepted

INV-001 introduces a new `inventory` module with three collections rather than one, deliberately splitting the append-only history from the fast-read aggregate: `Location` (an organization's stock-keeping location, `ACTIVE|ARCHIVED` only — no `DRAFT`, since a location is either usable or decommissioned, not "authored" the way a catalog entity is), `StockBalance` (one materialized row per `{organizationId, locationId, variantId}`, the unique key in all but name), and `InventoryTransaction` (an append-only ledger, `create()`+`list()` only, no update/delete, mirroring `AuditEvent`'s single-purpose-collection shape from `ADR-019`).

`StockBalance.quantityOnHand` is never directly patchable — the repository exposes exactly two named atomic operations instead of a general-purpose `update()`: `incrementOrCreate` (a single `findOneAndUpdate` with `upsert: true`, never "check existence then decide insert-or-update" in application code) and `decrementIfSufficient` (a guarded `findOneAndUpdate` whose filter itself includes `quantityOnHand: {$gte: amount}`, never a separate "read balance, check in code, then write" sequence). This directly extends `ADR-018`'s atomic-guarded-counter pattern (`Organization.activeOwnerCount`) to a new domain, and is this project's first foundation-layer application of that pattern outside SEC-002. Both operations require an active `ClientSession` — a balance can only ever change as part of the single `withTransaction()` that also writes the corresponding `InventoryTransaction`, so the ledger and the balance cannot drift out of sync by construction, not merely by convention.

`recordTransfer()` is a dedicated service operation, not two independent `recordTransaction()` calls — moving stock between two locations as separate outbound-then-inbound transactions could leave a `TRANSFER_OUT` applied with no matching `TRANSFER_IN` (or vice versa) if the second call failed independently. The entire transfer — source decrement, destination increment-or-create, and both ledger entries — runs inside one `withTransaction()`; an insufficient-stock failure rolls back all of it, proven by a dedicated test showing zero ledger entries and unchanged balances on both sides afterward. `TRANSFER_IN`/`TRANSFER_OUT` are valid stored transaction types but are rejected as direct input to `recordTransaction()` — they can only be produced by `recordTransfer()`.

`ADJUSTMENT` requires an explicit `adjustmentDirection: INCREASE | DECREASE` — a bare "unsigned quantity, type implies direction" mapping (sufficient for `PURCHASE`/`RETURN`/`OPENING_BALANCE` inbound and `SALE`/`DAMAGE` outbound) is not sufficient for `ADJUSTMENT` alone, since a stock correction can legitimately go either direction. This is enforced at the Zod layer (`superRefine`, the actual guarantee) and, as defense-in-depth, at the Mongoose layer via a conditional `required` function for the "must be present" half — a plain custom path validator does not get invoked by Mongoose when a path's value is `undefined`, which was discovered as a real gap during implementation testing and corrected before this was committed, not left as a known issue.

Negative inventory is prevented unconditionally (CLAUDE.md §6.3) — no `allowNegative`/backorder configuration exists anywhere in this task; every outbound stock change goes through `decrementIfSufficient`'s guarded filter. Full multi-location support, including `TRANSFER_IN`/`TRANSFER_OUT`, is built now rather than deferred to a later task, since the task's own description explicitly names "Locations" (plural) and CLAUDE.md §6.3 names both transfer types by name — this is existing evidence, not an invented requirement.

No `SEC-003` `AuditEvent` integration exists in this module — `InventoryTransaction` is this task's own complete, sufficient audit trail for stock changes, consistent with every catalog module's identical "no audit wiring until a route layer exists" reasoning. No forward-looking foreign key (`sourceType`/`sourceId`/`orderId`/`purchaseId`/`supplierId`/`saleId`) was added to `InventoryTransaction` — a future business workflow (`BUS-001` purchase receiving, `COM-004` order fulfillment) calling `recordTransaction()`/`recordTransfer()` repeatedly may eventually need an idempotency/reference mechanism to prevent a retried business operation from creating a duplicate inventory movement, but that is explicitly deferred rather than solved speculatively here.

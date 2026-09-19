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

## ADR-023 — Customer Is a Global (Non-Organization-Scoped) Entity Referencing User, With a Transactional Default-Address Guarantee
**Status:** Accepted

CUST-001 introduces a new `customers` module (`Customer`, `Address`) that deliberately carries **no `organizationId`** on either collection — unlike every catalog/inventory entity so far (`CAT-001`–`004`, `INV-001`), all of which depend on `SEC-002` and are organization-owned. `CUST-001` depends only on `SEC-001` per `MASTER_TASK_LIST.xlsx`, and `User` (SEC-001) itself already carries no `organizationId` — organization membership is a separate join collection (`OrganizationMembership`), not a `User` field. Making `Customer` global rather than organization-scoped follows this existing precedent directly and matches the platform's stated future marketplace direction: a single customer identity interacting with multiple seller organizations, rather than one customer record duplicated per organization. `Customer.userId` is required and unique (1:1 with `User`), following the same dependent-entity-holds-the-foreign-key direction used everywhere else in this codebase (`OrganizationMembership.userId`, `ProductVariant.productId`); `user.model.ts` is not modified — no `customerId` field was added to `User`.

`Customer.status` (`ACTIVE|ARCHIVED`) and `Address` default flags (`isDefaultBilling`/`isDefaultShipping`) are deliberately **excluded from their respective general-purpose update schemas** — a departure from the catalog modules' convention of allowing `status` through the general `PATCH`. Lifecycle changes go only through dedicated `archiveCustomerProfile`/`restoreCustomerProfile`/`archiveAddress` functions, and default-address changes go only through `setDefaultAddress`, closing off any path where a routine field edit could silently grant archival or default status as a side effect.

At most one default billing and one default shipping address per customer is enforced by a **partial unique index** on each flag (`{customerId, isDefaultBilling: true}` / `{customerId, isDefaultShipping: true}`) — the same technique already used three times (`organization-membership.model.ts`, CAT-004's barcode, INV-001's location code). Switching the default additionally runs inside **one `withTransaction()`** (verify ownership and `ACTIVE` status, unset the existing default, set the new one) rather than as two independent writes — an explicit, approved requirement distinct from this project's usual "let the unique index be the only guarantee" pattern, because the intended behavior specifically requires the ownership/status check and both writes to be atomic together, not merely to avoid ending up with two simultaneous defaults. The partial unique indexes remain an additional, database-level invariant on top of the transaction, not a replacement for it.

`customers` is also the first module since `SEC-001`/`SEC-002` to introduce an HTTP route layer, unlike the catalog/inventory foundation tasks' consistent deferral — justified because `authenticate()` is already live and a customer managing their own profile/addresses is inherently a self-service, authenticated end-user flow with an immediate real consumer, not a business-management primitive with no HTTP surface yet. Every route resolves identity exclusively from `req.auth.userId`; no route, service, or repository function anywhere in this module accepts a client-supplied `userId`/`customerId` for authorization purposes.

**Resolved (DEC-007 addendum, CHG-013)**: the `customer.archived`/`customer.restored` audit-wiring conflict noted below was resolved by a small, additive extension to `AUDIT_ACTIONS`/`AUDIT_ENTITY_TYPES` in `modules/audit/models/audit-event.model.ts` — `customer.archived`, `customer.restored`, and the `Customer` entity type, an 8-line change touching no existing action, entity type, or behavior. `customer.service.ts`'s `archiveCustomerProfile`/`restoreCustomerProfile` now call `audit.service.ts`'s existing `record()` after the archive/restore genuinely succeeds (never on a `NotFoundError` path), with `actorUserId` set to the authenticated `userId` (self-service — the customer is always their own actor) and `entityId` the `Customer._id` — the same best-effort, non-blocking, `SUCCESS`/`INFO` conventions every other audited action already uses. Ordinary profile/address CRUD and address archive/restore remain deliberately unaudited, per the original CUST-001 scope. `logger` was added as an *optional* trailing parameter to these two functions specifically (mirroring `auth.service.ts`'s own precedent for the same reason) so every pre-existing call site continues to work unchanged.

Original gap (superseded by the resolution above, kept for history): the approved `customer.archived`/`customer.restored` audit events were initially **not implemented** — wiring them required adding new entries to `AUDIT_ACTIONS`/`AUDIT_ENTITY_TYPES` in a SEC-003 file, which conflicted with CUST-001's own explicit "do not modify SEC-003" boundary. This was recorded in `OPEN_DECISIONS.md` (`DEC-007`) rather than resolved unilaterally, and has since been explicitly approved and implemented as described above.

## ADR-022 — Inventory Engine: Ledger/Balance Split, Atomic Guarded Mutation, Dedicated Transfer Operation
**Status:** Accepted

INV-001 introduces a new `inventory` module with three collections rather than one, deliberately splitting the append-only history from the fast-read aggregate: `Location` (an organization's stock-keeping location, `ACTIVE|ARCHIVED` only — no `DRAFT`, since a location is either usable or decommissioned, not "authored" the way a catalog entity is), `StockBalance` (one materialized row per `{organizationId, locationId, variantId}`, the unique key in all but name), and `InventoryTransaction` (an append-only ledger, `create()`+`list()` only, no update/delete, mirroring `AuditEvent`'s single-purpose-collection shape from `ADR-019`).

`StockBalance.quantityOnHand` is never directly patchable — the repository exposes exactly two named atomic operations instead of a general-purpose `update()`: `incrementOrCreate` (a single `findOneAndUpdate` with `upsert: true`, never "check existence then decide insert-or-update" in application code) and `decrementIfSufficient` (a guarded `findOneAndUpdate` whose filter itself includes `quantityOnHand: {$gte: amount}`, never a separate "read balance, check in code, then write" sequence). This directly extends `ADR-018`'s atomic-guarded-counter pattern (`Organization.activeOwnerCount`) to a new domain, and is this project's first foundation-layer application of that pattern outside SEC-002. Both operations require an active `ClientSession` — a balance can only ever change as part of the single `withTransaction()` that also writes the corresponding `InventoryTransaction`, so the ledger and the balance cannot drift out of sync by construction, not merely by convention.

`recordTransfer()` is a dedicated service operation, not two independent `recordTransaction()` calls — moving stock between two locations as separate outbound-then-inbound transactions could leave a `TRANSFER_OUT` applied with no matching `TRANSFER_IN` (or vice versa) if the second call failed independently. The entire transfer — source decrement, destination increment-or-create, and both ledger entries — runs inside one `withTransaction()`; an insufficient-stock failure rolls back all of it, proven by a dedicated test showing zero ledger entries and unchanged balances on both sides afterward. `TRANSFER_IN`/`TRANSFER_OUT` are valid stored transaction types but are rejected as direct input to `recordTransaction()` — they can only be produced by `recordTransfer()`.

`ADJUSTMENT` requires an explicit `adjustmentDirection: INCREASE | DECREASE` — a bare "unsigned quantity, type implies direction" mapping (sufficient for `PURCHASE`/`RETURN`/`OPENING_BALANCE` inbound and `SALE`/`DAMAGE` outbound) is not sufficient for `ADJUSTMENT` alone, since a stock correction can legitimately go either direction. This is enforced at the Zod layer (`superRefine`, the actual guarantee) and, as defense-in-depth, at the Mongoose layer via a conditional `required` function for the "must be present" half — a plain custom path validator does not get invoked by Mongoose when a path's value is `undefined`, which was discovered as a real gap during implementation testing and corrected before this was committed, not left as a known issue.

Negative inventory is prevented unconditionally (CLAUDE.md §6.3) — no `allowNegative`/backorder configuration exists anywhere in this task; every outbound stock change goes through `decrementIfSufficient`'s guarded filter. Full multi-location support, including `TRANSFER_IN`/`TRANSFER_OUT`, is built now rather than deferred to a later task, since the task's own description explicitly names "Locations" (plural) and CLAUDE.md §6.3 names both transfer types by name — this is existing evidence, not an invented requirement.

## ADR-024 — Wishlist/Back-In-Stock: Organization-Scoped Requests From a Global Customer, No Notification Delivery in COM-001
**Status:** Accepted

COM-001 introduces a new `wishlist` module with two separate collections — `WishlistItem` and `BackInStockRequest` — rather than one collection with a flag, since a customer can wishlist an in-stock item with no notification need, and can request a back-in-stock notification without ever wishlisting the item; the two concerns have independent lifecycles and independent uniqueness rules. This mirrors the same "related but independently-lifecycled" split `ADR-023` already established for `Customer`/`Address`.

Both collections carry `organizationId`, even though `Customer` (`ADR-023`) is global — a `ProductVariant` reference is only meaningful within a specific organization's catalog, so the relationship being recorded genuinely spans both a global customer and an organization-owned variant. The client-supplied `organizationId` is **never trusted as authorization**: it is validated read-only (exists + `ACTIVE`) via `organizations`' existing `organizationRepository.findById()`, deliberately **not** SEC-002's membership-based `resolveOrganizationContext`/`requirePermission` — customers are not organization members, and building a parallel authorization mechanism for them was explicitly avoided. The actual authoritative tenant check is `ProductVariant.findById(organizationId, variantId)` itself (already established by `CAT-004`): since that lookup filters by `{_id, organizationId}` together, a variant genuinely belonging to a different organization is indistinguishable from nonexistent, regardless of what the client claimed.

Both collections are soft-deleted (`WishlistItem`: `ACTIVE|ARCHIVED`; `BackInStockRequest`: `PENDING|CANCELLED`), so neither uses a plain `{customerId, variantId}`-shaped unique index — that would permanently block a customer from ever re-adding or re-requesting the same variant after removal/cancellation. Instead, each uses a **partial** unique index scoped to the "currently active" status value only (`status: 'ACTIVE'` for `WishlistItem`; `status: 'PENDING'` for `BackInStockRequest`) — the same technique already proven for organization-membership's status-scoped uniqueness, `CAT-004`'s barcode, `INV-001`'s location code, and `CUST-001`'s default-address flags. Both are proven correct under genuine concurrency by a dedicated race test, not merely an application-level pre-check.

A `BackInStockRequest` may only be created when the **sum of `StockBalance.quantityOnHand` across every location** for `{organizationId, variantId}` is zero — a customer doesn't pick a warehouse, so this is deliberately not a per-location check. This reuses `INV-001`'s existing, unmodified `stock-balance.repository.ts`'s `list()` as a plain read; it is **not** wrapped in a transaction with the request write, accepting a small TOCTOU window as an explicit tradeoff rather than inventing reservation/backorder behavior this task doesn't need. `{organizationId, variantId, status}` is indexed on `BackInStockRequest` specifically because it is the exact query a future notification-dispatch task will need — forward-justified by the feature's own stated purpose, not speculative.

**Notification delivery and `FULFILLED` are explicitly out of scope.** The task's own acceptance wording is "saved and *requested*," not "sent"; `OPEN_DECISIONS.md`'s `DEC-003`/`DEC-004` (email/SMS provider) remain unresolved and no queue infrastructure exists. `BackInStockRequest.status` is `PENDING | CANCELLED` only — adding `FULFILLED` now would imply a detection mechanism (either hooking `INV-001`'s transaction-recording functions or a scheduled job) that this task deliberately does not build.

This is the **second** module (after `CUST-001`) to add a self-service HTTP route layer, for the same reason: `authenticate()` is already live, and a customer managing their own wishlist/requests is inherently an end-user flow with an immediate consumer. One real implementation defect was found and fixed during testing: the router is mounted with no path prefix (mirroring `healthRouter`/`readyRouter`, since its routes already define top-level `/wishlist` and `/back-in-stock-requests` paths), and an initial blanket `router.use(authenticate)` incorrectly intercepted *every* request reaching the router — including genuinely unmatched, unrelated paths — turning what should have been a 404 into a 401. Caught by the pre-existing `health.route.test.ts` regression test and corrected by scoping the middleware to the router's own two path prefixes. No `SEC-003` audit wiring exists for wishlist/back-in-stock actions — routine, high-volume self-service CRUD, analogous to `CUST-001`'s own unaudited address CRUD, not an account-lifecycle event; `DEC-007` is not reopened.

No `SEC-003` `AuditEvent` integration exists in this module — `InventoryTransaction` is this task's own complete, sufficient audit trail for stock changes, consistent with every catalog module's identical "no audit wiring until a route layer exists" reasoning. No forward-looking foreign key (`sourceType`/`sourceId`/`orderId`/`purchaseId`/`supplierId`/`saleId`) was added to `InventoryTransaction` — a future business workflow (`BUS-001` purchase receiving, `COM-004` order fulfillment) calling `recordTransaction()`/`recordTransfer()` repeatedly may eventually need an idempotency/reference mechanism to prevent a retried business operation from creating a duplicate inventory movement, but that is explicitly deferred rather than solved speculatively here.

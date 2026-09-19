# Wishlist Module — WishlistItem, BackInStockRequest (COM-001)

This module implements COM-001: "Wishlist and back-in-stock notification
requests." It depends on `CAT-004` (`ProductVariant`) and `CUST-001`
(`Customer`), both `COMPLETED`.

## Why two separate collections

`WishlistItem` and `BackInStockRequest` are deliberately separate
collections, not one collection with a flag. A customer can wishlist an
in-stock item with no notification need, and can request a back-in-stock
notification for a variant without ever adding it to their wishlist — the
two concerns have independent lifecycles (`ACTIVE|ARCHIVED` vs.
`PENDING|CANCELLED`) and independent uniqueness rules. This mirrors the
same "related but independently-lifecycled" split `CUST-001` already
established for `Customer`/`Address`.

## Organization / customer relationship

`ProductVariant` is organization-owned; `Customer` (`CUST-001`) is global.
Both `WishlistItem` and `BackInStockRequest` carry `organizationId` because
they mediate between the two — a variant reference is only meaningful
within a specific organization's catalog. **The client-supplied
`organizationId` is never trusted as authorization.** It is validated
read-only (exists + `ACTIVE`) via `organizations`' existing
`organizationRepository.findById()` — **not** SEC-002's
`resolveOrganizationContext`/`requirePermission` middleware, which requires
an `OrganizationMembership` that customers never have. The actual
authoritative tenant check is `ProductVariant.findById(organizationId,
variantId)` itself: since that lookup filters by `{_id, organizationId}`
together, a variant genuinely belonging to a different organization is
indistinguishable from nonexistent, regardless of what the client claimed.

## Partial unique indexes (not plain unique — both collections are soft-deleted)

- `WishlistItem`: `{customerId, variantId}` unique **where `status:
'ACTIVE'`**. A plain (non-partial) unique index would permanently block a
  customer from ever re-adding a variant they'd previously removed — soft
  deletion means the removed row still exists as an `ARCHIVED` document, so
  the uniqueness constraint must only apply to the currently-active row.
- `BackInStockRequest`: `{customerId, variantId, status}` unique **where
  `status: 'PENDING'`** — same reasoning; a `CANCELLED` request never
  blocks a new `PENDING` one for the same pair.

Both proven by a dedicated test: create → archive/cancel → re-add/re-request
succeeds, and a genuine concurrent-create race for the same key resolves to
exactly one success (the database index is the actual guarantee, not an
application-level pre-check).

## Stock semantics

A variant is "in stock" when the **sum of `StockBalance.quantityOnHand`
across every location** for `{organizationId, variantId}` is greater than
zero — a customer doesn't pick a warehouse, so this is deliberately not a
per-location check. `BackInStockRequest` creation rejects when this sum is
`> 0`. The check reuses `INV-001`'s existing, **unmodified**
`stock-balance.repository.ts`'s `list()` function (a plain read, paged at a
pragmatic 1000-row bound) rather than adding a new aggregate function to
INV-001 itself. This is a **plain read, not a transaction** with the
request write — a small TOCTOU window (stock could change between the
check and the insert) is explicitly accepted; this module invents no
reservation/backorder behavior. `WishlistItem` creation has no stock
requirement at all — wishlisting an in-stock variant is normal.

## Why notification delivery is deferred

The acceptance criterion is "saved and **requested**," not "sent." No
email/SMS provider is selected yet (`OPEN_DECISIONS.md` `DEC-003`/`DEC-004`
remain `OPEN`) and no queue infrastructure (Redis/BullMQ) exists in this
codebase. Building delivery now would mean inventing infrastructure ahead
of those decisions. `{organizationId, variantId, status}` is indexed on
`BackInStockRequest` specifically because it's the exact query a future
notification-dispatch task will need ("who is waiting for variant X") —
forward-justified by the feature's own purpose, not speculative.

## Why FULFILLED is deferred

Detecting that a variant has come back into stock and marking pending
requests `FULFILLED` would require either hooking into `INV-001`'s
`recordTransaction`/`recordTransfer` (modifying a completed, independently
security-reviewed module without a justified reason) or a scheduled/polling
job (infrastructure that doesn't exist). `BackInStockRequest.status` is
`PENDING | CANCELLED` only in this task; a future task can add `FULFILLED`
additively once real delivery infrastructure exists.

## Security / IDOR boundary

Every repository function in this module requires `customerId` as a
mandatory parameter, the same IDOR-prevention convention every other
module uses. `req.auth.userId` is the only identity source at the route
layer — `resolveCustomerId()` (in `services/shared-validation.ts`) resolves
it to a `Customer._id` via `customers`' own repository (read-only reuse,
not its service layer), and every subsequent call uses that resolved id,
never a client-supplied `customerId`/`userId`. Cross-customer access
produces a generic `NotFoundError` (404), identical whether the target
belongs to another customer or doesn't exist at all — no enumeration.

An **archived customer** can still read their existing wishlist/requests
but cannot create or archive/cancel anything — `assertCustomerActive()`
(shared-validation.ts) is checked at the start of every mutating service
function, mirroring `customers/services/address.service.ts`'s own
`assertCustomerActive` exactly.

## Lifecycle / no cascade

Archiving a `WishlistItem`, cancelling a `BackInStockRequest`, archiving a
`Customer`, or archiving a `ProductVariant` never cascades onto anything
else in this module. A new `WishlistItem`/`BackInStockRequest` cannot be
created against an already-`ARCHIVED` variant, but an existing record is
never touched if its variant is archived afterward — the same no-cascade
principle already established repeatedly (`ADR-011`/`020`/`021`/`022`).

## No SEC-003 audit wiring

Wishlist add/remove and back-in-stock request create/cancel are routine,
high-volume, self-service actions — analogous to `CUST-001`'s own
(deliberately unaudited) address CRUD, not to an account-lifecycle event
like `customer.archived`. `DEC-007` is not reopened.

## Routes

Mounted with no path prefix in `routes/v1/index.ts` (the same convention
`healthRouter`/`readyRouter` use, since this router's own routes already
define their top-level paths):

```
GET    /api/v1/wishlist
POST   /api/v1/wishlist                          body: {organizationId, variantId}
DELETE /api/v1/wishlist/:id

GET    /api/v1/back-in-stock-requests
POST   /api/v1/back-in-stock-requests            body: {organizationId, variantId}
DELETE /api/v1/back-in-stock-requests/:id
```

**Implementation note**: `authenticate` is applied via `router.use(['/wishlist',
'/back-in-stock-requests'], authenticate)`, not a blanket `router.use(authenticate)`.
Since this router is mounted with no prefix, a blanket call would have
intercepted _every_ request that reaches it in the middleware chain —
including a completely unrelated, genuinely unmatched path — and returned
401 instead of letting it fall through to the app's real 404 handler. This
was caught by the existing `health.route.test.ts` regression test
("unmatched route returns the standardized 404 envelope") during
validation and fixed before this module was considered complete.

No staff/admin route, no organization-membership requirement, no
notification-sending endpoint of any kind.

## Testing

All test files use a standalone `mongodb-memory-server` (`MongoMemoryServer`)
— no `withTransaction()` is used anywhere in this module, so no replica set
is needed even for the route-level tests (a simplification relative to
`CUST-001`, which needed one for `setDefaultAddress`).

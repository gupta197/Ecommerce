# Cart Module — Cart, CartItem (COM-002)

This module implements COM-002: "Cart lifecycle and server-side pricing
validation." It depends on `INV-001` (`StockBalance`, read-only) and
`CUST-001` (`Customer`), both `COMPLETED`. `CAT-004` (`ProductVariant`) is
required transitively (a `CartItem` references it directly) but is not a
declared direct dependency in `MASTER_TASK_LIST.xlsx`.

## Domain model: one Cart per customer per organization

`Customer` (`CUST-001`) is global; `ProductVariant` (`CAT-004`) is
organization-owned. A `Cart` therefore carries `organizationId` and is keyed
uniquely by `{customerId, organizationId}` — a customer can have one
independent Cart per organization they shop with, but a single Cart can
never span multiple organizations (every item add validates its variant
against the Cart's own fixed `organizationId`). This avoids inventing
multi-seller cart/checkout-splitting complexity (CLAUDE.md §2) while
remaining forward-compatible with a future marketplace phase, where each
seller naturally gets its own independent cart.

## No price/name/SKU snapshot on CartItem

`CartItem` stores only `{cartId, organizationId, variantId, quantity}`.
Every read (`GET /cart`) resolves the **current** `ProductVariant.price`
(and `Product.name`/`ProductVariant.sku` for display) live, and computes
`subtotal`/`total` fresh on every call — never a snapshot captured at
add-time. This is required, not incidental: the acceptance criterion is
"Cart totals are server-authoritative," which only holds if a total always
reflects the current, real price. A **future Order** (`COM-004`) is exactly
the opposite: it needs an immutable snapshot of what was actually charged,
for traceability — that responsibility belongs to Checkout/Order, not Cart.

## CartItem is a separate collection, hard-deleted

Consistent with every other module in this codebase (`Address`,
`WishlistItem`, `BackInStockRequest`): a real per-item uniqueness constraint
(`{cartId, variantId}` unique) and independent CRUD both favor a separate
collection over an embedded array. Unlike those other collections, however,
**`CartItem` removal is a hard delete**, not a soft one — a cart item has no
history value once removed (nobody needs an audit trail of what used to be
in an active shopping cart). This also means the uniqueness index can be a
**plain** unique index rather than a partial one: once a row is removed it
is genuinely gone, so re-adding the same variant later never collides with
a stale soft-deleted row.

## The 9999 ceiling is enforced atomically, never read-then-write

`POST /cart/items` must reject `existingQuantity + requestedQuantity > 9999`
without ever reading the current quantity, computing a new value in
application code, and writing it back — that sequence is a concurrency race
the ceiling could be bypassed through. `cart-item.repository.ts`'s
`incrementOrCreate` instead performs a single `findOneAndUpdate` whose
**filter itself** encodes the ceiling (`quantity: {$lte: MAX - amount}`),
combined with `$inc` and `upsert: true` so the same atomic call both
creates a brand-new item (when none exists) and increments an existing one
(when the result would stay within the ceiling). When an existing item is
already too close to the ceiling to accept the requested amount, the
upsert's insert attempt collides with the `{cartId, variantId}` unique
index and throws a duplicate-key error — not a bug, but how this function
detects "limit exceeded" without a separate read. The catch retries as a
plain conditional increment for the genuine-race case, and reports
`limitExceeded: true` (no write performed) if that also fails to match.

`PATCH /cart/items/:id` (replace) only needs the schema-level `1..9999`
bound, since it sets an exact value rather than adding to one — no
concurrent-race ceiling bypass is possible for a plain replace.

## GET must never create a Cart

`GET /cart?organizationId=X` and `DELETE /cart?organizationId=X` (clear)
both use `cartRepository.findByCustomerAndOrganization()`, a read-only
lookup — if no `Cart` document exists yet, they return an empty-cart view
rather than creating one. `cartRepository.findOrCreate()` (an atomic
upsert-find) is called **only** from `addCartItem` — the only path that
should ever bring a `Cart` document into existence.

## Organization / variant relationship (same pattern as COM-001)

The client-supplied `organizationId` is **never trusted as authorization**.
It is validated read-only (exists + `ACTIVE`) via `organizations`' existing
`organizationRepository.findById()` — **not** SEC-002's
`resolveOrganizationContext`/`requirePermission` middleware, since customers
are not organization members. The actual authoritative tenant check is
`ProductVariant.findById(organizationId, variantId)` itself: a variant
genuinely belonging to a different organization is indistinguishable from
nonexistent, regardless of what the client claimed — proven by a dedicated
cross-org-variant-rejection test at both the service and route layers.

## Archived variant behavior

| Operation                                       | Behavior                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /cart/items` (new add)                    | Rejected — a new `CartItem` can never reference an `ARCHIVED` variant.                                      |
| Existing `CartItem`, variant archived afterward | No cascade — the item is never touched automatically.                                                       |
| `PATCH /cart/items/:id`                         | Rejected — a quantity edit implies continued purchase intent for something no longer in the active catalog. |
| `DELETE /cart/items/:id`                        | Always allowed, unconditionally.                                                                            |
| `GET /cart`                                     | The item stays visible, flagged via `variantStatus` — never hidden.                                         |

## Inventory: Cart is not a reservation system

Cart never mutates `StockBalance` and never reserves inventory. Adding an
out-of-stock variant is allowed; quantity is never capped by current stock.
`GET /cart` includes an informational `inStock` flag per item (aggregate
`StockBalance.quantityOnHand` across all locations, reusing `INV-001`'s
existing, **unmodified** `stock-balance.repository.ts` `list()` — the same
technique `COM-001` already established), purely for display. Authoritative
inventory validation belongs to a future Checkout (`COM-003`).

## Security / IDOR boundary

Identity always comes from `req.auth.userId` via `resolveCustomerId()`,
never a client-supplied `customerId`/`cartId`. `CartItem` carries no
`customerId` of its own (by design — see the schema above), so item-level
`PATCH`/`DELETE /cart/items/:id` resolve ownership in two steps: look up the
item by `_id` alone, then verify its `cartId` belongs to a `Cart` owned by
the caller (`cartRepository.findById(customerId, item.cartId)`). Both
"item does not exist" and "item belongs to another customer" produce an
identical generic `NotFoundError` (404) — no enumeration, the same
convention every other module uses.

## No SEC-003 audit wiring, no Cart lifecycle/status field

Cart add/update/remove/clear are routine, high-volume self-service actions
— the same category already excluded for `wishlist`'s add/remove and
`CUST-001`'s address CRUD. `Cart` has no `status` field in this task: no
concrete state transition exists yet (a future `COM-003` `CHECKED_OUT`-style
transition can be added additively when it is actually needed).

## Routes

Mounted under a `/cart` prefix in `routes/v1/index.ts` (the same convention
`customers`/`organizations` use — deliberately **not** `wishlist`'s
no-prefix convention, so a blanket `router.use(authenticate)` here is safe:
every request reaching this router has already been matched to start with
`/cart` by the parent router):

```
GET    /api/v1/cart?organizationId=X
POST   /api/v1/cart/items                  body: {organizationId, variantId, quantity}
PATCH  /api/v1/cart/items/:id              body: {quantity}
DELETE /api/v1/cart/items/:id
DELETE /api/v1/cart?organizationId=X
```

No "list all my carts across every organization" endpoint — not required
by the acceptance criteria and low-value in the current single-business
phase; explicitly deferred, not an oversight.

## Testing

All test files use a standalone `mongodb-memory-server` (`MongoMemoryServer`)
— no `withTransaction()` is used anywhere in this module, so no replica set
is needed even for the route-level tests.

See `ADR-025` for the full architectural record.

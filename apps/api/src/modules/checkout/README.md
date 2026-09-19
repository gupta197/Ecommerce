# Checkout Module — Preview, Confirm, Order Creation (COM-003)

This module implements COM-003: "Checkout preview and order creation." It
depends on `COM-002` (`Cart`) per `MASTER_TASK_LIST.xlsx`; `CAT-004`
(`ProductVariant`), `INV-001` (`StockBalance`), `CUST-001` (`Customer`,
`Address`) and `SEC-001` are all required transitively but are not COM-003's
own direct dependency.

## Preview and confirm are two operations, not one

The task's own title is "Checkout **preview and order creation**" — two
distinct nouns. `POST /api/v1/checkout/preview` is a read-only operation:
it runs the exact same validation and pricing walk as confirmation but
creates nothing and modifies nothing. `POST /api/v1/checkout` runs that
same walk again (current data can have changed in between — see "Price
change behavior" below) and, only if it still passes, creates the `Order`
and clears the `Cart`. Both routes share one internal pricing/validation
function (`priceCartItems`) so the two paths can never drift apart.

## COM-003 creates the Order — it is not COM-004's job

`COM-004` ("Order lifecycle, tracking, cancellation and returns") depends
on `COM-003` and is scoped to managing an **already-existing** Order's
state machine — not to creating the first one. COM-003's own roadmap
description literally includes "order creation," so this module writes
directly to a new, minimal `orders` module's `Order` collection (see that
module's own README) rather than deferring persistence to a later task.
COM-004 will extend `Order` **additively** (tracking fields, cancellation
reasons, return records, further status values) when it is approved.

## COM-003 validates inventory — it does not reserve or decrement it

Checkout reads the **aggregate** `StockBalance.quantityOnHand` across every
location for each variant (reusing `INV-001`'s existing, **unmodified**
`stock-balance.repository.ts`, the same technique COM-001/COM-002 already
established) and rejects if it's insufficient. **No `StockBalance` is ever
mutated and no `InventoryTransaction` is ever created by this module** —
proven by a dedicated test asserting both are unchanged after a successful
checkout. This is a deliberate boundary, not an oversight: `recordTransaction()`
(the only sanctioned mutation path) requires a specific `locationId`, and no
fulfillment-location-selection strategy exists anywhere in this codebase.
Actual stock commitment is left to whichever future step actually confirms
the sale (most plausibly tied to a payment webhook, once `COM-005` exists).

## Server-authoritative pricing, no snapshot in Cart, always a snapshot in Order

Every `ProductVariant.price` and `Product.name` is re-resolved **live** at
both `preview` and `confirm` — never trusted from `Cart`'s own (already
dynamically-computed, per `ADR-025`) totals, and never accepted from the
client. `subtotal`/`total` are computed with integer minor-unit arithmetic
(`ADR-008`), defensively validated as safe integers at every step
(`Number.isSafeInteger`) — a computed value that would exceed safe-integer
bounds is rejected outright rather than silently corrupted. Once an `Order`
is created, its `items` (`name`, `sku`, `price`, `quantity`, `subtotal`) are
a **frozen snapshot** — never re-resolved from the live catalog afterward.
This is the deliberate opposite of Cart's own always-dynamic pricing: an
active Cart must reflect current truth, but a placed Order must remain a
faithful record of what was actually agreed to.

## Price-change behavior: confirm always uses the current price, silently

If the price shown at `preview` has changed by the time the customer calls
`confirm`, **confirm uses the new price without rejecting** — there is no
price lock and no confirmation token. This is a deliberate, approved
product decision, not an oversight: the two-step preview/confirm design
already gives the frontend a natural point to show the customer an
up-to-date total immediately before they confirm.

## Address: shipping required, billing falls back to shipping

`shippingAddressId` is optional in the request; if omitted, the customer's
own `isDefaultShipping` + `ACTIVE` address is used. If neither exists,
checkout is rejected. `billingAddressId` is optional; if omitted, the
**resolved shipping address** is used as billing too. Every resolved
address is scoped by `customerId` (`addressRepository.findById(customerId,
id)`, already IDOR-safe) and must be `ACTIVE`; both are **snapshotted**
(fields copied) into the Order, never stored as a live reference — the
same immutability reasoning as pricing above, so an Order's shipping
details never silently change if the customer edits or removes the saved
Address afterward.

## Cart validation: all-or-nothing, no automatic cleanup

If the Cart doesn't exist, is empty, or contains an item whose variant is
no longer `ACTIVE`, **the entire checkout is rejected** — never a partial
checkout of only the valid items. Checkout never removes stale items from
the Cart itself; the customer must do that through COM-002's own
`DELETE /api/v1/cart/items/:id` and retry. A cross-organization `CartItem`
reference is re-validated defensively even though Cart's own COM-002
invariant already makes it unreachable through any public API.

## Atomicity: Order creation and Cart clearing are one transaction

`confirmCheckout` re-reads the Cart and its items **using the transaction's
own session**, computes the final snapshot, creates the `Order`, and
deletes the `CartItem`s — all inside one `withTransaction()`. If any step
fails, **everything rolls back**: no Order can exist with its Cart items
still present having been silently dropped, and no Cart-clearing can occur
without a matching Order. Proven by dedicated forced-failure tests
(a monkey-patched `OrderModel.create`/`CartItemModel.deleteMany` that
throws, verifying the other side of the pair never happened) — the same
lightweight, no-new-dependency monkey-patch-and-restore technique this
codebase already uses for `membership.service.test.ts`'s own
audit-write-failure tests.

Product/variant/stock reads inside the transaction's callback are plain
(non-session) reads via the existing, unmodified `catalog`/`inventory`
repositories — those modules cannot be modified in this task, and since
COM-003 never *writes* to `ProductVariant`/`StockBalance`, there is nothing
for those specific reads to need transactional consistency with beyond the
Cart/CartItem read and Order write, which genuinely are session-scoped.

### Why Cart/CartItem are read via their raw Mongoose models here

`cart.repository.ts`/`cart-item.repository.ts` (COM-002, a closed, completed
module this task must not modify) do not accept a `ClientSession` parameter.
`checkout.service.ts` therefore imports `CartModel`/`CartItemModel` directly
(already-public exports) for the specific session-scoped read-and-delete
`confirmCheckout` needs — read-only/delete-only, never a write of new Cart
data, and no cart/ file is touched.

## A natural (partial) idempotency guarantee — and its known limit

Because `confirmCheckout` reads and deletes `CartItem`s **inside** the same
transaction as Order creation, two genuinely concurrent `confirm` requests
for the same Cart race on those same documents: MongoDB detects the write
conflict, the losing transaction is automatically retried by the driver's
`session.withTransaction()` (the same mechanism `INV-001`'s own
`recordTransaction`/`recordTransfer` already rely on), and on retry it
re-reads the Cart, finds it empty, and correctly rejects — **never a
duplicate Order**. Proven by a dedicated concurrency test firing two
simultaneous confirms and asserting exactly one Order is created.

**This does not solve every idempotency scenario.** If the server commits
an Order successfully but the client loses the HTTP response (a network
timeout) and retries, that retry will see an already-empty Cart and receive
a "cart is empty" error rather than the original Order. **This is a known,
deliberately deferred limitation** — a full `Idempotency-Key` replay
mechanism was explicitly not built in COM-003 (no incomplete idempotency
system was introduced); it remains open for a later hardening pass or for
`COM-005`, where idempotency is that task's own named acceptance criterion.

## No SEC-003 audit event

No `checkout.completed`/`order.created` `AuditEvent` is added. The `Order`
document itself is the durable business record — CLAUDE.md's own list of
audit-worthy examples names "order **cancellation**" and "refund," not
plain order placement, and unlike a role change or a permission grant, an
Order's own existence and timestamp already constitute a permanent record
with no other trace to lose. `SEC-003` (`audit-event.model.ts`) is not
modified by this task.

## No Cart lifecycle/status field, no tax/discount/shipping

Cart still has no `status` field (`ADR-025` stands unchanged). `Order.total`
currently equals `Order.subtotal` — no tax, discount, or shipping-cost
calculation exists anywhere in this codebase; `total` is kept as its own
persisted field purely so a future task can populate it additively without
a schema migration.

## Routes

Mounted under a `/checkout` prefix in `routes/v1/index.ts` (the same
convention `cart`/`customers`/`organizations` use):

```
POST /api/v1/checkout/preview   body: {organizationId, shippingAddressId?, billingAddressId?}
POST /api/v1/checkout           body: {organizationId, shippingAddressId?, billingAddressId?}
```

No `GET /api/v1/checkout/:id` — there is no persisted "checkout" resource
to fetch by id (see "Checkout is stateless" below); the created `Order` is
returned inline by the confirm response itself. A future "view my order"
endpoint belongs to `COM-004`'s own `orders` route surface.

## Checkout is stateless — no `CheckoutSession` document

No separate `Checkout`/`CheckoutSession`/`CheckoutAttempt` collection
exists. `preview` performs reads and computation only; `confirm` writes
directly to `Order` (already the thing being "created"). A refreshed
browser or an abandoned preview leaves nothing behind — the customer's
`Cart` (COM-002) is already the durable, resumable state they have.

## Security / IDOR boundary

Identity always comes from `req.auth.userId` via `resolveCustomerId()`,
never a client-supplied `customerId`. `organizationId` is client-supplied
context, validated read-only (exists + `ACTIVE`) — **not** SEC-002's
membership middleware, since customers are not organization members (the
same boundary every prior commerce module established). The authoritative
tenant check for every line item remains `ProductVariant.findById(organizationId,
variantId)`. Address ids are scoped by `customerId`; a foreign customer's
address id is indistinguishable from nonexistent (generic 404, no
enumeration). `Cart`/`CartItem` ids are never accepted from the client at
all — the Cart is always resolved server-side from `(customerId,
organizationId)`.

## Testing

Service/route tests both use `MongoMemoryReplSet` (not a standalone
`MongoMemoryServer`) — `confirmCheckout` genuinely uses `withTransaction()`,
which requires a replica set, mirroring `CUST-001`'s own
`setDefaultAddress` test requirement.

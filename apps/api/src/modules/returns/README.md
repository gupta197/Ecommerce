# Returns Module — ReturnRequest (COM-004 Tranche A)

Implements the return side of COM-004 ("Order lifecycle, tracking,
cancellation and **returns**"). A return is a wholly separate workflow from
`Order`'s own fulfillment lifecycle — never an `Order.status` value (see
`modules/orders/README.md`'s state-machine section for why).

## Status enum is complete; only `PENDING` is reachable in Tranche A

```
PENDING → APPROVED | REJECTED   (terminal)
APPROVED → RECEIVED              (terminal)
```

The full enum is defined now because the data model and the
quantity-integrity check both need to reason about every value — but **no
service or route in this tranche ever transitions a request away from
`PENDING`**. Approval, rejection, and receipt are explicitly deferred staff
operations (see "Deferred to a future tranche" below); this module only
implements creation and listing.

## Quantity integrity — the central requirement of this tranche

A requested return quantity is validated twice:

1. **Against the Order's own immutable snapshot** (`OrderItem.quantity`) —
   cheap, non-transactional, since that snapshot never changes.
2. **Against the cumulative quantity already requested by every existing
   non-`REJECTED` `ReturnRequest`** for the same order+variant — this is
   the invariant that prevents two overlapping submissions from together
   exceeding what was purchased, and it is **not** a plain
   "read-then-insert" check.

### Why a dedicated lock collection exists

MongoDB's transaction isolation does not, by itself, serialize two
concurrent transactions that each **insert a different new document** —
there is no shared document for the storage engine to detect a write
conflict on, unlike an update against an existing one. `ReturnRequestLock`
(one document per `orderId`, no stored quantity, purely a point of
contention) is atomically upserted **inside the transaction, before** the
aggregate read — two concurrent return-request submissions against the
same order genuinely conflict on this document, the loser's transaction is
retried automatically by the MongoDB driver (the identical mechanism
already proven safe for `COM-003`'s own concurrent-checkout-confirm race),
and the retry's fresh read then correctly sees the winner's already-
committed request. Proven by a dedicated concurrency test: two simultaneous
requests that would individually fit but together exceed the purchased
quantity resolve to exactly one success.

### Why "excludes rejected" needs no decrement path

`sumNonRejectedQuantitiesByVariant` is a **live query**
(`status: {$ne: 'REJECTED'}`), never a cached counter. This means "a
rejected request no longer counts toward the limit" is true by
construction, correctly, even though no code path in this tranche can ever
produce a `REJECTED` request — there is nothing to keep in sync, and a
future staff-rejection capability needs zero changes to this check for it
to keep working correctly.

## Order immutability

Requesting a return **never** modifies the parent `Order` — not its
`items`, `subtotal`, `total`, `shippingAddress`, `billingAddress`, or even
its `status`. A return's own refund-eligible amount (once refunds exist,
in a future COM-005) would be computed independently from `ReturnRequest`,
never by mutating `Order.total`. Proven by a dedicated test comparing the
Order document before and after a return request.

## A return may only be requested for a DELIVERED order

`DELIVERED` is a fully terminal lifecycle state (no outgoing edges in
`ORDER_TRANSITIONS`), so this check, done once before opening the
transaction, cannot go stale — nothing can transition an order away from
`DELIVERED` while a return request is being validated.

## No return-window enforcement (open decision)

No existing Planning/ADR evidence defines a return-window duration. Rather
than invent one, this tranche enforces **no time limit at all** —
`Order.deliveredAt` is populated (see `orders/README.md`) specifically so a
future, explicitly-approved policy has something to measure against.

## No inventory restocking, no refunds

This module never writes to `StockBalance` or `InventoryTransaction` —
proven by a dedicated negative test. Refund execution is entirely a future
COM-005 (payment provider) concern; `ReturnRequest` reaching `RECEIVED`
(once that capability exists) would be the hand-off point, nothing more.

## Customer routes (nested under `/api/v1/orders/:id/...`, in `orders/routes/order.route.ts`)

```
GET  /api/v1/orders/:id/returns     list this order's own return requests
POST /api/v1/orders/:id/returns     body: {items: [{variantId, quantity}], reason}
```

No route exists for approval, rejection, or receipt in this tranche.

## Deferred to a future tranche (explicitly, not silently)

- **Staff approve/reject/receive decisions** — blocked on the same SEC-002
  permission gap named in `orders/README.md`; no decision-transition
  function exists anywhere in this module yet, not even unexposed (unlike
  `Order`'s own internal-only lifecycle functions) — nothing in this
  tranche can reach `APPROVED`/`REJECTED`/`RECEIVED` through any code path.
- **Inventory restocking on receipt** — would reuse `INV-001`'s existing
  `RETURN` transaction type, but requires a `locationId` neither `Order`
  nor `ReturnRequest` carries (the same fulfillment-location gap COM-003
  already identified and deferred).
- **Refund execution** — COM-005.
- **Return-window enforcement** — see above.

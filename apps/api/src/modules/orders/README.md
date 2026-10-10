# Orders Module — Order, lifecycle (COM-003 + COM-004 Tranche A)

`Order` was created by **COM-003 (Checkout)** — see the bottom of this file
for why COM-003, not COM-004, brought the first `Order` document into
existence. **COM-004 Tranche A** (this change, `ADR-027`) extends the module
additively with the state machine, customer-facing read/cancel routes, and
the tracking/cancellation fields CLAUDE.md §7.3 describes. Nothing from
COM-003 was redesigned: `create()`, the original `OrderItemAttrs`/
`OrderAddressSnapshot` shapes, and the immutable-snapshot principle are all
untouched.

## State machine (ADR-027)

```
PENDING_PAYMENT → CONFIRMED → PROCESSING → PACKED → SHIPPED → DELIVERED
       ↓               ↓
   CANCELLED       CANCELLED
```

`order.service.ts`'s `ORDER_TRANSITIONS` table is the single source of truth
for which edges are legal — the `ORDER_STATUSES` enum on the model only
lists valid _values_, it says nothing about which transitions between them
are allowed. Every transition goes through `order.repository.ts`'s
`updateStatus()`, an **atomically guarded** `findOneAndUpdate` whose filter
includes `status: fromStatus` — never a separate "read current status,
decide, then write" sequence, so two concurrent transition attempts against
the same Order can never both succeed (the loser's write matches nothing
and returns `null`).

**Returns are never an `Order.status` value.** A separate `ReturnRequest`
collection (`modules/returns/`) owns the entire return workflow — see that
module's own README for why.

### Internal-only transitions (Tranche A scope)

`confirmOrder`, `startProcessing`, `markPacked`, `markShipped`, and
`markDelivered` are implemented and fully tested, but **none of them is
exposed via any route in this tranche** — no staff/admin API exists yet (no
`order.*` SEC-002 permission has been added; see "Deferred to a future
tranche" below). `confirmOrder` is specifically the trusted internal
boundary a **future COM-005** will call once a payment provider is
integrated and a webhook has been cryptographically verified — COM-004
builds and tests the mechanism now so "state transitions are controlled and
tested" is true for the whole chain, not just the customer-reachable part.
Never call any of these five functions from anything client-triggered.

`PROCESSING → CANCELLED` is deliberately **not** a legal edge in
`ORDER_TRANSITIONS` in this tranche — no staff-cancellation caller exists
to ever reach it. A future tranche would add it additively alongside staff
cancellation, not retrofit it speculatively now.

## Cancellation (customer-facing, Tranche A)

`cancelOrder` is the **only** customer-triggered status transition in this
tranche. Legal only from `PENDING_PAYMENT`/`CONFIRMED` — `PROCESSING`,
`PACKED`, `SHIPPED`, and `DELIVERED` are explicitly excluded by the approved
Tranche A rule, not merely unrouted. `cancellationReason`/`cancelledAt` are
set on the Order; `cancelledBy` is deliberately **not** a separate field —
who cancelled is already captured by the `order.cancelled` `AuditEvent`'s
own `actorUserId`, avoiding a second, driftable place to track the same
fact.

## Tracking fields (Tranche A)

`carrier`, `trackingNumber`, `shippedAt`, `deliveredAt` are plain, opaque
fields set only by `markShipped`/`markDelivered` (both internal-only in this
tranche — see above). **No external carrier API integration exists or is
implied** — these are exactly the fields a future staff action would
populate by hand (or, even later, a real carrier integration would populate
automatically) without any further schema change. `deliveredAt` exists
specifically so a **future, explicitly-approved return-window policy** has
something to measure against — no window duration is enforced anywhere in
this tranche (see `modules/returns/README.md`).

## Indexes (Tranche A)

`{customerId, createdAt: -1}` backs the customer's own order list
(`GET /api/v1/orders`). `{organizationId, status}` is forward-justified for
a future staff order-listing/queue view — not built in this tranche (no
route exposes it), but the exact, stated purpose of this task's own
"tracking" requirement, not a speculative addition.

## Repository (Tranche A additions)

- `findById(customerId, id)` — the only lookup a customer-facing route may
  use.
- `findByIdInternal(id)` — unscoped, for the internal-only transition
  functions above; never call this from a route handler.
- `updateStatus(filter, fromStatus, toStatus, patch)` — the atomic guard
  described above; `filter.customerId` is present for customer-triggered
  calls (`cancelOrder`) and omitted for internal ones.
- `listByCustomer(customerId, filter, options)` — paginated, filterable by
  `status`/`organizationId`.

`create()` (COM-003's own) is untouched.

## Customer routes (Tranche A)

```
GET  /api/v1/orders                    list the caller's own orders (paginated, filterable)
GET  /api/v1/orders/:id                order detail
POST /api/v1/orders/:id/cancel         body: {reason?}
GET  /api/v1/orders/:id/returns        list the order's own return requests
POST /api/v1/orders/:id/returns        create a return request — see modules/returns/README.md
```

Identity always from `req.auth.userId` → `resolveCustomerId()`; every query
scoped by the resolved `customerId`; cross-customer access produces a
generic 404, never an enumerable distinction. Return-request routes are
nested here (same `:id` path segment) but call across into
`modules/returns/`'s own service — the same one-directional
cross-module-service-reuse pattern `checkout.service.ts` already uses
against `orders`' own repository.

## Deferred to a future tranche (explicitly, not silently)

- **Staff/admin order management** (confirm/process/pack/ship/deliver,
  staff cancellation from `PROCESSING`) — blocked on an explicit SEC-002
  extension (`ORDER_READ`/`ORDER_MANAGE` permissions do not exist yet).
  This would also be the **first** business-domain use of
  `resolveOrganizationContext`/`requirePermission` anywhere in this
  codebase outside `organizations/` itself.
- **Return approval/rejection/receipt** — see `modules/returns/README.md`.
- **Fulfillment-location assignment and any inventory decrement/restock** —
  `Order`/`OrderItem` still carry no `locationId`; `recordTransaction`/
  `recordTransfer` require one. COM-004 performs **zero** `StockBalance`/
  `InventoryTransaction` writes, proven by a dedicated negative test.
- **Payment and refund integration** — `DEC-001` (payment provider) remains
  `OPEN`.
- **Return-window enforcement** — no duration is defined by any existing
  Planning/ADR evidence; not invented here.

## Why COM-003, not COM-004, created this module

COM-003's own roadmap description is "Checkout **preview and order
creation**" — Checkout is the task that brings the first `Order` document
into existence. `COM-004` ("Order lifecycle, tracking, cancellation and
returns") depends on `COM-003` and is scoped to managing an
**already-existing** order's state machine, not creating the first one.

## Immutable snapshot, not a live reference

Every `OrderItem` (`variantId, productId, name, sku, price, quantity,
subtotal`) is a **snapshot** captured at checkout-confirmation time — none
of these fields are ever re-resolved from the live `Product`/`ProductVariant`
afterward. `shippingAddress`/`billingAddress` are likewise **snapshots** of
the relevant `Address` fields, not a live `addressId` reference. COM-004
preserves this absolutely: no cancellation or return operation anywhere in
this module ever modifies `items`, `subtotal`, `total`,
`shippingAddress`, or `billingAddress` — proven by a dedicated test.

## Transaction participation

`order.repository.ts`'s `create()` accepts an optional `ClientSession` —
required so it can participate in `checkout.service.ts`'s single
Order-creation-plus-Cart-clearing transaction. `updateStatus()` is a
single-document atomic operation and deliberately does **not** use a
transaction — there is no multi-document invariant to protect for a status
change alone (unlike `modules/returns/`'s own quantity-integrity check,
which genuinely needs one).

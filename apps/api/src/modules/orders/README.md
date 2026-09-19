# Orders Module — Order (created by COM-003, minimal)

This module is created by **COM-003 (Checkout)**, not COM-004. It exists
because COM-003's own roadmap description is "Checkout **preview and order
creation**" — Checkout is the task that brings the first `Order` document
into existence, not merely a task that hands data to a separate module.
COM-004 ("Order lifecycle, tracking, cancellation and returns") will extend
this module — additively, never by breaking what's here — when it is
approved and implemented.

## Why this module is deliberately minimal

Only what COM-003 actually needs exists here: the `Order` model and a
single repository function, `create()`. No `findById`, `list`, `update`, or
status-transition function is added speculatively — building those now,
ahead of COM-004's own approval, would be exactly the kind of scope creep
CLAUDE.md's task-execution rules warn against ("do not perform unrelated
refactoring," "implement only the approved task"). No `services/` or
`routes/` directory exists in this module at all — Checkout's own
`checkout.service.ts` calls `orderRepository.create()` directly (the same
one-directional cross-module-repository-reuse pattern already used
throughout this codebase, e.g. `wishlist.service.ts` reading `catalog`'s
`product-variant.repository.ts`), and no HTTP route yet exposes an order to
read back (the created Order is returned inline by `POST /api/v1/checkout`
itself — see the `checkout` module's own README).

## Immutable snapshot, not a live reference

Every `OrderItem` (`variantId, productId, name, sku, price, quantity,
subtotal`) is a **snapshot** captured at checkout-confirmation time — none
of these fields are ever re-resolved from the live `Product`/`ProductVariant`
afterward. `shippingAddress`/`billingAddress` are likewise **snapshots** of
the relevant `Address` fields, not a live `addressId` reference. This is the
deliberate opposite of `Cart`/`CartItem`'s own no-snapshot design
(`ADR-025`): a `Cart` must always reflect current truth so its totals stay
server-authoritative right up to the moment of checkout, but an `Order` is a
financial and shipping record that must remain a faithful account of what
was actually agreed to — even if the product is later renamed/repriced, or
the customer edits or archives the address afterward.

## Status

`ORDER_STATUSES = ['PENDING_PAYMENT']` — the **only** value COM-003 ever
sets, and the only one currently valid at the schema level. COM-004 will
extend this enum additively (`CONFIRMED`, `PROCESSING`, `PACKED`, `SHIPPED`,
`DELIVERED`, cancellation/return states, per CLAUDE.md §7.3) when it
implements the actual state machine — no future state is pre-declared here,
the same discipline already applied to `Cart`'s own deferred `status` field.

## No indexes yet

This collection intentionally has **no secondary index** beyond the default
`_id` index — COM-003 only ever _creates_ Orders, it never queries them back
by `customerId`/`organizationId` (the created Order is returned inline by
the confirm response itself, not looked up afterward). Adding a listing
index now, before any real query pattern needs it, would be building
COM-004's own infrastructure ahead of its approval. COM-004 will add
whatever indexes its actual order-listing/lookup routes require.

## Transaction participation

`order.repository.ts`'s `create()` accepts an optional `ClientSession` —
required so it can participate in `checkout.service.ts`'s single
Order-creation-plus-Cart-clearing transaction (see the `checkout` module's
own README for why that atomicity boundary exists). It is not itself
wrapped in a transaction — the caller (`checkout.service.ts`) owns that.

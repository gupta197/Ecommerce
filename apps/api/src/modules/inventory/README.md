# Inventory Module — Location, StockBalance & InventoryTransaction (INV-001)

This module implements INV-001: "Locations, balances and immutable
inventory transactions." It depends on CAT-004 (`ProductVariant`) but does
not modify any catalog file.

## Layering

```
Service → Repository → Mongoose Model
```

**No Controller/Route layer exists yet** — same reasoning as the catalog
modules: no HTTP-reachable action exists yet to authorize against, so no
route is added and no temporary auth workaround is introduced.

## Organization ownership

Every collection (`Location`, `StockBalance`, `InventoryTransaction`)
requires `organizationId` as a mandatory field, and every repository
function takes it as a required parameter — the same convention Category,
Brand, Product, and ProductVariant already established. No `ref:
'Organization'` on the field itself, consistent with every existing module.

## Location

`{organizationId, name, code?, status, createdAt, updatedAt}`. **No
`DRAFT`** — a location is either usable (`ACTIVE`) or decommissioned
(`ARCHIVED`); unlike a catalog entity, there's no "authoring" phase for a
warehouse. `code` is optional; when supplied it's trimmed, bounded to 50
characters, and unique per `{organizationId, code}` via a **partial** unique
index (`partialFilterExpression: {code: {$exists: true}}`) — the same
corrected technique CAT-004's barcode index uses, not `sparse`, since a
plain `sparse` index on a compound key only excludes a document missing
*every* indexed field, and `organizationId` is always present. Archiving is
soft only, never cascades to existing `StockBalance`/`InventoryTransaction`
history, and an archived location becomes ineligible for *new* transactions
(enforced by `inventory.service.ts`, not by `location.service.ts` itself).

## StockBalance

`{organizationId, locationId, variantId, quantityOnHand, updatedAt}` — no
`createdAt` (a balance row's own creation time isn't a business-relevant
fact the way it is for the immutable ledger below). Unique index:
`{organizationId, locationId, variantId}` — this is the primary key in all
but name.

**`quantityOnHand` is never directly patchable.** `stock-balance.repository.ts`
exposes exactly two named, semantically explicit mutation operations —
`incrementOrCreate` and `decrementIfSufficient` — and no general-purpose
`update()`/`set()`. The only way a caller can change a balance is through
`inventory.service.ts`'s `recordTransaction()`/`recordTransfer()`, which
always also writes the corresponding ledger entry — the balance and the
ledger can never drift out of sync because there is no code path that
writes one without the other.

**Guarded decrement, not read-then-write**: `decrementIfSufficient`'s
MongoDB filter itself includes `quantityOnHand: {$gte: amount}` — the
sufficiency check and the write are the same atomic operation, never a
separate "read the balance, check in application code, then write"
sequence. This directly reuses the pattern `ADR-018` established for
`Organization.activeOwnerCount`'s last-owner protection, applied to a new
domain.

**Atomic increment-or-create**: `incrementOrCreate` is a single
`findOneAndUpdate` with `upsert: true` — never "check if a balance exists,
then decide whether to insert or update." Two concurrent first-writes for
the same key are ultimately resolved by the unique index; when both writers
are inside a MongoDB transaction (the only way this is ever called), a
losing writer surfaces as a transient write conflict that `withTransaction()`'s
built-in whole-callback retry already resolves — proven by a dedicated
concurrency test with no pre-existing balance document. A duplicate-key
catch-and-retry inside `incrementOrCreate` itself is an additional,
cheap defense-in-depth layer for the same race outside that primary
mechanism.

## InventoryTransaction

Append-only: `{organizationId, locationId, variantId, type, quantity,
adjustmentDirection?, note?, createdAt}` — no `updatedAt`, this document is
never modified after creation. `inventory-transaction.repository.ts`
exposes only `create()` and `list()` — no `update()`, no `delete()`,
mirroring `audit-event.repository.ts`'s exact shape. `create()` takes a
required (not optional) `ClientSession` parameter — a ledger entry can only
ever be written as part of the single `withTransaction()` that also
updates the corresponding `StockBalance`.

**Types**: `PURCHASE, SALE, RETURN, ADJUSTMENT, DAMAGE, OPENING_BALANCE,
TRANSFER_IN, TRANSFER_OUT`. `TRANSFER_IN`/`TRANSFER_OUT` are valid stored
values but are **never** accepted as direct input to `recordTransaction()`
— they can only be produced by `recordTransfer()`.

**Quantity**: always a positive integer (finite, non-zero, non-negative, no
fractional value) — direction is carried entirely by `type`/
`adjustmentDirection`, never by the sign of `quantity`.

**Direction mapping**:

| Type | Delta |
|---|---|
| `PURCHASE`, `RETURN`, `OPENING_BALANCE` | `+quantity` |
| `SALE`, `DAMAGE` | `-quantity` |
| `ADJUSTMENT` + `INCREASE` | `+quantity` |
| `ADJUSTMENT` + `DECREASE` | `-quantity` |

`adjustmentDirection` is required for, and only for, `ADJUSTMENT` — a plain
"unsigned quantity, type implies direction" mapping isn't sufficient for
`ADJUSTMENT` alone, since it can mean either direction. Enforced at both the
Zod layer (`superRefine`) and, as defense-in-depth, at the Mongoose layer: a
conditional `required` function for the "must be present" half (a plain
custom validator doesn't get invoked by Mongoose when a path's value is
`undefined`, so `required` — which is specifically designed to be evaluated
in that case — is the correct construct) plus a custom validator for the
"must be absent otherwise" half.

## recordTransaction()

Handles only `PURCHASE, SALE, RETURN, ADJUSTMENT, DAMAGE, OPENING_BALANCE`.
Sequence: validate `variantId` (organization-scoped, re-fetched via
`ProductVariant`'s own repository, rejects missing/cross-org/`ARCHIVED` —
mirrors CAT-004's `assertValidProduct` exactly) → validate `locationId`
(same pattern) → compute the signed delta → **inside one
`withTransaction()`**: atomically adjust `StockBalance`, then create the
`InventoryTransaction`. Both succeed or neither does — proven by a
dedicated rollback test (a rejected `SALE` leaves the balance unchanged and
writes no ledger entry at all).

## recordTransfer()

A dedicated operation — **never** two independent `recordTransaction()`
calls, which could leave a `TRANSFER_OUT` applied with no matching
`TRANSFER_IN` if the second call failed independently. Validates the
variant and both locations, rejects `fromLocationId === toLocationId`, then
inside one `withTransaction()`: guarded-decrements the source balance,
increments-or-creates the destination balance, and writes both a
`TRANSFER_OUT` and a `TRANSFER_IN` ledger entry. An insufficient-stock
failure rolls back the entire operation — proven by a dedicated test
showing zero ledger entries and unchanged balances on both sides after a
rejected transfer.

## Negative-inventory prevention

No `allowNegative`/backorder configuration of any kind exists. Every
outbound adjustment (`SALE`, `DAMAGE`, `ADJUSTMENT`+`DECREASE`,
`TRANSFER_OUT`'s source decrement) goes through `decrementIfSufficient`'s
guarded filter — this is unconditional or the current phase.

## No SEC-003 audit integration

`InventoryTransaction` is this task's own complete, sufficient audit trail
for stock changes — no `AuditEvent` call exists anywhere in this module,
and no `modules/audit/` file was touched.

## No forward-looking reference fields

No `sourceType`/`sourceId`/`orderId`/`purchaseId`/`supplierId`/`saleId` or
any other foreign key to a future business workflow exists on
`InventoryTransaction`. **Future integration note** (not solved here): a
future business workflow (e.g. `BUS-001` purchase receiving, `COM-004`
order fulfillment) that calls `recordTransaction()`/`recordTransfer()` may
need an idempotency/reference mechanism so that retrying the same business
operation cannot create a duplicate inventory movement. This is explicitly
deferred — no speculative field was added in anticipation of it.

## Multi-location

Full multi-location support (including `TRANSFER_IN`/`TRANSFER_OUT`) is
built now, not deferred — the task's own description explicitly names
"Locations" (plural) and CLAUDE.md §6.3 names both transfer transaction
types.

## Testing

`location.repository.test.ts`/`location.service.test.ts` use
`mongodb-memory-server`'s standalone `MongoMemoryServer` — no transactions
needed for plain `Location` CRUD. `stock-balance.repository.test.ts`/
`inventory-transaction.repository.test.ts` also use a standalone server —
`mongoose.startSession()` without starting an actual transaction works for
single-document writes even on a non-replica-set deployment, which is
sufficient to unit-test these repositories' atomic primitives in isolation.
`inventory.service.test.ts` uses `MongoMemoryReplSet` (`recordTransaction`/
`recordTransfer` genuinely need `withTransaction()`'s multi-document ACID
guarantees), and is where the two mandated concurrency scenarios live:
concurrent initial-balance creation (no pre-existing `StockBalance`,
proving no lost update and exactly one resulting document) and concurrent
outbound operations (proving exactly one of two competing `SALE`s succeeds
and the balance never goes negative).

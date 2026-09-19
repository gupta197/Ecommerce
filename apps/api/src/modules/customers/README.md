# Customers Module — Customer, Address (CUST-001)

This module implements CUST-001: "Customer profile, addresses and account
lifecycle." It depends only on SEC-001 (authentication) — deliberately not
SEC-002 (organizations/RBAC).

## Global, not organization-scoped

**Neither `Customer` nor `Address` carries `organizationId`** — an explicit,
approved architectural decision, not an oversight. `CUST-001`'s own declared
dependency in `MASTER_TASK_LIST.xlsx` is `SEC-001` only, unlike every
organization-owned catalog entity (`CAT-001`–`004`), which explicitly
depends on `SEC-002`. Combined with `User` (SEC-001) itself carrying no
`organizationId` — organization membership is already a separate join
collection, not a `User` field — this makes `Customer` a global identity by
design, matching the future marketplace direction (one customer account
interacting with multiple seller organizations). `user.model.ts` is not
modified — no `customerId` field was added to `User` either; `Customer`
holds the `userId` foreign key, not the reverse.

## Layering

```
Service → Repository → Model → Routes
```

Unlike CAT-001–004/INV-001, this module **does** have a route layer — an
explicit, approved decision, not the default. The justification: `SEC-001`'s
`authenticate()` middleware is already live, and a customer managing _their
own_ profile/addresses is inherently a self-service, authenticated end-user
flow, unlike the catalog/inventory foundation tasks which had no HTTP
consumer to expose yet.

## Customer/User relationship

`Customer.userId` is required and unique (1:1 with `User`, enforced by a
unique index) — `Customer` is the dependent entity holding the foreign key,
mirroring every other directional reference in this codebase
(`OrganizationMembership.userId`, `ProductVariant.productId`,
`InventoryTransaction.variantId`). A `User` can exist with no `Customer`
profile (an organization staff member who never shops); a `Customer` cannot
exist without a `User` in this task (no guest checkout support — that
remains a separate, later concern).

`User.status` (`ACTIVE|DISABLED`, SEC-001, authentication) and
`Customer.status` (`ACTIVE|ARCHIVED`, this module, domain/shopping profile)
are entirely independent — neither cascades to the other. Password/email/
authentication ownership remains entirely inside SEC-001; this module never
touches `user.model.ts` or any other SEC-001 file.

## Customer lifecycle

`ACTIVE | ARCHIVED` only — no `SUSPENDED`/`DISABLED` third state, since no
concrete business rule distinguishing it from `ARCHIVED` was identified.
Archiving is soft only, never deletes the document, never cascades to
addresses. **Status is never settable through the general profile
`PATCH`** — only the dedicated `archiveCustomerProfile`/
`restoreCustomerProfile` service functions change it (an approved deviation
from the catalog modules' convention of allowing `status` through the
general update schema). An archived profile can still be read but cannot be
updated, nor can it create/modify/archive/set-default any address, until
restored.

## Address

A separate collection (not embedded on `Customer`) referencing `customerId`
— needed for independent CRUD and, most importantly, for the
database-enforced "at most one default" guarantee below, which an embedded
array couldn't express. `recipientName`/`phone` are independent of the
`Customer`'s own name/phone (a shipment can legitimately go to a different
named recipient). `country` is a bounded free-text string, not a locked
ISO-3166 enum — no reference dataset or new dependency introduced.
Lifecycle is `ACTIVE | ARCHIVED`, soft-delete only, for consistency with
every other entity in this codebase.

**Default billing / default shipping**: two independent booleans, each
enforced by its own partial unique index —
`{customerId, isDefaultBilling: true}` / `{customerId, isDefaultShipping:
true}` — the same technique already used for organization-membership's
ACTIVE-status uniqueness, CAT-004's barcode, and INV-001's location code.
**Switching the default is a single `withTransaction()`** (approved
decision, a deliberate change from this module's original plan): verify
ownership and `ACTIVE` status, unset the existing default of that type,
set the new one — all four steps commit or roll back together. The partial
unique indexes remain an additional, database-level invariant on top of
the transaction, not a replacement for it. Neither default flag, nor
`status`, nor `customerId` is ever settable through the general address
`PATCH` — only `setDefaultAddress`/`archiveAddress` change them.

## Tenant/ownership scoping

`Customer` has no higher-level tenant object in this module (there is no
`organizationId`) — its own `_id`, resolved exclusively via
`findByUserId(req.auth.userId)`, is the scoping boundary. `Address`
repository functions all require `customerId` as a mandatory parameter,
the same IDOR-prevention convention every other module uses, anchored on
`customerId` instead of `organizationId`. No route, service, or repository
function ever accepts a client-supplied `userId`/`customerId` for
authorization purposes.

## Routes

All under `/api/v1/customers`, all requiring `authenticate()`, all
resolving identity from `req.auth.userId` only:

```
GET    /me
POST   /me
PATCH  /me
DELETE /me                          (archive)
GET    /me/addresses
POST   /me/addresses
PATCH  /me/addresses/:id
DELETE /me/addresses/:id            (archive)
POST   /me/addresses/:id/default    (body: {type: 'billing'|'shipping'})
```

No staff/admin route exists or is planned here — viewing or managing
_another_ customer's data would need `SEC-002` organization/permission
context this module deliberately doesn't have. No `restoreCustomerProfile`
route exists yet either — the service/repository function is implemented
and tested, but only the routes explicitly approved above were added; a
restore endpoint was not part of that approved list.

## Audit — not wired (flagged, not silently decided)

`customer.archived`/`customer.restored` were approved as the required
audit events for this task. **They are not implemented.** Wiring them
requires adding new entries to `AUDIT_ACTIONS`/`AUDIT_ENTITY_TYPES` in
`modules/audit/models/audit-event.model.ts` — a SEC-003 file, and this
task's boundaries explicitly state "Do NOT modify SEC-003." This is a
direct conflict between two approved instructions, resolved here by not
touching SEC-003, and documented for a follow-up decision rather than
picked silently. A test in `customer.service.test.ts` explicitly documents
the current state (zero `AuditEvent` documents are created by any CUST-001
action).

## Testing

`customer.repository.test.ts`/`customer.service.test.ts`/
`address.repository.test.ts` use a standalone `mongodb-memory-server`
(`MongoMemoryServer`) — no transaction is needed for plain CRUD, including
`address.repository.ts`'s `clearDefaultFlag`/`setDefaultFlag`, which are
exercised there via `mongoose.startSession()` without starting an actual
transaction (valid for single-document writes on a standalone server).
`address.service.test.ts` and `customer.route.test.ts` use
`MongoMemoryReplSet` — `setDefaultAddress()`'s real `withTransaction()`
usage needs a genuine replica set, including its own dedicated concurrency
test (two concurrent `setDefaultAddress` calls for different addresses of
the same customer resolve to exactly one default, never both).

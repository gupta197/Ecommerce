# Organizations Module — RBAC Foundation (SEC-002)

This module implements **SEC-002: Organizations, memberships, roles and
permissions** from `Planning/MASTER_TASK_LIST.xlsx`. It builds the
authorization layer on top of SEC-001's authentication foundation —
`Organization` and `OrganizationMembership` did not exist before this task.

## Layering

```
Route → Authorization (resolveOrganizationContext / requirePermission) → Service → Repository → Model
```

Routes exist (unlike catalog, which deferred them) for the same reason
SEC-001's routes exist: this module's own endpoints are what create the
organization/membership context other modules will eventually depend on —
there is no chicken-and-egg problem to defer.

## Roles and permissions — deliberately static, not DB-backed

`OrganizationMembership.role` is a fixed enum (`OWNER | ADMIN | MEMBER`) —
**no `Role` collection**. Permissions are a static, code-defined map
(`authorization/permissions.ts`) — **no `Permission` collection**. SEC-002's
actual requirements (tenant isolation, authorization tests passing) don't
call for dynamic/custom per-organization roles; a fixed enum plus a static
map is the simplest model that satisfies them, and remains an additive
(non-breaking) migration path if genuine custom roles are ever needed later.

```
PERMISSIONS = {
  ORGANIZATION_READ, ORGANIZATION_UPDATE,
  MEMBERSHIP_READ, MEMBERSHIP_MANAGE, ROLE_MANAGE,
}

ROLE_PERMISSIONS = {
  OWNER:  [ORGANIZATION_READ, ORGANIZATION_UPDATE, MEMBERSHIP_READ, MEMBERSHIP_MANAGE, ROLE_MANAGE],
  ADMIN:  [ORGANIZATION_READ, ORGANIZATION_UPDATE, MEMBERSHIP_READ],
  MEMBER: [ORGANIZATION_READ],
}
```

`membership.manage` (add/remove a membership) and `role.manage` (change an
existing membership's role) are kept as two separate permissions,
deliberately — both happen to be OWNER-only today, but nothing forces them
to stay coupled if a future task wants to grant one without the other.

Holding a permission does not guarantee an operation succeeds: last-owner
protection (below) is an orthogonal data-integrity rule that applies even
to an `OWNER` who indisputably holds `role.manage`/`membership.manage`.

## Organization context — URL param, always re-verified, never cached

`/api/v1/organizations/:organizationId/...` — the URL segment is untrusted
input. `authorization/policy.ts`'s `resolveOrganizationContext()` performs,
on every single request:

1. Validate `organizationId` as a well-formed ObjectId (module-local Zod
   schema) — malformed input is rejected with a 422 before any database
   read.
2. Load the `Organization`. Missing or not `status: 'ACTIVE'` → a generic
   `ForbiddenError`.
3. Look up an `ACTIVE` `OrganizationMembership` for `{organizationId,
userId: req.auth.userId}`. Missing → the same generic `ForbiddenError`.
4. Attach `req.membership = {membershipId, organizationId, role}`.

"Organization doesn't exist", "organization is suspended", and "caller
isn't a member" are **byte-identical** responses (same message, same status
code) — verified by a dedicated test — so no organization's existence,
suspension state, or another user's membership can be enumerated.

There is deliberately no JWT/session organization claim: context is
resolved fresh from the database on every request, at the cost of one extra
indexed read compared to SEC-001's `authenticate()` (which intentionally
avoids any per-request database lookup). This is a necessary, accepted
difference — authorization must reflect a revoked/removed membership
immediately, whereas SEC-001 accepted bounded staleness only for pure
authentication.

## Suspension has no reactivation bypass

A `SUSPENDED` organization blocks **every** role, including its own
`OWNER`, inside `resolveOrganizationContext()` — there is no special-case
exemption. Consequence: once an organization is suspended, **no endpoint in
this module can ever un-suspend it** (the very `PATCH .../organizations/:id`
call that would flip `status` back to `ACTIVE` is itself blocked by the
same check). This is an accepted, deliberate limitation for SEC-002 — SEC-002
has no platform-admin capability, and building one purely to work around
this was explicitly out of scope, not an oversight.

## Last-owner protection — atomic counter, not count-then-act

`Organization.activeOwnerCount` is a denormalized counter, mutated only via
atomic guarded MongoDB operations — the same compare-and-swap philosophy as
SEC-001's refresh-token rotation (`claimActiveByHash`). A plain "count
documents, then decide, then write" approach does **not** prevent the real
risk: two concurrent operations that each target a _different_ one of two
`OWNER` memberships, each independently observing "2 owners, safe to
proceed," is a write-skew anomaly that snapshot-isolated transactions alone
do not prevent when the two writes land on two different documents.
Routing every owner-count change through one shared counter field on the
`Organization` document closes that gap: MongoDB serializes writes to a
single document, so only one of two racing "reduce the owner count"
operations can ever win.

```
repositories/organization.repository.ts:
  incrementActiveOwnerCount(id, session)              — always safe, no guard
  decrementActiveOwnerCountIfSafe(id, session)         — findOneAndUpdate({activeOwnerCount: {$gt: 1}}, {$inc: -1})
                                                          returns null if this would reach zero
```

Required transitions (`services/membership.service.ts`):

| Transition                     | Counter effect                                                        |
| ------------------------------ | --------------------------------------------------------------------- |
| `MEMBER` ↔ `ADMIN`             | none                                                                  |
| `*` → `OWNER`                  | `+1` (always safe)                                                    |
| `OWNER` → `*`                  | `-1`, guarded — rejected with `ForbiddenError` if it would reach zero |
| removing an `OWNER` membership | `-1`, guarded, same as above                                          |

Organization creation and the creator's first `OWNER` membership are one
atomic `withTransaction()` unit (reusing DB-001's existing helper, no new
transaction/retry abstraction) — a forced failure of the membership half is
proven, by a dedicated rollback test, to leave no orphan `Organization`
behind. A dedicated concurrency test (`services/last-owner-protection.test.ts`)
proves the write-skew scenario directly: two organizations with two owners
each, concurrently removing/demoting _different_ owners via
`Promise.allSettled` — exactly one operation succeeds, the other is
rejected, and the organization never ends with zero `ACTIVE` owners.

## Membership lifecycle — `ACTIVE → REMOVED` is terminal

There is no reactivation endpoint in SEC-002. Regaining access after removal
means creating a **new** membership document. This is why the uniqueness
index is a **partial** unique index (`{organizationId, userId}` unique,
`partialFilterExpression: {status: 'ACTIVE'}`) rather than a blanket one —
a blanket unique index would make re-adding a previously removed user
impossible, since the old `REMOVED` row would permanently collide with any
future row for the same pair.

## Membership creation — mass-assignment protection

`POST .../memberships` accepts **only** `{userId}` (`.strict()` Zod schema
— any other field, including an attempted `organizationId`/`role`/`status`,
is rejected outright as a 422, not silently stripped). The service function
`membershipService.addMember(organizationId, userId, logger)` has **no**
`role`/`status` parameter in its signature at all — there is no code path,
even under a hypothetical validation bypass, that could honor a
client-supplied role or status. New members always start as
`role: 'MEMBER', status: 'ACTIVE'`.

## Self-management — mostly falls out of the permission matrix

Only `role.manage`/`membership.manage` (both `OWNER`-only) gate role and
membership mutation, so five of the seven self-management edge cases the
approved plan named require no bespoke "is this the caller acting on
themselves?" code at all — an `ADMIN` or `MEMBER` attempting to change any
role, or a `MEMBER` attempting to add a membership, is rejected at the
permission-check layer regardless of the target. Only the `OWNER`-acting-
on-self cases need the atomic counter, and that logic doesn't need to know
or care whether the caller is the target — it only cares about the
resulting `activeOwnerCount`.

## `req.membership` and the auth → organizations dependency

`req.membership: {membershipId, organizationId, role}` is added via a
**new** file, `types/express.d.ts`, using TypeScript declaration merging —
SEC-001's own `apps/api/src/types/express.d.ts` (which declares
`req.auth`) is not modified. `membershipId` is included (not just
`organizationId`/`role`) because it's free (the membership document is
already fetched to read `role`) and useful for cheap self-targeting
comparisons and future audit logging, without a second query.

This module depends on `modules/auth`'s already-public
`userRepository.findById()` (to confirm a target user exists before adding
them to an organization) — the dependency is one-directional
(`organizations → auth`); `modules/auth` has no knowledge of this module.

## Indexes

| Model                  | Index                                  | Unique                               | Supports                                                                         |
| ---------------------- | -------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Organization           | none beyond `_id`                      | —                                    | no query pattern needs one yet                                                   |
| OrganizationMembership | `{organizationId:1, userId:1}`         | yes, **partial** (`status:'ACTIVE'`) | at most one ACTIVE membership per pair, while permitting historical REMOVED rows |
| OrganizationMembership | `{userId:1, status:1}`                 | no                                   | `GET /organizations`                                                             |
| OrganizationMembership | `{organizationId:1, role:1, status:1}` | no                                   | member listing                                                                   |

## Explicitly out of scope here

Catalog wiring (catalog has no route layer to attach this to, and its files
are untouched), the SEC-003 audit/security-event framework (only minimal
`logger.info` lines for organization/membership/role mutations), MFA,
password reset, GeoIP, Redis, platform-admin functionality, dynamic/custom
roles, a `Permission`/`Role` collection, JWT/session changes, and any
frontend work.

## Testing

`mongodb-memory-server`'s `MongoMemoryReplSet` (a real, even single-node,
replica set) for every test that exercises `withTransaction()` — a
standalone `MongoMemoryServer` cannot run multi-document transactions at
all. Repository-level tests that only need a single atomic
`findOneAndUpdate` (not a full transaction) use a standalone server with a
plain, non-transactional session. Covers organization/membership CRUD, the
partial-index re-add-after-removal behavior, the full permission matrix,
organization-context resolution (including the byte-identical-error
enumeration guard), suspension, mass-assignment attempts, IDOR across
organizations, self-management edge cases, and the dedicated last-owner
concurrency suite (including the true write-skew race across two different
owners) plus the atomic-bootstrap rollback test.

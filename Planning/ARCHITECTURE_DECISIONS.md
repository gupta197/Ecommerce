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

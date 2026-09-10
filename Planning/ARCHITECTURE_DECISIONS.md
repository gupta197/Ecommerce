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

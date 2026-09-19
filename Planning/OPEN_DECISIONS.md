# Open Decisions

This file is the source of truth for architecture/business decisions that are not yet finalized.

## Rules
- Record decisions before implementation when they materially affect architecture, security, financial correctness, or data model.
- Do not silently make high-impact decisions.
- Each decision should have an owner, options, recommendation, and final outcome.
- Once resolved, move the decision to `ARCHITECTURE_DECISIONS.md` or create an ADR under `docs/decisions/`.

## Current Open Decisions

| ID | Decision | Options | Recommendation | Status |
|---|---|---|---|---|
| DEC-001 | Payment provider | Razorpay / Stripe / other | Select based on target markets and fees | OPEN |
| DEC-002 | Object storage | AWS S3 / Cloudflare R2 / other S3-compatible | S3-compatible private bucket | OPEN |
| DEC-003 | Email provider | Resend / SES / other | Choose based on deliverability and cost | OPEN |
| DEC-004 | SMS/WhatsApp provider | Provider TBD | Select after notification requirements are finalized | OPEN |
| DEC-005 | Production hosting | AWS / Azure / other | Decide after deployment requirements | OPEN |
| DEC-006 | Migration tool for schema evolution | migrate-mongo / custom script + tracking collection / defer until first real schema | Defer the tool choice until the first schema-changing task (likely CAT-001) actually needs it | OPEN |
| DEC-007 | CUST-001's approved `customer.archived`/`customer.restored` audit events vs. the explicit "do not modify SEC-003" boundary for that task | (a) Extend `AUDIT_ACTIONS`/`AUDIT_ENTITY_TYPES` in `modules/audit/models/audit-event.model.ts` with `customer.archived`/`customer.restored`/`Customer`, as a small, additive, isolated follow-up; (b) leave CUST-001 permanently without audit wiring for these actions | (a) — extending the enum is the same kind of additive change SEC-003's own design anticipates for future modules, and is lower-risk than leaving an explicitly-approved security-relevant audit requirement permanently unmet | OPEN |

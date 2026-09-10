# CLAUDE.md — E-Commerce & Business Management Platform

## 1. Project Identity

This repository is a full-stack MERN business platform that starts as a family-business e-commerce and management system and is designed to evolve into a multi-organization / multi-vendor marketplace.

### Technology Stack

- Frontend: React + TypeScript
- Backend: Node.js + Express + TypeScript
- Database: MongoDB + Mongoose
- Cache / queues: Redis + BullMQ
- Object storage: S3-compatible private object storage
- API style: REST
- API version: `/api/v1`
- Validation: Zod or the project-approved validation library
- Server-state management: TanStack Query
- Forms: React Hook Form
- Styling/UI: Tailwind CSS + approved component library
- Testing:
  - Unit tests
  - Integration/API tests
  - Security tests
  - End-to-end tests where appropriate
- Development: Docker-compatible local environment and Git

## 2. Core Business Scope

The platform must eventually support:

### Customer commerce
- Product/category browsing
- Product details
- Product variants
- Wishlist
- Out-of-stock wishlist items
- Back-in-stock notifications
- Customer registration/login
- Billing/shipping addresses
- Cart
- Checkout
- Payments
- Orders and tracking
- Invoices
- Reviews
- Discounts/coupons
- Returns/refunds

### Business management
- Products, categories, brands and variants
- Inventory and stock movements
- POS / daily sales
- Customers
- Customer ledger
- Suppliers
- Purchases
- Supplier ledger
- Expenses
- Investments and withdrawals
- Employees
- Salary records/payments
- Reports
- Business dashboard

### Property / rental management
- Properties
- Rooms
- Tenants
- Room allocation
- Tenant documents
- Rent transactions
- Rental reports

### Utilities
- Electricity accounts
- Meter readings
- Electricity bills
- Consumption tracking
- Water accounts
- Meter readings
- Water bills
- Consumption tracking

### Future marketplace
- Multiple organizations/sellers
- Seller onboarding
- Seller-specific catalog
- Seller branding
- Seller users/roles
- Seller inventory
- Seller orders
- Seller reports
- Future commissions
- Future payouts/settlements
- Future marketplace checkout

Do not implement future marketplace complexity prematurely. Build the foundation so that it can support it later.

---

# 3. Architecture Principles

## 3.1 Modular Monolith First

Build a modular monolith.

Do NOT introduce microservices unless a later architectural decision explicitly approves them.

Backend modules should be independently organized:

```text
auth
users
organizations
roles
permissions
catalog
inventory
customers
cart
wishlist
checkout
payments
orders
invoices
returns
discounts
purchases
suppliers
sales
expenses
ledger
investments
employees
salaries
properties
rooms
tenants
rent
utilities
reports
notifications
documents
security
audit
```

Modules may communicate through well-defined services/events/interfaces.

Avoid circular dependencies.

## 3.2 Layered Backend

Prefer:

```text
Route
  ↓
Controller
  ↓
Service / Domain Logic
  ↓
Repository / Model
  ↓
Database / External Integration
```

Controllers must remain thin.

Business rules belong in services/domain logic, not controllers.

Repositories should handle persistence concerns rather than business decisions.

## 3.3 Organization-First Multi-Tenancy

The platform must be designed for multiple organizations from the beginning.

Business-owned data should contain:

```text
organizationId
```

Backend authorization must enforce organization isolation.

Never trust:

- organizationId from the browser
- userId from the browser
- role from the browser
- permissions from the browser
- price from the browser
- inventory quantity from the browser
- discount amount from the browser

The authenticated server context is authoritative.

Every organization-scoped query must be reviewed for tenant isolation.

Object-level authorization is required in addition to authentication and role checks.

---

# 4. Security Is a First-Class Requirement

Security must NOT be postponed until the end.

Expected request security flow:

```text
Internet
 ↓
Reverse Proxy / Load Balancer
 ↓
Request ID / Trace ID
 ↓
IP / Device / Geo Enrichment
 ↓
Rate Limiting / WAF
 ↓
Authentication
 ↓
Session Validation
 ↓
Organization / Tenant Check
 ↓
Role + Permission Check
 ↓
Object-Level Authorization
 ↓
Business Operation
 ↓
Audit Log / Security Event
 ↓
Monitoring
```

## 4.1 Authentication

Implement:

- Secure password hashing
- Short-lived access tokens
- Rotating refresh-token/session strategy
- Secure logout
- Password reset
- Email/phone verification where required
- Brute-force protection
- Login rate limiting
- Account/session security
- MFA for privileged roles when enabled
- Step-up/re-authentication for sensitive operations

Never store plaintext passwords.

Never log passwords, tokens, OTPs, payment secrets or private API secrets.

## 4.2 Sessions

Maintain server-side security session records where appropriate.

A session should be capable of recording:

- session ID
- user ID
- organization ID where relevant
- device information
- IP address
- approximate GeoIP information
- created time
- last activity
- expiry
- revoked state
- refresh-token family information

Support:

- list active sessions
- revoke one session
- revoke other sessions
- revoke all sessions
- token-family reuse detection

## 4.3 IP / Device / Geo Tracking

Security telemetry may include:

- IP address
- IPv4/IPv6
- user agent
- browser/version
- operating system/version
- device type
- session ID
- request ID
- approximate country
- approximate region/city
- timezone
- approximate latitude/longitude where available

Important:

GeoIP is approximate and must NEVER be presented as exact physical location.

Configure trusted proxies correctly.

Do not blindly trust `X-Forwarded-For`.

Do not call a GeoIP provider for every request. Cache results where appropriate.

Define retention policies for security telemetry.

Avoid unnecessary permanent page-view tracking.

## 4.4 Audit Logging

Sensitive business and security actions must produce audit records.

Audit records should support:

```text
actor
organization
action
entityType
entityId
outcome
severity
requestId
correlationId
IP
userAgent
sessionId
device
safe before/after diff
timestamp
```

Examples:

- login success/failure
- logout
- password change
- role change
- permission change
- organization membership change
- product price change
- inventory adjustment
- stock transfer
- order cancellation
- refund
- expense creation/void
- purchase receiving
- salary payment
- investment movement
- tenant allocation
- rent adjustment
- document view/download
- data export
- webhook signature failure
- rate-limit violation
- suspicious login

Never place secrets in audit logs.

## 4.5 Security Events

Support detection/recording of events such as:

- repeated failed logins
- new device
- new country
- suspicious location changes
- privilege changes
- mass exports
- suspicious administrator activity
- token reuse
- IP abuse

Security alerts must be permission-protected.

---

# 5. Authorization

Authentication answers:

> Who are you?

Authorization answers:

> What are you allowed to do?

Implement:

```text
User
 ↓
Organization Membership
 ↓
Role
 ↓
Permissions
 ↓
Object-level access
```

Never implement authorization only in React.

Frontend permission checks are for UX only.

Backend permission checks are mandatory.

Use least privilege.

Privileged operations require stronger controls.

---

# 6. Data Model Rules

## 6.1 MongoDB

Use Mongoose with TypeScript.

Define explicit schemas.

Avoid uncontrolled schema flexibility for important business data.

Every important collection needs reviewed indexes.

## 6.2 Product and Variant Separation

Do not put every SKU/variant directly into an uncontrolled product document.

Use:

```text
Product
  ↓
ProductVariant
```

A variant may contain:

- SKU
- barcode
- price
- compare-at price
- cost
- attributes
- inventory references
- active/archive state

## 6.3 Inventory

Inventory is a transaction system.

Do not rely only on:

```text
product.stock = 25
```

Maintain immutable inventory transactions such as:

```text
PURCHASE
SALE
RETURN
ADJUSTMENT
TRANSFER_IN
TRANSFER_OUT
DAMAGE
OPENING_BALANCE
```

Maintain/materialize balances for fast reads.

Critical inventory operations must be atomic and auditable.

Prevent negative inventory unless an explicit business rule permits it.

## 6.4 Money

Never use binary floating-point arithmetic for financial calculations.

Prefer integer minor units consistently:

```text
₹125.50
→
12550 paise
```

Define currency explicitly.

Use Decimal128 only where the domain genuinely requires decimal precision.

Financial records must be traceable and auditable.

## 6.5 Dates

Store timestamps in UTC.

Convert to the organization's/user's timezone only for presentation and reporting.

Be explicit about date-range boundaries in reports.

---

# 7. Commerce Rules

## 7.1 Cart

The backend is authoritative for:

- product availability
- variant status
- price
- discounts
- tax
- shipping
- stock
- totals

Never trust cart totals calculated by the frontend.

## 7.2 Checkout

Checkout must revalidate:

- product existence
- variant availability
- current price
- discount eligibility
- stock
- customer/address information
- payment requirements

## 7.3 Orders

Orders must use a controlled state machine.

Do not allow arbitrary status changes.

Example:

```text
PENDING_PAYMENT
 ↓
CONFIRMED
 ↓
PROCESSING
 ↓
PACKED
 ↓
SHIPPED
 ↓
DELIVERED
```

Cancellation/return/refund states must be explicitly defined.

## 7.4 Payments

Use a payment-provider abstraction.

Never store raw card numbers, CVV or equivalent payment secrets.

Payment webhooks must have:

- signature verification
- idempotency
- replay protection where applicable
- safe event persistence
- deterministic state handling

Never trust a client-side payment-success callback as final payment confirmation.

---

# 8. Files and Documents

Use private S3-compatible object storage.

Do not expose permanent public file URLs for sensitive documents.

Use:

- signed URLs
- MIME validation
- extension validation
- size limits
- safe object keys
- access control
- optional malware scanning
- download auditing for sensitive documents

Never allow users to choose arbitrary server filesystem paths.

---

# 9. API Standards

Base URL:

```text
/api/v1
```

Use RESTful resource naming.

Example:

```text
GET    /api/v1/products
GET    /api/v1/products/:id
POST   /api/v1/products
PATCH  /api/v1/products/:id
DELETE /api/v1/products/:id
```

Use consistent response envelopes.

Example:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Errors should be structured and safe:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": []
  }
}
```

Do not expose stack traces, database internals or secrets in production responses.

Sensitive mutations should support idempotency keys where appropriate.

---

# 10. Validation

Validate all external input.

Validate:

- request body
- query parameters
- path parameters
- uploaded files
- webhook payloads
- pagination
- sorting
- filters

Protect against:

- MongoDB operator injection
- NoSQL injection
- XSS
- malicious file uploads
- oversized requests
- parameter abuse

Never assume frontend validation is sufficient.

---

# 11. Rate Limiting

Apply appropriate rate limits to:

- login
- registration
- OTP
- password reset
- search
- checkout
- uploads
- admin endpoints
- exports
- webhooks
- expensive reports

Use Redis-backed rate limiting when multiple API instances are involved.

Rate limits should be configurable rather than scattered as magic numbers.

---

# 12. Frontend Rules

Use:

- React
- TypeScript
- TanStack Query
- React Hook Form
- Zod/project-approved validation
- reusable UI components

Frontend responsibilities:

- user experience
- rendering
- form handling
- client-side validation
- API interaction
- permission-aware UI

Frontend must NOT be responsible for enforcing security.

Do not duplicate complex business logic unnecessarily between frontend and backend.

Shared types/validation may be used where appropriate, but backend remains authoritative.

---

# 13. Performance

Avoid:

- unbounded database queries
- loading entire collections into memory
- unnecessary nested population
- repeated API calls
- N+1 queries
- client-side filtering of large datasets
- loading all variants for every product page unnecessarily

Use:

- pagination
- indexes
- projections
- aggregation pipelines where appropriate
- caching
- background jobs
- denormalized/read models when justified

Do not optimize blindly. Measure first.

---

# 14. Redis and Background Jobs

Use Redis/BullMQ for asynchronous workloads such as:

- email
- notifications
- back-in-stock alerts
- reports
- exports
- invoice generation where appropriate
- scheduled utility/rent processing
- cleanup
- other long-running operations

Jobs must be:

- idempotent where appropriate
- retry-safe
- observable
- failure-aware

Do not move simple synchronous business logic into queues without a reason.

---

# 15. Testing Requirements

Each feature should include appropriate tests.

Minimum expectations for backend features:

- unit tests for important business rules
- API/integration tests
- authorization tests
- tenant-isolation tests
- validation tests
- error-path tests

Security-sensitive modules additionally require tests for:

- unauthorized access
- cross-organization access
- privilege escalation
- IDOR/object-level access
- brute-force/rate limits
- token/session behavior
- webhook verification

Commerce/financial modules additionally require:

- idempotency tests
- concurrency/consistency tests where relevant
- money calculation tests
- state-transition tests
- inventory reconciliation tests

Do not mark a task complete merely because the application starts.

---

# 16. File-Driven Development Management

Do NOT depend on an external project-management system.

The repository files are the source of truth.

```text
planning/
├── MASTER_TASK_LIST.xlsx
├── DEVELOPMENT_PROGRESS.xlsx
├── CHANGE_LOG.xlsx
├── OPEN_DECISIONS.md
├── ARCHITECTURE_DECISIONS.md
└── DEVELOPMENT_LOG.md
```

## Task workflow

```text
MASTER_TASK_LIST.xlsx
        ↓
Select next task
        ↓
Read dependencies + acceptance criteria
        ↓
Inspect existing code
        ↓
Explain implementation plan
        ↓
Developer approval
        ↓
Implement
        ↓
Run tests
        ↓
Security review
        ↓
Update DEVELOPMENT_PROGRESS.xlsx
        ↓
Update CHANGE_LOG.xlsx if required
        ↓
Update docs if required
        ↓
Git commit
        ↓
Mark task COMPLETED
        ↓
Next task
```

### Status values

```text
NOT_STARTED
READY
IN_PROGRESS
BLOCKED
IN_REVIEW
TESTING
COMPLETED
CANCELLED
```

Never mark a task complete without meeting its acceptance criteria.

---

# 17. Task Execution Rules for Claude

When asked to implement a task:

### Step 1 — Read
Read:

- `CLAUDE.md`
- `planning/MASTER_TASK_LIST.xlsx`
- relevant architecture decisions
- relevant existing documentation
- relevant source code

### Step 2 — Understand
Identify:

- objective
- dependencies
- acceptance criteria
- affected modules
- database changes
- API changes
- frontend changes
- security implications
- tests required

### Step 3 — Inspect
Before editing:

- inspect existing files
- inspect existing patterns
- inspect schemas/models
- inspect routes
- inspect services
- inspect tests
- inspect configuration

Do not create duplicate infrastructure that already exists.

### Step 4 — Plan
Explain briefly:

```text
Objective
Files likely affected
Database impact
API impact
Security impact
Testing plan
Risks
```

For architecture/security/financial decisions that materially affect the system, stop and ask the developer for approval.

### Step 5 — Implement
Implement only the approved task.

Do not perform unrelated refactoring.

Do not change architecture silently.

### Step 6 — Test
Run appropriate:

- typecheck
- lint
- unit tests
- integration tests
- security tests
- build

Fix failures caused by the implementation.

### Step 7 — Review
Verify:

- tenant isolation
- authorization
- validation
- error handling
- audit logging
- security controls
- database indexes
- concurrency/idempotency where relevant
- no secrets committed
- no sensitive data leaked

### Step 8 — Documentation
Update:

- `DEVELOPMENT_PROGRESS.xlsx`
- `CHANGE_LOG.xlsx` when appropriate
- `DEVELOPMENT_LOG.md`
- architecture decisions when applicable

### Step 9 — Git
Recommend/create a meaningful commit, for example:

```text
feat(auth): implement secure session authentication
```

Do not create huge unrelated commits.

---

# 18. Definition of Done

A task is `COMPLETED` only when:

- Acceptance criteria are satisfied
- Code follows project architecture
- TypeScript passes
- Lint passes
- Relevant tests pass
- Security checks pass
- Tenant isolation is verified where applicable
- Database indexes are reviewed
- API behavior is documented where applicable
- No secrets are committed
- Planning/progress files are updated
- Known issues are recorded
- Git commit is created/recommended

---

# 19. Change Management

If a requested change affects:

- architecture
- database strategy
- tenancy model
- authentication
- authorization
- payment flow
- financial correctness
- inventory consistency
- public API contracts
- major technology choices

do NOT silently implement it.

First:

1. Explain the impact.
2. Identify affected modules.
3. Record an open decision if needed.
4. Obtain developer approval.
5. Implement.
6. Record the final decision.

---

# 20. Important Don'ts

Never:

- build the entire application in one uncontrolled step
- skip architecture inspection
- trust frontend authorization
- trust frontend prices
- trust frontend inventory
- trust frontend organization IDs
- store plaintext passwords
- store raw card secrets
- log tokens/passwords/OTP secrets
- expose private documents publicly
- use floating-point arithmetic for money
- bypass inventory transactions
- bypass payment webhook verification
- allow arbitrary order status changes
- ignore tenant isolation
- add microservices without approval
- perform unrelated refactoring
- mark incomplete work as completed
- invent requirements
- silently make high-impact architectural decisions

---

# 21. Current Implementation Phases

```text
Phase 0 — Foundation
Phase 1 — Security & Identity
Phase 2 — Catalog
Phase 3 — Inventory
Phase 4 — Customer
Phase 5 — Commerce
Phase 6 — Business Management
Phase 7 — Rental Management
Phase 8 — Utilities
Phase 9 — Reporting
Phase 10 — Marketplace
```

Implement phases in dependency order unless an approved architecture decision changes the sequence.

---

# 22. First Development Task

The first task should be an architecture/repository analysis.

Do NOT immediately start implementing business modules.

First determine:

- current repository state
- installed tooling
- Node/npm/pnpm versions
- Git state
- existing source code
- existing package configuration
- available environment configuration
- whether MongoDB/Redis are configured
- folder structure
- documentation state
- security gaps
- dependency risks
- recommended implementation sequence

Then compare findings with `MASTER_TASK_LIST.xlsx`.

The developer must approve the implementation plan before significant code generation begins.

---

## Final Principle

Build this platform as if it will eventually handle multiple businesses, customers, employees, financial records, inventory, payments and sensitive documents.

Prefer:

**secure + auditable + modular + maintainable + testable**

over:

**fast but fragile.**

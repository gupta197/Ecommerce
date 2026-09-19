import { Types } from 'mongoose'
// Read-only use of other modules' already-public repositories — no
// modification to organizations/catalog/inventory/customers. Mirrors the
// same one-directional-dependency pattern already used throughout this
// codebase (e.g. wishlist.service.ts reading catalog's
// product-variant.repository.ts).
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as stockBalanceRepository from '../../inventory/repositories/stock-balance.repository.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import type { ProductVariantDocument } from '../../catalog/models/product-variant.model.js'

/** Resolves the caller's own Customer id from their authenticated userId —
 *  identity always comes from req.auth.userId, never a client-supplied
 *  customerId (same boundary CUST-001/COM-001 established). Uses the
 *  customers module's repository directly, not its service layer, per the
 *  approved "repositories only, not controller/route internals" boundary. */
export async function resolveCustomerId(userId: Types.ObjectId): Promise<Types.ObjectId> {
  const customer = await customerRepository.findByUserId(userId)
  if (!customer) {
    throw new NotFoundError('Customer profile not found.')
  }
  return customer._id
}

/** Archived (or, defensively, missing) customers cannot mutate their Cart —
 *  mirrors customers/address.service.ts's own assertCustomerActive exactly.
 *  Reads (GET /cart) are never gated by this check. */
export async function assertCustomerActive(customerId: Types.ObjectId): Promise<void> {
  const customer = await customerRepository.findById(customerId)
  if (!customer || customer.status === 'ARCHIVED') {
    throw new ValidationError('An archived customer profile cannot perform this action.', [
      { path: 'customerId', message: 'Customer profile is archived' },
    ])
  }
}

/**
 * Validates a client-supplied organizationId is never trusted as
 * authorization by itself — it must reference a real, ACTIVE organization.
 * This does NOT use SEC-002's resolveOrganizationContext/requirePermission
 * middleware: those require an OrganizationMembership, which customers
 * never have. This is a read-only existence+status check only, no
 * membership concept — deliberately not a new authorization mechanism.
 */
export async function assertValidOrganization(organizationId: Types.ObjectId): Promise<void> {
  const organization = await organizationRepository.findById(organizationId)
  if (!organization) {
    throw new ValidationError('organizationId does not reference an existing organization.', [
      { path: 'organizationId', message: 'Organization not found' },
    ])
  }
  if (organization.status !== 'ACTIVE') {
    throw new ValidationError('This organization is not currently active.', [
      { path: 'organizationId', message: 'Organization is not active' },
    ])
  }
}

/**
 * The authoritative tenant relationship is the ProductVariant's own
 * organizationId, not the client-supplied one: `findById` filters by
 * `{_id, organizationId}` together, so a variant genuinely belonging to a
 * different organization is indistinguishable from nonexistent — never
 * trusted from a syntactically valid ObjectId alone. Rejects an ARCHIVED
 * variant — a new CartItem can never reference one (an existing CartItem's
 * variant being archived afterward is handled separately in
 * cart.service.ts, never here).
 */
export async function assertValidVariant(
  organizationId: Types.ObjectId,
  variantId: Types.ObjectId,
): Promise<ProductVariantDocument> {
  const variant = await productVariantRepository.findById(organizationId, variantId)
  if (!variant) {
    throw new ValidationError(
      'variantId does not reference an existing product variant in this organization.',
      [{ path: 'variantId', message: 'Variant not found' }],
    )
  }
  if (variant.status === 'ARCHIVED') {
    throw new ValidationError('An archived variant cannot be used for this action.', [
      { path: 'variantId', message: 'Variant is archived' },
    ])
  }
  return variant
}

const STOCK_SUM_PAGE_LIMIT = 1000

/**
 * Sums StockBalance.quantityOnHand across every location for this
 * variant+organization — informational only (GET /cart's availability
 * indicator). Cart never reserves inventory and never mutates StockBalance;
 * this is a plain read reusing INV-001's existing, unmodified
 * stock-balance.repository.ts `list()`, the same technique COM-001 already
 * established. A 1000-row page is a pragmatic bound — no organization is
 * expected to have anywhere near that many locations for a single variant.
 */
export async function getAggregateStock(
  organizationId: Types.ObjectId,
  variantId: Types.ObjectId,
): Promise<number> {
  const { items } = await stockBalanceRepository.list(
    organizationId,
    { variantId },
    { page: 1, limit: STOCK_SUM_PAGE_LIMIT },
  )
  return items.reduce((sum, item) => sum + item.quantityOnHand, 0)
}

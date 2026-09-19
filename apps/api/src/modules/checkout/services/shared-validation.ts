import { Types } from 'mongoose'
// Read-only use of other modules' already-public repositories — no
// modification to organizations/customers/inventory. Mirrors the same
// one-directional-dependency pattern already used throughout this codebase
// (e.g. cart.service.ts reading organizations'/inventory's repositories).
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import * as stockBalanceRepository from '../../inventory/repositories/stock-balance.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

/** Resolves the caller's own Customer id from their authenticated userId —
 *  identity always comes from req.auth.userId, never a client-supplied
 *  customerId (same boundary every prior commerce module established). */
export async function resolveCustomerId(userId: Types.ObjectId): Promise<Types.ObjectId> {
  const customer = await customerRepository.findByUserId(userId)
  if (!customer) {
    throw new NotFoundError('Customer profile not found.')
  }
  return customer._id
}

/** Archived (or, defensively, missing) customers cannot preview or confirm
 *  checkout — mirrors every other module's assertCustomerActive exactly. */
export async function assertCustomerActive(customerId: Types.ObjectId): Promise<void> {
  const customer = await customerRepository.findById(customerId)
  if (!customer || customer.status === 'ARCHIVED') {
    throw new ValidationError('An archived customer profile cannot check out.', [
      { path: 'customerId', message: 'Customer profile is archived' },
    ])
  }
}

/**
 * Validates a client-supplied organizationId is never trusted as
 * authorization by itself — it must reference a real, ACTIVE organization.
 * This does NOT use SEC-002's resolveOrganizationContext/requirePermission
 * middleware: those require an OrganizationMembership, which customers
 * never have. This is a read-only existence+status check only, the same
 * one every prior customer-facing commerce module (COM-001, COM-002) uses.
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

const STOCK_SUM_PAGE_LIMIT = 1000

/**
 * Sums StockBalance.quantityOnHand across every location for this
 * variant+organization — the same aggregate-availability check COM-001/
 * COM-002 already established, reused unmodified. A plain read; checkout
 * never mutates StockBalance and never reserves inventory.
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

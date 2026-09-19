import { Types } from 'mongoose'
import { CartModel, type CartDocument } from '../models/cart.model.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CartKey {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
}

// customerId is a mandatory scoping parameter on every function here — the
// same IDOR-prevention convention every other module uses.
export async function findById(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<CartDocument | null> {
  return CartModel.findOne({ _id: id, customerId })
}

/** Read-only lookup — never creates. Used by GET /cart and the clear-cart
 *  operation, both of which must treat "no Cart yet" as an empty result,
 *  never as a reason to create one (approved COM-002 correction #2). */
export async function findByCustomerAndOrganization(key: CartKey): Promise<CartDocument | null> {
  return CartModel.findOne({ customerId: key.customerId, organizationId: key.organizationId })
}

/**
 * Atomically ensures a Cart exists for (customerId, organizationId) and
 * returns it — a single upsert-find, never "read then decide to create in
 * application code." This is the ONLY place a Cart document is ever created
 * (POST /cart/items, via cart.service.ts's addCartItem).
 *
 * Two concurrent first-adds for the same (customer, organization) race on
 * the {customerId, organizationId} unique index: MongoDB itself can surface
 * a duplicate-key error from `findOneAndUpdate`'s upsert path when two
 * writers attempt to insert the same key at the same instant (the same
 * documented race stock-balance.repository.ts's incrementOrCreate already
 * guards against) — the catch below retries as a plain, non-upsert find,
 * which is guaranteed to succeed once the winning writer's insert has
 * committed.
 */
export async function findOrCreate(key: CartKey): Promise<CartDocument> {
  const filter = { customerId: key.customerId, organizationId: key.organizationId }
  try {
    const cart = await CartModel.findOneAndUpdate(
      filter,
      { $setOnInsert: filter },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    )
    return cart as CartDocument
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await CartModel.findOne(filter)
      if (existing) {
        return existing
      }
    }
    throw error
  }
}

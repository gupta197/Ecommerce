import mongoose, { Schema, type Types } from 'mongoose'

// Extended additively by COM-004 (ADR-027) from COM-003's original
// ['PENDING_PAYMENT']-only enum, per CLAUDE.md §7.3's own state-machine
// description. Returns are deliberately NOT a value here — a separate
// ReturnRequest collection (modules/returns/) owns the entire return
// workflow; CANCELLED is the only non-fulfillment terminal state. This enum
// only lists valid values — it does not itself encode which transitions
// are legal; see order.service.ts's ORDER_TRANSITIONS for the enforced
// edges (e.g. PROCESSING -> CANCELLED is deliberately NOT a legal edge in
// this tranche, since no staff-cancellation caller exists yet).
export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export interface OrderItemAttrs {
  variantId: Types.ObjectId
  productId: Types.ObjectId
  // name/sku/price/subtotal are a SNAPSHOT captured at checkout confirmation
  // time — never re-resolved from the live catalog afterward. This is the
  // deliberate opposite of Cart/CartItem's own no-snapshot design (ADR-025):
  // Cart must always reflect current truth, but an Order is a financial
  // record that must remain a faithful account of what was actually agreed
  // to, even if the product is later renamed, repriced, or archived.
  name: string
  sku: string
  price: number
  quantity: number
  subtotal: number
}

// A snapshot of an Address document's shipping-relevant fields (never a
// live reference) — the same immutability reasoning as OrderItemAttrs
// above, applied to CUST-001's Address. isDefaultBilling/isDefaultShipping
// are deliberately not captured; they are Address-lifecycle concerns, not
// facts about this order.
export interface OrderAddressSnapshot {
  recipientName: string
  phone?: string
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  country: string
}

export interface OrderAttrs {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  items: OrderItemAttrs[]
  subtotal: number
  total: number
  status: OrderStatus
  shippingAddress: OrderAddressSnapshot
  billingAddress: OrderAddressSnapshot
  // --- COM-004 additive lifecycle/tracking fields (ADR-027) ---
  // Cancellation. cancelledBy is deliberately NOT a separate field — "who"
  // cancelled is already captured by the order.cancelled AuditEvent's own
  // actorUserId, and duplicating it here would be a second, driftable place
  // to track the same fact.
  cancellationReason?: string
  cancelledAt?: Date
  // Tracking — plain opaque strings entered by a (future, not-yet-built)
  // staff action, never resolved via any external carrier API, and never
  // writable by any customer-facing route in this tranche.
  carrier?: string
  trackingNumber?: string
  shippedAt?: Date
  // Populated when transitioning to DELIVERED — the basis a future,
  // explicitly-approved return-window policy would measure against
  // (no window duration is enforced in this tranche; see returns/README.md).
  deliveredAt?: Date
  createdAt: Date
  updatedAt: Date
}

const orderAddressSchema = new Schema<OrderAddressSnapshot>(
  {
    recipientName: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 20 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    postalCode: { type: String, required: true, trim: true, maxlength: 20 },
    country: { type: String, required: true, trim: true, maxlength: 100 },
  },
  { _id: false },
)

const orderItemSchema = new Schema<OrderItemAttrs>(
  {
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    sku: { type: String, required: true, trim: true },
    // Integer minor units (ADR-008), same convention as ProductVariant.price.
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
)

const orderSchema = new Schema<OrderAttrs>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    // No ref: 'Organization' — matches every other module's cross-tenant
    // organizationId convention.
    organizationId: { type: Schema.Types.ObjectId, required: true },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items: OrderItemAttrs[]) => items.length > 0,
        message: 'An order must contain at least one item',
      },
    },
    subtotal: { type: Number, required: true, min: 0 },
    // Equal to subtotal in COM-003 (no tax/discount/shipping engine exists
    // yet) but kept as its own persisted field so a future task can
    // populate it additively without a schema migration.
    total: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ORDER_STATUSES, required: true, default: 'PENDING_PAYMENT' },
    shippingAddress: { type: orderAddressSchema, required: true },
    billingAddress: { type: orderAddressSchema, required: true },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
    cancelledAt: { type: Date },
    carrier: { type: String, trim: true, maxlength: 100 },
    trackingNumber: { type: String, trim: true, maxlength: 100 },
    shippedAt: { type: Date },
    deliveredAt: { type: Date },
  },
  {
    collection: 'orders',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// Added by COM-004 (ADR-027) now that real read patterns exist:
// {customerId} backs "this customer's own order list" (GET /api/v1/orders),
// sorted by recency; {organizationId, status} is forward-justified for a
// future staff order-listing/queue view (not built in this tranche — no
// route exposes it yet — but the exact, stated purpose of this task's own
// "tracking" requirement, not a speculative addition).
orderSchema.index({ customerId: 1, createdAt: -1 })
orderSchema.index({ organizationId: 1, status: 1 })

export type OrderDocument = mongoose.HydratedDocument<OrderAttrs>

export const OrderModel = mongoose.model<OrderAttrs>('Order', orderSchema)

import mongoose, { Schema, type Types } from 'mongoose'

// Only the initial state COM-003 ever sets. COM-004 ("Order lifecycle,
// tracking, cancellation and returns") will extend this enum additively
// (CONFIRMED, PROCESSING, PACKED, SHIPPED, DELIVERED, CANCELLED, etc. per
// CLAUDE.md §7.3) when that task is approved — no future state is
// pre-declared here, the same discipline already applied to Cart's own
// deferred status field (ADR-025).
export const ORDER_STATUSES = ['PENDING_PAYMENT'] as const
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

// Deliberately NO secondary index in COM-003 — this collection is
// write-only from this task's own perspective (no order-listing/lookup
// route exists yet). Adding a {customerId}/{organizationId} index now,
// before any query pattern needs it, would be building COM-004's own
// infrastructure ahead of that task's approval. COM-004 will add whatever
// indexes its actual read patterns require.

export type OrderDocument = mongoose.HydratedDocument<OrderAttrs>

export const OrderModel = mongoose.model<OrderAttrs>('Order', orderSchema)

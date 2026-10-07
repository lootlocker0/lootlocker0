import type { Allergen, OrderStatus, PaymentMethod, Rarity } from "@prisma/client";

/**
 * Shapes copied 1:1 from docs/API-CONTRACT.md §6a. This file has no runtime
 * behaviour — it exists so every admin component imports the same field
 * names instead of re-declaring `AdminOrder` five slightly different ways.
 */

export type AdminOrderItem = {
  productId: string;
  qty: number;
  nameSnapshot: string;
  unitPriceCents: number;
  raritySnapshot: Rarity;
  allergensSnapshot: Allergen[];
};

export type AdminOrder = {
  orderNumber: string;
  pickupCode: string;
  studentName: string;
  homeroom: string | null;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  cashDueCents: number;
  paidAt: string | null;
  expiresAt: string | null;
  placedAt: string;
  allergens: Allergen[];
  items: AdminOrderItem[];
};

export type AdminProductTotal = {
  productId: string;
  nameSnapshot: string;
  qty: number;
  allergens: Allergen[];
};

export type AdminSlot = {
  id: string;
  label: string;
  startTime: string;
  location: string;
  serviceDate: string;
  // null only for a window whose (startTime, location) no longer exists in
  // the current template — a historical day the schedule has since changed
  // under. There is no PickupSlot table/`active` flag anymore; a window is
  // either in the fixed template or it isn't.
  capacity: number | null;
  bookedCount: number;
  remaining: number | null;
  counts: {
    total: number;
    listed: number;
    byStatus: Partial<Record<OrderStatus, number>>;
  };
  cashDueCents: number;
  productTotals: AdminProductTotal[];
  orders: AdminOrder[];
};

export type AdminOrdersResponse = {
  serviceDate: string;
  statuses: OrderStatus[];
  slots: AdminSlot[];
};

export type AdminErrorCode =
  | "ADMIN_UNAUTHORIZED"
  | "ADMIN_NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "ORDER_NOT_FOUND"
  | "INVALID_STATUS_TRANSITION"
  | "PICKUP_CODE_MISMATCH"
  | "CASH_NOT_COLLECTED"
  | "PAYMENT_METHOD_MISMATCH"
  | "REFUND_FAILED"
  | "STOCK_ADJUSTMENT_REJECTED"
  | "PRODUCT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "INTERNAL";

/** The error envelope from docs/API-CONTRACT.md §2, with code-specific detail
 * fields left as `unknown` — each call site narrows the ones it expects. */
export type AdminApiError = {
  code: AdminErrorCode;
  message: string;
  [detail: string]: unknown;
};

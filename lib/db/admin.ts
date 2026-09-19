import type { Allergen, OrderStatus, PaymentMethod } from "@prisma/client";
import { Allergen as AllergenEnum } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

// Shared pieces of the P4 staff admin routes. Everything here is about one
// thing: staff change an order's state while students, the Stripe webhook and
// the expiry sweep are changing it too, so no admin write may ever be a
// read-then-write.
//
// The rule every mutation in app/api/admin/** follows:
//
//   updateMany({ where: { id, status: { in: <allowed> } }, data: … })
//
// The conditional WHERE is evaluated after the row lock under READ COMMITTED,
// so of two staff phones pressing the same button exactly one matches a row —
// the same mechanism lib/db/release.ts relies on. `count === 0` then means
// somebody (or something) else moved the order first, and the handler re-reads
// to decide whether that was a harmless duplicate press or a real conflict.

/// `LL-` plus digits (lib/codes.ts). Bounded rather than pinned at five so
/// widening the number space later does not break every admin lookup.
export const ADMIN_ORDER_NUMBER_RE = /^LL-\d{4,10}$/;

/// Every field the admin routes are allowed to read off an order.
///
/// THIS IS THE PII BOUNDARY, and it is an explicit projection rather than an
/// `include` so a column added in a later phase cannot leak by default.
/// `studentName` and `homeroom` are here because staff have to identify a
/// person standing at a locker. `email` and `phone` are NOT, anywhere in P4 —
/// nothing on a pick list needs to contact a child, and the narrowest
/// projection that does the job is the one that survives a screenshot of a
/// staff tablet (CLAUDE.md §2.6).
const ADMIN_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  pickupCode: true,
  studentName: true,
  homeroom: true,
  // Not PII (an internal account reference, not a name/email/phone) — needed
  // by the cash and refund routes to award/reverse reward points. Routes in
  // this namespace build explicit response bodies rather than spreading
  // `order`, so adding this field here does not put it in front of staff.
  userId: true,
  status: true,
  paymentMethod: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  paidAt: true,
  expiresAt: true,
  createdAt: true,
  slotId: true,
  stripePaymentIntentId: true,
  items: {
    select: {
      productId: true,
      qty: true,
      nameSnapshot: true,
      unitPriceCents: true,
      raritySnapshot: true,
      allergensSnapshot: true,
    },
    orderBy: { nameSnapshot: "asc" },
  },
} as const;

export type AdminOrder = NonNullable<
  Awaited<ReturnType<typeof loadAdminOrder>>
>;

/// Resolve an order by the number printed on the pick list.
///
/// Unlike `GET /api/orders/[orderNumber]`, a plain 404 here is safe to be
/// truthful about: the caller already holds a staff session that can list every
/// order for the day, so there is no enumeration oracle left to protect.
export async function loadAdminOrder(orderNumberRaw: string) {
  // toUpperCase, not toLocaleUpperCase — this must not depend on the server's
  // locale (Turkish dotless i turns "LL" into something else).
  const orderNumber = orderNumberRaw.toUpperCase();
  if (!ADMIN_ORDER_NUMBER_RE.test(orderNumber)) {
    throw new AppError("ORDER_NOT_FOUND");
  }

  const order = await db.order.findUnique({
    where: { orderNumber },
    select: ADMIN_ORDER_SELECT,
  });
  if (!order) throw new AppError("ORDER_NOT_FOUND");
  return order;
}

/// Match the code the student read out against the order.
///
/// Normalised on both sides (trim + upper) because the alphabet in lib/codes.ts
/// is upper-case only, so normalising cannot turn one valid code into a
/// different valid code — it only forgives a phone keyboard.
///
/// Not a constant-time compare, deliberately: the caller is already
/// authenticated as staff and can read the code straight off the pick list, so
/// there is no secret here a timing side channel could reveal that the same
/// session cannot simply ask for.
export function assertPickupCodeMatches(
  order: { pickupCode: string },
  provided: string,
): void {
  if (order.pickupCode.trim().toUpperCase() !== provided.trim().toUpperCase()) {
    throw new AppError("PICKUP_CODE_MISMATCH");
  }
}

/// The union of every allergen on an order's lines, in the canonical enum order
/// so two orders never render the same set in two different sequences.
///
/// Built from `allergensSnapshot`, never from the live product (CLAUDE.md §2.5),
/// and never truncated (§2.8). This is a convenience for putting the warning at
/// the top of a bag label; it does NOT replace the per-line lists, which the
/// pick list also returns in full — an aggregate cannot tell staff *which*
/// item in the bag carries the peanuts.
const ALLERGEN_ORDER = new Map(
  Object.values(AllergenEnum).map((a, i) => [a, i] as const),
);

export function unionAllergens(
  lines: { allergensSnapshot: Allergen[] }[],
): Allergen[] {
  const set = new Set<Allergen>();
  for (const l of lines) for (const a of l.allergensSnapshot) set.add(a);
  return [...set].sort(
    (a, b) => (ALLERGEN_ORDER.get(a) ?? 99) - (ALLERGEN_ORDER.get(b) ?? 99),
  );
}

/// What is still owed in cash on this order, in integer cents.
///
/// Card orders are always 0 here — a card order that has not been paid is not
/// a debt staff collect at the locker, it is an order that never happened.
export function cashDueCents(order: {
  paymentMethod: PaymentMethod;
  paidAt: Date | null;
  status: OrderStatus;
  totalCents: number;
}): number {
  if (order.paymentMethod !== "CASH_AT_PICKUP") return 0;
  if (order.paidAt) return 0;
  // Nothing is owed on an order that was cancelled, expired or refunded.
  if (!ORDER_STILL_OWED.has(order.status)) return 0;
  return order.totalCents;
}

const ORDER_STILL_OWED: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "RESERVED",
  "PACKED",
  "PICKED_UP",
]);

/// The idempotent conditional transition every admin state change is built on.
///
/// Returns `"changed"` when this call did the work, `"noop"` when the order was
/// already in the target state (a double press, a second staff phone), and
/// throws `INVALID_STATUS_TRANSITION` when it is somewhere else entirely.
///
/// The re-read only happens on `count === 0`, so the common path is one
/// statement and the stale read can never cause a write.
export async function transitionOrderStatus(args: {
  orderId: string;
  from: readonly OrderStatus[];
  to: OrderStatus;
  extra?: { paidAt?: Date; expiresAt?: null };
}): Promise<"changed" | "noop"> {
  const { count } = await db.order.updateMany({
    where: { id: args.orderId, status: { in: [...args.from] } },
    data: { status: args.to, ...args.extra },
  });
  if (count === 1) return "changed";

  const now = await db.order.findUnique({
    where: { id: args.orderId },
    select: { status: true },
  });
  if (!now) throw new AppError("ORDER_NOT_FOUND");
  if (now.status === args.to) return "noop";
  throw new AppError("INVALID_STATUS_TRANSITION", {
    status: now.status,
    expected: [...args.from],
  });
}

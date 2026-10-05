import { db } from "@/lib/db";
import type { OrderStatus } from "@prisma/client";

/// Give back everything a PENDING order was holding: its stock and its seat.
///
/// Shared by the Stripe failure handler and the expiry sweep, which means it
/// will run concurrently with itself on the same order (the sweep expires an
/// order at the same moment `payment_intent.canceled` arrives for it). It has to
/// be idempotent, and it is — but not because of a check. See below.
export async function releaseOrder(
  orderId: string,
  finalStatus: Extract<OrderStatus, "CANCELLED" | "EXPIRED">,
): Promise<{ released: boolean }> {
  return db.$transaction(
    async (tx) => {
      // The conditional update IS the lock. `WHERE id = ? AND status = 'PENDING'`
      // is evaluated after the row lock is taken, so of two concurrent releases
      // exactly one matches a row and the other matches zero and stops. A
      // `findUnique` then `if (status === "PENDING")` would let both through and
      // restock the same snacks twice.
      // Flipping status and releasing the pickup-window seat in the same
      // conditional UPDATE: there's no separate pickup-slot row anymore, so
      // "give the seat back" is just excluding this order from the next
      // book_pickup_window()/GET-/api/slots COUNT(*), which setting
      // seatReleasedAt does directly. seat_released_only_when_terminal in
      // manual_constraints.sql backstops this against ever being set outside
      // a status that actually means "released".
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: "PENDING" },
        data: { status: finalStatus, expiresAt: null, seatReleasedAt: new Date() },
      });
      if (count === 0) return { released: false };

      // ── Lock ordering. This is not cosmetic. ───────────────────────────────
      // The checkout transaction reserves product rows in ascending id order
      // (reserve_stock). This function follows the same order. There used to
      // be a pickup-slot row in this chain too (book_slot, then products
      // ascending) — gone now, since releasing a seat is just the UPDATE
      // above, with no second row for this function or book_pickup_window()'s
      // advisory lock to ever contend over. backend.md §6 historically got
      // the product ordering backwards and unsorted, which is an ABBA
      // deadlock against a concurrent checkout on the same product, and a
      // second ABBA deadlock between two concurrent releases of two orders
      // sharing two products. Postgres resolves a deadlock by killing one
      // side, so both would surface as a 500 in the middle of a lunch rush
      // rather than as anything a client can handle.

      // This orderBy is currently redundant, not decorative — leave it. qa
      // deleted it and ran eight concurrent releases of two orders sharing two
      // products (docs/HANDOFF.md §35.2): nothing changed, because
      // OrderItem's `@@unique([orderId, productId])` makes an unordered
      // `findMany` on `orderId` come back in productId-ascending order anyway.
      // The lock ordering this function needs is currently guarded by that
      // index, not by this line. If the unique constraint is ever dropped, or
      // the query planner ever picks a sequential scan, this sort is the only
      // thing standing between two concurrent releases and a deadlock.
      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: { productId: true, qty: true },
        orderBy: { productId: "asc" },
      });

      for (const i of items) {
        // Restock is unbounded on purpose — there is no "original stock" to
        // clamp to. The known consequence: if staff already adjusted stock by
        // hand for this order, the release double-counts it. Nothing in the
        // database prevents that (docs/HANDOFF.md §7).
        await tx.$executeRaw`
          UPDATE products
             SET stock_qty  = stock_qty + ${i.qty},
                 updated_at = now()
           WHERE id = ${i.productId}
        `;
      }

      return { released: true };
    },
    {
      // Matches the checkout transaction, and matches what the SQL functions in
      // manual_constraints.sql are written against: under READ COMMITTED a
      // blocked UPDATE re-reads the row after acquiring the lock. Stated
      // explicitly so a database whose default is REPEATABLE READ cannot turn
      // this into serialization failures.
      isolationLevel: "ReadCommitted",
      maxWait: 5_000,
      timeout: 15_000,
    },
  );
}

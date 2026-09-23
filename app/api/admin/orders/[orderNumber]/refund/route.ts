import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import { requireAdminSession } from "@/lib/admin-session";
import { adminRefundSchema } from "@/lib/validation";
import { refundOrderPayment } from "@/lib/stripe/payments";
import { loadAdminOrder } from "@/lib/db/admin";
import { getPointsPerDollar, pointsForSubtotal, reverseRewardPoints } from "@/lib/rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MANUAL REFUND. Money goes back to a family.
//
// ── The amount is never negotiable ───────────────────────────────────────────
// There is no amount in the request body and there will not be one. The refund
// is `order.totalCents` as stored — the figure the server itself computed from
// database prices at checkout and wrote behind the `order_total_consistent`
// CHECK constraint (CLAUDE.md §2.2). A staff-supplied amount is a
// client-supplied money value with a friendlier name, and the one thing worse
// than refunding the wrong amount is doing it because a text field said so.
//
// Partial refunds are therefore not possible here. That is a real limitation
// and it is deliberate: partial refunds need a policy (who may, for what, and
// does the student's daily cap get the money back) before they need an
// endpoint. Flagged in docs/HANDOFF.md.
//
// ── Order of operations, and why it is this way round ────────────────────────
//   1. read and validate eligibility
//   2. refund at Stripe (card only), idempotency-keyed on the order id
//   3. conditionally move the order to REFUNDED
//
// Step 3 after step 2, not before. If step 3 fails, the money is back with the
// family and our order still says PAID — visibly wrong, and self-healing,
// because Stripe's own `charge.refunded` webhook arrives and writes REFUNDED.
// The reverse order fails the other way: an order marked REFUNDED for money
// that never moved, which nothing corrects and nobody notices until a parent
// asks. Between "we refunded and our books lag" and "our books say we refunded
// and we did not", only the first is recoverable.
//
// Concurrency: two staff pressing refund both reach Stripe with the SAME
// idempotency key (`re_<orderId>`), so Stripe creates one refund and returns it
// twice. Then exactly one of them matches the conditional UPDATE. One refund,
// one status change, whichever way the requests interleave.

/// Money actually moved and the order is still ours to refund.
///
/// `CANCELLED` and `EXPIRED` are excluded ON PURPOSE, and this is the direct
/// answer to docs/HANDOFF.md §50(c): those are exactly the statuses whose stock
/// and seat were ALREADY given back by the release path. Refunding them here
/// would produce a REFUNDED row indistinguishable from one whose stock is still
/// held — and the standing instruction to staff is "a refund does not restock,
/// adjust inventory by hand", which applied to that row restocks a second time
/// and oversells. Since every status this route accepts still holds its stock,
/// `stockStillHeld: true` in the response is a fact, not a guess.
///
/// `PENDING` is excluded because no money has been taken yet; the sweep or a
/// `payment_intent.canceled` is what ends those, and both release properly.
/// `RESERVED` is excluded because an unpaid cash order is a cancellation, not a
/// refund — and there is no cancel route yet (docs/HANDOFF.md).
const REFUNDABLE_FROM = ["PAID", "PACKED", "PICKED_UP"] as const;

/// Statuses where the bag has NOT yet been handed over, so the pickup window's
/// seat can honestly be given back if staff ask for it.
const SEAT_RELEASABLE_FROM = ["PAID", "PACKED"] as const;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ orderNumber: string }> },
) {
  try {
    const { sessionId } = requireAdminSession(req);
    const { orderNumber } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new AppError("INVALID_INPUT", {
        fields: { _body: ["Request body must be JSON."] },
      });
    }
    const parsed = adminRefundSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const { releaseSlotSeat } = parsed.data;

    const order = await loadAdminOrder(orderNumber);

    // ── 1. Eligibility ───────────────────────────────────────────────────────

    if (order.status === "REFUNDED") {
      // Idempotent. Includes the case where Stripe's own webhook got here
      // first, which is the normal outcome of refunding from the dashboard.
      return Response.json(
        {
          orderNumber: order.orderNumber,
          status: "REFUNDED",
          changed: false,
          refundedCents: order.totalCents,
          stockStillHeld: true,
          itemsToAdjust: adjustmentHint(order.items),
          slotSeatReleased: false,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (!(REFUNDABLE_FROM as readonly string[]).includes(order.status)) {
      throw new AppError("INVALID_STATUS_TRANSITION", {
        status: order.status,
        expected: [...REFUNDABLE_FROM],
      });
    }

    const isCard = order.paymentMethod === "CARD";

    if (!isCard && !order.paidAt) {
      // A cash order nobody ever paid for. There is no money to send back, and
      // saying "refunded" would put a fiction in the books.
      throw new AppError("CASH_NOT_COLLECTED", { totalCents: order.totalCents });
    }

    // ── 2. The payment provider, card only ───────────────────────────────────

    let stripeRefundId: string | null = null;
    let alreadyRefundedAtStripe = false;

    if (isCard) {
      if (!order.stripePaymentIntentId) {
        // A PAID card order always has an intent id — the webhook found the
        // order BY that id. Missing means the row was hand-edited or the
        // payment was never really ours. Refuse loudly rather than marking an
        // order refunded with no money movement behind it.
        logEvent("admin_refund_no_intent", { orderId: order.id, sessionId });
        throw new AppError("REFUND_FAILED", { reason: "NO_PAYMENT_INTENT" });
      }

      try {
        const refund = await refundOrderPayment({
          orderId: order.id,
          intentId: order.stripePaymentIntentId,
          // Our books, not Stripe's charge total. If the two ever disagree,
          // what we recorded taking is what we owe back.
          amountCents: order.totalCents,
        });
        stripeRefundId = refund.id || null;
        alreadyRefundedAtStripe = refund.alreadyRefunded;
      } catch (e) {
        // The order stays exactly where it was. Nothing here is half-done: the
        // status change has not been attempted yet.
        logEvent("admin_refund_provider_failed", {
          orderId: order.id,
          sessionId,
        });
        console.error("[admin refund]", order.id, e);
        throw new AppError("REFUND_FAILED", { reason: "PROVIDER_ERROR" });
      }
    }

    // Computed before the transaction (a plain settings read), reversed
    // inside it, only if this call is the one that actually moves the order
    // to REFUNDED. Gated on `order.paidAt`, never `order.status` —
    // `REFUNDABLE_FROM` above includes PACKED, and a cash order can sit
    // PACKED with `paidAt` still null (bagged before the money was
    // collected), in which case no points were ever awarded to reverse.
    const pointsToReverse = order.paidAt && order.userId
      ? pointsForSubtotal(order.subtotalCents, await getPointsPerDollar())
      : 0;

    // ── 3. The books ─────────────────────────────────────────────────────────
    //
    // Lock order inside this transaction is order row -> slot row, matching
    // lib/db/release.ts (order -> slot -> products) and compatible with the
    // global order the checkout transaction takes (mailbox -> slot ->
    // products). Taking the slot before the order row here would be an ABBA
    // deadlock against a concurrent release.
    const result = await db.$transaction(
      async (tx) => {
        // Split into two conditional updates rather than one, because whether
        // the seat may be released depends on which status we transitioned
        // FROM — and reading the status first and then updating is precisely
        // the read-then-write this codebase does not do. The two WHERE clauses
        // are mutually exclusive, so at most one can match.
        const beforeHandover = await tx.order.updateMany({
          where: { id: order.id, status: { in: [...SEAT_RELEASABLE_FROM] } },
          data: { status: "REFUNDED", expiresAt: null },
        });

        let seatReleased = false;

        if (beforeHandover.count === 1) {
          if (releaseSlotSeat) {
            // GREATEST(…, 0) matches lib/db/release.ts. Reachable at most once
            // per order because the conditional update above gates it, so the
            // floor is a backstop here rather than the thing doing the work.
            await tx.$executeRaw`
              UPDATE pickup_slots
                 SET booked_count = GREATEST(booked_count - 1, 0),
                     updated_at   = now()
               WHERE id = ${order.slotId}
            `;
            seatReleased = true;
          }
          if (order.paidAt && order.userId) {
            await reverseRewardPoints(tx, order.userId, pointsToReverse);
          }
          return { changed: true, seatReleased };
        }

        const afterHandover = await tx.order.updateMany({
          // Already handed over: the seat's handout throughput was genuinely
          // consumed, so it is never given back regardless of what was asked.
          where: { id: order.id, status: "PICKED_UP" },
          data: { status: "REFUNDED", expiresAt: null },
        });
        if (afterHandover.count === 1) {
          if (order.paidAt && order.userId) {
            await reverseRewardPoints(tx, order.userId, pointsToReverse);
          }
          return { changed: true, seatReleased };
        }

        // Somebody moved it between the eligibility read and here — most
        // likely Stripe's `charge.refunded` webhook for the refund we just
        // created, which is a benign race and lands on the same end state.
        // Points were already reversed by that webhook delivery; reversing
        // again here would double-count, so nothing happens on this path.
        return { changed: false, seatReleased };
      },
      { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 15_000 },
    );

    logEvent("admin_refund_recorded", {
      orderId: order.id,
      sessionId,
      totalCents: order.totalCents,
      paymentMethod: order.paymentMethod,
      changed: result.changed,
      seatReleased: result.seatReleased,
      alreadyRefundedAtStripe,
      // The Stripe refund id is not PII and is the thread back to the money.
      ...(stripeRefundId ? { stripeRefundId } : {}),
    });
    if (result.changed && order.paidAt && order.userId && pointsToReverse > 0) {
      logEvent("reward_points_reversed", {
        orderId: order.id,
        userId: order.userId,
        points: pointsToReverse,
      });
    }

    return Response.json(
      {
        orderNumber: order.orderNumber,
        status: "REFUNDED",
        changed: result.changed,
        refundedCents: order.totalCents,
        paymentMethod: order.paymentMethod,
        /// true when Stripe reported the charge was already fully refunded, so
        /// this call moved no money. The order is still recorded REFUNDED,
        /// because that is the true state.
        alreadyRefundedAtStripe,
        /// ALWAYS true from this route, and it is a fact rather than a default:
        /// every status it accepts still holds its stock, and a refund does not
        /// restock (CLAUDE.md, and the same rule the Stripe webhook follows).
        /// Staff must adjust inventory by hand — `itemsToAdjust` is exactly
        /// what to adjust and by how much.
        stockStillHeld: true,
        itemsToAdjust: adjustmentHint(order.items),
        /// Whether the pickup window got its seat back. Only ever true when
        /// `releaseSlotSeat` was requested AND the bag had not been handed over.
        slotSeatReleased: result.seatReleased,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/// Exactly what staff would have to put back on the shelf, and the delta to
/// send to the stock route to do it. Built from the line snapshots, so a
/// product renamed since the order still reads the way the bag is labelled.
function adjustmentHint(
  items: {
    productId: string;
    qty: number;
    nameSnapshot: string;
  }[],
) {
  return items.map((i) => ({
    productId: i.productId,
    nameSnapshot: i.nameSnapshot,
    qty: i.qty,
    /// The value to POST to /api/admin/products/[productId]/stock IF — and only
    /// if — the snack is physically back on the shelf. It very often is not:
    /// a refund usually happens because the item was wrong, damaged, or already
    /// eaten. Nothing applies this automatically for exactly that reason.
    suggestedDelta: i.qty,
  }));
}

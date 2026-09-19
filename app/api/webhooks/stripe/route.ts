import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { db } from "@/lib/db";
import { releaseOrder } from "@/lib/db/release";
import { sendConfirmationEmail } from "@/lib/email";
import { logEvent } from "@/lib/log";
import { awardRewardPoints, getPointsPerDollar, pointsForSubtotal, reverseRewardPoints } from "@/lib/rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The only writer of PAID (CLAUDE.md §2.3). A client reporting
// `status === "succeeded"` never flips an order; this handler does, and only
// after Stripe's signature checks out.
//
// Not rate limited, deliberately. The signature check is the authentication and
// a limiter here would drop legitimate bursts of retries from Stripe.

/// How long a claimed-but-unfinished `webhook_events` row is believed to belong
/// to a request that is still running (docs/HANDOFF.md §32).
///
/// The number has to sit between two bounds:
///
///   lower — longer than this handler can possibly take. Its slowest path is
///     `releaseOrder`, whose own transaction is capped at maxWait 5s +
///     timeout 15s, and the platform kills the function well before a minute.
///     Three minutes is roughly six times the worst case, so a live request is
///     never mistaken for a corpse and two processes never dispatch one event
///     concurrently.
///   upper — shorter than Stripe's retry cadence, which backs off from a few
///     minutes to hours over three days. The first retry after a crash lands
///     outside this window, so the recovery costs one retry, not a day of them.
///
/// Both failure directions are asymmetric and that is why it is nearer the
/// lower bound than the upper: too long only delays recovery by one Stripe
/// retry, while too short risks reprocessing an event whose first delivery is
/// still in flight. Every handler below is idempotent, so even that is
/// survivable — but "survivable" is not the bar for money.
const WEBHOOK_CLAIM_STALE_MS = 3 * 60_000;

/// Below this, a claim is trusted as in-flight with a 200 ("already
/// processed"), the same as today. At or above it — and still short of
/// `WEBHOOK_CLAIM_STALE_MS` — the claim is genuinely ambiguous: this handler
/// finishes in milliseconds, so a claim that is already several seconds old
/// and still unfinished is starting to look like a corpse, but it is too soon
/// to be sure. A 200 here would tell Stripe to stop retrying an event that may
/// never actually get processed — the crash-plus-in-window-retry gap docs/
/// HANDOFF.md §32 "Residual 2" describes, where the very mechanism meant to
/// protect concurrent deliveries becomes a second, narrower way to lose one.
/// So this band answers a retryable failure instead of a trusting 200: never
/// tell Stripe the event is handled while there is real doubt. The two-tier
/// split still keeps genuinely-simultaneous duplicate deliveries idempotent —
/// they finish within milliseconds of each other, comfortably inside the
/// trust window — while closing the door a same-value single threshold left
/// open.
const WEBHOOK_CLAIM_TRUST_MS = 10_000;

type ClaimOutcome = "claimed" | "reclaimed" | "duplicate" | "ambiguous";

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "P2002"
  );
}

/// Phase one of the two-phase claim: take the event, or decline it.
///
/// Returns "duplicate" when this delivery must not be dispatched — either the
/// event is genuinely finished, or another request holds a fresh claim on it.
async function claimWebhookEvent(
  id: string,
  type: string,
): Promise<ClaimOutcome> {
  // Two passes at most. The second exists for one narrow case: the row was
  // deleted between our failed insert and our read, by a handler that threw.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The insert IS the deduplication. Stripe retries concurrently, and a
      // `findUnique` then `create` lets two simultaneous deliveries of one event
      // both see "not processed" and both process it. Here they race on the
      // primary key instead and exactly one wins.
      await db.webhookEvent.create({ data: { id, type } });
      return attempt === 0 ? "claimed" : "reclaimed";
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }

    const existing = await db.webhookEvent.findUnique({
      where: { id },
      select: { createdAt: true, processedAt: true },
    });
    // Vanished — a failing handler deleted it. Try to take it properly.
    if (!existing) continue;

    if (existing.processedAt !== null) {
      logEvent("webhook_replay_ignored", { eventId: id });
      return "duplicate";
    }

    const trustBefore = new Date(Date.now() - WEBHOOK_CLAIM_TRUST_MS);
    if (existing.createdAt >= trustBefore) {
      // Claimed, unfinished, and seconds old: somebody else is plausibly
      // mid-dispatch right now. Trust them with a 200. This is the branch that
      // keeps genuinely concurrent duplicate delivery idempotent — three
      // simultaneous deliveries of one event still produce one `ok` and two
      // `already processed`, because a real dispatch finishes in milliseconds,
      // not seconds.
      logEvent("webhook_claim_in_flight", { eventId: id });
      return "duplicate";
    }

    const staleBefore = new Date(Date.now() - WEBHOOK_CLAIM_STALE_MS);
    if (existing.createdAt >= staleBefore) {
      // Claimed, unfinished, and old enough that "still in flight" is no
      // longer a safe assumption, but not yet old enough to reclaim outright.
      // Answering 200 here is exactly the residual gap this two-tier split
      // exists to close: it would tell Stripe the event is handled while we
      // genuinely do not know that, and a crash whose next retry lands in this
      // band would then be abandoned for good. Answer ambiguous instead — the
      // caller turns this into a retryable non-2xx, so Stripe tries again
      // later, by which point this claim has either finished (⇒ 200) or aged
      // into the reclaim window below (⇒ actually reprocessed).
      logEvent("webhook_claim_ambiguous", {
        eventId: id,
        ageMs: Date.now() - existing.createdAt.getTime(),
      });
      return "ambiguous";
    }

    // Claimed, unfinished, and old: whoever took it is not coming back (OOM,
    // timeout, kill -9). Reclaim it atomically — the WHERE clause is the lock,
    // so of two processes reclaiming the same corpse exactly one gets a row and
    // the other is told, correctly, that it lost.
    const { count } = await db.webhookEvent.updateMany({
      where: { id, processedAt: null, createdAt: { lt: staleBefore } },
      data: { createdAt: new Date(), type },
    });
    if (count === 1) {
      logEvent("webhook_claim_reclaimed", {
        eventId: id,
        type,
        abandonedAtMs: existing.createdAt.getTime(),
      });
      return "reclaimed";
    }

    logEvent("webhook_reclaim_lost", { eventId: id });
    return "duplicate";
  }

  logEvent("webhook_claim_gave_up", { eventId: id });
  return "duplicate";
}

export async function POST(req: NextRequest) {
  // ── 1. Raw body. App Router: req.text(), never req.json(). ─────────────────
  // The signature is computed over the exact bytes Stripe sent. Parsing first
  // and re-serialising changes key order and whitespace and the signature stops
  // matching — which fails closed, but fails on every single event.
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse rather than skip verification. An unverified webhook endpoint is a
    // public "mark this order paid" button.
    logEvent("webhook_secret_missing");
    return new Response("webhook not configured", { status: 500 });
  }

  let event: Stripe.Event;
  try {
    // Pure local crypto — no network call, and no Stripe account needed. This
    // is why the webhook path has no simulation seam: anything holding the
    // signing secret can drive it, including a test.
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch {
    logEvent("webhook_bad_signature");
    return new Response("bad signature", { status: 400 });
  }

  // ── 2. Replay defence, phase one: claim the event. ─────────────────────────
  // DELTA FROM backend.md §5, which inserts a bare dedupe row and treats its
  // existence as "handled". docs/HANDOFF.md §32: a hard crash between that
  // insert and the status update leaves the row behind, every Stripe retry
  // answers `already processed`, and a student is charged for an order that
  // then expires. The row is a claim now, and phase two below is what marks it
  // finished.
  const claim = await claimWebhookEvent(event.id, event.type);
  if (claim === "duplicate") {
    return new Response("already processed", { status: 200 });
  }
  if (claim === "ambiguous") {
    // Never 200 here (see WEBHOOK_CLAIM_TRUST_MS above): a 200 tells Stripe
    // this event is handled, and it is not yet safe to claim that. 409 asks
    // Stripe to retry on its normal schedule, by which point the original
    // claim has either finished for real or aged past WEBHOOK_CLAIM_STALE_MS
    // and becomes reclaimable.
    return new Response("claim ambiguous, retry", { status: 409 });
  }

  // ── 3. Dispatch. ───────────────────────────────────────────────────────────
  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await onPaid(event.data.object);
        break;
      case "payment_intent.payment_failed":
      case "payment_intent.canceled":
        await onFailed(event.data.object);
        break;
      case "charge.refunded":
        await onRefunded(event.data.object);
        break;
      default:
        logEvent("webhook_unhandled", { type: event.type });
    }
  } catch (e) {
    // Delete the dedupe row so Stripe's retry can actually reprocess. Without
    // this, one transient database error means the event is marked seen and the
    // payment is never recorded.
    await db.webhookEvent.delete({ where: { id: event.id } }).catch(() => {});
    logEvent("webhook_handler_failed", { eventId: event.id, type: event.type });
    console.error("[webhook]", event.id, e);
    // 500 tells Stripe to retry. Never 200 on a failure — a 200 is a promise
    // that the event was handled.
    return new Response("handler failed", { status: 500 });
  }

  // ── 4. Replay defence, phase two: the event is finished. ───────────────────
  // Only now is `already processed` the truth. Written after the dispatch
  // returned, so nothing but a completed handler can set it.
  try {
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });
  } catch (e) {
    // The work is done and durable; failing the response here would earn a
    // Stripe retry for an event that has already been applied. Leave the claim
    // unfinished instead: it becomes reclaimable after WEBHOOK_CLAIM_STALE_MS
    // and every handler above is idempotent, so a reprocess is a no-op.
    logEvent("webhook_mark_processed_failed", { eventId: event.id });
    console.error("[webhook] mark processed", event.id, e);
  }

  // ── 5. Return fast. ────────────────────────────────────────────────────────
  return new Response("ok", { status: 200 });
}

async function onPaid(pi: Stripe.PaymentIntent) {
  const order = await db.order.findUnique({
    where: { stripePaymentIntentId: pi.id },
    select: {
      id: true,
      status: true,
      totalCents: true,
      subtotalCents: true,
      userId: true,
    },
  });

  if (!order) {
    // Money moved and we cannot say for what. The intent's metadata carries
    // orderId/orderNumber, so this is recoverable by hand from the dashboard.
    logEvent("webhook_orphan_intent", { intentId: pi.id });
    return;
  }

  if (order.status !== "PENDING") {
    // Already paid, already expired, already cancelled. This is the normal
    // outcome of a retry or of the sweep racing a late payment, not an error.
    logEvent("webhook_noop", { orderId: order.id, status: order.status });
    return;
  }

  // Stripe's amount must match ours. A mismatch means tampering or a bug and
  // must never silently pass.
  if (pi.amount_received !== order.totalCents) {
    // DELTA FROM backend.md §5, which logs and returns. Returning alone leaves
    // the order PENDING with its `expiresAt` intact, so the sweep expires it a
    // few minutes later and releases the stock — for an order that has been
    // paid. The student is charged and has no order. Clearing the expiry
    // freezes the order out of the sweep's reach and parks it for a human;
    // status stays PENDING so nothing downstream treats it as good.
    await db.order.update({
      where: { id: order.id },
      data: { expiresAt: null },
    });
    logEvent("webhook_amount_mismatch", {
      orderId: order.id,
      stripe: pi.amount_received,
      db: order.totalCents,
    });
    return;
  }

  // Points are computed before the transaction (a plain settings read, not
  // something that needs to run inside it — same convention as checkout's
  // pre-transaction getSetting calls), but AWARDED only inside it, gated on
  // this exact call being the one that flips PENDING -> PAID. Zero when
  // there's no linked account, so a guest order's transaction below does
  // nothing extra.
  const pointsToAward = order.userId
    ? pointsForSubtotal(order.subtotalCents, await getPointsPerDollar())
    : 0;

  // Conditional on PENDING for the same reason releaseOrder is: two concurrent
  // deliveries that both got past the dedupe insert (different event ids for
  // the same intent, which Stripe does send) must not both act. Wrapped in a
  // transaction together with the reward-points award (previously a bare
  // updateMany) so a crash between "flip to PAID" and "award points" rolls
  // back both rather than leaving one without the other.
  const count = await db.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "PAID", paidAt: new Date(), expiresAt: null },
    });
    if (count === 1 && order.userId) {
      await awardRewardPoints(tx, order.userId, pointsToAward);
    }
    return count;
  });
  if (count === 0) {
    logEvent("webhook_noop_raced", { orderId: order.id });
    return;
  }

  logEvent("order_paid", { orderId: order.id, totalCents: order.totalCents });
  if (order.userId && pointsToAward > 0) {
    logEvent("reward_points_awarded", {
      orderId: order.id,
      userId: order.userId,
      points: pointsToAward,
    });
  }
  // Not awaited: the response to Stripe must not wait on a notification.
  void sendConfirmationEmail(order.id);
}

async function onFailed(pi: Stripe.PaymentIntent) {
  const order = await db.order.findUnique({
    where: { stripePaymentIntentId: pi.id },
    select: { id: true, status: true },
  });
  if (!order || order.status !== "PENDING") return;

  // releaseOrder re-checks PENDING inside its own transaction, so the read
  // above is only an optimisation — the sweep may have expired this order
  // between the two, and that case releases nothing rather than twice.
  const { released } = await releaseOrder(order.id, "CANCELLED");
  logEvent("order_payment_failed", { orderId: order.id, released });
}

async function onRefunded(charge: Stripe.Charge) {
  const piId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!piId) return;

  const before = await db.order.findUnique({
    where: { stripePaymentIntentId: piId },
    select: {
      id: true,
      status: true,
      userId: true,
      paidAt: true,
      subtotalCents: true,
    },
  });
  if (!before) {
    // Money went back for an intent we cannot name. Same recovery path as
    // webhook_orphan_intent: the intent's metadata carries the order id.
    logEvent("webhook_orphan_refund", { intentId: piId });
    return;
  }

  // DELTA FROM backend.md §5, which matches only PAID and PACKED
  // (docs/HANDOFF.md §33). Stripe does not guarantee event ordering, so
  // `charge.refunded` can arrive while the order is still PENDING — and then it
  // matched nothing, the later `payment_intent.succeeded` wrote PAID, and an
  // order whose money had been returned sat PAID forever with the snack on the
  // pick list.
  //
  // A `charge.refunded` event cannot exist for a charge that never succeeded:
  // Stripe has no way to return money that was never taken. So the payment DID
  // happen before the refund in real time, whatever order we hear about it in,
  // and collapsing straight from PENDING to REFUNDED is the correct end state.
  // `onPaid`'s `WHERE status = 'PENDING'` guard then finds zero rows when the
  // succeeded event finally shows up, and no-ops harmlessly.
  //
  // `notIn: ["REFUNDED"]` rather than a status list, for two reasons: it stays
  // idempotent (a second refund event for an already-REFUNDED order matches
  // nothing, exactly as before), and it is future-proof — a status added to the
  // enum later cannot silently become a hole a refund falls through.
  // Reversal is gated on `before.paidAt`, read here BEFORE this write touches
  // the row — never on `before.status`. `REFUNDABLE_FROM` in the admin refund
  // route includes PACKED, and a cash order can sit PACKED with `paidAt` still
  // null (bagged before the money is collected); points were never awarded for
  // that order, so there is nothing to reverse. A PENDING order (the
  // out-of-order-delivery case below) has `paidAt: null` for the same reason
  // and needs no special-casing to also reverse zero.
  const pointsToReverse = before.paidAt && before.userId
    ? pointsForSubtotal(before.subtotalCents, await getPointsPerDollar())
    : 0;

  // Wrapped in a transaction together with the reward-points reversal
  // (previously a bare updateMany), for the same reason onPaid's award is.
  const count = await db.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { stripePaymentIntentId: piId, status: { notIn: ["REFUNDED"] } },
      // `expiresAt` is cleared because the order is leaving PENDING: schema.prisma
      // says an expiry only belongs to a PENDING card order, and leaving one on a
      // REFUNDED row is a stale claim the sweep would ignore but a human would
      // misread.
      //
      // `paidAt` is deliberately NOT written. It is set by exactly one path —
      // onPaid, after the amount check — and stamping it here with the instant a
      // refund was PROCESSED would put a time in it that is not when the money
      // moved. A REFUNDED order with a null `paidAt` is legible and true ("the
      // refund reached us before the payment confirmation did", which the log
      // line below names); a fabricated timestamp in a money field is not.
      // Nothing downstream requires it: nothing outside the webhook reads paidAt.
      data: { status: "REFUNDED", expiresAt: null },
    });
    if (count === 1 && before.paidAt && before.userId) {
      await reverseRewardPoints(tx, before.userId, pointsToReverse);
    }
    return count;
  });

  if (count === 0) {
    logEvent("webhook_noop", { orderId: before.id, status: before.status });
    return;
  }

  if (before.status === "PENDING") {
    // Worth its own line: it means Stripe delivered out of order, the student
    // was charged and refunded without the order ever being confirmed here, and
    // the stock and seat below are still held for an order nobody will collect.
    logEvent("order_refunded_before_payment", { orderId: before.id });
  }

  // Stock does NOT auto-return on a refund, in any of these transitions. The
  // snack may already be packed or eaten; staff adjusts inventory by hand in
  // /admin (P4). Same for the pickup seat.
  logEvent("order_refunded", {
    intentId: piId,
    updated: count,
    previousStatus: before.status,
  });
  if (before.paidAt && before.userId && pointsToReverse > 0) {
    logEvent("reward_points_reversed", {
      orderId: before.id,
      userId: before.userId,
      points: pointsToReverse,
    });
  }
}

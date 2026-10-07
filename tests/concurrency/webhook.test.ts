import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import {
  chargeRefunded,
  confirmationsSentFor,
  countBookedOrders,
  countLogEvent,
  paymentIntentFailed,
  paymentIntentSucceeded,
  postWebhook,
  runSweep,
  seedPendingCardOrder,
  stripeEvent,
} from "../helpers";

describe("webhook idempotency", () => {
  beforeEach(resetDb);

  it("processes the same event three times with one effect", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500);

    // Sequential replay — Stripe's own retry behaviour.
    const responses = [];
    for (let i = 0; i < 3; i++) responses.push(await postWebhook(event));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.text)).toEqual([
      "ok",
      "already processed",
      "already processed",
    ]);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PAID");
    expect(after.paidAt).not.toBeNull();
    expect(after.expiresAt).toBeNull();
    expect(await testDb.webhookEvent.count()).toBe(1);
    // The notification seam fired exactly once (lib/email.ts logs rather than
    // sends — HANDOFF §23 — so the log line is the spy).
    expect(confirmationsSentFor(order.id)).toBe(1);
    expect(countLogEvent("order_paid", `"orderId":"${order.id}"`)).toBe(1);
  });

  it("handles concurrent delivery of the same event", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(
      order.stripePaymentIntentId!,
      500,
      "evt_concurrent_triple",
    );

    // Concurrent, not sequential. A check-then-insert dedupe passes the
    // sequential test above and fails this one.
    const results = await Promise.all([
      postWebhook(event),
      postWebhook(event),
      postWebhook(event),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.text === "ok")).toHaveLength(1);
    expect(await testDb.webhookEvent.count()).toBe(1);
    expect(confirmationsSentFor(order.id)).toBe(1);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PAID");

    // Re-verified explicitly against the three-band claim logic (HANDOFF §32
    // "Residual 2"), rather than assumed unaffected: genuinely simultaneous
    // duplicates land inside WEBHOOK_CLAIM_TRUST_MS (10s), so none of them may
    // take the new 409 branch. A regression that shortened the trust window
    // would turn Stripe's normal duplicate delivery into a retry storm.
    expect(results.filter((r) => r.status === 409)).toHaveLength(0);
    expect(results.filter((r) => r.text === "already processed")).toHaveLength(2);
    expect(
      countLogEvent("webhook_claim_ambiguous", `"eventId":"evt_concurrent_triple"`),
    ).toBe(0);
  });

  /**
   * Three deliveries with DIFFERENT event ids for one intent — which Stripe
   * genuinely does send. The dedupe insert cannot help here; only the
   * conditional `updateMany(where: status = PENDING)` in `onPaid` stops all
   * three from acting (HANDOFF §18.6).
   */
  it("acts once when three different event ids describe one payment", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const pi = order.stripePaymentIntentId!;

    const results = await Promise.all([
      postWebhook(paymentIntentSucceeded(pi, 500, "evt_distinct_a")),
      postWebhook(paymentIntentSucceeded(pi, 500, "evt_distinct_b")),
      postWebhook(paymentIntentSucceeded(pi, 500, "evt_distinct_c")),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await testDb.webhookEvent.count()).toBe(3);
    expect(countLogEvent("order_paid", `"orderId":"${order.id}"`)).toBe(1);
    expect(confirmationsSentFor(order.id)).toBe(1);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PAID");
  });

  it("rejects an unsigned webhook and records nothing", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 500),
      { sign: false },
    );
    expect(r.status).toBe(400);
    expect(await testDb.webhookEvent.count()).toBe(0);
    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING");
  });

  it("rejects a webhook signed with the wrong secret", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 500),
      { secret: "whsec_not_the_real_secret" },
    );
    expect(r.status).toBe(400);
    expect(r.text).toBe("bad signature");
    expect(await testDb.webhookEvent.count()).toBe(0);
  });

  it("rejects a garbage signature header", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 500),
      { signature: "t=1,v1=deadbeef" },
    );
    expect(r.status).toBe(400);
    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING");
  });

  it("ignores an amount that disagrees with the order, and freezes it", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 100), // tampered
    );
    expect(r.status).toBe(200);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING"); // must NOT be PAID
    expect(after.paidAt).toBeNull();
    // HANDOFF §18.5: the expiry is cleared so the sweep cannot release stock
    // for an order that has actually been paid. That combination — PENDING with
    // expiresAt null — is the "frozen, needs a human" signal in §27.
    expect(after.expiresAt).toBeNull();
    expect(countLogEvent("webhook_amount_mismatch", `"orderId":"${order.id}"`)).toBe(1);
  });

  it("is a no-op for an intent with no matching order", async () => {
    const r = await postWebhook(paymentIntentSucceeded("pi_orphan_qa_test", 500));
    expect(r.status).toBe(200);
    expect(countLogEvent("webhook_orphan_intent", "pi_orphan_qa_test")).toBe(1);
  });

  it("200s and records an unhandled event type without touching orders", async () => {
    const r = await postWebhook(
      stripeEvent("customer.created", { id: "cus_qa", object: "customer" }),
    );
    expect(r.status).toBe(200);
    expect(await testDb.webhookEvent.count()).toBe(1);
  });

  it("releases stock and the seat on payment_failed, exactly once", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500, stockQty: 20 });
    const productId = order.items[0].productId;
    const before = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    expect(before.stockQty).toBe(19);

    await postWebhook(paymentIntentFailed(order.stripePaymentIntentId!, "evt_fail_1"));

    const afterFirst = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterFirst.status).toBe("CANCELLED");
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty,
    ).toBe(20);
    expect(
      (await countBookedOrders(order.pickupServiceDate, order.pickupStartTime, order.pickupLocation)),
    ).toBe(0);

    // A second failure event, different id, must restock nothing.
    await postWebhook(paymentIntentFailed(order.stripePaymentIntentId!, "evt_fail_2"));
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty,
    ).toBe(20);
  });

  /**
   * The RESTRAINT half of the two-phase claim (HANDOFF §32, verification row D),
   * kept from the original `it.fails` with its fixture unchanged.
   *
   * A claim row with a default `createdAt` is, by design, indistinguishable from
   * a delivery that is still in flight — it is inside `WEBHOOK_CLAIM_TRUST_MS`
   * (10s) — so it must be trusted and answered `already processed`. Reclaiming
   * it would break the concurrent-duplicate-delivery case above. The recovery
   * half is the backdated test that follows this one; keeping both is the point.
   */
  it("trusts a seconds-old unfinished claim and leaves the order alone", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_fresh_claim");

    // Exactly what the route writes before dispatching, with `processedAt` null.
    await testDb.webhookEvent.create({
      data: { id: "evt_fresh_claim", type: "payment_intent.succeeded" },
    });

    // Stripe retries the same event id, immediately, twice.
    const r1 = await postWebhook(event);
    const r2 = await postWebhook(event);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect([r1.text, r2.text]).toEqual(["already processed", "already processed"]);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING");
    expect(after.paidAt).toBeNull();
    // The claim was not stolen, not finished, and not touched.
    const row = await testDb.webhookEvent.findUniqueOrThrow({
      where: { id: "evt_fresh_claim" },
    });
    expect(row.processedAt).toBeNull();
    expect(confirmationsSentFor(order.id)).toBe(0);
  });

  /**
   * REGRESSION for HANDOFF §32 — the recovery half, i.e. the test above with
   * the one line the fix note asks for: a `createdAt` older than
   * `WEBHOOK_CLAIM_STALE_MS`. The original `it.fails` marker could never flip
   * without it, because its fixture landed in the trust band by construction.
   *
   * This is the actual crash the original finding described — a handler killed
   * between claiming the event and recording the payment. Before the fix every
   * Stripe retry answered `already processed` forever, the order expired, and
   * the student was charged for nothing. It must now be reclaimed and processed.
   */
  it("reclaims a claim abandoned by a crashed handler and records the payment", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_crashed");

    // What a killed process leaves behind, aged past the 3-minute window.
    await testDb.webhookEvent.create({
      data: {
        id: "evt_crashed",
        type: "payment_intent.succeeded",
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    const r1 = await postWebhook(event);
    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    console.log(
      `[webhook crash recovery] retry of a 10-minute-old unfinished claim: ` +
        `response=${r1.status} "${r1.text}" status=${after.status} ` +
        `paidAt=${after.paidAt !== null} expiresAt=${after.expiresAt}`,
    );

    expect(r1.status).toBe(200);
    expect(r1.text).toBe("ok");
    // The student's money is now attached to an order, which is the whole point.
    expect(after.status).toBe("PAID");
    expect(after.paidAt).not.toBeNull();
    // And out of the sweep's reach, so the recovered order cannot be expired.
    expect(after.expiresAt).toBeNull();
    expect(countLogEvent("webhook_claim_reclaimed", `"eventId":"evt_crashed"`)).toBe(1);
    expect(confirmationsSentFor(order.id)).toBe(1);

    // The claim is finished now, so the NEXT retry is an ordinary replay again —
    // recovery must not leave the row reclaimable forever.
    const row = await testDb.webhookEvent.findUniqueOrThrow({ where: { id: "evt_crashed" } });
    expect(row.processedAt).not.toBeNull();
    const r2 = await postWebhook(event);
    expect(r2.status).toBe(200);
    expect(r2.text).toBe("already processed");
    expect(confirmationsSentFor(order.id)).toBe(1);
  });

  /**
   * REGRESSION for HANDOFF §33 (was `it.fails`, converted 2026-09-03).
   *
   * Stripe does not guarantee ordering. `charge.refunded` arriving before
   * `payment_intent.succeeded` used to match nothing (the order was still
   * PENDING), and the succeeded event then marked it PAID — an order sitting
   * PAID forever for money that had been returned, with the snack still on the
   * pick list. `onRefunded` now matches any status except REFUNDED.
   */
  it("ends REFUNDED when charge.refunded arrives before payment_intent.succeeded", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const pi = order.stripePaymentIntentId!;

    const refundFirst = await postWebhook(chargeRefunded(pi, "evt_refund_first"));
    expect(refundFirst.status).toBe(200);

    const midway = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(midway.status).toBe("REFUNDED");
    // Leaving an expiry on a non-PENDING order would be a stale claim a human
    // would misread (HANDOFF §33).
    expect(midway.expiresAt).toBeNull();

    const succeededSecond = await postWebhook(
      paymentIntentSucceeded(pi, 500, "evt_succeeded_second"),
    );
    expect(succeededSecond.status).toBe(200);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    console.log(
      `[out-of-order events] refunded-then-succeeded left status=${after.status} ` +
        `paidAt=${after.paidAt !== null}`,
    );
    // A refunded order must not be PAID.
    expect(after.status).toBe("REFUNDED");
    // Documented consequence (HANDOFF §33): `paidAt` stays null in the reversed
    // case, so it is NOT a "was this ever paid" flag for a REFUNDED order.
    expect(after.paidAt).toBeNull();
    expect(countLogEvent("order_refunded_before_payment", `"orderId":"${order.id}"`)).toBe(1);
    // The late succeeded event found nothing to do and did nothing.
    expect(countLogEvent("order_paid", `"orderId":"${order.id}"`)).toBe(0);
    expect(confirmationsSentFor(order.id)).toBe(0);
  });

  /**
   * NEW — the resource-holding half of §33's widened match, which nothing
   * asserted before.
   *
   * A refund that arrives for a still-PENDING order takes it to REFUNDED, and
   * REFUNDED never auto-releases anything. So the stock and the pickup seat this
   * order reserved are held permanently, for an order that was never collectable
   * and whose money has gone back. That is the documented rule ("erring towards
   * holding stock can never oversell") and it is deliberate — but it is a real
   * resource leak that only a human with /admin can undo, so it gets a named
   * test rather than being an implicit assumption.
   */
  it("does NOT release stock or the seat when a refund lands on a PENDING order", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500, stockQty: 20 });
    const productId = order.items[0].productId;

    // The hold the PENDING order is sitting on.
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty,
    ).toBe(19);
    expect(
      (await countBookedOrders(order.pickupServiceDate, order.pickupStartTime, order.pickupLocation)),
    ).toBe(1);

    await postWebhook(chargeRefunded(order.stripePaymentIntentId!, "evt_refund_pending"));

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("REFUNDED");

    const stock = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    const booked = await countBookedOrders(
      order.pickupServiceDate,
      order.pickupStartTime,
      order.pickupLocation,
    );
    console.log(
      `[refund on PENDING] status=${after.status} stock=${stock.stockQty}/20 ` +
        `booked=${booked} expiresAt=${after.expiresAt}`,
    );
    expect(stock.stockQty).toBe(19); // still held
    expect(booked).toBe(1); // seat still consumed

    // And nothing later frees them either: the sweep only looks at PENDING card
    // orders with an expiry, and the refund cleared the expiry. The hold is
    // permanent until staff adjusts it by hand.
    const sweep = await runSweep();
    expect(sweep.status).toBe(200);
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty,
    ).toBe(19);
    expect(
      (await countBookedOrders(order.pickupServiceDate, order.pickupStartTime, order.pickupLocation)),
    ).toBe(1);
    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("REFUNDED");
  });

  /** The same pair in the documented order works, which is what makes the above a bug. */
  it("refund after payment does mark the order REFUNDED, without restocking", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500, stockQty: 20 });
    const pi = order.stripePaymentIntentId!;
    await postWebhook(paymentIntentSucceeded(pi, 500));

    const before = await testDb.product.findUniqueOrThrow({
      where: { id: order.items[0].productId },
    });
    await postWebhook(chargeRefunded(pi));

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("REFUNDED");
    const stock = await testDb.product.findUniqueOrThrow({ where: { id: before.id } });
    expect(stock.stockQty).toBe(before.stockQty); // staff adjusts manually

    // Documented consequence (HANDOFF §21): the pickup seat is NOT freed.
    const booked = await countBookedOrders(
      order.pickupServiceDate,
      order.pickupStartTime,
      order.pickupLocation,
    );
    expect(booked).toBe(1);
  });

  /**
   * HANDOFF §46: `charge.refunded` now beats every status except REFUNDED, so
   * it is reachable from far more states than the PAID/PACKED pair it used to
   * match. Deliver it against each one and confirm the end state and that
   * neither stock nor `booked_count` moves in any of them.
   *
   * RESERVED, PACKED and PICKED_UP are set directly: they are P4 admin
   * transitions that have no route yet, and the point here is the webhook's
   * behaviour against a status, not how the order reached it.
   */
  it.each(["RESERVED", "PACKED", "PICKED_UP", "CANCELLED", "EXPIRED"] as const)(
    "takes a %s order to REFUNDED without returning stock or the seat",
    async (status) => {
      const order = await seedPendingCardOrder({ totalCents: 500, stockQty: 20 });
      await testDb.order.update({ where: { id: order.id }, data: { status } });

      const stockBefore = await testDb.product.findUniqueOrThrow({
        where: { id: order.items[0].productId },
      });
      const bookedBefore = await countBookedOrders(
        order.pickupServiceDate,
        order.pickupStartTime,
        order.pickupLocation,
      );

      const r = await postWebhook(
        chargeRefunded(order.stripePaymentIntentId!, `evt_refund_from_${status}`),
      );
      expect(r.status).toBe(200);

      const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe("REFUNDED");
      expect(after.expiresAt).toBeNull();
      expect(
        (await testDb.product.findUniqueOrThrow({ where: { id: stockBefore.id } })).stockQty,
      ).toBe(stockBefore.stockQty);
      expect(
        await countBookedOrders(order.pickupServiceDate, order.pickupStartTime, order.pickupLocation),
      ).toBe(bookedBefore);

      // Idempotent: a second refund event for the same charge matches nothing.
      const second = await postWebhook(
        chargeRefunded(order.stripePaymentIntentId!, `evt_refund_from_${status}_again`),
      );
      expect(second.status).toBe(200);
      expect(
        (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
      ).toBe("REFUNDED");
      expect(
        (await testDb.product.findUniqueOrThrow({ where: { id: stockBefore.id } })).stockQty,
      ).toBe(stockBefore.stockQty);
    },
  );

  /**
   * The same widened match, reached honestly rather than by an UPDATE: a
   * declined payment releases the stock and the seat, and a refund for that
   * intent then overwrites CANCELLED with REFUNDED.
   *
   * Worth its own test because the end state is ambiguous to a human. The rule
   * staff are given is "a refund does not restock; adjust inventory by hand" —
   * but this REFUNDED order already gave its stock back automatically when it
   * was cancelled, and nothing in the row says so. Restocking it by hand a
   * second time is a plausible P4 mistake, and it oversells.
   */
  it("overwrites an already-released CANCELLED order with REFUNDED, stock still released", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500, stockQty: 20 });
    const productId = order.items[0].productId;
    const pi = order.stripePaymentIntentId!;

    await postWebhook(paymentIntentFailed(pi, "evt_declined_then_refunded"));
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty,
    ).toBe(20); // released by the decline
    expect(
      (await countBookedOrders(order.pickupServiceDate, order.pickupStartTime, order.pickupLocation)),
    ).toBe(0);

    await postWebhook(chargeRefunded(pi, "evt_refund_after_decline"));

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    console.log(
      `[refund after decline] status=${after.status} stock=${
        (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty
      }/20 (already released by the decline)`,
    );
    expect(after.status).toBe("REFUNDED");
    // No second release: the refund handler returns nothing, which is the only
    // reason this does not become 21 units of phantom stock.
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty,
    ).toBe(20);
    expect(
      (await countBookedOrders(order.pickupServiceDate, order.pickupStartTime, order.pickupLocation)),
    ).toBe(0);
  });

  /**
   * HANDOFF §21: "`onFailed` releases stock on a payment_failed event, and a
   * student can retry the same intent afterwards. Once released, the retry
   * succeeds at Stripe but the order is CANCELLED, so `onPaid` no-ops —
   * charged, no order."
   *
   * The Stripe-side half (whether an automatic-payment-methods intent really
   * permits that retry) cannot be established without a real account. The
   * database-side half is testable, and it is the half that loses the money.
   */
  it("a payment that succeeds after a failure event is silently swallowed", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const pi = order.stripePaymentIntentId!;

    await postWebhook(paymentIntentFailed(pi, "evt_declined"));
    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("CANCELLED");

    const late = await postWebhook(paymentIntentSucceeded(pi, 500, "evt_late_success"));
    expect(late.status).toBe(200);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    // Money would have moved at Stripe; nothing here records it.
    expect(after.status).toBe("CANCELLED");
    expect(after.paidAt).toBeNull();
    expect(countLogEvent("webhook_noop", `"orderId":"${order.id}"`)).toBeGreaterThan(0);
  });
});

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
  seedPendingCardOrder,
} from "../helpers";

/**
 * The THREE-band claim in `app/api/webhooks/stripe/route.ts` — new logic that
 * nothing had attacked yet.
 *
 * docs/HANDOFF.md §32 "Residual 2" (closed by the manager, not by backend) and
 * docs/API-CONTRACT.md §6 `POST /api/webhooks/stripe`. An unfinished claim's age
 * decides the answer:
 *
 *   age <  WEBHOOK_CLAIM_TRUST_MS (10s)   → 200 "already processed"  (trusted)
 *   10s ≤ age < WEBHOOK_CLAIM_STALE_MS(3m)→ 409 "claim ambiguous, retry"  (NEW)
 *   age ≥ 3m                              → reclaimed and reprocessed
 *
 * Every fixture here plants the row a crashed handler would have left behind
 * and backdates `createdAt` to put it in a specific band. The clock is the only
 * input the route has, so the clock is the whole test surface.
 */

const TRUST_MS = 10_000;
const STALE_MS = 3 * 60_000;

/** The row a handler that claimed an event and then died leaves behind. */
async function plantUnfinishedClaim(id: string, ageMs: number, type = "payment_intent.succeeded") {
  await testDb.webhookEvent.create({
    data: { id, type, createdAt: new Date(Date.now() - ageMs) },
  });
}

describe("webhook claim bands", () => {
  beforeEach(resetDb);

  /**
   * THE NEW BAND. A claim that is 30 seconds old and still unfinished is past
   * the point where "somebody is mid-dispatch" is credible (real dispatch takes
   * milliseconds) but not yet old enough to declare dead. The route must not
   * answer 200 — a 2xx tells Stripe the event is handled and ends its retries,
   * which is precisely how the crash in §32 got lost twice over.
   */
  it("answers 409 for a claim in the ambiguous band and touches nothing", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const before = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    const productBefore = await testDb.product.findUniqueOrThrow({
      where: { id: order.items[0].productId },
    });

    await plantUnfinishedClaim("evt_ambiguous", 30_000);
    const planted = await testDb.webhookEvent.findUniqueOrThrow({
      where: { id: "evt_ambiguous" },
    });

    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_ambiguous"),
    );

    console.log(
      `[webhook claim band] 30s-old unfinished claim: response=${r.status} "${r.text}"`,
    );

    expect(r.status).toBe(409);
    expect(r.text).toBe("claim ambiguous, retry");

    // The order is untouched: not paid, not frozen, still on its clock.
    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING");
    expect(after.paidAt).toBeNull();
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(confirmationsSentFor(order.id)).toBe(0);

    // The claim itself is untouched too. Bumping `createdAt` here would reset
    // the staleness clock on every retry and the row could never age into the
    // reclaim window — an infinite 409 loop for a payment that is already lost.
    const row = await testDb.webhookEvent.findUniqueOrThrow({ where: { id: "evt_ambiguous" } });
    expect(row.processedAt).toBeNull();
    expect(row.createdAt.getTime()).toBe(planted.createdAt.getTime());

    // And no side effects anywhere else.
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productBefore.id } })).stockQty,
    ).toBe(productBefore.stockQty);
    expect(countLogEvent("webhook_claim_ambiguous", `"eventId":"evt_ambiguous"`)).toBe(1);
  });

  /**
   * All three bands in one table, so a change to either constant fails here
   * rather than in one scattered assertion. The ages are deliberately far from
   * the boundaries (2s / 30s / 10m against 10s and 3m) — a fixture planted at
   * 9.9s would be a clock-skew flake, not a test.
   */
  it.each([
    {
      label: "well inside the trust window — treated as in flight",
      ageMs: TRUST_MS / 5,
      status: 200,
      text: "already processed",
      endStatus: "PENDING",
    },
    {
      label: "three times the trust window — ambiguous",
      ageMs: TRUST_MS * 3,
      status: 409,
      text: "claim ambiguous, retry",
      endStatus: "PENDING",
    },
    {
      label: "just under the stale window — still ambiguous",
      ageMs: STALE_MS - 80_000,
      status: 409,
      text: "claim ambiguous, retry",
      endStatus: "PENDING",
    },
    {
      label: "well past the stale window — reclaimed",
      ageMs: STALE_MS + 7 * 60_000,
      status: 200,
      text: "ok",
      endStatus: "PAID",
    },
  ])("claim aged $ageMs ms: $label", async ({ ageMs, status, text, endStatus }) => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const id = `evt_band_${ageMs}`;
    await plantUnfinishedClaim(id, ageMs);

    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 500, id),
    );
    expect(r.status).toBe(status);
    expect(r.text).toBe(text);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(endStatus);
    // Only the reclaim may notify; the other two bands must stay silent.
    expect(confirmationsSentFor(order.id)).toBe(endStatus === "PAID" ? 1 : 0);
  });

  /**
   * The story §32 "Residual 2" actually promises, end to end: a delivery is
   * killed, the next retry lands while the claim is ambiguous and is told to
   * come back, and the retry after that — once the claim has aged past three
   * minutes — reclaims it and records the payment. Nothing is lost; recovery
   * costs retries, not money.
   */
  it("recovers a crashed delivery across a 409 and a later reclaim", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_recovered");

    await plantUnfinishedClaim("evt_recovered", 30_000);

    const first = await postWebhook(event);
    expect(first.status).toBe(409);
    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("PENDING");

    // Time passes (Stripe's next retry is minutes away). Ageing the row is the
    // only honest way to simulate that without sleeping for three minutes.
    await testDb.webhookEvent.update({
      where: { id: "evt_recovered" },
      data: { createdAt: new Date(Date.now() - STALE_MS - 60_000) },
    });

    const second = await postWebhook(event);
    console.log(
      `[webhook claim recovery] 409 then reclaim: first=${first.status} second=${second.status} "${second.text}"`,
    );
    expect(second.status).toBe(200);
    expect(second.text).toBe("ok");

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PAID");
    expect(after.paidAt).not.toBeNull();
    expect(confirmationsSentFor(order.id)).toBe(1);
    expect(countLogEvent("order_paid", `"orderId":"${order.id}"`)).toBe(1);
  });

  /**
   * The ambiguity resolving the OTHER way: the original handler was slow, not
   * dead. Once it marks the claim finished, the retry that was getting 409 must
   * get a plain 200 replay — not a reclaim, and not a second dispatch.
   */
  it("stops answering 409 as soon as the original claim finishes", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_slow_finisher");

    await plantUnfinishedClaim("evt_slow_finisher", 30_000);
    expect((await postWebhook(event)).status).toBe(409);

    // The slow handler finishes: it applied the payment and marked the claim.
    await testDb.order.update({
      where: { id: order.id },
      data: { status: "PAID", paidAt: new Date(), expiresAt: null },
    });
    await testDb.webhookEvent.update({
      where: { id: "evt_slow_finisher" },
      data: { processedAt: new Date() },
    });

    const r = await postWebhook(event);
    expect(r.status).toBe(200);
    expect(r.text).toBe("already processed");
    expect(confirmationsSentFor(order.id)).toBe(0); // this route never dispatched
    expect(countLogEvent("webhook_replay_ignored", `"eventId":"evt_slow_finisher"`)).toBe(1);
  });

  /**
   * The reclaim race, proved rather than assumed (HANDOFF §46). The
   * `updateMany({ where: { processedAt: null, createdAt: { lt: staleBefore } } })`
   * IS the lock: of N deliveries that all find the same corpse, exactly one may
   * get `count === 1` and dispatch. If two ever did, two handlers would run one
   * payment concurrently.
   *
   * Five deliveries, not two — a two-way race can be won by luck.
   */
  it("lets exactly one of five simultaneous deliveries reclaim a stale claim", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_reclaim_race");
    await plantUnfinishedClaim("evt_reclaim_race", 10 * 60_000);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => postWebhook(event)),
    );

    const oks = results.filter((r) => r.text === "ok").length;
    console.log(
      `[webhook reclaim race] 5 simultaneous deliveries of one stale claim: ` +
        `${JSON.stringify(results.map((r) => `${r.status} ${r.text}`))}`,
    );

    // Exactly one winner, and every loser told something safe and final.
    expect(oks).toBe(1);
    expect(countLogEvent("webhook_claim_reclaimed", `"eventId":"evt_reclaim_race"`)).toBe(1);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);

    // One dispatch means one of everything downstream.
    expect(countLogEvent("order_paid", `"orderId":"${order.id}"`)).toBe(1);
    expect(confirmationsSentFor(order.id)).toBe(1);
    expect(await testDb.webhookEvent.count()).toBe(1);

    const row = await testDb.webhookEvent.findUniqueOrThrow({
      where: { id: "evt_reclaim_race" },
    });
    expect(row.processedAt).not.toBeNull();

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PAID");
    expect(after.expiresAt).toBeNull();
  });

  /**
   * HANDOFF §32 "Residual 1": the window is time-based, so a handler that HANGS
   * for more than three minutes without dying can be dispatched a second time
   * by a Stripe retry. Backend's claim is that both dispatch paths are guarded
   * by conditional updates and the second one no-ops. Proved, not assumed.
   *
   * The simulation is exact: apply the payment (as the hung handler eventually
   * would), leave the claim unfinished, age it past the window, and deliver
   * again — that is a second dispatch of an event whose work is already done.
   */
  it("no-ops the second dispatch when a hung handler's claim goes stale", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500, stockQty: 20 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_hung");

    // First delivery completes the work...
    expect((await postWebhook(event)).text).toBe("ok");
    const afterFirst = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterFirst.status).toBe("PAID");

    // ...but the claim never got marked finished (the `webhook_mark_processed_failed`
    // path), and it has now aged past the reclaim window.
    await testDb.webhookEvent.update({
      where: { id: "evt_hung" },
      data: { processedAt: null, createdAt: new Date(Date.now() - STALE_MS - 60_000) },
    });

    const second = await postWebhook(event);
    expect(second.status).toBe(200);
    expect(second.text).toBe("ok"); // it really did reclaim and dispatch again

    const afterSecond = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    console.log(
      `[webhook double dispatch] reclaimed an already-applied event: ` +
        `status=${afterSecond.status} paidAtChanged=${
          afterSecond.paidAt?.getTime() !== afterFirst.paidAt?.getTime()
        } emails=${confirmationsSentFor(order.id)}`,
    );

    // Idempotent: same status, same paidAt, one notification, one order_paid.
    expect(afterSecond.status).toBe("PAID");
    expect(afterSecond.paidAt?.getTime()).toBe(afterFirst.paidAt?.getTime());
    expect(confirmationsSentFor(order.id)).toBe(1);
    expect(countLogEvent("order_paid", `"orderId":"${order.id}"`)).toBe(1);
    expect(countLogEvent("webhook_noop", `"orderId":"${order.id}"`)).toBe(1);
    // And no money or inventory moved twice.
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: order.items[0].productId } }))
        .stockQty,
    ).toBe(19);
  });

  /**
   * The most expensive double dispatch there is: a reclaimed
   * `payment_intent.payment_failed`. Its handler RELEASES stock and the pickup
   * seat, so running it twice would put a unit back on the shelf that was never
   * taken off it — phantom inventory, which oversells at the locker.
   *
   * `onFailed`'s `status !== "PENDING"` check plus `releaseOrder`'s own
   * conditional update are what stop it. Proved against the reclaim path,
   * because that is the path that can genuinely dispatch one event twice.
   */
  it("does not release stock twice when a failed-payment event is reclaimed", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500, stockQty: 20 });
    const productId = order.items[0].productId;
    const event = paymentIntentFailed(order.stripePaymentIntentId!, "evt_failed_reclaim");

    expect((await postWebhook(event)).text).toBe("ok");
    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("CANCELLED");
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: productId } })).stockQty,
    ).toBe(20); // released exactly once
    expect(
      await countBookedOrders(order.pickupServiceDate, order.pickupStartTime, order.pickupLocation),
    ).toBe(0);

    // The claim was never marked finished and has aged out: the next retry
    // reclaims it and dispatches the release a second time.
    await testDb.webhookEvent.update({
      where: { id: "evt_failed_reclaim" },
      data: { processedAt: null, createdAt: new Date(Date.now() - STALE_MS - 60_000) },
    });
    const second = await postWebhook(event);
    expect(second.status).toBe(200);

    const stock = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    const booked = await countBookedOrders(
      order.pickupServiceDate,
      order.pickupStartTime,
      order.pickupLocation,
    );
    console.log(
      `[webhook double release] reclaimed a failed-payment event: stock=${stock.stockQty}/20 ` +
        `booked=${booked}`,
    );
    expect(stock.stockQty).toBe(20); // NOT 21
    expect(booked).toBe(0); // not negative, and the constraint holds
  });

  /**
   * ADVERSARIAL — the bands are decided by comparing a database timestamp to the
   * application server's `Date.now()`. Those are two different clocks in any
   * deployment where Postgres is not on the same host, and nothing validates
   * the row's timestamp.
   *
   * A claim stamped in the future (a DB clock running ahead) is trusted
   * indefinitely: it can never age into the ambiguous band, let alone the
   * reclaim band, so a crashed handler under clock skew is §32 all over again.
   * Asserted so the dependency is visible and measured rather than assumed
   * away.
   */
  it("trusts a claim timestamped in the future, so clock skew re-opens the crash window", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_future_claim");

    // A crashed handler's claim, stamped five minutes ahead of the app server.
    await plantUnfinishedClaim("evt_future_claim", -5 * 60_000);

    const r = await postWebhook(event);
    console.log(
      `[webhook clock skew] claim stamped 5 min in the future: response=${r.status} "${r.text}"`,
    );
    expect(r.status).toBe(200);
    expect(r.text).toBe("already processed");
    // Never reclaimed, however many times Stripe retries within the skew.
    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("PENDING");
  });

  /**
   * The bands are a property of the CLAIM, not of the event type. A refund
   * delivered against an ambiguous claim must be held back too — answering 200
   * to a refund we never applied is the same lost-event failure with the money
   * pointing the other way.
   */
  it("applies the ambiguous band to charge.refunded as well", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    await testDb.order.update({
      where: { id: order.id },
      data: { status: "PAID", paidAt: new Date(), expiresAt: null },
    });
    await plantUnfinishedClaim("evt_refund_ambiguous", 30_000, "charge.refunded");

    const r = await postWebhook(
      chargeRefunded(order.stripePaymentIntentId!, "evt_refund_ambiguous"),
    );
    expect(r.status).toBe(409);
    expect(r.text).toBe("claim ambiguous, retry");
    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("PAID"); // NOT refunded — nothing was dispatched
  });

  /**
   * A 409 must never be reachable for an event id nobody has claimed: that
   * would be a retry loop on a first delivery. Sanity, and cheap.
   */
  it("never answers 409 for an unclaimed event id", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_first_delivery"),
    );
    expect(r.status).toBe(200);
    expect(r.text).toBe("ok");
  });

  /**
   * ADVERSARIAL — the residual the trust band still carries, asserted as
   * behaviour rather than left as prose.
   *
   * docs/HANDOFF.md §32 "Residual 2" says "a same-second retry gets 409 and
   * tries again later". It does not: a retry inside WEBHOOK_CLAIM_TRUST_MS
   * (10s) is answered 200 "already processed", because that branch is what
   * keeps genuinely concurrent duplicate delivery idempotent. A 2xx is Stripe's
   * signal that an event is delivered, so if a handler dies at t=0 and the only
   * retry lands at t<10s, that payment is never recorded — the original §32
   * failure, narrowed from "forever" to a ten-second window.
   *
   * This test pins the ACTUAL behaviour so the doc can be corrected against it
   * and so a future change to the trust window is visible here.
   */
  it("still answers 200 to a retry inside the trust window, leaving that payment unrecorded", async () => {
    const order = await seedPendingCardOrder({ totalCents: 500 });
    const event = paymentIntentSucceeded(order.stripePaymentIntentId!, 500, "evt_fast_retry");

    // Handler claimed the event and was killed a moment ago.
    await plantUnfinishedClaim("evt_fast_retry", 1_000);

    const r = await postWebhook(event);
    console.log(
      `[webhook trust-window residual] retry 1s after a crashed claim: ` +
        `response=${r.status} "${r.text}" order=${
          (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status
        }`,
    );

    // Documented in API-CONTRACT §6 and correct for concurrency; the point of
    // the test is that it is ALSO a 2xx for a crash, and 2xx ends Stripe's
    // retries for that event id.
    expect(r.status).toBe(200);
    expect(r.text).toBe("already processed");
    expect(TRUST_MS).toBe(10_000);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING");
    expect(after.paidAt).toBeNull();
    // Worse than merely unrecorded: the order is still on its expiry clock, so
    // the sweep will hand the stock back for a payment that was taken.
    expect(after.expiresAt).not.toBeNull();
  });
});

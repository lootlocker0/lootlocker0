import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import {
  adminCookie,
  adminPost,
  chargeRefunded,
  checkoutPayload,
  countLogEvent,
  paymentIntentSucceeded,
  postCheckout,
  postWebhook,
  seedPendingCardOrder,
  seedProduct,
  seedSlot,
  signupAccount,
} from "../helpers";

/**
 * Reward points earning/reversal (docs/HANDOFF.md #88, docs/API-CONTRACT.md
 * §6c "Reward points"). Everything here that claims "exactly once" fires with
 * `Promise.all`, not a sequential loop — a sequential version of any of these
 * passes against a read-then-write implementation and proves nothing
 * (BUILDPLAN.md's named failure mode for this suite).
 */

async function rewardPointsOf(userId: string): Promise<number> {
  return (await testDb.user.findUniqueOrThrow({ where: { id: userId } })).rewardPoints;
}

describe("reward points — card orders", () => {
  beforeEach(resetDb);

  it("awards points exactly once when the webhook pays a linked order", async () => {
    const account = await signupAccount();
    const order = await seedPendingCardOrder({
      totalCents: 300,
      accountCookie: account.cookie,
    });
    expect(await rewardPointsOf(account.user.id)).toBe(0);

    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 300),
    );
    expect(r.status).toBe(200);

    // floor(300/100) * 10 = 30, matching the shipped UI copy's rate.
    expect(await rewardPointsOf(account.user.id)).toBe(30);
    expect(
      countLogEvent("reward_points_awarded", `"userId":"${account.user.id}"`),
    ).toBe(1);
  });

  it("does not award points to a guest order (no linked account)", async () => {
    const order = await seedPendingCardOrder({ totalCents: 300 });
    const r = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 300),
    );
    expect(r.status).toBe(200);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PAID");
    expect(after.userId).toBeNull();
    // Scoped to this order id — countLogEvent reads the whole shared server
    // log for the file, and an earlier test in this run may have logged this
    // same event for a different order/user.
    expect(countLogEvent("reward_points_awarded", `"orderId":"${order.id}"`)).toBe(0);
  });

  /**
   * Mirrors webhook.test.ts's "acts once when three different event ids
   * describe one payment" — the case a dedupe-by-event-id insert cannot help
   * with, since these are three genuinely distinct Stripe event ids for one
   * PaymentIntent. Only the conditional `updateMany(where: status = PENDING)`
   * stops all three award attempts.
   */
  it("awards points exactly once under concurrent webhook delivery for one payment", async () => {
    const account = await signupAccount();
    const order = await seedPendingCardOrder({
      totalCents: 500,
      accountCookie: account.cookie,
    });
    const pi = order.stripePaymentIntentId!;

    const results = await Promise.all([
      postWebhook(paymentIntentSucceeded(pi, 500, "evt_reward_a")),
      postWebhook(paymentIntentSucceeded(pi, 500, "evt_reward_b")),
      postWebhook(paymentIntentSucceeded(pi, 500, "evt_reward_c")),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    expect(await rewardPointsOf(account.user.id)).toBe(50); // floor(500/100)*10
    expect(
      countLogEvent("reward_points_awarded", `"userId":"${account.user.id}"`),
    ).toBe(1);
    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("PAID");
  });

  it("reverses points exactly once when the refund webhook arrives", async () => {
    const account = await signupAccount();
    const order = await seedPendingCardOrder({
      totalCents: 300,
      accountCookie: account.cookie,
    });
    await postWebhook(paymentIntentSucceeded(order.stripePaymentIntentId!, 300));
    expect(await rewardPointsOf(account.user.id)).toBe(30);

    const r = await postWebhook(chargeRefunded(order.stripePaymentIntentId!));
    expect(r.status).toBe(200);

    expect(await rewardPointsOf(account.user.id)).toBe(0);
    expect(
      countLogEvent("reward_points_reversed", `"userId":"${account.user.id}"`),
    ).toBe(1);
  });

  it("reverses points exactly once via the admin refund route", async () => {
    const account = await signupAccount();
    const order = await seedPendingCardOrder({
      totalCents: 300,
      accountCookie: account.cookie,
    });
    await postWebhook(paymentIntentSucceeded(order.stripePaymentIntentId!, 300));
    expect(await rewardPointsOf(account.user.id)).toBe(30);

    const cookie = await adminCookie();
    const r = await adminPost(`/api/admin/orders/${order.orderNumber}/refund`, cookie, {});
    expect(r.status).toBe(200);

    expect(await rewardPointsOf(account.user.id)).toBe(0);
  });

  /**
   * Mirrors admin-inventory.test.ts's "a manual refund racing charge.refunded
   * lands exactly one refund" — same race, this suite's own hazard on top of
   * it: both paths reverse points, gated on the SAME conditional `updateMany`
   * that already makes the status change exactly-once. If that gate ever
   * stopped covering the points call too, this is what would go negative.
   */
  it("does not double-reverse points when an admin refund races the refund webhook", async () => {
    const account = await signupAccount();
    const order = await seedPendingCardOrder({
      totalCents: 300,
      accountCookie: account.cookie,
    });
    await postWebhook(paymentIntentSucceeded(order.stripePaymentIntentId!, 300));
    expect(await rewardPointsOf(account.user.id)).toBe(30);

    const cookie = await adminCookie();
    const [manual, hook] = await Promise.all([
      adminPost(`/api/admin/orders/${order.orderNumber}/refund`, cookie, {}),
      postWebhook(chargeRefunded(order.stripePaymentIntentId!)),
    ]);
    expect(manual.status, `manual refund: ${manual.text}`).toBeLessThan(500);
    expect(hook.status).toBe(200);

    expect(
      (await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("REFUNDED");
    // Not -30. Whichever side won the race reversed it once; the loser's
    // conditional update matched nothing and reversed nothing.
    expect(await rewardPointsOf(account.user.id)).toBe(0);
  });

  it("reverses points on a PACKED card order refunded before pickup", async () => {
    const account = await signupAccount();
    const order = await seedPendingCardOrder({
      totalCents: 400,
      accountCookie: account.cookie,
    });
    await postWebhook(paymentIntentSucceeded(order.stripePaymentIntentId!, 400));
    expect(await rewardPointsOf(account.user.id)).toBe(40);

    const cookie = await adminCookie();
    const packed = await adminPost(`/api/admin/orders/${order.orderNumber}/pack`, cookie, {});
    expect(packed.status).toBe(200);

    const r = await adminPost(`/api/admin/orders/${order.orderNumber}/refund`, cookie, {});
    expect(r.status).toBe(200);
    expect(await rewardPointsOf(account.user.id)).toBe(0);
  });
});

describe("reward points — cash orders", () => {
  beforeEach(resetDb);

  async function cashOrder(account: { cookie: string }, totalCents: number) {
    const slot = await seedSlot({ capacity: 10 });
    const product = await seedProduct({ priceCents: totalCents, stockQty: 20 });
    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: product.id, qty: 1 }],
      }),
      { cookie: account.cookie },
    );
    expect(r.status, r.text).toBe(200);
    return r.body.orderNumber as string;
  }

  it("awards points when staff record cash collected", async () => {
    const account = await signupAccount();
    const orderNumber = await cashOrder(account, 600);
    expect(await rewardPointsOf(account.user.id)).toBe(0);

    const cookie = await adminCookie();
    const r = await adminPost(`/api/admin/orders/${orderNumber}/cash`, cookie, {});
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);

    expect(await rewardPointsOf(account.user.id)).toBe(60); // floor(600/100)*10
    expect(countLogEvent("reward_points_awarded", `"userId":"${account.user.id}"`)).toBe(1);
  });

  /**
   * The idempotency guarantee the cash route's own header describes: a
   * double-pressed button, or two staff phones, must produce one write and
   * two no-ops — not one write and two more award attempts.
   */
  it("awards points exactly once under a triple-pressed cash-collect button", async () => {
    const account = await signupAccount();
    const orderNumber = await cashOrder(account, 300);
    const cookie = await adminCookie();

    const results = await Promise.all([
      adminPost(`/api/admin/orders/${orderNumber}/cash`, cookie, {}),
      adminPost(`/api/admin/orders/${orderNumber}/cash`, cookie, {}),
      adminPost(`/api/admin/orders/${orderNumber}/cash`, cookie, {}),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.changed === true)).toHaveLength(1);

    expect(await rewardPointsOf(account.user.id)).toBe(30);
    expect(
      countLogEvent("reward_points_awarded", `"userId":"${account.user.id}"`),
    ).toBe(1);
  });

  /**
   * The nuance this whole feature is built around: `paidAt`, not `status`, is
   * the money fact. A cash order packed before the money is collected has NOT
   * earned points yet, and the existing CASH_NOT_COLLECTED guard already
   * refuses to refund it — confirmed here so a future change to either guard
   * can't silently let points get reversed for money that was never taken.
   */
  it("a PACKED cash order that never collected cash cannot be refunded, and earns/reverses nothing", async () => {
    const account = await signupAccount();
    const orderNumber = await cashOrder(account, 300);
    const cookie = await adminCookie();

    const packed = await adminPost(`/api/admin/orders/${orderNumber}/pack`, cookie, {});
    expect(packed.status).toBe(200);
    expect(packed.body.status).toBe("PACKED");

    expect(await rewardPointsOf(account.user.id)).toBe(0);
    expect(
      countLogEvent("reward_points_awarded", `"userId":"${account.user.id}"`),
    ).toBe(0);

    const refund = await adminPost(`/api/admin/orders/${orderNumber}/refund`, cookie, {});
    expect(refund.status).toBe(409);
    expect(refund.body.error.code).toBe("CASH_NOT_COLLECTED");

    expect(await rewardPointsOf(account.user.id)).toBe(0);
    expect(
      countLogEvent("reward_points_reversed", `"userId":"${account.user.id}"`),
    ).toBe(0);
  });

  it("awards points on a cash order collected while already PACKED", async () => {
    const account = await signupAccount();
    const orderNumber = await cashOrder(account, 500);
    const cookie = await adminCookie();

    await adminPost(`/api/admin/orders/${orderNumber}/pack`, cookie, {});
    const collect = await adminPost(`/api/admin/orders/${orderNumber}/cash`, cookie, {});
    expect(collect.status).toBe(200);
    expect(collect.body.status).toBe("PACKED"); // status unchanged; paidAt is the new fact
    expect(collect.body.paidAt).not.toBeNull();

    expect(await rewardPointsOf(account.user.id)).toBe(50);
  });

  it("reverses points on a refunded cash order that had collected payment", async () => {
    const account = await signupAccount();
    const orderNumber = await cashOrder(account, 400);
    const cookie = await adminCookie();

    await adminPost(`/api/admin/orders/${orderNumber}/cash`, cookie, {});
    expect(await rewardPointsOf(account.user.id)).toBe(40);

    const r = await adminPost(`/api/admin/orders/${orderNumber}/refund`, cookie, {});
    expect(r.status).toBe(200);
    expect(await rewardPointsOf(account.user.id)).toBe(0);
  });
});

describe("adjust_reward_points — the SQL function directly", () => {
  beforeEach(resetDb);

  it("floors at zero and leaves the balance untouched rather than going negative", async () => {
    const account = await signupAccount();
    await testDb.user.update({
      where: { id: account.user.id },
      data: { rewardPoints: 10 },
    });

    const rows = await testDb.$queryRaw<{ points: number | null }[]>`
      SELECT adjust_reward_points(${account.user.id}::text, ${-50}::int) AS points
    `;
    expect(rows[0]?.points).toBeNull();
    expect(await rewardPointsOf(account.user.id)).toBe(10); // unchanged
  });

  it("returns NULL for a user that does not exist, and writes nothing", async () => {
    const rows = await testDb.$queryRaw<{ points: number | null }[]>`
      SELECT adjust_reward_points(${"not-a-real-user-id"}::text, ${10}::int) AS points
    `;
    expect(rows[0]?.points).toBeNull();
  });

  it("applies a positive delta atomically and returns the new balance", async () => {
    const account = await signupAccount();
    const rows = await testDb.$queryRaw<{ points: number | null }[]>`
      SELECT adjust_reward_points(${account.user.id}::text, ${25}::int) AS points
    `;
    expect(rows[0]?.points).toBe(25);
    expect(await rewardPointsOf(account.user.id)).toBe(25);
  });
});

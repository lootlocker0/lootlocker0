import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import {
  chargeRefunded,
  checkoutPayload,
  countBookedOrders,
  paymentIntentFailed,
  paymentIntentSucceeded,
  postCheckout,
  postWebhook,
  runSweep,
  seedPendingCardOrder,
  seedProduct,
  seedSlot,
} from "../helpers";

describe("expiry sweep", () => {
  beforeEach(resetDb);

  it("refuses without the cron secret", async () => {
    expect((await runSweep({ secret: null })).status).toBe(401);
    expect((await runSweep({ secret: "wrong-secret-value" })).status).toBe(401);
    // A wrong secret of the same length as the real one: the constant-time
    // compare must not accept it either.
    expect((await runSweep({ secret: "qa-cron-secret-valuX" })).status).toBe(401);
  });

  it("is idempotent when three sweeps run concurrently", async () => {
    const order = await seedPendingCardOrder({
      totalCents: 500,
      stockQty: 20,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const productId = order.items[0].productId;
    const before = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    expect(before.stockQty).toBe(19); // the hold is real before the sweep runs

    const results = await Promise.all([runSweep(), runSweep(), runSweep()]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // Exactly one invocation may report the release, even though all three
    // scanned the same row (HANDOFF §21: Vercel Cron can double-fire).
    const totalReleased = results.reduce((a, r) => a + r.body.released, 0);
    expect(totalReleased).toBe(1);
    expect(results.reduce((a, r) => a + r.body.failed, 0)).toBe(0);

    const after = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    // Released exactly once, not three times.
    expect(after.stockQty).toBe(before.stockQty + order.items[0].qty);
    expect(after.stockQty).toBe(20);

    const booked = await countBookedOrders(
      order.pickupServiceDate,
      order.pickupStartTime,
      order.pickupLocation,
    );
    expect(booked).toBe(0);

    const o = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe("EXPIRED");
    expect(o.expiresAt).toBeNull();

    // An immediate second pass finds nothing.
    const again = await runSweep();
    expect(again.body).toEqual({ scanned: 0, released: 0, failed: 0 });
  });

  it("does not release an order that just succeeded", async () => {
    const order = await seedPendingCardOrder({
      totalCents: 500,
      stockQty: 20,
      expiresAt: new Date(Date.now() - 1000),
    });
    const productId = order.items[0].productId;

    await Promise.all([
      runSweep(),
      postWebhook(paymentIntentSucceeded(order.stripePaymentIntentId!, 500)),
    ]);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    console.log(`[sweep vs late payment] winner: ${after.status}`);
    // One of PAID or EXPIRED, never a torn state, and never both effects.
    expect(["PAID", "EXPIRED"]).toContain(after.status);

    const stock = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    const booked = await countBookedOrders(
      order.pickupServiceDate,
      order.pickupStartTime,
      order.pickupLocation,
    );
    expect(booked).toBeGreaterThanOrEqual(0);

    if (after.status === "PAID") {
      // Paid means the hold must still be held: the snack is on the shelf for
      // this student and the seat is theirs.
      expect(stock.stockQty).toBe(19);
      expect(booked).toBe(1);
      expect(after.expiresAt).toBeNull();
    } else {
      // Expired means everything went back exactly once, and — critically —
      // the payment must NOT have been recorded as paid.
      expect(stock.stockQty).toBe(20);
      expect(booked).toBe(0);
      expect(after.paidAt).toBeNull();
    }
  });

  /**
   * NEW interaction created by the §33 fix, which nothing covered: since
   * `onRefunded` now matches a PENDING order, a refund and the sweep can both
   * be acting on one expiring order at the same instant.
   *
   * Both are conditional updates, so exactly one of two shapes is legal, and
   * "released twice" (21 units of phantom stock, or a negative `booked_count`)
   * is not one of them.
   */
  it("cannot release twice when a refund and the sweep race one expiring order", async () => {
    const order = await seedPendingCardOrder({
      totalCents: 500,
      stockQty: 20,
      expiresAt: new Date(Date.now() - 1000),
    });
    const productId = order.items[0].productId;

    await Promise.all([
      runSweep(),
      postWebhook(chargeRefunded(order.stripePaymentIntentId!, "evt_refund_vs_sweep")),
    ]);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    const stock = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    const booked = await countBookedOrders(
      order.pickupServiceDate,
      order.pickupStartTime,
      order.pickupLocation,
    );
    console.log(
      `[sweep vs refund] status=${after.status} stock=${stock.stockQty}/20 ` +
        `booked=${booked}`,
    );

    // The refund beats every status except REFUNDED, so it wins whichever order
    // the two land in: either it flipped PENDING first (and the sweep then
    // matched nothing), or the sweep expired it first and the refund overwrote
    // EXPIRED.
    expect(after.status).toBe("REFUNDED");
    expect(after.expiresAt).toBeNull();

    // Released exactly once, or not at all. Never twice.
    expect([19, 20]).toContain(stock.stockQty);
    expect([0, 1]).toContain(booked);
    // And the two holds agree with each other — a released seat with held stock
    // (or the reverse) would mean the release ran partially.
    expect(booked).toBe(stock.stockQty === 20 ? 0 : 1);
    expect(booked).toBeGreaterThanOrEqual(0);
  });

  /**
   * HANDOFF §21, the narrow-but-real money hole, forced rather than waited for:
   * a payment landing after the sweep has already expired the order. The
   * `clientSecret` handed to the browser stays usable, so this is reachable
   * whenever Stripe (or a student on a slow phone) is slower than the TTL.
   *
   * Documented as current behaviour, not as an acceptable one: the money is
   * taken at Stripe and nothing here records an order for it. Only the
   * `webhook_noop` log line marks it, and nothing alerts on that.
   */
  it("takes payment for an already-expired order and records nothing", async () => {
    const order = await seedPendingCardOrder({
      totalCents: 500,
      stockQty: 20,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const swept = await runSweep();
    expect(swept.body.released).toBe(1);

    const late = await postWebhook(
      paymentIntentSucceeded(order.stripePaymentIntentId!, 500),
    );
    expect(late.status).toBe(200);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("EXPIRED");
    expect(after.paidAt).toBeNull();
    // Stock stayed released — correct for an expired order, and the reason the
    // failure mode is "charged with no order" rather than "oversold".
    const stock = await testDb.product.findUniqueOrThrow({
      where: { id: order.items[0].productId },
    });
    expect(stock.stockQty).toBe(20);
  });

  it("never touches a cash order, even one carrying an expiry", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const product = await seedProduct({ stockQty: 10, priceCents: 300 });
    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: product.id, qty: 2 }],
      }),
    );
    expect(r.status).toBe(200);

    // Force the state HANDOFF §21 warns about if item 18.2 were ever reverted.
    await testDb.order.updateMany({
      where: { orderNumber: r.body.orderNumber },
      data: { expiresAt: new Date(Date.now() - 600_000) },
    });

    const swept = await runSweep();
    expect(swept.body).toEqual({ scanned: 0, released: 0, failed: 0 });

    const after = await testDb.order.findFirstOrThrow({
      where: { orderNumber: r.body.orderNumber },
    });
    expect(after.status).toBe("RESERVED");
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
    ).toBe(8);
  });

  /**
   * The documented throughput ceiling (HANDOFF §21): `take: 100` per run. More
   * than 100 abandoned card orders inside one 5-minute window and the backlog
   * grows. Asserted rather than assumed, because nothing alerts when it is hit
   * and the only symptom is stock staying held.
   */
  it("leaves a backlog above 100 stale orders for the next run", async () => {
    const slot = await seedSlot({ capacity: 200 });
    const product = await seedProduct({ priceCents: 100, stockQty: 500 });

    await Promise.all(
      Array.from({ length: 105 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `backlog${i}@school.ca`,
            paymentMethod: "CARD",
            items: [{ productId: product.id, qty: 1 }],
          }),
        ),
      ),
    );
    expect(await testDb.order.count({ where: { status: "PENDING" } })).toBe(105);
    await testDb.order.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });

    const first = await runSweep();
    expect(first.body).toEqual({ scanned: 100, released: 100, failed: 0 });
    expect(await testDb.order.count({ where: { status: "PENDING" } })).toBe(5);

    const second = await runSweep();
    expect(second.body).toEqual({ scanned: 5, released: 5, failed: 0 });
    expect(
      (await testDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
    ).toBe(500);
  });

  /**
   * Lock-ordering regression for `lib/db/release.ts` (HANDOFF §18.3, §21).
   *
   * Two orders that share the same two products, released concurrently from two
   * different entry points (the sweep and a `payment_failed` webhook). Without
   * the slot-then-products-ascending order inside `releaseOrder`, this is an
   * ABBA deadlock between two releases and surfaces as a 500.
   */
  it("does not deadlock when concurrent releases share two products", async () => {
    const slot = await seedSlot({ capacity: 20 });
    const x = await seedProduct({ stockQty: 50, priceCents: 100 });
    const y = await seedProduct({ stockQty: 50, priceCents: 100 });

    const made = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `rel${i}@school.ca`,
            paymentMethod: "CARD",
            // Opposite request order on alternate carts. The route sorts, so
            // this is about the release path, not checkout.
            items:
              i % 2 === 0
                ? [
                    { productId: x.id, qty: 2 },
                    { productId: y.id, qty: 3 },
                  ]
                : [
                    { productId: y.id, qty: 3 },
                    { productId: x.id, qty: 2 },
                  ],
          }),
        ),
      ),
    );
    expect(made.every((r) => r.status === 200)).toBe(true);

    const orders = await testDb.order.findMany({ select: { id: true, stripePaymentIntentId: true } });
    expect(orders).toHaveLength(8);
    await testDb.order.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });

    // Every release path at once: three sweeps and a failure event per order.
    const results = await Promise.all([
      runSweep(),
      runSweep(),
      runSweep(),
      ...orders.map((o, i) =>
        postWebhook(paymentIntentFailed(o.stripePaymentIntentId!, `evt_rel_${i}`)),
      ),
    ]);

    expect(results.filter((r) => r.status >= 500)).toEqual([]);

    const [px, py] = await Promise.all([
      testDb.product.findUniqueOrThrow({ where: { id: x.id } }),
      testDb.product.findUniqueOrThrow({ where: { id: y.id } }),
    ]);
    // Each order released exactly once — never twice, never not at all.
    expect(px.stockQty).toBe(50);
    expect(py.stockQty).toBe(50);
    const bookedAfter = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(bookedAfter).toBe(0);

    const statuses = await testDb.order.groupBy({ by: ["status"], _count: true });
    expect(statuses.map((s) => s.status).sort()).toEqual(
      expect.arrayContaining([expect.stringMatching(/CANCELLED|EXPIRED/)]),
    );
    expect(
      (await testDb.order.count({ where: { status: "PENDING" } })),
    ).toBe(0);
  });

  /**
   * The OTHER ABBA in HANDOFF §18.3, and the one that actually reproduces:
   * release-versus-checkout on the same slot and the same products.
   *
   * Checkout takes the slot row (book_slot) and then product rows;
   * `releaseOrder` must take them in that same order. backend.md §6 had it
   * backwards — products first, then the slot — which is a clean ABBA against
   * any checkout running at the same moment on the same window. Verified by
   * reversing `lib/db/release.ts` locally: this test goes red with
   * `deadlock detected` (40P01) surfacing as INTERNAL 500s, and green again
   * once the order is restored. Numbers are in the QA section of
   * docs/HANDOFF.md.
   */
  it("does not deadlock when releases and fresh checkouts share a slot and its products", async () => {
    const slot = await seedSlot({ capacity: 120 });
    const x = await seedProduct({ stockQty: 400, priceCents: 100 });
    const y = await seedProduct({ stockQty: 400, priceCents: 100 });

    // 24 card orders about to be released.
    const doomed = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `doomed${i}@school.ca`,
            paymentMethod: "CARD",
            items: [
              { productId: x.id, qty: 1 },
              { productId: y.id, qty: 1 },
            ],
          }),
        ),
      ),
    );
    expect(doomed.every((r) => r.status === 200)).toBe(true);
    await testDb.order.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    const intents = await testDb.order.findMany({
      where: { status: "PENDING" },
      select: { stripePaymentIntentId: true },
    });

    // Releases and brand-new checkouts, on the same slot and products, at once.
    const results = await Promise.all([
      runSweep(),
      runSweep(),
      ...intents.map((o, i) =>
        postWebhook(paymentIntentFailed(o.stripePaymentIntentId!, `evt_abba_${i}`)),
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `fresh${i}@school.ca`,
            items: [
              { productId: y.id, qty: 1 },
              { productId: x.id, qty: 1 },
            ],
          }),
        ),
      ),
    ]);

    const failures = results.filter((r) => r.status >= 500);
    expect(
      failures.map((f) => f.text.slice(0, 160)),
      "500s here are deadlocks between releaseOrder and book_pickup_window/reserve_stock",
    ).toEqual([]);

    // The books still balance: every doomed order gave back exactly what it
    // held, every fresh order took exactly what it claimed.
    const fresh = await testDb.order.count({ where: { status: "RESERVED" } });
    const [px, py] = await Promise.all([
      testDb.product.findUniqueOrThrow({ where: { id: x.id } }),
      testDb.product.findUniqueOrThrow({ where: { id: y.id } }),
    ]);
    expect(px.stockQty).toBe(400 - fresh);
    expect(py.stockQty).toBe(400 - fresh);
    const bookedAfter = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(bookedAfter).toBe(fresh);
  });

  /**
   * The same ABBA probe with the NEW lock in the cycle (HANDOFF §46).
   *
   * The checkout transaction's lock order is mailbox (advisory) → a
   * per-window advisory lock inside book_pickup_window() itself → products
   * ascending, and `lib/db/release.ts` takes only products ascending (there
   * is no separate pickup-slot row left to lock — releasing a seat is just
   * setting `seatReleasedAt` on the order row already locked by its own
   * conditional UPDATE).
   *
   * The test above never contends the advisory lock — every request uses a
   * distinct email. This one crosses every dimension at once: two mailboxes,
   * two pickup windows, two products in reversed cart order, and concurrent
   * releases on the same rows. A deadlock surfaces as a 500, not a coded 409.
   */
  it("does not deadlock when two mailboxes cross two windows and two products", async () => {
    const slotA = await seedSlot({ capacity: 60 });
    const slotB = await seedSlot({ capacity: 60 });
    const x = await seedProduct({ stockQty: 400, priceCents: 1 });
    const y = await seedProduct({ stockQty: 400, priceCents: 1 });
    const emails = ["abba-a@school.ca", "abba-b@school.ca"];

    // Card orders about to be released. PENDING is excluded from the cap
    // aggregate, so these can share the same two mailboxes without the cap
    // interfering with what this test is measuring.
    const doomed = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: i % 2 === 0 ? slotA.id : slotB.id,
            email: emails[i % 2],
            paymentMethod: "CARD",
            items: [
              { productId: x.id, qty: 1 },
              { productId: y.id, qty: 1 },
            ],
          }),
        ),
      ),
    );
    expect(doomed.map((r) => r.status)).toEqual(Array(16).fill(200));
    await testDb.order.updateMany({
      where: { status: "PENDING" },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    // 40 fresh cash checkouts, cart order alternating, mailbox alternating,
    // window alternating — every combination of the lock order in flight at
    // once — plus two sweeps releasing the doomed orders underneath them.
    const fresh = Array.from({ length: 40 }, (_, i) =>
      postCheckout(
        checkoutPayload({
          slotId: i % 4 < 2 ? slotA.id : slotB.id,
          email: emails[i % 2],
          paymentMethod: "CASH_AT_PICKUP",
          items:
            i % 2 === 0
              ? [
                  { productId: x.id, qty: 1 },
                  { productId: y.id, qty: 1 },
                ]
              : [
                  { productId: y.id, qty: 1 },
                  { productId: x.id, qty: 1 },
                ],
        }),
      ),
    );
    const results = await Promise.all([runSweep(), runSweep(), ...fresh]);

    const failures = results.filter((r) => r.status >= 500);
    expect(
      failures.map((f) => f.text.slice(0, 160)),
      "500s here are an ABBA deadlock between the advisory lock and releaseOrder",
    ).toEqual([]);

    // Drain anything the sweeps raced past, then check the books.
    await runSweep();
    expect(await testDb.order.count({ where: { status: "PENDING" } })).toBe(0);

    const reserved = await testDb.order.count({ where: { status: "RESERVED" } });
    const [px, py] = await Promise.all([
      testDb.product.findUniqueOrThrow({ where: { id: x.id } }),
      testDb.product.findUniqueOrThrow({ where: { id: y.id } }),
    ]);
    console.log(
      `[abba crossed mailboxes] reserved=${reserved}/40 500s=${failures.length} ` +
        `stock=${px.stockQty}/${py.stockQty}`,
    );
    expect(px.stockQty).toBe(400 - reserved);
    expect(py.stockQty).toBe(400 - reserved);

    const [a, b] = await Promise.all([
      countBookedOrders(slotA.serviceDate, slotA.startTime, slotA.location),
      countBookedOrders(slotB.serviceDate, slotB.startTime, slotB.location),
    ]);
    expect(a + b).toBe(reserved);
    expect(a).toBeLessThanOrEqual(slotA.capacity);
    expect(b).toBeLessThanOrEqual(slotB.capacity);
  });
});

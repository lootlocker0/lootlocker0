import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import { seedSlot, seedProduct, checkoutPayload, postCheckout, countBookedOrders } from "../helpers";

describe("stock under concurrent load", () => {
  beforeEach(resetDb);

  it("sells the last unit exactly once", async () => {
    const slot = await seedSlot({ capacity: 100 });
    const product = await seedProduct({ stockQty: 1 });

    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `s${i}@school.ca`,
            items: [{ productId: product.id, qty: 1 }],
          }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.body?.error?.code === "OUT_OF_STOCK"),
    ).toHaveLength(14);
    expect(results.filter((r) => r.status === 500)).toHaveLength(0);

    const after = await testDb.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQty).toBe(0);
    expect(after.stockQty).toBeGreaterThanOrEqual(0); // stock_non_negative holds

    // The 14 losers each claimed a seat before failing on stock. Every one of
    // those seats must have rolled back with its transaction.
    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(booked).toBe(1);
  });

  it("rolls back the slot booking when a later line is out of stock", async () => {
    const slot = await seedSlot({ capacity: 10 });
    const inStock = await seedProduct({ stockQty: 10 });
    const soldOut = await seedProduct({ stockQty: 0 });

    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        items: [
          { productId: inStock.id, qty: 1 },
          { productId: soldOut.id, qty: 1 },
        ],
      }),
    );

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("OUT_OF_STOCK");

    // The critical assertion: partial failure must leave NOTHING behind.
    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    const stockAfter = await testDb.product.findUniqueOrThrow({ where: { id: inStock.id } });
    expect(booked).toBe(0);
    expect(stockAfter.stockQty).toBe(10);
    expect(await testDb.order.count()).toBe(0);
    expect(await testDb.orderItem.count()).toBe(0);
  });

  /**
   * Same rollback assertion, but the failing line comes FIRST in the request
   * and only sorts to second by cuid. The route reserves in
   * `productId.localeCompare` order, not request order, so this is the case
   * where a successful reservation is definitely already on the books when the
   * failure happens — the request-order version can pass by reserving nothing.
   */
  it("rolls back when the failing line is the second one reached by the sort", async () => {
    const slot = await seedSlot({ capacity: 10 });

    // Prices kept small on purpose: the daily spend cap (1500c) is checked
    // BEFORE the transaction, so a fixture that costs more than the cap never
    // reaches the code this test is about.
    let inStock = await seedProduct({ stockQty: 7, priceCents: 100 });
    let soldOut = await seedProduct({ stockQty: 0, priceCents: 100 });
    for (let i = 0; i < 10 && soldOut.id.localeCompare(inStock.id) < 0; i++) {
      soldOut = await seedProduct({ stockQty: 0, priceCents: 100 });
    }
    if (soldOut.id.localeCompare(inStock.id) < 0) {
      // cuids are monotonic in practice, so this should not happen; fail loudly
      // rather than silently testing the weaker ordering.
      throw new Error("could not seed a pair with the sold-out product sorting last");
    }
    inStock = await testDb.product.findUniqueOrThrow({ where: { id: inStock.id } });

    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        items: [
          { productId: soldOut.id, qty: 1 }, // first in the request…
          { productId: inStock.id, qty: 3 }, // …but reserved first by the sort
        ],
      }),
    );

    expect(r.body.error.code).toBe("OUT_OF_STOCK");
    const stockAfter = await testDb.product.findUniqueOrThrow({ where: { id: inStock.id } });
    expect(stockAfter.stockQty).toBe(7);
    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(booked).toBe(0);
  });

  /**
   * ABBA deadlock regression (HANDOFF §21).
   *
   * `app/api/checkout/route.ts` sorts lines by `productId` before calling
   * `reserve_stock`, which is the only thing fixing the order in which row
   * locks are taken. Deleting that sort must turn this test red — the proof
   * that it exercises the defence rather than passing by luck is in the QA
   * section of docs/HANDOFF.md, where the observed failure with the sort
   * removed is recorded.
   *
   * A deadlock surfaces as a 500 (Postgres kills one side with 40P01), never as
   * a clean 409.
   *
   * TWO SLOTS, not one, and this is the whole test. `book_slot` takes the slot
   * row lock first, so two carts on the SAME window are serialised by that lock
   * before they ever touch a product — an ABBA deadlock is impossible and the
   * single-slot version of this test passes with the sort deleted (measured;
   * see the QA section of docs/HANDOFF.md). Carts in two different pickup
   * windows holding the same two products is both the realistic case — Lunch A
   * and Lunch B selling the same chips and the same juice — and the only one
   * that actually exercises the lock ordering.
   */
  it("does not deadlock when carts in two windows hold the same two products in reverse order", async () => {
    const slotA = await seedSlot({ capacity: 60 });
    const slotB = await seedSlot({ capacity: 60 });
    const a = await seedProduct({ stockQty: 200, priceCents: 100 });
    const b = await seedProduct({ stockQty: 200, priceCents: 100 });

    const results = await Promise.all([
      ...Array.from({ length: 30 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slotA.id,
            email: `fwd${i}@school.ca`,
            items: [
              { productId: a.id, qty: 1 },
              { productId: b.id, qty: 1 },
            ],
          }),
        ),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slotB.id,
            email: `rev${i}@school.ca`,
            items: [
              { productId: b.id, qty: 1 },
              { productId: a.id, qty: 1 },
            ],
          }),
        ),
      ),
    ]);

    const failures = results.filter((r) => r.status === 500);
    expect(
      failures.map((f) => f.text.slice(0, 200)),
      "a 500 here is a deadlock or a pool timeout, not a business outcome",
    ).toEqual([]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(60);

    const [pa, pb] = await Promise.all([
      testDb.product.findUniqueOrThrow({ where: { id: a.id } }),
      testDb.product.findUniqueOrThrow({ where: { id: b.id } }),
    ]);
    expect(pa.stockQty).toBe(140);
    expect(pb.stockQty).toBe(140);
  });

  /**
   * HANDOFF §21: "Prices are read at step 3 and stock is reserved at step 6, in
   * different transactions. A staff reprice in that window means the order is
   * created, charged and snapshotted at the old price."
   *
   * The reprice race itself is a small, real, and by-design money leak (the
   * snapshot is what the student agreed to). What must NOT survive it is an
   * order whose total disagrees with its own lines — that would be money the
   * database cannot explain, and `order_total_consistent` only checks
   * total = subtotal + tax, not total = Σ lines.
   */
  it("never produces an order whose total disagrees with its own snapshots", async () => {
    const slot = await seedSlot({ capacity: 60 });
    const product = await seedProduct({ priceCents: 200, stockQty: 500 });

    const repricer = (async () => {
      for (let i = 0; i < 25; i++) {
        await testDb.product.update({
          where: { id: product.id },
          data: { priceCents: i % 2 === 0 ? 700 : 200 },
        });
      }
    })();

    const checkouts = Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `reprice${i}@school.ca`,
            items: [{ productId: product.id, qty: 1 }],
          }),
        ),
      ),
    );

    const [results] = await Promise.all([checkouts, repricer]);
    expect(results.filter((r) => r.status === 500)).toHaveLength(0);

    const orders = await testDb.order.findMany({ include: { items: true } });
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      const lineSum = o.items.reduce((a, l) => a + l.unitPriceCents * l.qty, 0);
      expect(o.subtotalCents, `order ${o.orderNumber}`).toBe(lineSum);
      expect(o.totalCents).toBe(o.subtotalCents + o.taxCents);
      expect([200, 700]).toContain(o.items[0].unitPriceCents);
    }
  });

  /**
   * Interactive-transaction / connection-pool ceiling (HANDOFF §21: "push
   * concurrency until you find that number and report it").
   *
   * This asserts the *shape* of the failure rather than a specific number: at
   * whatever concurrency this instance tops out, a student must still get a
   * coded 409 they can act on, never a bare INTERNAL 500. The measured ceiling
   * for this environment is recorded in the QA section of docs/HANDOFF.md.
   */
  it("degrades into coded errors, not 500s, at 120-way concurrency", async () => {
    const slot = await seedSlot({ capacity: 200 });
    const product = await seedProduct({ stockQty: 1000 });

    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `load${i}@school.ca`,
            items: [{ productId: product.id, qty: 1 }],
          }),
        ),
      ),
    );

    const byStatus = results.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const fiveHundreds = results.filter((r) => r.status === 500);

    // Whatever happened, the books must balance: stock down by exactly the
    // number of orders that were created, and no oversell.
    console.log(`[120-way checkout] status distribution: ${JSON.stringify(byStatus)}`);

    const orders = await testDb.order.count();
    const after = await testDb.product.findUniqueOrThrow({ where: { id: product.id } });
    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(after.stockQty).toBe(1000 - orders);
    expect(booked).toBe(orders);

    expect(
      { byStatus, sample: fiveHundreds[0]?.text?.slice(0, 300) },
      "500s under load mean pool exhaustion (P2028) surfacing as INTERNAL",
    ).toMatchObject({ byStatus: { 200: 120 } });
  });
});

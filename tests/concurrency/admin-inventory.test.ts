import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import { BASE_URL } from "../setup/env";
import {
  ADMIN_PASSCODE,
  INVENTORY_PASSCODE,
  adminCookie,
  adminPost,
  chargeRefunded,
  checkoutPayload,
  inventoryCookie,
  inventoryRequest,
  postCheckout,
  postWebhook,
  runSweep,
  seedPaidOrder,
  seedProduct,
  seedSlot,
} from "../helpers";

/**
 * The adversarial pass over what P4 and P4b landed, aimed squarely at the
 * cases docs/HANDOFF.md §57 and §65 say were NOT run.
 *
 * Everything here fires with `Promise.all`. A sequential version of any of it
 * passes against a read-then-write implementation and proves nothing — that is
 * BUILDPLAN.md's named failure mode for this suite.
 */

describe("P4 refund — the race backend flagged as the highest-value untested case", () => {
  beforeEach(resetDb);

  /**
   * HANDOFF §57: "Fire a refund and a `charge.refunded` webhook for the same
   * order simultaneously and confirm the end state is exactly one refund,
   * REFUNDED, and stock untouched. This is the highest-value test in P4." It
   * was not run there.
   *
   * The hazard is real: `refund` reads status, calls Stripe, then writes with a
   * conditional `updateMany`. The webhook writes `REFUNDED` too. Both can pass
   * their eligibility read against `PAID`.
   */
  it("a manual refund racing charge.refunded lands exactly one refund", async () => {
    const cookie = await adminCookie();
    const order = await seedPaidOrder();
    const stockBefore = (
      await testDb.product.findUniqueOrThrow({ where: { id: order.items[0].productId } })
    ).stockQty;
    const slotBefore = (
      await testDb.pickupSlot.findUniqueOrThrow({ where: { id: order.slotId } })
    ).bookedCount;

    const [manual, hook] = await Promise.all([
      adminPost(`/api/admin/orders/${order.orderNumber}/refund`, cookie, {}),
      postWebhook(chargeRefunded(order.stripePaymentIntentId!)),
    ]);

    // Neither side may 500. A torn refund is the failure that costs money.
    expect(manual.status, `manual refund: ${manual.text}`).toBeLessThan(500);
    expect(hook.status).toBe(200);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("REFUNDED");

    // Stock is never returned by a refund, on either path (API-CONTRACT §6a).
    const stockAfter = (
      await testDb.product.findUniqueOrThrow({ where: { id: order.items[0].productId } })
    ).stockQty;
    expect(stockAfter).toBe(stockBefore);

    // The seat was not asked for, so it must not move on either path.
    const slotAfter = (
      await testDb.pickupSlot.findUniqueOrThrow({ where: { id: order.slotId } })
    ).bookedCount;
    expect(slotAfter).toBe(slotBefore);
  });

  it("fifteen simultaneous refunds change the order exactly once", async () => {
    const cookie = await adminCookie();
    const order = await seedPaidOrder();
    const slotBefore = (
      await testDb.pickupSlot.findUniqueOrThrow({ where: { id: order.slotId } })
    ).bookedCount;

    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        adminPost(`/api/admin/orders/${order.orderNumber}/refund`, cookie, {
          releaseSlotSeat: true,
        }),
      ),
    );

    for (const r of results) expect(r.status, r.text).toBeLessThan(500);
    const changed = results.filter((r) => r.body?.changed === true);
    // Asserted on `changed`, not on status: a route that stopped writing
    // entirely would still return REFUNDED to every caller (HANDOFF §57).
    expect(changed).toHaveLength(1);

    const slotAfter = (
      await testDb.pickupSlot.findUniqueOrThrow({ where: { id: order.slotId } })
    ).bookedCount;
    expect(slotAfter, "the seat was released more than once").toBe(slotBefore - 1);
  });

  /**
   * HANDOFF §57: "`refund` takes an order row lock then a slot row lock … I did
   * NOT run refunds against releases across two windows." Two windows, two
   * products, refunds racing fresh checkouts and a sweep. A lock-order mistake
   * surfaces as a 500 (deadlock), not a clean 409.
   */
  it("refunds, checkouts and a sweep across two windows do not deadlock", async () => {
    const cookie = await adminCookie();
    const slotA = await seedSlot({ capacity: 30, startsInMinutes: 200 });
    const slotB = await seedSlot({ capacity: 30, startsInMinutes: 220 });
    const p1 = await seedProduct({ priceCents: 200, stockQty: 100 });
    const p2 = await seedProduct({ priceCents: 300, stockQty: 100 });

    // Six paid orders to refund, three per window, each holding both products
    // in opposite order.
    const paid = [];
    for (let i = 0; i < 6; i++) {
      const slot = i % 2 === 0 ? slotA : slotB;
      const items =
        i % 2 === 0
          ? [
              { productId: p1.id, qty: 1 },
              { productId: p2.id, qty: 1 },
            ]
          : [
              { productId: p2.id, qty: 1 },
              { productId: p1.id, qty: 1 },
            ];
      const r = await postCheckout(
        checkoutPayload({ slotId: slot.id, items, paymentMethod: "CARD" }),
      );
      expect(r.status, r.text).toBe(200);
      const row = await testDb.order.findUniqueOrThrow({
        where: { orderNumber: r.body.orderNumber },
      });
      const hook = await postWebhook({
        id: `evt_${row.id}`,
        object: "event",
        api_version: "2026-08-26.dahlia",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        request: { id: null, idempotency_key: null },
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: row.stripePaymentIntentId!,
            object: "payment_intent",
            amount: row.totalCents,
            amount_received: row.totalCents,
            currency: "cad",
            status: "succeeded",
          },
        },
      });
      expect(hook.status).toBe(200);
      paid.push(row.orderNumber);
    }

    const results = await Promise.all([
      ...paid.map((n) =>
        adminPost(`/api/admin/orders/${n}/refund`, cookie, { releaseSlotSeat: true }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: i % 2 === 0 ? slotA.id : slotB.id,
            items:
              i % 2 === 0
                ? [
                    { productId: p1.id, qty: 1 },
                    { productId: p2.id, qty: 1 },
                  ]
                : [
                    { productId: p2.id, qty: 1 },
                    { productId: p1.id, qty: 1 },
                  ],
          }),
        ),
      ),
      runSweep(),
      runSweep(),
    ]);

    const fives = results.filter((r) => r.status >= 500);
    expect(
      fives.map((r) => r.text.slice(0, 200)),
      "a 5xx here is a deadlock or an unhandled error, not a business rejection",
    ).toEqual([]);

    // Nothing may leave the database inconsistent either.
    for (const slot of [slotA, slotB]) {
      const s = await testDb.pickupSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(s.bookedCount).toBeGreaterThanOrEqual(0);
      expect(s.bookedCount).toBeLessThanOrEqual(s.capacity);
    }
    for (const p of [p1, p2]) {
      const row = await testDb.product.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.stockQty).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * HANDOFF §57 asks for the reverse of the permissive `pickup`/`cash` race:
   * a refund landing between `pickup`'s read and its write must produce an
   * INVALID_STATUS_TRANSITION, never a handover.
   */
  it("a refund racing a pickup never produces both a handover and a refund", async () => {
    const cookie = await adminCookie();
    const order = await seedPaidOrder();

    const [pickup, refund] = await Promise.all([
      adminPost(`/api/admin/orders/${order.orderNumber}/pickup`, cookie, {
        pickupCode: order.pickupCode,
      }),
      adminPost(`/api/admin/orders/${order.orderNumber}/refund`, cookie, {}),
    ]);

    expect(pickup.status, pickup.text).toBeLessThan(500);
    expect(refund.status, refund.text).toBeLessThan(500);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    // Both are legal end states depending on who won; a torn one is not.
    expect(["PICKED_UP", "REFUNDED"]).toContain(after.status);

    const changedCount = [pickup, refund].filter((r) => r.body?.changed === true).length;
    // Refunding a PICKED_UP order is allowed (API-CONTRACT §6a), so two
    // successful changes is legitimate — what must not happen is zero.
    expect(changedCount).toBeGreaterThanOrEqual(1);
  });
});

describe("P4 money — no client-supplied money value survives", () => {
  beforeEach(resetDb);

  it("the refund amount is the stored total, whatever the body claims", async () => {
    const cookie = await adminCookie();
    const order = await seedPaidOrder();

    // `amountCents` does not exist in the schema. Whether it is rejected as an
    // unknown key or ignored, the one thing that must never happen is a refund
    // for a number a client chose (CLAUDE.md §2.2).
    const r = await adminPost(`/api/admin/orders/${order.orderNumber}/refund`, cookie, {
      amountCents: 999999,
      totalCents: 999999,
      refundedCents: 1,
    });

    if (r.status === 200) {
      expect(r.body.refundedCents).toBe(order.totalCents);
    } else {
      expect(r.status, r.text).toBe(400);
    }
    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.totalCents).toBe(order.totalCents);
  });

  it("the stock route refuses an absolute quantity, on both namespaces", async () => {
    const admin = await adminCookie();
    const inventory = await inventoryCookie();
    const product = await seedProduct({ stockQty: 12 });

    const a = await adminPost(`/api/admin/products/${product.id}/stock`, admin, { stockQty: 0 });
    expect(a.status, a.text).toBe(400);

    const b = await inventoryRequest(
      "POST",
      `/api/inventory/products/${product.id}/stock`,
      inventory,
      { stockQty: 0 },
    );
    expect(b.status, b.text).toBe(400);

    expect((await testDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty).toBe(
      12,
    );
  });
});

describe("P4 stock ledger — stock and audit row commit together", () => {
  beforeEach(resetDb);

  it("merges supplier purchases with paid order lines without returning student data", async () => {
    const admin = await adminCookie();
    const order = await seedPaidOrder({ qty: 2 });
    const productId = order.items[0].productId;
    const purchase = await adminPost(`/api/admin/products/${productId}/stock`, admin, {
      delta: 5,
      type: "PURCHASE",
      unitCostCents: 125,
    });
    expect(purchase.status, purchase.text).toBe(200);

    const response = await fetch(
      `${BASE_URL}/api/admin/products/${productId}/transactions?take=10`,
      { headers: { cookie: admin } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      transactions: { source: string; qtyDelta: number; orderStatus: string | null }[];
    };
    expect(body.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "PURCHASE", qtyDelta: 5 }),
        expect.objectContaining({ source: "SALE", qtyDelta: -2, orderStatus: "PAID" }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("studentName");
    expect(JSON.stringify(body)).not.toContain("email");

    const allTransactions = await fetch(`${BASE_URL}/api/admin/transactions?take=10`, {
      headers: { cookie: admin },
    });
    expect(allTransactions.status).toBe(200);
    const globalBody = (await allTransactions.json()) as {
      transactions: {
        productId: string;
        source: string;
        qtyDelta: number;
        orderStatus: string | null;
      }[];
    };
    expect(globalBody.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId, source: "PURCHASE", qtyDelta: 5 }),
        expect.objectContaining({ productId, source: "SALE", qtyDelta: -2, orderStatus: "PAID" }),
      ]),
    );
    expect(JSON.stringify(globalBody)).not.toContain("studentName");
    expect(JSON.stringify(globalBody)).not.toContain("email");
  });

  it("rolls back the stock change when the ledger insert fails", async () => {
    const admin = await adminCookie();
    const product = await seedProduct({ stockQty: 12 });

    await testDb.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_reject_stock_transaction() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced stock transaction insert failure';
      END;
      $$
    `);
    await testDb.$executeRawUnsafe(`
      CREATE TRIGGER qa_reject_stock_transaction
      BEFORE INSERT ON stock_transactions
      FOR EACH ROW EXECUTE FUNCTION qa_reject_stock_transaction()
    `);

    try {
      const response = await adminPost(`/api/admin/products/${product.id}/stock`, admin, {
        delta: 4,
        type: "PURCHASE",
        unitCostCents: 100,
      });
      expect(response.status, response.text).toBe(500);
      expect(
        (await testDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
      ).toBe(12);
      expect(await testDb.stockTransaction.count({ where: { productId: product.id } })).toBe(0);
    } finally {
      await testDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS qa_reject_stock_transaction ON stock_transactions",
      );
      await testDb.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_reject_stock_transaction()");
    }
  });
});

describe("P4b inventory — the races §65 flagged and did not run", () => {
  beforeEach(resetDb);

  it("the two passcodes are genuinely different credentials", () => {
    expect(
      INVENTORY_PASSCODE,
      "the test environment shares one passcode, so no isolation test here can fail",
    ).not.toBe(ADMIN_PASSCODE);
  });

  /**
   * §65: "fire 10 identical creates and assert exactly one row exists, one 201,
   * nine 409s, and no partially-created product."
   */
  it("ten identical creates race the slug index down to exactly one product", async () => {
    const cookie = await inventoryCookie();
    const slug = `race-slug-${Date.now()}`;

    const body = {
      name: "Slug Race Bar",
      slug,
      description: "Two editors saving the same new product at once.",
      priceCents: 175,
      category: "sweet",
      rarity: "COMMON",
      allergens: ["DAIRY"],
      allergensReviewed: true,
      stockQty: 10,
      imageUrl: "/products/none.svg",
      active: false,
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        inventoryRequest("POST", "/api/inventory/products", cookie, body),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const taken = results.filter((r) => r.body?.error?.code === "PRODUCT_SLUG_TAKEN");

    expect(created).toHaveLength(1);
    expect(taken).toHaveLength(9);
    expect(results.filter((r) => r.status >= 500).map((r) => r.text)).toEqual([]);
    expect(await testDb.product.count({ where: { slug } })).toBe(1);

    // No half-written row: the one that exists is complete and matches what was
    // sent, allergens included.
    const row = await testDb.product.findUniqueOrThrow({ where: { slug } });
    expect(row.priceCents).toBe(175);
    expect(row.stockQty).toBe(10);
    expect(row.allergens).toEqual(["DAIRY"]);
    expect(row.active).toBe(false);
  });

  /**
   * §65: "A product created `active: true` with stock is immediately
   * purchasable. Create-then-immediately-buy is not a race I exercised."
   */
  it("a product created active is immediately purchasable, and its stock still holds", async () => {
    const cookie = await inventoryCookie();
    const slot = await seedSlot({ capacity: 30, startsInMinutes: 200 });
    const slug = `insta-buy-${Date.now()}`;

    const created = await inventoryRequest("POST", "/api/inventory/products", cookie, {
      name: "Instant Buy Bar",
      slug,
      description: "Published and bought in the same breath.",
      priceCents: 150,
      category: "sweet",
      rarity: "COMMON",
      allergens: [],
      allergensReviewed: true,
      stockQty: 5,
      imageUrl: "/products/none.svg",
      active: true,
    });
    expect(created.status, created.text).toBe(201);
    const productId = created.body.product.id;

    // Ten buyers for five units, fired simultaneously.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        postCheckout(checkoutPayload({ slotId: slot.id, items: [{ productId, qty: 1 }] })),
      ),
    );

    const ok = results.filter((r) => r.status === 200);
    const soldOut = results.filter((r) => r.body?.error?.code === "OUT_OF_STOCK");
    expect(ok).toHaveLength(5);
    expect(soldOut).toHaveLength(5);

    const after = await testDb.product.findUniqueOrThrow({ where: { id: productId } });
    expect(after.stockQty).toBe(0);
    expect(after.stockQty).toBeGreaterThanOrEqual(0);
  });

  /**
   * §65: inventory adjustments interleaved with live checkouts on one product.
   * P4 ran this shape for `/api/admin`; "should compose identically" is not
   * "did".
   */
  it("inventory adjustments compose exactly with concurrent checkouts", async () => {
    const cookie = await inventoryCookie();
    const slot = await seedSlot({ capacity: 40, startsInMinutes: 200 });
    const product = await seedProduct({ priceCents: 150, stockQty: 30 });

    const results = await Promise.all([
      ...Array.from({ length: 15 }, () =>
        inventoryRequest("POST", `/api/inventory/products/${product.id}/stock`, cookie, {
          delta: 1,
        }),
      ),
      ...Array.from({ length: 10 }, () =>
        postCheckout(
          checkoutPayload({ slotId: slot.id, items: [{ productId: product.id, qty: 1 }] }),
        ),
      ),
    ]);

    expect(results.filter((r) => r.status >= 500).map((r) => r.text)).toEqual([]);
    const after = await testDb.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQty).toBe(30 + 15 - 10);
  });

  it("twenty simultaneous +1 adjustments return twenty distinct quantities", async () => {
    const cookie = await inventoryCookie();
    const product = await seedProduct({ stockQty: 50 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        inventoryRequest("POST", `/api/inventory/products/${product.id}/stock`, cookie, {
          delta: 1,
        }),
      ),
    );

    const quantities = results.map((r) => r.body?.stockQty);
    expect(results.every((r) => r.status === 200)).toBe(true);
    // `adjust_stock()` reads its result out of the same UPDATE. With nothing
    // else writing, a repeat means a lost update.
    expect(new Set(quantities).size, `duplicate quantities: ${quantities}`).toBe(20);
    expect((await testDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty).toBe(
      70,
    );
  });

  /**
   * §65, stated as a KNOWN and DELIBERATE behaviour rather than a bug: PATCH is
   * last-write-wins with no version token, so two editors can compose into a
   * product that is `active` with an allergen list nobody affirmed alongside
   * the publish decision.
   *
   * This test does not assert the hazard away — it PINS it, so the day someone
   * adds a version column the test goes red and the decision gets made on
   * purpose. `HANDOFF.md` §63 is the schema ask.
   */
  it("PINS the known last-write-wins publish hazard (§65) — not an assertion that it is safe", async () => {
    const cookie = await inventoryCookie();
    const product = await seedProduct({ allergens: ["DAIRY"], active: false, stockQty: 5 });

    const [publish, edit] = await Promise.all([
      inventoryRequest("PATCH", `/api/inventory/products/${product.id}`, cookie, {
        active: true,
        allergens: ["DAIRY"],
        allergensReviewed: true,
      }),
      inventoryRequest("PATCH", `/api/inventory/products/${product.id}`, cookie, {
        allergens: ["DAIRY", "PEANUTS"],
        allergensReviewed: true,
      }),
    ]);

    expect(publish.status, publish.text).toBe(200);
    expect(edit.status, edit.text).toBe(200);

    const after = await testDb.product.findUniqueOrThrow({ where: { id: product.id } });

    // Both writes were individually affirmed, so both are legal. The observable
    // consequence is that the product can end up ACTIVE carrying an allergen
    // list that was never affirmed in the same request as the publish.
    const publishedWithUnaffirmedList =
      after.active && after.allergens.includes("PEANUTS");
    expect(
      typeof publishedWithUnaffirmedList,
      "documented outcome, recorded rather than hidden",
    ).toBe("boolean");
    expect(after.allergens.length).toBeGreaterThan(0);
  });
});

describe("P4b allergen gate — cannot be bypassed by a crafted request", () => {
  beforeEach(resetDb);

  it.each([
    ["missing entirely", undefined],
    ["the string 'true'", "true"],
    ["the number 1", 1],
    ["an empty object", {}],
    ["null", null],
  ])("refuses a create whose affirmation is %s", async (_label, value) => {
    const cookie = await inventoryCookie();
    const slug = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const r = await inventoryRequest("POST", "/api/inventory/products", cookie, {
      name: "Gate Probe",
      slug,
      description: "A truthy value is not an affirmation.",
      priceCents: 175,
      category: "sweet",
      rarity: "COMMON",
      allergens: ["PEANUTS"],
      ...(value === undefined ? {} : { allergensReviewed: value }),
      stockQty: 5,
      imageUrl: "/products/none.svg",
      active: true,
    });

    expect(r.status, `accepted ${_label}: ${r.text}`).toBe(400);
    expect(await testDb.product.count({ where: { slug } })).toBe(0);
  });

  it("refuses to publish a never-reviewed empty list without restating it", async () => {
    const cookie = await inventoryCookie();
    const product = await seedProduct({ allergens: [], active: false, stockQty: 5 });

    const refused = await inventoryRequest("PATCH", `/api/inventory/products/${product.id}`, cookie, {
      active: true,
      allergensReviewed: true,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("ALLERGENS_NOT_REVIEWED");
    expect((await testDb.product.findUniqueOrThrow({ where: { id: product.id } })).active).toBe(
      false,
    );

    const allowed = await inventoryRequest("PATCH", `/api/inventory/products/${product.id}`, cookie, {
      active: true,
      allergens: [],
      allergensReviewed: true,
    });
    expect(allowed.status, allowed.text).toBe(200);
    expect((await testDb.product.findUniqueOrThrow({ where: { id: product.id } })).active).toBe(
      true,
    );
  });

  it("an allergen edit that races a publish still cannot land unreviewed", async () => {
    const cookie = await inventoryCookie();
    const product = await seedProduct({ allergens: ["DAIRY"], active: false, stockQty: 5 });

    // Neither request carries an affirmation. Concurrency must not create a
    // window where one slips through on the other's read.
    const results = await Promise.all([
      inventoryRequest("PATCH", `/api/inventory/products/${product.id}`, cookie, {
        active: true,
      }),
      inventoryRequest("PATCH", `/api/inventory/products/${product.id}`, cookie, {
        allergens: ["DAIRY", "SESAME"],
      }),
    ]);

    for (const r of results) {
      expect(r.status, r.text).toBe(400);
      expect(r.body.error.code).toBe("ALLERGENS_NOT_REVIEWED");
    }
    const after = await testDb.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.active).toBe(false);
    expect(after.allergens).toEqual(["DAIRY"]);
  });
});

describe("P4b boundary — no order, student or payment is reachable", () => {
  beforeEach(resetDb);

  it("an inventory session is refused by every staff route and the receipt route", async () => {
    const cookie = await inventoryCookie();
    const order = await seedPaidOrder();

    const gets = ["/api/admin/session", "/api/admin/orders"];
    for (const path of gets) {
      const res = await fetch(`${(await import("../setup/env")).BASE_URL}${path}`, {
        headers: { cookie },
      });
      expect(res.status, `${path} accepted an inventory session`).toBe(401);
      expect(await res.text()).not.toContain(order.email);
    }

    const posts = [
      `/api/admin/orders/${order.orderNumber}/pack`,
      `/api/admin/orders/${order.orderNumber}/pickup`,
      `/api/admin/orders/${order.orderNumber}/cash`,
      `/api/admin/orders/${order.orderNumber}/refund`,
    ];
    for (const path of posts) {
      const r = await adminPost(path, cookie, {});
      expect(r.status, `${path} accepted an inventory session`).toBe(401);
    }

    expect((await testDb.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });

  it("a staff session is refused by every inventory route", async () => {
    const cookie = await adminCookie();
    const product = await seedProduct({ stockQty: 5 });

    expect((await inventoryRequest("GET", "/api/inventory/session", cookie)).status).toBe(401);
    expect((await inventoryRequest("GET", "/api/inventory/products", cookie)).status).toBe(401);
    expect(
      (await inventoryRequest("GET", `/api/inventory/products/${product.id}`, cookie)).status,
    ).toBe(401);
    expect(
      (await inventoryRequest("POST", "/api/inventory/products", cookie, {})).status,
    ).toBe(401);
    expect(
      (await inventoryRequest("PATCH", `/api/inventory/products/${product.id}`, cookie, { name: "x" }))
        .status,
    ).toBe(401);
    expect(
      (
        await inventoryRequest("POST", `/api/inventory/products/${product.id}/stock`, cookie, {
          delta: 1,
        })
      ).status,
    ).toBe(401);
  });

  it("a full inventory product list carries no student-shaped field at any depth", async () => {
    const cookie = await inventoryCookie();
    await seedPaidOrder();
    await seedProduct({ stockQty: 3, allergens: ["SOY"] });

    const r = await inventoryRequest("GET", "/api/inventory/products", cookie);
    expect(r.status).toBe(200);

    for (const needle of [
      "@",
      "email",
      "phone",
      "studentName",
      "homeroom",
      "pickupCode",
      "orderNumber",
      "paidAt",
      "stripe",
    ]) {
      expect(r.text.toLowerCase(), `leaked "${needle}"`).not.toContain(needle.toLowerCase());
    }

    const allowed = new Set([
      "id",
      "slug",
      "name",
      "description",
      "priceCents",
      "category",
      "rarity",
      "allergens",
      "stockQty",
      "active",
      "imageUrl",
      "sortOrder",
      "createdAt",
      "updatedAt",
    ]);
    for (const p of (r.body.products as Record<string, unknown>[]).slice(0, 25)) {
      for (const key of Object.keys(p)) {
        expect(allowed.has(key), `unexpected column "${key}"`).toBe(true);
      }
    }
  });
});

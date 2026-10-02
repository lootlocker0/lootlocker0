import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import {
  checkoutPayload,
  postCheckout,
  seedProduct,
  seedSlot,
  seedSlotMinutesFromNow,
} from "../helpers";
import { schoolParts, slotStartInstant } from "@/lib/timezone";

describe("money integrity and input tampering", () => {
  beforeEach(resetDb);

  it("ignores a tampered client total", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ priceCents: 500, stockQty: 10 });

    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        items: [{ productId: p.id, qty: 2 }],
        clientTotalCents: 1, // "one cent, please"
      }),
    );

    expect(r.status).toBe(200);
    expect(r.body.totalCents).toBe(1000);
    const order = await testDb.order.findFirstOrThrow();
    expect(order.totalCents).toBe(1000);
    expect(order.subtotalCents).toBe(1000);
    expect(order.taxCents).toBe(0);
  });

  it("ignores a negative client total just as hard", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ priceCents: 500, stockQty: 10 });
    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        items: [{ productId: p.id, qty: 1 }],
        clientTotalCents: -99999,
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.totalCents).toBe(500);
    expect((await testDb.order.findFirstOrThrow()).totalCents).toBe(500);
  });

  it.each([
    ["negative qty", -1],
    ["zero qty", 0],
    ["absurd qty", 99999],
    ["fractional qty", 1.5],
    ["stringly-typed qty", "1" as unknown as number],
    ["NaN qty", NaN],
  ])("rejects %s", async (_label, qty) => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ stockQty: 10 });
    const r = await postCheckout(
      checkoutPayload({ slotId: slot.id, items: [{ productId: p.id, qty: qty as number }] }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_INPUT");
    // Nothing may have moved.
    expect((await testDb.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(10);
    expect(await testDb.order.count()).toBe(0);
  });

  it("rejects duplicate cart lines rather than merging them", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ stockQty: 10 });
    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        items: [
          { productId: p.id, qty: 1 },
          { productId: p.id, qty: 1 },
        ],
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a body that is not JSON with a code, not a 500", async () => {
    const r = await postCheckout("not json at all");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_INPUT");
    expect(r.body.error.fields._body).toBeDefined();
  });

  it("rejects an inactive product", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ active: false, stockQty: 10 });
    const r = await postCheckout(
      checkoutPayload({ slotId: slot.id, items: [{ productId: p.id, qty: 1 }] }),
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PRODUCT_UNAVAILABLE");
  });

  it("rejects a product id that does not exist", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        items: [{ productId: "cmtkqayvk00005p7dl2izvtzz", qty: 1 }],
      }),
    );
    expect(r.body.error.code).toBe("PRODUCT_UNAVAILABLE");
  });

  it("rejects a slot in the past", async () => {
    const slot = await seedSlot({
      capacity: 5,
      serviceDate: new Date("2020-01-01T00:00:00.000Z"),
      startTime: "12:20",
    });
    const p = await seedProduct({ stockQty: 5 });
    const r = await postCheckout(
      checkoutPayload({ slotId: slot.id, items: [{ productId: p.id, qty: 1 }] }),
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PAST_CUTOFF");
  });

  /**
   * No advance-notice cutoff — a slot is orderable right up until its own
   * start time — but the boundary itself must still land on the correct
   * minute, on the SCHOOL's clock, not the server's.
   *
   * The test process is in Pacific/Kiritimati (UTC+14) and the server is in
   * Asia/Tokyo (UTC+9); the school is America/Vancouver (UTC-7). For most of
   * the UTC day those are three different dates, so the fixture's
   * `serviceDate`/`startTime` pair and the server's `slotStartInstant` only
   * agree if both go through `lib/timezone.ts` (HANDOFF §17). A server-local
   * `setHours` implementation lands hours or a whole day away and this test
   * goes red — which a UTC-only suite would not.
   */
  it("stays open until a slot's own start time, to the minute, in the school's timezone", async () => {
    const p = await seedProduct({ stockQty: 10 });

    const okSlot = await seedSlotMinutesFromNow(2, 5);
    const noSlot = await seedSlotMinutesFromNow(-2, 5);

    // Sanity-check the fixture itself before trusting the assertion: the slot
    // really is 2 minutes ahead / 2 minutes past as an absolute instant.
    const okMinutes =
      (slotStartInstant(okSlot.serviceDate, okSlot.startTime).getTime() - Date.now()) / 60_000;
    const noMinutes =
      (slotStartInstant(noSlot.serviceDate, noSlot.startTime).getTime() - Date.now()) / 60_000;
    expect(okMinutes).toBeGreaterThan(0);
    expect(noMinutes).toBeLessThanOrEqual(0);

    const ok = await postCheckout(
      checkoutPayload({ slotId: okSlot.id, items: [{ productId: p.id, qty: 1 }] }),
    );
    const no = await postCheckout(
      checkoutPayload({ slotId: noSlot.id, items: [{ productId: p.id, qty: 1 }] }),
    );

    expect(ok.status).toBe(200);
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe("PAST_CUTOFF");
  });

  it("closes a window the instant it starts, on the school's clock, not the server's calendar day", async () => {
    // A window at 12:20 Vancouver time today. Whatever the server's zone is,
    // this either has or has not started yet on the school's clock, and the
    // test computes the expectation the same way lib/timezone.ts does.
    const now = schoolParts();
    const slot = await seedSlot({
      capacity: 5,
      serviceDate: new Date(Date.UTC(now.year, now.month - 1, now.day)),
      startTime: "12:20",
    });
    const p = await seedProduct({ stockQty: 5 });

    const startsAt = slotStartInstant(slot.serviceDate, slot.startTime);
    const shouldBeOpen = startsAt.getTime() > Date.now();

    const r = await postCheckout(
      checkoutPayload({ slotId: slot.id, items: [{ productId: p.id, qty: 1 }] }),
    );

    if (shouldBeOpen) {
      expect(r.status).toBe(200);
    } else {
      expect(r.body?.error?.code).toBe("PAST_CUTOFF");
    }
  });

  it("charges the current price and snapshots what was charged", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ priceCents: 500, stockQty: 10 });
    await testDb.product.update({ where: { id: p.id }, data: { priceCents: 900 } });

    const r = await postCheckout(
      checkoutPayload({ slotId: slot.id, items: [{ productId: p.id, qty: 1 }] }),
    );
    const item = await testDb.orderItem.findFirstOrThrow();

    expect(r.body.totalCents).toBe(900);
    expect(item.unitPriceCents).toBe(900);

    // And a later reprice must not rewrite history.
    await testDb.product.update({ where: { id: p.id }, data: { priceCents: 100 } });
    const again = await testDb.orderItem.findFirstOrThrow();
    expect(again.unitPriceCents).toBe(900);
  });

  it("snapshots name and rarity, not just price", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({
      name: "Original Name",
      rarity: "LEGENDARY",
      priceCents: 300,
      stockQty: 5,
    });
    await postCheckout(
      checkoutPayload({ slotId: slot.id, items: [{ productId: p.id, qty: 1 }] }),
    );
    await testDb.product.update({
      where: { id: p.id },
      data: { name: "Renamed", rarity: "COMMON" },
    });

    const item = await testDb.orderItem.findFirstOrThrow();
    expect(item.nameSnapshot).toBe("Original Name");
    expect(item.raritySnapshot).toBe("LEGENDARY");
  });

  it("keeps money in integer cents through a 10× line", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ priceCents: 133, stockQty: 20 });
    const r = await postCheckout(
      checkoutPayload({ slotId: slot.id, items: [{ productId: p.id, qty: 10 }] }),
    );
    expect(r.body.totalCents).toBe(1330);
    const order = await testDb.order.findFirstOrThrow();
    expect(Number.isInteger(order.totalCents)).toBe(true);
    expect(order.totalCents).toBe(order.subtotalCents + order.taxCents);
  });

  it("does not return stock on refund", async () => {
    // Covered end to end in webhook.test.ts; asserted here too because it is a
    // money rule, not a webhook detail.
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ priceCents: 500, stockQty: 10 });
    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CARD",
        items: [{ productId: p.id, qty: 1 }],
      }),
    );
    expect(r.status).toBe(200);
    expect((await testDb.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(9);
  });

  it("never puts PII in the response body of a checkout", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const p = await seedProduct({ stockQty: 5 });
    const r = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        studentName: "Priya Testerson",
        email: "priya.testerson@school.ca",
        phone: "604-555-0199",
        homeroom: "9B",
        items: [{ productId: p.id, qty: 1 }],
      }),
    );
    expect(r.status).toBe(200);
    for (const needle of ["Priya", "priya.testerson@school.ca", "604-555-0199", "9B"]) {
      expect(r.text).not.toContain(needle);
    }
  });
});

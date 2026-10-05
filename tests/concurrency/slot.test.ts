import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import { seedSlot, seedProduct, checkoutPayload, postCheckout, countBookedOrders } from "../helpers";
import { PICKUP_WINDOW_TEMPLATE, listPickupWindows } from "@/lib/pickup-windows";
import { slotStartInstant } from "@/lib/timezone";

/**
 * Pickup-window capacity under concurrent load.
 *
 * `Promise.all`, never a for-loop. A sequential loop passes against a
 * read-then-write `if (booked < capacity)` implementation, which is the single
 * most common way a suite like this reports a false green.
 *
 * There is no PickupSlot table anymore (lib/pickup-windows.ts): capacity
 * comes from a fixed in-code template and "booked" is a live count over
 * `orders`, serialized by book_pickup_window()'s transaction-scoped advisory
 * lock instead of a row lock. `seedSlot()` still gives each test an isolated,
 * arbitrary-capacity window via `test_pickup_windows` (lib/pickup-windows-
 * test.ts, QA_ALLOW_TEST_WINDOWS=1 — never in production) — see its doc
 * comment in tests/helpers.ts for why that isolation (a unique location per
 * test) is load-bearing, not cosmetic.
 */
describe("pickup-window capacity under concurrent load", () => {
  beforeEach(resetDb);

  it("admits exactly one order when one seat remains", async () => {
    const slot = await seedSlot({ capacity: 1 });
    const product = await seedProduct({ stockQty: 100 });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `student${i}@school.ca`,
            items: [{ productId: product.id, qty: 1 }],
          }),
        ),
      ),
    );

    const ok = results.filter((r) => r.status === 200);
    const full = results.filter((r) => r.body?.error?.code === "SLOT_FULL");

    expect(ok).toHaveLength(1);
    expect(full).toHaveLength(19);
    // Nobody may get a 500: SLOT_FULL is the expected answer for 19 of these,
    // and an unhandled error here means a deadlock or a pool timeout.
    expect(results.filter((r) => r.status === 500)).toHaveLength(0);

    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(booked).toBe(1);
    expect(booked).toBeLessThanOrEqual(slot.capacity);

    // The 19 losers' stock reservations must have rolled back with their seats.
    const p = await testDb.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(p.stockQty).toBe(99);
    expect(await testDb.order.count()).toBe(1);
  });

  it("never lets the booked count exceed capacity under sustained load", async () => {
    const slot = await seedSlot({ capacity: 5 });
    const product = await seedProduct({ stockQty: 1000 });

    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `s${i}@school.ca`,
            items: [{ productId: product.id, qty: 1 }],
          }),
        ),
      ),
    );

    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(booked).toBe(5);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(await testDb.order.count()).toBe(5);

    // Stock moved exactly as many times as a seat did.
    const p = await testDb.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(p.stockQty).toBe(995);
  });

  it("returns SLOT_FULL, not a 404 oracle, for a window id that resolves to nothing", async () => {
    const product = await seedProduct({ stockQty: 5 });
    const r = await postCheckout(
      checkoutPayload({
        // Well-formed composite shape, no such window — API-CONTRACT §6:
        // missing and full must be indistinguishable.
        slotId: "2099-01-01|09:00|Nowhere",
        items: [{ productId: product.id, qty: 1 }],
      }),
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("SLOT_FULL");
    expect(await testDb.order.count()).toBe(0);
  });

  // The old "deactivated slot" case has no replacement — there is no `active`
  // concept left. A window is either in the template (and resolvable) or it
  // isn't (SLOT_FULL), covered by the case above.

  /**
   * Exercises book_pickup_window() directly, against a synthetic tuple that
   * exists in no template at all — the primitive, isolated from checkout's
   * surrounding transaction, validation, and stock reservation. This is what
   * actually proves the advisory-lock race is closed; the checkout-level test
   * below proves the route wires the primitive correctly.
   */
  it("book_pickup_window() admits exactly `capacity` concurrent callers for the same window", async () => {
    const serviceDate = new Date("2031-06-15T00:00:00.000Z");
    const startTime = "09:00";
    const location = `race-${Math.random().toString(36).slice(2)}`;
    const capacity = 3;

    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () =>
        testDb.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ ok: boolean }[]>`
            SELECT book_pickup_window(${serviceDate}::timestamp, ${startTime}::text, ${location}::text, ${capacity}::int) AS ok
          `;
          const ok = rows[0]?.ok === true;
          if (ok) {
            // The real function's contract is "you may now insert, inside
            // this same transaction" — a caller that calls it and never
            // inserts is not exercising what checkout actually does.
            await tx.order.create({
              data: {
                orderNumber: `LL-RACE${Math.random().toString(36).slice(2, 8)}`,
                pickupCode: Math.random().toString(36).slice(2, 6).toUpperCase(),
                studentName: "Race Student",
                email: `race-${Math.random().toString(36).slice(2)}@school.ca`,
                phone: "604-555-0100",
                pickupLabel: "Race",
                pickupStartTime: startTime,
                pickupLocation: location,
                pickupServiceDate: serviceDate,
                paymentMethod: "CASH_AT_PICKUP",
                status: "RESERVED",
                subtotalCents: 0,
                taxCents: 0,
                totalCents: 0,
              },
            });
          }
          return ok;
        }, { isolationLevel: "ReadCommitted" }),
      ),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(capacity);
    expect(await countBookedOrders(serviceDate, startTime, location)).toBe(capacity);
  });

  /**
   * Checkout-level integration: one REAL template window (the smallest,
   * 18-capacity), pre-filled to capacity-1 by inserting orders directly
   * (bypassing checkout), then N concurrent real `POST /api/checkout`
   * requests at the one remaining seat. Proves the route wires
   * book_pickup_window() correctly end-to-end, without needing per-test
   * capacity control over the production template.
   */
  it("POST /api/checkout admits exactly one more order into an almost-full real template window", async () => {
    const smallest = [...PICKUP_WINDOW_TEMPLATE].sort((a, b) => a.capacity - b.capacity)[0];
    const now = new Date();
    // The real template's times are fixed wall-clock times (e.g. "11:20") —
    // whichever of today's..+6 school days is the first one where that exact
    // time hasn't already passed is the one to use. Picking "today" blindly
    // would resolve to a PAST_CUTOFF window half the time, depending on what
    // time of day this test happens to run.
    const upcoming = listPickupWindows(now)
      .filter((w) => w.startTime === smallest.startTime && w.location === smallest.location)
      .find((w) => slotStartInstant(w.serviceDate, w.startTime).getTime() > now.getTime());
    if (!upcoming) throw new Error("no upcoming occurrence of the smallest template window found");
    const serviceDate = upcoming.serviceDate;
    for (let i = 0; i < smallest.capacity - 1; i++) {
      await testDb.order.create({
        data: {
          orderNumber: `LL-PREFILL${i}${Math.random().toString(36).slice(2, 6)}`,
          pickupCode: Math.random().toString(36).slice(2, 6).toUpperCase(),
          studentName: "Prefill Student",
          email: `prefill-${i}-${Math.random().toString(36).slice(2)}@school.ca`,
          phone: "604-555-0100",
          pickupLabel: smallest.label,
          pickupStartTime: smallest.startTime,
          pickupLocation: smallest.location,
          pickupServiceDate: serviceDate,
          paymentMethod: "CASH_AT_PICKUP",
          status: "RESERVED",
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
        },
      });
    }
    expect(await countBookedOrders(serviceDate, smallest.startTime, smallest.location)).toBe(
      smallest.capacity - 1,
    );

    const slotId = upcoming.id;
    const product = await seedProduct({ stockQty: 100 });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postCheckout(
          checkoutPayload({
            slotId,
            email: `last-seat-${i}@school.ca`,
            items: [{ productId: product.id, qty: 1 }],
          }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error?.code === "SLOT_FULL")).toHaveLength(9);
    expect(
      await countBookedOrders(serviceDate, smallest.startTime, smallest.location),
    ).toBe(smallest.capacity);
  });
});

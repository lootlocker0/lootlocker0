import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import {
  checkoutPayload,
  countBookedOrders,
  paymentIntentSucceeded,
  postCheckout,
  postWebhook,
  seedProduct,
  seedSlot,
  spend,
  spendAttempt,
} from "../helpers";
import { schoolDayStartInstant } from "@/lib/timezone";

const CAP = 1500; // lib/settings.ts default; the settings table is left empty.

/**
 * The daily spend cap. HANDOFF §21 calls the race here "the single most
 * exploitable hole in the route" and explicitly did not test it.
 */
describe("daily spend cap", () => {
  beforeEach(resetDb);

  it("enforces the cap at the boundary, sequentially", async () => {
    const slot = await seedSlot({ capacity: 20 });
    const email = "kid@school.ca";

    await spend(email, 1400, slot.id);
    expect((await spendAttempt(email, 100, slot.id)).status).toBe(200);

    const over = await spendAttempt(email, 1, slot.id);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("SPEND_CAP_EXCEEDED");
    expect(over.body.error.capCents).toBe(CAP);
    expect(over.body.error.spentCents).toBe(1500);

    const sum = await testDb.order.aggregate({
      _sum: { totalCents: true },
      where: { email },
    });
    expect(sum._sum.totalCents).toBe(1500);
  });

  it("cannot be sidestepped by changing the capitalisation of the email", async () => {
    const slot = await seedSlot({ capacity: 20 });
    await spend("kid@school.ca", 1400, slot.id);

    const r = await spendAttempt("  KID@School.CA  ", 200, slot.id);
    expect(r.body?.error?.code).toBe("SPEND_CAP_EXCEEDED");
  });

  /**
   * REGRESSION for HANDOFF §31 (was `it.fails`, converted 2026-09-03 after the
   * fix landed).
   *
   * The cap used to be a read-then-write with no lock and no database
   * constraint behind it: every concurrent checkout aggregated the same `spent`
   * value, every one of them passed the check, and every one of them committed
   * — six accepted, 1800c against a 1500c cap. It is now the first statement of
   * the checkout transaction, behind
   * `pg_advisory_xact_lock(hashtextextended(email + ':' + school day, 0))`.
   *
   * Six simultaneous 300c orders for one address. Each is individually well
   * under the 1500c cap; together they are 1800c, so exactly one must be
   * refused.
   */
  it("holds the cap under six concurrent checkouts for one address", async () => {
    const slot = await seedSlot({ capacity: 50 });
    const email = "racer@school.ca";
    const products = await Promise.all(
      Array.from({ length: 6 }, () => seedProduct({ priceCents: 300, stockQty: 10 })),
    );

    const results = await Promise.all(
      products.map((p) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email,
            paymentMethod: "CASH_AT_PICKUP",
            items: [{ productId: p.id, qty: 1 }],
          }),
        ),
      ),
    );

    const accepted = results.filter((r) => r.status === 200).length;
    const capped = results.filter(
      (r) => r.body?.error?.code === "SPEND_CAP_EXCEEDED",
    ).length;
    const committed =
      (
        await testDb.order.aggregate({
          _sum: { totalCents: true },
          where: { email, status: { in: ["RESERVED", "PAID", "PACKED", "PICKED_UP"] } },
        })
      )._sum.totalCents ?? 0;

    // Evidence for docs/HANDOFF.md, printed on every run.
    console.log(
      `[spend-cap race] 6×300c concurrent for one email: accepted=${accepted} ` +
        `capped=${capped} committedCents=${committed} capCents=${CAP}`,
    );

    // What must hold: a student can never commit more than the cap in a day.
    expect(committed).toBeLessThanOrEqual(CAP);
    // And exactly, not approximately: 5×300c is the most that fits under 1500c,
    // so the sixth — and only the sixth — has to be the one that is refused.
    expect(accepted).toBe(5);
    expect(capped).toBe(1);
    expect(committed).toBe(1500);
    // Nobody degraded to a bare 500 while queueing on the advisory lock.
    expect(results.filter((r) => r.status === 500)).toHaveLength(0);
  });

  /**
   * The same invariant under a burst four times the size, against a cap that
   * only three of the requests can fit under. HANDOFF §46 asks for exactly
   * this: "confirm `committed <= cap` holds exactly, not approximately".
   *
   * 20 × 400c, cap 1500c. Whatever order the lock grants in, the arithmetic is
   * forced: 400, 800, 1200 fit; the fourth would be 1600. So accepted is 3 and
   * committed is 1200 — there is no interleaving that produces any other
   * number, which is what makes this an equality assertion and not a bound.
   */
  it("admits exactly three of twenty concurrent 400c checkouts against a 1500c cap", async () => {
    const slot = await seedSlot({ capacity: 60 });
    const email = "burst@school.ca";
    const products = await Promise.all(
      Array.from({ length: 20 }, () => seedProduct({ priceCents: 400, stockQty: 5 })),
    );

    const started = Date.now();
    const results = await Promise.all(
      products.map((p) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email,
            paymentMethod: "CASH_AT_PICKUP",
            items: [{ productId: p.id, qty: 1 }],
          }),
        ),
      ),
    );
    const elapsed = Date.now() - started;

    const accepted = results.filter((r) => r.status === 200).length;
    const capped = results.filter(
      (r) => r.body?.error?.code === "SPEND_CAP_EXCEEDED",
    ).length;
    const committed =
      (
        await testDb.order.aggregate({
          _sum: { totalCents: true },
          where: { email, status: { in: ["RESERVED", "PAID", "PACKED", "PICKED_UP"] } },
        })
      )._sum.totalCents ?? 0;

    console.log(
      `[spend-cap burst] 20×400c concurrent on one mailbox: accepted=${accepted} ` +
        `capped=${capped} committedCents=${committed} capCents=${CAP} in ${elapsed}ms`,
    );

    expect(committed).toBeLessThanOrEqual(CAP);
    expect(accepted).toBe(3);
    expect(committed).toBe(1200);
    expect(capped).toBe(17);
    // HANDOFF §46's other half: the lock is held for the whole transaction, so
    // one mailbox is strictly serial. The tail must still get a coded 409 —
    // never an `INTERNAL` 500 from blowing past the 5s maxWait / 15s timeout.
    expect(results.filter((r) => r.status === 500)).toHaveLength(0);
    expect(accepted + capped).toBe(20);
  });

  /**
   * The lock's SCOPE, not just its effect. HANDOFF §31 claims it "serialises one
   * mailbox on one day and nothing else"; the manager measured that but never
   * committed a test for it.
   *
   * Asserting on wall-clock timing alone would be flaky, so this proves it
   * structurally instead: a separate database session takes the *exact* advisory
   * lock key the route derives (`<lowercased email>:<school day ISO>`) and holds
   * it. While it is held, a checkout for that mailbox cannot make progress, and
   * checkouts for twelve other mailboxes must all complete anyway. Releasing the
   * lock lets the blocked one through.
   *
   * If the first assertion below ever fails — the victim's checkout completing
   * while the key is held — it means the route no longer derives the key this
   * way, and the same-mailbox serialisation this file depends on is gone.
   */
  it("serialises one mailbox only: other students never wait on it", async () => {
    const slot = await seedSlot({ capacity: 40 });
    const victimEmail = "victim@school.ca";
    const lockKey = `${victimEmail}:${schoolDayStartInstant().toISOString()}`;

    const victimProduct = await seedProduct({ priceCents: 300, stockQty: 5 });
    const otherProducts = await Promise.all(
      Array.from({ length: 12 }, () => seedProduct({ priceCents: 1400, stockQty: 5 })),
    );

    let lockAcquired!: () => void;
    const acquired = new Promise<void>((res) => (lockAcquired = res));
    let releaseLock!: () => void;
    const held = new Promise<void>((res) => (releaseLock = res));

    // Session-scoped hold: `pg_advisory_xact_lock` inside an interactive
    // transaction is released by Postgres when this transaction commits, so
    // there is nothing to unlock by hand even if the test throws.
    const holder = testDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        lockAcquired();
        await held;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    await acquired;

    let victimSettled = false;
    const victim = postCheckout(
      checkoutPayload({
        slotId: slot.id,
        email: victimEmail,
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: victimProduct.id, qty: 1 }],
      }),
    ).then((r) => {
      victimSettled = true;
      return r;
    });

    const startedOthers = Date.now();
    const others = await Promise.all(
      otherProducts.map((p, i) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email: `mailbox${i}@school.ca`,
            paymentMethod: "CASH_AT_PICKUP",
            items: [{ productId: p.id, qty: 1 }],
          }),
        ),
      ),
    );
    const othersMs = Date.now() - startedOthers;

    console.log(
      `[spend-cap lock scope] 12 other mailboxes while one is lock-blocked: ` +
        `accepted=${others.filter((r) => r.status === 200).length}/12 in ${othersMs}ms ` +
        `victimSettled=${victimSettled}`,
    );

    // Twelve different students, each spending 1400c — every one of them must
    // commit, and none of them may inherit the blocked mailbox's wait.
    expect(others.map((r) => r.status)).toEqual(Array(12).fill(200));
    // And the blocked one really is blocked, which is what makes the line above
    // mean something.
    expect(victimSettled).toBe(false);

    releaseLock();
    await holder;

    const v = await victim;
    expect(v.status).toBe(200);
    expect(
      (
        await testDb.order.aggregate({
          _sum: { totalCents: true },
          where: { email: victimEmail },
        })
      )._sum.totalCents,
    ).toBe(300);
  });

  /**
   * ADVERSARIAL — the lock key is built from the request's email, and the cap
   * aggregate matches on the same value. If the key were ever derived BEFORE
   * `checkoutSchema` normalises (`.trim().toLowerCase()`), eight concurrent
   * requests writing the address eight different ways would take eight
   * different locks, and §31's race would be open again to anyone who can hold
   * down the shift key. Two different pickup windows as well, since the key is
   * mailbox + day and must not be per-slot.
   */
  it("cannot be raced by spelling the same address eight different ways", async () => {
    const slotA = await seedSlot({ capacity: 20 });
    const slotB = await seedSlot({ capacity: 20 });
    const variants = [
      "case@school.ca",
      "CASE@school.ca",
      "Case@School.Ca",
      "  case@school.ca  ",
      "cAsE@school.ca",
      "CASE@SCHOOL.CA",
      "\tcase@School.ca ",
      "Case@school.CA",
    ];
    const products = await Promise.all(
      variants.map(() => seedProduct({ priceCents: 300, stockQty: 5 })),
    );

    const results = await Promise.all(
      variants.map((email, i) =>
        postCheckout(
          checkoutPayload({
            slotId: i % 2 === 0 ? slotA.id : slotB.id,
            email,
            paymentMethod: "CASH_AT_PICKUP",
            items: [{ productId: products[i].id, qty: 1 }],
          }),
        ),
      ),
    );

    const accepted = results.filter((r) => r.status === 200).length;
    const committed =
      (
        await testDb.order.aggregate({
          _sum: { totalCents: true },
          where: { email: "case@school.ca" },
        })
      )._sum.totalCents ?? 0;

    console.log(
      `[spend-cap case race] 8×300c concurrent across 8 spellings and 2 windows: ` +
        `accepted=${accepted} committedCents=${committed}`,
    );

    expect(committed).toBeLessThanOrEqual(CAP);
    expect(accepted).toBe(5);
    expect(committed).toBe(1500);
    // Every one of them landed in the one canonical mailbox, so there is no
    // second bucket hiding the rest of the money.
    expect(await testDb.order.count()).toBe(5);
  });

  /**
   * HANDOFF §46's availability question, made into a regression test: the lock
   * is held for the whole transaction, so 60 checkouts for one address are now
   * strictly serial. They must QUEUE, not fall over — every one of them a 200,
   * none of them the bare `INTERNAL` 500 that a blown `maxWait`/`timeout`
   * produces, and the committed sum exactly equal to the number that succeeded.
   *
   * 60 is deliberately well below the measured ceiling (see the P3 step 4 notes
   * in docs/HANDOFF.md: 150 → 2.4s all-200, 500 → 7.6s all-200, 800 → 11% 500s).
   * A test pinned near the ceiling would be a flake on shared CI hardware, and
   * the ceiling is an availability number, not a correctness one.
   */
  it("queues rather than fails when 60 checkouts hit one mailbox at once", async () => {
    const email = "queue@school.ca";
    const slot = await seedSlot({ capacity: 80 });
    // 1c each: 60c total stays under the 1500c cap, so every one of them runs
    // the FULL transaction (lock, aggregate, book_slot, reserve_stock, insert)
    // rather than short-circuiting on the cap check.
    const products = await Promise.all(
      Array.from({ length: 60 }, () => seedProduct({ priceCents: 1, stockQty: 5 })),
    );

    const started = Date.now();
    const results = await Promise.all(
      products.map((p) =>
        postCheckout(
          checkoutPayload({
            slotId: slot.id,
            email,
            paymentMethod: "CASH_AT_PICKUP",
            items: [{ productId: p.id, qty: 1 }],
          }),
        ),
      ),
    );
    const ms = Date.now() - started;

    const ok = results.filter((r) => r.status === 200).length;
    console.log(
      `[spend-cap queue] 60 concurrent 1c checkouts on one mailbox: ok=${ok}/60 ` +
        `500s=${results.filter((r) => r.status === 500).length} in ${ms}ms`,
    );

    expect(results.filter((r) => r.status === 500)).toHaveLength(0);
    expect(ok).toBe(60);
    const committed = (
      await testDb.order.aggregate({ _sum: { totalCents: true }, where: { email } })
    )._sum.totalCents;
    expect(committed).toBe(60);
    // The books have to balance under the queue as well as the cap: one seat per
    // committed order, no more.
    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(booked).toBe(60);
    expect(booked).toBeLessThanOrEqual(slot.capacity);
  });

  /**
   * The same money, one request at a time, is correctly refused — which is what
   * makes the concurrent case a race rather than a misconfiguration.
   */
  it("refuses the same six orders when they arrive sequentially", async () => {
    const slot = await seedSlot({ capacity: 50 });
    const email = "sequential@school.ca";
    let accepted = 0;
    for (let i = 0; i < 6; i++) {
      const r = await spendAttempt(email, 300, slot.id);
      if (r.status === 200) accepted++;
    }
    expect(accepted).toBe(5);
    const committed = (
      await testDb.order.aggregate({ _sum: { totalCents: true }, where: { email } })
    )._sum.totalCents;
    expect(committed).toBe(1500);
  });

  /**
   * Documented-by-design, and HANDOFF §21 asks for it to be tested and then put
   * in front of the human: `PENDING` is excluded from the cap aggregate, so a
   * student can hold an unlimited number of unpaid card orders, each under the
   * cap, and pay all of them. The cap only ever constrains money already
   * committed.
   *
   * CLAUDE.md §7 puts changes to the spend cap on the human escalation list,
   * and this is effectively a cap change.
   */
  it("does not count PENDING card orders, so four 1400c holds can all be paid", async () => {
    const slot = await seedSlot({ capacity: 20 });
    const email = "holder@school.ca";

    const orders = [];
    for (let i = 0; i < 4; i++) {
      const p = await seedProduct({ priceCents: 1400, stockQty: 5 });
      const r = await postCheckout(
        checkoutPayload({
          slotId: slot.id,
          email,
          paymentMethod: "CARD",
          items: [{ productId: p.id, qty: 1 }],
        }),
      );
      expect(r.status).toBe(200); // never capped, however many are outstanding
      orders.push(r.body.orderNumber as string);
    }

    const rows = await testDb.order.findMany({
      where: { email },
      select: { id: true, stripePaymentIntentId: true, totalCents: true },
    });
    for (const row of rows) {
      const w = await postWebhook(
        paymentIntentSucceeded(row.stripePaymentIntentId!, row.totalCents),
      );
      expect(w.status).toBe(200);
    }

    const paid = await testDb.order.aggregate({
      _sum: { totalCents: true },
      where: { email, status: "PAID" },
    });
    expect(paid._sum.totalCents).toBe(5600); // 3.7× the daily cap, all paid
  });

  /**
   * The cap window is the SCHOOL's day (`schoolDayStartInstant`), not the
   * server's. The test process runs in Pacific/Kiritimati and the server in
   * Asia/Tokyo, so a server-local implementation would draw the boundary in a
   * different place than this assertion does.
   */
  it("counts only orders placed since the school day began", async () => {
    const slot = await seedSlot({ capacity: 20 });
    const email = "yesterday@school.ca";
    const dayStart = schoolDayStartInstant();

    await spend(email, 1400, slot.id);

    // One second before the school's midnight: yesterday's money.
    await testDb.order.updateMany({
      where: { email },
      data: { createdAt: new Date(dayStart.getTime() - 1000) },
    });
    const fresh = await spendAttempt(email, 1400, slot.id);
    expect(fresh.status).toBe(200);

    // One second after the school's midnight: today's money, and it counts.
    await testDb.order.updateMany({
      where: { email },
      data: { createdAt: new Date(dayStart.getTime() + 1000) },
    });
    const blocked = await spendAttempt(email, 200, slot.id);
    expect(blocked.body?.error?.code).toBe("SPEND_CAP_EXCEEDED");
  });
});

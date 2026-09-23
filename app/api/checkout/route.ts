import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { checkoutSchema } from "@/lib/validation";
import { getSetting } from "@/lib/settings";
import { AppError, errorResponse } from "@/lib/errors";
import { applyBps } from "@/lib/money";
import { orderNumber, pickupCode, withRetryOnUnique } from "@/lib/codes";
import { rateLimit } from "@/lib/rate-limit";
import { logEvent, hashPii } from "@/lib/log";
import { schoolDayStartInstant, slotStartInstant } from "@/lib/timezone";
import { createOrderPaymentIntent } from "@/lib/stripe/payments";
import { getAccountUser } from "@/lib/account-auth";
import { releaseOrder } from "@/lib/db/release";
import { sendConfirmationEmail } from "@/lib/email";
import {
  assertOrderSessionConfigured,
  orderSessionCookie,
} from "@/lib/order-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The highest-risk code in the project. The order of operations is not
// negotiable; deviating causes oversells and double charges.
//
//   1. validate            reject before touching anything
//   2. rate limit          per IP and per email
//   3. reprice from the DB the client's total is evidence, never input
//   4. slot-time check     reject a slot whose start time has already passed,
//                          in the school's timezone, not the server's — no
//                          advance-notice cutoff beyond that
//   5. TRANSACTION         advisory lock (email+day) -> daily spend cap
//                          -> book_slot -> reserve_stock (sorted) -> create order
//   6. payment             cash is already done; card opens a PaymentIntent
//
// Alongside 1-2, not a numbered step of its own because it gates nothing: a
// best-effort read of the `ll_account` session (if any) tags the order with
// its `userId` for order history/reward points. Guest checkout is byte-for-
// byte unaffected — see the comment at that read.
//
// Stock is reserved BEFORE payment on purpose. A student who abandons checkout
// holds stock until `expiresAt` and the sweep gives it back. The alternative —
// reserving after payment clears — means occasionally charging for snacks that
// are not on the shelf and refunding a child at a locker with a queue behind
// them. The abandoned-cart cost is the cheaper failure.

export async function POST(req: NextRequest) {
  try {
    // ── 0. Refuse before touching anything if we cannot issue a receipt. ──────
    // Every successful response below sets a signed cookie that is the ONLY way
    // the student will ever read their order back (GET /api/orders/…). With no
    // signing secret we could still take the money and still hold the stock, and
    // the student would get a confirmation page that says the order does not
    // exist. Checked here, first, so the failure costs nobody anything.
    assertOrderSessionConfigured();

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    // ── 1. Validate. Never coerce. ────────────────────────────────────────────
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      // A body that is not JSON is a 400 with a code, not an unhandled 500.
      throw new AppError("INVALID_INPUT", {
        fields: { _body: ["Request body must be JSON."] },
      });
    }

    const parsed = checkoutSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data;

    // ── 1b. Best-effort account attribution. Never gates anything. ───────────
    // If the browser also carries a valid `ll_account` session, the order it's
    // about to place gets tagged with that account for order history and
    // reward points — going forward only, never retroactively (no email
    // verification exists at signup, so linking by email match would let
    // anyone see a stranger's history just by signing up with a known email).
    // Guest checkout — no cookie, an expired one, anything short of a valid
    // session — must resolve to `null` and change nothing else about this
    // request; `getAccountUser` already does that, the `.catch` is only so a
    // future change to it can never take checkout down with it.
    const accountUser = await getAccountUser(req).catch(() => null);

    // ── 2. Rate limit. ────────────────────────────────────────────────────────
    // Two dimensions because they catch different things: the IP limit catches
    // one bot cycling stolen cards, the email limit catches a distributed
    // attempt that rotates IPs but keeps one address. The email is hashed —
    // it is a child's address and it never reaches a log line or a Redis key
    // intact (CLAUDE.md §2.6).
    await rateLimit(`checkout:ip:${ip}`, 10, 60);
    await rateLimit(`checkout:email:${hashPii(input.email)}`, 5, 60);

    // ── 3. Recompute from the database. ───────────────────────────────────────
    const products = await db.product.findMany({
      where: { id: { in: input.items.map((i) => i.productId) }, active: true },
      select: {
        id: true,
        name: true,
        priceCents: true,
        rarity: true,
        allergens: true,
      },
    });

    // Duplicate lines are already rejected by the schema, so a short result can
    // only mean a product is missing or inactive.
    if (products.length !== input.items.length) {
      throw new AppError("PRODUCT_UNAVAILABLE");
    }

    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = input.items.map((i) => {
      const p = byId.get(i.productId)!;
      // Snapshots, written once (CLAUDE.md §2.5). Correcting a product's
      // allergens tomorrow must not rewrite what a student was handed today.
      return {
        productId: p.id,
        qty: i.qty,
        nameSnapshot: p.name,
        unitPriceCents: p.priceCents,
        raritySnapshot: p.rarity,
        allergensSnapshot: p.allergens,
      };
    });

    const subtotalCents = lines.reduce(
      (a, l) => a + l.unitPriceCents * l.qty,
      0,
    );
    const taxCents = applyBps(subtotalCents, await getSetting("tax_rate_bps"));
    const totalCents = subtotalCents + taxCents;

    if (
      input.clientTotalCents !== undefined &&
      input.clientTotalCents !== totalCents
    ) {
      logEvent("total_mismatch", {
        emailHash: hashPii(input.email),
        client: input.clientTotalCents,
        server: totalCents,
      });
      // We do NOT throw. We charge the correct amount and let the UI reconcile.
      // Throwing here would break the legitimate race where staff repriced an
      // item while a cart was open.
    }

    // The daily spend cap is checked inside the transaction below, not here.
    // See the comment on the advisory lock: a check outside the transaction is
    // a read-then-write and six concurrent carts for one address all pass it.
    const cap = await getSetting("daily_spend_cap_cents");
    // The school's midnight, not the server's. On a UTC server, server-local
    // midnight is 17:00 the previous afternoon in Vancouver, which would reset
    // a child's daily limit in the middle of the school day.
    const startOfDay = schoolDayStartInstant();

    // No advance-notice cutoff (e.g. no "must order 45 minutes ahead" rule) —
    // customers can place an order right up until a slot's own start time.
    // What is NOT optional is rejecting a slot whose start time has already
    // passed: nothing else in this codebase ever deactivates a slot once its
    // window opens (`active` is a manual staff/seed flag, not a clock), and
    // `GET /api/slots` only filters by calendar day, so a stale tab or a
    // replayed request with this morning's slotId would otherwise still
    // reserve a seat, decrement stock, and charge a card for a pickup that
    // already happened.
    const slot = await db.pickupSlot.findUnique({
      where: { id: input.slotId },
      select: { id: true, active: true, serviceDate: true, startTime: true },
    });
    // A missing or deactivated slot is reported as SLOT_FULL rather than as a
    // 404: the student's next move is identical (refetch the slot list and pick
    // another window), and an id-probing response that distinguishes "no such
    // slot" from "full" tells a scraper more than it tells a student.
    if (!slot || !slot.active) throw new AppError("SLOT_FULL");
    if (slotStartInstant(slot.serviceDate, slot.startTime).getTime() <= Date.now()) {
      throw new AppError("PAST_CUTOFF");
    }

    // ── 5. The transaction. ───────────────────────────────────────────────────
    const ttlMin = await getSetting("pending_order_ttl_minutes");
    // The advisory-lock key: one mailbox, one school day. Hashed in Postgres by
    // hashtextextended() rather than in JS so the key is derived the same way
    // from every process and every runtime version, and so a child's address
    // never becomes a value we carry around ourselves.
    const capLockKey = `${input.email}:${startOfDay.toISOString()}`;
    // Cash orders are RESERVED the moment they exist; see the note at the
    // creation call below.
    const isCard = input.paymentMethod === "CARD";

    const order = await withRetryOnUnique(() =>
      db.$transaction(
        async (tx) => {
          // ── 5a. Serialise this mailbox for the rest of the transaction. ─────
          // docs/HANDOFF.md §31: without this, six simultaneous 300c checkouts
          // for one address against a 1500c cap all aggregated `spent = 0`, all
          // passed, and all committed — 1800c. There is no `reserve_spend()` the
          // way there is a `reserve_stock()`, because the cap is a sum over rows
          // that do not exist yet; a single UPDATE ... WHERE cannot express it.
          // So the lock is explicit instead.
          //
          // pg_advisory_xact_lock is released by Postgres at commit OR rollback,
          // and the commit is recorded before the lock is released — so the next
          // holder's aggregate (a fresh READ COMMITTED snapshot, taken after the
          // lock is granted) always sees the previous holder's committed order.
          // Nothing to unlock by hand, and nothing leaks if this process dies.
          //
          // Taken FIRST, before book_slot and reserve_stock, for two reasons:
          // the cap is the cheapest failure and should not cost a seat and a
          // stock decrement to discover, and taking it before any row lock keeps
          // one global lock order (mailbox → slot → products ascending) that
          // cannot deadlock against lib/db/release.ts.
          //
          // It serialises one mailbox on one day and nothing else. Two different
          // students hash to different keys and never wait on each other, so
          // this is not a lunch-rush bottleneck.
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${capLockKey}, 0))
          `;

          // ── 5b. Daily spend cap, re-read under the lock. ────────────────────
          // PENDING is deliberately excluded: an abandoned cart must not block
          // re-ordering for fifteen minutes. The known consequence — unpaid
          // holds are unbounded — is docs/HANDOFF.md §39, resolved by the human.
          const spent = await tx.order.aggregate({
            _sum: { totalCents: true },
            where: {
              email: input.email,
              createdAt: { gte: startOfDay },
              status: { in: ["PAID", "RESERVED", "PACKED", "PICKED_UP"] },
            },
          });
          const spentCents = spent._sum.totalCents ?? 0;

          if (spentCents + totalCents > cap) {
            // Rolls back a transaction that has taken nothing but the advisory
            // lock, which is exactly why this check runs first.
            throw new AppError("SPEND_CAP_EXCEEDED", { capCents: cap, spentCents });
          }

          // Atomic slot booking. The WHERE clause does the capacity check in the
          // same statement as the write — an app-level `if (booked < capacity)`
          // reads outside the lock and loses this race every time.
          const slotRows = await tx.$queryRaw<{ ok: boolean }[]>`
            SELECT book_slot(${input.slotId}::text) AS ok
          `;
          if (slotRows[0]?.ok !== true) throw new AppError("SLOT_FULL");

          // Atomic stock reservation, one product at a time, ascending by id.
          // The sort is load-bearing: it fixes the order in which row locks are
          // taken, so two carts holding the same two products cannot deadlock by
          // approaching them from opposite ends. lib/db/release.ts follows the
          // same order (slot first, then products ascending) for the same reason.
          for (const l of [...lines].sort((a, b) =>
            a.productId.localeCompare(b.productId),
          )) {
            const stockRows = await tx.$queryRaw<{ ok: boolean }[]>`
              SELECT reserve_stock(${l.productId}::text, ${l.qty}::int) AS ok
            `;
            if (stockRows[0]?.ok !== true) {
              // Throwing rolls the whole transaction back, including the seat
              // claimed above and every product already reserved on this pass.
              // A partial hold is never left behind.
              throw new AppError("OUT_OF_STOCK", { productName: l.nameSnapshot });
            }
          }

          return tx.order.create({
            data: {
              orderNumber: orderNumber(),
              pickupCode: pickupCode(),
              studentName: input.studentName,
              email: input.email,
              phone: input.phone,
              homeroom: input.homeroom,
              // null for a guest, or when the session cookie is missing/expired.
              // Attribution only — never read by any pricing, cap, stock, or
              // slot logic above, and this transaction behaves identically
              // whether or not it's set.
              userId: accountUser?.id ?? null,
              slotId: input.slotId,
              paymentMethod: input.paymentMethod,
              // DELTA FROM backend.md §3, which creates every order PENDING and
              // then updates cash orders to RESERVED after the transaction
              // commits. A crash in that window leaves a cash order stuck
              // PENDING with `expiresAt = null` — invisible to the sweep, which
              // only looks at CARD orders with an expiry — holding its stock and
              // its seat forever with no process that will ever release them.
              // Creating it RESERVED inside the transaction removes the window
              // entirely. The status is written once, atomically, with the hold
              // it describes.
              status: isCard ? "PENDING" : "RESERVED",
              subtotalCents,
              taxCents,
              totalCents,
              // Only a card order is on a clock. A cash order is a real
              // reservation from the moment it is made; nothing expires it.
              expiresAt: isCard
                ? new Date(Date.now() + ttlMin * 60_000)
                : null,
              items: { create: lines },
            },
            select: { id: true, orderNumber: true, pickupCode: true },
          });
        },
        {
          // The SQL functions in manual_constraints.sql are written against READ
          // COMMITTED semantics (a blocked UPDATE re-evaluates its WHERE after
          // taking the lock). Stated explicitly so a database configured with a
          // stricter default turns this into serialization errors nowhere.
          isolationLevel: "ReadCommitted",
          // Generous on purpose. Under a real lunch rush dozens of these queue
          // for a connection; timing out there produces a bare 500 instead of a
          // clean 409, which is the worst possible answer to give a student.
          maxWait: 5_000,
          timeout: 15_000,
        },
      ),
    );
    // withRetryOnUnique wraps the whole transaction, not just the insert.
    // Postgres aborts a transaction on the first failed statement, so retrying
    // an insert in place (backend.md §2) would hit "current transaction is
    // aborted" rather than a fresh code. Retrying the transaction is safe
    // because the failed attempt rolled its seat and stock back with it.

    // ── 6a. CASH — no Stripe involved at any point. ───────────────────────────
    if (!isCard) {
      // Not awaited into the response path in a way that can fail the order: the
      // reservation is already committed and durable. (Delivery is not built —
      // see lib/email.ts and API-CONTRACT §6.)
      await sendConfirmationEmail(order.id).catch((e) =>
        console.error("confirmation notification failed", e),
      );
      logEvent("order_reserved_cash", { orderId: order.id, totalCents });
      const res = NextResponse.json(
        {
          orderNumber: order.orderNumber,
          pickupCode: order.pickupCode,
          totalCents,
          requiresPayment: false,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
      // The receipt key. Same cookie on both payment paths, deliberately: the
      // confirmation page does not have to know how the order was paid for.
      res.cookies.set(orderSessionCookie(order));
      return res;
    }

    // ── 6b. CARD — open a PaymentIntent, idempotent on the order id. ──────────
    let intent;
    try {
      intent = await createOrderPaymentIntent({
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountCents: totalCents,
      });
    } catch (e) {
      // DELTA FROM backend.md §3, which has no failure path here and would leave
      // the order PENDING, holding stock and a seat, until the sweep expires it
      // fifteen minutes later — for a payment the student was never able to
      // attempt. Release it now instead. This is safe even if Stripe did create
      // the intent before the error: the client secret never left this function,
      // so nothing can confirm it, and the succeeded webhook would find no
      // PENDING order and no-op.
      logEvent("payment_intent_create_failed", { orderId: order.id });
      await releaseOrder(order.id, "CANCELLED").catch((releaseError) =>
        console.error("release after PaymentIntent failure", releaseError),
      );
      throw e;
    }

    await db.order.update({
      where: { id: order.id },
      data: { stripePaymentIntentId: intent.id },
    });

    logEvent("payment_intent_created", { orderId: order.id, totalCents });

    const res = NextResponse.json(
      {
        orderNumber: order.orderNumber,
        totalCents,
        requiresPayment: true,
        clientSecret: intent.clientSecret,
        // No pickupCode. A card order is not confirmed until Stripe says so —
        // handing over the locker code before payment would let a student walk
        // up with a code for an order that expired unpaid.
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    // Set before the student leaves for Stripe, not after they come back: the
    // return trip is a top-level navigation the server does not control, and a
    // SameSite=Lax cookie issued now survives it.
    res.cookies.set(orderSessionCookie(order));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}

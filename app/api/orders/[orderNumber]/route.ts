import type { NextRequest } from "next/server";
import type { OrderStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import {
  assertOrderSessionConfigured,
  orderSessionCookieName,
  verifyOrderSessionToken,
} from "@/lib/order-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The confirmation page, and the only way a student ever reads an order back.
//
// A card order is PENDING when POST /api/checkout returns, and the only thing
// that flips it to PAID is the Stripe webhook (CLAUDE.md §2.3) — so the page
// polls this route rather than believing Stripe.js. It is also where the pickup
// code for a card order finally appears, since checkout deliberately withholds
// it from an order that might still expire unpaid.
//
// AUTHORISATION IS THE COOKIE, NOT THE URL. `LL-#####` is a 90,000-value space
// that anyone can walk. The signed, httpOnly, per-order cookie set at checkout
// is what authorises the read (lib/order-session.ts, docs/HANDOFF.md §22). Every
// failure — no cookie, expired cookie, forged cookie, a valid cookie for a
// *different* order, or an order number that never existed — returns the exact
// same ORDER_NOT_FOUND. Nothing in the response distinguishes them, so probing
// order numbers reveals nothing, not even whether an order exists.
//
// WHAT IT DOES NOT RETURN: `studentName`, `email`, `phone`, `homeroom`. The
// cookie proves whose order this is; it is not a reason to hand back a child's
// contact details to render a receipt that does not need them (CLAUDE.md §2.6).

/// Order numbers are `LL-` plus digits (lib/codes.ts). Bounded rather than
/// pinned at five so widening the space (HANDOFF §21) does not silently break
/// every lookup.
const ORDER_NUMBER_RE = /^LL-\d{4,10}$/;

/// One answer for every failure mode. Never add a detail field to this.
function notFound(reason: string): never {
  logEvent("order_lookup_denied", { reason });
  throw new AppError("ORDER_NOT_FOUND");
}

/// The pickup code is a bearer token at the locker. It is released once the
/// order is genuinely claimable, and stays visible through the rest of its
/// life — a student re-opening the receipt after pickup should still see what
/// code they used, and staff scanning/reading it at PACKED is the exact moment
/// this exists to serve:
///
///   RESERVED   cash order, real reservation from the moment it was created
///   PAID       the webhook, and nothing else, has confirmed the money
///   PACKED     staff bagged it — this is when the code is read aloud
///   PICKED_UP  handed over. Terminal, and still fine to show on the receipt
///
/// Never for PENDING. A card order that is still PENDING may yet expire unpaid
/// and have its stock and seat given back — showing a code for it would put a
/// student at a locker with a code that stands for nothing. Same reasoning that
/// keeps `pickupCode` out of the card checkout response. Also never for
/// CANCELLED/EXPIRED/REFUNDED — none of those hold a live reservation, so the
/// code stands for nothing.
/// Typed against the enum so a status that stops existing is a compile error
/// rather than a code that silently never shows.
const CODE_VISIBLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "RESERVED",
  "PAID",
  "PACKED",
  "PICKED_UP",
]);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ orderNumber: string }> },
) {
  try {
    // A missing signing secret is a misconfiguration, not a missing order: no
    // cookie could verify, so every lookup would 404 and the "order does not
    // exist" would be a lie. Fail loudly instead. It leaks nothing — the answer
    // is identical for every order number, including ones that never existed.
    assertOrderSessionConfigured();

    const { orderNumber: rawParam } = await ctx.params;
    // Case-normalised because a student may retype the URL; codes.ts only ever
    // emits upper case. toUpperCase, not toLocaleUpperCase — this must not
    // depend on the server's locale.
    const orderNumber = rawParam.toUpperCase();
    if (!ORDER_NUMBER_RE.test(orderNumber)) notFound("malformed_order_number");

    // ── The cookie is the credential. ─────────────────────────────────────────
    // Named after the order so a student who placed two orders in one sitting
    // can open either receipt. The name is not trusted for anything: the token
    // itself binds the order's database id, and that id is re-checked against
    // this URL below. Copying one order's cookie value under another order's
    // cookie name therefore buys nothing.
    const token = req.cookies.get(orderSessionCookieName(orderNumber))?.value;
    const orderId = verifyOrderSessionToken(token);
    if (!orderId) notFound(token ? "invalid_token" : "no_cookie");

    // Note the database is only touched once a signature has verified, so a
    // flood of guessed order numbers costs one HMAC each and no query. That is
    // why this route is not rate limited — see API-CONTRACT §6.
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true,
        status: true,
        paymentMethod: true,
        pickupCode: true,
        subtotalCents: true,
        taxCents: true,
        totalCents: true,
        expiresAt: true,
        createdAt: true,
        // Explicit projection, not `include`. studentName/email/phone/homeroom
        // are absent on purpose and a column added later cannot leak by default.
        // Not capacity, not a booked count. Those never leave the server
        // (same rule as GET /api/slots).
        pickupLabel: true,
        pickupStartTime: true,
        pickupLocation: true,
        pickupServiceDate: true,
        items: {
          select: {
            productId: true,
            qty: true,
            nameSnapshot: true,
            unitPriceCents: true,
            raritySnapshot: true,
            allergensSnapshot: true,
          },
          orderBy: { nameSnapshot: "asc" },
        },
      },
    });

    // The order id came out of a signature we produced, so a miss here means the
    // row was deleted. Treated the same as everything else.
    if (!order) notFound("order_row_missing");

    // THE CROSS-ORDER CHECK. A signed cookie for order A must not read order B
    // just because the address bar changed. The cookie's id is resolved first
    // and the row it points at must be the one named in the URL.
    if (order.orderNumber !== orderNumber) notFound("order_mismatch");

    const showCode = CODE_VISIBLE_STATUSES.has(order.status);

    return Response.json(
      {
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod: order.paymentMethod,
        subtotalCents: order.subtotalCents,
        taxCents: order.taxCents,
        totalCents: order.totalCents,
        // Present only when the order is actually claimable. The field is
        // omitted, not null, so a UI that renders truthiness cannot show an
        // empty locker code box.
        ...(showCode ? { pickupCode: order.pickupCode } : {}),
        // Only ever non-null for a PENDING card order: when the hold on the
        // stock and the seat runs out. Poll until then, not forever.
        expiresAt: order.expiresAt,
        placedAt: order.createdAt,
        slot: {
          label: order.pickupLabel,
          startTime: order.pickupStartTime,
          location: order.pickupLocation,
          serviceDate: order.pickupServiceDate,
        },
        // Snapshots, never the live product (CLAUDE.md §2.5). `allergensSnapshot`
        // is returned in full and must be rendered in full — this is the
        // confirmation surface CLAUDE.md §2.8 is written about.
        items: order.items,
      },
      // Never cached, and not only for freshness: this is a per-student receipt
      // behind a cookie, and a shared cache that keyed on the URL alone would
      // hand one student's pickup code to the next.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

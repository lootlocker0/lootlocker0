import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { requireAccountUser } from "@/lib/account-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A signed-in account's own order history — the only route in this codebase
// that lists more than one order for one identity. Hard auth requirement
// (401 ACCOUNT_UNAUTHORIZED if not signed in), unlike checkout's optional
// account read: this endpoint's entire purpose requires being logged in.
//
// Only orders placed WHILE signed in appear here. There is no retroactive
// linking by matching email to pre-existing guest orders — signup has no
// email verification step, so linking by email match would let anyone see a
// stranger's order history just by signing up with a known email
// (docs/API-CONTRACT.md §6c).
//
// Explicit projection, same shape GET /api/orders/[orderNumber] already
// returns (plus paymentMethod, useful in a list where a single order's
// confirmation page leaves it implicit) — never studentName/email/phone/
// homeroom. The account system is single-user with no household/multi-child
// concept anywhere in the schema, so there is no case for redisplaying a
// student's name here; that's a call to revisit only if a real multi-child
// account model is ever built.
//
// No pagination in v1 — same known limitation as GET /api/orders/[orderNumber]
// never having one. Not rate limited: a session-cookie-gated read of your own
// data, same class as GET /api/account/me.

export async function GET(req: NextRequest) {
  try {
    const user = await requireAccountUser(req);

    const orders = await db.order.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        orderNumber: true,
        status: true,
        paymentMethod: true,
        pickupCode: true,
        subtotalCents: true,
        taxCents: true,
        totalCents: true,
        paidAt: true,
        createdAt: true,
        slot: {
          select: {
            label: true,
            startTime: true,
            location: true,
            serviceDate: true,
          },
        },
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

    return NextResponse.json(
      { orders },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

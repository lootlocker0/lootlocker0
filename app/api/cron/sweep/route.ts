import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { cancelOrderPaymentIntent } from "@/lib/stripe/payments";
import { releaseOrder } from "@/lib/db/release";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gives back what abandoned card orders are holding. Without this, every
// student who opens the payment form and closes the tab permanently removes a
// snack from the shelf and a seat from a pickup window.
//
// Called every 5 minutes by .github/workflows/sweep-cron.yml, not Vercel's own
// Cron Jobs — the Hobby plan caps native cron at once/day, and this app has no
// Pro subscription. The TTL is `pending_order_ttl_minutes` (default 15), so
// worst-case an abandoned cart holds stock for TTL + 5 minutes.

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means no way to authenticate, so nobody is authorised.
  // Never fall through to "allow" — this route releases stock and cancels
  // payment intents.
  if (!secret) return false;

  const provided = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Constant-time, and length-checked first because timingSafeEqual throws on a
  // length mismatch. A plain `!==` leaks the secret one byte at a time to
  // anything that can measure the response.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return new Response("unauthorized", { status: 401 });
  }

  const stale = await db.order.findMany({
    where: {
      status: "PENDING",
      paymentMethod: "CARD",
      expiresAt: { lt: new Date() },
    },
    select: { id: true, stripePaymentIntentId: true },
    // Bounded so one run cannot hold a connection for minutes. Whatever is left
    // over is picked up five minutes later.
    take: 100,
    orderBy: { expiresAt: "asc" },
  });

  let released = 0;
  let failed = 0;

  for (const o of stale) {
    try {
      // Cancel at Stripe FIRST. If the student's payment lands a millisecond
      // later, the succeeded webhook finds an order that is no longer PENDING
      // and no-ops — so the ordering here is what prevents releasing the stock
      // out from under a payment that actually completed. cancel() is
      // best-effort and swallows "already succeeded" / "already cancelled".
      if (o.stripePaymentIntentId) {
        await cancelOrderPaymentIntent(o.stripePaymentIntentId);
      }
      const r = await releaseOrder(o.id, "EXPIRED");
      if (r.released) released++;
    } catch (e) {
      // One bad order must not abort the sweep and strand the other 99 holding
      // stock. Count it and keep going; the next run retries it.
      failed++;
      logEvent("sweep_order_failed", { orderId: o.id });
      console.error("[sweep]", o.id, e);
    }
  }

  logEvent("sweep_complete", { scanned: stale.length, released, failed });
  return Response.json(
    { scanned: stale.length, released, failed },
    { headers: { "Cache-Control": "no-store" } },
  );
}

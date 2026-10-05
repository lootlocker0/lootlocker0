import { describe, it, expect, beforeAll } from "vitest";
import Stripe from "stripe";
import { STAGING_SITE_URL, STAGING_STRIPE_WEBHOOK_SECRET, STAGING_ADMIN_PASSCODE } from "./staging-env";

/**
 * Payment-processing smoke test — STAGING ONLY. See staging-env.ts for why
 * this is a separate suite from tests/smoke/production.test.ts and why it
 * refuses to run without STAGING_SITE_URL explicitly set.
 *
 * Unlike the production smoke suite, this one DOES write: it places a real
 * cash order and a real card order through a real checkout request, forges
 * a signed Stripe webhook exactly like tests/e2e/helpers.ts does, and
 * refunds the card order through the real admin API. That is only
 * acceptable against a database that is disposable BY DESIGN — this must
 * never point at a deployment backed by the real production database.
 *
 * ── The belt-and-suspenders guard ───────────────────────────────────────
 * Every simulated PaymentIntent id looks like `pi_sim_<24 hex>`
 * (lib/stripe/payments.ts) — the explicit, unmistakable marker that
 * `lib/stripe/payments.ts`'s simulator produced it rather than a real
 * Stripe call. The very first assertion after creating a card order checks
 * this id shape and FAILS LOUDLY, before any webhook or refund happens, if
 * it doesn't match — which is exactly what happens if this ever runs
 * against a deployment using a real (non-"placeholder") `STRIPE_SECRET_KEY`.
 * That is the one thing standing between "test run" and "a real charge
 * against a real card," so do not relax or remove it.
 */

const stripeSdk = new Stripe("sk_test_placeholder");

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${STAGING_SITE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${STAGING_SITE_URL}${path}`, { headers });
}

function uniq() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let productId: string;
let slotId: string;

beforeAll(async () => {
  const [productsRes, slotsRes] = await Promise.all([
    get("/api/products"),
    get("/api/slots"),
  ]);
  const products = (await productsRes.json()) as { products: { id: string }[] };
  const slots = (await slotsRes.json()) as { slots: { id: string; full: boolean }[] };

  const product = products.products[0];
  const slot = slots.slots.find((s) => !s.full);
  if (!product || !slot) {
    throw new Error(
      "Staging catalog has no sellable product or open pickup slot — seed " +
        "the staging database before running this suite.",
    );
  }
  productId = product.id;
  slotId = slot.id;
});

describe("staging payment smoke — cash order", () => {
  it("a cash order reserves immediately and never touches Stripe", async () => {
    const res = await post("/api/checkout", {
      studentName: `Staging Smoke ${uniq()}`,
      email: `staging-smoke-${uniq()}@example.invalid`,
      phone: "604-555-0100",
      slotId,
      paymentMethod: "CASH_AT_PICKUP",
      items: [{ productId, qty: 1 }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; stripePaymentIntentId: unknown };
    expect(body.status).toBe("RESERVED");
    expect(body.stripePaymentIntentId).toBeFalsy();
  });
});

describe("staging payment smoke — card order, simulated webhook, refund", () => {
  it("runs the full card payment lifecycle", async () => {
    // 1. Checkout.
    const checkoutRes = await post("/api/checkout", {
      studentName: `Staging Smoke ${uniq()}`,
      email: `staging-smoke-${uniq()}@example.invalid`,
      phone: "604-555-0100",
      slotId,
      paymentMethod: "CARD",
      items: [{ productId, qty: 1 }],
    });
    expect(checkoutRes.status).toBe(200);
    const order = (await checkoutRes.json()) as {
      orderNumber: string;
      status: string;
      totalCents: number;
      stripePaymentIntentId: string;
      clientSecret: string;
    };
    expect(order.status).toBe("PENDING");

    // THE SAFETY GUARD — see the module comment. Do not remove.
    expect(
      order.stripePaymentIntentId,
      "stripePaymentIntentId is not a simulated id (pi_sim_...) — this " +
        "deployment may be using a REAL Stripe key. Refusing to forge a " +
        "webhook or touch this order any further.",
    ).toMatch(/^pi_sim_[0-9a-f]{24}$/);

    // 2. Forge the success webhook, exactly as tests/e2e/helpers.ts does.
    const event = {
      id: `evt_staging_${uniq()}`,
      object: "event",
      api_version: "2026-08-26.dahlia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: order.stripePaymentIntentId,
          object: "payment_intent",
          amount: order.totalCents,
          amount_received: order.totalCents,
          currency: "cad",
          status: "succeeded",
        },
      },
    };
    const payload = JSON.stringify(event);
    const webhookRes = await fetch(`${STAGING_SITE_URL}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSdk.webhooks.generateTestHeaderString({
          payload,
          secret: STAGING_STRIPE_WEBHOOK_SECRET,
        }),
      },
      body: payload,
    });
    expect(webhookRes.status).toBe(200);

    // 3. Confirm it actually paid, through the public receipt route — not a
    // database read, so this also proves the webhook's effect is visible
    // over the same HTTP surface a student's browser would poll.
    const receiptCookie = (checkoutRes.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith(`ll_ord_${order.orderNumber}=`));
    expect(receiptCookie, "no receipt cookie on the checkout response").toBeDefined();

    const receiptRes = await get(`/api/orders/${order.orderNumber}`, {
      cookie: receiptCookie!,
    });
    expect(receiptRes.status).toBe(200);
    const receipt = (await receiptRes.json()) as { status: string; pickupCode: string };
    expect(receipt.status).toBe("PAID");
    expect(receipt.pickupCode).toBeTruthy();

    // 4. Refund it through the real admin API, so staging doesn't accumulate
    // a growing pile of paid orders every run.
    const loginRes = await post("/api/admin/login", { passcode: STAGING_ADMIN_PASSCODE });
    expect(loginRes.status).toBe(200);
    const adminCookie = (loginRes.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ll_admin="));
    expect(adminCookie, "no staff session cookie from admin login").toBeDefined();

    const refundRes = await post(
      `/api/admin/orders/${order.orderNumber}/refund`,
      { releaseSlotSeat: true },
      { cookie: adminCookie! },
    );
    expect(refundRes.status).toBe(200);
    const refund = (await refundRes.json()) as { status: string };
    expect(refund.status).toBe("REFUNDED");
  });
});

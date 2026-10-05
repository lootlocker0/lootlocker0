import { test, expect, type Page } from "@playwright/test";
import Stripe from "stripe";
import { stripeRealDb, seedProduct, seedSlot } from "./db";
import { STRIPE_TEST_SECRET_KEY } from "./env";

/**
 * Real Stripe TEST MODE checkout. No simulator anywhere in this file —
 * `tests/stripe-real/env.ts` already refused to start the server without a
 * real `sk_test_`/`pk_test_` pair, so by the time this runs, `PaymentStep.tsx`
 * mounts a genuine Stripe `PaymentElement` against a genuine Stripe
 * clientSecret. This is the one thing the ordinary e2e suite structurally
 * cannot do (docs/HANDOFF.md §20) — it needs a real Stripe account and real
 * internet egress to Stripe's API, neither of which exist in the sandbox
 * that suite runs in.
 *
 * Card numbers are Stripe's own published test numbers — see
 * https://docs.stripe.com/testing. They only work against a test-mode key;
 * there is no path from this file to a real charge.
 */

const stripe = new Stripe(STRIPE_TEST_SECRET_KEY, { apiVersion: "2026-08-26.dahlia" });

async function fillSquadInfo(page: Page, email: string) {
  await page.getByLabel("Full name").fill("Stripe Real Test Student");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Phone").fill("604-555-0100");
}

async function startCardCheckout(page: Page, productId: string, slotId: string, email: string) {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["ll-cart", JSON.stringify({ state: { lines: [{ productId, qty: 1 }] }, version: 2 })],
  );
  await page.goto("/checkout");
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
  });
  await fillSquadInfo(page, email);
  await page.getByRole("radio", { name: new RegExp(`^\\d{2}:\\d{2}`) }).check({ force: true });
  await page.getByRole("radio", { name: /^card/i }).check({ force: true });
  await page.getByRole("button", { name: /continue to payment/i }).click();
  await page.getByRole("heading", { name: /pay by card/i }).waitFor({ timeout: 20_000 });
  const shown = await page.getByText(/LL-\d{5}/).first().innerText();
  return shown.match(/LL-\d{5}/)![0];
}

/**
 * Fills Stripe's unified Payment Element. Field set (postal code, country)
 * depends on the connected Stripe account's configured billing-details
 * collection, which this suite cannot know ahead of a real run — each
 * optional field is filled only if present, so a account configured
 * differently from what was assumed here doesn't hard-fail the whole spec
 * over a field that was never going to appear.
 */
async function fillCard(page: Page, number: string) {
  const frame = page.frameLocator("iframe[name^='__privateStripeFrame']").first();
  await frame.locator('[placeholder="Card number"]').fill(number);
  await frame.locator('[placeholder="MM / YY"]').fill("12/34");
  await frame.locator('[placeholder="CVC"]').fill("123");
  const postal = frame.locator('[placeholder="ZIP"], [placeholder="Postal code"]');
  if (await postal.count()) await postal.first().fill("V6B 1A1");
}

test.describe("real Stripe test-mode checkout", () => {
  test("4242 4242 4242 4242 — succeeds without authentication, order reaches PAID", async ({ page }) => {
    const product = await seedProduct();
    const slot = await seedSlot();
    const orderNumber = await startCardCheckout(page, product.id, slot.id, `stripe-ok-${Date.now()}@school.ca`);

    await fillCard(page, "4242424242424242");
    await page.getByRole("button", { name: /^pay/i }).click();

    // Real Stripe round trip + a real webhook delivered by `stripe listen`
    // (see the workflow) — this is the part that cannot be faked, so give
    // it real time rather than the local simulator's near-instant cutover.
    await expect
      .poll(
        async () => (await stripeRealDb.order.findUnique({ where: { orderNumber } }))?.status,
        { timeout: 30_000, message: "order never reached PAID via the real webhook" },
      )
      .toBe("PAID");

    await page.goto(`/order/${orderNumber}`);
    await expect(page.getByText(/pickup code/i)).toBeVisible();

    const order = await stripeRealDb.order.findUniqueOrThrow({ where: { orderNumber } });
    expect(order.stripePaymentIntentId).toMatch(/^pi_[A-Za-z0-9]+$/); // a REAL intent id, never pi_sim_
    const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId!);
    expect(intent.status).toBe("succeeded");
  });

  test("4000 0025 0000 3155 — requires 3D Secure, then succeeds", async ({ page }) => {
    const product = await seedProduct();
    const slot = await seedSlot();
    const orderNumber = await startCardCheckout(page, product.id, slot.id, `stripe-3ds-${Date.now()}@school.ca`);

    await fillCard(page, "4000002500003155");
    await page.getByRole("button", { name: /^pay/i }).click();

    // Stripe's test-mode 3DS challenge. UNVERIFIED against a live run — this
    // suite has never executed against a real account (the sandbox that
    // built it has no path to api.stripe.com). If Stripe's challenge markup
    // doesn't match this selector, this is the one place to look first;
    // widen it or swap to Stripe's documented 3DS test helper if so.
    const challengeFrame = page.frameLocator('iframe[name*="stripe-3ds2"], iframe[src*="hooks.stripe.com"]');
    await challengeFrame.getByRole("button", { name: /complete|authorize|succeed/i }).click({ timeout: 15_000 });

    await expect
      .poll(
        async () => (await stripeRealDb.order.findUnique({ where: { orderNumber } }))?.status,
        { timeout: 30_000, message: "order never reached PAID after 3DS" },
      )
      .toBe("PAID");
  });

  test("4000 0000 0000 9995 — declines, order stays PENDING and holds its stock", async ({ page }) => {
    const product = await seedProduct();
    const slot = await seedSlot();
    const orderNumber = await startCardCheckout(page, product.id, slot.id, `stripe-decline-${Date.now()}@school.ca`);

    const before = await stripeRealDb.product.findUniqueOrThrow({ where: { id: product.id } });

    await fillCard(page, "4000000000009995");
    await page.getByRole("button", { name: /^pay/i }).click();

    await expect(page.getByRole("alert")).toContainText(/declined|insufficient/i, { timeout: 20_000 });

    const order = await stripeRealDb.order.findUniqueOrThrow({ where: { orderNumber } });
    expect(order.status).toBe("PENDING"); // never PAID — no webhook fires for a decline
    const after = await stripeRealDb.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQty).toBe(before.stockQty); // the PENDING reservation is unaffected by the decline
  });
});

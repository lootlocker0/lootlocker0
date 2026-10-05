import { test, expect, type Page } from "@playwright/test";
import { e2eDb, fillWindow, seedSlot } from "./setup/db";
import { CATALOG } from "./setup/global-setup";
import { primeCart, waitForHydration } from "./helpers";

/**
 * `/checkout`, both payment methods.
 *
 * The cart is primed through localStorage rather than by re-walking the
 * catalog — `catalog.spec.ts` owns that path, and re-doing it here would mean a
 * failure in the catalog page reported itself as a checkout failure.
 */

async function productBySlug(slug: string) {
  return e2eDb.product.findUniqueOrThrow({ where: { slug } });
}

/**
 * The pickup radios are `sr-only` inputs inside their labels, so a radio's
 * accessible name is the label text — "12:20 · Lunch A", or "… — Full" for a
 * window with no seats left. Picking "the first one that is not full" is what a
 * student does; a spec that picks index 0 blindly goes red the moment an
 * earlier window fills up, for reasons that are not a bug.
 */
async function chooseFirstOpenSlot(page: Page) {
  const radios = page.getByRole("radio", { name: /^\d{2}:\d{2}/ });
  const n = await radios.count();
  expect(n, "no pickup windows offered — the fixture slots are past the cutoff").toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const r = radios.nth(i);
    if (await r.isDisabled()) continue;
    // `force` because the input is `sr-only`: its own 1×1 box sits under the
    // label that wraps it, so Playwright's actionability check correctly
    // reports "label intercepts pointer events". A real user clicks the label
    // (works) or tabs to the input and presses arrow keys (also works) —
    // `keyboard.spec.ts` exercises that second path deliberately.
    await r.check({ force: true });
    return;
  }
  throw new Error("every pickup window rendered as full");
}

async function fillSquadInfo(page: Page, email: string) {
  await page.getByLabel("Full name").fill("Playwright Student");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Phone").fill("604-555-0100");
}

test.describe("checkout", () => {
  test("cash order confirms immediately and never touches Stripe", async ({ page }) => {
    const staple = await productBySlug(CATALOG.staple.slug);
    await primeCart(page, [{ productId: staple.id, qty: 2 }]);

    await page.goto("/checkout");
    await waitForHydration(page, "form");

    const email = `cash-${Date.now()}@school.ca`;
    await fillSquadInfo(page, email);

    await chooseFirstOpenSlot(page);
    await page.getByRole("radio", { name: /cash at pickup/i }).check({ force: true });

    await page.getByRole("button", { name: /confirm pickup order/i }).click();

    await expect(page).toHaveURL(/\/order\/LL-\d{5}$/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /order secured/i })).toBeVisible();
    await expect(page.getByText(/bring cash to pay when you collect/i)).toBeVisible();

    // Pickup code is present for a RESERVED order (API-CONTRACT §6).
    await expect(page.getByText(/pickup code — read this to staff/i)).toBeVisible();

    // No Stripe iframe anywhere on the cash path.
    await expect(page.locator("iframe[title*='payment' i]")).toHaveCount(0);
    await expect(page.locator("iframe[name^='__privateStripe']")).toHaveCount(0);

    const orderNumber = new URL(page.url()).pathname.split("/").pop()!;
    const order = await e2eDb.order.findUniqueOrThrow({
      where: { orderNumber },
      include: { items: true },
    });
    expect(order.status).toBe("RESERVED");
    expect(order.paymentMethod).toBe("CASH_AT_PICKUP");
    // Server-side repricing: 2 × 250, never a client-supplied number.
    expect(order.totalCents).toBe(500);
    expect(order.stripePaymentIntentId).toBeNull();
    // Snapshots, not live reads (CLAUDE.md §2.5).
    expect(order.items[0].unitPriceCents).toBe(staple.priceCents);
    expect([...order.items[0].allergensSnapshot].sort()).toEqual(["DAIRY", "GLUTEN"]);
  });

  test("card order reaches the payment step with the order already held", async ({ page }) => {
    const staple = await productBySlug(CATALOG.staple.slug);
    await primeCart(page, [{ productId: staple.id, qty: 1 }]);

    await page.goto("/checkout");
    await waitForHydration(page, "form");

    await fillSquadInfo(page, `card-${Date.now()}@school.ca`);
    await chooseFirstOpenSlot(page);
    await page.getByRole("radio", { name: /^card/i }).check({ force: true });

    await page.getByRole("button", { name: /continue to payment/i }).click();

    // The order exists and holds its stock and seat BEFORE any card detail is
    // entered — that is the contract (API-CONTRACT §6), and it is what makes a
    // decline releasable rather than a lost sale.
    await expect(page.getByRole("heading", { name: /pay by card/i })).toBeVisible({
      timeout: 20_000,
    });
    const shown = await page.getByText(/LL-\d{5}/).first().innerText();
    const orderNumber = shown.match(/LL-\d{5}/)![0];

    const order = await e2eDb.order.findUniqueOrThrow({ where: { orderNumber } });
    expect(order.status).toBe("PENDING");
    expect(order.paymentMethod).toBe("CARD");
    expect(order.totalCents).toBe(staple.priceCents);
    expect(order.expiresAt).not.toBeNull();
    // HANDOFF §20: no Stripe account exists here, so the intent is simulated
    // and unmistakably marked as such.
    expect(order.stripePaymentIntentId).toMatch(/^pi_sim_[0-9a-f]{24}$/);

    // The cart is cleared the instant the order is placed, so a back-navigation
    // cannot re-submit the same loadout against the seat it already holds.
    expect(await page.evaluate(() => localStorage.getItem("ll-cart"))).toContain(
      '"lines":[]',
    );

    /*
     * WHAT THIS SPEC CANNOT DO, stated rather than faked.
     *
     * `pi_sim_…` is not a Stripe client secret, so Stripe.js refuses to mount
     * Elements against it and never reaches Stripe's network (which is blocked
     * in this sandbox anyway). Entering `4242…`, submitting, and asserting a
     * charge is therefore impossible here and always has been (HANDOFF §20) —
     * that is the one item left on P5's manual list: "one real transaction
     * placed and refunded".
     *
     * What IS proven: the order is created and held before payment, the
     * simulated intent is deterministic, and the page degrades to a usable
     * state (below) rather than a spinner, which is the part a student
     * actually experiences when the card form cannot load.
     */
    const stripeFailedGracefully = page.getByRole("alert").filter({
      hasText: /card payment form couldn.t load|card payment isn.t available/i,
    });
    const elementsMounted = page.locator("iframe[name^='__privateStripe']");
    await expect
      .poll(
        async () => (await stripeFailedGracefully.count()) + (await elementsMounted.count()),
        {
          timeout: 20_000,
          message:
            "the card step neither mounted Stripe Elements nor showed the documented fallback — " +
            "a student would be looking at an empty panel with a held order and no way to pay",
        },
      )
      .toBeGreaterThan(0);
  });

  test("client-side validation blocks a submit with no pickup window", async ({ page }) => {
    const staple = await productBySlug(CATALOG.staple.slug);
    await primeCart(page, [{ productId: staple.id, qty: 1 }]);

    await page.goto("/checkout");
    await waitForHydration(page, "form");

    const before = await e2eDb.order.count();
    await page.getByRole("button", { name: /confirm pickup order/i }).click();

    await expect(page.getByRole("alert").first()).toContainText(/check the highlighted fields/i);
    await expect(page.getByText("Choose a pickup window.")).toBeVisible();
    expect(await e2eDb.order.count()).toBe(before);
  });

  test("an empty cart cannot reach a payable checkout", async ({ page }) => {
    await page.goto("/checkout");
    await expect(page.getByText(/your loadout is empty/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /confirm pickup order/i })).toHaveCount(0);
  });

  test("a full pickup window renders disabled with a reason, not hidden", async ({ page }) => {
    // A window on the school's own calendar day so `GET /api/slots` returns it,
    // seeded already full. A disappearing option reads as a bug; "— Full" reads
    // as sold out, which is the truth.
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 1, label: "Full Window" });
    await fillWindow(slot, 1);

    const staple = await productBySlug(CATALOG.staple.slug);
    await primeCart(page, [{ productId: staple.id, qty: 1 }]);
    await page.goto("/checkout");
    await waitForHydration(page, "form");

    const fullOption = page.getByRole("radio", { name: new RegExp(`${slot.startTime}.*Full Window`) });
    await expect(fullOption).toHaveCount(1);
    await expect(fullOption).toBeDisabled();
    await expect(fullOption).toHaveAccessibleName(/Full$/);
  });
});

test.describe("checkout — money integrity through the UI", () => {
  test("the price the server charges wins over anything the page computed", async ({ page }) => {
    const p = await e2eDb.product.create({
      data: {
        slug: `e2e-repriced-${Date.now()}`,
        name: `Repriced Item ${Date.now()}`,
        description: "Price changes between render and submit.",
        priceCents: 500,
        category: "sweet",
        rarity: "RARE",
        allergens: [],
        stockQty: 10,
        active: true,
        imageUrl: "/products/none.svg",
        sortOrder: 1,
      },
    });

    await primeCart(page, [{ productId: p.id, qty: 1 }]);
    await page.goto("/checkout");
    await waitForHydration(page, "form");
    await expect(page.getByText("$5.00").first()).toBeVisible();

    // Staff repriced it while the student was filling the form in.
    await e2eDb.product.update({ where: { id: p.id }, data: { priceCents: 900 } });

    await fillSquadInfo(page, `reprice-${Date.now()}@school.ca`);
    await chooseFirstOpenSlot(page);
    await page.getByRole("button", { name: /confirm pickup order/i }).click();
    await expect(page).toHaveURL(/\/order\/LL-\d{5}$/, { timeout: 20_000 });

    const orderNumber = new URL(page.url()).pathname.split("/").pop()!;
    const order = await e2eDb.order.findUniqueOrThrow({
      where: { orderNumber },
      include: { items: true },
    });

    // The page said $5.00; the database says $9.00. CLAUDE.md §2.2.
    expect(order.totalCents).toBe(900);
    expect(order.items[0].unitPriceCents).toBe(900);
    // And the receipt shows what was actually charged, not the stale estimate.
    await expect(page.getByText("$9.00").first()).toBeVisible();
    await expect(page.getByText("$5.00")).toHaveCount(0);
  });
});

import { test, expect, type Page } from "@playwright/test";
import { countBookedOrders, e2eDb, seedProduct, seedSlot } from "./setup/db";
import { ADMIN_PASSCODE, INVENTORY_PASSCODE } from "./setup/env";
import {
  paymentIntentSucceeded,
  placeOrder,
  postWebhook,
  signInAsStaff,
  waitForHydration,
} from "./helpers";

/**
 * `/admin` — a full lunch service, driven from the screen (the P4 gate).
 *
 * Every fixture order is placed through the real `POST /api/checkout`, never
 * inserted: a hand-built row cannot reproduce the stock and seat holds the
 * release path is supposed to give back, and the `order_total_consistent` /
 * `booked_within_capacity` check constraints reject sloppy inserts anyway.
 */

async function openPickList(page: Page) {
  await signInAsStaff(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /pick list/i })).toBeVisible({
    timeout: 20_000,
  });
  await waitForHydration(page, "button");
}

/** The order card for one order number, inside the pick list. */
const orderCard = (page: Page, orderNumber: string) =>
  page.locator("article").filter({ hasText: orderNumber });

/**
 * Raw DOM text of the whole page, for leak assertions about SPECIFIC strings.
 *
 * `innerText()` is the wrong tool for those and quietly weakens the test: it
 * returns text as RENDERED, so `text-transform: uppercase` (which the pick list
 * uses on student names) turns "Devon Okonkwo" into "DEVON OKONKWO", and a
 * `not.toContain("someone@school.ca")` assertion would pass against a page that
 * is displaying exactly that string inside an uppercased element.
 * `textContent()` returns what is in the DOM — including the RSC flight payload
 * Next inlines in `<script>` tags, which is exactly where a server-rendered PII
 * leak would hide.
 */
const pageText = (page: Page) => page.locator("body").textContent();

/**
 * Visible text only. Used for the broad "no @ anywhere" sweep, which cannot run
 * against `pageText`: Next's inlined flight payload legitimately contains `@`
 * in module specifiers like `@swc/helpers`, so that assertion would fail on
 * every page regardless of whether any student data is present.
 */
const visibleText = (page: Page) => page.locator("body").innerText();

/**
 * One product's row in the stock adjuster. Scoped to `#stock-adjustment`
 * deliberately: the same product name also appears as an order line `li` inside
 * the pick list above, and an unscoped `li` filter matches both.
 */
const stockRow = (page: Page, productName: string) =>
  page.locator("#stock-adjustment li").filter({ hasText: productName });

test.describe("staff admin — sign in", () => {
  test("signed out shows the staff sign-in form and no order data", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: /staff sign-in/i })).toBeVisible();
    await expect(page.getByLabel("Passcode")).toBeVisible();
    await expect(page.getByRole("heading", { name: /pick list/i })).toHaveCount(0);
    // No student data may render behind an unauthenticated shell.
    expect(await visibleText(page)).not.toContain("@");
  });

  test("a wrong passcode is a retryable error, not a lockout screen", async ({ page }) => {
    await page.goto("/admin");
    await waitForHydration(page, "form");
    await page.getByLabel("Passcode").fill("definitely-not-it");
    await page.getByRole("button", { name: /sign in/i }).click();

    // `.first()` because Next injects its own always-present, always-empty
    // `role="alert"` route announcer (`#__next-route-announcer__`) into every
    // page; an unscoped `getByRole("alert")` is a strict-mode violation that
    // reads as "the error never rendered".
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByLabel("Passcode")).toHaveValue("");
    await expect(page.getByRole("heading", { name: /staff sign-in/i })).toBeVisible();
  });

  test("the inventory passcode does not open the staff screen", async ({ page }) => {
    // API-CONTRACT §6b: structurally independent auth. If a refactor ever
    // merges the two credentials, this is what notices.
    expect(INVENTORY_PASSCODE).not.toBe(ADMIN_PASSCODE);
    await page.goto("/admin");
    await waitForHydration(page, "form");
    await page.getByLabel("Passcode").fill(INVENTORY_PASSCODE);
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /pick list/i })).toHaveCount(0);
  });

  test("the correct passcode opens today's pick list", async ({ page }) => {
    await page.goto("/admin");
    await waitForHydration(page, "form");
    await page.getByLabel("Passcode").fill(ADMIN_PASSCODE);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("heading", { name: /pick list/i })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("sign out drops straight back to the sign-in form", async ({ page }) => {
    await openPickList(page);
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page.getByRole("heading", { name: /staff sign-in/i })).toBeVisible();

    // And a reload does not resurrect the dashboard from a stale cookie hint.
    await page.reload();
    await expect(page.getByRole("heading", { name: /staff sign-in/i })).toBeVisible();
  });
});

test.describe("staff admin — a cash lunch service, end to end", () => {
  test("pack, refuse handover until cash is recorded, record cash, hand over", async ({
    page,
  }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Cash Service" });
    const product = await seedProduct({ priceCents: 175, stockQty: 20 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 1 }],
      paymentMethod: "CASH_AT_PICKUP",
      studentName: "Cash Student",
    });
    expect(order.status).toBe("RESERVED");

    await openPickList(page);
    const card = orderCard(page, order.orderNumber);
    await expect(card).toBeVisible();
    // The row states what is still owed, in words, next to the total.
    await expect(card).toContainText(/Cash due \$1\.75/);
    await expect(card).toContainText(/NOT paid/);

    // ── pack ──
    await card.getByRole("button", { name: /mark packed/i }).click();
    await expect(orderCard(page, order.orderNumber)).toContainText(/packed/i);
    expect((await e2eDb.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PACKED",
    );

    // ── handover refused while the cash is unpaid ──
    const packed = orderCard(page, order.orderNumber);
    await packed.getByRole("button", { name: /mark picked up/i }).click();
    await packed.getByLabel(/pickup code/i).fill(order.pickupCode);
    await packed.getByRole("button", { name: /confirm pickup/i }).click();
    await expect(packed.getByRole("alert")).toContainText(/cash hasn.t been recorded/i);
    expect((await e2eDb.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PACKED",
    );

    // ── record cash ──
    await orderCard(page, order.orderNumber)
      .getByRole("button", { name: /record cash/i })
      .click();
    await expect
      .poll(async () =>
        (await e2eDb.order.findUniqueOrThrow({ where: { id: order.id } })).paidAt !== null,
      )
      .toBe(true);

    // ── handover, with the code re-typed ──
    // `Mark picked up` TOGGLES the confirm form, and the refused attempt above
    // left it open — clicking again would close it. Open it only if it is shut.
    const paid = orderCard(page, order.orderNumber);
    const codeField = paid.getByLabel(/pickup code/i);
    if ((await codeField.count()) === 0) {
      await paid.getByRole("button", { name: /mark picked up/i }).click();
    }
    await codeField.fill(order.pickupCode);
    await paid.getByRole("button", { name: /confirm pickup/i }).click();

    await expect
      .poll(async () =>
        (await e2eDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
      )
      .toBe("PICKED_UP");
  });

  test("a wrong pickup code refuses the handover and says why", async ({ page }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Code Check" });
    const product = await seedProduct({ priceCents: 175, stockQty: 20 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 1 }],
      paymentMethod: "CASH_AT_PICKUP",
    });
    await e2eDb.order.update({ where: { id: order.id }, data: { paidAt: new Date() } });

    await openPickList(page);
    const card = orderCard(page, order.orderNumber);
    await card.getByRole("button", { name: /mark picked up/i }).click();
    await card.getByLabel(/pickup code/i).fill("ZZZZ");
    await card.getByRole("button", { name: /confirm pickup/i }).click();

    await expect(card.getByRole("alert")).toContainText(/doesn.t match this order/i);
    expect((await e2eDb.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "RESERVED",
    );
  });

  test("the pickup code field is never pre-filled — that keystroke is the identity check", async ({
    page,
  }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "No Prefill" });
    const product = await seedProduct({ priceCents: 175, stockQty: 20 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 1 }],
      paymentMethod: "CASH_AT_PICKUP",
    });

    await openPickList(page);
    const card = orderCard(page, order.orderNumber);
    await card.getByRole("button", { name: /mark picked up/i }).click();
    await expect(card.getByLabel(/pickup code/i)).toHaveValue("");
  });
});

test.describe("staff admin — card refund", () => {
  test("refunds the full total, releases nothing by default, and never restocks", async ({
    page,
  }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Refund Service" });
    const product = await seedProduct({ priceCents: 600, stockQty: 20 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 2 }],
      paymentMethod: "CARD",
    });
    const r = await postWebhook(paymentIntentSucceeded(order.stripePaymentIntentId!, 1200));
    expect(r.status).toBe(200);

    const stockBefore = (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } }))
      .stockQty;
    const seatBefore = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);

    await openPickList(page);
    const card = orderCard(page, order.orderNumber);
    await card.getByRole("button", { name: /^refund$/i }).click();

    // The confirmation must state the exact amount, from the order, not a
    // number the operator typed.
    await expect(card).toContainText("$12.00");
    await card.getByRole("button", { name: /confirm refund/i }).click();

    await expect
      .poll(async () =>
        (await e2eDb.order.findUniqueOrThrow({ where: { id: order.id } })).status,
      )
      .toBe("REFUNDED");

    // Stock is NOT auto-returned — the snack may already be packed or eaten.
    // The screen offers it as an explicit staff decision instead.
    const stockAfter = (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } }))
      .stockQty;
    expect(stockAfter).toBe(stockBefore);
    await expect(
      page.getByText(/refunded — stock was not returned automatically/i),
    ).toBeVisible();
    await expect(
      page.getByText(/only press these if the item is physically back on the shelf/i),
    ).toBeVisible();

    // The seat was not released, because the box was not ticked.
    const seatAfter = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(seatAfter).toBe(seatBefore);

    // ── the explicit restock prompt does what it says, once ──
    await page
      .getByRole("button", { name: /it.s back on the shelf — apply/i })
      .first()
      .click();
    await expect
      .poll(
        async () =>
          (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
      )
      .toBe(stockBefore + 2);
  });

  test("refund is not offered on an order that was never paid", async ({ page }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Unpaid" });
    const product = await seedProduct({ priceCents: 250, stockQty: 20 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 1 }],
      paymentMethod: "CASH_AT_PICKUP",
    });

    await openPickList(page);
    const card = orderCard(page, order.orderNumber);
    await expect(card.getByRole("button", { name: /^refund$/i })).toBeDisabled();
  });
});

test.describe("staff admin — stock adjustment", () => {
  test("applies a signed relative delta and shows the authoritative result", async ({ page }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Stock Service" });
    const product = await seedProduct({
      priceCents: 250,
      stockQty: 20,
      name: `Adjustable ${Date.now()}`,
    });
    await placeOrder({ slotId: slot.id, items: [{ productId: product.id, qty: 1 }] });

    await openPickList(page);

    // Scoped to the stock-adjustment section: the same product name also
    // appears as an order line inside the pick list above.
    const row = stockRow(page, product.name);
    await expect(row).toBeVisible();
    await row.getByRole("textbox").fill("+7");
    await row.getByRole("button", { name: /apply/i }).click();

    // 20 seeded − 1 reserved by the checkout above = 19, then +7.
    await expect
      .poll(
        async () =>
          (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
      )
      .toBe(26);
    await expect(row).toContainText("19 → 26");
  });

  test("refuses a delta that would drive stock negative, and says the current number", async ({
    page,
  }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Negative Guard" });
    const product = await seedProduct({
      priceCents: 250,
      stockQty: 3,
      name: `Scarce Adjustable ${Date.now()}`,
    });
    await placeOrder({ slotId: slot.id, items: [{ productId: product.id, qty: 1 }] });

    await openPickList(page);
    const row = stockRow(page, product.name);
    await row.getByRole("textbox").fill("-50");
    await row.getByRole("button", { name: /apply/i }).click();

    await expect(row.getByRole("alert")).toContainText(/leave stock negative/i);
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
    ).toBe(2);
  });

  test("a non-integer delta is refused client-side before any request", async ({ page }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Bad Delta" });
    const product = await seedProduct({
      priceCents: 250,
      stockQty: 10,
      name: `Fractional Guard ${Date.now()}`,
    });
    await placeOrder({ slotId: slot.id, items: [{ productId: product.id, qty: 1 }] });

    await openPickList(page);
    const row = stockRow(page, product.name);

    let posted = 0;
    await page.route("**/api/admin/products/**/stock", (r) => {
      posted++;
      r.continue();
    });

    await row.getByRole("textbox").fill("1.5");
    await row.getByRole("button", { name: /apply/i }).click();
    await expect(row.getByRole("alert")).toContainText(/non-zero whole number/i);
    expect(posted).toBe(0);
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
    ).toBe(9);
  });
});

test.describe("staff admin — allergens and PII on the pick list", () => {
  test("renders both the order-level union and the per-line snapshot", async ({ page }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "Allergen Service" });
    const a = await seedProduct({
      priceCents: 250,
      stockQty: 20,
      allergens: ["PEANUTS"],
      name: `Peanut Line ${Date.now()}`,
    });
    const b = await seedProduct({
      priceCents: 250,
      stockQty: 20,
      allergens: ["DAIRY"],
      name: `Dairy Line ${Date.now()}`,
    });
    const order = await placeOrder({
      slotId: slot.id,
      items: [
        { productId: a.id, qty: 1 },
        { productId: b.id, qty: 1 },
      ],
    });

    await openPickList(page);
    const card = orderCard(page, order.orderNumber);
    // Order-level union, so a packer sees the hazard before reading the lines.
    await expect(card.getByRole("note")).toContainText("PEANUTS");
    await expect(card.getByRole("note")).toContainText("DAIRY");
    // And per-line, so they know WHICH bag item carries it.
    await expect(card).toContainText(`${a.name}`);
    await expect(card.locator("li").filter({ hasText: a.name })).toContainText("[PEANUTS]");
    await expect(card.locator("li").filter({ hasText: b.name })).toContainText("[DAIRY]");
  });

  test("the pick list carries no email, no phone and no order database id", async ({ page }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 20, label: "PII Service" });
    const product = await seedProduct({ priceCents: 250, stockQty: 20 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 1 }],
      studentName: "Devon Okonkwo",
      email: "devon.okonkwo@school.ca",
      phone: "604-555-0142",
      homeroom: "9C",
    });

    await openPickList(page);
    // Read the page only once THIS order has rendered — otherwise a passing
    // "no email present" assertion could just mean the order was not on screen
    // yet, which is a green test that proves nothing.
    await expect(orderCard(page, order.orderNumber)).toBeVisible();
    const body = (await pageText(page))!;

    // Staff legitimately need the name and homeroom to hand a bag over.
    expect(body).toContain("Devon Okonkwo");
    expect(body).toContain("9C");
    // They do not need — and must not be shown — contact details or the row id.
    expect(body).not.toContain("devon.okonkwo@school.ca");
    expect(body).not.toContain("604-555-0142");
    expect(body).not.toContain(order.id);
    // …and no address of any shape is on screen, not just this student's.
    expect(await visibleText(page)).not.toContain("@");
  });
});

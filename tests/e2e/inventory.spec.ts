import { test, expect, type Page } from "@playwright/test";
import { countBookedOrders, e2eDb, seedProduct, seedSlot } from "./setup/db";
import { ADMIN_PASSCODE, INVENTORY_PASSCODE } from "./setup/env";
import {
  adminApiToken,
  inventoryApiToken,
  placeOrder,
  signInAsInventory,
  signInAsStaff,
  waitForHydration,
} from "./helpers";

/**
 * `/inventory` — the restricted catalog editor (API-CONTRACT §6b), held by two
 * thirteen-year-olds.
 *
 * The two things this spec is really for:
 *
 *   1. THE BOUNDARY. No order, no student, no payment, no setting is reachable
 *      with an inventory session — not in a response body, not in an error, not
 *      at any nesting level. Asserted over real HTTP, not by looking at the UI.
 *   2. THE ALLERGEN GATE. CLAUDE.md §2.8 tightens rather than relaxes for this
 *      role. The UI enforcing it is necessary and not sufficient; a crafted
 *      request that skips the UI entirely must be refused by the server.
 */

const inventoryRow = (page: Page, productName: string) =>
  page.locator("li").filter({ hasText: productName }).first();

async function openInventory(page: Page) {
  await signInAsInventory(page);
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: /catalog editor/i })).toBeVisible({
    timeout: 20_000,
  });
  await waitForHydration(page, "button");
}

test.describe("inventory editor — sign in and separation", () => {
  test("signed out shows the catalog sign-in, and never offers the staff form", async ({
    page,
  }) => {
    await page.goto("/inventory");
    await expect(page.getByRole("heading", { name: /catalog sign-in/i })).toBeVisible();
    // §6b: "Never fall back to the staff sign-in form" — offering one in place
    // of the other is how the wrong passcode ends up in the wrong hands.
    await expect(page.getByRole("heading", { name: /staff sign-in/i })).toHaveCount(0);
    await expect(page.getByText(/different passcode from the staff/i)).toBeVisible();
  });

  test("the staff passcode does not open the catalog editor", async ({ page }) => {
    expect(ADMIN_PASSCODE).not.toBe(INVENTORY_PASSCODE);
    await page.goto("/inventory");
    await waitForHydration(page, "form");
    await page.getByLabel("Passcode").fill(ADMIN_PASSCODE);
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /catalog editor/i })).toHaveCount(0);
  });

  test("a staff cookie does not authorise the catalog editor's own screen", async ({ page }) => {
    await signInAsStaff(page);
    await page.goto("/inventory");
    // The ll_admin cookie is present; the inventory session check must still
    // 401 and drop to sign-in.
    await expect(page.getByRole("heading", { name: /catalog sign-in/i })).toBeVisible();
  });

  test("an inventory cookie does not authorise the staff screen", async ({ page }) => {
    await signInAsInventory(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: /staff sign-in/i })).toBeVisible();
  });
});

test.describe("inventory editor — the boundary, over real HTTP", () => {
  test("an inventory session is refused by every staff route and by the receipt route", async ({
    request,
  }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 10 });
    const product = await seedProduct({ priceCents: 200, stockQty: 10 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 1 }],
      studentName: "Boundary Student",
      email: "boundary.student@school.ca",
      phone: "604-555-0177",
    });

    await inventoryApiToken(request);

    const adminGets = ["/api/admin/session", "/api/admin/orders"];
    for (const path of adminGets) {
      const r = await request.get(path);
      expect(r.status(), `${path} accepted an inventory session`).toBe(401);
      expect(await r.text()).not.toContain("boundary.student@school.ca");
    }

    const adminPosts = [
      `/api/admin/orders/${order.orderNumber}/pack`,
      `/api/admin/orders/${order.orderNumber}/pickup`,
      `/api/admin/orders/${order.orderNumber}/cash`,
      `/api/admin/orders/${order.orderNumber}/refund`,
      `/api/admin/products/${product.id}/stock`,
    ];
    for (const path of adminPosts) {
      const r = await request.post(path, { data: {} });
      expect(r.status(), `${path} accepted an inventory session`).toBe(401);
    }

    // The receipt route answers the same way it answers a stranger — the
    // inventory cookie is not a skeleton key and not an oracle.
    const receipt = await request.get(`/api/orders/${order.orderNumber}`);
    expect([401, 403, 404]).toContain(receipt.status());

    // Nothing changed.
    const after = await e2eDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(order.status);
  });

  test("no inventory response contains any student-shaped field, at any depth", async ({
    request,
  }) => {
    await inventoryApiToken(request);

    const list = await request.get("/api/inventory/products");
    expect(list.status()).toBe(200);
    const raw = await list.text();

    // §6b: "a full product list contains no @, and no email/phone/studentName/
    // homeroom/pickupCode/orderNumber key at any depth."
    for (const needle of [
      "@",
      "email",
      "phone",
      "studentName",
      "homeroom",
      "pickupCode",
      "orderNumber",
      "paidAt",
      "stripe",
    ]) {
      expect(raw.toLowerCase(), `inventory product list leaked "${needle}"`).not.toContain(
        needle.toLowerCase(),
      );
    }

    // And the whitelist holds: only the fourteen documented columns.
    const body = (await list.json()) as { products: Record<string, unknown>[] };
    const allowed = new Set([
      "id",
      "slug",
      "name",
      "description",
      "priceCents",
      "category",
      "rarity",
      "allergens",
      "stockQty",
      "active",
      "imageUrl",
      "sortOrder",
      "createdAt",
      "updatedAt",
    ]);
    for (const p of body.products.slice(0, 25)) {
      for (const key of Object.keys(p)) {
        expect(allowed.has(key), `unexpected column "${key}" in an inventory product`).toBe(true);
      }
    }
  });

  test("a staff session is refused by every inventory route", async ({ request }) => {
    await adminApiToken(request);
    const product = await seedProduct({ priceCents: 200, stockQty: 5 });

    const gets = [
      "/api/inventory/session",
      "/api/inventory/products",
      `/api/inventory/products/${product.id}`,
    ];
    for (const path of gets) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
    expect((await request.post("/api/inventory/products", { data: {} })).status()).toBe(401);
    expect(
      (await request.patch(`/api/inventory/products/${product.id}`, { data: { name: "x" } })).status(),
    ).toBe(401);
    expect(
      (
        await request.post(`/api/inventory/products/${product.id}/stock`, { data: { delta: 1 } })
      ).status(),
    ).toBe(401);
  });
});

test.describe("inventory editor — the allergen gate cannot be bypassed", () => {
  test("the UI refuses to create without the affirmation, and sends no request", async ({
    page,
  }) => {
    await openInventory(page);
    await page.getByRole("button", { name: /add a new product/i }).click();

    let posted = 0;
    await page.route("**/api/inventory/products", (r) => {
      if (r.request().method() === "POST") posted++;
      r.continue();
    });

    const name = `Gate UI ${Date.now()}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Description").fill("Created without affirming allergens.");
    await page.getByLabel(/price/i).fill("1.75");
    await page.getByLabel("Category").selectOption("sweet");
    await page.getByLabel("Rarity").selectOption("COMMON");
    await page.getByLabel(/photo|image/i).fill("/products/none.svg");
    await page.getByLabel(/starting stock/i).fill("5");
    // Deliberately NOT checking the affirmation.
    await page.getByRole("button", { name: /create product/i }).click();

    await expect(page.getByRole("alert").filter({ hasText: /allergen confirmation/i })).toBeVisible();
    expect(posted, "the form posted a create with no allergen affirmation").toBe(0);
    expect(await e2eDb.product.count({ where: { name } })).toBe(0);
  });

  test("a crafted create with no affirmation is refused by the server", async ({ request }) => {
    await inventoryApiToken(request);
    const slug = `crafted-no-affirm-${Date.now()}`;

    const r = await request.post("/api/inventory/products", {
      data: {
        name: "Crafted No Affirmation",
        slug,
        description: "Bypasses the UI entirely.",
        priceCents: 175,
        category: "sweet",
        rarity: "COMMON",
        allergens: ["PEANUTS"],
        // allergensReviewed deliberately absent
        stockQty: 5,
        imageUrl: "/products/none.svg",
        active: true,
      },
    });

    expect(r.status()).toBe(400);
    expect((await r.json()).error.code).toBe("ALLERGENS_NOT_REVIEWED");
    expect(await e2eDb.product.count({ where: { slug } })).toBe(0);
  });

  test("`allergensReviewed` is only accepted as the literal true", async ({ request }) => {
    await inventoryApiToken(request);

    for (const value of [1, "true", "yes", {}, [], null, "TRUE"]) {
      const slug = `crafted-truthy-${Date.now()}-${JSON.stringify(value)}`
        .replace(/[^a-z0-9-]/gi, "")
        .toLowerCase();
      const r = await request.post("/api/inventory/products", {
        data: {
          name: "Crafted Truthy Affirmation",
          slug,
          description: "A truthy value is not an affirmation.",
          priceCents: 175,
          category: "sweet",
          rarity: "COMMON",
          allergens: [],
          allergensReviewed: value,
          stockQty: 5,
          imageUrl: "/products/none.svg",
          active: true,
        },
      });
      expect(r.status(), `allergensReviewed: ${JSON.stringify(value)} was accepted`).toBe(400);
      expect(await e2eDb.product.count({ where: { slug } })).toBe(0);
    }
  });

  test("publishing an unreviewed seeded product is refused, even with the flag set", async ({
    request,
  }) => {
    // The exact case §6b built the rule for: a row whose empty allergen list
    // was never reviewed must not be silently re-published as "reviewed".
    const product = await seedProduct({ allergens: [], active: false, stockQty: 5 });
    await inventoryApiToken(request);

    const r = await request.patch(`/api/inventory/products/${product.id}`, {
      data: { active: true, allergensReviewed: true },
    });

    expect(r.status()).toBe(400);
    expect((await r.json()).error.code).toBe("ALLERGENS_NOT_REVIEWED");
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).active,
    ).toBe(false);

    // Restating the empty list explicitly is what makes it legitimate.
    const ok = await request.patch(`/api/inventory/products/${product.id}`, {
      data: { active: true, allergens: [], allergensReviewed: true },
    });
    expect(ok.status()).toBe(200);
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).active,
    ).toBe(true);
  });

  test("changing allergens without re-affirming is refused", async ({ request }) => {
    const product = await seedProduct({ allergens: ["DAIRY"], active: true, stockQty: 5 });
    await inventoryApiToken(request);

    const r = await request.patch(`/api/inventory/products/${product.id}`, {
      data: { allergens: ["DAIRY", "PEANUTS"] },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error.code).toBe("ALLERGENS_NOT_REVIEWED");
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).allergens,
    ).toEqual(["DAIRY"]);
  });

  test("an unknown allergen token is refused, never silently dropped", async ({ request }) => {
    const product = await seedProduct({ allergens: ["DAIRY"], active: false, stockQty: 5 });
    await inventoryApiToken(request);

    const r = await request.patch(`/api/inventory/products/${product.id}`, {
      data: { allergens: ["DAIRY", "GLUTEN_FREE"], allergensReviewed: true },
    });
    expect(r.status()).toBe(400);
    // A silent drop is the dangerous behaviour: the editor believes they
    // recorded something the database does not have.
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).allergens,
    ).toEqual(["DAIRY"]);
  });

  test("the affirmation checkbox resets whenever the checklist is touched", async ({ page }) => {
    await openInventory(page);
    await page.getByRole("button", { name: /add a new product/i }).click();

    const affirm = page.locator("#create-allergens-reviewed");
    await affirm.check();
    await expect(affirm).toBeChecked();

    // Touching any box un-affirms. A stale affirmation carrying a later edit
    // across the gate is exactly what this rule exists to stop.
    await page.locator("#create-allergen-PEANUTS").check();
    await expect(affirm).not.toBeChecked();
  });
});

test.describe("inventory editor — money and stock", () => {
  test("no client-supplied total or absolute stock is accepted after creation", async ({
    request,
  }) => {
    const product = await seedProduct({ priceCents: 250, stockQty: 12 });
    await inventoryApiToken(request);

    // CLAUDE.md §2.4: an absolute set is a read-then-write with a human in the
    // middle. PATCH must refuse it loudly rather than silently ignoring it.
    const patch = await request.patch(`/api/inventory/products/${product.id}`, {
      data: { stockQty: 7 },
    });
    expect(patch.status()).toBe(400);
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
    ).toBe(12);

    // …and the stock route refuses an absolute field too.
    const abs = await request.post(`/api/inventory/products/${product.id}/stock`, {
      data: { stockQty: 7 },
    });
    expect(abs.status()).toBe(400);

    // Unknown keys are rejected, not silently dropped — including ones that
    // name money or order state.
    for (const body of [
      { name: "x", totalCents: 1 },
      { name: "x", status: "PAID" },
      { name: "x", id: "cattacker" },
      { name: "x", slug: "renamed" },
    ]) {
      const r = await request.patch(`/api/inventory/products/${product.id}`, { data: body });
      expect(r.status(), `PATCH accepted ${JSON.stringify(body)}`).toBe(400);
    }
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).name,
    ).toBe(product.name);
  });

  test("concurrent adjustments each return a distinct quantity — no lost update", async ({
    request,
  }) => {
    const product = await seedProduct({ priceCents: 200, stockQty: 40 });
    await inventoryApiToken(request);

    // Promise.all, not a loop. A sequential version of this passes against a
    // read-then-write implementation and proves nothing.
    //
    // NO other writer touches this product, which is what makes "12 distinct
    // quantities" a valid assertion: `adjust_stock()` reads its result out of
    // the same UPDATE, so with only +1 operations in flight the returned values
    // must be 41…52 in some order. A repeat would mean two callers observed the
    // same post-state, i.e. a lost update.
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request.post(`/api/inventory/products/${product.id}/stock`, { data: { delta: 1 } }),
      ),
    );

    const quantities: number[] = [];
    for (const r of responses) {
      expect(r.status()).toBe(200);
      quantities.push((await r.json()).stockQty);
    }
    expect(
      new Set(quantities).size,
      `duplicate stockQty across concurrent adjustments: ${quantities}`,
    ).toBe(12);
    expect([...quantities].sort((a, b) => a - b)).toEqual([
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    ]);

    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
    ).toBe(52);
  });

  test("adjustments compose exactly with concurrent checkouts on the same product", async ({
    request,
  }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 30 });
    const product = await seedProduct({ priceCents: 200, stockQty: 40 });
    await inventoryApiToken(request);

    // Deliberately NOT asserting distinct returned quantities here: a checkout
    // decrementing between two adjustments makes the same value legitimately
    // appear twice (…39 → +1 = 40 → checkout = 39 → +1 = 40). The property that
    // still has to hold under interleaving is the arithmetic.
    const results = await Promise.all([
      ...Array.from({ length: 12 }, () =>
        request.post(`/api/inventory/products/${product.id}/stock`, { data: { delta: 1 } }),
      ),
      ...Array.from({ length: 8 }, () =>
        placeOrder({ slotId: slot.id, items: [{ productId: product.id, qty: 1 }] }),
      ),
    ]);

    for (const r of results.slice(0, 12) as Awaited<ReturnType<typeof request.post>>[]) {
      expect(r.status()).toBe(200);
    }

    const after = await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQty, "12 adjustments and 8 sales did not compose").toBe(40 + 12 - 8);

    const booked = await countBookedOrders(slot.serviceDate, slot.startTime, slot.location);
    expect(booked).toBe(8);
    expect(booked).toBeLessThanOrEqual(slot.capacity);
  });

  test("a delta that would go negative is refused and reports the real quantity", async ({
    request,
  }) => {
    const product = await seedProduct({ priceCents: 200, stockQty: 3 });
    await inventoryApiToken(request);

    const r = await request.post(`/api/inventory/products/${product.id}/stock`, {
      data: { delta: -10 },
    });
    expect(r.status()).toBe(409);
    const body = await r.json();
    expect(body.error.code).toBe("STOCK_ADJUSTMENT_REJECTED");
    expect(body.error.stockQty).toBe(3);
    expect(
      (await e2eDb.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty,
    ).toBe(3);
  });

  test("the price bounds hold against a crafted request", async ({ request }) => {
    await inventoryApiToken(request);
    for (const priceCents of [0, -100, 5001, 1.5, "175"]) {
      const slug = `price-bound-${Date.now()}-${String(priceCents).replace(/\W/g, "")}`;
      const r = await request.post("/api/inventory/products", {
        data: {
          name: "Price Bound Probe",
          slug,
          description: "Probing the documented 1–5000 cent bounds.",
          priceCents,
          category: "sweet",
          rarity: "COMMON",
          allergens: [],
          allergensReviewed: true,
          stockQty: 1,
          imageUrl: "/products/none.svg",
          active: false,
        },
      });
      expect(r.status(), `priceCents ${JSON.stringify(priceCents)} was accepted`).toBe(400);
      expect(await e2eDb.product.count({ where: { slug } })).toBe(0);
    }
  });
});

test.describe("inventory editor — the screen itself", () => {
  test("lists inactive and sold-out products, which the public catalog hides", async ({
    page,
  }) => {
    const inactive = await seedProduct({
      name: `Inactive Draft ${Date.now()}`,
      active: false,
      stockQty: 4,
    });
    const soldOut = await seedProduct({
      name: `Zero Stock ${Date.now()}`,
      active: true,
      stockQty: 0,
    });

    await openInventory(page);
    await expect(inventoryRow(page, inactive.name)).toContainText(/draft \(inactive\)/i);
    await expect(inventoryRow(page, soldOut.name)).toContainText(/out of stock/i);

    // The public catalog API filters both of these out — that contrast is the
    // point of this screen.
    const publicList = await page.request.get("/api/products");
    const body = await publicList.text();
    expect(body).not.toContain(inactive.name);
    expect(body).not.toContain(soldOut.name);
  });

  test("an empty allergen list is labelled as unconfirmed, not as safe", async ({ page }) => {
    const p = await seedProduct({
      name: `Empty Allergens ${Date.now()}`,
      allergens: [],
      stockQty: 5,
    });
    await openInventory(page);
    await expect(inventoryRow(page, p.name)).toContainText(
      /not the same as confirmed safe/i,
    );
  });

  test("adjusting stock from the screen shows the authoritative number", async ({ page }) => {
    const p = await seedProduct({ name: `Screen Adjust ${Date.now()}`, stockQty: 9 });
    await openInventory(page);

    const row = inventoryRow(page, p.name);
    await row.getByRole("button", { name: /adjust stock/i }).click();
    await row.getByLabel(new RegExp(`adjust stock for ${p.name}`, "i")).fill("+4");
    await row.getByRole("button", { name: /apply/i }).click();

    await expect
      .poll(async () => (await e2eDb.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty)
      .toBe(13);
    await expect(row).toContainText("9 → 13");
  });

  test("nothing on this screen mentions an order, a student or a payment", async ({ page }) => {
    const slot = await seedSlot({ startsInMinutes: 200, capacity: 10 });
    const product = await seedProduct({ priceCents: 200, stockQty: 10 });
    const order = await placeOrder({
      slotId: slot.id,
      items: [{ productId: product.id, qty: 1 }],
      studentName: "Invisible Student",
      email: "invisible.student@school.ca",
      phone: "604-555-0188",
    });

    await openInventory(page);
    const html = await page.content();
    for (const needle of [
      "Invisible Student",
      "invisible.student@school.ca",
      "604-555-0188",
      order.orderNumber,
      order.pickupCode,
    ]) {
      expect(html, `the catalog editor rendered "${needle}"`).not.toContain(needle);
    }
  });
});

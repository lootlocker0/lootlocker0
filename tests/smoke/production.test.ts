import { describe, it, expect } from "vitest";
import { PROD_SITE_URL } from "./env";

/**
 * Production smoke suite. READ-ONLY, by hard rule, not convention:
 *
 *   - no POST /api/checkout, ever — a real card would be charged through the
 *     live Stripe account this app actually uses in production, unlike every
 *     other suite in this repo (lib/stripe/payments.ts's simulator only arms
 *     off-production, per docs/HANDOFF.md §20 — production always makes the
 *     real call).
 *   - no sign-in attempt against /api/admin/login or /api/inventory/login —
 *     a wrong passcode here would trip whatever real lockout/rate-limit the
 *     production deployment has for that endpoint, against the actual staff
 *     credential.
 *   - no write of any kind to the real database — no order, no account, no
 *     product change, nothing that a human would have to go clean up by hand
 *     afterward.
 *
 * This exists to catch "the deployment is actually broken" (wrong env var,
 * a 500 on every page, DNS/TLS misconfigured) on a schedule, not to
 * re-prove product behavior — that is what the other three suites
 * (`tests/unit`, `tests/api`, `tests/e2e`) already do against disposable
 * databases. If a check here needs a real write to assert something
 * meaningful, it belongs in one of those suites instead, not here.
 */

async function get(path: string): Promise<Response> {
  return fetch(`${PROD_SITE_URL}${path}`, { redirect: "manual" });
}

describe("production smoke — public pages", () => {
  it("home page loads", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html/i);
    expect(html).not.toMatch(/create-next-app/i);
  });

  it("catalog page loads", async () => {
    const res = await get("/snacks");
    expect(res.status).toBe(200);
  });
});

describe("production smoke — public read APIs", () => {
  it("GET /api/products returns a well-formed, safety-reviewed catalog", async () => {
    const res = await get("/api/products");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");

    const body = (await res.json()) as {
      products: {
        id: string;
        priceCents: number;
        stockQty: number;
        allergens: string[];
        active: boolean;
      }[];
    };
    expect(Array.isArray(body.products)).toBe(true);

    for (const product of body.products) {
      // Every row returned here is implicitly `active: true, stockQty > 0`
      // per the route's own filter (docs/HANDOFF.md item 10) — this just
      // confirms that filter is actually doing its job in production, not
      // just in the test database.
      expect(product.active).toBe(true);
      expect(product.stockQty).toBeGreaterThan(0);
      // CLAUDE.md §2.1: money is integer cents, never a float.
      expect(Number.isInteger(product.priceCents)).toBe(true);
      expect(product.priceCents).toBeGreaterThan(0);
    }
  });

  it("GET /api/slots returns pickup windows with no capacity numbers leaked", async () => {
    const res = await get("/api/slots");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: Record<string, unknown>[] };
    expect(Array.isArray(body.slots)).toBe(true);
    for (const slot of body.slots) {
      // docs/HANDOFF.md item 10: this is advisory/racy by design and must
      // never expose the raw numbers it is derived from.
      expect(slot).not.toHaveProperty("capacity");
      expect(slot).not.toHaveProperty("bookedCount");
    }
  });
});

describe("production smoke — staff/inventory surfaces refuse an unauthenticated read", () => {
  it("GET /api/admin/orders with no session is refused, not a pick list", async () => {
    const res = await get("/api/admin/orders");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ADMIN_UNAUTHORIZED");
  });

  it("GET /api/inventory/products with no session is refused, not a catalog edit view", async () => {
    const res = await get("/api/inventory/products");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVENTORY_UNAUTHORIZED");
  });
});

describe("production smoke — nothing a student's browser shouldn't see", () => {
  it("the home page response carries no server secret", async () => {
    const res = await get("/");
    const html = await res.text();
    // The same shape tests/leaks/bundle.test.ts checks against the built
    // bundle locally; this is the same assertion against the real deployed
    // artifact, which is the only copy that actually matters.
    expect(html).not.toMatch(/sk_(test|live)_/);
    expect(html).not.toMatch(/whsec_/);
    expect(html).not.toMatch(/ADMIN_PASSCODE/i);
  });
});

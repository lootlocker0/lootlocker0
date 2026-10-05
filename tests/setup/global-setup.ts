import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prepareSchema } from "./db";
import { startServer, stopServer } from "./server";
import { BASE_URL, TEST_DATABASE_URL } from "./env";

/**
 * Runs once for the whole suite, before any worker forks.
 *
 * The self-check at the end is not ceremony. If `next dev` picked up
 * `DATABASE_URL` from the repo's `.env` instead of the one passed to it, every
 * test in this suite would drive the DEV database while asserting against the
 * TEST database — and the assertions would fail in ways that look like product
 * bugs, or worse, a concurrency test would quietly destroy real dev data.
 * Proving the server can see a row only the test database contains is the
 * cheapest way to rule that out.
 */
export async function setup() {
  prepareSchema();

  // `tests/unit` needs neither the server nor a fixture; skipping the ~6s
  // `next dev` boot keeps `npm run test:unit` usable as a fast inner loop.
  if (process.env.QA_NO_SERVER === "1") return async () => {};

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
  });

  await db.$executeRawUnsafe(
    `TRUNCATE order_items, orders, webhook_events, products, test_pickup_windows RESTART IDENTITY CASCADE`,
  );

  const sentinel = await db.product.create({
    data: {
      slug: "qa-harness-sentinel",
      name: "QA Harness Sentinel",
      description: "Written by tests/setup/global-setup.ts; deleted immediately.",
      priceCents: 1,
      category: "sweet",
      rarity: "COMMON",
      allergens: [],
      stockQty: 1,
      active: true,
      imageUrl: "/products/none.svg",
    },
  });

  await startServer();

  const res = await fetch(`${BASE_URL}/api/products`);
  const body = (await res.json()) as { products?: { id: string }[] };
  const sawSentinel = body.products?.some((p) => p.id === sentinel.id) ?? false;

  await db.product.delete({ where: { id: sentinel.id } });
  await db.$disconnect();

  if (!sawSentinel) {
    await stopServer();
    throw new Error(
      "Harness self-check failed: the dev server did not return a product that " +
        "only exists in the test database. It is talking to a different DATABASE_URL. " +
        "Refusing to run — this suite would otherwise write to the dev database.",
    );
  }

  return async () => {
    await stopServer();
  };
}

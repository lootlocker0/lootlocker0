import { stripeRealDb } from "./db";

/**
 * Same shape as tests/e2e/setup/global-setup.ts's self-check: proves the
 * dev server this suite's webServer starts is actually talking to THIS
 * suite's database (STRIPE_REAL_DATABASE_URL), not some other suite's or a
 * real production one, before any real Stripe call is made.
 */
export async function setup() {
  const sentinel = await stripeRealDb.product.create({
    data: {
      slug: "stripe-real-harness-sentinel",
      name: "Stripe Real Harness Sentinel",
      description: "Written by tests/stripe-real/global-setup.ts; deleted immediately.",
      priceCents: 1,
      category: "sweet",
      rarity: "COMMON",
      allergens: [],
      stockQty: 1,
      active: true,
      imageUrl: "/products/none.svg",
    },
  });

  return async () => {
    await stripeRealDb.product
      .delete({ where: { id: sentinel.id } })
      .catch(() => {}); // already gone is fine
    await stripeRealDb.$disconnect();
  };
}

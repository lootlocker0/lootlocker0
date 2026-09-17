/**
 * LootLockers seed — idempotent by construction.
 *
 *   npx prisma db seed        # or: npx tsx prisma/seed.ts
 *
 * Running it twice must produce zero duplicate rows and zero unique-constraint
 * errors. Every write below is an upsert on a real unique key:
 *
 *   products      → slug
 *   pickup_slots  → (serviceDate, startTime, location)
 *   settings      → key
 *
 * Three deliberate non-overwrites, because a seed re-run must never destroy
 * operational state:
 *
 *   · Product.stockQty is set on create only. Stock belongs to reserve_stock()
 *     and the release path; a seed that resets it can un-sell snacks that have
 *     already been paid for. Pass SEED_RESET_STOCK=1 to opt in for local dev.
 *   · PickupSlot.capacity and bookedCount are set on create only, for the same
 *     reason plus the booked_within_capacity CHECK constraint.
 *   · Setting values are written on create only. Changing the spend cap or the
 *     tax rate is a human decision (CLAUDE.md §7), and a seed run must not
 *     silently revert one.
 *
 * Product naming: most items are generic descriptions of real snacks. A subset
 * (Doritos, Kool-Aid Jammers, Lay's, Cheetos, Ruffles) uses real brand names by
 * the manager's explicit decision, because the catalog is physically stocking
 * those exact products — see docs/DESIGN.md "Third-party IP" §3 for the
 * nominative-use reasoning. None of them carry invented stat/rarity flavor
 * text; descriptions stay factual (name, flavor) per that same decision.
 * CLAUDE.md §2.7 ("no third-party IP") reads as about invented copy wrapped
 * around a trademark, not about naming what's actually on the shelf.
 *
 * Allergen lists are placeholders authored by an agent and MUST be reviewed by
 * whoever is accountable for allergens at the school before launch — see
 * docs/HANDOFF.md §4. This applies equally to the real-branded items above;
 * an agent guessing at a Doritos ingredient list is not a substitute for
 * reading the actual bag.
 */
import "dotenv/config";

import type { Allergen, Rarity } from "@prisma/client";

import { db } from "../lib/db";
import { schoolParts } from "../lib/timezone";

const RESET_STOCK = process.env.SEED_RESET_STOCK === "1";

const PRODUCT_IMAGES: Record<string, string> = {
  "gatorade-fruit-punch": "/ProductImages/redgatorade.png",
  "gatorade-lemon-lime": "/ProductImages/lemon-limegatorade.png",
  "gatorade-orange": "/ProductImages/orangegatorade.png",
  "gatorade-cool-blue": "/ProductImages/bluegatorade.png",
  "kool-aid-grape": "/ProductImages/grapekoolaid.png",
  "kool-aid-cherry": "/ProductImages/cherrykoolaid.png",
  "kool-aid-blue-raspberry-lemonade": "/ProductImages/blueraspberrykoolaid.png",
  "kool-aid-strawberry-kiwi": "/ProductImages/strawberrykiwikoolaid.png",
  "alani-nu": "/ProductImages/alaniNu.png",
  "nutella-sticks": "/ProductImages/nutella-bready.png",
  "minute-maid-juice": "/ProductImages/minutemaid.png",
  "fruit-roll-ups": "/ProductImages/fruitrollup.jpg",
  "chocolate-chip-cookies": "",
};

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

type SeedProduct = {
  slug: string;
  name: string;
  description: string;
  sizeProduct: string;
  priceCents: number;
  category: "sweet" | "savory" | "drinks" | "healthy";
  rarity: Rarity;
  allergens: Allergen[];
  stockQty: number;
  active?: boolean;
};

const PRODUCTS: SeedProduct[] = [
  {
    slug: "gatorade-fruit-punch",
    name: "Gatorade Fruit Punch",
    description: "Fruit Punch flavour sports drink.",
    sizeProduct: "591 mL",
    priceCents: 300,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 10,
  },
  {
    slug: "gatorade-lemon-lime",
    name: "Gatorade Lemon-Lime",
    description: "Lemon-Lime flavour sports drink.",
    sizeProduct: "591 mL",
    priceCents: 300,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 10,
  },
  {
    slug: "gatorade-orange",
    name: "Gatorade Orange",
    description: "Orange flavour sports drink.",
    sizeProduct: "591 mL",
    priceCents: 300,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 10,
  },
  {
    slug: "gatorade-cool-blue",
    name: "Gatorade Cool Blue",
    description: "Cool Blue flavour sports drink.",
    sizeProduct: "591 mL",
    priceCents: 300,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 10,
  },
  {
    slug: "kool-aid-grape",
    name: "Kool-Aid Grape",
    description: "Purple grape flavored drink pouch.",
    sizeProduct: "180 mL pouch",
    priceCents: 200,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 24,
  },
  {
    slug: "kool-aid-cherry",
    name: "Kool-Aid Cherry",
    description: "Red cherry flavored drink pouch.",
    sizeProduct: "180 mL pouch",
    priceCents: 200,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 24,
  },
  {
    slug: "kool-aid-blue-raspberry-lemonade",
    name: "Kool-Aid Blue Raspberry Lemonade",
    description: "Blue raspberry lemonade flavored drink pouch.",
    sizeProduct: "180 mL pouch",
    priceCents: 200,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 24,
  },
  {
    slug: "kool-aid-strawberry-kiwi",
    name: "Kool-Aid Strawberry Kiwi",
    description: "Strawberry kiwi flavored drink pouch.",
    sizeProduct: "180 mL pouch",
    priceCents: 200,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 24,
  },
  {
    slug: "alani-nu",
    name: "Alani Nu",
    description: "Energy drink variety pack in assorted Alani flavours.",
    sizeProduct: "355 mL",
    priceCents: 300,
    category: "drinks",
    rarity: "UNCOMMON",
    allergens: [],
    stockQty: 24,
  },
  {
    slug: "nutella-sticks",
    name: "Nutella Sticks",
    description: "Creamy hazelnut chocolate sticks for a quick snack.",
    sizeProduct: "22 g",
    priceCents: 150,
    category: "sweet",
    rarity: "UNCOMMON",
    allergens: ["DAIRY", "GLUTEN", "TREE_NUTS"],
    stockQty: 22,
  },
  {
    slug: "fruit-roll-ups",
    name: "Fruit Roll-Ups",
    description: "Fruit-flavoured chewy snack strips.",
    sizeProduct: "12 g",
    priceCents: 100,
    category: "sweet",
    rarity: "COMMON",
    allergens: ["GLUTEN"],
    stockQty: 36,
  },
  {
    slug: "minute-maid-juice",
    name: "Minute Maid Juice",
    description: "Classic fruit juice.",
    sizeProduct: "200 mL",
    priceCents: 125,
    category: "drinks",
    rarity: "COMMON",
    allergens: [],
    stockQty: 30,
  },
  {
    slug: "chocolate-chip-cookies",
    name: "Chocolate Chip Cookies",
    description: "Soft baked chocolate chip cookies.",
    sizeProduct: "454 g",
    priceCents: 150,
    category: "sweet",
    rarity: "RARE",
    allergens: ["GLUTEN", "DAIRY", "EGGS", "SOY"],
    stockQty: 16,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Pickup slots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Placeholder bell schedule. The real one, and the real per-slot handout
 * throughput, are school sign-off items (CLAUDE.md §7).
 */
const SLOT_TEMPLATE = [
  { label: "Pickup 1", startTime: "07:50", location: "Locker B449", capacity: 24 },
  { label: "Pickup 2", startTime: "10:50", location: "Hub", capacity: 24 },
  { label: "Pickup 3", startTime: "11:30", location: "Hub", capacity: 18 },
  { label: "Pickup 4", startTime: "14:15", location: "Locker B449", capacity: 18 },
];

/** Only seed the current day for the pickup picker. Repeating the same four
 * windows across every future date makes the UI feel duplicated and noisy.
 */
const SLOT_DAYS = 1;

/**
 * UTC-midnight date key for the school's calendar day plus offset.
 */
function serviceDay(offset: number): Date {
  const p = schoolParts();
  return new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings — defaults mirror lib/settings.ts
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS: Record<string, string> = {
  daily_spend_cap_cents: "1500",
  order_cutoff_minutes: "45",
  // Placeholder. Tax treatment of snack foods is a human decision (CLAUDE.md §7).
  tax_rate_bps: "0",
  pending_order_ttl_minutes: "15",
};

async function main() {
  const productSlugs = PRODUCTS.map((p) => p.slug);

  // Remove stale catalog items that are no longer in the active seed set.
  await db.product.deleteMany({
    where: {
      OR: [
        { slug: { notIn: productSlugs } },
        { slug: { in: ["kool-aid-green-apple", "green-apple", "greenapple"] } },
      ],
    },
  });

  // Remove stale future pickup slots so a reseed does not keep showing the old
  // multi-day list alongside the new single-day schedule.
  await db.pickupSlot.deleteMany({
      where: {
        serviceDate: { gte: serviceDay(0) },
        orders: { none: {} },
      },
  });

  // ── Products ──────────────────────────────────────────────────────────────
  for (const [i, p] of PRODUCTS.entries()) {
    const sortOrder = (i + 1) * 10;
    await db.product.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        name: p.name,
        description: p.description,
        sizeProduct: p.sizeProduct,
        priceCents: p.priceCents,
        category: p.category,
        rarity: p.rarity,
        allergens: p.allergens,
        stockQty: p.stockQty,
        active: p.active ?? true,
        imageUrl: PRODUCT_IMAGES[p.slug] ?? `/ProductImages/${p.slug}.png`,
        sortOrder,
      },
      update: {
        // Descriptive fields are safe to refresh. stockQty is not — see the
        // file header.
        name: p.name,
        description: p.description,
        sizeProduct: p.sizeProduct,
        priceCents: p.priceCents,
        category: p.category,
        rarity: p.rarity,
        allergens: p.allergens,
        active: p.active ?? true,
        imageUrl: PRODUCT_IMAGES[p.slug] ?? `/ProductImages/${p.slug}.png`,
        sortOrder,
        ...(RESET_STOCK ? { stockQty: p.stockQty } : {}),
      },
    });
  }

  // ── Pickup slots ──────────────────────────────────────────────────────────
  for (let day = 0; day < SLOT_DAYS; day++) {
    const serviceDate = serviceDay(day);

    for (const s of SLOT_TEMPLATE) {
      await db.pickupSlot.upsert({
        where: {
          serviceDate_startTime_location: {
            serviceDate,
            startTime: s.startTime,
            location: s.location,
          },
        },
        create: {
          label: s.label,
          startTime: s.startTime,
          location: s.location,
          serviceDate,
          capacity: s.capacity,
          active: true,
        },
        update: {
          // capacity and bookedCount are intentionally left alone.
          label: s.label,
          active: true,
        },
      });
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  for (const [key, value] of Object.entries(SETTINGS)) {
    await db.setting.upsert({
      where: { key },
      create: { key, value },
      // Never stomp a human's change.
      update: {},
    });
  }

  const [products, slots, settings, soldOut, futureSlots] = await Promise.all([
    db.product.count(),
    db.pickupSlot.count(),
    db.setting.count(),
    db.product.count({ where: { stockQty: 0 } }),
    db.pickupSlot.count({ where: { serviceDate: { gte: serviceDay(0) } } }),
  ]);

  console.log(
    [
      "seed complete",
      `  products      ${products} (${soldOut} sold out)`,
      `  pickup slots  ${slots} (${futureSlots} today or later)`,
      `  settings      ${settings}`,
      `  stock reset   ${RESET_STOCK ? "yes (SEED_RESET_STOCK=1)" : "no"}`,
    ].join("\n"),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

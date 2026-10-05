import { execSync } from "child_process";
import { randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { STRIPE_REAL_DATABASE_URL } from "./env";
import { schoolParts } from "@/lib/timezone";

/** Same shape as tests/e2e/setup/db.ts, pointed at this suite's own database. */
export const stripeRealDb: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: STRIPE_REAL_DATABASE_URL,
    allowExitOnIdle: true,
    idleTimeoutMillis: 1_000,
  }),
});

export function prepareSchema(): void {
  const env = {
    ...process.env,
    DATABASE_URL: STRIPE_REAL_DATABASE_URL,
    DIRECT_URL: STRIPE_REAL_DATABASE_URL,
  };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  execSync(
    `psql "${STRIPE_REAL_DATABASE_URL}" -v ON_ERROR_STOP=1 -f prisma/migrations/manual_constraints.sql`,
    { env, stdio: "pipe" },
  );
}

const uniq = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

export async function seedProduct() {
  const id = uniq();
  return stripeRealDb.product.create({
    data: {
      slug: `stripe-real-${id}`,
      name: `Stripe Real Test Snack ${id}`,
      description: "Seeded by the real-Stripe checkout suite.",
      priceCents: 300,
      category: "sweet",
      rarity: "COMMON",
      allergens: [],
      stockQty: 25,
      active: true,
      imageUrl: `/products/stripe-real-${id}.svg`,
      sortOrder: 0,
    },
  });
}

/** A pickup window three hours out on the school's (America/Vancouver) clock — matches tests/e2e/setup/db.ts's seedSlot default. */
export async function seedSlot() {
  const target = new Date(Date.now() + 180 * 60_000);
  const p = schoolParts(target);
  const serviceDate = new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0));
  const startTime = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;

  return stripeRealDb.pickupSlot.create({
    data: {
      label: `Stripe Real Test Window ${uniq()}`,
      startTime,
      location: "Locker bank R",
      serviceDate,
      capacity: 20,
      bookedCount: 0,
      active: true,
    },
  });
}

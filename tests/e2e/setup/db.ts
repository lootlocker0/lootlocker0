import { execSync } from "child_process";
import { randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Allergen, Rarity } from "@prisma/client";
import { E2E_DATABASE_URL } from "./env";
import { schoolParts } from "@/lib/timezone";
import { pickupWindowId } from "@/lib/pickup-windows";
import { TEST_PICKUP_WINDOWS_DDL } from "../../fixtures/test-pickup-windows-ddl";

/**
 * Real Postgres, its own database. Prisma 7 removed the `datasources`
 * constructor option, so the driver adapter is the only way to point a client
 * at a URL (docs/HANDOFF.md §2).
 */
export const e2eDb: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: E2E_DATABASE_URL,
    allowExitOnIdle: true,
    idleTimeoutMillis: 1_000,
  }),
});

/**
 * Idempotent. `manual_constraints.sql` is not optional: without it there is no
 * `book_slot()`, no `reserve_stock()` and no `adjust_stock()`, so every
 * checkout and every stock adjustment in this suite would 500 for a reason
 * that has nothing to do with the browser.
 */
export function prepareSchema(): void {
  const env = {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    DIRECT_URL: E2E_DATABASE_URL,
  };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  execSync(
    `psql "${E2E_DATABASE_URL}" -v ON_ERROR_STOP=1 -f prisma/migrations/manual_constraints.sql`,
    { env, stdio: "pipe" },
  );
  // Test-only, NOT a production table — see lib/pickup-windows-test.ts.
  execSync(
    `psql "${E2E_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "${TEST_PICKUP_WINDOWS_DDL}"`,
    { env, stdio: "pipe" },
  );
}

/**
 * `settings` is deliberately never written, exactly as in the vitest harness:
 * `lib/settings.ts` caches per process for 60s, so a suite that writes a
 * setting and immediately drives a page is unreliable by construction. An
 * empty table means every route reads the documented defaults — cap 1500,
 * cutoff 45 min, tax 0 bps, TTL 15 min.
 */
export async function truncateAll(): Promise<void> {
  await e2eDb.$executeRawUnsafe(
    `TRUNCATE order_items, orders, webhook_events, products, test_pickup_windows RESTART IDENTITY CASCADE`,
  );
}

let seq = 0;
export const uniq = () =>
  `${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(3).toString("hex")}`;

export interface SeedProductOpts {
  name?: string;
  slug?: string;
  description?: string;
  priceCents?: number;
  stockQty?: number;
  active?: boolean;
  allergens?: Allergen[];
  rarity?: Rarity;
  category?: string;
  sortOrder?: number;
}

export async function seedProduct(opts: SeedProductOpts = {}) {
  const id = uniq();
  return e2eDb.product.create({
    data: {
      slug: opts.slug ?? `e2e-${id}`,
      name: opts.name ?? `E2E Product ${id}`,
      description: opts.description ?? "Seeded by the E2E suite.",
      priceCents: opts.priceCents ?? 500,
      category: opts.category ?? "sweet",
      rarity: opts.rarity ?? "COMMON",
      allergens: opts.allergens ?? [],
      stockQty: opts.stockQty ?? 25,
      active: opts.active ?? true,
      imageUrl: `/products/e2e-${id}.svg`,
      sortOrder: opts.sortOrder ?? 0,
    },
  });
}

export interface SeedSlotOpts {
  capacity?: number;
  /** Minutes from now on the SCHOOL's clock (America/Vancouver). Default 180. */
  startsInMinutes?: number;
  serviceDate?: Date;
  startTime?: string;
  label?: string;
  location?: string;
}

/**
 * Declares a pickup window `startsInMinutes` from now **in America/Vancouver**,
 * not in the server's or the browser's timezone (docs/HANDOFF.md §17). Both
 * processes deliberately run on other zones, so a fixture computed from the
 * local `Date` getters would agree with a broken server-local cutoff and
 * disagree with a correct one.
 *
 * No PickupSlot table anymore — this writes to `test_pickup_windows`
 * (lib/pickup-windows-test.ts), which the real checkout/slots routes resolve
 * exactly like a production template entry, only when QA_ALLOW_TEST_WINDOWS=1
 * (never in production).
 */
export async function seedSlot(opts: SeedSlotOpts = {}) {
  const startsIn = opts.startsInMinutes ?? 180;
  const target = new Date(Date.now() + startsIn * 60_000);
  const p = schoolParts(target);

  const serviceDate =
    opts.serviceDate ?? new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0));
  const startTime =
    opts.startTime ??
    `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const location = opts.location ?? `Locker bank ${uniq()}`;
  const label = opts.label ?? `E2E Window ${uniq()}`;
  const capacity = opts.capacity ?? 20;

  await e2eDb.$executeRaw`
    INSERT INTO test_pickup_windows (service_date, start_time, location, label, capacity)
    VALUES (${serviceDate}, ${startTime}, ${location}, ${label}, ${capacity})
  `;

  return { id: pickupWindowId(serviceDate, startTime, location), label, startTime, location, serviceDate, capacity };
}

/** Live "booked" count for a window — replaces re-reading
 * `PickupSlot.bookedCount`. */
export async function countBookedOrders(
  serviceDate: Date,
  startTime: string,
  location: string,
): Promise<number> {
  return e2eDb.order.count({
    where: {
      pickupServiceDate: serviceDate,
      pickupStartTime: startTime,
      pickupLocation: location,
      seatReleasedAt: null,
    },
  });
}

/** Simulates a window already at capacity by directly filling it with
 * `count` minimal order+orderItem rows (bypassing checkout) — replaces the
 * old direct `pickupSlot.update({ data: { bookedCount } })`. Each fake order
 * needs a real product row to satisfy the order_items FK. */
export async function fillWindow(
  window: { serviceDate: Date; startTime: string; location: string },
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const product = await seedProduct({ priceCents: 100, stockQty: count });
  for (let i = 0; i < count; i++) {
    const id = uniq();
    await e2eDb.order.create({
      data: {
        orderNumber: `LL-FILL${id}`,
        pickupCode: id.slice(0, 4).toUpperCase(),
        studentName: "Fill Student",
        email: `fill-${id}@school.ca`,
        phone: "604-555-0100",
        pickupLabel: "Fill",
        pickupStartTime: window.startTime,
        pickupLocation: window.location,
        pickupServiceDate: window.serviceDate,
        paymentMethod: "CASH_AT_PICKUP",
        status: "RESERVED",
        subtotalCents: 100,
        taxCents: 0,
        totalCents: 100,
        items: {
          create: [
            {
              productId: product.id,
              qty: 1,
              nameSnapshot: product.name,
              unitPriceCents: 100,
              raritySnapshot: product.rarity,
              allergensSnapshot: product.allergens,
            },
          ],
        },
      },
    });
  }
}

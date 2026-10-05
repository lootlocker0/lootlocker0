import { db } from "@/lib/db";
import { pickupWindowId, type PickupWindow } from "@/lib/pickup-windows";

/**
 * Test-only pickup-window registry — inert in production.
 *
 * The real template (lib/pickup-windows.ts) is fixed: four windows, fixed
 * times, fixed capacities. Production has no reason to want anything else.
 * The test suite does: tests/concurrency/* and tests/e2e/* each need their
 * OWN isolated window (a unique location string, an arbitrary capacity, a
 * precise "starts in N minutes") so that one test's bookings never leak into
 * another's capacity/race assertions — exactly what a freely-insertable
 * `PickupSlot` row used to give them.
 *
 * `QA_ALLOW_TEST_WINDOWS=1` is set ONLY by the test harness's spawned-server
 * env (tests/setup/env.ts, tests/e2e/setup/env.ts, tests/stripe-real/env.ts)
 * — never by a production deployment. With it unset, every function here is
 * a no-op before it touches the database. `test_pickup_windows` is NOT a
 * production table: it is not in prisma/schema.prisma or any
 * prisma/migrations/* file, and exists only in a test database, created by
 * each suite's own prepareSchema(). Capacity enforcement itself is
 * unaffected either way — book_pickup_window() only ever counts live
 * `orders` rows; this registry exists purely to tell checkout/slots what
 * capacity and label a test window declares, the same job
 * PICKUP_WINDOW_TEMPLATE does for the real four.
 */
const ENABLED = process.env.QA_ALLOW_TEST_WINDOWS === "1";

export async function listTestWindows(): Promise<PickupWindow[]> {
  if (!ENABLED) return [];
  const rows = await db.$queryRaw<
    { service_date: Date; start_time: string; location: string; label: string; capacity: number }[]
  >`SELECT service_date, start_time, location, label, capacity FROM test_pickup_windows`;
  return rows.map((r) => ({
    id: pickupWindowId(r.service_date, r.start_time, r.location),
    label: r.label,
    startTime: r.start_time,
    location: r.location,
    serviceDate: r.service_date,
    capacity: r.capacity,
  }));
}

export async function findTestWindow(id: string): Promise<PickupWindow | null> {
  if (!ENABLED) return null;
  const windows = await listTestWindows();
  return windows.find((w) => w.id === id) ?? null;
}

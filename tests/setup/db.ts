import { execSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { TEST_DATABASE_URL } from "./env";

/**
 * Real Postgres. Not SQLite, not a mock (qa.md §1).
 *
 * Prisma 7 removed the `datasources` constructor option that qa.md's example
 * uses; the driver adapter is the only way to point a client at a URL now
 * (docs/HANDOFF.md §2).
 */
export const testDb: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: TEST_DATABASE_URL,
    // `setupFiles` run per file inside one shared fork, so there is no safe
    // place to `$disconnect()` (doing it in an afterAll closes the pool the
    // next file still needs). Letting idle sockets stop holding the event loop
    // open is what stops the run from hanging for the full teardown timeout.
    allowExitOnIdle: true,
    idleTimeoutMillis: 1_000,
  }),
});

/**
 * Idempotent schema prep. Runs once per suite from the vitest globalSetup, not
 * per file — `migrate deploy` on an up-to-date database is a no-op and
 * `manual_constraints.sql` is written to be re-runnable.
 *
 * The check constraints and the two SQL functions are the whole point: without
 * `manual_constraints.sql` there is no `book_slot()`, no `reserve_stock()`, and
 * no `booked_within_capacity` backstop, so every concurrency test in this suite
 * would pass against a database that cannot actually enforce anything.
 */
export function prepareSchema(): void {
  const env = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    DIRECT_URL: TEST_DATABASE_URL,
  };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  execSync(
    `psql "${TEST_DATABASE_URL}" -v ON_ERROR_STOP=1 -f prisma/migrations/manual_constraints.sql`,
    { env, stdio: "pipe" },
  );
}

/**
 * `settings` is deliberately NOT truncated and never written by this suite.
 * `lib/settings.ts` caches for 60 seconds per process (HANDOFF §21,
 * cross-cutting), so a test that writes a setting and immediately calls a route
 * is unreliable by construction. Leaving the table empty means every route
 * reads the documented defaults — cap 1500, cutoff 45 min, tax 0 bps,
 * TTL 15 min — and they cannot drift mid-run.
 */
export async function resetDb(): Promise<void> {
  // `users` cascades to `account_sessions` (its FK's own ON DELETE has no
  // bearing on TRUNCATE ... CASCADE, which always follows the FK graph).
  // `oauth_states` has no FK to `users` and is left alone deliberately: no
  // test in this suite exercises the Google OAuth token exchange (it needs
  // real Google credentials this harness does not have), so nothing ever
  // writes a row there.
  await testDb.$executeRawUnsafe(
    `TRUNCATE order_items, orders, webhook_events, products, pickup_slots, users RESTART IDENTITY CASCADE`,
  );
}

export async function teardownDb(): Promise<void> {
  await testDb.$disconnect();
}

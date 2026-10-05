/**
 * Single source of truth for the environment the code under test runs in.
 *
 * Imported by the vitest globalSetup (which spawns the server) and by the test
 * process itself, so the two can never drift — a mismatched
 * `ORDER_SESSION_SECRET` between the server and the test process produces
 * cookies that never verify, which looks exactly like a logic bug in the route
 * (docs/HANDOFF.md §28).
 *
 * NOTE ON THE DATABASE. qa.md §1 spins up `@testcontainers/postgresql`.
 * Docker-in-docker does not work in this sandbox (the daemon cannot start under
 * the restricted privileges available here), so this points at a real system
 * Postgres and a dedicated `looplockers_test` database instead. Same idempotent
 * `migrate deploy` + `manual_constraints.sql` + TRUNCATE-per-test pattern; the
 * requirement that actually matters — real Postgres, real row locks, real
 * READ COMMITTED semantics — is unchanged. It is NOT SQLite and it is NOT a
 * mock, because every bug worth finding here lives in transaction behaviour.
 */

export const TEST_DATABASE_URL =
  process.env.QA_DATABASE_URL ??
  "postgresql://looplockers:looplockers_dev@localhost:5432/looplockers_test?sslmode=disable";

/** The dev server the suite drives over real HTTP. */
export const TEST_PORT = Number(process.env.QA_PORT ?? 3111);
export const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

/** Local HMAC only. No Stripe account is involved anywhere in this suite. */
export const STRIPE_WEBHOOK_SECRET = "whsec_qa_local_testing_secret";
export const CRON_SECRET = "qa-cron-secret-value";
export const ORDER_SESSION_SECRET = "qa-order-session-secret-value";

/**
 * Rate limiting is off for the concurrency suite by default (HANDOFF §19: "50
 * simultaneous checkouts from one IP are the test, not the abuse").
 * `QA_RATE_LIMIT=on` starts the server in `memory` mode instead, which is what
 * `npm run test:ratelimit` uses to prove the 429 branch actually executes.
 */
export const RATE_LIMIT_ON = process.env.QA_RATE_LIMIT === "on";

/**
 * Deliberately NOT UTC. HANDOFF §17: a UTC-only cutoff test passes against the
 * server-local `setHours` bug this replaced. Tokyo is on the wrong calendar day
 * relative to Vancouver for most of the UTC day, so a timezone regression in
 * `lib/timezone.ts` shows up here instead of in production.
 */
export const SERVER_TZ = process.env.QA_TZ ?? "Asia/Tokyo";

export function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "development",
    TZ: SERVER_TZ,
    DATABASE_URL: TEST_DATABASE_URL,
    DIRECT_URL: TEST_DATABASE_URL,
    // Lets seedSlot() (tests/helpers.ts) declare an isolated, arbitrary-
    // capacity test window the real checkout/slots routes will honor — see
    // lib/pickup-windows-test.ts. Never set in production.
    QA_ALLOW_TEST_WINDOWS: "1",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_placeholder",
    CRON_SECRET,
    ORDER_SESSION_SECRET,
    RESEND_API_KEY: "re_placeholder",
    NEXT_PUBLIC_SITE_URL: BASE_URL,
    ...(RATE_LIMIT_ON
      ? { RATE_LIMIT_DISABLED: "" }
      : { RATE_LIMIT_DISABLED: "1" }),
    // Never let a stray Upstash config in the ambient environment turn the
    // limiter into a network call.
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
  };
}

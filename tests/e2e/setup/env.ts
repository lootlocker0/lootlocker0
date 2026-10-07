/**
 * Environment for the browser-driven half of the suite.
 *
 * Deliberately its OWN port and its OWN database, separate from the vitest
 * harness (`tests/setup/env.ts`, port 3111, `looplockers_test`). The two are
 * routinely run back-to-back, and vitest's per-test `TRUNCATE ... CASCADE`
 * would delete the catalog a Playwright spec is mid-assertion on — a failure
 * that reads exactly like a product bug.
 *
 * NODE_ENV stays `development` for the same three reasons `tests/setup/server.ts`
 * documents (docs/HANDOFF.md §28): a production build marks the order-receipt
 * cookie `Secure`, which a browser silently drops over plain http — every
 * confirmation-page read would then 404 for an environmental reason. The
 * production bundle IS still built and scanned, separately, by
 * `tests/leaks/bundle.test.ts`.
 */

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3210);

/**
 * `localhost`, NOT `127.0.0.1`, and this is load-bearing rather than cosmetic.
 *
 * Next 16's dev server runs `blockCrossSiteDEV()` over the WebSocket upgrade
 * for `/_next/hmr` (`server/lib/router-server.js`). Reached on `127.0.0.1`
 * while the server's own hostname is `localhost`, the guard treats the origin
 * as cross-site and destroys the socket without a response — the browser
 * reports `ERR_INVALID_HTTP_RESPONSE` during the handshake.
 *
 * That would be harmless if it only cost hot reload. It does not: Next's dev
 * client bootstrap AWAITS the HMR connection before calling `hydrateRoot`. A
 * socket that never connects means a page that never hydrates. Every button on
 * the site renders, is visible, is enabled, and does nothing — "Add" never adds,
 * the staff sign-in form never posts — and none of it produces a console error
 * or a failed request. A suite pointed at `127.0.0.1` therefore fails every
 * interactive assertion while every static assertion passes, which reads
 * exactly like a broken frontend.
 *
 * The vitest harness (`tests/setup/env.ts`) is unaffected and correctly stays
 * on `127.0.0.1`: it drives routes with `fetch`, which never opens a socket.
 */
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://looplockers:looplockers_dev@localhost:5432/looplockers_e2e?sslmode=disable";

/** Local HMAC only. No Stripe account is involved anywhere (HANDOFF §20). */
export const STRIPE_WEBHOOK_SECRET = "whsec_e2e_local_testing_secret";
export const CRON_SECRET = "e2e-cron-secret-value";
export const ORDER_SESSION_SECRET = "e2e-order-session-secret-value";

export const ADMIN_PASSCODE = "e2e-staff-passcode";
export const ADMIN_SESSION_SECRET = "e2e-admin-session-secret";

/**
 * Must differ from ADMIN_PASSCODE — API-CONTRACT §6b treats the separation as
 * the contract, and a test environment that shares them cannot detect a
 * regression that merges the two credentials.
 */
export const INVENTORY_PASSCODE = "e2e-inventory-passcode";
export const INVENTORY_SESSION_SECRET = "e2e-inventory-session-secret";

/**
 * Same non-UTC reasoning as the vitest harness (HANDOFF §17): the server runs
 * on Asia/Tokyo while the browser context runs on Pacific/Kiritimati, so any
 * cutoff or service-date arithmetic that reads a wall clock instead of
 * `lib/timezone.ts` disagrees across a calendar-day boundary here rather than
 * in production.
 */
export const SERVER_TZ = process.env.E2E_TZ ?? "Asia/Tokyo";
export const BROWSER_TZ = process.env.E2E_BROWSER_TZ ?? "Pacific/Kiritimati";

/**
 * Playwright cannot download its own browser build in this sandbox — the
 * egress policy blocks `cdn.playwright.dev` (403 at the proxy). A stock
 * Chromium snapshot from `storage.googleapis.com` is used instead and driven
 * over CDP exactly the same way. Override with `PW_CHROMIUM_PATH` anywhere a
 * normal `npx playwright install chromium` works; leave it unset in CI, where
 * the config falls back to Playwright's own bundled browser.
 */
export const CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH;

/** Playwright's `webServer.env` is `Record<string, string>` — no undefined. */
export function serverEnv(): Record<string, string> {
  const raw: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    TZ: SERVER_TZ,
    DATABASE_URL: E2E_DATABASE_URL,
    DIRECT_URL: E2E_DATABASE_URL,
    // Lets seedSlot() (tests/e2e/setup/db.ts) declare an isolated,
    // arbitrary-capacity test window — see lib/pickup-windows-test.ts.
    // Never set in production.
    QA_ALLOW_TEST_WINDOWS: "1",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_placeholder",
    CRON_SECRET,
    ORDER_SESSION_SECRET,
    ADMIN_PASSCODE,
    ADMIN_SESSION_SECRET,
    INVENTORY_PASSCODE,
    INVENTORY_SESSION_SECRET,
    RESEND_API_KEY: "re_placeholder",
    NEXT_PUBLIC_SITE_URL: E2E_BASE_URL,
    // A browser-driven suite hits `/api/checkout` a handful of times per spec
    // from one address; the limiter is not what these specs are testing.
    // `tests/ratelimit/**` owns that branch.
    RATE_LIMIT_DISABLED: "1",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
  };

  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

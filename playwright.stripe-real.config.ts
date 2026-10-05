import { defineConfig, devices } from "@playwright/test";
import {
  STRIPE_REAL_BASE_URL,
  STRIPE_REAL_PORT,
  CHROMIUM_PATH,
  serverEnv,
} from "./tests/stripe-real/env";
import { prepareSchema } from "./tests/stripe-real/db";

// Same reasoning as playwright.config.ts: migrations run at config-load
// time, before Playwright's webServer readiness probe can hit an
// unmigrated database and die with an opaque 180s timeout.
prepareSchema();

/**
 * Real-Stripe-test-mode checkout suite. Owner: qa, run manually via
 * `.github/workflows/stripe-real-test.yml` — never part of the ordinary
 * `ci.yml` run, because it requires real Stripe TEST MODE secrets
 * (tests/stripe-real/env.ts refuses to start without them, and refuses to
 * start with anything that isn't `sk_test_`/`pk_test_`-prefixed).
 *
 * `workers: 1`, no retries: a retried test that already charged a test
 * card and already received the real webhook would re-submit a form IN A
 * NEW ORDER rather than replaying a check — these tests are written to
 * each create exactly one real Stripe test-mode object, not to be safely
 * re-run mid-assertion.
 */
export default defineConfig({
  testDir: "./tests/stripe-real",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 90_000, // real network round trips to Stripe, not the local simulator
  expect: { timeout: 15_000 },

  use: {
    baseURL: STRIPE_REAL_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    launchOptions: {
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      args: ["--no-sandbox"],
    },
  },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
  ],

  globalSetup: "./tests/stripe-real/global-setup.ts",

  webServer: {
    command: `npx next dev --port ${STRIPE_REAL_PORT}`,
    url: `${STRIPE_REAL_BASE_URL}/api/products`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: serverEnv(),
  },
});

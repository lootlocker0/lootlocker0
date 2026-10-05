import { defineConfig, devices } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_PORT,
  BROWSER_TZ,
  CHROMIUM_PATH,
  serverEnv,
} from "./tests/e2e/setup/env";
import { prepareSchema } from "./tests/e2e/setup/db";
import { resolveProjectDir } from "./tests/setup/project-dir";

/**
 * Migrations run HERE, at config-load time, and not in `globalSetup`.
 *
 * Playwright starts `webServer` before `globalSetup` in this version, and the
 * readiness probe is `GET /api/products` — which is a database read. Against an
 * unmigrated database that 500s forever and the run dies with a bare
 * "Timed out waiting 180000ms from config.webServer", 180 seconds later, with
 * the actual cause (`public.products does not exist`) buried in the server log.
 * The config module is the only hook that is guaranteed to run first.
 * `migrate deploy` on an up-to-date database is a no-op and
 * `manual_constraints.sql` is written to be re-runnable, so this is cheap.
 */
prepareSchema();

/**
 * "." unless `E2E_PROJECT_DIR` is set, in which case an isolated mirror of the
 * working tree so this suite does not fight another agent's `npm run dev` for
 * Next 16's one-dev-server-per-project lock. See `tests/e2e/setup/project-dir.ts`.
 */
const PROJECT_DIR = resolveProjectDir();

/**
 * Browser-driven half of the QA suite. Owner: qa (CLAUDE.md ownership map).
 *
 * Three deliberate choices, each of which a "simpler" config would get wrong:
 *
 * 1. **`next dev`, not `next build && next start`.** `NODE_ENV=production`
 *    marks the per-order receipt cookie `Secure`; a browser silently drops a
 *    `Secure` cookie over plain http, so every confirmation-page read would 404
 *    for an environmental reason that reads exactly like a broken route
 *    (docs/HANDOFF.md §28). The production bundle is still built and scanned —
 *    by `tests/leaks/bundle.test.ts`, which is where that belongs.
 *
 * 2. **Its own port and its own database.** `tests/setup/env.ts` owns 3111 and
 *    `looplockers_test`, and TRUNCATEs it between tests. Sharing would mean a
 *    vitest run deleting the catalog a spec is mid-assertion on.
 *
 * 3. **`workers: 1`.** These specs place real orders against one shared
 *    catalog and one shared pick list; the admin specs in particular assert on
 *    "this order appears in today's list". Parallel workers make that
 *    order-dependent. Concurrency is proven properly in
 *    `tests/concurrency/**` with real simultaneous HTTP, not by racing
 *    browsers.
 */

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/setup/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["list"], ["allure-playwright", { resultsDir: "allure-results", suiteTitle: false }]]
    : [["list"], ["allure-playwright", { resultsDir: "allure-results", suiteTitle: false }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Deliberately a different zone from the server's Asia/Tokyo
    // (docs/HANDOFF.md §17): a service date or cutoff rendered from the
    // browser's wall clock instead of the payload's UTC-anchored value drifts
    // a calendar day here rather than in production.
    timezoneId: BROWSER_TZ,
    locale: "en-CA",
    launchOptions: {
      // Playwright's own browser download host is blocked by this sandbox's
      // egress policy, so a stock Chromium snapshot is used when
      // PW_CHROMIUM_PATH points at one. Unset (CI, a normal dev machine),
      // Playwright uses its bundled build.
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      args: ["--no-sandbox"],
    },
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      // A phone is what a student actually checks out on. `isMobile` +
      // `hasTouch` are the parts that matter: they change hit-testing and
      // hover behaviour, which is where a hover-only allergen tooltip or a
      // 40px-tall tap target would show up.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],

  webServer: {
    command: `npx next dev ${PROJECT_DIR} --port ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/products`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: serverEnv(),
  },
});

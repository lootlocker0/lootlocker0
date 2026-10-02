import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import AllureReporter from "allure-vitest/reporter";

/**
 * Production smoke suite — a SEPARATE config from vitest.config.ts on
 * purpose. The default config's `globalSetup` spins up a local Postgres and
 * a local `next dev` server (`tests/setup/global-setup.ts`) and every other
 * suite in this repo asserts against ITS database. This suite does neither:
 * it makes real HTTPS requests against the live deployed site
 * (`tests/smoke/env.ts`'s `PROD_SITE_URL`) and is read-only by construction
 * — see the comment at the top of `tests/smoke/production.test.ts` for why
 * that is a hard rule here and not just a convention.
 *
 * `tests/smoke/staging-payment.test.ts` is explicitly excluded below: it
 * writes real orders and moves a simulated payment, which is only safe
 * against a disposable staging database (vitest.staging-payment.config.ts),
 * never swept up into this read-only production run by a loose glob.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/smoke/**/*.test.ts"],
    exclude: ["tests/smoke/staging-payment.test.ts", "**/node_modules/**"],
    testTimeout: 30_000,
    reporters: [
      "default",
      new AllureReporter({
        resultsDir: "allure-results",
        globalLabels: [{ name: "suite", value: "smoke-production" }],
      }),
    ],
  },
});

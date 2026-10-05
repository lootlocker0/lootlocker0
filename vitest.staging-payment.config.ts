import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import AllureReporter from "allure-vitest/reporter";

/**
 * Staging payment-processing smoke suite. See tests/smoke/staging-env.ts for
 * why this is deliberately separate from vitest.smoke.config.ts's read-only
 * production suite — this one writes real orders and moves a simulated
 * payment through a real checkout+webhook+refund cycle, which is only safe
 * against a disposable staging database, never production.
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
    include: ["tests/smoke/staging-payment.test.ts"],
    testTimeout: 30_000,
    reporters: [
      "default",
      new AllureReporter({
        resultsDir: "allure-results",
        globalLabels: [{ name: "suite", value: "smoke-staging-payment" }],
      }),
    ],
  },
});

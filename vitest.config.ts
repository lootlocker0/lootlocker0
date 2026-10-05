import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import AllureReporter from "allure-vitest/reporter";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // `tests/e2e/**` is Playwright's (`playwright.config.ts`), and vitest's
    // default `include` of `**/*.spec.ts` would otherwise pick those files up
    // and fail on `import { test } from "@playwright/test"` — a red suite that
    // says nothing about the product. Run them with `npm run test:e2e`.
    exclude: ["**/node_modules/**", "**/.git/**", "**/.next/**", "tests/e2e/**"],
    globalSetup: ["tests/setup/global-setup.ts"],
    // The test process and the server under test run in two DIFFERENT non-UTC
    // zones on purpose (the server gets Asia/Tokyo — tests/setup/env.ts).
    // Vancouver is UTC-7/-8, Tokyo is +9, Kiritimati is +14: for most of the UTC
    // day all three are on different calendar days. Any cutoff or spend-cap
    // arithmetic that reads a wall clock from `TZ` instead of `lib/timezone.ts`
    // (HANDOFF §3, §13, §17) cannot survive that, whereas a UTC-only suite would
    // pass against the original bug.
    env: {
      TZ: "Pacific/Kiritimati",
      // Must match the server's (tests/setup/env.ts). With it unset,
      // lib/order-session.ts falls back to a random per-process key, so a token
      // signed in the test process would never verify in the server process —
      // an environment bug that looks exactly like a broken route (HANDOFF §28).
      ORDER_SESSION_SECRET: "qa-order-session-secret-value",
    },
    setupFiles: ["tests/setup/global.ts"],
    // Allure results for `npm run test:unit` / `test:api` land in the same
    // `allure-results/` directory Playwright's e2e run writes to (result files
    // are UUID-named, so the two never collide), tagged by which npm script
    // ran them (`npm_lifecycle_event`) so the combined report can tell a unit
    // test apart from an API test with the same describe/it name.
    reporters: [
      "default",
      new AllureReporter({
        resultsDir: "allure-results",
        globalLabels: [{ name: "suite", value: process.env.npm_lifecycle_event ?? "vitest" }],
      }),
    ],
    // Concurrency cases fire 60 real HTTP requests at a `next dev` server that
    // compiles routes on first hit. 30s is not enough for the first test in a
    // cold run.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    teardownTimeout: 30_000,
    // Concurrency tests share one database. Parallel files corrupt each other:
    // a TRUNCATE in one file deletes the fixtures another file is mid-assertion
    // on, and the failure looks like a race in the product code.
    //
    // qa.md's `poolOptions.forks.singleFork` was removed in Vitest 4; the
    // equivalent is one worker, no file parallelism, no per-file isolation —
    // i.e. every test file shares one process and one connection pool.
    pool: "forks",
    maxWorkers: 1,
    isolate: false,
    fileParallelism: false,
    // Within a file too. `describe.concurrent` would mean two tests sharing one
    // TRUNCATE'd database.
    sequence: { concurrent: false },
  },
});

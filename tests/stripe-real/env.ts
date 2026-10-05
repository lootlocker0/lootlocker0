/**
 * Environment for the real-Stripe-test-mode checkout suite.
 *
 * Deliberately separate from `tests/e2e/setup/env.ts`: that suite's whole
 * point is running with NO Stripe account (`sk_test_placeholder`, HANDOFF
 * §20). This one's whole point is the opposite — a real Stripe TEST MODE
 * account, real `PaymentElement`, real test card numbers. Keeping them
 * apart means the ordinary CI run (`ci.yml`) never needs a Stripe secret at
 * all, and this suite never silently degrades into the simulator.
 *
 * Own port (3220) and own database (`looplockers_stripe_real`), same
 * reasoning as the e2e suite: nothing here may share state with any other
 * suite's run.
 */

export const STRIPE_REAL_PORT = Number(process.env.STRIPE_REAL_PORT ?? 3220);
export const STRIPE_REAL_BASE_URL = `http://localhost:${STRIPE_REAL_PORT}`;

export const STRIPE_REAL_DATABASE_URL =
  process.env.STRIPE_REAL_DATABASE_URL ??
  "postgresql://looplockers:looplockers_dev@localhost:5432/looplockers_stripe_real?sslmode=disable";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. This suite makes real calls against a real Stripe ` +
        "test-mode account and refuses to guess or fall back to the simulator " +
        "— set it explicitly (see .github/workflows/stripe-real-test.yml).",
    );
  }
  return v;
}

/// Read once at import time, not lazily — a missing or malformed key must
/// fail the whole run immediately, not three minutes into a flaky-looking
/// test failure.
export const STRIPE_TEST_SECRET_KEY = required("STRIPE_TEST_SECRET_KEY");
export const STRIPE_TEST_PUBLISHABLE_KEY = required("STRIPE_TEST_PUBLISHABLE_KEY");
export const STRIPE_TEST_WEBHOOK_SECRET = required("STRIPE_TEST_WEBHOOK_SECRET");

// THE SAFETY GUARD. A real card gets charged real money the instant a
// `sk_live_...` key reaches `stripe.confirmPayment` with a real test card
// number — Stripe does not refuse a "test" card in live mode the way a
// human might expect, it just fails differently. Refuse to even construct
// the server environment if either key does not look like Stripe's own
// test-mode prefix, before any server starts and before any browser opens.
for (const [name, value] of [
  ["STRIPE_TEST_SECRET_KEY", STRIPE_TEST_SECRET_KEY],
  ["STRIPE_TEST_PUBLISHABLE_KEY", STRIPE_TEST_PUBLISHABLE_KEY],
] as const) {
  if (!/^(sk|pk)_test_/.test(value)) {
    throw new Error(
      `${name} does not look like a Stripe TEST-mode key (expected it to start ` +
        `with sk_test_ or pk_test_). Refusing to run — this suite must never ` +
        "touch a live key.",
    );
  }
}

export const CRON_SECRET = "stripe-real-cron-secret";
export const ORDER_SESSION_SECRET = "stripe-real-order-session-secret";
export const ADMIN_PASSCODE = "stripe-real-staff-passcode";
export const ADMIN_SESSION_SECRET = "stripe-real-admin-session-secret";

export const CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH;

/** Playwright's `webServer.env` is `Record<string, string>` — no undefined. */
export function serverEnv(): Record<string, string> {
  const raw: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development", // same Secure-cookie-over-http reasoning as tests/e2e/setup/env.ts
    DATABASE_URL: STRIPE_REAL_DATABASE_URL,
    DIRECT_URL: STRIPE_REAL_DATABASE_URL,
    STRIPE_SECRET_KEY: STRIPE_TEST_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: STRIPE_TEST_WEBHOOK_SECRET,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: STRIPE_TEST_PUBLISHABLE_KEY,
    CRON_SECRET,
    ORDER_SESSION_SECRET,
    ADMIN_PASSCODE,
    ADMIN_SESSION_SECRET,
    RESEND_API_KEY: "re_placeholder",
    NEXT_PUBLIC_SITE_URL: STRIPE_REAL_BASE_URL,
    RATE_LIMIT_DISABLED: "1",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
  };
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

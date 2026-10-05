/**
 * Single source of truth for the STAGING deployment this suite hits.
 *
 * Deliberately named `STAGING_*`, never reusing `tests/smoke/env.ts`'s
 * `PROD_SITE_URL` or any of its sibling secrets. As of this writing,
 * `vars.PROD_SITE_URL` points at the only deployment that actually exists in
 * a meaningfully separate way — Vercel's Preview deployments for this
 * project currently share the SAME `DATABASE_URL` and the SAME
 * `STRIPE_SECRET_KEY` as Production (checked directly against the Vercel
 * project's env var list: every sensitive var is scoped to
 * `target: ["production", "preview"]`, one shared value, not a
 * preview-only value). Pointing this suite at a ".vercel.app" preview URL
 * today would therefore write to the real production database and move
 * money through the real Stripe account — exactly the risk this suite
 * exists to avoid.
 *
 * So: this suite refuses to run until `STAGING_SITE_URL` is explicitly set
 * to a deployment that has its own disposable database and its own
 * `sk_test_...` Stripe key — separate Vercel env var values scoped to
 * `preview` only (or a dedicated staging project), not an inherited
 * production value. That is infrastructure the project owner has to set
 * up and point this at; this file will not guess a `.vercel.app` URL.
 */
export const STAGING_SITE_URL = (() => {
  const url = process.env.STAGING_SITE_URL;
  if (!url) {
    throw new Error(
      "STAGING_SITE_URL is not set. This suite places real orders and moves " +
        "a simulated payment through a real deployment's checkout+webhook " +
        "path, so it refuses to guess which deployment that is. Point it at " +
        "a staging deployment with its OWN disposable database and its own " +
        "sk_test_ Stripe key — not a Vercel preview URL that still inherits " +
        "production's DATABASE_URL/STRIPE_SECRET_KEY, which is this " +
        "project's current state as of the comment at the top of this file.",
    );
  }
  return url.replace(/\/+$/, "");
})();

export const STAGING_STRIPE_WEBHOOK_SECRET = (() => {
  const v = process.env.STAGING_STRIPE_WEBHOOK_SECRET;
  if (!v) throw new Error("STAGING_STRIPE_WEBHOOK_SECRET is not set.");
  return v;
})();

export const STAGING_ADMIN_PASSCODE = (() => {
  const v = process.env.STAGING_ADMIN_PASSCODE;
  if (!v) throw new Error("STAGING_ADMIN_PASSCODE is not set.");
  return v;
})();

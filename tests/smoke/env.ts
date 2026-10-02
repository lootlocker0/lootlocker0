/**
 * Single source of truth for which site this suite hits.
 *
 * `PROD_SITE_URL` matches the name `.github/workflows/sweep-cron.yml`
 * already uses (`vars.PROD_SITE_URL`) for the same real deployment — reusing
 * it here means one repository variable, not a second one that can drift
 * from the first. No default/fallback to a guessed domain: pointing a
 * "production smoke test" at the wrong host by a typo-safe default is worse
 * than refusing to run.
 */
export const PROD_SITE_URL = (() => {
  const url = process.env.PROD_SITE_URL;
  if (!url) {
    throw new Error(
      "PROD_SITE_URL is not set. This suite makes real requests against the " +
        "live deployed site and refuses to guess which one — set it to the " +
        "production origin (e.g. https://lootlockers.shop), with no trailing slash.",
    );
  }
  return url.replace(/\/+$/, "");
})();

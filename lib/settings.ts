import { db } from "./db";

const DEFAULTS = {
  daily_spend_cap_cents: 1500,
  order_cutoff_minutes: 45,
  tax_rate_bps: 0,
  pending_order_ttl_minutes: 15,
  // Reward points earned per whole dollar of subtotalCents on a paid order
  // (card or cash). Matches the rate already shown in shipped UI copy —
  // changing this does not retroactively re-price past awards or reversals.
  reward_points_per_dollar: 10,
} as const;

type Key = keyof typeof DEFAULTS;

let cache: Partial<Record<Key, number>> = {};
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getSetting(key: Key): Promise<number> {
  if (Date.now() - cachedAt > TTL_MS) {
    const rows = await db.setting.findMany();
    cache = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    cachedAt = Date.now();
  }
  const v = cache[key];
  return Number.isFinite(v) ? (v as number) : DEFAULTS[key];
}

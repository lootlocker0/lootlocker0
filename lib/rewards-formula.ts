/** Pure. Zero imports, on purpose — same reason lib/money.ts has none: a
 *  formula worth unit-testing without a database has to be importable
 *  without one. `lib/rewards.ts` re-exports this; import from here directly
 *  (as tests/unit/rewards.test.ts does) whenever you want the formula alone.
 *
 *  `subtotalCents`, not `totalCents` — points are earned pre-tax. */
export function pointsForSubtotal(
  subtotalCents: number,
  pointsPerDollar: number,
): number {
  return Math.floor(subtotalCents / 100) * pointsPerDollar;
}

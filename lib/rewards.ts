import type { Prisma } from "@prisma/client";
import { getSetting } from "./settings";

/** Reward points earn/reverse. This module is the only place
 *  `reward_points` is ever touched — always via `adjust_reward_points()`
 *  (prisma/migrations/manual_constraints.sql), never a raw Prisma
 *  `increment`/`decrement`, so the floor at zero is enforced by the database
 *  rather than by caller discipline.
 *
 *  Award and reversal must both run inside the SAME transaction as the write
 *  that changes `Order.paidAt`/`Order.status` — that's why every function
 *  here takes a `Prisma.TransactionClient`, never `db` directly. A crash
 *  between "flip to PAID" and "award points" must roll back both, not leave
 *  one without the other.
 *
 *  The formula itself lives in `lib/rewards-formula.ts` (re-exported below)
 *  so it stays importable with no database at all — this file pulls in
 *  `lib/settings.ts` -> `lib/db.ts`, which throws without `DATABASE_URL`,
 *  and a pure-function unit test must not need one.
 */
export { pointsForSubtotal } from "./rewards-formula";

/** Points earned per whole dollar of `subtotalCents` — tunable via the
 *  `reward_points_per_dollar` setting (lib/settings.ts), default 10 to match
 *  the rate already shown in shipped UI copy ("Spend $1.00 → earn 10
 *  points"). Changing the setting is NOT retroactive: an order already paid
 *  keeps the points it was awarded at the old rate, and a later refund
 *  reverses points computed at whatever rate is current when the refund
 *  happens, not the rate in effect at award time. This app already accepts
 *  the equivalent drift elsewhere (e.g. changing daily_spend_cap_cents
 *  doesn't re-check past orders); documented here rather than solved. */
export async function getPointsPerDollar(): Promise<number> {
  return getSetting("reward_points_per_dollar");
}

async function adjustRewardPoints(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ points: number | null }[]>`
    SELECT adjust_reward_points(${userId}::text, ${delta}::int) AS points
  `;
  return rows[0]?.points ?? null;
}

/** Award points to a user. `points` must be a positive integer — this is the
 *  award path (webhook `onPaid`, the cash-collection route), always gated by
 *  the caller on the order's `paidAt` having just been set for the first
 *  time, never on `status` alone (a cash order can reach PACKED with
 *  `paidAt` still null). */
export async function awardRewardPoints(
  tx: Prisma.TransactionClient,
  userId: string,
  points: number,
): Promise<void> {
  if (points <= 0) return;
  await adjustRewardPoints(tx, userId, points);
}

/** Reverse points from a user. `points` must be a positive integer (the
 *  amount to remove) — this is the reversal path (webhook `onRefunded`, the
 *  admin refund route), always gated by the caller on the order's `paidAt`
 *  having been set BEFORE the refund write, for the same reason as above.
 *  Floors at zero in the database; never produces a negative balance. */
export async function reverseRewardPoints(
  tx: Prisma.TransactionClient,
  userId: string,
  points: number,
): Promise<void> {
  if (points <= 0) return;
  await adjustRewardPoints(tx, userId, -points);
}

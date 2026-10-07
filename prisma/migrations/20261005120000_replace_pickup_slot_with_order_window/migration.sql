-- Replaces the pre-seeded PickupSlot table with a template-derived design:
-- the four pickup windows now live in code (lib/pickup-windows.ts), and
-- "how many seats are taken" is a live count over `orders` instead of a
-- stored counter. See docs/HANDOFF.md for why (the rolling 7-day seed window
-- silently ran dry in production and nothing re-seeded it).
--
-- Hand-written, not `prisma migrate dev`-generated: adding four NOT NULL
-- columns to a populated `orders` table needs a backfill Prisma cannot
-- invent on its own. This migration adds them nullable, backfills from the
-- still-present `pickup_slots` table, THEN tightens to NOT NULL, in that
-- order, so it is safe to run against a database that already has real
-- order history.

-- ── 1. New columns on `orders`, nullable for now ───────────────────────────

ALTER TABLE "orders"
  ADD COLUMN "pickup_label" TEXT,
  ADD COLUMN "pickup_start_time" TEXT,
  ADD COLUMN "pickup_location" TEXT,
  ADD COLUMN "pickup_service_date" TIMESTAMP(3),
  ADD COLUMN "seat_released_at" TIMESTAMP(3);

-- ── 2. Backfill the snapshot from the row each order's slot_id still points
--      at, while pickup_slots still exists ─────────────────────────────────

UPDATE "orders" o
   SET "pickup_label" = s."label",
       "pickup_start_time" = s."start_time",
       "pickup_location" = s."location",
       "pickup_service_date" = s."service_date"
  FROM "pickup_slots" s
 WHERE o."slot_id" = s."id";

-- ── 3. Backfill seat_released_at ────────────────────────────────────────────
--
-- lib/db/release.ts's releaseOrder() unconditionally decremented
-- booked_count for every CANCELLED/EXPIRED order, so "released" is exactly
-- reconstructable for those two statuses.
--
-- Every pre-migration REFUNDED order is left NULL ("still holds a seat") on
-- purpose. The old schema recorded a refund's seat release only as an
-- ephemeral decrement to a shared counter, never per-order, so whether any
-- given historical REFUNDED order had `releaseSlotSeat: true` checked at the
-- time cannot be reconstructed. NULL can only ever overcount a closed day's
-- seats (invisible — lib/pickup-windows.ts never re-evaluates a past day's
-- availability), whereas guessing "released" could undercount into a future
-- oversell if that exact window were ever somehow revisited. Only the safe
-- direction is automated; the other requires a human with the actual refund
-- records, and is out of scope here.

UPDATE "orders"
   SET "seat_released_at" = COALESCE("updated_at", now())
 WHERE "status" IN ('CANCELLED', 'EXPIRED');

-- ── 4. Tighten the snapshot columns to NOT NULL ─────────────────────────────
--
-- Every order has a slot_id (it was NOT NULL on the old schema), so step 2
-- backfilled 100% of existing rows before this runs. seat_released_at stays
-- nullable forever — null is its live, meaningful "still held" state.

ALTER TABLE "orders"
  ALTER COLUMN "pickup_label" SET NOT NULL,
  ALTER COLUMN "pickup_start_time" SET NOT NULL,
  ALTER COLUMN "pickup_location" SET NOT NULL,
  ALTER COLUMN "pickup_service_date" SET NOT NULL;

-- ── 5. Drop the old slot linkage ────────────────────────────────────────────

DROP INDEX "orders_slot_id_status_idx";
DROP INDEX "orders_slot_id_pickup_code_key";
ALTER TABLE "orders" DROP CONSTRAINT "orders_slot_id_fkey";
ALTER TABLE "orders" DROP COLUMN "slot_id";

-- ── 6. Drop the table itself ────────────────────────────────────────────────

DROP TABLE "pickup_slots";

-- ── 7. New indexes replacing the ones dropped in step 5 ─────────────────────

CREATE UNIQUE INDEX "orders_pickup_service_date_pickup_start_time_pickup_locat_key"
  ON "orders"("pickup_service_date", "pickup_start_time", "pickup_location", "pickup_code");

CREATE INDEX "orders_pickup_service_date_pickup_start_time_pickup_locati_idx"
  ON "orders"("pickup_service_date", "pickup_start_time", "pickup_location");

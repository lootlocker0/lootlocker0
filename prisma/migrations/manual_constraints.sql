-- LootLockers — database-level invariants Prisma cannot express.
--
-- Apply AFTER every `prisma migrate deploy` / `prisma migrate dev`:
--
--     psql "$DATABASE_URL" -f prisma/migrations/manual_constraints.sql
--
-- This file is idempotent. Running it twice, or against a database that
-- already has some of these objects, is a no-op. The qa harness re-runs it on
-- every fresh test container, so it has to stay that way.
--
-- Two kinds of thing live here:
--
--   1. CHECK constraints. Belt to the application's braces. If any code path
--      ever writes stock or capacity directly instead of going through the
--      functions below, the write fails loudly instead of quietly selling
--      snacks that do not exist.
--
--   2. book_slot() and reserve_stock(). The only sanctioned way to move slot
--      capacity and stock (CLAUDE.md §2.4). Both do their check and their
--      write in a single UPDATE ... WHERE statement. That is the whole point:
--      under READ COMMITTED, a concurrent UPDATE re-evaluates the WHERE clause
--      after it acquires the row lock, so the loser of the race sees the
--      winner's value and matches zero rows. An application-level
--      `if (booked < capacity) { update }` reads a stale value outside the
--      lock and loses this race every single time under real load.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CHECK constraints
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- Stock can never go negative. reserve_stock() should make this unreachable;
  -- if it ever fires, something bypassed the function.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_non_negative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT stock_non_negative CHECK (stock_qty >= 0);
  END IF;

  -- Money is non-negative integer cents. A negative price is a free-money bug.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_price_non_negative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT product_price_non_negative CHECK (price_cents >= 0);
  END IF;

  -- Slot bookings: never negative, never past capacity, capacity never negative.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booked_count_non_negative'
  ) THEN
    ALTER TABLE pickup_slots
      ADD CONSTRAINT booked_count_non_negative CHECK (booked_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'slot_capacity_non_negative'
  ) THEN
    ALTER TABLE pickup_slots
      ADD CONSTRAINT slot_capacity_non_negative CHECK (capacity >= 0);
  END IF;

  -- The oversell backstop. book_slot() enforces this too; this makes an
  -- oversell impossible even if someone writes booked_count by hand.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booked_within_capacity'
  ) THEN
    ALTER TABLE pickup_slots
      ADD CONSTRAINT booked_within_capacity CHECK (booked_count <= capacity);
  END IF;

  -- Order money. Non-negative, and the total must actually be the sum of its
  -- parts — an order whose total disagrees with subtotal + tax is either a
  -- rounding bug or tampering, and it is cheaper to reject the INSERT than to
  -- reconcile it against Stripe later.
  -- NOTE FOR TEST FIXTURES: any helper that inserts an order directly must set
  -- subtotal_cents + tax_cents = total_cents.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_amounts_non_negative'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT order_amounts_non_negative
      CHECK (subtotal_cents >= 0 AND tax_cents >= 0 AND total_cents >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_total_consistent'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT order_total_consistent
      CHECK (total_cents = subtotal_cents + tax_cents);
  END IF;

  -- Order lines. A zero or negative quantity is never a legitimate purchase.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_item_qty_positive'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_item_qty_positive CHECK (qty > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_item_price_non_negative'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_item_price_non_negative CHECK (unit_price_cents >= 0);
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Atomic slot booking
-- ─────────────────────────────────────────────────────────────────────────────

-- Claims one seat in a pickup slot. Returns TRUE if the seat was claimed,
-- FALSE if the slot is missing, inactive, or already full.
--
-- Callers must treat FALSE as SLOT_FULL and abort the surrounding transaction.
-- The increment is released by lib/db/release.ts, not by another function here.
CREATE OR REPLACE FUNCTION book_slot(p_slot_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE pickup_slots
     SET booked_count = booked_count + 1,
         updated_at   = now()
   WHERE id = p_slot_id
     AND active = true
     AND booked_count < capacity;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

COMMENT ON FUNCTION book_slot(text) IS
  'Atomically claims one seat in a pickup slot. TRUE = claimed, FALSE = full/inactive/missing. Check and write happen in one UPDATE; never replace with a read-then-write.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Atomic stock reservation
-- ─────────────────────────────────────────────────────────────────────────────

-- Reserves p_qty units of a product. Returns TRUE if reserved, FALSE if the
-- product is missing, inactive, or has insufficient stock.
--
-- Reserving happens BEFORE payment on purpose: an abandoned cart holding stock
-- until its TTL expires is a cheaper failure than charging a student for a
-- snack that is not on the shelf.
CREATE OR REPLACE FUNCTION reserve_stock(p_product_id text, p_qty int)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_rows int;
BEGIN
  -- A non-positive quantity would silently *increase* stock. Refuse it here as
  -- well as in the request validator; this function is reachable from psql.
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN false;
  END IF;

  UPDATE products
     SET stock_qty  = stock_qty - p_qty,
         updated_at = now()
   WHERE id = p_product_id
     AND active = true
     AND stock_qty >= p_qty;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

COMMENT ON FUNCTION reserve_stock(text, int) IS
  'Atomically decrements product stock. TRUE = reserved, FALSE = insufficient/inactive/missing. Check and write happen in one UPDATE; never replace with a read-then-write.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Atomic staff stock adjustment (P4)
-- ─────────────────────────────────────────────────────────────────────────────

-- Applies a RELATIVE change to a product's stock and returns the new quantity,
-- or NULL if nothing was changed (product missing, or the change would take
-- stock below zero).
--
-- Same shape and the same reason as reserve_stock(): the bound check and the
-- write are one UPDATE, so a staff adjustment and a student's checkout landing
-- in the same millisecond compose instead of clobbering each other. An
-- application-level `read stockQty, add delta, write` loses that race and
-- silently un-reserves whatever was reserved in between.
--
-- Two deliberate differences from reserve_stock():
--
--   · No `active = true` filter. Staff must be able to correct the count on a
--     product they have just deactivated — that is exactly when a miscount is
--     discovered — and refusing would leave the number wrong forever.
--   · Signed delta. A negative delta is a write-off (breakage, a miscount, a
--     snack eaten by staff) and is bounded by the same stock_qty >= 0 floor,
--     which is why the check is `stock_qty + p_delta >= 0` and not `>= p_delta`.
--
-- It deliberately CANNOT distinguish "no such product" from "would go
-- negative": both are NULL. The caller re-reads for a human-readable message
-- only, and that read is diagnostic — the decision was already made here.
CREATE OR REPLACE FUNCTION adjust_stock(p_product_id text, p_delta int)
RETURNS int
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_new int;
BEGIN
  -- A zero delta would report success for a write that never happened, which
  -- is a confusing thing to show someone counting a shelf. Rejected at the
  -- request boundary too (adminStockAdjustSchema); this function is reachable
  -- from psql.
  IF p_delta IS NULL OR p_delta = 0 THEN
    RETURN NULL;
  END IF;

  UPDATE products
     SET stock_qty  = stock_qty + p_delta,
         updated_at = now()
   WHERE id = p_product_id
     AND stock_qty + p_delta >= 0
  RETURNING stock_qty INTO v_new;

  -- NULL when the UPDATE matched no row.
  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION adjust_stock(text, int) IS
  'Atomically applies a signed delta to product stock. Returns the new stock_qty, or NULL if the product is missing or the change would go negative. Ignores active. Check and write happen in one UPDATE; never replace with a read-then-write.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Atomic reward-points adjustment
-- ─────────────────────────────────────────────────────────────────────────────

-- Applies a RELATIVE change to a user's reward-points balance and returns the
-- new balance, or NULL if nothing was changed (user missing, or the change
-- would take the balance below zero).
--
-- Same shape and the same reason as adjust_stock(): the bound check and the
-- write are one UPDATE, so an award (webhook onPaid, cash collection) and a
-- reversal (webhook onRefunded, admin refund) landing in the same millisecond
-- compose instead of clobbering each other. This function is called from
-- both directions:
--
--   · Award  (positive delta) — webhook `onPaid`, the cash-collection route.
--     Both gate the call on the order's `paid_at` having just been set for
--     the first time, never on `status` alone (a cash order can reach PACKED
--     with `paid_at` still NULL).
--   · Reversal (negative delta) — webhook `onRefunded`, the admin refund
--     route. Both gate the call on the order's `paid_at` having been set
--     BEFORE the refund write, for the same reason.
--
-- Reward points must never be adjusted via a raw Prisma increment/decrement —
-- always through this function, so the floor at zero is enforced at the
-- database, not by caller discipline.
--
-- It deliberately CANNOT distinguish "no such user" from "would go negative":
-- both are NULL. The caller re-reads for a human-readable message only, and
-- that read is diagnostic — the decision was already made here.
CREATE OR REPLACE FUNCTION adjust_reward_points(p_user_id text, p_delta int)
RETURNS int
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_new int;
BEGIN
  -- A zero delta would report success for a write that never happened.
  IF p_delta IS NULL OR p_delta = 0 THEN
    RETURN NULL;
  END IF;

  UPDATE users
     SET reward_points = reward_points + p_delta,
         updated_at    = now()
   WHERE id = p_user_id
     AND reward_points + p_delta >= 0
  RETURNING reward_points INTO v_new;

  -- NULL when the UPDATE matched no row.
  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION adjust_reward_points(text, int) IS
  'Atomically applies a signed delta to a user''s reward_points. Returns the new balance, or NULL if the user is missing or the change would go negative. Called for both award (positive) and reversal (negative). Check and write happen in one UPDATE; never replace with a read-then-write or a raw Prisma increment/decrement.';

COMMIT;

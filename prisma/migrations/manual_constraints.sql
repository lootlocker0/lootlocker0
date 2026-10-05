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
--   2. book_pickup_window() and reserve_stock(). The only sanctioned way to
--      move pickup-window occupancy and stock (CLAUDE.md §2.4). reserve_stock()
--      does its check and its write in a single UPDATE ... WHERE statement —
--      under READ COMMITTED, a concurrent UPDATE re-evaluates the WHERE clause
--      after it acquires the row lock, so the loser of the race sees the
--      winner's value and matches zero rows. book_pickup_window() has no row
--      to lock (there is no pickup-slot table — see lib/pickup-windows.ts), so
--      it reconstructs the same guarantee with a transaction-scoped advisory
--      lock instead: see §2 below for why that closes the race identically.
--      An application-level `if (booked < capacity) { update }` reads a stale
--      value outside any lock and loses this race every single time under
--      real load.

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

  -- A seat may only ever be released from a status that actually releases
  -- one. Belt-and-braces against a future bug writing seat_released_at on a
  -- still-live order — book_pickup_window()'s live COUNT(*) excludes any
  -- order with seat_released_at set, so a wrongly-released seat is a real
  -- oversell risk, not just a cosmetic inconsistency.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seat_released_only_when_terminal'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT seat_released_only_when_terminal
      CHECK (seat_released_at IS NULL OR status IN ('CANCELLED', 'EXPIRED', 'REFUNDED'));
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
-- 2. Atomic pickup-window booking
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS book_slot(text);

-- Checks whether a pickup window has a free seat, and reserves it for the
-- caller's IN-FLIGHT INSERT if so. There is no pickup_slots row to lock
-- anymore (capacity lives in the application's template, lib/pickup-
-- windows.ts; "booked" is a live count over `orders`, not a stored
-- counter) — so this reconstructs the same atomicity reserve_stock() gets
-- from a single UPDATE ... WHERE, using a transaction-scoped advisory lock
-- instead of a row lock:
--
--   1. pg_advisory_xact_lock serializes every caller racing for the SAME
--      (service_date, start_time, location) behind one key. Postgres queues
--      them and releases the lock only at COMMIT or ROLLBACK.
--   2. Because the lock is held until commit, and a commit is recorded
--      before its advisory lock is released, the NEXT caller's COUNT(*) —
--      a fresh snapshot under READ COMMITTED, taken only after it acquires
--      the lock — is guaranteed to see every seat the previous holder
--      actually kept. This is the exact guarantee the old single UPDATE
--      statement gave book_slot(); there is just no row to hang it on.
--
-- Returns TRUE if the caller may create an order holding this seat, FALSE if
-- the window is already at or over capacity. p_capacity is supplied by the
-- CALLER (from the current template) — this function does not know what a
-- valid window is, only how to serialize and count. The caller's order
-- INSERT must happen inside the SAME transaction as this call, before
-- commit, or the lock's guarantee is void. Release is a plain
-- `UPDATE orders SET seat_released_at = now() WHERE id = ? AND
-- seat_released_at IS NULL` in lib/db/release.ts and the admin refund
-- route — no second function needed, since "give a seat back" is just
-- excluding that order from the next COUNT(*).
CREATE OR REPLACE FUNCTION book_pickup_window(
  p_service_date timestamp,
  p_start_time   text,
  p_location     text,
  p_capacity     int
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_lock_key text;
  v_count    int;
BEGIN
  IF p_capacity IS NULL OR p_capacity < 0 THEN
    RETURN false;
  END IF;

  v_lock_key := p_service_date::text || '|' || p_start_time || '|' || p_location;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  SELECT count(*) INTO v_count
    FROM orders
   WHERE pickup_service_date = p_service_date
     AND pickup_start_time   = p_start_time
     AND pickup_location     = p_location
     AND seat_released_at IS NULL;

  RETURN v_count < p_capacity;
END;
$$;

COMMENT ON FUNCTION book_pickup_window(timestamp, text, text, int) IS
  'Atomically checks whether a pickup window has a free seat, serialized per (service_date, start_time, location) by a transaction-scoped advisory lock. TRUE = caller may insert an order holding this seat, FALSE = full. The caller''s order INSERT must happen inside the SAME transaction, before commit, or the lock''s guarantee is void.';

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

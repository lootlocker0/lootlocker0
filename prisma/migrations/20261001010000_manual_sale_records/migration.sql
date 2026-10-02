ALTER TYPE "StockTransactionType" ADD VALUE 'SALE';

ALTER TABLE "stock_transactions"
ADD COLUMN "sale_total_cents" INTEGER;

ALTER TABLE "stock_transactions"
DROP CONSTRAINT "stock_transactions_purchase_shape";

ALTER TABLE "stock_transactions"
ADD CONSTRAINT "stock_transactions_sale_total_nonnegative"
CHECK ("sale_total_cents" IS NULL OR "sale_total_cents" >= 0);

ALTER TABLE "stock_transactions"
ADD CONSTRAINT "stock_transactions_purchase_shape" CHECK (
  (
    "type"::text = 'PURCHASE'
    AND "qty_delta" > 0
    AND "unit_cost_cents" IS NOT NULL
    AND "sale_total_cents" IS NULL
  )
  OR (
    "type"::text = 'ADJUSTMENT'
    AND "unit_cost_cents" IS NULL
    AND "sale_total_cents" IS NULL
  )
  OR (
    "type"::text = 'SALE'
    AND "qty_delta" < 0
    AND "unit_cost_cents" IS NULL
    AND "sale_total_cents" IS NOT NULL
  )
);
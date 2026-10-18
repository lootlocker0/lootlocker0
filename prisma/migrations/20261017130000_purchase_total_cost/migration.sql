ALTER TABLE "stock_transactions"
ADD COLUMN "total_cost_cents" INTEGER;

ALTER TABLE "stock_transactions"
ADD CONSTRAINT "stock_transactions_total_cost_nonnegative"
CHECK ("total_cost_cents" IS NULL OR "total_cost_cents" >= 0);

ALTER TABLE "stock_transactions"
ADD CONSTRAINT "stock_transactions_total_cost_purchase_only"
CHECK ("total_cost_cents" IS NULL OR "type"::text = 'PURCHASE');

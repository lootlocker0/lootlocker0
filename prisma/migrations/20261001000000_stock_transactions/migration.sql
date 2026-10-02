CREATE TYPE "StockTransactionType" AS ENUM ('PURCHASE', 'ADJUSTMENT');

CREATE TABLE "stock_transactions" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "type" "StockTransactionType" NOT NULL,
    "qty_delta" INTEGER NOT NULL,
    "unit_cost_cents" INTEGER,
    "stock_qty_after" INTEGER NOT NULL,
    "session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_transactions_qty_delta_nonzero" CHECK ("qty_delta" <> 0),
    CONSTRAINT "stock_transactions_cost_nonnegative" CHECK ("unit_cost_cents" IS NULL OR "unit_cost_cents" >= 0),
    CONSTRAINT "stock_transactions_purchase_shape" CHECK (
      ("type" = 'PURCHASE' AND "qty_delta" > 0 AND "unit_cost_cents" IS NOT NULL)
      OR ("type" = 'ADJUSTMENT' AND "unit_cost_cents" IS NULL)
    ),
    CONSTRAINT "stock_transactions_stock_nonnegative" CHECK ("stock_qty_after" >= 0)
);

CREATE INDEX "stock_transactions_product_id_created_at_idx"
ON "stock_transactions"("product_id", "created_at");

ALTER TABLE "stock_transactions"
ADD CONSTRAINT "stock_transactions_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
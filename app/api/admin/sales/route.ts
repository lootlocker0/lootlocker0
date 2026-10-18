import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import { requireAdminSession } from "@/lib/admin-session";
import { adminRecordSaleSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class SaleStockAdjustmentRejected extends Error {
  constructor(
    readonly productId: string,
    readonly delta: number,
  ) {
    super("Manual sale stock adjustment rejected");
  }
}

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = requireAdminSession(req);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new AppError("INVALID_INPUT", {
        fields: { _body: ["Request body must be JSON."] },
      });
    }

    const parsed = adminRecordSaleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const items = "items" in parsed.data ? parsed.data.items : [parsed.data];

    let sale: {
      transactionId: string;
      productId: string;
      productName: string;
      qty: number;
      saleTotalCents: number;
      stockQty: number;
    }[];
    try {
      sale = await db.$transaction(async (tx) => {
        const stockByProduct = new Map<string, number>();

        // Acquire product row locks in a stable order so overlapping multi-line
        // sales cannot deadlock by requesting the same products differently.
        for (const item of [...items].sort((a, b) =>
          a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
        )) {
          const delta = -item.qty;
          const rows = await tx.$queryRaw<{ stock: number | null }[]>`
            SELECT adjust_stock(${item.productId}::text, ${delta}::int) AS stock
          `;
          const stockQty = rows[0]?.stock ?? null;
          if (stockQty === null) {
            throw new SaleStockAdjustmentRejected(item.productId, delta);
          }
          stockByProduct.set(item.productId, stockQty);
        }

        const products = await tx.product.findMany({
          where: { id: { in: items.map((item) => item.productId) } },
          select: { id: true, name: true },
        });
        const productNames = new Map(products.map((product) => [product.id, product.name]));

        return Promise.all(
          items.map(async (item) => {
            const productName = productNames.get(item.productId);
            const stockQty = stockByProduct.get(item.productId);
            if (productName === undefined || stockQty === undefined) {
              throw new SaleStockAdjustmentRejected(item.productId, -item.qty);
            }
            const transaction = await tx.stockTransaction.create({
              data: {
                productId: item.productId,
                type: "SALE",
                qtyDelta: -item.qty,
                saleTotalCents: item.saleTotalCents,
                stockQtyAfter: stockQty,
                sessionId,
              },
              select: { id: true },
            });

            return {
              transactionId: transaction.id,
              productId: item.productId,
              productName,
              qty: item.qty,
              saleTotalCents: item.saleTotalCents,
              stockQty,
            };
          }),
        );
      });
    } catch (error) {
      if (!(error instanceof SaleStockAdjustmentRejected)) throw error;
      const product = await db.product.findUnique({
        where: { id: error.productId },
        select: { stockQty: true },
      });
      if (!product) throw new AppError("PRODUCT_UNAVAILABLE");
      throw new AppError("STOCK_ADJUSTMENT_REJECTED", {
        productId: error.productId,
        stockQty: product.stockQty,
        delta: error.delta,
      });
    }

    for (const item of sale) {
      logEvent("admin_sale_recorded", {
        productId: item.productId,
        qty: item.qty,
        saleTotalCents: item.saleTotalCents,
        stockQty: item.stockQty,
        sessionId,
      });
    }

    if ("items" in parsed.data) {
      return Response.json(
        {
          items: sale.map(({ productId, productName, qty, saleTotalCents, stockQty }) => ({
            productId,
            productName,
            qty,
            saleTotalCents,
            stockQty,
          })),
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        transactionId: sale[0].transactionId,
        productId: sale[0].productId,
        productName: sale[0].productName,
        qty: sale[0].qty,
        saleTotalCents: sale[0].saleTotalCents,
        stockQty: sale[0].stockQty,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
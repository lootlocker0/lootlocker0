import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import { requireAdminSession } from "@/lib/admin-session";
import { adminRecordSaleSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const { productId, qty, saleTotalCents } = parsed.data;
    const delta = -qty;

    const sale = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ stock: number | null }[]>`
        SELECT adjust_stock(${productId}::text, ${delta}::int) AS stock
      `;
      const stockQty = rows[0]?.stock ?? null;
      if (stockQty === null) return null;

      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { name: true },
      });
      if (!product) return null;

      const transaction = await tx.stockTransaction.create({
        data: {
          productId,
          type: "SALE",
          qtyDelta: delta,
          saleTotalCents,
          stockQtyAfter: stockQty,
          sessionId,
        },
        select: { id: true },
      });

      return { transactionId: transaction.id, productName: product.name, stockQty };
    });

    if (sale === null) {
      const product = await db.product.findUnique({
        where: { id: productId },
        select: { stockQty: true },
      });
      if (!product) throw new AppError("PRODUCT_UNAVAILABLE");
      throw new AppError("STOCK_ADJUSTMENT_REJECTED", {
        productId,
        stockQty: product.stockQty,
        delta,
      });
    }

    logEvent("admin_sale_recorded", {
      productId,
      qty,
      saleTotalCents,
      stockQty: sale.stockQty,
      sessionId,
    });

    return Response.json(
      {
        transactionId: sale.transactionId,
        productId,
        productName: sale.productName,
        qty,
        saleTotalCents,
        stockQty: sale.stockQty,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
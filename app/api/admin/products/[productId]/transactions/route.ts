import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const productIdSchema = z.cuid();
const takeSchema = z.number().int().min(1).max(500);
const SOLD_ORDER_STATUSES = ["RESERVED", "PAID", "PACKED", "PICKED_UP", "REFUNDED"] as const;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ productId: string }> },
) {
  try {
    requireAdminSession(req);
    const { productId: rawId } = await ctx.params;
    const idParsed = productIdSchema.safeParse(rawId);
    if (!idParsed.success) throw new AppError("PRODUCT_UNAVAILABLE");
    const productId = idParsed.data;

    const takeParsed = takeSchema.safeParse(Number(new URL(req.url).searchParams.get("take") ?? "100"));
    if (!takeParsed.success) {
      throw new AppError("INVALID_INPUT", {
        fields: { take: ["Expected an integer from 1 to 500."] },
      });
    }
    const take = takeParsed.data;

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new AppError("PRODUCT_UNAVAILABLE");

    const [stockChanges, orderItems] = await Promise.all([
      db.stockTransaction.findMany({
        where: { productId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        select: {
          id: true,
          type: true,
          qtyDelta: true,
          unitCostCents: true,
          stockQtyAfter: true,
          createdAt: true,
        },
      }),
      db.orderItem.findMany({
        where: {
          productId,
          order: { status: { in: [...SOLD_ORDER_STATUSES] } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        select: {
          id: true,
          qty: true,
          nameSnapshot: true,
          createdAt: true,
          order: { select: { orderNumber: true, status: true } },
        },
      }),
    ]);

    const combined = [
      ...stockChanges.map((entry) => ({
        id: entry.id,
        source: entry.type,
        direction: entry.qtyDelta > 0 ? "IN" as const : "OUT" as const,
        qtyDelta: entry.qtyDelta,
        unitCostCents: entry.unitCostCents,
        stockQtyAfter: entry.stockQtyAfter,
        orderNumber: null,
        orderStatus: null,
        createdAt: entry.createdAt.toISOString(),
      })),
      ...orderItems.map((entry) => ({
        id: entry.id,
        source: "SALE" as const,
        direction: "OUT" as const,
        qtyDelta: -entry.qty,
        unitCostCents: null,
        stockQtyAfter: null,
        orderNumber: entry.order.orderNumber,
        orderStatus: entry.order.status,
        createdAt: entry.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const transactions = combined.slice(0, take);

    return Response.json(
      {
        productId,
        transactions,
        hasMore:
          combined.length > take || stockChanges.length > take || orderItems.length > take,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
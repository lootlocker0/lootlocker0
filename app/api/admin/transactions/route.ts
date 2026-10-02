import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const takeSchema = z.number().int().min(1).max(500);
const SOLD_ORDER_STATUSES = ["RESERVED", "PAID", "PACKED", "PICKED_UP", "REFUNDED"] as const;

export async function GET(req: NextRequest) {
  try {
    requireAdminSession(req);
    const rawTake = new URL(req.url).searchParams.get("take");
    const parsedTake = takeSchema.safeParse(Number(rawTake ?? "100"));
    if (!parsedTake.success) {
      throw new AppError("INVALID_INPUT", {
        fields: { take: ["Expected an integer from 1 to 500."] },
      });
    }
    const take = parsedTake.data;

    const [stockChanges, orderItems] = await Promise.all([
      db.stockTransaction.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        select: {
          id: true,
          productId: true,
          product: { select: { name: true } },
          type: true,
          qtyDelta: true,
          unitCostCents: true,
          saleTotalCents: true,
          stockQtyAfter: true,
          createdAt: true,
        },
      }),
      db.orderItem.findMany({
        where: { order: { status: { in: [...SOLD_ORDER_STATUSES] } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        select: {
          id: true,
          productId: true,
          qty: true,
          nameSnapshot: true,
          unitPriceCents: true,
          createdAt: true,
          order: { select: { orderNumber: true, status: true } },
        },
      }),
    ]);

    const combined = [
      ...stockChanges.map((entry) => ({
        id: entry.id,
        productId: entry.productId,
        productName: entry.product.name,
        source: entry.type,
        direction: entry.qtyDelta > 0 ? "IN" as const : "OUT" as const,
        qtyDelta: entry.qtyDelta,
        unitCostCents: entry.unitCostCents,
        saleTotalCents: entry.saleTotalCents,
        stockQtyAfter: entry.stockQtyAfter,
        orderNumber: null,
        orderStatus: null,
        createdAt: entry.createdAt.toISOString(),
      })),
      ...orderItems.map((entry) => ({
        id: entry.id,
        productId: entry.productId,
        productName: entry.nameSnapshot,
        source: "SALE" as const,
        direction: "OUT" as const,
        qtyDelta: -entry.qty,
        unitCostCents: null,
        saleTotalCents: entry.unitPriceCents * entry.qty,
        stockQtyAfter: null,
        orderNumber: entry.order.orderNumber,
        orderStatus: entry.order.status,
        createdAt: entry.createdAt.toISOString(),
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

    return Response.json(
      {
        transactions: combined.slice(0, take),
        hasMore:
          combined.length > take || stockChanges.length > take || orderItems.length > take,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
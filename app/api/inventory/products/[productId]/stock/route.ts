import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import { requireInventorySession } from "@/lib/inventory-session";
import { inventoryStockAdjustSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Keep quantity current" — a delivery arrived, a box was miscounted, something
// was dropped.
//
// ── Relative here, absolute only at creation ────────────────────────────────
// The body carries a signed `delta`. `POST /api/inventory/products` takes an
// absolute `stockQty`, and the difference between the two is not an
// inconsistency — it is the whole argument:
//
//   at creation   the row does not exist. Nothing can have reserved stock on a
//                 product that has never been saved, so there is no concurrent
//                 write to lose. An absolute quantity is exactly right, and
//                 demanding "create it with 0, then adjust by +24" would be
//                 ceremony with no safety in it.
//
//   afterwards    the shelf is live. "Set stock to 7" is a read-then-write with
//                 a human in the middle: count the box, walk to the laptop, and
//                 in between a student's checkout reserves a unit — writing 7
//                 silently un-reserves it and the shelf oversells (CLAUDE.md
//                 §2.4). A delta composes with whatever else happened.
//
// The editor is thirteen, which is an argument for computing the delta for them
// on screen (they counted 7, the screen showed 9, send -2) and never for
// relaxing the rule. The database does not know who is holding the clipboard.
//
// ── Atomic, through the same function staff use ─────────────────────────────
// `adjust_stock(text, int)` from prisma/migrations/manual_constraints.sql does
// its bound check and its write in one UPDATE, exactly as `reserve_stock` does.
// P4b adds no new SQL: no migration, no re-run of manual_constraints.sql.
//
// ── The hazard, inherited from P4 ───────────────────────────────────────────
// lib/db/release.ts restocks without a ceiling when a card order expires or a
// payment fails (docs/HANDOFF.md §7). Adjusting for an order that then releases
// adds the quantity twice. Adjust for what is physically on the shelf, never
// for what an order did — and this role cannot see orders at all, which makes
// that the only advice it can act on.

const productIdSchema = z.cuid();

class StockAdjustmentRejected extends Error {}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ productId: string }> },
) {
  try {
    const { sessionId } = requireInventorySession(req);
    const { productId: rawId } = await ctx.params;

    const idParsed = productIdSchema.safeParse(rawId);
    if (!idParsed.success) throw new AppError("PRODUCT_UNAVAILABLE");
    const productId = idParsed.data;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new AppError("INVALID_INPUT", {
        fields: { _body: ["Request body must be JSON."] },
      });
    }

    const parsed = inventoryStockAdjustSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const { delta, totalCostCents } = parsed.data;
    const type = totalCostCents === undefined ? "ADJUSTMENT" : "PURCHASE";
    let transaction: {
      id: string;
      stockQty: number;
      unitCostCents: number | null;
    };
    try {
      transaction = await db.$transaction(async (tx) => {
        // The stock change and its immutable ledger entry must commit or roll
        // back together.
        const rows = await tx.$queryRaw<{ stock: number | null }[]>`
          SELECT adjust_stock(${productId}::text, ${delta}::int) AS stock
        `;
        const stockQty = rows[0]?.stock ?? null;
        if (stockQty === null) throw new StockAdjustmentRejected();

        const unitCostCents =
          totalCostCents === undefined
            ? null
            : Math.round(totalCostCents / delta);
        const stockTransaction = await tx.stockTransaction.create({
          data: {
            productId,
            type,
            qtyDelta: delta,
            unitCostCents,
            totalCostCents: totalCostCents ?? null,
            stockQtyAfter: stockQty,
            sessionId,
          },
          select: { id: true },
        });

        return { id: stockTransaction.id, stockQty, unitCostCents };
      });
    } catch (error) {
      if (!(error instanceof StockAdjustmentRejected)) throw error;
      // Diagnostic only. The failed transaction rolled back; this read
      // identifies whether the product was missing or the change went below
      // zero and never performs a write.
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
    const { stockQty } = transaction;

    logEvent("inventory_stock_adjusted", {
      productId,
      delta,
      type,
      stockQty,
      sessionId,
    });

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { name: true, slug: true, active: true, allergens: true },
    });

    return Response.json(
      {
        productId,
        name: product?.name ?? null,
        slug: product?.slug ?? null,
        /// Authoritative: read out of the same UPDATE that made the change, so
        /// it already includes any concurrent checkout that landed first. It
        /// will sometimes not equal what the editor expected — show this number,
        /// not their arithmetic.
        stockQty,
        delta,
        transactionId: transaction.id,
        type,
        unitCostCents: transaction.unitCostCents,
        totalCostCents: totalCostCents ?? null,
        /// Derived from the atomic result, not a second read: what the quantity
        /// was at the instant of the write.
        previousStockQty: stockQty - delta,
        active: product?.active ?? null,
        /// Echoed so a screen that just changed a count can keep the safety data
        /// on screen without a second request. Full list, never truncated
        /// (CLAUDE.md §2.8).
        allergens: product?.allergens ?? [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

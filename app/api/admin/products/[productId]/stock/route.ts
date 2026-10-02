import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import { requireAdminSession } from "@/lib/admin-session";
import { adminStockAdjustSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual stock correction: a delivery arrived, a box was miscounted, something
// got dropped.
//
// ── Relative, never absolute ─────────────────────────────────────────────────
// The body carries a signed `delta`, not a new quantity, and that is a
// correctness requirement rather than an interface preference. "Set stock to 7"
// is a read-then-write with a human in the middle: staff count the shelf, walk
// to the tablet, and in between a student's checkout reserves a unit — writing
// 7 silently un-reserves it and the shelf oversells by one. A delta composes
// with whatever else happened; an absolute value overwrites it (CLAUDE.md
// §2.4). Staff who have just counted a shelf need the delta computed for them
// in the UI, not the invariant relaxed here.
//
// ── Atomic, like everything else that moves stock ────────────────────────────
// `adjust_stock(text, int)` in prisma/migrations/manual_constraints.sql does its
// bound check and its write in one UPDATE, exactly as `reserve_stock` does. It
// returns the new quantity, or NULL when nothing moved. Nothing here reads
// `stockQty` and then writes it.
//
// ── The one hazard staff have to be told about ───────────────────────────────
// `lib/db/release.ts` restocks without a ceiling when a card order expires or a
// payment fails (docs/HANDOFF.md §7). If staff hand-adjust for an order that
// then releases, the quantity is added twice and the shelf claims stock that
// does not exist. Nothing in the database prevents it. Adjust for what is
// physically on the shelf, not for what an order did.

const productIdSchema = z.cuid();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ productId: string }> },
) {
  try {
    const { sessionId } = requireAdminSession(req);
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
    const parsed = adminStockAdjustSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const { delta, type, unitCostCents } = parsed.data;

    // The atomic stock update and its audit row either commit together or
    // neither becomes visible.
    const mutation = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ stock: number | null }[]>`
        SELECT adjust_stock(${productId}::text, ${delta}::int) AS stock
      `;
      const stockQty = rows[0]?.stock ?? null;
      if (stockQty === null) return null;

      const transaction = await tx.stockTransaction.create({
        data: {
          productId,
          type,
          qtyDelta: delta,
          unitCostCents: unitCostCents ?? null,
          stockQtyAfter: stockQty,
          sessionId,
        },
        select: { id: true },
      });
      return { stockQty, transactionId: transaction.id };
    });
    if (mutation === null) {
      // Diagnostic ONLY — the decision was already made and committed above.
      // This read exists to tell a staff member which of the two failures they
      // hit, and it can never cause a write.
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
    const { stockQty } = mutation;

    // Non-PII by construction: a product id, a count, a session. No student is
    // involved in a stock adjustment and none appears in this line.
    logEvent("admin_stock_adjusted", {
      productId,
      delta,
      type,
      stockQty,
      sessionId,
    });

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { name: true, active: true, allergens: true },
    });

    return Response.json(
      {
        productId,
        name: product?.name ?? null,
        /// Authoritative: read out of the same UPDATE that made the change, so
        /// it already includes any concurrent checkout that landed first.
        stockQty,
        delta,
        type,
        unitCostCents: unitCostCents ?? null,
        transactionId: mutation.transactionId,
        /// Derived arithmetic from the atomic result, not a second read — it is
        /// what the quantity was at the instant of the write.
        previousStockQty: stockQty - delta,
        active: product?.active ?? null,
        /// Echoed so a screen that just changed a product's count can keep the
        /// safety data on screen without a second request. Full list, never
        /// truncated (CLAUDE.md §2.8).
        allergens: product?.allergens ?? [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

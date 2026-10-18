import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import { requireInventorySession } from "@/lib/inventory-session";
import {
  INVENTORY_PRODUCT_SELECT,
  slugifyProductName,
} from "@/lib/db/inventory";
import { inventoryProductCreateSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  — every product, unfiltered.
// POST — create one.
//
// GET returns Product only. POST atomically creates the Product and its initial
// purchase-ledger row; neither path touches an order, an order item, a student,
// or a setting. The response projection (INVENTORY_PRODUCT_SELECT) is an
// explicit column list, not a row spread.

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory/products
// ─────────────────────────────────────────────────────────────────────────────
//
// EVERY product — inactive ones and sold-out ones included. That is the
// difference from the public `GET /api/products`, which filters to
// `active = true AND stockQty > 0`, and the filter is exactly backwards for this
// role: the products an editor most needs to open are the ones that sold out or
// were switched off.
//
// No pagination and no filtering. This is a school snack catalog — 23 rows
// today, and a couple of hundred at its most ambitious. A `take`/`skip` API that
// nobody needs is surface that can be got wrong; when the catalog outgrows one
// response, the fix is a real decision made against a real number.

export async function GET(req: NextRequest) {
  try {
    requireInventorySession(req);

    const products = await db.product.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: INVENTORY_PRODUCT_SELECT,
    });

    // Computed from the rows already fetched, not a second query. Gives an
    // editor the "what needs attention" summary without a filter API:
    // deactivated items and empty shelves are the two working lists.
    const counts = {
      total: products.length,
      active: products.filter((p) => p.active).length,
      inactive: products.filter((p) => !p.active).length,
      outOfStock: products.filter((p) => p.stockQty === 0).length,
      // Not a safety claim about the product — the database cannot distinguish
      // "reviewed, none present" from "never filled in" (there is no
      // `allergensReviewedAt` column; see lib/validation.ts and
      // docs/HANDOFF.md). It is a prompt: these are the rows worth re-checking,
      // and 8 of them arrived with the seed (docs/HANDOFF.md §16).
      withEmptyAllergenList: products.filter((p) => p.allergens.length === 0)
        .length,
    };

    return Response.json(
      { products, counts },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/products
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = requireInventorySession(req);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new AppError("INVALID_INPUT", {
        fields: { _body: ["Request body must be JSON."] },
      });
    }

    const parsed = inventoryProductCreateSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      // The allergen refusal gets its own code so a client can say "allergens
      // must be checked" in those words rather than colouring a field red.
      // Everything else is an ordinary 400.
      if (fields.allergens || fields.allergensReviewed) {
        throw new AppError("ALLERGENS_NOT_REVIEWED", { fields });
      }
      throw new AppError("INVALID_INPUT", { fields });
    }
    const input = parsed.data;

    const slug = input.slug ?? slugifyProductName(input.name);
    if (slug.length < 2) {
      // A name of pure punctuation or emoji. Refuse rather than invent a key.
      throw new AppError("INVALID_INPUT", {
        fields: {
          slug: ["Could not build a link name from that product name. Set one."],
        },
      });
    }

    // ── The write ────────────────────────────────────────────────────────────
    // Field by field, never `data: input`. Even if a schema change let an
    // unexpected key through, it could not become a column write — and the set
    // of columns this role may write is readable in one screen, which is the
    // property that makes the boundary auditable.
    let product;
    try {
      product = await db.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            slug,
            name: input.name,
            description: input.description,
            priceCents: input.priceCents,
            category: input.category,
            rarity: input.rarity,
            allergens: input.allergens,
            // Absolute, and safe precisely here: the row does not exist yet,
            // so there is no concurrent reservation to clobber (CLAUDE.md §2.4).
            stockQty: input.stockQty,
            active: input.active,
            imageUrl: input.imageUrl,
            sortOrder: input.sortOrder ?? 0,
          },
          select: INVENTORY_PRODUCT_SELECT,
        });

        if (input.stockQty > 0) {
          await tx.stockTransaction.create({
            data: {
              productId: created.id,
              type: "PURCHASE",
              qtyDelta: input.stockQty,
              unitCostCents: Math.round(
                input.initialPurchaseTotalCents / input.stockQty,
              ),
              totalCostCents: input.initialPurchaseTotalCents,
              stockQtyAfter: input.stockQty,
              sessionId,
            },
            select: { id: true },
          });
        }

        return created;
      });
    } catch (e) {
      // The unique index on `slug` is the race winner, not a pre-check: two
      // editors saving "Cheese Puffs" at the same instant both derive the same
      // slug, and exactly one INSERT survives.
      if (
        typeof e === "object" &&
        e !== null &&
        (e as { code?: string }).code === "P2002"
      ) {
        throw new AppError("PRODUCT_SLUG_TAKEN", { slug });
      }
      throw e;
    }

    // Non-PII by construction: a product, a price, a session. No student is
    // involved in a catalog edit and none appears in this line. `priceCents` is
    // logged deliberately — it is a money field an unsupervised editor can set,
    // and the log is the only record of who set what to what (docs/HANDOFF.md).
    logEvent("inventory_product_created", {
      productId: product.id,
      slug: product.slug,
      priceCents: product.priceCents,
      stockQty: product.stockQty,
      initialPurchaseTotalCents: input.initialPurchaseTotalCents,
      active: product.active,
      allergenCount: product.allergens.length,
      sessionId,
    });

    return Response.json(
      { product },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

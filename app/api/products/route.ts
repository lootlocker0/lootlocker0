import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { productQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";

// Stock and `active` change during a lunch service. Next would otherwise be free
// to render this handler once at build time and serve a frozen catalog forever.
export const dynamic = "force-dynamic";

/// Explicit projection, not the whole row. Two reasons: it pins the response to
/// the Product shape published in docs/API-CONTRACT.md §4, and a column added
/// later (P4b adds photo/inventory fields) cannot leak into a public response
/// just by existing. `createdAt`/`updatedAt` are internal and are not returned.
const PRODUCT_FIELDS = {
  id: true,
  slug: true,
  name: true,
  description: true,
  sizeProduct: true,
  priceCents: true,
  category: true,
  rarity: true,
  allergens: true,
  stockQty: true,
  active: true,
  imageUrl: true,
  sortOrder: true,
} as const;

export async function GET(req: NextRequest) {
  try {
    const parsed = productQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsed.success) {
      // backend.md §9 calls `.parse()` here, which throws a raw ZodError and
      // surfaces as a bare 500. Every documented failure gets a machine-readable
      // code (docs/API-CONTRACT.md §2), so an unknown allergen or category is a
      // 400 the client can act on.
      throw new AppError("INVALID_INPUT", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const q = parsed.data;

    const products = await db.product.findMany({
      where: {
        active: true,
        stockQty: { gt: 0 },
        ...(q.category && { category: q.category }),
        ...(q.rarity && { rarity: q.rarity }),
        // Allergen exclusion is safety filtering. `NOT hasSome` is the correct
        // semantic: drop the product if it contains ANY excluded allergen.
        // `hasEvery` would only drop products carrying the entire excluded set,
        // so a peanut-allergic student filtering PEANUTS would still be shown
        // trail mix. Never hasEvery here.
        ...(q.excludeAllergens.length && {
          NOT: { allergens: { hasSome: q.excludeAllergens } },
        }),
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: PRODUCT_FIELDS,
    });

    return Response.json(
      { products },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

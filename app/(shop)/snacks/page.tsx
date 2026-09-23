import type { Metadata } from "next";
import Link from "next/link";
import { Rarity } from "@prisma/client";
import { db } from "@/lib/db";
import { PRODUCT_CATEGORIES, type ProductCategory } from "@/lib/validation";
import { rarityMeta } from "@/lib/rarity";
import { ProductGrid } from "@/components/ProductGrid";

export const metadata: Metadata = {
  title: "The Loot | LootLockers",
  description: "Browse every snack in stock, filter by rarity or category.",
};

// Stock and `active` change during a lunch service — same reasoning as
// GET /api/products (docs/API-CONTRACT.md §6).
export const revalidate = 0;

const RARITIES = Object.values(Rarity);

function isProductCategory(v: string): v is ProductCategory {
  return (PRODUCT_CATEGORIES as readonly string[]).includes(v);
}

function isRarity(v: string): v is Rarity {
  return (RARITIES as readonly string[]).includes(v);
}

/** Builds `/snacks?...` preserving every filter except the one being toggled off/on. */
function filterHref(
  current: { category?: string; rarity?: string },
  patch: { category?: string; rarity?: string },
) {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.category) params.set("category", next.category);
  if (next.rarity) params.set("rarity", next.rarity);
  const qs = params.toString();
  return qs ? `/snacks?${qs}` : "/snacks";
}

export default async function SnacksPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; rarity?: string }>;
}) {
  const sp = await searchParams;

  // Mirrors GET /api/products' validation (lib/validation.ts) rather than a
  // second source of truth for the four category strings / five rarities.
  // Unlike the API, a mistyped/unknown query param on this page just falls
  // back to "no filter" instead of a 400 — this is a browsable page, not a
  // machine contract.
  const category = sp.category && isProductCategory(sp.category) ? sp.category : undefined;
  const rarity = sp.rarity && isRarity(sp.rarity) ? sp.rarity : undefined;

  // Server Component reading the DB directly, not GET /api/products — the
  // API's `stockQty > 0` filter would drop sold-out products entirely, and
  // the P2 gate requires them rendered disabled, not hidden.
  // (docs/HANDOFF.md §12.)
  const products = await db.product.findMany({
    where: {
      active: true,
      ...(category && { category }),
      ...(rarity && { rarity }),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      priceCents: true,
      category: true,
      rarity: true,
      allergens: true,
      stockQty: true,
      imageUrl: true,
    },
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-8">
      <h1 className="font-display text-headline-lg uppercase text-rarity-epic">
        The Loot
      </h1>
      <p className="mt-2 max-w-xl text-text-dim">
        Everything in stock right now. Sold-out items stay listed so you can
        see what to check back for.
      </p>

      <div className="mt-8 flex flex-col gap-4">
        <fieldset>
          <legend className="font-mono text-xs uppercase tracking-wide text-text-faint">
            Category
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link
              href={filterHref(sp, { category: undefined })}
              aria-current={!category ? "true" : undefined}
              className={`clip-shard-tight border-2 px-4 py-1.5 font-mono text-xs uppercase transition-colors ${
                !category
                  ? "border-gold bg-gold text-void"
                  : "border-brand text-text hover:bg-brand/15"
              }`}
            >
              All
            </Link>
            {PRODUCT_CATEGORIES.map((c) => (
              <Link
                key={c}
                href={filterHref(sp, { category: category === c ? undefined : c })}
                aria-current={category === c ? "true" : undefined}
                className={`clip-shard-tight border-2 px-4 py-1.5 font-mono text-xs uppercase transition-colors ${
                  category === c
                    ? "border-gold bg-gold text-void"
                    : "border-brand text-text hover:bg-brand/15"
                }`}
              >
                {c}
              </Link>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="font-mono text-xs uppercase tracking-wide text-text-faint">
            Rarity
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link
              href={filterHref(sp, { rarity: undefined })}
              aria-current={!rarity ? "true" : undefined}
              className={`clip-shard-tight border-2 px-4 py-1.5 font-mono text-xs uppercase transition-colors ${
                !rarity
                  ? "border-gold bg-gold text-void"
                  : "border-brand text-text hover:bg-brand/15"
              }`}
            >
              All
            </Link>
            {RARITIES.map((r) => {
              const meta = rarityMeta(r);
              const active = rarity === r;
              return (
                <Link
                  key={r}
                  href={filterHref(sp, { rarity: active ? undefined : r })}
                  aria-current={active ? "true" : undefined}
                  className="clip-shard-tight border-2 px-4 py-1.5 font-mono text-xs uppercase transition-colors"
                  style={{
                    borderColor: meta.hex,
                    background: active ? meta.hex : "transparent",
                    color: active ? "var(--color-void)" : meta.hex,
                  }}
                >
                  {meta.label}
                </Link>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="mt-10">
        <h2 className="sr-only">
          {products.length} {products.length === 1 ? "product" : "products"}
        </h2>
        <ProductGrid
          products={products}
          emptyMessage="No snacks match those filters. Try clearing one."
        />
      </div>
    </div>
  );
}

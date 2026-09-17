"use client";

import type { Allergen, Rarity } from "@prisma/client";
import { RarityCard } from "@/components/ui/RarityCard";
import { useCart } from "@/stores/cart";

/**
 * Product shape needed to render a grid of RarityCards. Matches the fields
 * both read paths produce — the Server Component's direct `db.product`
 * query (full Prisma `Product`) and `GET /api/products`'s JSON projection
 * (docs/API-CONTRACT.md §4) — so this component doesn't care which page fed
 * it the array.
 */
export type CatalogProduct = {
  id: string;
  name: string;
  description: string;
  sizeProduct?: string | null;
  priceCents: number;
  category: string;
  rarity: Rarity;
  allergens: Allergen[];
  stockQty: number;
  imageUrl: string;
};

/**
 * Client boundary that owns cart interactivity. `RarityCard`/`ShardButton`
 * have no "use client" directive of their own (components/ui primitives are
 * meant to be usable from either a server or client tree) — this is the
 * module that pulls them into the client bundle so `onAdd` can reach
 * `useCart`. Stock is bounded from `product.stockQty`, the value the caller
 * just read live — never a number cached in the cart store itself.
 */
export function ProductGrid({
  products,
  emptyMessage = "Nothing matches those filters right now.",
}: {
  products: CatalogProduct[];
  emptyMessage?: string;
}) {
  const add = useCart((s) => s.add);

  if (products.length === 0) {
    return (
      <p className="border-2 border-white/10 bg-surface-2 p-6 text-center text-text-dim">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {products.map((p) => (
        <RarityCard
          key={p.id}
          name={p.name}
          description={p.description}
          priceCents={p.priceCents}
          imageUrl={p.imageUrl}
          rarity={p.rarity}
          allergens={p.allergens}
          stockQty={p.stockQty}
          onAdd={() => add(p.id, p.stockQty)}
        />
      ))}
    </div>
  );
}

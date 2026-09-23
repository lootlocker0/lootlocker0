import type { Rarity, Allergen } from "@prisma/client";
import { rarityMeta } from "@/lib/rarity";
import { ShardButton } from "./ShardButton";
import { ProductImage } from "./ProductImage";

export function RarityCard({
  name, description, priceCents, imageUrl, rarity, allergens, stockQty, onAdd,
}: {
  name: string;
  description: string;
  priceCents: number;
  imageUrl: string;
  rarity: Rarity;
  allergens: Allergen[];
  stockQty: number;
  onAdd: () => void;
}) {
  const meta = rarityMeta(rarity);
  const soldOut = stockQty === 0;

  return (
    <article
      className="clip-panel relative flex flex-col gap-3 border-2 bg-surface-3 p-4"
      style={{
        borderColor: meta.hex,
        // Decoration only - the tier is also stated as text in the badge below,
        // so this is safe to hide from assistive tech.
        boxShadow: `0 0 22px -6px ${meta.glow}`,
      }}
    >
      <span
        aria-hidden="true"
        className="clip-corner-badge absolute right-0 top-0 flex h-12 w-12 items-start justify-end p-1.5"
        style={{ background: meta.hex }}
      >
        <span className="font-mono text-[10px] font-bold text-void">{meta.label.slice(0, 3).toUpperCase()}</span>
      </span>

      <span
        className="w-fit px-2 py-0.5 font-mono text-[11px] font-bold uppercase text-void"
        style={{ background: meta.hex }}
      >
        {meta.label}
      </span>

      <div className="flex aspect-square h-full w-full items-center justify-center overflow-hidden bg-surface-lowest">
        <ProductImage
          src={imageUrl}
          alt=""
          rarity={rarity}
          width={320}
          height={320}
          className="h-full w-full object-contain"
        />
      </div>

      <h3 className="font-display text-headline-md uppercase leading-none text-text">
        {name}
      </h3>
      <p className="text-sm text-text-dim">{description}</p>

      {/* Safety UI. Never truncated, never hover-only, never "+2 more". */}
      {allergens.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Contains allergens">
          {allergens.map((a) => (
            <li
              key={a}
              className="border border-danger/60 px-2 py-0.5 font-mono text-[11px] text-danger"
            >
              {a.replace(/_/g, " ")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[11px] text-rarity-uncommon">No listed allergens</p>
      )}

      <div className="mt-auto flex items-center justify-between pt-2">
        <span className="font-display text-xl text-gold">
          ${(priceCents / 100).toFixed(2)}
        </span>
        <ShardButton size="sm" onClick={onAdd} disabled={soldOut}>
          {soldOut ? "Sold out" : "Add"}
        </ShardButton>
      </div>

      {stockQty > 0 && stockQty <= 5 && (
        <p className="font-mono text-[11px] text-gold">Only {stockQty} left</p>
      )}
    </article>
  );
}

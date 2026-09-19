"use client";

import { useState } from "react";
import Image from "next/image";
import type { Rarity } from "@prisma/client";
import { rarityMeta } from "@/lib/rarity";

/**
 * next/image wrapper with a graceful fallback. Seeded `imageUrl` values are
 * `/products/<slug>.svg` and `public/products/` is empty (docs/HANDOFF.md §6)
 * — every catalog card 404s on the real image right now. Rather than a
 * broken-image icon, a failed load renders a rarity-tinted placeholder built
 * entirely from design tokens (no third-party asset, no icon font).
 */
export function ProductImage({
  src,
  alt,
  rarity,
  width,
  height,
  className,
}: {
  src: unknown;
  alt: string;
  rarity: Rarity;
  width: number;
  height: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const meta = rarityMeta(rarity);
  const imageSrc = typeof src === "string" ? src.trim() : "";

  if (failed || !imageSrc) {
    return (
      <div
        role="img"
        aria-label={alt || "Product image unavailable"}
        className={className}
        style={{
          background: `linear-gradient(135deg, ${meta.hex}2E 0%, transparent 70%)`,
        }}
      >
        <div className="flex h-full w-full items-center justify-center">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-1/3 w-1/3"
            style={{ color: meta.hex }}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            {/* Generic pouch/snack glyph — deliberately not a licensed icon set. */}
            <path
              d="M7 3h10l1.5 4H5.5L7 3Z"
              strokeLinejoin="round"
            />
            <path
              d="M5.5 7h13l-1 12a2 2 0 0 1-2 1.8H8.5A2 2 0 0 1 6.5 19L5.5 7Z"
              strokeLinejoin="round"
            />
            <path d="M9.5 11.5c1.5 1.5 3.5 1.5 5 0" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <Image
      src={imageSrc}
      alt={alt}
      width={width}
      height={height}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

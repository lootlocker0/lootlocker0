"use client";

import { useState } from "react";
import { ShardButton } from "@/components/ui/ShardButton";
import { inventoryFetch } from "./inventoryApi";
import type { InventoryApiError } from "./types";

/**
 * Per-product signed stock delta, matching
 * `POST /api/inventory/products/[productId]/stock` exactly (§6b): the input
 * is always relative, never an absolute "set to N" — the API has no such
 * field. Absolute is only valid at creation, when the row doesn't exist yet
 * and nothing can have a concurrent reservation on it.
 *
 * Bound is ±1000 here (tighter than the staff route's ±10000, per §6b).
 */
export function StockAdjuster({
  productId,
  name,
  currentStock,
  onAdjusted,
  onUnauthorized,
}: {
  productId: string;
  name: string;
  currentStock: number;
  onAdjusted: (nextStockQty: number) => void;
  onUnauthorized: () => void;
}) {
  const [delta, setDelta] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<InventoryApiError | null>(null);
  const [result, setResult] = useState<{ previous: number; next: number } | null>(null);

  async function apply(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = delta.trim();
    const n = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(n) || n === 0) {
      setError({ code: "INVALID_INPUT", message: "Enter a non-zero whole number, e.g. +7 or -2." });
      return;
    }
    if (Math.abs(n) > 1000) {
      setError({ code: "INVALID_INPUT", message: "Adjustments are limited to ±1000 at a time." });
      return;
    }
    setBusy(true);
    setError(null);
    const res = await inventoryFetch<{
      productId: string;
      stockQty: number;
      previousStockQty: number;
      delta: number;
    }>(`/api/inventory/products/${productId}/stock`, {
      method: "POST",
      body: JSON.stringify({ delta: n }),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      setError(res.error);
      return;
    }
    setResult({ previous: res.data.previousStockQty, next: res.data.stockQty });
    setDelta("");
    onAdjusted(res.data.stockQty);
  }

  return (
    <div className="border-2 border-white/10 bg-surface-2 p-3">
      <form onSubmit={apply} className="flex flex-wrap items-center gap-3">
        <label className="font-mono text-xs uppercase text-text-faint" htmlFor={`stock-delta-${productId}`}>
          Adjust stock for {name}
        </label>
        <input
          id={`stock-delta-${productId}`}
          type="text"
          inputMode="text"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          placeholder="+7 or -2"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `stock-delta-error-${productId}` : undefined}
          className="w-28 border-2 border-white/10 bg-surface-3 px-2 py-1 font-mono text-text focus:border-brand"
        />
        <ShardButton type="submit" size="sm" loading={busy}>
          Apply
        </ShardButton>
        <span className="font-mono text-xs text-text-dim">
          {result ? `${result.previous} → ${result.next}` : `Currently ${currentStock}`}
        </span>
      </form>
      <p className="mt-2 text-xs text-text-dim">
        Count what&rsquo;s physically on the shelf and enter the difference —
        the screen already accounts for anything sold since you last checked.
        A card order that later expires or fails restocks automatically; if
        you also add that amount back by hand it gets counted twice.
      </p>
      {error && (
        <p id={`stock-delta-error-${productId}`} role="alert" className="mt-1 font-mono text-xs text-danger">
          {error.code === "STOCK_ADJUSTMENT_REJECTED"
            ? `That would leave stock negative (currently ${String(error.stockQty ?? currentStock)}, requested ${String(error.delta ?? delta)}).`
            : error.code === "PRODUCT_UNAVAILABLE"
              ? "That product no longer exists."
              : error.message}
        </p>
      )}
    </div>
  );
}

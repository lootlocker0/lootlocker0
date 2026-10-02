"use client";

import { useEffect, useState } from "react";
import { ShardButton } from "@/components/ui/ShardButton";
import { formatCents } from "@/lib/money";
import { adminFetch } from "./adminApi";

type SaleProduct = {
  id: string;
  name: string;
  stockQty: number;
};

type SaleResponse = {
  productId: string;
  productName: string;
  qty: number;
  saleTotalCents: number;
  stockQty: number;
};

function parseSaleTotalCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [dollars, fraction = ""] = trimmed.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 2_147_483_647 ? cents : null;
}

export function ManualSaleForm({
  onUnauthorized,
  onRecorded,
}: {
  onUnauthorized: () => void;
  onRecorded: () => void;
}) {
  const [products, setProducts] = useState<SaleProduct[] | null>(null);
  const [productsError, setProductsError] = useState(false);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [saleTotal, setSaleTotal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    fetch("/api/products", { cache: "no-store" })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(String(response.status))),
      )
      .then((data: { products: SaleProduct[] }) => {
        if (!ignore) setProducts(data.products);
      })
      .catch(() => {
        if (!ignore) setProductsError(true);
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function recordSale(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const quantity = Number(qty);
    if (!productId) {
      setError("Choose a product.");
      return;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10_000) {
      setError("Quantity sold must be a whole number from 1 to 10,000.");
      return;
    }
    const saleTotalCents = parseSaleTotalCents(saleTotal);
    if (saleTotalCents === null) {
      setError("Enter the total sale amount in dollars, with up to two decimal places.");
      return;
    }

    setBusy(true);
    const response = await adminFetch<SaleResponse>("/api/admin/sales", {
      method: "POST",
      body: JSON.stringify({ productId, qty: quantity, saleTotalCents }),
    });
    setBusy(false);
    if (!response.ok) {
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      setError(
        response.error.code === "STOCK_ADJUSTMENT_REJECTED"
          ? "Not enough stock to record that sale. Refresh stock and try again."
          : response.error.message,
      );
      return;
    }

    setProducts((current) =>
      current?.map((product) =>
        product.id === response.data.productId
          ? { ...product, stockQty: response.data.stockQty }
          : product,
      ) ?? null,
    );
    setSuccess(
      `Recorded ${response.data.qty} sold for ${formatCents(response.data.saleTotalCents)}. Stock now ${response.data.stockQty}.`,
    );
    setQty("");
    setSaleTotal("");
    onRecorded();
  }

  return (
    <section aria-labelledby="record-sale-heading" className="my-6 border-y border-white/10 py-5">
      <div className="mb-3">
        <h3 id="record-sale-heading" className="font-mono text-sm uppercase text-text">
          Record sale
        </h3>
        <p className="mt-1 text-xs text-text-dim">
          Records units sold and the total received. Inventory is deducted automatically.
        </p>
      </div>

      {productsError && (
        <p role="alert" className="mb-3 text-xs text-danger">Could not load products for sale entry.</p>
      )}
      {products !== null && products.length === 0 && (
        <p className="mb-3 text-xs text-text-dim">No in-stock products are available to sell.</p>
      )}

      <form onSubmit={recordSale} className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-48 flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
          Product
          <select
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
            disabled={products === null || productsError}
            className="h-10 border-2 border-white/10 bg-surface-3 px-2 text-sm text-text focus:border-brand"
          >
            <option value="">Select product</option>
            {products?.map((product) => (
              <option key={product.id} value={product.id} disabled={product.stockQty < 1}>
                {product.name} · stock {product.stockQty}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
          Quantity sold
          <input
            type="number"
            min="1"
            max="10000"
            step="1"
            value={qty}
            onChange={(event) => setQty(event.target.value)}
            className="h-10 w-28 border-2 border-white/10 bg-surface-3 px-2 text-sm text-text focus:border-brand"
          />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
          Total sold for (CAD)
          <input
            type="text"
            inputMode="decimal"
            value={saleTotal}
            onChange={(event) => setSaleTotal(event.target.value)}
            placeholder="0.00"
            className="h-10 w-36 border-2 border-white/10 bg-surface-3 px-2 text-sm text-text focus:border-brand"
          />
        </label>
        <ShardButton type="submit" loading={busy} disabled={products === null || productsError || products.length === 0}>
          Record sale
        </ShardButton>
      </form>

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      {success && <p role="status" className="mt-3 text-xs text-rarity-uncommon">{success}</p>}
    </section>
  );
}
"use client";

import { useEffect, useRef, useState } from "react";
import { ShardButton } from "@/components/ui/ShardButton";
import { formatCents } from "@/lib/money";
import { adminFetch } from "./adminApi";

type SaleProduct = {
  id: string;
  name: string;
  stockQty: number;
};

type SaleLine = {
  id: number;
  productId: string;
  qty: string;
  saleTotal: string;
};

type SaleResponse = {
  items: Array<{
    productId: string;
    productName: string;
    qty: number;
    saleTotalCents: number;
    stockQty: number;
  }>;
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
  const [lines, setLines] = useState<SaleLine[]>([
    { id: 0, productId: "", qty: "", saleTotal: "" },
  ]);
  const nextLineId = useRef(1);
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

  function updateLine(id: number, field: "productId" | "qty" | "saleTotal", value: string) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, [field]: value } : line)),
    );
  }

  function addLine() {
    setLines((current) => [
      ...current,
      { id: nextLineId.current++, productId: "", qty: "", saleTotal: "" },
    ]);
  }

  function removeLine(id: number) {
    setLines((current) => current.filter((line) => line.id !== id));
  }

  async function recordSale(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (lines.length === 0) {
      setError("Add at least one product to the sale.");
      return;
    }
    if (lines.length > 20) {
      setError("A sale can contain at most 20 different products.");
      return;
    }

    const seenProducts = new Set<string>();
    const items: { productId: string; qty: number; saleTotalCents: number }[] = [];

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      if (!line.productId) {
        setError(`Choose a product for line ${lineNumber}.`);
        return;
      }
      if (seenProducts.has(line.productId)) {
        setError("Each product can only appear once in a sale. Combine its quantity into one line.");
        return;
      }
      seenProducts.add(line.productId);

      const quantity = Number(line.qty);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10_000) {
        setError(`Quantity on line ${lineNumber} must be a whole number from 1 to 10,000.`);
        return;
      }
      const saleTotalCents = parseSaleTotalCents(line.saleTotal);
      if (saleTotalCents === null) {
        setError(`Enter the total sale amount for line ${lineNumber}, with up to two decimal places.`);
        return;
      }
      items.push({ productId: line.productId, qty: quantity, saleTotalCents });
    }

    setBusy(true);
    const response = await adminFetch<SaleResponse>("/api/admin/sales", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    setBusy(false);
    if (!response.ok) {
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      setError(
        response.error.code === "STOCK_ADJUSTMENT_REJECTED"
          ? "Not enough stock for one or more products. No items were recorded. Refresh stock and try again."
          : response.error.message,
      );
      return;
    }

    const stockById = new Map(response.data.items.map((item) => [item.productId, item.stockQty]));
    setProducts((current) =>
      current?.map((product) => {
        const stockQty = stockById.get(product.id);
        return stockQty === undefined ? product : { ...product, stockQty };
      }) ?? null,
    );
    const totalQty = response.data.items.reduce((sum, item) => sum + item.qty, 0);
    const totalSaleCents = response.data.items.reduce((sum, item) => sum + item.saleTotalCents, 0);
    setSuccess(
      `Recorded ${totalQty} units across ${response.data.items.length} products for ${formatCents(totalSaleCents)}.`,
    );
    setLines([{ id: 0, productId: "", qty: "", saleTotal: "" }]);
    onRecorded();
  }

  return (
    <section aria-labelledby="record-sale-heading" className="my-6 border-y border-white/10 py-5">
      <div className="mb-3">
        <h3 id="record-sale-heading" className="font-mono text-sm uppercase text-text">
          Record sale
        </h3>
        <p className="mt-1 text-xs text-text-dim">
          Add one or more products. Enter quantity and the total received for each product; stock is deducted together.
        </p>
      </div>

      {productsError && (
        <p role="alert" className="mb-3 text-xs text-danger">Could not load products for sale entry.</p>
      )}
      {products !== null && products.length === 0 && (
        <p className="mb-3 text-xs text-text-dim">No in-stock products are available to sell.</p>
      )}

      <form onSubmit={recordSale} className="space-y-4">
        {lines.map((line, index) => {
          const selectedElsewhere = new Set(
            lines.filter((other) => other.id !== line.id).map((other) => other.productId),
          );
          return (
            <fieldset
              key={line.id}
              className="flex flex-wrap items-end gap-3 border border-white/10 bg-surface-2 p-3"
            >
              <legend className="px-1 font-mono text-[10px] uppercase text-text-faint">
                Product {index + 1}
              </legend>
              <label className="flex min-w-48 flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
                Product
                <select
                  value={line.productId}
                  onChange={(event) => updateLine(line.id, "productId", event.target.value)}
                  disabled={products === null || productsError}
                  className="h-10 border-2 border-white/10 bg-surface-3 px-2 text-sm text-text focus:border-brand"
                >
                  <option value="">Select product</option>
                  {products?.map((product) => (
                    <option
                      key={product.id}
                      value={product.id}
                      disabled={product.stockQty < 1 || selectedElsewhere.has(product.id)}
                    >
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
                  value={line.qty}
                  onChange={(event) => updateLine(line.id, "qty", event.target.value)}
                  className="h-10 w-28 border-2 border-white/10 bg-surface-3 px-2 text-sm text-text focus:border-brand"
                />
              </label>
              <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
                Total sold for (CAD)
                <input
                  type="text"
                  inputMode="decimal"
                  value={line.saleTotal}
                  onChange={(event) => updateLine(line.id, "saleTotal", event.target.value)}
                  placeholder="0.00"
                  className="h-10 w-36 border-2 border-white/10 bg-surface-3 px-2 text-sm text-text focus:border-brand"
                />
              </label>
              {lines.length > 1 && (
                <ShardButton type="button" size="sm" intent="ghost" onClick={() => removeLine(line.id)}>
                  Remove
                </ShardButton>
              )}
            </fieldset>
          );
        })}

        <div className="flex flex-wrap gap-3">
          <ShardButton
            type="button"
            size="sm"
            intent="ghost"
            onClick={addLine}
            disabled={lines.length >= 20 || busy}
          >
            Add product
          </ShardButton>
          <ShardButton
            type="submit"
            loading={busy}
            disabled={products === null || productsError || products.length === 0}
          >
            Record sale
          </ShardButton>
        </div>
      </form>

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      {success && <p role="status" className="mt-3 text-xs text-rarity-uncommon">{success}</p>}
    </section>
  );
}

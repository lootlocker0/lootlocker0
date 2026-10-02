"use client";

import { useEffect, useMemo, useState } from "react";
import type { Allergen, Rarity } from "@prisma/client";
import { ShardButton } from "@/components/ui/ShardButton";
import { formatCents } from "@/lib/money";
import { rarityMeta } from "@/lib/rarity";
import { adminFetch } from "./adminApi";
import type { AdminApiError, AdminOrdersResponse } from "./types";

type CatalogProduct = {
  id: string;
  name: string;
  priceCents: number;
  category: string;
  rarity: Rarity;
  allergens: Allergen[];
  stockQty: number;
};

type AdjustRow = {
  productId: string;
  name: string;
  rarity: Rarity | null;
  allergens: Allergen[];
  knownStock: number | null;
};

type StockHistoryEntry = {
  id: string;
  source: "PURCHASE" | "ADJUSTMENT" | "SALE";
  direction: "IN" | "OUT";
  qtyDelta: number;
  unitCostCents: number | null;
  saleTotalCents: number | null;
  stockQtyAfter: number | null;
  orderNumber: string | null;
  orderStatus: string | null;
  createdAt: string;
};

type StockHistoryResponse = {
  transactions: StockHistoryEntry[];
  hasMore: boolean;
};

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: StockHistoryResponse };

/**
 * Products come from the live catalog unioned with today's pick list. This
 * includes products sold out/deactivated after orders today, but not products
 * that are inactive and have no orders today.
 */
export function StockAdjuster({
  ordersData,
  onUnauthorized,
}: {
  ordersData: AdminOrdersResponse;
  onUnauthorized: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogProduct[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);

  useEffect(() => {
    let ignore = false;
    fetch("/api/products", { cache: "no-store" })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(String(response.status))),
      )
      .then((data: { products: CatalogProduct[] }) => {
        if (!ignore) setCatalog(data.products);
      })
      .catch(() => {
        if (!ignore) setCatalogError(true);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const rows = useMemo<AdjustRow[]>(() => {
    const byId = new Map<string, AdjustRow>();
    for (const product of catalog ?? []) {
      byId.set(product.id, {
        productId: product.id,
        name: product.name,
        rarity: product.rarity,
        allergens: product.allergens,
        knownStock: product.stockQty,
      });
    }
    for (const slot of ordersData.slots) {
      for (const productTotal of slot.productTotals) {
        if (!byId.has(productTotal.productId)) {
          byId.set(productTotal.productId, {
            productId: productTotal.productId,
            name: productTotal.nameSnapshot,
            rarity: null,
            allergens: productTotal.allergens,
            knownStock: null,
          });
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog, ordersData]);

  return (
    <div>
      <h2 className="font-display text-headline-lg uppercase text-text">Stock ledger</h2>
      <p className="mt-2 max-w-2xl text-sm text-text-dim">
        Sales are recorded from orders. Use Add or Remove for manual stock changes; supplier purchases
        only add stock.
      </p>
      <p className="mt-3 max-w-2xl border-l-2 border-brand pl-3 text-xs text-text-faint">
        Corrections must match the physical shelf count. Failed or expired card orders release their
        reserved stock automatically; do not manually reverse an order reservation.
      </p>
      <p className="mt-2 max-w-2xl border-2 border-white/10 bg-surface-2 p-3 text-xs text-text-faint">
        This list is products currently for sale, plus anything ordered today that has since sold out or
        been deactivated. Products inactive with no orders today are not included.
      </p>

      {catalogError && (
        <p role="alert" className="mt-4 border-2 border-danger p-3 text-sm text-danger">
          Could not load the live catalog. Items ordered today are still listed below.
        </p>
      )}
      {catalog === null && !catalogError && (
        <p role="status" className="mt-4 text-sm text-text-dim">Loading catalog…</p>
      )}
      {rows.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {rows.map((row) => (
            <StockRow key={row.productId} row={row} onUnauthorized={onUnauthorized} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StockRow({
  row,
  onUnauthorized,
}: {
  row: AdjustRow;
  onUnauthorized: () => void;
}) {
  const [adjustmentQty, setAdjustmentQty] = useState("");
  const [adjustmentDirection, setAdjustmentDirection] = useState<1 | -1>(1);
  const [purchaseQty, setPurchaseQty] = useState("");
  const [unitCostCents, setUnitCostCents] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [result, setResult] = useState<{ previous: number; next: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryState | null>(null);

  async function loadHistory() {
    setHistory({ status: "loading" });
    const response = await adminFetch<StockHistoryResponse>(
      `/api/admin/products/${row.productId}/transactions?take=100`,
    );
    if (!response.ok) {
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      setHistory({ status: "error", message: response.error.message });
      return;
    }
    setHistory({ status: "ready", data: response.data });
  }

  async function saveStock(body: { delta: number; type?: "PURCHASE"; unitCostCents?: number }) {
    setBusy(true);
    setError(null);
    const response = await adminFetch<{ stockQty: number; previousStockQty: number }>(
      `/api/admin/products/${row.productId}/stock`,
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!response.ok) {
      if (response.status === 401) {
        onUnauthorized();
        return false;
      }
      setError(response.error);
      return false;
    }
    setResult({ previous: response.data.previousStockQty, next: response.data.stockQty });
    if (historyOpen) void loadHistory();
    return true;
  }

  async function applyAdjustment(event: React.FormEvent) {
    event.preventDefault();
    const value = adjustmentQty.trim();
    const quantity = Number(value);
    if (value === "" || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 10_000) {
      setError({ code: "INVALID_INPUT", message: "Enter a whole quantity from 1 to 10,000." });
      return;
    }
    if (await saveStock({ delta: adjustmentDirection * quantity })) setAdjustmentQty("");
  }

  async function applyPurchase(event: React.FormEvent) {
    event.preventDefault();
    const quantity = Number(purchaseQty.trim());
    const cost = Number(unitCostCents.trim());
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 10_000) {
      setError({ code: "INVALID_INPUT", message: "Purchase quantity must be a whole number from 1 to 10,000." });
      return;
    }
    if (unitCostCents.trim() === "" || !Number.isSafeInteger(cost) || cost < 0) {
      setError({ code: "INVALID_INPUT", message: "Enter unit cost as non-negative integer cents." });
      return;
    }
    const saved = await saveStock({ delta: quantity, type: "PURCHASE", unitCostCents: cost });
    if (saved) {
      setPurchaseQty("");
      setUnitCostCents("");
    }
  }

  function toggleHistory() {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (opening && history === null) void loadHistory();
  }

  return (
    <li className="clip-panel border-2 border-white/10 bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[12rem] flex-1">
          <p className="font-mono text-sm text-text">{row.name}</p>
          <p className="font-mono text-[11px] text-text-faint">
            {result
              ? `Currently ${result.next}`
              : row.knownStock === null
                ? "Stock unknown — not in the live catalog read"
                : `Currently ${row.knownStock}`}
            {row.allergens.length > 0 && (
              <span className="font-bold text-danger"> · {row.allergens.join(", ")}</span>
            )}
          </p>
        </div>
        {row.rarity && (
          <span
            className="w-fit px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-void"
            style={{ background: rarityMeta(row.rarity).hex }}
          >
            {rarityMeta(row.rarity).label}
          </span>
        )}
        {result && (
          <span className="font-mono text-xs text-rarity-uncommon">
            Latest stock: {result.previous} → {result.next}
          </span>
        )}
        <ShardButton type="button" size="sm" intent="ghost" onClick={toggleHistory}>
          {historyOpen ? "Hide history" : "View history"}
        </ShardButton>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <form onSubmit={applyAdjustment} className="flex flex-wrap items-end gap-2 border-t border-white/10 pt-3">
          <p className="w-full font-mono text-[11px] uppercase text-text-dim">Stock change</p>
          <div className="flex h-9" role="group" aria-label={`Stock change direction for ${row.name}`}>
            <button
              type="button"
              aria-pressed={adjustmentDirection === 1}
              onClick={() => setAdjustmentDirection(1)}
              className={`border-2 px-3 font-mono text-xs uppercase ${adjustmentDirection === 1 ? "border-brand bg-brand/10 text-brand" : "border-white/10 text-text-dim hover:border-brand"}`}
            >
              + Add
            </button>
            <button
              type="button"
              aria-pressed={adjustmentDirection === -1}
              onClick={() => setAdjustmentDirection(-1)}
              className={`border-2 border-l-0 px-3 font-mono text-xs uppercase ${adjustmentDirection === -1 ? "border-brand bg-brand/10 text-brand" : "border-white/10 text-text-dim hover:border-brand"}`}
            >
              − Remove
            </button>
          </div>
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
            Quantity
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="10000"
              step="1"
              value={adjustmentQty}
              onChange={(event) => setAdjustmentQty(event.target.value)}
              aria-label={`Quantity to ${adjustmentDirection === 1 ? "add to" : "remove from"} ${row.name}`}
              className="w-28 border-2 border-white/10 bg-surface-3 px-2 py-1 text-sm text-text focus:border-brand"
            />
          </label>
          <ShardButton type="submit" size="sm" loading={busy}>
            {adjustmentDirection === 1 ? "Add stock" : "Deduct stock"}
          </ShardButton>
        </form>

        <form onSubmit={applyPurchase} className="flex flex-wrap items-end gap-2 border-t border-white/10 pt-3">
          <p className="w-full font-mono text-[11px] uppercase text-text-dim">Supplier purchase</p>
          <p className="w-full -mt-1 text-xs text-text-faint">
            Purchases only add stock. Choose Remove above to deduct a quantity.
          </p>
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
            Quantity
            <input
              type="number"
              min="1"
              max="10000"
              step="1"
              value={purchaseQty}
              onChange={(event) => setPurchaseQty(event.target.value)}
              aria-label={`Purchase quantity for ${row.name}`}
              className="w-24 border-2 border-white/10 bg-surface-3 px-2 py-1 text-sm text-text focus:border-brand"
            />
          </label>
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-text-faint">
            Unit cost (cents)
            <input
              type="number"
              min="0"
              max="2147483647"
              step="1"
              value={unitCostCents}
              onChange={(event) => setUnitCostCents(event.target.value)}
              aria-label={`Unit cost in cents for ${row.name}`}
              className="w-32 border-2 border-white/10 bg-surface-3 px-2 py-1 text-sm text-text focus:border-brand"
            />
          </label>
          <ShardButton type="submit" size="sm" loading={busy}>Record purchase</ShardButton>
        </form>
      </div>

      {error && (
        <p role="alert" className="mt-2 font-mono text-xs text-danger">
          {error.code === "STOCK_ADJUSTMENT_REJECTED"
            ? `That would leave stock negative (currently ${String(error.stockQty ?? "?")}, requested ${String(error.delta ?? "?")}).`
            : error.code === "PRODUCT_UNAVAILABLE"
              ? "That product no longer exists."
              : error.message}
        </p>
      )}

      {historyOpen && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <h3 className="font-mono text-xs uppercase text-text">Latest quantity changes</h3>
          {history?.status === "loading" && (
            <p role="status" className="mt-2 text-xs text-text-dim">Loading history…</p>
          )}
          {history?.status === "error" && (
            <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 text-xs text-danger">
              {history.message}
              <ShardButton type="button" size="sm" onClick={() => void loadHistory()}>Retry</ShardButton>
            </div>
          )}
          {history?.status === "ready" && (
            <>
              {history.data.transactions.length === 0 ? (
                <p className="mt-2 text-xs text-text-dim">No stock changes or completed orders recorded.</p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[38rem] border-collapse text-left font-mono text-xs">
                    <thead className="text-[10px] uppercase text-text-faint">
                      <tr>
                        <th className="border-b border-white/10 px-2 py-2">When</th>
                        <th className="border-b border-white/10 px-2 py-2">Source</th>
                        <th className="border-b border-white/10 px-2 py-2">Change</th>
                        <th className="border-b border-white/10 px-2 py-2">Amount</th>
                        <th className="border-b border-white/10 px-2 py-2">Stock after</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.data.transactions.map((entry) => (
                        <tr key={`${entry.source}-${entry.id}`}>
                          <td className="border-b border-white/5 px-2 py-2 text-text-dim">
                            {new Date(entry.createdAt).toLocaleString()}
                          </td>
                          <td className="border-b border-white/5 px-2 py-2 text-text">
                            {entry.source === "SALE"
                              ? `Order ${entry.orderNumber} · ${entry.orderStatus}`
                              : entry.source === "PURCHASE"
                                ? "Supplier purchase"
                                : "Stock adjustment"}
                          </td>
                          <td className={`border-b border-white/5 px-2 py-2 ${entry.direction === "IN" ? "text-rarity-uncommon" : "text-danger"}`}>
                            {entry.direction === "IN" ? "+" : "-"}{Math.abs(entry.qtyDelta)}
                          </td>
                          <td className="border-b border-white/5 px-2 py-2 text-text-dim">
                            {entry.source === "PURCHASE"
                              ? entry.unitCostCents === null ? "—" : `Unit ${formatCents(entry.unitCostCents)}`
                              : entry.source === "SALE"
                                ? entry.saleTotalCents === null ? "—" : formatCents(entry.saleTotalCents)
                                : "—"}
                          </td>
                          <td className="border-b border-white/5 px-2 py-2 text-text-dim">
                            {entry.stockQtyAfter ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {history.data.hasMore && (
                <p className="mt-2 text-[11px] text-text-faint">Showing the latest 100 records.</p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
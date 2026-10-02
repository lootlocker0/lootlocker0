"use client";

import { useEffect, useState } from "react";
import { ShardButton } from "@/components/ui/ShardButton";
import { formatCents } from "@/lib/money";
import { adminFetch } from "./adminApi";

type TransactionSource = "PURCHASE" | "ADJUSTMENT" | "SALE";
type TransactionFilter = "ALL" | TransactionSource;

type Transaction = {
  id: string;
  productId: string;
  productName: string;
  source: TransactionSource;
  direction: "IN" | "OUT";
  qtyDelta: number;
  unitCostCents: number | null;
  stockQtyAfter: number | null;
  orderNumber: string | null;
  orderStatus: string | null;
  createdAt: string;
};

type TransactionsResponse = {
  transactions: Transaction[];
  hasMore: boolean;
};

type TransactionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: TransactionsResponse };

const FILTERS: { value: TransactionFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PURCHASE", label: "Purchases" },
  { value: "ADJUSTMENT", label: "Adjustments" },
  { value: "SALE", label: "Sales" },
];

export function TransactionsList({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [state, setState] = useState<TransactionsState>({ status: "loading" });
  const [filter, setFilter] = useState<TransactionFilter>("ALL");
  const [take, setTake] = useState(100);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setState({ status: "loading" });
      const response = await adminFetch<TransactionsResponse>(
        `/api/admin/transactions?take=${take}`,
      );
      if (ignore) return;
      if (!response.ok) {
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        setState({ status: "error", message: response.error.message });
        return;
      }
      setState({ status: "ready", data: response.data });
    }

    void load();
    return () => {
      ignore = true;
    };
  }, [take, refreshToken, onUnauthorized]);

  function refresh() {
    setTake(100);
    setRefreshToken((current) => current + 1);
  }

  const entries =
    state.status === "ready"
      ? state.data.transactions.filter((entry) => filter === "ALL" || entry.source === filter)
      : [];

  return (
    <section aria-labelledby="transactions-heading" className="admin-no-print">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <h2 id="transactions-heading" className="font-display text-headline-lg uppercase text-text">
            Transactions
          </h2>
          <p className="mt-1 text-sm text-text-dim">
            Purchases, physical stock changes, and recorded sales, newest first.
          </p>
        </div>
        <ShardButton type="button" size="sm" intent="ghost" onClick={refresh}>
          Refresh
        </ShardButton>
      </div>

      <div className="my-4 flex flex-wrap gap-2" role="group" aria-label="Filter transactions">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
            className={`border-2 px-3 py-2 font-mono text-xs uppercase transition-colors ${
              filter === option.value
                ? "border-brand bg-brand/10 text-brand"
                : "border-white/10 text-text-dim hover:border-brand hover:text-brand"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {state.status === "loading" && (
        <p role="status" className="py-8 text-sm text-text-dim">Loading transactions…</p>
      )}
      {state.status === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-2 border-danger p-4 text-sm text-danger">
          {state.message}
          <ShardButton type="button" size="sm" onClick={refresh}>Retry</ShardButton>
        </div>
      )}
      {state.status === "ready" && (
        <>
          {entries.length === 0 ? (
            <p className="border-y border-white/10 py-8 text-sm text-text-dim">
              {state.data.transactions.length === 0
                ? "No transactions have been recorded yet."
                : "No transactions match this filter."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] border-collapse text-left font-mono text-xs">
                <thead className="text-[10px] uppercase text-text-faint">
                  <tr>
                    <th className="border-b border-white/10 px-3 py-3">Date</th>
                    <th className="border-b border-white/10 px-3 py-3">Product</th>
                    <th className="border-b border-white/10 px-3 py-3">Type</th>
                    <th className="border-b border-white/10 px-3 py-3">Quantity</th>
                    <th className="border-b border-white/10 px-3 py-3">Unit cost</th>
                    <th className="border-b border-white/10 px-3 py-3">Stock after</th>
                    <th className="border-b border-white/10 px-3 py-3">Order</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={`${entry.source}-${entry.id}`}>
                      <td className="border-b border-white/5 px-3 py-3 whitespace-nowrap text-text-dim">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="border-b border-white/5 px-3 py-3 text-text">{entry.productName}</td>
                      <td className="border-b border-white/5 px-3 py-3 text-text-dim">
                        {entry.source === "SALE"
                          ? `Sale · ${entry.orderStatus}`
                          : entry.source === "PURCHASE"
                            ? "Supplier purchase"
                            : "Adjustment"}
                      </td>
                      <td className={`border-b border-white/5 px-3 py-3 ${entry.direction === "IN" ? "text-rarity-uncommon" : "text-danger"}`}>
                        {entry.direction === "IN" ? "+" : "−"}{Math.abs(entry.qtyDelta)}
                      </td>
                      <td className="border-b border-white/5 px-3 py-3 text-text-dim">
                        {entry.unitCostCents === null ? "—" : formatCents(entry.unitCostCents)}
                      </td>
                      <td className="border-b border-white/5 px-3 py-3 text-text-dim">
                        {entry.stockQtyAfter ?? "—"}
                      </td>
                      <td className="border-b border-white/5 px-3 py-3 text-text-dim">
                        {entry.orderNumber ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
            <p className="text-xs text-text-faint">
              Showing {state.data.transactions.length} of the latest {take} loaded records.
            </p>
            {state.data.hasMore && take < 500 && (
              <ShardButton type="button" size="sm" intent="ghost" onClick={() => setTake((current) => Math.min(current + 100, 500))}>
                Load older
              </ShardButton>
            )}
          </div>
        </>
      )}
    </section>
  );
}
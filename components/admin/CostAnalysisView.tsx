"use client";

import { useEffect, useState } from "react";
import { ShardButton } from "@/components/ui/ShardButton";
import { formatCents } from "@/lib/money";
import { adminFetch } from "./adminApi";

type Purchase = {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  quantityLeft: number;
  totalCostCents: number | null;
  unitCostCents: number | null;
  currentSellingPriceCents: number;
  projectedProfitCents: number | null;
  actualProfitCents: number | null;
  date: string;
  lastUpdated: string;
};

type OrderCost = {
  orderNumber: string;
  date: string;
  itemsSold: number;
  cogsCents: number | null;
  revenueCents: number;
  profitCents: number | null;
  costBasisComplete: boolean;
};

type CostAnalysisResponse = {
  purchases: Purchase[];
  orders: OrderCost[];
};

type CostAnalysisState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: CostAnalysisResponse };

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function ProfitValue({ cents }: { cents: number | null }) {
  if (cents === null) {
    return <span className="text-text-faint">Unavailable</span>;
  }

  return (
    <span className={cents >= 0 ? "text-rarity-uncommon" : "text-danger"}>
      {formatCents(cents)}
    </span>
  );
}

export function CostAnalysisView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [state, setState] = useState<CostAnalysisState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setState({ status: "loading" });
      const response = await adminFetch<CostAnalysisResponse>("/api/admin/cost-analysis");
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
  }, [onUnauthorized, refreshKey]);

  return (
    <section aria-labelledby="cost-analysis-heading" className="admin-no-print space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <h2 id="cost-analysis-heading" className="font-display text-headline-lg uppercase text-text">
            Cost analysis
          </h2>
          <p className="mt-1 text-sm text-text-dim">
            Purchase costs, selling prices, and profit for recorded orders.
          </p>
        </div>
        <ShardButton type="button" size="sm" intent="ghost" onClick={() => setRefreshKey((n) => n + 1)}>
          Refresh
        </ShardButton>
      </div>

      {state.status === "loading" && (
        <p role="status" className="text-sm text-text-dim">Loading cost analysis…</p>
      )}

      {state.status === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-2 border-danger p-4 text-sm text-danger">
          {state.message}
          <ShardButton type="button" size="sm" onClick={() => setRefreshKey((n) => n + 1)}>
            Retry
          </ShardButton>
        </div>
      )}

      {state.status === "ready" && (
        <>
          <section aria-labelledby="purchase-analysis-heading">
            <div className="mb-3">
              <h3 id="purchase-analysis-heading" className="font-mono text-sm uppercase text-text">
                Purchases
              </h3>
              <p className="mt-1 text-xs text-text-dim">
                Purchases are combined by product. Estimated profit assumes every purchased unit sells at
                the current price; actual profit starts at the combined purchase cost and adds revenue as
                sales are recorded. Stock changes are allocated to purchase lots in FIFO order.
              </p>
            </div>
            {state.data.purchases.length === 0 ? (
              <p className="border-y border-white/10 py-6 text-sm text-text-dim">
                No purchases have been recorded yet. New product stock purchases will appear here.
              </p>
            ) : (
              <div className="overflow-x-auto border border-white/10 bg-surface-2">
                <table className="min-w-full border-collapse text-left font-mono text-xs">
                  <thead className="text-[10px] uppercase text-text-faint">
                    <tr>
                      <th className="border-b border-white/10 px-3 py-3">Date</th>
                      <th className="border-b border-white/10 px-3 py-3">Product</th>
                      <th className="border-b border-white/10 px-3 py-3">Quantity</th>
                      <th className="border-b border-white/10 px-3 py-3">Quantity left</th>
                      <th className="border-b border-white/10 px-3 py-3">Total cost</th>
                      <th className="border-b border-white/10 px-3 py-3">Avg per item</th>
                      <th className="border-b border-white/10 px-3 py-3">Selling price</th>
                      <th className="border-b border-white/10 px-3 py-3">Projected profit</th>
                      <th className="border-b border-white/10 px-3 py-3">Actual profit</th>
                      <th className="border-b border-white/10 px-3 py-3">Last updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.data.purchases.map((purchase) => (
                      <tr key={purchase.id}>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {formatDate(purchase.date)}
                        </td>
                        <td className="border-b border-white/5 px-3 py-3 text-text">{purchase.productName}</td>
                        <td className="border-b border-white/5 px-3 py-3 text-text-dim">{purchase.quantity}</td>
                        <td className="border-b border-white/5 px-3 py-3 text-text-dim">{purchase.quantityLeft}</td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {purchase.totalCostCents === null ? (
                            <span className="text-text-faint">Unavailable</span>
                          ) : formatCents(purchase.totalCostCents)}
                        </td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {purchase.unitCostCents === null ? (
                            <span className="text-text-faint">Unavailable</span>
                          ) : formatCents(purchase.unitCostCents)}
                        </td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {formatCents(purchase.currentSellingPriceCents)}
                        </td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3">
                          <ProfitValue cents={purchase.projectedProfitCents} />
                        </td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3">
                          <ProfitValue cents={purchase.actualProfitCents} />
                        </td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {formatDate(purchase.lastUpdated)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="order-analysis-heading">
            <div className="mb-3">
              <h3 id="order-analysis-heading" className="font-mono text-sm uppercase text-text">
                Orders
              </h3>
              <p className="mt-1 text-xs text-text-dim">
                Order profit is revenue minus the recorded purchase cost of the items sold.
              </p>
            </div>
            {state.data.orders.length === 0 ? (
              <p className="border-y border-white/10 py-6 text-sm text-text-dim">
                No order sales are available for cost analysis.
              </p>
            ) : (
              <div className="overflow-x-auto border border-white/10 bg-surface-2">
                <table className="min-w-full border-collapse text-left font-mono text-xs">
                  <thead className="text-[10px] uppercase text-text-faint">
                    <tr>
                      <th className="border-b border-white/10 px-3 py-3">Order</th>
                      <th className="border-b border-white/10 px-3 py-3">Date</th>
                      <th className="border-b border-white/10 px-3 py-3">Items sold</th>
                      <th className="border-b border-white/10 px-3 py-3">Total cost</th>
                      <th className="border-b border-white/10 px-3 py-3">Revenue</th>
                      <th className="border-b border-white/10 px-3 py-3">Total profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.data.orders.map((order) => (
                      <tr key={order.orderNumber}>
                        <td className="border-b border-white/5 px-3 py-3 text-text">{order.orderNumber}</td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {formatDate(order.date)}
                        </td>
                        <td className="border-b border-white/5 px-3 py-3 text-text-dim">{order.itemsSold}</td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {order.cogsCents === null ? "Unavailable" : formatCents(order.cogsCents)}
                        </td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3 text-text-dim">
                          {formatCents(order.revenueCents)}
                        </td>
                        <td className="whitespace-nowrap border-b border-white/5 px-3 py-3">
                          <ProfitValue cents={order.profitCents} />
                          {!order.costBasisComplete && (
                            <span className="ml-2 text-text-faint" title="At least one item has no recorded purchase cost">
                              (incomplete cost history)
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShardButton } from "@/components/ui/ShardButton";
import { adminFetch, type AdminResult } from "./adminApi";
import { PickList } from "./PickList";
import { StockAdjuster } from "./StockAdjuster";
import type { AdminOrdersResponse } from "./types";

type OrdersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: AdminOrdersResponse };

// docs/API-CONTRACT.md §6a: PENDING is excluded by default because a
// printed sheet containing an unpaid card order is a bag handed to a
// student who never paid. "Show unpaid" below adds it back for on-screen
// awareness only — the print stylesheet still hides the action chrome, and
// staff should never pack against a PENDING line regardless of this toggle.
const DEFAULT_STATUSES = "RESERVED,PAID,PACKED,PICKED_UP,REFUNDED";

/** No setState in here — pure fetch, reused by both the effect and the
 * manually-triggered `load()` below. */
function fetchAdminOrders(
  date: string,
  showPending: boolean,
): Promise<AdminResult<AdminOrdersResponse>> {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  params.set("status", showPending ? `${DEFAULT_STATUSES},PENDING` : DEFAULT_STATUSES);
  return adminFetch<AdminOrdersResponse>(`/api/admin/orders?${params.toString()}`);
}

/**
 * Signed-in shell: date/status controls, the pick list, and the stock
 * adjuster. Any authenticated fetch that comes back 401 (session expired
 * mid-shift, secret rotated, second staff phone logged out) calls
 * `onUnauthorized`, which drops the whole tree back to `AdminSignIn` — this
 * is the actual authorization boundary, not the Server Component's cookie
 * check (docs/API-CONTRACT.md §6a).
 */
export function Dashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [showPending, setShowPending] = useState(false);
  const [state, setState] = useState<OrdersState>({ status: "loading" });
  const [signingOut, setSigningOut] = useState(false);

  // Mount + filter-change fetch. The fetch/setState pair lives inline in the
  // effect body (not behind a useCallback invoked from the effect) with the
  // standard "ignore" cleanup flag — same shape as
  // components/hooks/useLiveProducts.ts / useSlots.ts, for the same reason:
  // this is what react-hooks/set-state-in-effect expects from a legitimate
  // data-fetching effect, not the cascading-render pattern it actually
  // flags.
  useEffect(() => {
    let ignore = false;

    async function run() {
      setState((s) => (s.status === "ready" ? s : { status: "loading" }));
      const res = await fetchAdminOrders(date, showPending);
      if (ignore) return;
      if (!res.ok) {
        if (res.status === 401) {
          onUnauthorized();
          return;
        }
        setState({ status: "error", message: res.error.message });
        return;
      }
      setState({ status: "ready", data: res.data });
    }

    run();
    return () => {
      ignore = true;
    };
  }, [date, showPending, onUnauthorized]);

  // User-initiated refetch: the Refresh button, the Retry button, and every
  // order/stock action's "reload after a successful mutation" callback. Not
  // called from inside an effect, so it's fine as a useCallback reference.
  const load = useCallback(async () => {
    const res = await fetchAdminOrders(date, showPending);
    if (!res.ok) {
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      setState({ status: "error", message: res.error.message });
      return;
    }
    setState({ status: "ready", data: res.data });
  }, [date, showPending, onUnauthorized]);

  useEffect(() => {
    let inFlight = false;

    async function refreshWhenVisible() {
      if (document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      try {
        await load();
      } finally {
        inFlight = false;
      }
    }

    const interval = window.setInterval(refreshWhenVisible, 10_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [load]);

  async function signOut() {
    setSigningOut(true);
    await adminFetch("/api/admin/logout", { method: "POST" });
    setSigningOut(false);
    // Drop back to the sign-in form immediately, and re-derive the
    // Server Component's cookie-presence hint so a hard refresh of this
    // page agrees with what's already on screen.
    onUnauthorized();
    router.refresh();
  }

  return (
    <div className="admin-print-root min-h-screen bg-void">
      <header className="admin-no-print sticky top-0 z-40 flex flex-wrap items-center justify-between gap-4 border-b border-white/5 bg-surface px-4 py-4 sm:px-8">
        <h1 className="font-display text-headline-md uppercase text-brand">
          LootLockers Staff
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 font-mono text-xs uppercase text-text-dim">
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Service date"
              className="border-2 border-white/10 bg-surface-2 px-2 py-1 text-text focus:border-brand"
            />
          </label>
          <label className="flex items-center gap-2 font-mono text-xs uppercase text-text-dim">
            <input
              type="checkbox"
              checked={showPending}
              onChange={(e) => setShowPending(e.target.checked)}
            />
            Show unpaid (pending)
          </label>
          <ShardButton size="sm" intent="ghost" onClick={load}>
            Refresh
          </ShardButton>
          <ShardButton size="sm" intent="ghost" onClick={() => window.print()}>
            Print pick list
          </ShardButton>
          <ShardButton size="sm" intent="ghost" loading={signingOut} onClick={signOut}>
            Sign out
          </ShardButton>
        </div>
      </header>

      <div className="flex flex-col lg:flex-row">
        <aside className="admin-no-print border-b border-white/10 bg-surface-2 px-4 py-4 lg:min-h-[calc(100vh-81px)] lg:w-64 lg:border-b-0 lg:border-r lg:px-6 lg:py-8">
          <nav aria-label="Staff tools" className="flex gap-2 lg:flex-col">
            <a
              href="/admin"
              aria-current="page"
              className="border-2 border-brand bg-brand/10 px-3 py-2 font-mono text-xs uppercase text-brand"
            >
              Orders
            </a>
            <a
              href="/inventory"
              className="border-2 border-white/10 px-3 py-2 font-mono text-xs uppercase text-text-dim transition-colors hover:border-brand hover:text-brand"
            >
              Catalog / Add product
            </a>
          </nav>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8">
        {state.status === "loading" && (
          <p role="status" className="text-text-dim">
            Loading orders…
          </p>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-4 border-2 border-danger bg-surface-2 p-4 text-danger"
          >
            {state.message}
            <ShardButton size="sm" onClick={load}>
              Retry
            </ShardButton>
          </div>
        )}

        {state.status === "ready" && (
          <>
            <PickList data={state.data} onOrderChanged={load} onUnauthorized={onUnauthorized} />

            <section id="stock-adjustment" className="admin-no-print mt-12 border-t border-white/10 pt-8">
              <StockAdjuster ordersData={state.data} onUnauthorized={onUnauthorized} />
            </section>
          </>
        )}
        </main>
      </div>
    </div>
  );
}

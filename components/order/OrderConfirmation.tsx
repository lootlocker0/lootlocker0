"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Allergen, OrderStatus, PaymentMethod, Rarity } from "@prisma/client";
import { formatCents } from "@/lib/money";
import { rarityMeta } from "@/lib/rarity";
import { formatSlotTime } from "@/lib/timezone";
import { AngledPanel } from "@/components/ui/AngledPanel";
import { ShardButton } from "@/components/ui/ShardButton";
import { ProgressTracker } from "@/components/ui/ProgressTracker";

type OrderItem = {
  productId: string;
  qty: number;
  nameSnapshot: string;
  unitPriceCents: number;
  raritySnapshot: Rarity;
  allergensSnapshot: Allergen[];
};

type OrderPayload = {
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  pickupCode?: string;
  expiresAt: string | null;
  placedAt: string;
  slot: { label: string; startTime: string; location: string; serviceDate: string };
  items: OrderItem[];
};

type ViewState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "fetch_error" }
  | { kind: "order"; order: OrderPayload };

// docs/API-CONTRACT.md §6 "Polling recipe (card)": every 1.5s, for up to 20s,
// then stop assuming and say so rather than spinning forever.
const FAST_POLL_MS = 1_500;
const FAST_POLL_BUDGET_MS = 20_000;

/**
 * `status: "PENDING"` with `expiresAt: null` only happens when the webhook
 * refused a payment whose amount didn't match the order (CLAUDE.md §2.3
 * territory) and parked it out of the sweep's reach for a human. It will
 * never become PAID and will never expire on its own — polling it forever
 * would spin. docs/HANDOFF.md §27.
 */
function isFrozen(o: OrderPayload) {
  return o.status === "PENDING" && o.expiresAt === null;
}

/**
 * Every other PENDING order carries a real `expiresAt`. Once that instant is
 * in the past the order is doomed even if the sweep (every 5 minutes) hasn't
 * caught it yet — treated as expired here rather than waiting for `status`
 * to catch up. docs/HANDOFF.md §27.
 */
function isClockExpired(o: OrderPayload) {
  return (
    o.status === "PENDING" && o.expiresAt !== null && new Date(o.expiresAt).getTime() < Date.now()
  );
}

function isActivelyPending(o: OrderPayload) {
  return o.status === "PENDING" && !isFrozen(o) && !isClockExpired(o);
}

/** Letter-spaced so the code reads clearly out loud at a locker. */
function spacedCode(code: string) {
  return code.split("").join(" ");
}

function formatServiceDate(iso: string) {
  // `serviceDate` is midnight UTC standing in for a calendar day, not a real
  // instant — read with UTC getters, same reasoning as lib/timezone.ts, so
  // this never drifts a day depending on the browser's local zone.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

export function OrderConfirmation({ orderNumber }: { orderNumber: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [checkingAgain, setCheckingAgain] = useState(false);
  const pollStartRef = useRef<number | null>(null);
  const retriedOnceRef = useRef(false);

  async function fetchOrder() {
    try {
      const res = await fetch(`/api/orders/${orderNumber}`, { cache: "no-store" });
      if (res.status === 404) {
        setState({ kind: "not_found" });
        return;
      }
      if (!res.ok) {
        if (!retriedOnceRef.current) {
          retriedOnceRef.current = true;
          await fetchOrder();
          return;
        }
        setState({ kind: "fetch_error" });
        return;
      }
      const order: OrderPayload = await res.json();
      setState({ kind: "order", order });
    } catch {
      if (!retriedOnceRef.current) {
        retriedOnceRef.current = true;
        await fetchOrder();
        return;
      }
      setState({ kind: "fetch_error" });
    }
  }

  // Initial load. orderNumber is fixed for the life of this component (it
  // comes from the URL segment), so this really is a mount-once fetch.
  useEffect(() => {
    fetchOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderNumber]);

  // Self-scheduling poll: only while the order is genuinely, actively
  // pending (not frozen, not already dead by the clock) and only inside the
  // 20s budget. Re-runs every time `state` changes because a fresh fetch
  // produces a fresh `state`, which is exactly when the next tick should be
  // scheduled — a plain setInterval would keep ticking after the order
  // resolves. Whether the budget is exhausted is *derived* below at render
  // time from `pollStartRef` rather than written back into state from here:
  // this effect only ever subscribes to an external timer, it never
  // synchronously calls setState, which is what react-hooks/set-state-in-effect
  // (correctly) flags as a cascading-render risk.
  useEffect(() => {
    if (state.kind !== "order") return;
    const order = state.order;
    if (!isActivelyPending(order)) return;

    if (pollStartRef.current === null) pollStartRef.current = Date.now();
    const elapsed = Date.now() - pollStartRef.current;
    if (elapsed >= FAST_POLL_BUDGET_MS) return;

    const t = setTimeout(fetchOrder, FAST_POLL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function checkAgain() {
    pollStartRef.current = null;
    setCheckingAgain(true);
    fetchOrder().finally(() => setCheckingAgain(false));
  }

  function retryFetch() {
    retriedOnceRef.current = false;
    setState({ kind: "loading" });
    fetchOrder();
  }

  if (state.kind === "loading") {
    return (
      <Shell headline="Order status">
        <p role="status" aria-live="polite" className="mt-4 text-text-dim">
          Loading your order…
        </p>
      </Shell>
    );
  }

  if (state.kind === "not_found") {
    return (
      <Shell headline="Order not found">
        <p role="alert" className="mt-4 max-w-md text-text-dim">
          We can&rsquo;t find that order. It may be on a different device, the
          link may be wrong, or the receipt may have expired.
        </p>
        <Link
          href="/snacks"
          className="clip-shard mx-auto mt-8 inline-flex items-center justify-center bg-gold px-8 py-3 font-display uppercase tracking-wide text-void transition-transform hover:brightness-110 active:scale-[.97]"
        >
          Browse The Loot
        </Link>
      </Shell>
    );
  }

  if (state.kind === "fetch_error") {
    return (
      <Shell headline="Couldn’t load your order">
        <p role="alert" className="mt-4 max-w-md text-text-dim">
          Check your connection and try again.
        </p>
        <ShardButton className="mt-6" onClick={retryFetch}>
          Retry
        </ShardButton>
      </Shell>
    );
  }

  const order = state.order;
  const frozen = isFrozen(order);
  const clockExpired = isClockExpired(order);
  const activelyPending = isActivelyPending(order);
  const showCode = order.pickupCode !== undefined;
  // Derived at render time from the ref the poll effect maintains, rather
  // than mirrored into its own state slot — see the comment on the polling
  // effect above.
  const fastPollExhausted =
    activelyPending &&
    pollStartRef.current !== null &&
    Date.now() - pollStartRef.current >= FAST_POLL_BUDGET_MS;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-8">
      {activelyPending && (
        <ProgressTracker
          className="mb-10"
          steps={[
            { id: "loadout", label: "Loadout", status: "complete" },
            { id: "pickup", label: "Pickup", status: "complete" },
            { id: "confirmed", label: "Confirmed", status: "active" },
          ]}
        />
      )}

      <StatusBanner
        order={order}
        frozen={frozen}
        clockExpired={clockExpired}
        activelyPending={activelyPending}
        fastPollExhausted={fastPollExhausted}
        checkingAgain={checkingAgain}
        onCheckAgain={checkAgain}
      />

      {(order.status === "RESERVED" ||
        order.status === "PAID" ||
        order.status === "PACKED" ||
        order.status === "PICKED_UP") && (
        <AngledPanel variant="card" tone="lowest" border="gold" glow className="mt-6">
          {showCode && (
            <div className="text-center">
              <p className="font-mono text-xs uppercase tracking-wide text-text-faint">
                Pickup code — read this to staff
              </p>
              <p className="mt-2 font-display text-4xl tracking-[0.3em] text-gold">
                {spacedCode(order.pickupCode!)}
              </p>
            </div>
          )}

          <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-white/10 pt-6 font-mono text-sm">
            <div>
              <dt className="text-text-faint">Pickup window</dt>
              <dd className="mt-1 text-text">
                {formatSlotTime(order.slot.startTime)} · {order.slot.label}
              </dd>
            </div>
            <div>
              <dt className="text-text-faint">Location</dt>
              <dd className="mt-1 text-text">{order.slot.location}</dd>
            </div>
            <div>
              <dt className="text-text-faint">Date</dt>
              <dd className="mt-1 text-text">{formatServiceDate(order.slot.serviceDate)}</dd>
            </div>
            <div>
              <dt className="text-text-faint">Order</dt>
              <dd className="mt-1 text-text">{order.orderNumber}</dd>
            </div>
          </dl>
        </AngledPanel>
      )}

      <AngledPanel variant="panel" tone={3} border="brand" className="mt-6">
        <h2 className="font-display text-lg uppercase text-text">Manifest</h2>
        <ul className="mt-4 flex flex-col gap-4">
          {order.items.map((item) => {
            const meta = rarityMeta(item.raritySnapshot);
            return (
              <li key={item.productId} className="flex items-start justify-between gap-4 border-b border-white/5 pb-4 last:border-0 last:pb-0">
                <div>
                  <p className="font-mono text-sm text-text">
                    {item.qty}× {item.nameSnapshot}
                  </p>
                  <span
                    className="mt-1 inline-block px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-void"
                    style={{ background: meta.hex }}
                  >
                    {meta.label}
                  </span>
                  {item.allergensSnapshot.length > 0 ? (
                    <ul className="mt-1 flex flex-wrap gap-1" aria-label="Contains allergens">
                      {item.allergensSnapshot.map((a) => (
                        <li
                          key={a}
                          className="border border-danger/60 px-1.5 py-0.5 font-mono text-[10px] text-danger"
                        >
                          {a.replace(/_/g, " ")}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 font-mono text-[10px] text-rarity-uncommon">
                      No listed allergens
                    </p>
                  )}
                </div>
                <p className="shrink-0 font-mono text-sm text-text">
                  {formatCents(item.unitPriceCents * item.qty)}
                </p>
              </li>
            );
          })}
        </ul>

        <dl className="mt-4 flex flex-col gap-1 border-t border-white/10 pt-4 font-mono text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-text-dim">Subtotal</dt>
            <dd className="text-text">{formatCents(order.subtotalCents)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-text-dim">Tax</dt>
            <dd className="text-text">{formatCents(order.taxCents)}</dd>
          </div>
          <div className="flex items-center justify-between text-base">
            <dt className="text-text">Total</dt>
            <dd className="text-gold">{formatCents(order.totalCents)}</dd>
          </div>
        </dl>
      </AngledPanel>

      <p className="mt-6 text-center text-xs text-text-faint">
        This page is your receipt — no confirmation email is sent. Save or
        screenshot this before you close the tab.
      </p>

      <div className="mt-8 text-center">
        <Link
          href="/snacks"
          className="clip-shard inline-flex items-center justify-center bg-gold px-8 py-3 font-display uppercase tracking-wide text-void transition-transform hover:brightness-110 active:scale-[.97]"
        >
          Back to The Loot
        </Link>
      </div>
    </div>
  );
}

function StatusBanner({
  order,
  frozen,
  clockExpired,
  activelyPending,
  fastPollExhausted,
  checkingAgain,
  onCheckAgain,
}: {
  order: OrderPayload;
  frozen: boolean;
  clockExpired: boolean;
  activelyPending: boolean;
  fastPollExhausted: boolean;
  checkingAgain: boolean;
  onCheckAgain: () => void;
}) {
  const showCode = order.pickupCode !== undefined;

  if (frozen) {
    return (
      <Banner tone="danger" headline="See staff to finish this order">
        Something didn&rsquo;t match up when your payment was processed. This
        order needs a person to sort out — it will not resolve on its own.
        Bring your order number,{" "}
        <span className="font-mono text-text">{order.orderNumber}</span>, to
        staff.
      </Banner>
    );
  }

  if (clockExpired || order.status === "EXPIRED") {
    return (
      <Banner tone="dim" headline="This order expired">
        Payment wasn&rsquo;t completed in time, so the hold on your items and
        pickup window was released.
      </Banner>
    );
  }

  if (order.status === "CANCELLED") {
    return (
      <Banner tone="dim" headline="This order was cancelled">
        Nothing was charged. Your items and pickup window are free again.
      </Banner>
    );
  }

  if (order.status === "REFUNDED") {
    return (
      <Banner tone="dim" headline="This order was refunded">
        The payment for this order has been returned.
      </Banner>
    );
  }

  if (activelyPending) {
    return (
      <Banner tone="active" headline="Confirming your payment…" live>
        {fastPollExhausted ? (
          <>
            <p>
              This is taking longer than expected. Your payment may still be
              processing — keep this page open, or check again now.
            </p>
            <ShardButton size="sm" className="mt-3" loading={checkingAgain} onClick={onCheckAgain}>
              Check again
            </ShardButton>
          </>
        ) : (
          <p>Hang tight — this updates automatically.</p>
        )}
      </Banner>
    );
  }

  // RESERVED / PAID / PACKED / PICKED_UP — the genuinely secured states.
  const headline = order.status === "PICKED_UP" ? "Picked up" : "Order secured";
  const detail =
    order.status === "PICKED_UP"
      ? "This order has already been handed over."
      : order.status === "PACKED"
        ? "Packed and waiting for you at the loot."
        : order.paymentMethod === "CASH_AT_PICKUP"
          ? "Bring cash to pay when you collect your order."
          : "Payment confirmed.";

  return (
    <Banner tone="success" headline={headline}>
      {detail}
      {!showCode && " Your pickup code will appear here once it's ready."}
    </Banner>
  );
}

function Banner({
  tone,
  headline,
  live,
  children,
}: {
  tone: "success" | "active" | "dim" | "danger";
  headline: string;
  live?: boolean;
  children: React.ReactNode;
}) {
  const toneClass = {
    success: "text-gold",
    active: "text-brand",
    dim: "text-text-dim",
    danger: "text-danger",
  }[tone];

  return (
    <div role={live ? "status" : undefined} aria-live={live ? "polite" : undefined}>
      <h1 className={`font-display text-display uppercase ${toneClass}`}>{headline}</h1>
      <div className="mt-3 max-w-lg text-sm text-text-dim">{children}</div>
    </div>
  );
}

function Shell({
  headline,
  children,
}: {
  headline: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-24 text-center sm:px-8">
      <h1 className="font-display text-headline-lg uppercase text-text">{headline}</h1>
      {children}
    </div>
  );
}

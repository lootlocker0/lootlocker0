"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AngledPanel } from "@/components/ui/AngledPanel";
import { formatCents } from "@/lib/money";

type User = {
  id: string;
  username: string;
  name: string | null;
  email: string;
  rewardPoints: number;
};

type Mode = "signin" | "signup";

type AccountPayload = {
  user?: User;
  error?: { message?: string };
};

type AccountOrder = {
  orderNumber: string;
  status: string;
  paymentMethod: string;
  totalCents: number;
  paidAt: string | null;
  createdAt: string;
  items: { nameSnapshot: string; qty: number }[];
};

/// Plain labels, not a shared status-badge component — this is the only
/// place in the app that lists many orders' statuses side by side. Colours
/// stay text-only (text-dim/gold/danger), matching this file's existing
/// restraint rather than inventing a new badge system for one screen.
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Awaiting payment",
  RESERVED: "Reserved",
  PAID: "Paid",
  PACKED: "Packed",
  PICKED_UP: "Picked up",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REFUNDED: "Refunded",
};

function accountError(payload: AccountPayload) {
  return payload.error?.message ?? "We couldn't open The Locker. Try again.";
}

export function LockerSignIn({ oauthMessage }: { oauthMessage?: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(oauthMessage ?? "");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // `null` doubles as "not loaded yet" — there's no separate ordersLoading
  // flag, since setting one synchronously at the top of an effect body is
  // exactly the cascading-render pattern React's own lint rule warns
  // against. The signed-in view below reads `orders === null` as loading.
  const [orders, setOrders] = useState<AccountOrder[] | null>(null);

  useEffect(() => {
    fetch("/api/account/me", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = (await response.json()) as AccountPayload;
        return payload.user ?? null;
      })
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    fetch("/api/account/orders", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return [];
        const payload = (await response.json()) as { orders?: AccountOrder[] };
        return payload.orders ?? [];
      })
      .then(setOrders)
      .catch(() => setOrders([]));
  }, [user]);

  function switchMode(nextMode: Mode) {
    setMode(nextMode);
    setError("");
    setPassword("");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const endpoint = mode === "signup" ? "/api/account/signup" : "/api/account/login";
      const body = mode === "signup"
        ? { username: username.trim(), email: email.trim(), password }
        : { email: email.trim(), password };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as AccountPayload;
      if (!response.ok || !payload.user) {
        setError(accountError(payload));
        return;
      }
      setUser(payload.user);
      setPassword("");
    } catch {
      setError("Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    setError("");
    try {
      const response = await fetch("/api/account/logout", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = (await response.json()) as AccountPayload;
        setError(accountError(payload));
        return;
      }
      setUser(null);
      setOrders(null);
      setMode("signin");
      setUsername("");
      setEmail("");
      setPassword("");
    } catch {
      setError("Could not sign out. Check your connection and try again.");
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-20 text-center sm:px-8">
        <p role="status" className="font-mono text-sm uppercase text-text-dim">Checking your locker…</p>
      </main>
    );
  }

  if (user) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-8 sm:py-20">
        <header className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-gold">Locker access granted</p>
          <h1 className="mt-3 font-display text-display uppercase leading-none text-text">
            Welcome, <span className="text-brand">{user.name ?? user.username}</span>
          </h1>
          <p className="mt-5 max-w-xl text-body-lg text-text-dim">Your account is ready for drops, pickup receipts, and rewards.</p>
        </header>

        <section className="mt-12 grid gap-6 md:grid-cols-[1.1fr_.9fr]" aria-label="Locker account">
          <div className="clip-card border-2 border-brand/50 bg-surface-2 p-6 sm:p-8">
            <p className="font-mono text-xs uppercase tracking-widest text-text-faint">Your profile</p>
            <p className="mt-4 font-display text-3xl uppercase text-text">{user.name ?? user.username}</p>
            {user.name && (
              <p className="mt-1 font-mono text-xs text-text-faint">@{user.username}</p>
            )}
            <p className="mt-1 font-mono text-sm text-text-dim">{user.email}</p>
            <button type="button" onClick={signOut} className="mt-8 border-b border-text-faint pb-1 font-mono text-xs uppercase tracking-wide text-text-dim hover:border-gold hover:text-gold">
              Sign out
            </button>
            {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
          </div>

          <div className="clip-panel border-2 border-gold/50 bg-surface-lowest p-6 sm:p-8">
            <p className="font-mono text-xs uppercase tracking-widest text-gold">Rewards balance</p>
            <p className="mt-3 font-display text-6xl text-gold">{user.rewardPoints}</p>
            <p className="font-mono text-sm uppercase text-text-dim">points ready</p>
            <div className="mt-6 border-t border-white/10 pt-5 text-sm text-text-dim">
              <p>Spend $1.00 → earn 10 points</p>
              <p className="mt-2">Redeem 10 points → $0.10 off</p>
            </div>
          </div>
        </section>

        <AngledPanel
          as="section"
          variant="panel"
          tone={2}
          className="mt-6 sm:p-8"
          aria-label="Order history"
        >
          <p className="font-mono text-xs uppercase tracking-widest text-text-faint">
            Order history
          </p>
          {orders === null ? (
            <p className="mt-4 font-mono text-sm text-text-dim">Loading your orders…</p>
          ) : orders.length === 0 ? (
            <p className="mt-4 text-sm text-text-dim">No orders yet.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-4">
              {orders.map((order) => (
                <li
                  key={order.orderNumber}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-white/10 pb-4 last:border-0 last:pb-0"
                >
                  <div>
                    <p className="font-mono text-sm text-text">
                      {order.orderNumber}
                      <span className="ml-3 text-text-dim">
                        {new Date(order.createdAt).toLocaleDateString("en-CA")}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-text-dim">
                      {order.items.map((i) => `${i.qty}× ${i.nameSnapshot}`).join(", ")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm text-text">{formatCents(order.totalCents)}</p>
                    <p className="text-xs uppercase tracking-wide text-text-dim">
                      {STATUS_LABEL[order.status] ?? order.status}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </AngledPanel>

        <Link href="/snacks" className="clip-shard mt-10 inline-flex bg-gold px-8 py-3 font-display uppercase tracking-wide text-void hover:brightness-110">
          Browse The Loot
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:px-8 sm:py-20">
      <div className="grid gap-12 md:grid-cols-[1fr_.85fr] md:items-start">
        <header>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-gold">Member access</p>
          <h1 className="mt-3 font-display text-display uppercase leading-none text-text">The <span className="text-brand">Locker</span></h1>
          <p className="mt-5 max-w-xl text-body-lg text-text-dim">Sign in to track your loadouts, pickup receipts, and rewards.</p>
          <div className="mt-10 border-l-2 border-gold pl-5">
            <p className="font-display text-xl uppercase text-text">LootLockers rewards</p>
            <p className="mt-2 max-w-md text-text-dim">Every $1 spent earns 10 points. Every 10 points is worth $0.10 off your next drop.</p>
          </div>
        </header>

        <section className="clip-card border-2 border-brand/50 bg-surface-2 p-6 sm:p-8">
          <div className="mb-7">
            <p className="font-mono text-xs uppercase tracking-widest text-text-faint">{mode === "signup" ? "New member" : "Returning member"}</p>
            <h2 className="mt-2 font-display text-headline-md uppercase text-text">{mode === "signup" ? "Create your locker" : "Sign in"}</h2>
          </div>

          <form onSubmit={submit}>
            {mode === "signup" && (
              <>
                <label htmlFor="locker-username" className="font-mono text-xs uppercase text-text-faint">Username</label>
                <input id="locker-username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="choose_a_handle" autoComplete="username" className="mt-2 w-full border-2 border-white/15 bg-surface-lowest px-3 py-3 font-mono text-sm text-text placeholder:text-text-faint focus:border-gold focus:outline-none" />
              </>
            )}

            <label htmlFor="locker-email" className="mt-5 block font-mono text-xs uppercase text-text-faint">Email</label>
            <input id="locker-email" name="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" className="mt-2 w-full border-2 border-white/15 bg-surface-lowest px-3 py-3 font-mono text-sm text-text placeholder:text-text-faint focus:border-gold focus:outline-none" />

            <label htmlFor="locker-password" className="mt-5 block font-mono text-xs uppercase text-text-faint">Password</label>
            <input id="locker-password" name="password" type="password" required minLength={mode === "signup" ? 8 : 1} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "8 characters minimum" : "Enter your password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} className="mt-2 w-full border-2 border-white/15 bg-surface-lowest px-3 py-3 font-mono text-sm text-text placeholder:text-text-faint focus:border-gold focus:outline-none" />

            {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}

            <button type="submit" disabled={submitting} className="clip-shard mt-7 w-full bg-gold px-8 py-4 font-display text-lg uppercase tracking-wide text-void hover:brightness-110 disabled:opacity-50">
              {submitting ? "Opening…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="my-6 flex items-center gap-3 text-xs font-mono uppercase text-text-faint"><span className="h-px flex-1 bg-white/10" />or<span className="h-px flex-1 bg-white/10" /></div>
          {/*
            Google's official "Sign in with Google" button (branding
            guidelines: https://developers.google.com/identity/branding-guidelines),
            not a re-skinned link — the logo, text, weight, and colors are
            fixed by that spec and are not brand tokens to swap in. It still
            points at this app's own OAuth redirect (/api/account/google/start
            -> Google's authorization endpoint -> our callback exchanges the
            code server-side); nothing about the sign-in mechanism changed,
            only the button's appearance. The white pill is deliberate on a
            dark page — Google's guidelines don't offer a variant meant to
            blend into arbitrary app branding.
          */}
          <a
            href="/api/account/google/start"
            className="flex h-10 w-full items-center justify-center gap-3 rounded border border-[#747775] bg-white px-3 font-sans text-sm font-medium tracking-wide text-[#1f1f1f] hover:bg-[#f7f8f8]"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" />
              <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.348 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" />
              <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
            </svg>
            Sign in with Google
          </a>

          <button type="button" onClick={() => switchMode(mode === "signup" ? "signin" : "signup")} className="mt-6 w-full text-center font-mono text-xs uppercase tracking-wide text-text-dim hover:text-gold">
            {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}
          </button>
        </section>
      </div>
    </main>
  );
}

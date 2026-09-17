"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type User = {
  id: string;
  username: string;
  email: string;
  rewardPoints: number;
};

type Mode = "signin" | "signup";

type AccountPayload = {
  user?: User;
  error?: { message?: string };
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
            Welcome, <span className="text-brand">{user.username}</span>
          </h1>
          <p className="mt-5 max-w-xl text-body-lg text-text-dim">Your account is ready for drops, pickup receipts, and rewards.</p>
        </header>

        <section className="mt-12 grid gap-6 md:grid-cols-[1.1fr_.9fr]" aria-label="Locker account">
          <div className="clip-card border-2 border-brand/50 bg-surface-2 p-6 sm:p-8">
            <p className="font-mono text-xs uppercase tracking-widest text-text-faint">Your profile</p>
            <p className="mt-4 font-display text-3xl uppercase text-text">{user.username}</p>
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
          <a href="/api/account/google/start" className="clip-shard inline-flex w-full justify-center border-2 border-brand px-8 py-3 font-display uppercase tracking-wide text-brand hover:bg-brand/15">Continue with Google</a>

          <button type="button" onClick={() => switchMode(mode === "signup" ? "signin" : "signup")} className="mt-6 w-full text-center font-mono text-xs uppercase tracking-wide text-text-dim hover:text-gold">
            {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}
          </button>
        </section>
      </div>
    </main>
  );
}

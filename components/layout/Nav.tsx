"use client";

import Link from "next/link";
import { useCart } from "@/stores/cart";
import { LockerMark } from "@/components/brand/LockerMark";

const LINKS = [
  { href: "/snacks", label: "The Locker" },
  { href: "/about", label: "Mission Briefing" },
];

/**
 * Sticky top nav, shared across `/`, `/snacks`, `/cart`, `/about`. Cart count
 * reads the persisted zustand store, which only exists in `localStorage` —
 * the server always renders zero lines. `hasHydrated` (flipped by the
 * store's own `onRehydrateStorage` callback, see stores/cart.ts) gates the
 * real count so the first client render matches the server-rendered HTML
 * exactly; the badge updates to the live count immediately after hydration,
 * which is a normal store-driven update, not a mismatch.
 */
export function Nav() {
  const count = useCart((s) => s.count());
  const hasHydrated = useCart((s) => s.hasHydrated);

  return (
    <header className="clip-header sticky top-0 z-40 border-b border-white/5 bg-surface/95 px-4 pb-3 pt-4 backdrop-blur sm:px-8">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-6xl items-center justify-between"
      >
        <Link
          href="/"
          className="flex items-center gap-2 font-display text-xl uppercase tracking-wide text-brand"
        >
          <img
            src="/logo.png"
            alt="LootLockers logo"
            className="h-12 w-36 rounded-md object-cover"
          />
        </Link>

        <ul className="flex items-center gap-6">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="font-mono text-sm uppercase tracking-wide text-text-dim transition-colors hover:text-brand"
              >
                {l.label}
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/cart"
              className="clip-shard-tight inline-flex items-center gap-2 border-2 border-gold px-4 py-1.5 font-mono text-sm uppercase text-gold transition-colors hover:bg-gold/15"
            >
              Loadout
              <span
                aria-live="polite"
                className="inline-flex min-w-[1.5em] items-center justify-center rounded-full bg-gold px-1.5 py-0.5 text-[11px] font-bold text-void"
              >
                {hasHydrated ? count : 0}
              </span>
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}

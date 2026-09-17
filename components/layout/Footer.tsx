import Link from "next/link";

/**
 * Static footer, shared across `/`, `/snacks`, `/cart`, `/about`. No client
 * state — plain server-rendered markup.
 */
export function Footer() {
  return (
    <footer className="mt-16 border-t border-white/5 bg-surface px-4 py-10 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 sm:flex-row sm:justify-between">
        <div>
          <p className="font-display text-lg uppercase tracking-wide text-brand">
            LootLockers
          </p>
          <p className="mt-2 max-w-xs text-sm text-text-dim">
            School snack ordering with locker pickup. Order ahead, skip the
            line, grab your loadout between classes.
          </p>
        </div>

        <nav aria-label="Footer" className="flex gap-10">
          <ul className="flex flex-col gap-2 font-mono text-sm uppercase text-text-dim">
            <li>
              <Link href="/snacks" className="transition-colors hover:text-brand">
                The Loot
              </Link>
            </li>
            <li>
              <Link href="/cart" className="transition-colors hover:text-brand">
                Loadout
              </Link>
            </li>
            <li>
              <Link href="/about" className="transition-colors hover:text-brand">
                Mission Briefing
              </Link>
            </li>
          </ul>
        </nav>
      </div>

      <p className="mx-auto mt-8 max-w-6xl font-mono text-[11px] text-text-faint">
        © {new Date().getFullYear()} LootLockers. All snacks sold while
        supplies last.
      </p>
    </footer>
  );
}

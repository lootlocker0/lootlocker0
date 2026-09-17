import type { Metadata } from "next";
import Link from "next/link";

// This route is the export folder DESIGN.md renamed `loot_drop_mission_briefing`
// — a marketing/about page with no cart, checkout, or rarity UI at all. Per
// DESIGN.md's own per-screen note, that makes it the lowest-priority screen
// for the primitive set and the highest-priority one for plain accessible
// semantic HTML, since it's almost entirely static copy.
export const metadata: Metadata = {
  title: "Mission Briefing | LootLockers",
  description:
    "What LootLockers is, how pickup works, and how allergen and safety information is handled.",
};

const OBJECTIVES = [
  {
    title: "Fast pickup",
    body: "Order ahead and pick a window that fits your schedule. Show your code at the loot and you're back to class before the bell.",
  },
  {
    title: "Allergen intel, always visible",
    body: "Every product lists its allergens on the card, in your cart, and on your receipt — never truncated, never hidden behind a hover.",
  },
  {
    title: "School approved",
    body: "Every snack sold through LootLockers is stocked and reviewed by the school before it ever appears in The Loot.",
  },
] as const;

const STATS = [
  { value: "4", label: "Categories" },
  { value: "20+", label: "Snacks in rotation" },
  { value: "3", label: "Daily pickup windows" },
] as const;

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
      <header className="text-center">
        <h1 className="font-display text-headline-lg uppercase text-text">
          Mission Briefing
        </h1>
        <p className="mt-4 text-text-dim">
          LootLockers is a school snack ordering system: browse what&rsquo;s in
          stock, order ahead, and pick it up at a locker between classes — no
          line, no cash fumbling.
        </p>
      </header>

      <section aria-labelledby="objectives-heading" className="mt-14">
        <h2
          id="objectives-heading"
          className="text-center font-display text-headline-md uppercase text-text"
        >
          Core objectives
        </h2>
        <ul className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {OBJECTIVES.map((o) => (
            <li
              key={o.title}
              className="clip-panel border-2 border-brand/30 bg-surface-2 p-5"
            >
              <h3 className="font-display uppercase text-brand">{o.title}</h3>
              <p className="mt-2 text-sm text-text-dim">{o.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="LootLockers by the numbers" className="mt-14">
        <dl className="grid grid-cols-3 gap-4 border-y border-white/10 py-8 text-center">
          {STATS.map((s) => (
            <div key={s.label}>
              <dd className="font-display text-headline-lg text-gold">{s.value}</dd>
              <dt className="mt-1 font-mono text-xs uppercase text-text-faint">
                {s.label}
              </dt>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="safety-heading" className="mt-14">
        <h2 id="safety-heading" className="font-display text-headline-md uppercase text-text">
          Allergen &amp; safety information
        </h2>
        <p className="mt-4 text-text-dim">
          Allergen data is safety-critical, not decorative. A product only
          ships with &ldquo;no listed allergens&rdquo; after it&rsquo;s been
          reviewed against its actual packaging — an empty list always means
          reviewed and confirmed clear, never unreviewed or unknown. If you
          have a question about a specific product, ask staff at pickup
          before you eat.
        </p>
      </section>

      <p className="mt-14 text-center">
        <Link
          href="/snacks"
          className="clip-shard inline-flex items-center justify-center bg-gold px-8 py-3 font-display uppercase tracking-wide text-void transition-transform hover:brightness-110 active:scale-[.97]"
        >
          Browse The Loot
        </Link>
      </p>
    </article>
  );
}

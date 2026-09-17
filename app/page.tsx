import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { ProductGrid } from "@/components/ProductGrid";
import { LockerMark } from "@/components/brand/LockerMark";

// `/` sits outside the `(shop)` route group (frontend.md §6 wants it built at
// the literal `app/page.tsx`), so it can't pick up `app/(shop)/layout.tsx`'s
// Nav/Footer automatically — both are rendered directly here instead.
export const metadata: Metadata = {
  title: "LootLockers | Order ahead, skip the line",
  description:
    "School snack ordering with locker pickup. Browse The Locker, build your loadout, grab it between classes.",
};

// Refresh the drop strip periodically; stock moves during a lunch service,
// but the home page isn't the safety-critical read path (that's /snacks).
export const revalidate = 30;

const STEPS = [
  {
    n: 1,
    title: "Browse The Locker",
    body: "Filter by rarity or category and see live stock and allergens on every card.",
  },
  {
    n: 2,
    title: "Build your loadout",
    body: "Add snacks to your cart and pick a pickup window that fits your schedule.",
  },
  {
    n: 3,
    title: "Grab it at the locker",
    body: "Show your code at pickup and you're back to class before the bell.",
  },
] as const;

export default async function Home() {
  const dropProducts = await db.product.findMany({
    where: { active: true, stockQty: { gt: 0 } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: 4,
    select: {
      id: true,
      name: true,
      description: true,
      priceCents: true,
      category: true,
      rarity: true,
      allergens: true,
      stockQty: true,
      imageUrl: true,
    },
  });

  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <main className="flex-1">
        <section
          className="clip-hero relative overflow-hidden border-b border-white/5 bg-surface-lowest px-4 py-20 text-center sm:px-8"
          style={{
            backgroundImage: "url('/LandingPage.jpeg')",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            backgroundSize: "cover",
          }}
        >
          <LockerMark
            variant="shield"
            size={88}
            glow
            className="mx-auto mb-6"
          />
          <p className="clip-shard-tight mx-auto mb-6 w-fit border-2 border-brand px-3 py-1 font-mono text-xs uppercase tracking-widest text-brand">
            Season 01
          </p>
          <h1 className="mx-auto max-w-3xl text-display font-display uppercase leading-none text-text">
            Snacks, <span className="text-gold">unlocked.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-body-lg text-text-dim">
            Order ahead from The Locker, build your loadout, and pick it up
            between classes — no line, no cash fumbling, no missed lunch.
          </p>
          <Link
            href="/snacks"
            className="clip-shard mx-auto mt-8 inline-flex items-center justify-center bg-gold px-12 py-4 font-display text-lg uppercase tracking-wide text-void transition-transform hover:brightness-110 active:scale-[.97]"
          >
            Enter The Locker
          </Link>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-8">
          <div className="mb-8 flex items-baseline justify-between">
            <h2 className="font-display text-headline-lg uppercase text-rarity-epic">
              Today&rsquo;s Drop
            </h2>
            <Link
              href="/snacks"
              className="font-mono text-sm uppercase text-brand hover:underline"
            >
              See the full locker →
            </Link>
          </div>
          <ProductGrid products={dropProducts} />
        </section>

        <section className="border-t border-white/5 bg-surface-2 px-4 py-16 sm:px-8">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-center font-display text-headline-lg uppercase text-text">
              Deployment Protocol
            </h2>
            <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
              {STEPS.map((step) => (
                <div key={step.n} className="flex flex-col items-center text-center">
                  <span
                    aria-hidden="true"
                    className="clip-hex flex h-14 w-14 items-center justify-center bg-brand font-display text-xl text-void"
                  >
                    {step.n}
                  </span>
                  <h3 className="mt-4 font-display text-lg uppercase text-text">
                    {step.title}
                  </h3>
                  <p className="mt-2 max-w-xs text-sm text-text-dim">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

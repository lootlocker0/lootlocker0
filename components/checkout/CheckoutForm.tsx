"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { useCart } from "@/stores/cart";
import { useLiveProducts } from "@/components/hooks/useLiveProducts";
import { useSlots } from "@/components/hooks/useSlots";
import { AngledPanel } from "@/components/ui/AngledPanel";
import { ShardButton } from "@/components/ui/ShardButton";
import { SlotPicker } from "@/components/ui/SlotPicker";
import { ProgressTracker } from "@/components/ui/ProgressTracker";
import { ProductImage } from "@/components/ui/ProductImage";
import { formatCents, sumLines } from "@/lib/money";
import { PaymentStep } from "./PaymentStep";
import { StripeErrorBoundary } from "./StripeErrorBoundary";

type FieldErrors = Record<string, string[]>;

type CheckoutError = {
  code: string;
  message: string;
  fields?: FieldErrors;
  capCents?: number;
  spentCents?: number;
  productName?: string;
};

type CardResult = { orderNumber: string; totalCents: number; clientSecret: string };

// Lazily created once per module — `loadStripe` synchronously validates the
// key format and throws on a missing/empty one, so this is wrapped rather
// than called at module scope the way the illustrative spec sketch does it.
// In this sandbox `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is a placeholder
// (docs/HANDOFF.md item 20) — it still starts with `pk_test_`, so the call
// itself succeeds; what fails later is Stripe's own network round trip
// against a simulated PaymentIntent, which `PaymentStep`/`StripeErrorBoundary`
// handle.
let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> | null {
  if (stripePromise) return stripePromise;
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) return null;
  try {
    stripePromise = loadStripe(key);
  } catch {
    stripePromise = null;
  }
  return stripePromise;
}

// Stripe Elements renders inside a sandboxed iframe, so it cannot inherit
// `var(--color-gold)` etc. from this page's stylesheet — it needs literal
// color values. Reading them from the already-computed custom properties
// (rather than hardcoding a second copy of the same hexes here) keeps
// app/globals.css the one place a rarity/brand hex is ever written; if a
// property is missing for some reason the key is simply omitted and Stripe's
// own "night" theme default takes over instead of a guessed duplicate.
function cssVar(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || undefined;
}

function getStripeAppearance() {
  return {
    theme: "night" as const,
    variables: {
      colorPrimary: cssVar("--color-gold"),
      colorBackground: cssVar("--color-surface-2"),
      colorText: cssVar("--color-text"),
      colorTextSecondary: cssVar("--color-text-dim"),
      colorDanger: cssVar("--color-danger"),
      fontFamily: '"Archivo Narrow", system-ui, sans-serif',
      borderRadius: "0px",
    },
  };
}

function clientValidate(input: {
  studentName: string;
  email: string;
  phone: string;
  slotId: string | null;
  hasUnavailable: boolean;
}): FieldErrors | null {
  const fields: FieldErrors = {};
  if (input.studentName.trim().length < 2) {
    fields.studentName = ["Enter your full name."];
  }
  if (!input.email.trim()) {
    fields.email = ["Enter your email."];
  }
  if (!input.phone.trim()) {
    fields.phone = ["Enter a phone number."];
  }
  if (!input.slotId) {
    fields.slotId = ["Choose a pickup window."];
  }
  if (input.hasUnavailable) {
    fields.items = ["Remove the unavailable item(s) from your loadout first."];
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

export function CheckoutForm() {
  const router = useRouter();
  const lines = useCart((s) => s.lines);
  const clearCart = useCart((s) => s.clear);

  const { state: productState, retry: retryProducts } = useLiveProducts();
  const { state: slotState, reload: reloadSlots } = useSlots();

  const [studentName, setStudentName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [homeroom, setHomeroom] = useState("");
  const [slotId, setSlotId] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"CARD" | "CASH_AT_PICKUP">(
    "CASH_AT_PICKUP",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<CheckoutError | null>(null);

  // Best-effort prefill from a signed-in account (the Locker) — never blocks
  // or errors the form if it's missing/fails, and never overwrites something
  // the student already typed (the functional setState reads the CURRENT
  // value at the moment this resolves, not the value from render time, so a
  // fast typist racing a slow fetch still wins). Guest checkout is
  // unaffected either way: no cookie means this fetch just 401s and no-ops.
  useEffect(() => {
    fetch("/api/account/me", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as {
          user?: { name: string | null; username: string; email: string };
        };
        const account = payload.user;
        if (!account) return;
        setStudentName((cur) => cur || account.name || account.username);
        setEmail((cur) => cur || account.email);
      })
      .catch(() => {
        /* guest checkout must work with no account at all */
      });
  }, []);
  const [card, setCard] = useState<CardResult | null>(null);

  // Checked BEFORE the empty-cart guard below, deliberately: the order this
  // renders for already exists server-side (its stock and pickup seat are
  // already held) by the time `card` is set, and the cart is cleared the
  // moment that happens (see `submit`, below) — so on the very next render
  // `lines.length` is already 0. Without this ordering the payment step
  // would never appear; the component would instead fall straight into the
  // "your loadout is empty" branch.
  if (card) {
    return <CardPaymentStep card={card} />;
  }

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-8">
        <h1 className="font-display text-headline-lg uppercase text-text">
          Extraction Point
        </h1>
        <p className="mt-4 text-text-dim">
          Your loadout is empty. Head to The Loot to build it first.
        </p>
        <Link
          href="/snacks"
          className="clip-shard mx-auto mt-8 inline-flex items-center justify-center bg-gold px-8 py-3 font-display uppercase tracking-wide text-void transition-transform hover:brightness-110 active:scale-[.97]"
        >
          Browse The Loot
        </Link>
      </div>
    );
  }

  if (productState.status === "loading" || slotState.status === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-8">
        <h1 className="font-display text-headline-lg uppercase text-text">
          Extraction Point
        </h1>
        <p role="status" className="mt-4 text-text-dim">
          Loading checkout…
        </p>
      </div>
    );
  }

  if (productState.status === "error") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-8">
        <h1 className="font-display text-headline-lg uppercase text-text">
          Extraction Point
        </h1>
        <p role="alert" className="mx-auto mt-4 max-w-md border-2 border-danger p-4 text-danger">
          Couldn&rsquo;t load your loadout. Check your connection and try again.
        </p>
        <ShardButton className="mt-6" onClick={retryProducts}>
          Retry
        </ShardButton>
      </div>
    );
  }

  if (slotState.status === "error") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-8">
        <h1 className="font-display text-headline-lg uppercase text-text">
          Extraction Point
        </h1>
        <p role="alert" className="mx-auto mt-4 max-w-md border-2 border-danger p-4 text-danger">
          Couldn&rsquo;t load pickup windows. Check your connection and try again.
        </p>
        <ShardButton className="mt-6" onClick={reloadSlots}>
          Retry
        </ShardButton>
      </div>
    );
  }

  const products = productState.products;
  const known = lines.flatMap((line) => {
    const product = products.get(line.productId);
    return product ? [{ line, product }] : [];
  });
  const unavailable = lines.filter((l) => !products.has(l.productId));
  const subtotalCents = sumLines(
    known.map(({ line, product }) => ({ unitPriceCents: product.priceCents, qty: line.qty })),
  );

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const fields = clientValidate({
      studentName,
      email,
      phone,
      slotId,
      hasUnavailable: unavailable.length > 0,
    });
    if (fields) {
      setError({ code: "INVALID_INPUT", message: "Check the highlighted fields.", fields });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentName: studentName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          ...(homeroom.trim() ? { homeroom: homeroom.trim() } : {}),
          slotId,
          paymentMethod,
          items: known.map(({ line }) => ({ productId: line.productId, qty: line.qty })),
          // Evidence only — the server reprices from the database and this
          // value never affects what's charged (CLAUDE.md §2.2). Tax isn't
          // computed client-side, so this is the subtotal; the server logs a
          // mismatch if its own total (subtotal + tax) disagrees.
          clientTotalCents: subtotalCents,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const err: CheckoutError = data.error;
        setError(err);
        // Recoverable per docs/API-CONTRACT.md §6 — refetch so the retry is
        // actionable instead of a dead end.
        if (err.code === "SLOT_FULL") reloadSlots();
        if (err.code === "OUT_OF_STOCK") retryProducts();
        setSubmitting(false);
        return;
      }

      // The order exists and already holds its stock and its pickup seat
      // regardless of payment outcome, and a card confirmation can leave this
      // page entirely via an off-site redirect before any in-page callback
      // runs — so the cart is cleared here, once, right after the order is
      // placed, rather than only on the cash branch or inside PaymentStep.
      clearCart();

      if (!data.requiresPayment) {
        router.push(`/order/${data.orderNumber}`);
        return;
      }

      setCard({
        orderNumber: data.orderNumber,
        totalCents: data.totalCents,
        clientSecret: data.clientSecret,
      });
      setSubmitting(false);
    } catch {
      setError({ code: "INTERNAL", message: "Something broke on our end." });
      setSubmitting(false);
    }
  }

  const fieldError = (name: string) => error?.fields?.[name]?.[0];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-8">
      <ProgressTracker
        className="mb-10"
        steps={[
          { id: "loadout", label: "Loadout", status: "complete" },
          { id: "pickup", label: "Pickup", status: "active" },
          { id: "confirmed", label: "Confirmed", status: "pending" },
        ]}
      />

      <h1 className="font-display text-headline-lg uppercase text-text">
        Extraction Point
      </h1>

      <form
        id="checkout-form"
        noValidate
        onSubmit={submit}
        className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3"
      >
        <div className="flex flex-col gap-6 lg:col-span-2">
          {error && !error.fields && (
            <p role="alert" className="border-2 border-danger bg-surface-2 p-4 text-sm text-danger">
              {error.message}
              {error.code === "SPEND_CAP_EXCEEDED" &&
                error.capCents !== undefined &&
                error.spentCents !== undefined &&
                ` Daily limit ${formatCents(error.capCents)}, already spent ${formatCents(error.spentCents)}.`}
              {error.code === "OUT_OF_STOCK" && error.productName && ` (${error.productName})`}
            </p>
          )}
          {error?.fields && (
            <p role="alert" className="border-2 border-danger bg-surface-2 p-4 text-sm text-danger">
              {error.message}
            </p>
          )}

          <AngledPanel variant="panel" tone={3} border="brand" as="section">
            <h2 className="font-display text-headline-md uppercase text-text">
              Squad info
            </h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="studentName" className="font-mono text-xs uppercase text-text-faint">
                  Full name
                </label>
                <input
                  id="studentName"
                  name="studentName"
                  type="text"
                  required
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  aria-invalid={fieldError("studentName") ? true : undefined}
                  aria-describedby={fieldError("studentName") ? "studentName-error" : undefined}
                  className="border-2 border-white/10 bg-surface-2 px-3 py-2 text-text focus:border-brand"
                />
                {fieldError("studentName") && (
                  <p id="studentName-error" role="alert" className="text-xs text-danger">
                    {fieldError("studentName")}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="email" className="font-mono text-xs uppercase text-text-faint">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={fieldError("email") ? true : undefined}
                  aria-describedby={fieldError("email") ? "email-error" : undefined}
                  className="border-2 border-white/10 bg-surface-2 px-3 py-2 text-text focus:border-brand"
                />
                {fieldError("email") && (
                  <p id="email-error" role="alert" className="text-xs text-danger">
                    {fieldError("email")}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="phone" className="font-mono text-xs uppercase text-text-faint">
                  Phone
                </label>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  aria-invalid={fieldError("phone") ? true : undefined}
                  aria-describedby={fieldError("phone") ? "phone-error" : undefined}
                  className="border-2 border-white/10 bg-surface-2 px-3 py-2 text-text focus:border-brand"
                />
                {fieldError("phone") && (
                  <p id="phone-error" role="alert" className="text-xs text-danger">
                    {fieldError("phone")}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="homeroom" className="font-mono text-xs uppercase text-text-faint">
                  Homeroom <span className="normal-case text-text-faint">(optional)</span>
                </label>
                <input
                  id="homeroom"
                  name="homeroom"
                  type="text"
                  value={homeroom}
                  onChange={(e) => setHomeroom(e.target.value)}
                  className="border-2 border-white/10 bg-surface-2 px-3 py-2 text-text focus:border-brand"
                />
              </div>
            </div>
          </AngledPanel>

          <AngledPanel variant="panel" tone={3} border="brand" as="section">
            <SlotPicker slots={slotState.slots} value={slotId} onChange={setSlotId} />
            {fieldError("slotId") && (
              <p role="alert" className="mt-2 text-xs text-danger">
                {fieldError("slotId")}
              </p>
            )}
          </AngledPanel>

          <AngledPanel variant="panel" tone={3} border="brand" as="section">
            <fieldset>
              <legend className="font-display text-headline-md uppercase text-text">
                Payment method
              </legend>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                {(
                  [
                    { value: "CASH_AT_PICKUP" as const, label: "Cash at pickup", hint: "Pay when you collect your order." },
                    { value: "CARD" as const, label: "Card", hint: "Pay securely online right now." },
                  ]
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className={`clip-panel flex-1 cursor-pointer border-2 p-4 transition-colors focus-within:outline focus-within:outline-[3px] focus-within:outline-gold ${
                      paymentMethod === opt.value
                        ? "border-gold bg-gold/10"
                        : "border-white/10 bg-surface-2 hover:border-brand/50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="paymentMethod"
                      value={opt.value}
                      checked={paymentMethod === opt.value}
                      onChange={() => setPaymentMethod(opt.value)}
                      className="sr-only"
                    />
                    <span className="font-display uppercase text-text">{opt.label}</span>
                    <span className="mt-1 block text-xs text-text-dim">{opt.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </AngledPanel>

          {unavailable.length > 0 && (
            <p role="alert" className="border-2 border-danger bg-surface-2 p-4 text-sm text-danger">
              {unavailable.length === 1 ? "An item" : "Some items"} in your
              loadout {unavailable.length === 1 ? "is" : "are"} no longer
              available.{" "}
              <Link href="/cart" className="underline underline-offset-2">
                Edit your loadout
              </Link>{" "}
              to continue.
            </p>
          )}
        </div>

        <AngledPanel
          as="aside"
          variant="panel-reverse"
          tone="lowest"
          border="gold"
          glow
          className="h-fit lg:sticky lg:top-24"
        >
          <h2 className="font-display text-lg uppercase text-text">Manifest summary</h2>

          <ul className="mt-4 flex flex-col gap-3">
            {known.map(({ line, product }) => {
              return (
                <li key={product.id} className="flex items-start gap-3">
                  <div className="h-12 w-12 shrink-0 overflow-hidden bg-surface-lowest">
                    <ProductImage
                      src={product.imageUrl}
                      alt=""
                      rarity={product.rarity}
                      width={48}
                      height={48}
                      className="h-full w-full object-contain"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm text-text">
                      {line.qty}× {product.name}
                    </p>
                    {product.allergens.length > 0 ? (
                      <ul className="mt-1 flex flex-wrap gap-1" aria-label="Contains allergens">
                        {product.allergens.map((a) => (
                          <li
                            key={a}
                            className="border border-danger/60 px-1 py-0.5 font-mono text-[9px] text-danger"
                          >
                            {a.replace(/_/g, " ")}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 font-mono text-[9px] text-rarity-uncommon">
                        No listed allergens
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 font-mono text-sm text-text">
                    {formatCents(product.priceCents * line.qty)}
                  </p>
                </li>
              );
            })}
          </ul>

          <dl className="mt-4 flex items-center justify-between border-t border-white/10 pt-4 font-mono text-sm">
            <dt className="text-text-dim">Subtotal</dt>
            <dd className="text-text">{formatCents(subtotalCents)}</dd>
          </dl>
          <p className="mt-2 font-mono text-[11px] text-text-faint">
            Tax and the final total are calculated at checkout — the number
            charged is always the one this page shows you next, never this
            estimate.
          </p>

          <ShardButton
            type="submit"
            form="checkout-form"
            size="lg"
            loading={submitting}
            disabled={unavailable.length > 0}
            className="mt-6 w-full"
          >
            {paymentMethod === "CARD" ? "Continue to payment" : "Confirm pickup order"}
          </ShardButton>
        </AngledPanel>
      </form>
    </div>
  );
}

/**
 * The card leg: the order already exists server-side (POST /api/checkout
 * already ran and already holds its stock and its pickup seat) — this is
 * purely the Stripe confirmation UI on top of it. Split out to its own
 * component, rather than an inline branch inside `CheckoutForm`, mainly so
 * it can render from `CheckoutForm`'s very first early return — before the
 * empty-cart guard — since the cart is cleared the instant this state is
 * set (see the comment at that call site).
 */
function CardPaymentStep({ card }: { card: CardResult }) {
  const stripe = getStripe();
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-8">
      <ProgressTracker
        className="mb-10"
        steps={[
          { id: "loadout", label: "Loadout", status: "complete" },
          { id: "pickup", label: "Pickup", status: "complete" },
          { id: "confirmed", label: "Confirmed", status: "active" },
        ]}
      />
      <h1 className="font-display text-headline-lg uppercase text-text">Pay by card</h1>
      <p className="mt-2 text-sm text-text-dim">
        Order <span className="font-mono text-text">{card.orderNumber}</span> is
        held. Complete payment to secure it.
      </p>

      <AngledPanel variant="panel" tone={3} border="brand" className="mt-6">
        {stripe ? (
          <StripeErrorBoundary
            fallback={
              <p role="alert" className="text-sm text-danger">
                The card payment form couldn&rsquo;t load. Reload the page to
                try again, or contact staff to pay cash at pickup — your order
                is already held.
              </p>
            }
          >
            <Elements
              stripe={stripe}
              options={{ clientSecret: card.clientSecret, appearance: getStripeAppearance() }}
            >
              <PaymentStep orderNumber={card.orderNumber} totalCents={card.totalCents} />
            </Elements>
          </StripeErrorBoundary>
        ) : (
          <p role="alert" className="text-sm text-danger">
            Card payment isn&rsquo;t available right now. Contact staff — your
            order <span className="font-mono text-text">{card.orderNumber}</span>{" "}
            is held, and cash at pickup is always accepted.
          </p>
        )}
      </AngledPanel>
    </div>
  );
}

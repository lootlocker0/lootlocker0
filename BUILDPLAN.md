# LootLockers — Build Plan

You are the manager. Claude Code's main thread dispatches; subagents execute and
report a summary back. You will not see their reasoning — which is the point, it
keeps the main thread clean — but it means the contract files are doing the real
coordination. Keep them accurate.

Total: roughly 10 working days solo.

---

## Bootstrap

```bash
npx create-next-app@latest looplockers \
  --typescript --tailwind --app --src-dir=false --import-alias "@/*"
cd looplockers

npm i @prisma/client zod stripe @stripe/stripe-js @stripe/react-stripe-js \
      zustand class-variance-authority clsx tailwind-merge \
      @upstash/ratelimit @upstash/redis resend
npm i -D prisma vitest @vitest/coverage-v8 @playwright/test \
      @axe-core/playwright @testcontainers/postgresql tsx
```

Drop in: `CLAUDE.md`, `.claude/agents/*.md`, `prisma/schema.prisma`,
`prisma/migrations/manual_constraints.sql`, `prisma/seed.ts`, `.mcp.json`.

`package.json`:

```json
{
  "prisma": { "seed": "tsx prisma/seed.ts" },
  "scripts": {
    "test:unit":        "vitest run tests/unit",
    "test:concurrency": "vitest run tests/concurrency",
    "test:e2e":         "playwright test",
    "test:leaks":       "vitest run tests/leaks",
    "sweep:local":      "curl -H \"Authorization: Bearer $CRON_SECRET\" localhost:3000/api/cron/sweep"
  }
}
```

---

## P0 · Design extraction — half a day

```
> Use the frontend agent to run the P0 design extraction: connect to Stitch,
  fetch every LootLockers screen, write docs/DESIGN.md, land the tokens in
  app/globals.css, and build the primitives in components/ui/. Report any WCAG
  AA contrast failures and any third-party IP that needs replacing.
```

**Gate:** `DESIGN.md` exists · rarity tokens in `@theme` · `ShardButton`,
`RarityCard`, `SlotPicker`, `AngledPanel`, `ProgressTracker` render · contrast
and IP both reported.

Read DESIGN.md yourself before moving on. Everything downstream inherits it, and
a wrong token here costs a rework across six screens.

---

## P1 · Schema and seed — half a day

```
> Use the backend agent to apply the schema and manual constraints, run the seed
  twice to prove idempotency, write lib/db.ts, lib/money.ts, lib/rarity.ts,
  lib/errors.ts, lib/settings.ts, lib/log.ts, and create the API-CONTRACT.md
  skeleton.
```

Verify by hand:

```bash
npx prisma migrate dev --name init
psql $DATABASE_URL -f prisma/migrations/manual_constraints.sql
npx prisma db seed && npx prisma db seed   # must be clean twice

psql $DATABASE_URL -c "\d products" | grep stock_non_negative
psql $DATABASE_URL -c "\df book_slot"
```

**Gate:** both check constraints present · both SQL functions exist · seed
idempotent.

---

## P2 · Catalog and cart — 2 days, parallelizable

No ownership overlap, so run both. Start backend a beat earlier — frontend needs
the contract published before it can consume it.

```
> Use the backend agent to build GET /api/products and GET /api/slots with
  category, rarity, and allergen-exclusion filtering. Allergen exclusion uses
  NOT hasSome, not hasEvery. Publish both to API-CONTRACT.md.
```

```
> Use the frontend agent to build /, /snacks, /about, the cart store, and /cart,
  reading from docs/DESIGN.md and docs/API-CONTRACT.md.
```

**Gate:** catalog renders from DB as a Server Component · allergen filter
excludes on any match · cart survives reload · sold-out cards disabled not
hidden.

---

## P3 · Checkout and Stripe — 3 days · the hard part

**Serial. Do not parallelize.** This phase is where the project either works or
quietly loses money.

Step 1:

```
> Use the backend agent to implement POST /api/checkout following the exact
  transaction order in your spec, then the Stripe webhook handler with replay
  protection, then lib/db/release.ts and the expiry sweep cron. Record in
  docs/HANDOFF.md which concurrency cases each is vulnerable to.
```

Step 2 — before frontend touches any of it:

```
> Use the qa agent to write and run the Priority 1 concurrency suite against
  the checkout transaction, webhook handler, and sweep. Report to
  docs/HANDOFF.md.
```

Fix what qa finds. Re-run. Only then:

```
> Use the frontend agent to build /checkout and /order/[orderNumber] against
  the published contract, including Stripe Elements, the cash path, and the
  confirmation-page polling described in your spec.
```

Local webhook loop while working:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
stripe trigger payment_intent.succeeded
```

**Gate:** concurrency suite green · webhook idempotent under sequential *and*
concurrent triple replay · decline card releases stock · partial-failure rollback
leaves nothing behind · cash and card both reach confirmation.

Give qa room to be annoying here. This is the phase where a false green costs
real money.

---

## P4 · Admin and ops — 2 days

```
> Use the backend agent to build authenticated admin routes: today's orders
  grouped by slot, mark packed, mark picked up, record cash collected, manual
  refund, manual stock adjustment.
```

```
> Use the frontend agent to build /admin with a printable pick list grouped by
  slot. Allergens print prominently on every line.
```

Do not skip this. Someone physically packs these bags at 12:15 with a queue
forming, and a spreadsheet will not survive that.

**Gate:** a staff member can run a full lunch service from the screen, offline
fallback included (print the list before service starts).

---

## P4b · Restricted inventory editor — new requirement, folded into P4

The product owner wants day-to-day catalog upkeep (adding products and
photos, setting which item/type it is, keeping quantity current) handled by
two 13-year-old family members, with the site itself — checkout, payments,
order data, any student PII — explicitly and completely off their hands.
That's a permissions boundary, not just a UI simplification, so it's a
distinct role from the P4 staff admin above, not a stripped-down view of it.

**Scope, explicitly:**
- Can: create/edit a product's name, category/type, price, photo, allergens,
  active flag, and stock quantity.
- Cannot reach, at the route/auth level, not just hidden in the UI: orders,
  order items, customer name/email/phone/homeroom, payment status, refunds,
  Stripe anything, settings (spend cap / cutoff / tax). None of that data
  should even be queryable through this role's session — this is an
  authorization boundary, not a navigation one.

**Proposed approach** (flag now if any of this is wrong before backend
builds it in P4):
- A separate `/inventory` route and its own session cookie/secret
  (`INVENTORY_SESSION_SECRET`, alongside `ADMIN_SESSION_SECRET` in `.env`),
  not a role flag inside the existing admin auth — so a bug in one can't
  leak into the other's scope.
- The route touches `Product` only. No `Order`/`OrderItem`/`Setting` model
  is reachable from any API route this session can hit — enforced server-side,
  since a 13-year-old's browser is not a security boundary a teenager should
  be relied on to respect on purpose or by accident.
- Photo upload needs real object storage (a raw `<input type=file>` writing
  into `public/` doesn't survive a redeploy and isn't multi-editor-safe).
  Defaulting to Vercel Blob since BUILDPLAN.md already assumes a Vercel
  deploy for the cron job — flag if that's wrong and something else
  (S3, Cloudflare R2, Supabase Storage) is preferred.
- Allergen fields stay mandatory on every product this role creates —
  CLAUDE.md invariant #8 doesn't get relaxed because the person entering
  data is younger; if anything a required, plain checklist UI (not free text)
  matters more here.

This is scoped as an extension of P4, not a new phase — same backend/frontend
split, built once `Product` (P1) and the base catalog (P2) exist. Not
starting on it yet; P1 is still in flight. Recording it here now so it isn't
lost, and so backend's P1 schema work doesn't need a second pass once this
lands.

---

## P5 · Hardening and launch — 2 days

```
> Use the qa agent to run the full suite: Priority 2 through 5, Playwright on
  desktop and mobile viewports, keyboard-only pass, axe scan on every route,
  and the bundle scan for leaked secrets and PII.
```

Then the manual list. These are yours, not an agent's.

**Infrastructure**
- [ ] Neon/Supabase region set to Canada; Vercel functions region `yyz`
- [ ] `DIRECT_URL` set so migrations bypass the pooler
- [ ] Cron registered in `vercel.json` and firing every 5 min
- [ ] Upstash Redis provisioned; rate limiting confirmed live

**Stripe**
- [ ] Live keys swapped in — *test-mode keys are live locally; `sk_live_`/
  `pk_live_` still not provided, see `docs/HANDOFF.md` #85*
- [x] Webhook endpoint registered, signing secret in env (test mode, local via
  `stripe listen`; a deployed endpoint is still open — see `docs/HANDOFF.md` #85)
- [x] Statement descriptor reads as something a parent recognizes
  (`"LOOTLOCKERS"`, `lib/stripe/payments.ts:86`, confirmed against a real
  test-mode PaymentIntent)
- [ ] Radar rules reviewed for card-testing volume
- [x] One real transaction placed and refunded end to end (test mode —
  `docs/HANDOFF.md` #85)
- [x] Apple Pay works (no code change needed — `PaymentElement` +
  `automatic_payment_methods` already covers it). Domain registered and
  confirmed working in Safari on macOS and iOS — test mode only,
  `docs/HANDOFF.md` #86
- [ ] Apple Pay domain registration repeated in **live mode** — test-mode
  registration does not carry over; needs `sk_live_` and is blocked on the
  same "Live keys swapped in" line above

**School sign-off** — blocking, and none of it is a code change
- [ ] `tax_rate_bps` confirmed with the school's finance contact
- [ ] Real bell schedule seeded
- [ ] Slot capacity set to physical handout throughput, not aspiration
- [ ] Daily spend cap agreed
- [ ] Data-handling requirements confirmed (retention, who can see the PII)
- [ ] Card-vs-cash decision settled — see below
- [ ] Allergen data reviewed by whoever is accountable for it at the school

**Rollback**
- [ ] Written answer to: how do you take orders if the site is down at 12:00?

---

## Running the loop

Each phase: dispatch → read `HANDOFF.md` → resolve blockers → run the gate →
commit with the phase in the message.

**Three failure modes to watch for.**

*An agent inventing an endpoint rather than requesting it.* Grep what frontend
calls against what API-CONTRACT.md documents; they should match exactly.

*Design drift.* `grep -rE "#[0-9a-fA-F]{6}" components/` should return nothing —
every color goes through a token.

*QA reporting green on a suite that never had a failing case.* Ask what it tried,
not what passed. A concurrency test written as a sequential loop passes against
broken code, and that is the single most common way this suite lies to you.

**Cost.** Backend and qa run Opus because transaction correctness and adversarial
test design are where model capability actually shows. Frontend runs Sonnet fine.
Trim frontend before you touch the other two.

---

## Still open, and it blocks P3

You said card *and* cash. The card path is what creates chargeback exposure — a
parent disputing a charge they don't recognize, at $15 per dispute regardless of
outcome, plus the fact that contracts with minors are voidable in most Canadian
provinces.

Worth settling with the school before P3 starts: are they comfortable with
students entering card details, or would they rather launch cash-only and add
parent-funded balances later? Cash-only is a smaller build and a much smaller
risk surface, and adding cards later costs you a week rather than a rewrite.

That's a conversation, not a ticket — but it changes what gets built in P3, so
have it now.

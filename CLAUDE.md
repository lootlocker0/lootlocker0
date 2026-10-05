# LootLockers — Agent Orchestration Contract

School snack ordering + locker pickup. **Real deployment, real money, minors' PII.**

Next.js 15 (App Router) · TypeScript strict · Tailwind v4 · Prisma + Postgres ·
Stripe · Vitest + Playwright.

---

## 1. How orchestration actually works here

Claude Code subagents **do not talk to each other**. Each runs in an isolated
context and reports a summary back to the main thread. The main thread is the
manager.

Shared state therefore lives on disk, not in conversation:

| File | Owner | Consumers |
|---|---|---|
| `docs/DESIGN.md` | frontend (P0 task) | frontend |
| `docs/API-CONTRACT.md` | backend | frontend, qa |
| `docs/HANDOFF.md` | append-only, any agent | manager resolves |
| `prisma/schema.prisma` | backend | everyone |

**No agent edits a file it does not own.** Frontend needing an API change appends
to `HANDOFF.md` and returns. It does not write route handlers, and it does not
stub the endpoint and continue — a stub that ships is worse than a blocked task.

### Ownership map

```
app/(shop)/**  components/**  stores/**       frontend
tailwind.config.ts  app/globals.css           frontend
app/api/**  lib/db/**  lib/stripe/**          backend
prisma/**                                     backend
tests/**  playwright.config.ts                qa
.github/workflows/**                          qa
CLAUDE.md                                     manager only
```

---

## 2. Non-negotiable invariants

Violating one of these is a stop-and-report, not a work-around.

1. **Money is integer cents.** No floats. No `parseFloat` on a price, ever.
2. **The server recalculates every total** from DB prices. Client-supplied totals
   are logged and discarded.
3. **Stripe webhooks are the only source of truth for payment.** Client-side
   `status === 'succeeded'` never flips an order to PAID.
4. **Stock and pickup windows move through `reserve_stock()` /
   `book_pickup_window()`.** Never a read-then-write in app code. There is no
   `PickupSlot` table — windows are a fixed template (`lib/pickup-windows.ts`)
   and "booked" is a live count over `orders`, serialized by a transaction-
   scoped advisory lock instead of a row lock.
5. **Order lines snapshot** name, price, rarity, allergens at purchase time.
6. **No PII in URLs, logs, or analytics.** These are children.
7. **Allergen data is safety-critical.** Never inferred, never defaulted, never
   truncated in UI. Missing allergen data blocks publication.

---

## 3. Stitch MCP setup

### Rotate the key first

Any key pasted into a chat or a shell command is burned — history is a log.
Revoke at *console.cloud.google.com → APIs & Services → Credentials*, issue a
new one restricted to the Stitch API, then:

```bash
echo 'export STITCH_API_KEY="AQ.your-new-key"' >> ~/.zshrc && source ~/.zshrc
```

### Path A — direct HTTP (try first)

```bash
claude mcp add stitch \
  --transport http \
  --header "X-Goog-Api-Key: $STITCH_API_KEY" \
  https://stitch.googleapis.com/mcp
```

Verify with `/mcp` inside Claude Code.

**Known failure:** Claude Code has an open issue where the `headers` config is
ignored and OAuth dynamic client registration is attempted instead — which Google
Stitch does not support. Symptom:

```
Incompatible auth server: does not support dynamic client registration
```

That is a client-side bug, not your key. Go to Path B.

### Path B — stdio wrapper (reliable)

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud auth application-default login
gcloud beta services mcp enable stitch.googleapis.com --project=YOUR_PROJECT_ID
```

`.mcp.json` at repo root (commit this; the key resolves from env):

```json
{
  "mcpServers": {
    "stitch": {
      "command": "npx",
      "args": ["-y", "@_davideast/stitch-mcp", "proxy"],
      "env": { "STITCH_API_KEY": "${STITCH_API_KEY}" }
    }
  }
}
```

### Path C — manual

Export screens from the Stitch web UI into `design/stitch-export/` and point the
frontend agent at the folder. MCP saves a manual step; it is not load-bearing.

---

## 4. Shared libraries

These are cross-cutting. Backend writes them; everyone imports them.

### `lib/money.ts`

```ts
/** All money is integer cents. This module is the only place cents become text. */

export function formatCents(cents: number, locale = "en-CA"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "CAD",
  }).format(cents / 100);
}

/** basis points -> cents. 500 bps = 5%. */
export function applyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10_000);
}

export function sumLines(lines: { unitPriceCents: number; qty: number }[]): number {
  return lines.reduce((acc, l) => acc + l.unitPriceCents * l.qty, 0);
}

/** Guard used at every trust boundary. */
export function assertCents(n: unknown, field: string): asserts n is number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new Error(`${field} must be a non-negative integer cent value`);
  }
}
```

### `lib/rarity.ts`

One lookup object. Never scatter rarity conditionals through JSX.

```ts
import { Rarity } from "@prisma/client";

export const RARITY = {
  COMMON:    { label: "Common",    hex: "#9BA0A8", glow: "rgba(155,160,168,.35)", order: 0 },
  UNCOMMON:  { label: "Uncommon",  hex: "#38D64B", glow: "rgba(56,214,75,.40)",   order: 1 },
  RARE:      { label: "Rare",      hex: "#1B7FE8", glow: "rgba(27,127,232,.45)",  order: 2 },
  EPIC:      { label: "Epic",      hex: "#A855F7", glow: "rgba(168,85,247,.50)",  order: 3 },
  LEGENDARY: { label: "Legendary", hex: "#F5C518", glow: "rgba(245,197,24,.55)",  order: 4 },
} as const satisfies Record<Rarity, {
  label: string; hex: string; glow: string; order: number;
}>;

export type RarityMeta = (typeof RARITY)[Rarity];
export const rarityMeta = (r: Rarity): RarityMeta => RARITY[r];
```

### `lib/errors.ts`

Machine-readable codes the UI branches on. Never bare 500s.

```ts
export const ERROR_CODES = {
  INVALID_INPUT:        { status: 400, message: "Check the highlighted fields." },
  PAST_CUTOFF:          { status: 409, message: "Ordering closed for that pickup time." },
  SLOT_FULL:            { status: 409, message: "That pickup time just filled up." },
  OUT_OF_STOCK:         { status: 409, message: "An item just sold out." },
  SPEND_CAP_EXCEEDED:   { status: 409, message: "Daily spending limit reached." },
  PRODUCT_UNAVAILABLE:  { status: 409, message: "An item is no longer available." },
  PAYMENT_FAILED:       { status: 402, message: "Payment was declined." },
  RATE_LIMITED:         { status: 429, message: "Too many attempts. Wait a minute." },
  INTERNAL:             { status: 500, message: "Something broke on our end." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public detail?: Record<string, unknown>,
  ) {
    super(ERROR_CODES[code].message);
  }
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) {
    const { status, message } = ERROR_CODES[e.code];
    return Response.json(
      { error: { code: e.code, message, ...e.detail } },
      { status },
    );
  }
  console.error("[unhandled]", e);
  return Response.json(
    { error: { code: "INTERNAL", message: ERROR_CODES.INTERNAL.message } },
    { status: 500 },
  );
}
```

### `lib/db.ts`

```ts
import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  g.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") g.prisma = db;
```

### `lib/settings.ts`

```ts
import { db } from "./db";

const DEFAULTS = {
  daily_spend_cap_cents: 1500,
  order_cutoff_minutes: 45,
  tax_rate_bps: 0,
  pending_order_ttl_minutes: 15,
} as const;

type Key = keyof typeof DEFAULTS;

let cache: Partial<Record<Key, number>> = {};
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getSetting(key: Key): Promise<number> {
  if (Date.now() - cachedAt > TTL_MS) {
    const rows = await db.setting.findMany();
    cache = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    cachedAt = Date.now();
  }
  const v = cache[key];
  return Number.isFinite(v) ? (v as number) : DEFAULTS[key];
}
```

### `lib/log.ts`

PII never reaches a log line intact.

```ts
import { createHash } from "crypto";

export const hashPii = (v: string) =>
  createHash("sha256").update(v.toLowerCase().trim()).digest("hex").slice(0, 12);

export const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  return `${u.slice(0, 2)}***@${d ?? "?"}`;
};

export function logEvent(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}
```

---

## 5. Environment

`.env.example` — commit this, never `.env`:

```bash
DATABASE_URL="postgresql://...?sslmode=require"
DIRECT_URL="postgresql://..."              # migrations, bypasses pooler

STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..."

CRON_SECRET="..."                          # guards the expiry sweep route
ADMIN_SESSION_SECRET="..."

RESEND_API_KEY="..."
NEXT_PUBLIC_SITE_URL="https://lootlockers.ca"
```

**Anything not prefixed `NEXT_PUBLIC_` must never appear in a client bundle.**
QA greps for this.

---

## 6. Phase gates

- **P0 Design** → `DESIGN.md`, rarity tokens in Tailwind, primitives render
- **P1 Schema** → migrations + constraints applied, seed idempotent twice
- **P2 Catalog** → products render from DB, cart survives reload
- **P3 Checkout** → concurrency suite green, webhook idempotent under replay
- **P4 Admin** → staff can run a full lunch service from the screen
- **P5 Launch** → live transaction placed and refunded, region confirmed Canadian

---

## 7. Escalate to the human — do not decide

- Tax treatment of snack foods (`tax_rate_bps` is a placeholder `0`)
- Real bell schedule and physical handout throughput per slot
- Whether students may use their own cards, or parent-funded balances only
- Anything touching school data policy or PII retention
- Changes to the daily spend cap

# LootLockers — API Contract

**Owner:** backend agent. **Consumers:** frontend, qa.

This file is the only view either of them has of the API surface. Code they
cannot read does not exist; an endpoint that is not documented here must not be
called. If frontend needs something that is not on this page, it appends the
request to `docs/HANDOFF.md` and stops — it does not write the route and it does
not stub it.

**Rule for backend:** an endpoint ships to `main` and to this file in the same
commit. No exceptions, including "temporary" internal routes.

**Status:** P3 complete (checkout, Stripe webhook, expiry sweep, confirmation
read) and **P4 backend complete** (staff admin). `GET /api/products`,
`GET /api/slots`, `POST /api/checkout`, `POST /api/webhooks/stripe`,
`GET /api/orders/[orderNumber]`, `GET /api/cron/sweep` and the eight
`/api/admin/*` routes are live and documented in §6. **The `/admin` screen is
unblocked.** The sections below define the conventions every endpoint follows,
plus the data types and enum values fixed by the database. Later phases append
to §6 without restructuring anything above it.

> **P4 deployment step, do not skip.** `POST /api/admin/products/[productId]/stock`
> calls a new SQL function, `adjust_stock`. Re-run
> `psql "$DATABASE_URL" -f prisma/migrations/manual_constraints.sql` against
> every database — dev, CI, `looplockers_test`, production — or that one route
> 500s. There is no Prisma migration; the file is idempotent (§5).

---

## 1. Conventions

| | |
|---|---|
| Base URL | `NEXT_PUBLIC_SITE_URL` (dev: `http://localhost:3000`) |
| Transport | JSON over HTTPS. `Content-Type: application/json` on every request with a body |
| Runtime | All routes are `runtime = "nodejs"` (Prisma and Stripe signature verification both need it) |
| Money | **Integer cents, always.** Field names end in `Cents`. There are no decimal amounts anywhere in this API |
| Currency | CAD. Not configurable |
| Dates | ISO 8601 strings in responses |
| Auth | Public routes are unauthenticated. `GET /api/orders/[orderNumber]` is authorised by the per-order httpOnly cookie that `POST /api/checkout` sets. `/api/cron/*` requires `Authorization: Bearer $CRON_SECRET`. `/api/admin/*` requires the `ll_admin` staff session cookie (§6a) — a **separate secret and separate cookie** from the student one |
| PII | Never in a path, query string, or redirect. Student name, email, phone and homeroom travel in POST bodies only |

### Totals

The server recomputes every total from database prices. A client-supplied
`clientTotalCents` is accepted for reconciliation, logged when it disagrees, and
then discarded. It never affects what is charged. Render the server's figure
before payment.

---

## 2. Error envelope

Every non-2xx response from a documented endpoint has this exact shape:

```json
{
  "error": {
    "code": "SLOT_FULL",
    "message": "That pickup time just filled up.",
    "...": "zero or more code-specific detail fields"
  }
}
```

Branch on `code`, never on `message` — messages are copy and will change.

| `code` | HTTP | Message | Detail fields |
|---|---|---|---|
| `INVALID_INPUT` | 400 | Check the highlighted fields. | `fields`: `{ [fieldName]: string[] }` |
| `ADMIN_UNAUTHORIZED` | 401 | Staff sign-in required. | — |
| `PAYMENT_FAILED` | 402 | Payment was declined. | — |
| `ORDER_NOT_FOUND` | 404 | We couldn't find that order. | — |
| `PAST_CUTOFF` | 409 | Ordering closed for that pickup time. | — |
| `SLOT_FULL` | 409 | That pickup time just filled up. | — |
| `OUT_OF_STOCK` | 409 | An item just sold out. | `productName`: string |
| `SPEND_CAP_EXCEEDED` | 409 | Daily spending limit reached. | `capCents`, `spentCents` |
| `PRODUCT_UNAVAILABLE` | 409 | An item is no longer available. | — |
| `INVALID_STATUS_TRANSITION` | 409 | That order is not in a state where this is allowed. | `status` (current), `expected` (`OrderStatus[]`) |
| `PICKUP_CODE_MISMATCH` | 409 | That pickup code does not match this order. | — |
| `CASH_NOT_COLLECTED` | 409 | Cash has not been recorded for this order yet. | `totalCents` |
| `PAYMENT_METHOD_MISMATCH` | 409 | That action does not apply to this payment method. | `paymentMethod` |
| `STOCK_ADJUSTMENT_REJECTED` | 409 | That stock adjustment would leave a negative quantity. | `productId`, `stockQty`, `delta` |
| `RATE_LIMITED` | 429 | Too many attempts. Wait a minute. | — |
| `INTERNAL` | 500 | Something broke on our end. | — |
| `REFUND_FAILED` | 502 | The refund could not be completed at the payment provider. | `reason`: `NO_PAYMENT_INTENT` \| `PROVIDER_ERROR` |
| `ADMIN_NOT_CONFIGURED` | 503 | Staff sign-in is not configured on this server. | — |

The last seven are P4 (staff admin) only. Unlike `ORDER_NOT_FOUND`, they are
allowed to be specific: the caller already holds a staff session that can list
every order for the day, so there is no enumeration oracle left to protect, and
somebody standing at a locker needs to know whether to collect money, re-read
the code, or fetch a manager.

Source of truth: `lib/errors.ts`. Codes are added there first.

`SLOT_FULL` and `OUT_OF_STOCK` are recoverable: refetch slots and the catalog
and let the student retry. The rest are terminal for that attempt.

## 6c. The Locker account

Student accounts use the `ll_account` httpOnly, `SameSite=Lax` cookie. The
cookie contains an opaque random token; only its SHA-256 hash is stored in
`account_sessions`, and the server checks that row and its expiry on every
request. Sessions last 30 days. Logout deletes the matching server row and
expires the cookie, so a copied or previously issued cookie stops working.

### `POST /api/account/signup`

Body:

```json
{ "username": "locker_kid", "email": "student@example.com", "password": "at-least-8-chars" }
```

Creates a password account, starts a session, and returns:

```json
{ "user": { "id": "cuid", "username": "locker_kid", "email": "student@example.com", "rewardPoints": 0 } }
```

`USERNAME_TAKEN` (409) and `EMAIL_TAKEN` (409) identify uniqueness conflicts.
Passwords are stored as salted Node `scrypt` hashes.

### `POST /api/account/login`

Body: `{ "email": "student@example.com", "password": "..." }`.
On success, starts a session and returns the same `{ user }` shape as signup.
Wrong credentials return `ACCOUNT_UNAUTHORIZED` (401) without revealing
whether the email exists. Login and signup are rate limited before credential
processing.

### `GET /api/account/me`

Returns the current session's `{ user }` shape. Missing, expired, or revoked
sessions return `ACCOUNT_UNAUTHORIZED` (401).

### `POST /api/account/logout`

Revokes the current server session when present, expires `ll_account`, and
returns `{ "ok": true }`. It is idempotent for a missing or already-revoked
cookie.

### `GET /api/account/google/start`

When all `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
`GOOGLE_REDIRECT_URI` variables are configured, creates a ten-minute,
single-use server-side OAuth state and redirects to Google. Missing
configuration returns `ACCOUNT_NOT_CONFIGURED` (503).

### `GET /api/account/google/callback`

Validates and consumes the one-time state, exchanges the authorization code,
requires a verified Google email, then links or creates the account and sets
`ll_account`. Success redirects to `NEXT_PUBLIC_SITE_URL` (or the callback
origin) at `/`. Invalid, expired, replayed, or failed callbacks return
`OAUTH_FAILED` (400). No OAuth token or account PII is logged.

`ORDER_NOT_FOUND` is deliberately ambiguous. It means "no order you are allowed
to read" — an unknown order number, a missing or expired confirmation cookie, and
a cookie belonging to a different order all produce the identical body. Do not
write copy that guesses which one happened.

---

## 3. Shared types

Generated from `prisma/schema.prisma`. Server code imports these from
`@prisma/client`; client components may import the types with
`import type { Rarity, Allergen } from "@prisma/client"`.

### `Rarity`

`COMMON` · `UNCOMMON` · `RARE` · `EPIC` · `LEGENDARY`

Display metadata (label, hex, glow, sort order) lives in `lib/rarity.ts` and
nowhere else. Do not re-declare rarity colours in a component.

### `Allergen`

`PEANUTS` · `TREE_NUTS` · `DAIRY` · `EGGS` · `GLUTEN` · `SOY` · `SESAME` ·
`FISH` · `SHELLFISH` · `MUSTARD` · `SULPHITES`

Safety-critical (CLAUDE.md §2.8). An empty array means "reviewed, none present",
never "unknown". Render every entry, never truncated, never hover-only, never
"+2 more".

> Resolved: `components/ui/rarity.ts` (P0 placeholder) has been deleted.
> `RarityCard` now imports `Allergen`/`Rarity` from `@prisma/client` and
> `rarityMeta` from `@/lib/rarity` directly. See `docs/HANDOFF.md` §5.

### `PaymentMethod`

`CARD` · `CASH_AT_PICKUP`

### `OrderStatus`

| Value | Meaning |
|---|---|
| `PENDING` | Created. Stock and one slot seat are held. Card orders carry `expiresAt` |
| `RESERVED` | Cash order awaiting pickup. Counts against the daily spend cap |
| `PAID` | Stripe webhook confirmed payment. **Only the webhook sets this** |
| `PACKED` | Staff bagged it |
| `PICKED_UP` | Handed over. Terminal |
| `CANCELLED` | Payment failed or staff cancelled. Stock and seat released |
| `EXPIRED` | TTL elapsed before payment. Stock and seat released by the sweep |
| `REFUNDED` | Money returned. Stock is **not** returned automatically |

### `category`

A plain string on `Product`, but only four values are accepted or documented:

`sweet` · `savory` · `drinks` · `healthy`

Anything else is rejected at the request boundary (`INVALID_INPUT`).

---

## 4. Object shapes

These are the field names the API will use. They match the Prisma models.

### Product

```jsonc
{
  "id": "cmtkq00k7000ewf7d8vvzz2no",  // cuid
  "slug": "gummy-bear-pouch",          // stable key, not shown to students
  "name": "Gummy Bear Pouch",
  "description": "A fistful of fruit-flavoured gummy bears in a resealable pouch.",
  "priceCents": 150,
  "category": "sweet",
  "rarity": "COMMON",
  "allergens": ["DAIRY", "SOY"],
  "stockQty": 40,
  "active": true,
  "imageUrl": "/products/gummy-bear-pouch.svg",
  "sortOrder": 10
}
```

### PickupSlot (as returned to students)

```jsonc
{
  "id": "cmtkq00ka000fwf7dsn6icbmt",
  "label": "Lunch B",
  "startTime": "12:20",                       // local wall clock, 24h
  "location": "Locker bank C",
  "serviceDate": "2026-09-02T00:00:00.000Z",
  "remaining": 17,                            // capacity - bookedCount, floored at 0
  "full": false
}
```

`capacity` and `bookedCount` are internal; students see `remaining` and `full`.

### Order / OrderItem

Order lines are **snapshots**. `nameSnapshot`, `unitPriceCents`,
`raritySnapshot` and `allergensSnapshot` are written once at purchase time and
are never refreshed from the product afterwards, so correcting a product's
allergens today does not rewrite what a student was handed last week. Every
display surface — cart line, confirmation, admin pick list — reads the snapshot.

---

## 5. Database setup

The two atomic mutators and every CHECK constraint live in
`prisma/migrations/manual_constraints.sql`, which Prisma cannot express and
therefore does **not** apply. Both steps are required, in this order:

```bash
npx prisma migrate deploy                 # or: migrate dev, in local dev
psql "$DATABASE_URL" -f prisma/migrations/manual_constraints.sql
npx prisma db seed                         # idempotent; safe to re-run
```

The SQL file is idempotent, so the qa harness can re-run it against every fresh
test container.

**P4 (2026-09-04)** adds `adjust_stock(text, int)` to
`manual_constraints.sql`. There is **no Prisma migration** — it is a function,
not a column — so `migrate deploy` alone does not install it. Re-run the SQL
file against every database (it is idempotent, and re-running it was verified to
be a no-op). Until you do,
`POST /api/admin/products/[productId]/stock` returns `INTERNAL` 500 and nothing
else changes.

**Migration `20260903055030_webhook_event_processed_at` (2026-09-03)** adds a
plain nullable `webhook_events.processed_at`. `migrate deploy` applies it;
`manual_constraints.sql` is unchanged, because a nullable column needs no
constraint and the claim protocol is enforced by the handler's conditional
`UPDATE`, not by the database. Any environment or test database created before
that date needs a `migrate deploy` before the webhook route will run.

Beyond the checks in the table below, one invariant is held by an explicit lock
rather than by a constraint: **the daily spend cap**. It is a sum over rows that
do not exist yet, so no single `UPDATE ... WHERE` can express it the way
`reserve_stock` does. `POST /api/checkout` therefore takes
`pg_advisory_xact_lock(hashtextextended(<email>:<school day>, 0))` as the first
statement of its transaction and re-reads the aggregate under it. The lock is
released by Postgres at commit or rollback; nothing unlocks it by hand and
nothing leaks if a process dies mid-checkout.

| Object | Contract |
|---|---|
| `book_slot(text) -> boolean` | Claims one seat. `true` = claimed, `false` = full, inactive, or missing |
| `reserve_stock(text, int) -> boolean` | Reserves N units. `true` = reserved, `false` = insufficient stock, inactive, or missing. A non-positive quantity returns `false` |
| `adjust_stock(text, int) -> int` | **P4.** Applies a signed delta to stock and returns the new `stock_qty`, or `NULL` if the product is missing or the change would go below zero. Ignores `active` (staff must be able to correct a deactivated product). A zero delta returns `NULL` |
| `stock_non_negative` | `products.stock_qty >= 0` |
| `product_price_non_negative` | `products.price_cents >= 0` |
| `booked_count_non_negative` | `pickup_slots.booked_count >= 0` |
| `slot_capacity_non_negative` | `pickup_slots.capacity >= 0` |
| `booked_within_capacity` | `pickup_slots.booked_count <= capacity` |
| `order_amounts_non_negative` | all three order amounts `>= 0` |
| `order_total_consistent` | `total_cents = subtotal_cents + tax_cents` |
| `order_item_qty_positive` | `order_items.qty > 0` |
| `order_item_price_non_negative` | `order_items.unit_price_cents >= 0` |

**For test fixtures:** any helper that inserts an order directly must satisfy
`order_total_consistent`, and any helper that writes `booked_count` must satisfy
`booked_within_capacity`. Both fail the write rather than accepting a torn row.

Stock and slot capacity move **only** through those two functions plus the
release path in `lib/db/release.ts` (CLAUDE.md §2.4). There is no sanctioned
read-then-write anywhere.

---

## 6. Endpoints

Each endpoint gets its own subsection here as it lands, in this format:

> ### `METHOD /api/path`
> One line on what it is for.
> **Request** — query params or body schema, with types and limits.
> **Response 200** — a real example payload.
> **Errors** — the exact `code` values this route can return and what the client
> should do about each.
> **Caching** — the `Cache-Control` header it sets, and why.
> **Notes** — concurrency behaviour, idempotency, rate limits.

### `GET /api/products`

The catalog. Active, in-stock products with optional category, rarity and
allergen-exclusion filtering.

**Request** — query string only. No body, no auth.

| Param | Type | Required | Notes |
|---|---|---|---|
| `category` | `sweet` \| `savory` \| `drinks` \| `healthy` | no | Exact match. Any other value is `INVALID_INPUT`, not an empty result |
| `rarity` | `COMMON` \| `UNCOMMON` \| `RARE` \| `EPIC` \| `LEGENDARY` | no | Exact match |
| `excludeAllergens` | comma-separated `Allergen` values | no | Drops any product carrying **at least one** of them. Tokens are trimmed and de-duplicated; surrounding spaces and empty segments are tolerated |

`excludeAllergens` values are **case-sensitive and validated against the
`Allergen` enum** (§3). `?excludeAllergens=dairy` and `?excludeAllergens=MILK`
are both `400 INVALID_INPUT` — they are not silently ignored. This is
deliberate: an unrecognised token in a `NOT hasSome` filter excludes nothing, so
a request that looks like it filtered dairy would serve dairy. Build these
values from the enum, never from user free text or display copy. Unknown query
params (`utm_*`, etc.) are ignored.

Filters combine with AND. `?category=drinks&rarity=COMMON` returns common
drinks.

**Response 200** — real output from `GET /api/products?category=healthy`:

```json
{
  "products": [
    {
      "id": "cmtkqayy1000k5p7dqcdtzx0i",
      "slug": "apple-slices-cup",
      "name": "Apple Slices Cup",
      "description": "Fresh-cut apple slices, cut the morning of service.",
      "priceCents": 175,
      "category": "healthy",
      "rarity": "COMMON",
      "allergens": [],
      "stockQty": 30,
      "active": true,
      "imageUrl": "/products/apple-slices-cup.svg",
      "sortOrder": 210
    },
    {
      "id": "cmtkqayy4000l5p7dej65rfg0",
      "slug": "trail-mix-bag",
      "name": "Trail Mix Bag",
      "description": "Peanuts, almonds, raisins and chocolate chunks.",
      "priceCents": 300,
      "category": "healthy",
      "rarity": "RARE",
      "allergens": ["PEANUTS", "TREE_NUTS", "SOY"],
      "stockQty": 14,
      "active": true,
      "imageUrl": "/products/trail-mix-bag.svg",
      "sortOrder": 220
    },
    {
      "id": "cmtkqayy6000m5p7donlxspaz",
      "slug": "greek-yogurt-parfait",
      "name": "Greek Yogurt Parfait",
      "description": "Greek yogurt layered with granola and berry compote.",
      "priceCents": 400,
      "category": "healthy",
      "rarity": "EPIC",
      "allergens": ["DAIRY", "GLUTEN"],
      "stockQty": 10,
      "active": true,
      "imageUrl": "/products/greek-yogurt-parfait.svg",
      "sortOrder": 230
    }
  ]
}
```

Always `{ "products": [...] }`, possibly empty. Fields are exactly the Product
shape in §4 — `createdAt`/`updatedAt` are internal and not returned. Ordered by
`sortOrder` ascending, then `name` ascending.

`allergens: []` means **reviewed, none present**. It never means unknown. Render
every entry; never truncate, never hide behind a hover (CLAUDE.md §2.8).

**Errors**

| `code` | HTTP | Cause | Client action |
|---|---|---|---|
| `INVALID_INPUT` | 400 | Unknown `category`, `rarity` or allergen token. `fields` names the offending param | Fix the filter. Do not retry unchanged, and do not fall back to an unfiltered catalog — that shows a student the items they filtered out |
| `INTERNAL` | 500 | Database unreachable | Retry once, then show the failure. Never render a partial catalog as if it were complete |

**Caching** — `Cache-Control: no-store`, and the route is `force-dynamic`.
`stockQty` and `active` change during a lunch service; a cached body advertises
stock that is already gone. That failure is recoverable (`OUT_OF_STOCK` at
checkout) but there is no edge-cache win worth it at one school's volume.

**Notes**

- **Sold-out items are not in this response.** The filter is `active = true AND
  stockQty > 0`. There is no opt-out param. The catalog page renders sold-out
  cards disabled rather than hidden by reading the database directly in its
  Server Component (`active` only, no stock filter) — the two read paths apply
  different where-clauses on purpose. If a *client-side* surface needs sold-out
  items, request the param in `HANDOFF.md`; do not infer them from a stock count
  of zero, because zero-stock products are simply absent here.
- Stock counts are a snapshot of the instant the query ran. Nothing is reserved
  by reading this endpoint; `stockQty: 3` is not a promise of three. Only the
  checkout transaction holds stock (P3).
- Not rate limited. It is a public read with no side effects.

---

### `GET /api/slots`

Bookable pickup windows from today forward, with live remaining capacity.

**Request** — no params, no body, no auth.

**Response 200** — real output, truncated to the first three of 21:

```json
{
  "slots": [
    {
      "id": "cmtkqayy9000n5p7dr9r6f8nd",
      "label": "Lunch A",
      "startTime": "11:50",
      "location": "Locker bank C",
      "serviceDate": "2026-09-02T00:00:00.000Z",
      "remaining": 21,
      "full": false
    },
    {
      "id": "cmtkqayyc000o5p7d35etrkwu",
      "label": "Lunch B",
      "startTime": "12:20",
      "location": "Locker bank C",
      "serviceDate": "2026-09-02T00:00:00.000Z",
      "remaining": 24,
      "full": false
    },
    {
      "id": "cmtkqayyd000p5p7dqaz9xn8q",
      "label": "Lunch C",
      "startTime": "12:50",
      "location": "Main hall table",
      "serviceDate": "2026-09-02T00:00:00.000Z",
      "remaining": 0,
      "full": true
    }
  ]
}
```

Ordered by `serviceDate` ascending, then `startTime` ascending. Inactive slots
and slots whose service date has passed are omitted entirely.

`capacity` and `bookedCount` are **not** in the payload and will not be added.
The client gets `remaining` (`capacity - bookedCount`, floored at 0) and `full`.
Anything that needs to know whether a seat is available asks for the seat —
`book_slot()` inside the checkout transaction — rather than comparing two
numbers it read earlier (CLAUDE.md §2.4).

`startTime` is a local wall clock (`"HH:MM"`, 24h), not a timestamp. Render it
as-is. `serviceDate` is midnight of the service day; show the date from it, and
do not derive a pickup instant by combining the two on the client.

**Errors**

| `code` | HTTP | Cause | Client action |
|---|---|---|---|
| `INTERNAL` | 500 | Database unreachable | Retry once. Never let checkout proceed with a slot list you could not load |

An empty `slots` array is a valid 200 and means no upcoming windows are open —
say so in the UI rather than showing an empty picker.

**Caching** — `Cache-Control: no-store`, and the route is `force-dynamic`.
Deliberate, and not a performance trade-off: a cached slot list sends a student
into a window that filled thirty seconds ago and turns into a `SLOT_FULL` 409
mid-checkout, at lunch, with a queue behind them. Refetch this list on mount,
and again after any `SLOT_FULL` response.

**Notes**

- `remaining` is a read of a value that concurrent checkouts are moving. It is
  advisory. Two students can both see `remaining: 1` and one of them will get
  `SLOT_FULL` — that is the design, and the client must handle it rather than
  trying to prevent it by polling.
- `full: true` slots are still returned, so the picker can show them disabled
  rather than silently dropping a window the student was looking for. Disable
  them; do not filter them out.
- "Today forward" is computed from server-local midnight, which on Vercel is
  UTC. See `docs/HANDOFF.md` §3 — the timezone fix (`America/Vancouver`) lands
  in P3 with the cutoff check.
- Not rate limited.

---

### `POST /api/checkout`

Turns a cart into an order. Validates, reprices from the database, checks the
daily cap and the ordering cutoff, atomically claims a seat in the pickup window
and the stock for every line, creates the order, and — for card orders — opens a
Stripe PaymentIntent.

**Request** — JSON body. No auth.

| Field | Type | Required | Notes |
|---|---|---|---|
| `studentName` | string | yes | Trimmed. 2–80 chars |
| `email` | string | yes | Trimmed and **lower-cased server-side** before anything uses it. Max 160. Must be a valid address |
| `phone` | string | yes | Trimmed. `^\+?[\d\s()-]{10,20}$` — digits, spaces, brackets, dashes, optional leading `+` |
| `homeroom` | string | no | Trimmed. Max 20 |
| `slotId` | cuid | yes | From `GET /api/slots` |
| `paymentMethod` | `CARD` \| `CASH_AT_PICKUP` | yes | Both are live |
| `items` | array | yes | 1–20 lines |
| `items[].productId` | cuid | yes | From `GET /api/products` |
| `items[].qty` | int | yes | 1–10 per line |
| `clientTotalCents` | int | no | Reconciliation only. See below |

```jsonc
{
  "studentName": "Cash Tester",
  "email": "cash.tester@example.com",
  "phone": "(604) 555-0134",
  "homeroom": "9B",
  "slotId": "cmtkqayye000q5p7dxg1ygklo",
  "paymentMethod": "CASH_AT_PICKUP",
  "items": [
    { "productId": "cmtkqayvk00005p7dl2izvtyt", "qty": 2 },
    { "productId": "cmtkqayy1000k5p7dqcdtzx0i", "qty": 1 }
  ],
  "clientTotalCents": 475
}
```

**Two cart lines for the same `productId` are a 400**, not a merge. A duplicate
means the client cart is corrupt and we would rather hear about it than quietly
guess the intent. De-duplicate in the cart store, not here.

`clientTotalCents` is **evidence, not input**. The server reprices every line
from the database, applies `tax_rate_bps`, and charges its own figure. If the
two disagree the server logs `total_mismatch` and proceeds at the server price —
it does not fail the order, because a staff reprice while a cart was open is a
legitimate race. Render the `totalCents` from the response, not your own, before
sending anyone to a payment form.

**Response 200 — cash**

```json
{
  "orderNumber": "LL-38759",
  "pickupCode": "7GKA",
  "totalCents": 475,
  "requiresPayment": false
}
```

The order is `RESERVED` immediately. There is nothing else to do; show the
pickup code.

**Response 200 — card**

```json
{
  "orderNumber": "LL-56477",
  "totalCents": 400,
  "requiresPayment": true,
  "clientSecret": "pi_3SxK2mABCD1234_secret_9f4b5ed415c4f630f65bacf5"
}
```

Branch on `requiresPayment`, never on the presence of a field.

**There is no `pickupCode` in the card response, and that is deliberate.** A
card order is `PENDING` until Stripe confirms payment. Handing over the locker
code first would let a student present a code for an order that then expired
unpaid. The code becomes available on the confirmation page once the order is
`PAID`.

Confirm the `clientSecret` with Stripe Elements. **A client-side
`status === "succeeded"` never means the order is paid** — only the webhook
writes `PAID` (CLAUDE.md §2.3). After a successful confirmation, poll the order
until its status flips.

**Errors**

| `code` | HTTP | Cause | Client action |
|---|---|---|---|
| `INVALID_INPUT` | 400 | Any field failed validation, a duplicate cart line, or a body that is not JSON. `fields` maps field name → messages (`_body` for an unparseable body) | Highlight the fields. Do not retry unchanged |
| `RATE_LIMITED` | 429 | More than 10 attempts/min from one IP, or 5/min for one email | Wait, then allow one retry. Do not auto-retry in a loop |
| `PRODUCT_UNAVAILABLE` | 409 | A `productId` does not exist or the product was deactivated | Refetch the catalog and rebuild the cart |
| `SPEND_CAP_EXCEEDED` | 409 | This order would push the address past the daily cap. `capCents`, `spentCents` | Terminal for today. Show both numbers |
| `SLOT_FULL` | 409 | The window filled, was deactivated, or does not exist | Refetch `GET /api/slots` and pick again. **Recoverable** |
| `PAST_CUTOFF` | 409 | Now is later than `slotStart - order_cutoff_minutes`. Checked **before** the spend cap: a closed window is refused whether or not the student also has budget left | Refetch slots; that window is closed. Another may not be |
| `OUT_OF_STOCK` | 409 | A line could not be reserved. `productName` names it | Refetch the catalog, drop or reduce that line. **Recoverable** |
| `INTERNAL` | 500 | Database or payment provider failure | Retry **once**. Nothing was charged |

A missing, deactivated, or non-existent slot all return `SLOT_FULL` rather than
a 404. The student's next move is identical in every case, and not
distinguishing them means id-probing tells a scraper nothing.

**Caching** — `Cache-Control: no-store`, route is `force-dynamic`.

**Notes**

- **Nothing partial is ever left behind.** The seat and every line's stock are
  claimed inside one transaction. If line three is sold out, the seat and lines
  one and two are rolled back with it — verified: a two-line cart whose second
  line was sold out left `booked_count` and the first product's `stock_qty`
  byte-identical.
- **Stock is held before payment, not after.** A card order holds its stock and
  its seat for `pending_order_ttl_minutes` (default 15) and the sweep gives them
  back if payment never lands. This is a deliberate trade: an abandoned cart
  briefly hiding a snack is cheaper than charging a student for a snack that is
  not on the shelf.
- **The daily spend cap holds under concurrency.** It is evaluated inside the
  checkout transaction, behind a Postgres advisory lock keyed on
  (lower-cased email + school day), so simultaneous checkouts for one address
  are serialised and each sees the money the previous one committed. Verified:
  six simultaneous 300c cash checkouts for one address against the 1500c cap
  produced five 200s, one `SPEND_CAP_EXCEEDED`, and exactly 1500c committed —
  previously six 200s and 1800c (`docs/HANDOFF.md` §31). Only the *same* mailbox
  serialises; twelve concurrent checkouts across twelve mailboxes all succeeded.
  A client firing `Promise.all` therefore gets 409s, not a bypass — handle them.
- **`SLOT_FULL` and `OUT_OF_STOCK` are normal, not exceptional.** Under load
  they are the *expected* answer for everyone but the winner. Verified: 20
  simultaneous checkouts against a capacity-1 window produced exactly one 200
  and nineteen 409s, `booked_count = 1`, and stock down by exactly one unit.
  Design the UI around them; do not try to prevent them by polling capacity.
- **The cutoff is the school's clock, not the server's.** `America/Vancouver`,
  pinned in `lib/timezone.ts`. Do not compute a cutoff on the client by
  combining `serviceDate` and `startTime` — you will get a different answer than
  the server in every timezone but one.
- **No confirmation email is sent.** Delivery is not built (`lib/email.ts`, and
  `docs/HANDOFF.md`). Do not tell a student to check their inbox. The
  confirmation screen is the receipt.
- Rate limits are per IP (10/min) and per hashed email (5/min).

---

### `POST /api/webhooks/stripe`

Stripe's callback. **The only writer of `PAID`** (CLAUDE.md §2.3). Not for
client use — it is documented here because qa drives it and because frontend
must understand that this, and not Stripe.js, is what confirms an order.

**Request** — the raw Stripe event body, with a `stripe-signature` header.
Verified against `STRIPE_WEBHOOK_SECRET`. The body is read with `req.text()`
and never re-serialised; anything that mutates the bytes breaks the signature.

Handled event types:

| Event | Effect |
|---|---|
| `payment_intent.succeeded` | `PENDING` → `PAID`, sets `paidAt`, clears `expiresAt` |
| `payment_intent.payment_failed` | `PENDING` → `CANCELLED`, releases the stock and the seat |
| `payment_intent.canceled` | Same as above |
| `charge.refunded` | **Any status except `REFUNDED`** → `REFUNDED`, clears `expiresAt`. **Does not** return stock or the slot seat |

Anything else is logged as `webhook_unhandled` and 200s.

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 200 | `ok` | Processed, or intentionally a no-op |
| 200 | `already processed` | Replay. The event id was already recorded, or a claim on it is trusted as actively in flight |
| 400 | `missing signature` | No `stripe-signature` header |
| 400 | `bad signature` | Signature did not verify. Nothing was recorded |
| 409 | `claim ambiguous, retry` | A claim on this event exists, is unfinished, and is old enough that "in flight" is no longer a safe assumption but not yet old enough to reclaim. **Retryable** — Stripe should and will try again on its normal schedule. Never treat this as a final failure |
| 500 | `webhook not configured` | `STRIPE_WEBHOOK_SECRET` unset. Refuses rather than skipping verification |
| 500 | `handler failed` | The dedupe row was deleted so Stripe's retry can reprocess |

**Notes**

- **Replay defence is a two-phase claim on `webhook_events`**, not a
  check-then-insert and no longer a bare insert. Phase one inserts the row with
  `processedAt = null` — that insert races on the primary key, so of N
  simultaneous deliveries exactly one proceeds. Phase two sets
  `processedAt = now()` after the dispatch returns. Only a row with
  `processedAt` set is a finished event.
  Verified: three simultaneous deliveries of one event id produced one `ok` and
  two `already processed`; three simultaneous deliveries with *different* ids
  for one intent produced exactly one `order_paid`; sequential replay produced
  `ok`, `already processed`, `already processed`.
- **A handler that dies mid-dispatch is recovered, not lost** (`docs/HANDOFF.md`
  §32). A row claimed but not finished for longer than **3 minutes**
  (`WEBHOOK_CLAIM_STALE_MS`) is considered abandoned — a kill, an OOM or a
  function timeout — and the next delivery of that event id reclaims it
  atomically and processes it. **For qa:** a fixture that simulates a crash by
  pre-inserting a `webhook_events` row must backdate `createdAt` past that
  window (`now() - interval '10 minutes'`), otherwise it is indistinguishable
  from a live delivery and is correctly ignored.
- **A claim's age is split into three bands, not two**, closing a residual gap
  recorded and resolved in `docs/HANDOFF.md` §32 ("Residual 2"): younger than
  **10 seconds** (`WEBHOOK_CLAIM_TRUST_MS`) is trusted as genuinely in-flight
  and answered `already processed` 200 — real dispatch finishes in
  milliseconds, so this is what keeps concurrent duplicate delivery idempotent.
  Between 10 seconds and 3 minutes is answered **409** (above), never 200 —
  telling Stripe an event is handled while there is real doubt is exactly how
  a crash whose first retry lands inside the old single window got silently
  lost twice. Past 3 minutes, it reclaims. **For qa:** a test that delays a
  duplicate delivery past 10 seconds should now expect 409, not 200.
- **Stripe does not guarantee event ordering, and the handlers no longer assume
  it does.** `charge.refunded` arriving before `payment_intent.succeeded` takes
  the order straight to `REFUNDED` (a refund can only exist for a charge that
  really succeeded), and the later succeeded event finds no `PENDING` order and
  no-ops. Verified in both directions: refund-then-succeeded and
  succeeded-then-refund both end at `REFUNDED`. In the reversed case `paidAt`
  stays null — the payment confirmation never arrived while the order was still
  claimable, and stamping a fabricated time into a money field would be worse
  than a null. **Do not treat `paidAt` as "was this ever paid" for a `REFUNDED`
  order.** A `order_refunded_before_payment` log line marks each occurrence.
- **A payment whose amount disagrees with the order is refused**, logged as
  `webhook_amount_mismatch`, and the order is frozen out of the sweep
  (`expiresAt` cleared) but left `PENDING` for a human. It never becomes `PAID`.
- A refund does **not** restock and does **not** free the pickup seat, in any of
  the transitions above — including the `PENDING` → `REFUNDED` one, where the
  order never became collectable. Staff adjusts inventory by hand (P4). Erring
  towards holding stock can never oversell; erring the other way can.
- Signature verification is local HMAC. Tests can drive this route with
  `stripe.webhooks.generateTestHeaderString({ payload, secret })` and no Stripe
  account — see `docs/HANDOFF.md`.

---

### `GET /api/orders/[orderNumber]`

The confirmation page. Reads one order back: status, money, lines, pickup window,
and — once the order is actually claimable — the pickup code. This is what
`/order/[orderNumber]` polls after a card payment.

**Request** — no body, no query params. `orderNumber` is the value returned by
`POST /api/checkout` (`LL-#####`). Case-insensitive in the URL.

**Auth: the cookie set by `POST /api/checkout`, not the URL.** Every successful
checkout response carries

```
Set-Cookie: ll_ord_LL-46154=<signed token>; Path=/api/orders; Max-Age=172800;
            HttpOnly; SameSite=Lax[; Secure in production]
```

One cookie per order, named after the order number, valid 48 hours. It is
`HttpOnly` — no script can read it and none needs to.

**For frontend, this is the entire integration:**

- Poll from the **client**, with an ordinary same-origin `fetch("/api/orders/" + orderNumber)`.
  The default `credentials: "same-origin"` already sends the cookie; setting
  `credentials: "omit"` breaks it.
- **A Server Component cannot fetch this.** A server-side `fetch` does not carry
  the browser's cookies unless you forward them by hand. The confirmation page's
  polling belongs in a client component.
- Nothing needs to be remembered across the Stripe redirect. No `sessionStorage`,
  no email in a query string, no PII in the URL at all (CLAUDE.md §2.6). The
  cookie is `SameSite=Lax`, so it survives the top-level navigation back from
  Stripe.
- Two orders in one sitting both stay readable — the cookies do not overwrite
  each other.

**Response 200**

```jsonc
{
  "orderNumber": "LL-46154",
  "status": "RESERVED",                    // OrderStatus, §3
  "paymentMethod": "CASH_AT_PICKUP",
  "subtotalCents": 800,
  "taxCents": 0,
  "totalCents": 800,
  "pickupCode": "TWM3",                    // ONLY when status is RESERVED or PAID
  "expiresAt": null,                       // ISO string only while a card order is PENDING
  "placedAt": "2026-09-03T04:43:41.991Z",
  "slot": {
    "label": "Lunch A",
    "startTime": "11:50",                  // local wall clock, 24h
    "location": "Locker bank C",
    "serviceDate": "2026-09-04T00:00:00.000Z"
  },
  "items": [
    {
      "productId": "cmtl15gos0002vp7dhfk4vb0o",
      "qty": 2,
      "nameSnapshot": "Milk Chocolate Bar",
      "unitPriceCents": 250,
      "raritySnapshot": "UNCOMMON",
      "allergensSnapshot": ["DAIRY", "SOY"]
    }
  ]
}
```

**`pickupCode` is present only when `status` is `RESERVED` or `PAID`.** It is a
key field, not a display field: it opens a locker. A `PENDING` card order may
still expire unpaid and hand its stock and its seat back, so a code for it would
stand for nothing. Branch on the status, and never render an empty code box —
the field is **omitted**, not `null`.

**The line items are the purchase snapshots** (`nameSnapshot`, `unitPriceCents`,
`raritySnapshot`, `allergensSnapshot`), not the live product. Render
`allergensSnapshot` **in full, never truncated, never hover-only** — this is the
receipt surface CLAUDE.md §2.8 is written about.

**No `studentName`, `email`, `phone` or `homeroom` are returned, at all.** The
cookie proves whose order this is; that is not a reason to hand a child's contact
details back over HTTP to draw a receipt that does not need them. If a screen
ever genuinely needs them, ask in `HANDOFF.md` — do not assume the field is
coming.

`capacity` and `bookedCount` are not returned either, for the same reason as
`GET /api/slots`.

**Polling recipe (card):** after Stripe Elements reports success, poll every
1.5 s for up to 20 s and stop on the first `status` that is not `PENDING`. If it
is still `PENDING` when the budget runs out, say **"confirming your payment"** and
keep a manual refresh available — never "paid". Only the webhook writes `PAID`
(CLAUDE.md §2.3). If `status` comes back `EXPIRED` or `CANCELLED`, stop polling:
the hold is gone and the cart has to be rebuilt.

Two things about `expiresAt` that the page must get right:

- **`status: "PENDING"` with `expiresAt: null` is a frozen order, not a live
  one.** Only one thing produces it: the payment reached Stripe with an amount
  that did not match the order, so the webhook refused it and parked the order
  out of the expiry sweep's reach for a human to look at. It will never become
  `PAID` on its own. Stop polling and send the student to staff — do not say
  "paid", do not say "expired".
- **A `PENDING` order whose `expiresAt` is already in the past is dead**, even
  though the sweep may take up to five more minutes to say so. Treat the
  timestamp as authoritative rather than waiting for the status to catch up.

**Errors**

| `code` | HTTP | Cause | Client action |
|---|---|---|---|
| `ORDER_NOT_FOUND` | 404 | Unknown order number, **or** no cookie, **or** an expired/forged cookie, **or** a valid cookie for a different order | Show "we can't find that order" and offer the catalog. Do not retry in a loop |
| `INTERNAL` | 500 | Database failure, or `ORDER_SESSION_SECRET` unset on the server | Retry once |

All four `ORDER_NOT_FOUND` causes are indistinguishable by design. `LL-#####` is
a 90,000-value space; an error that admitted "wrong cookie" would confirm that an
order exists and turn the route into an enumeration oracle. Same reasoning as
`SLOT_FULL` in checkout.

**Caching** — `Cache-Control: no-store`, route is `force-dynamic`. This is a
per-student receipt behind a cookie: a shared cache keyed on the URL alone would
hand one student's pickup code to the next.

**Notes**

- The token is an HMAC-SHA256 over `v1.<orderId>.<expiry>` signed with
  `ORDER_SESSION_SECRET` (`lib/order-session.ts`). It binds the order's database
  id, and the route then checks that the row it resolved carries the order number
  in the URL — so a cookie for order A cannot read order B by editing the address
  bar, even if it is renamed to B's cookie name. Verified both ways.
- **Not rate limited**, deliberately. The database is only touched after a
  signature verifies, so guessed order numbers cost one HMAC and no query — there
  is no enumeration surface to protect. A per-IP limit would also be actively
  harmful here: the whole school shares one NAT address and the confirmation page
  polls at 1.5 s.
- Read-only. It never writes, never touches stock or slot capacity, and is safe
  to poll.
- `ORDER_SESSION_SECRET` is required in production. With it unset,
  `POST /api/checkout` refuses (500) rather than creating orders whose receipt
  nobody could ever open. In dev and CI an ephemeral per-process key is used
  instead, so cookies work out of the box and stop verifying on restart.

---

### `GET /api/cron/sweep`

Expires unpaid card orders and gives back what they were holding. Called by
Vercel Cron every 5 minutes (`vercel.json`), not by any client.

**Request** — `Authorization: Bearer $CRON_SECRET`. Compared in constant time.
No secret configured means nobody is authorised.

**Response 200**

```json
{ "scanned": 1, "released": 1, "failed": 0 }
```

`scanned` is how many stale orders were found (max 100 per run), `released` how
many this run actually moved to `EXPIRED` — a lower number is normal and means
another process got there first. `failed` is per-order errors; one bad order
does not abort the run.

**Errors** — `401 unauthorized` (plain text, no error envelope: this route has
no client to branch on codes).

**Notes**

- Selects `status = PENDING AND paymentMethod = CARD AND expiresAt < now()`.
  Cash orders are never swept — they are `RESERVED` from creation and nothing
  expires them.
- Cancels at Stripe **before** releasing. If payment lands a millisecond later,
  the succeeded webhook finds a non-`PENDING` order and no-ops, so the money is
  never taken for stock that has already been given back.
- Idempotent. Verified: a second run immediately after returns
  `{"scanned":0,"released":0,"failed":0}` and stock is unchanged.
- Worst case an abandoned cart holds stock for `pending_order_ttl_minutes` + 5.

---

## 6a. Staff admin (P4) — `/api/admin/*`

Everything in this section requires a staff session. Nothing in it is reachable
by a student, and none of it shares a secret, a cookie, or a code path with the
student-facing confirmation cookie.

### Authentication

| | |
|---|---|
| Credential | **One shared passcode**, `ADMIN_PASSCODE`. No staff roster, no per-person accounts — a **placeholder** pending a human decision (`docs/HANDOFF.md` §53) |
| Session | `ll_admin` cookie: HMAC-SHA256 over `v1.<sessionId>.<expiry>`, signed with `ADMIN_SESSION_SECRET` |
| Cookie flags | `HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` (8 h), plus `Secure` in production |
| Scope | Every `/api/admin/*` route. **Not** the student receipt routes, and vice versa |

`ADMIN_SESSION_SECRET` is a **different secret from `ORDER_SESSION_SECRET`**, on
purpose. Verified both directions: a token minted with one key does not verify
under the other, and the cookie names (`ll_admin` vs `ll_ord_<orderNumber>`) do
not collide. A leak in the student receipt path can never become staff access.

**For frontend, this is the whole integration:**

- `POST /api/admin/login` once with the passcode. The cookie is set for you.
- Every subsequent call is an ordinary same-origin `fetch`. The default
  `credentials: "same-origin"` sends the cookie; `credentials: "omit"` breaks it.
- `Path=/`, so unlike the receipt cookie a Server Component **can** read it and
  decide whether to render a sign-in form. **That is a rendering decision only.**
  Never treat the presence of the cookie as permission to display data you have
  not actually fetched — the route handlers are the authorisation boundary and
  they check it themselves.
- On any `401 ADMIN_UNAUTHORIZED`, show the sign-in form. It means the session
  expired, was never there, or the secret was rotated.
- On `503 ADMIN_NOT_CONFIGURED`, the server has no passcode or no signing
  secret. Nobody can sign in; this is an ops problem, not a typo. Say so.

**CSRF.** `SameSite=Lax` withholds the cookie from every cross-site POST, and
that is the entire CSRF defence for these routes. It holds only while the rule
below holds, so it is stated as a contract and not as an implementation detail:

> **No `/api/admin` route may ever perform a side effect on a `GET`.** Lax
> *does* send this cookie on a cross-site top-level GET navigation.

**Sessions cannot be revoked individually.** There is no server-side session
store, so `POST /api/admin/logout` clears the browser's cookie but a token
already copied elsewhere stays valid until it expires. The only way to revoke
everything at once is to rotate `ADMIN_SESSION_SECRET`, which invalidates every
outstanding staff session immediately.

### PII rule for every route in this section

**`studentName` and `homeroom` only. `email` and `phone` appear nowhere, at any
nesting level, in any admin response.** Staff need to identify a person standing
at a locker, not contact them, and this list gets printed and left on a table
(CLAUDE.md §2.6). If a screen genuinely needs to reach a family, request it in
`HANDOFF.md` — do not assume a field is coming.

The same rule holds in the logs: admin events carry an order's **cuid** and the
session id, never a name, an email, a phone number or a pickup code. Verified by
grepping a full dev-server log after exercising every route — zero hits for any
of them.

---

### `POST /api/admin/login`

**Request**

```json
{ "passcode": "..." }
```

Not trimmed — a passcode may legitimately contain spaces, and silently editing
a credential before comparing it means the value that works is not the value
that was configured.

**Response 200** — sets the `ll_admin` cookie.

```json
{ "ok": true, "expiresAt": "2026-09-04T11:42:50.791Z" }
```

Use `expiresAt` to warn before the session ends rather than dropping a staff
member out mid-handover with an unexplained 401.

**Errors**

| `code` | HTTP | Cause | Client action |
|---|---|---|---|
| `ADMIN_UNAUTHORIZED` | 401 | Wrong passcode | Let them retype it. Do not auto-retry |
| `INVALID_INPUT` | 400 | Missing/oversized `passcode`, or a body that is not JSON | Fix the form |
| `RATE_LIMITED` | 429 | Over the login budget | Wait. Do **not** loop |
| `ADMIN_NOT_CONFIGURED` | 503 | `ADMIN_PASSCODE` or `ADMIN_SESSION_SECRET` unset, or the passcode is shorter than 8 characters | Ops problem. Show it as one |

**Rate limits — 10 per IP per 5 minutes, and 60 globally per 5 minutes.**

The global bucket is the one that matters: there is exactly **one** credential on
this system, so the realistic attack is a botnet guessing it from ten thousand
addresses, which a per-IP limit does not slow down at all. The trade is
deliberate and is recorded in `HANDOFF.md` — an attacker who burns the global
bucket locks staff out mid-service, and a lockout is visible and recoverable in
minutes where a guessed passcode is neither.

Unlike `POST /api/checkout`, **the limiter runs before the body is parsed**, so
malformed bodies are counted too. Verified: 10 × 400 then 429.

---

### `POST /api/admin/logout`

No body. Clears the cookie and returns `{ "ok": true }`. Deliberately does
**not** require a valid session — an expired or corrupt cookie is exactly the
state a staff member most needs to be able to clear.

---

### `GET /api/admin/session`

"Am I signed in?" A pure read with no side effect.

**Response 200** — `{ "authenticated": true, "sessionId": "f9f73180e619" }`

`sessionId` identifies a **sign-in, not a person**. It exists so a sequence of
actions in the logs can be correlated without naming anybody. Do not display it
as a user identity.

**Errors** — `ADMIN_UNAUTHORIZED` 401, `ADMIN_NOT_CONFIGURED` 503.

---

### `GET /api/admin/orders`

**THE PICK LIST.** One service day, grouped by pickup window, with everything
needed to pack and hand out bags in a single request — no per-order round trip,
nothing lazy-loaded, so the page can be printed before service and used with no
network at the locker (BUILDPLAN P4 gate).

**Request** — query string.

| Param | Type | Default | Notes |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | today **in the school's timezone** | The school's calendar day. `2026-02-31` is a 400, not a silent roll-forward to March |
| `slotId` | cuid | — | One window. **When present, `date` is ignored**, so a stale date cannot answer a locker screen with an empty list. The response's `serviceDate` says which day came back |
| `status` | comma-separated `OrderStatus` | see below | Validated against the enum; `?status=NOPE` is a 400, not an empty filter |

**Default statuses: `RESERVED`, `PAID`, `PACKED`, `PICKED_UP`, `REFUNDED`.**

`PENDING` is **excluded by default and this is deliberate.** An unpaid card order
holds a seat and stock but may evaporate when the sweep runs, and this response
is what gets printed — a printed pick list containing unpaid orders is a bag
handed to a student who never paid. It is one query param away
(`?status=PENDING`), not unreachable. `CANCELLED` and `EXPIRED` are excluded
because they released everything they held. `REFUNDED` **is** included: it still
holds its stock and its seat and staff need it to reconcile the shelf.

**Response 200**

```jsonc
{
  "serviceDate": "2026-09-03T00:00:00.000Z",
  "statuses": ["RESERVED", "PAID", "PACKED", "PICKED_UP", "REFUNDED"],
  "slots": [
    {
      "id": "cmtkqayy9000n5p7dr9r6f8nd",
      "label": "Lunch A",
      "startTime": "11:50",              // local wall clock, 24h
      "location": "Locker bank C",
      "serviceDate": "2026-09-03T00:00:00.000Z",
      "active": true,
      "capacity": 24,
      "bookedCount": 18,
      "remaining": 6,
      "counts": {
        "total": 18,                     // EVERY order in the window
        "listed": 7,                     // how many are in `orders` below
        "byStatus": { "PENDING": 10, "RESERVED": 6, "CANCELLED": 1, "PICKED_UP": 1 }
      },
      "cashDueCents": 1075,              // sum over the listed orders
      "productTotals": [
        { "productId": "cmt…", "nameSnapshot": "Gummy Bear Pouch",  "qty": 6, "allergens": [] },
        { "productId": "cmt…", "nameSnapshot": "Sour Rainbow Belts","qty": 1, "allergens": ["SULPHITES"] }
      ],
      "orders": [
        {
          "orderNumber": "LL-53802",
          "pickupCode": "PGQC",
          "studentName": "Test Student",
          "homeroom": "9B",
          "status": "RESERVED",
          "paymentMethod": "CASH_AT_PICKUP",
          "subtotalCents": 325,
          "taxCents": 0,
          "totalCents": 325,
          "cashDueCents": 325,
          "paidAt": null,
          "expiresAt": null,
          "placedAt": "2026-09-03T12:30:05.793Z",
          "allergens": ["SULPHITES"],
          "items": [
            {
              "productId": "cmt…",
              "qty": 1,
              "nameSnapshot": "Sour Rainbow Belts",
              "unitPriceCents": 175,
              "raritySnapshot": "COMMON",
              "allergensSnapshot": ["SULPHITES"]
            }
          ]
        }
      ]
    }
  ]
}
```

Slots are ordered by `serviceDate`, `startTime`, `location`. Orders within a
slot are ordered by `studentName`, then `pickupCode` — a printed sheet is read
by looking up a name.

**Field notes that change what you render:**

- **`counts` is over EVERY order in the window, `orders` is only the requested
  statuses.** That is what reconciles a `bookedCount` of 18 against a list of 7:
  the other 11 are `PENDING`/`CANCELLED`. Show the gap; a staff member who
  cannot explain why a window looks full will stop trusting the screen.
- **`order.allergens` is the union across that order's lines**, in canonical
  enum order — a bag-label warning. It does **not** replace
  `items[].allergensSnapshot`, which is also returned in full, because the
  aggregate cannot say *which* item carries the peanuts. **Render both, in full,
  never truncated, never hover-only** (CLAUDE.md §2.8). This is a printed sheet;
  there is no hover on paper.
- **`items[]` are the purchase snapshots**, never the live product (§4). A
  product renamed or re-priced this morning does not change what a bag packed
  against yesterday's order says it contains.
- **`productTotals` is the shelf-pull list** for the window: quantities summed
  over `RESERVED`, `PAID` and `PACKED` only. `PICKED_UP` is already gone and
  `REFUNDED` is not being handed to anyone.
- **`cashDueCents`** (per order and per slot) is integer cents still to collect.
  It is `0` for every card order and for any cash order already recorded paid.
- **`pickupCode` is present for every listed order**, unlike the student receipt
  which withholds it until the order is claimable. Staff are the ones who verify
  it.
- **Inactive slots are included.** Deactivating a window does not cancel the
  orders in it and those bags still have to be handed out. Show `active: false`.

**Errors** — `ADMIN_UNAUTHORIZED` 401, `ADMIN_NOT_CONFIGURED` 503,
`INVALID_INPUT` 400 (bad `date`, `slotId` or `status`), `INTERNAL` 500.

**Caching** — `Cache-Control: no-store`, route is `force-dynamic`. This is live
operational state behind a staff cookie; a shared cache keyed on the URL would
serve one school's children's names and live pickup codes to whoever asked next.

---

### The order action routes — shared behaviour

The next four all take `[orderNumber]` in the path (case-insensitive) and share
these rules, so they are stated once:

- **Every one of them is idempotent, by a conditional `UPDATE`, not by a check.**
  The response carries `changed: boolean`. `changed: false` with a 200 means the
  order was already in that state — a double-pressed button, or a second staff
  phone — and nothing was written. **Treat it as success.** Verified: 15
  simultaneous requests to each route produced exactly `changed=1, noop=14`,
  every time, on every route.
- **`INVALID_STATUS_TRANSITION` (409) carries `status` and `expected`.** Render
  both: "this order is `EXPIRED`; this only works from `RESERVED` or `PAID`" is
  actionable at a locker and "something went wrong" is not.
- Bodies are JSON. A non-JSON body is `INVALID_INPUT` with `fields._body`.
- All respond `Cache-Control: no-store`.
- **Unknown fields in the body are ignored** and can never influence anything.
  In particular there is no amount field on any of them (see the refund route).

---

### `POST /api/admin/orders/[orderNumber]/pack`

The bag is packed. No student is present and no money moves, so the body is
empty (`{}`).

**Allowed from `RESERVED` (cash) and `PAID` (card).** Not from `PENDING`: an
unpaid card order can still expire and hand its stock back, and packing against
it means a snack off the shelf for an order that is about to stop existing.

**Response 200**

```json
{
  "orderNumber": "LL-54795",
  "status": "PACKED",
  "changed": true,
  "allergens": ["SULPHITES"],
  "cashDueCents": 175,
  "pickupCode": "WEWP"
}
```

`allergens` is repeated here so the confirmation the staff member sees carries
the warning, not just the list they came from. `cashDueCents` is on this response
so the amount to collect is on screen **before** the handover, not discovered at
it.

**Errors** — `ADMIN_UNAUTHORIZED` 401, `ORDER_NOT_FOUND` 404,
`INVALID_STATUS_TRANSITION` 409, `INTERNAL` 500.

---

### `POST /api/admin/orders/[orderNumber]/pickup`

**The handover.** The bag leaves the locker and goes to a person.

**Request**

```json
{ "pickupCode": "WEWP" }
```

**`pickupCode` is required, always.** Trimmed and upper-cased server-side, so a
scanner or a phone keyboard can send `wewp`. This is the only moment the person
in front of staff is tied to the bag, and the bag may contain the one snack in
the building that a different student cannot eat.

**Allowed from `RESERVED`, `PAID`, `PACKED`.**

**Two guards, and both refuse rather than warn:**

1. A wrong code is `PICKUP_CODE_MISMATCH` (409), checked **before** status and
   money so a wrong code cannot be used to probe what is in the locker.
2. A cash order with no recorded payment is `CASH_NOT_COLLECTED` (409) with
   `totalCents`. **There is no override.** Collecting the money and handing over
   the bag are one action in the real world and two writes here; refusing the
   second until the first is recorded is what stops "I'll ring it in after
   lunch" from becoming money nobody can reconstruct. The remedy is one call to
   the cash route below, which is the thing staff should be doing anyway.
   A comped or free order is a policy question, not a button (`HANDOFF.md` §53).

**Response 200**

```json
{
  "orderNumber": "LL-54795",
  "status": "PICKED_UP",
  "changed": true,
  "cashDueCents": 0,
  "allergens": ["SULPHITES"]
}
```

An order that is already `PICKED_UP` returns `changed: false` **without** the
cash guard firing — the bag is gone and nothing this route does can un-hand it —
but `cashDueCents` is still reported so the screen can chase the money.

**Errors** — `ADMIN_UNAUTHORIZED` 401, `ORDER_NOT_FOUND` 404, `INVALID_INPUT`
400, `PICKUP_CODE_MISMATCH` 409, `CASH_NOT_COLLECTED` 409,
`INVALID_STATUS_TRANSITION` 409, `INTERNAL` 500.

---

### `POST /api/admin/orders/[orderNumber]/cash`

**Money changes hands.** A student puts coins on the table and this is the only
record that it happened.

**Request**

```jsonc
{ "pickupCode": "WEWP" }   // optional; verified when present
```

Optional here, unlike the handover: staff may take the money while the bag is
still on the bench, before the student is standing there.

**`CASH_AT_PICKUP` only.** A card order is `PAYMENT_METHOD_MISMATCH` (409) with
`paymentMethod`, and every underlying `UPDATE` additionally carries
`paymentMethod = 'CASH_AT_PICKUP'` in its `WHERE` clause. **CLAUDE.md §2.3 — only
the Stripe webhook writes `PAID` for a card order — is therefore held
structurally, not by convention:** this route cannot mark a card order paid even
if it is called with one. A cash order has no payment gateway to be a source of
truth, so an authenticated staff member at the locker *is* the source of truth,
and there is nowhere else the fact could come from.

**Allowed from `RESERVED`, `PACKED`, `PICKED_UP`.**

**The status it writes depends on where the order was, and this matters:**

| From | Result |
|---|---|
| `RESERVED` | → `PAID`, `paidAt` set |
| `PACKED` | stays **`PACKED`**, `paidAt` set |
| `PICKED_UP` | stays **`PICKED_UP`**, `paidAt` set |

`OrderStatus` has one slot and two facts to hold — has the money arrived, and
has the bag been made — and cash can legitimately be taken before or after
packing. So `paidAt` is the money fact and `status` is the fulfilment fact, and
`PACKED` is never walked backwards to `PAID`.

> **Read `paidAt`, not `status === "PAID"`, to decide whether a cash order has
> been paid.** A `PACKED` cash order can be fully paid. This is the single
> easiest thing to get wrong on the admin screen.

**Response 200**

```json
{
  "orderNumber": "LL-54795",
  "status": "PACKED",
  "paidAt": "2026-09-04T03:43:34.274Z",
  "changed": true,
  "cashDueCents": 0,
  "collectedCents": 175
}
```

Idempotent on `paidAt`, not on status: a second press returns `changed: false`
with the **original** timestamp. The record of when the money actually arrived is
never overwritten.

**Errors** — `ADMIN_UNAUTHORIZED` 401, `ORDER_NOT_FOUND` 404, `INVALID_INPUT`
400, `PAYMENT_METHOD_MISMATCH` 409, `PICKUP_CODE_MISMATCH` 409,
`INVALID_STATUS_TRANSITION` 409, `INTERNAL` 500.

---

### `POST /api/admin/orders/[orderNumber]/refund`

**Manual refund.** Money goes back to a family. Card orders go through Stripe;
cash orders record the fact, since no gateway was involved.

**Request**

```jsonc
{ "releaseSlotSeat": false }   // optional, default false
```

**There is no amount field, and there will not be one.** The refund is
`order.totalCents` as stored — the figure the server itself computed from
database prices and wrote behind the `order_total_consistent` CHECK constraint
(CLAUDE.md §2.2). A staff-supplied amount is a client-supplied money value with
a friendlier name. Any `amountCents` in the body is ignored and can reach
nothing. **Partial refunds are therefore impossible here**, deliberately: they
need a policy (who may, for what, and does the daily cap get the money back)
before they need an endpoint (`HANDOFF.md` §53).

`releaseSlotSeat` gives the pickup window's seat back as well as the money. It
defaults to **`false`**: `bookedCount` is physical handout throughput, and a
refund late in a service does not create the staff-time to hand out one more
bag. Staff who know the window still has room tick it. It is honoured only when
the bag has **not** been handed over (`PAID`/`PACKED`); a `PICKED_UP` order
consumed its throughput for real and never gets the seat back.

**Allowed from `PAID`, `PACKED`, `PICKED_UP`.** Already-`REFUNDED` returns
`changed: false`.

Notably **not** allowed from `CANCELLED` or `EXPIRED`, and this is the direct
answer to the P4 hazard recorded in `HANDOFF.md` §50(c): those are exactly the
statuses whose stock and seat were **already** given back by the release path,
and the standing instruction "a refund does not restock, adjust inventory by
hand" applied to such a row restocks a second time and oversells. Because every
status this route accepts still holds its stock, **`stockStillHeld: true` in the
response is a fact, not a default.** (Stripe's own `charge.refunded` webhook can
still move a `CANCELLED`/`EXPIRED` order to `REFUNDED`; that path is unchanged
and is the one to be careful with.)

Not allowed from `RESERVED` either: an unpaid cash order is a cancellation, not
a refund, and **there is no cancel route yet** (`HANDOFF.md` §53). A cash order
that was packed but never paid returns `CASH_NOT_COLLECTED` — there is no money
to send back and saying "refunded" would put a fiction in the books.

**Response 200**

```jsonc
{
  "orderNumber": "LL-95291",
  "status": "REFUNDED",
  "changed": true,
  "refundedCents": 175,
  "paymentMethod": "CARD",
  "alreadyRefundedAtStripe": false,
  "stockStillHeld": true,
  "itemsToAdjust": [
    {
      "productId": "cmtlfpsen0001v57dkjtmrxpf",
      "nameSnapshot": "Sour Rainbow Belts",
      "qty": 1,
      "suggestedDelta": 1
    }
  ],
  "slotSeatReleased": true
}
```

- **`stockStillHeld` is always `true` from this route.** A refund does **not**
  restock — the snack may already be packed, damaged or eaten. `itemsToAdjust`
  is exactly what staff would put back and the `suggestedDelta` to POST to the
  stock route **if, and only if, it is physically back on the shelf.** Nothing
  applies it automatically, for exactly that reason. Render this as a prompt,
  never as a completed action.
- `alreadyRefundedAtStripe: true` means Stripe reported the charge was already
  fully refunded, so this call moved no money. The order is still recorded
  `REFUNDED`, because that is the true state.
- `slotSeatReleased` reflects what actually happened, not what was asked.

**Ordering, and why a failure looks the way it does.** Stripe is called
**before** the status is written. If the status write then fails, the money is
back with the family and our order still says `PAID` — visibly wrong, and
self-healing, because Stripe's `charge.refunded` webhook arrives and writes
`REFUNDED`. The reverse order fails the other way: an order marked `REFUNDED`
for money that never moved, which nothing corrects and nobody notices until a
parent asks. A `REFUND_FAILED` therefore means **nothing was refunded and
nothing was changed** — safe to retry.

Concurrent refunds are safe: every attempt reaches Stripe with the same
idempotency key (`re_<orderId>`), so Stripe creates one refund and returns it to
all of them, and exactly one then matches the conditional status update.
Verified: 15 simultaneous refunds produced one refund, one status change, and
exactly one seat decrement.

**Errors** — `ADMIN_UNAUTHORIZED` 401, `ORDER_NOT_FOUND` 404, `INVALID_INPUT`
400, `INVALID_STATUS_TRANSITION` 409, `CASH_NOT_COLLECTED` 409, `REFUND_FAILED`
502 (`reason`: `NO_PAYMENT_INTENT` | `PROVIDER_ERROR`), `INTERNAL` 500.

---

### `POST /api/admin/products/[productId]/stock`

Manual stock correction: a delivery arrived, a box was miscounted, something got
dropped.

**Request**

```json
{ "delta": -3 }
```

| Field | Type | Notes |
|---|---|---|
| `delta` | int | **Signed and relative.** Non-zero, \|delta\| ≤ 10000 |

**There is no absolute "set stock to N", and that is a correctness requirement,
not an interface preference.** "Set stock to 7" is a read-then-write with a
human in the middle: staff count the shelf, walk to the tablet, and in between a
student's checkout reserves a unit — writing 7 silently un-reserves it and the
shelf oversells (CLAUDE.md §2.4). A delta composes with whatever else happened.
**Compute the delta for staff in the UI** (they counted 7, the screen showed 9,
send `-2`); do not ask the API to relax the invariant.

Applied by `adjust_stock()`, which does its bound check and its write in one
`UPDATE`. Verified: 40 simultaneous `+1` adjustments returned 40 **distinct**
quantities and landed exactly `+40` — no lost updates. And 20 concurrent
checkouts interleaved with 20 concurrent `+1` adjustments left stock exactly
where it started (`-20 +20`), with zero deadlocks.

Works on **inactive** products too — that is exactly when a miscount is
discovered.

**Response 200**

```json
{
  "productId": "cmtlfpsen0001v57dkjtmrxpf",
  "name": "Sour Rainbow Belts",
  "stockQty": 31,
  "delta": -3,
  "previousStockQty": 34,
  "active": true,
  "allergens": ["SULPHITES"]
}
```

`stockQty` is authoritative — read out of the same `UPDATE` that made the change,
so it already includes any concurrent checkout that landed first. It will
sometimes not equal what the staff member expected, and that is the point; show
the number, not their arithmetic.

**Errors**

| `code` | HTTP | Cause |
|---|---|---|
| `INVALID_INPUT` | 400 | `delta` missing, zero, fractional, or out of range |
| `ADMIN_UNAUTHORIZED` | 401 | No staff session |
| `PRODUCT_UNAVAILABLE` | 409 | No such product, or a malformed id |
| `STOCK_ADJUSTMENT_REJECTED` | 409 | Would leave a negative quantity. Carries `productId`, the current `stockQty` and the `delta` |
| `INTERNAL` | 500 | Usually: `manual_constraints.sql` has not been re-run, so `adjust_stock` does not exist |

**One hazard staff must be told about, in the UI.** `lib/db/release.ts` restocks
without a ceiling when a card order expires or a payment fails
(`HANDOFF.md` §7). If staff hand-adjust for an order that then releases, the
quantity is added twice and the shelf claims stock that does not exist. Nothing
in the database prevents it. **Adjust for what is physically on the shelf, not
for what an order did.**

---

## 6b. Restricted inventory editor (P4b) — `/api/inventory/*`

Day-to-day catalog upkeep, held by two thirteen-year-old family members. This is
a **third, structurally independent auth system** — not a reduced view of §6a and
not a role flag inside it.

> **THE BOUNDARY, stated as a contract.** No route in this section can read or
> write an `Order`, an `OrderItem` or a `Setting`. No student name, email, phone,
> homeroom, pickup code, order number, payment status, refund or Stripe object is
> reachable with an inventory session, at any nesting level, in any response, on
> any route — including error bodies. The only model any handler in this
> namespace touches is `Product`, and the only columns it returns are the
> fourteen listed under "Product shape" below.
>
> This is enforced at the route and auth level, not by hiding UI, and it is
> checked mechanically: `node scripts/verify-inventory-isolation.mjs` fails the
> build if any inventory source file names a forbidden model, imports the staff
> session module, the Stripe client, `lib/settings`, `lib/db/admin` or
> `lib/db/release`, writes on a `GET`, skips the session gate, or returns a
> column outside the whitelist. **Run it in CI.** It exits non-zero on violation.

### Authentication

| | |
|---|---|
| Credential | **One shared passcode**, `INVENTORY_PASSCODE`. Separate from `ADMIN_PASSCODE` — these two people must not hold the staff credential (`docs/HANDOFF.md` §61) |
| Session | `ll_inventory` cookie: HMAC-SHA256 over `v1.<sessionId>.<expiry>`, signed with `INVENTORY_SESSION_SECRET` |
| Cookie flags | `HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` (8 h), plus `Secure` in production |
| Scope | Every `/api/inventory/*` route. **Nothing else** |

`INVENTORY_SESSION_SECRET` is a **different secret from both
`ADMIN_SESSION_SECRET` and `ORDER_SESSION_SECRET`**. Verified in every direction
over real HTTP: a staff `ll_admin` token presented as `ll_inventory` is a 401, an
inventory token presented as `ll_admin` is a 401, an inventory token renamed onto
a receipt cookie is `ORDER_NOT_FOUND`, and presenting a valid staff cookie
alongside an inventory request authorises nothing. Rotating one secret revokes
one role's sessions and leaves the other two signed in.

**For frontend, this is the whole integration** — identical in shape to §6a, with
different names:

- `POST /api/inventory/login` once with the passcode. The cookie is set for you.
- Every subsequent call is an ordinary same-origin `fetch`; the default
  `credentials: "same-origin"` sends the cookie, `credentials: "omit"` breaks it.
- On `401 INVENTORY_UNAUTHORIZED`, show the inventory sign-in form. **Never fall
  back to the staff sign-in form** — they are different credentials and offering
  one in place of the other is how the wrong passcode ends up in the wrong hands.
- On `503 INVENTORY_NOT_CONFIGURED`, this server has no inventory passcode or no
  signing secret. Nobody can sign in; it is an ops problem. Note that the staff
  screen is unaffected — the two configurations are independent, verified.

**CSRF.** `SameSite=Lax` is the entire defence, on the same terms as §6a:

> **No `/api/inventory` route may ever perform a side effect on a `GET`.** The
> isolation script asserts this; a `GET` that writes turns the cookie into a CSRF
> hole because Lax *does* send it on a cross-site top-level GET navigation.

**Sessions cannot be revoked individually** (no server-side store). Logout clears
the browser's cookie; a copied token stays valid up to 8 hours. Rotating
`INVENTORY_SESSION_SECRET` is the instant global revoke for this role only.

### PII rule for every route in this section

**There is no PII in this section at all.** Not narrowed like §6a's
"`studentName` and `homeroom` only" — *none*. A `Product` has no personal data on
it and nothing else is queryable, so the entire question is answered by the
boundary rather than by a projection. Verified: a full product list contains no
`@`, and no `email`/`phone`/`studentName`/`homeroom`/`pickupCode`/`orderNumber`
key at any depth.

Logs follow: `inventory_login_ok`, `inventory_login_failed`,
`inventory_auth_denied`, `inventory_logout`, `inventory_product_created`,
`inventory_product_updated`, `inventory_stock_adjusted` and
`inventory_session_mode` carry a product cuid, a slug, prices, quantities and a
session id — never a person. Verified by grepping a full server log for every
seeded order's name, email, phone, homeroom and pickup code: **zero hits**.

### Product shape (this section only)

The public §4 `Product` plus `createdAt`/`updatedAt`, which an editor needs to
answer "did my change save".

```json
{
  "id": "cmtlfpsen0001v57dkjtmrxpf",
  "slug": "sour-rainbow-belts",
  "name": "Sour Rainbow Belts",
  "description": "Chewy sour belts in five colours.",
  "priceCents": 175,
  "category": "sweet",
  "rarity": "RARE",
  "allergens": ["SULPHITES"],
  "stockQty": 31,
  "active": true,
  "imageUrl": "/products/sour-rainbow-belts.svg",
  "sortOrder": 40,
  "createdAt": "2026-09-02T23:19:07.881Z",
  "updatedAt": "2026-09-05T06:31:12.004Z"
}
```

### The allergen rule, which is stricter here than anywhere else

CLAUDE.md §2.8 does not relax because the editor is younger; it tightens.

**Every create, every allergen edit and every publish must carry
`"allergensReviewed": true`.** It is a boolean the schema accepts only as literal
`true` — not a checkbox in a UI, a field in the request body, refused at the
validation layer with `400 ALLERGENS_NOT_REVIEWED` when absent.

The reason the affirmation exists rather than "at least one allergen required":
an empty list is legitimate (a bottle of water) and is byte-identical to a form
nobody filled in. Requiring a non-empty list would teach an editor to tick a box
that is not true in order to save the water, and a false `PEANUTS` tag is how
students learn to ignore the tags. So the review is transmitted, not inferred
from the array's length.

Three concrete rules:

| Situation | Required |
|---|---|
| `POST` create | `allergens` **and** `allergensReviewed: true`, always, even for an inactive draft |
| `PATCH` that changes `allergens` | `allergensReviewed: true` in the same request |
| `PATCH` that sets `active: true` | `allergensReviewed: true` in the same request — **and**, if the product's stored allergen list is empty, `allergens` must be sent explicitly too (send `[]`) |

That last clause is the one to build UI for: publishing a product that claims no
allergens requires restating the empty list, so the affirmation is made against a
list somebody actually looked at. The seeded catalog contains 8 rows whose empty
list was never reviewed (`HANDOFF.md` §16); this is what stops one of them being
silently re-published as "reviewed".

**The affirmation is not persisted** — there is no column for it, so it is a
gate at write time and not a durable record. `HANDOFF.md` §63 asks for
`allergensReviewedAt`.

### Photo handling — a URL field, not an upload

`imageUrl` is a `String`. **There is no upload endpoint, and no stubbed one.**
Real object storage needs a real credential nobody has issued (the same
discipline `lib/stripe/payments.ts` applies to the missing Stripe account);
`HANDOFF.md` §64 is the ask. Accepted values:

| Value | Accepted | Why |
|---|---|---|
| `/products/foo.svg` | ✅ | Site-relative, what `prisma/seed.ts` writes and `public/` serves |
| `https://cdn.example.com/foo.jpg` | ✅ | Absolute HTTPS |
| `http://…` | ❌ | Mixed content on an HTTPS page silently fails to render |
| `//host/foo.png` | ❌ | Protocol-relative: reads as a path, behaves as a remote origin |
| `data:` / `javascript:` / `blob:` / `file:` | ❌ | Not a photo location |

Max 512 characters. **Until an upload exists, prefer a site-relative path**: a
remote host is a third-party request from a student's browser.

---

### `POST /api/inventory/login`

**Request** — `{ "passcode": "..." }`. Not trimmed. Unknown keys are a 400.

**Response 200** — sets the `ll_inventory` cookie.

```json
{ "ok": true, "expiresAt": "2026-09-05T14:32:27.000Z" }
```

**Errors**

| `code` | HTTP | Cause | Client action |
|---|---|---|---|
| `INVENTORY_UNAUTHORIZED` | 401 | Wrong passcode | Let them retype it. Do not auto-retry |
| `INVALID_INPUT` | 400 | Missing/oversized/extra field, or a body that is not JSON | Fix the form |
| `RATE_LIMITED` | 429 | Over the login budget | Wait. Do **not** loop |
| `INVENTORY_NOT_CONFIGURED` | 503 | `INVENTORY_PASSCODE` or `INVENTORY_SESSION_SECRET` unset, or the passcode is shorter than 8 characters | Ops problem. Show it as one |

**Rate limits — 5 per IP per 5 minutes, and 30 globally per 5 minutes.** Half the
staff budgets, in a **separate key space**: hammering this passcode must never
lock staff out of the locker screen mid-service. The limiter runs **before the
body is parsed**, so malformed bodies count. Verified: 5 × 401 then 429, with a
second IP unaffected.

### `POST /api/inventory/logout`

No body. Clears the cookie, returns `{ "ok": true }`, and deliberately does
**not** require a valid session.

### `GET /api/inventory/session`

`{ "authenticated": true, "sessionId": "6e5e4ab2723d" }`. A pure read.
`sessionId` identifies a **sign-in, not a person** — do not display it as an
identity. Errors: `INVENTORY_UNAUTHORIZED` 401, `INVENTORY_NOT_CONFIGURED` 503.

---

### `GET /api/inventory/products`

**Every product — active and inactive, every stock level.** This is the
deliberate opposite of the public `GET /api/products`, which filters to
`active = true AND stockQty > 0`: the products this role most needs to open are
exactly the sold-out and deactivated ones.

No pagination, no filters, `Cache-Control: no-store`.

**Response 200**

```json
{
  "products": [ /* Product shape above, sortOrder asc then name asc */ ],
  "counts": {
    "total": 23,
    "active": 21,
    "inactive": 2,
    "outOfStock": 3,
    "withEmptyAllergenList": 8
  }
}
```

`withEmptyAllergenList` is **not a safety claim** — the database cannot tell
"checked, contains none" from "never filled in". It is a worklist: these are the
rows worth re-checking, and 8 of them arrived with the seed.

**Errors** — `INVENTORY_UNAUTHORIZED` 401, `INVENTORY_NOT_CONFIGURED` 503.

*(This is not the endpoint `HANDOFF.md` §59 asked for. That request was for a
staff-session-gated `GET /api/admin/products` to drive `StockAdjuster`; a staff
cookie gets a 401 here. See `HANDOFF.md` §66.)*

### `POST /api/inventory/products`

**Request** — every field required except `slug` and `sortOrder`. Nothing is
defaulted; a create route that fills in blanks is a create route that invents
catalog data, and one of the blanks is allergens.

```json
{
  "name": "Cheese Puff Cup",
  "slug": "cheese-puff-cup",
  "description": "A single-serve cup of cheese puffs.",
  "priceCents": 175,
  "category": "savory",
  "rarity": "COMMON",
  "allergens": ["DAIRY"],
  "allergensReviewed": true,
  "stockQty": 24,
  "imageUrl": "/products/cheese-puff-cup.svg",
  "active": false,
  "sortOrder": 50
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | 2–80, trimmed |
| `slug` | string | Optional; derived from `name` when absent. Lower-case, hyphens. **Write-once** — `PATCH` refuses it, because seeds upsert on it |
| `description` | string | 1–400. No default |
| `priceCents` | int | **1 – 5000.** Integer cents (CLAUDE.md §2.1). `0` is refused: a free product is a comp backdoor and there is no comp path (`HANDOFF.md` §56). `5000` ($50) catches "17500 typed for 175". Both bounds are flagged for confirmation in `HANDOFF.md` §62 |
| `category` | enum | `sweet` \| `savory` \| `drinks` \| `healthy` |
| `rarity` | enum | `COMMON`…`LEGENDARY`. Required, not defaulted |
| `allergens` | `Allergen[]` | Required. De-duplicated. An unrecognised token is a 400, never a silent drop |
| `allergensReviewed` | `true` | Required. See the allergen rule above |
| `stockQty` | int | 0–10000. **Absolute, and only here** — see the stock route |
| `imageUrl` | string | See photo handling above |
| `active` | boolean | Required, not defaulted. `true` publishes immediately |
| `sortOrder` | int | Optional, 0–9999, default 0 |

**Unknown keys are a 400.** The schema is `.strict()`, so `{"status":"PAID"}`,
`{"orderId":…}` or a client-supplied `id` is rejected rather than silently
dropped — a client must never believe a write happened that did not.

**Response 201** — `{ "product": { …Product shape… } }`

**Errors**

| `code` | HTTP | Cause |
|---|---|---|
| `ALLERGENS_NOT_REVIEWED` | 400 | `allergens` missing, unrecognised, or `allergensReviewed` not `true`. Carries `fields` |
| `INVALID_INPUT` | 400 | Any other field problem, an unknown key, a non-JSON body, or a name that yields no usable slug. Carries `fields` |
| `INVENTORY_UNAUTHORIZED` | 401 | No inventory session |
| `PRODUCT_SLUG_TAKEN` | 409 | That slug exists. Carries `slug`. Raised rather than auto-suffixing — two near-identical rows is a mistake worth stopping |
| `INVENTORY_NOT_CONFIGURED` | 503 | Not configured |

### `GET /api/inventory/products/[productId]`

`{ "product": { …Product shape… } }`. `PRODUCT_UNAVAILABLE` 409 for an unknown
**or malformed** id — the cases answer identically.

### `PATCH /api/inventory/products/[productId]`

**Request** — any subset of `name`, `description`, `priceCents`, `category`,
`rarity`, `allergens`, `allergensReviewed`, `imageUrl`, `active`, `sortOrder`.
At least one. Same validation as create.

**What `PATCH` deliberately refuses, each with a 400:**

| Key | Why |
|---|---|
| `stockQty` | An absolute set is a read-then-write (CLAUDE.md §2.4). Use the stock route. Rejected loudly so a client cannot believe it adjusted stock |
| `slug` | Write-once; a renamed slug turns the next seed run into a duplicate insert |
| anything else | `.strict()` — there is no order, student, payment or setting field to name here |

**Response 200** — `{ "product": { …Product shape… } }`

**Errors** — `ALLERGENS_NOT_REVIEWED` 400, `INVALID_INPUT` 400,
`INVENTORY_UNAUTHORIZED` 401, `PRODUCT_UNAVAILABLE` 409,
`INVENTORY_NOT_CONFIGURED` 503, `INTERNAL` 500.

**Concurrency: last write wins.** There is no optimistic-concurrency token. Two
editors saving the same product in the same minute means the later request's
fields overwrite the earlier one's; fields nobody sent are untouched. This is
deliberate — an `updatedAt` precondition would also fire on every concurrent
checkout and stock adjustment (both touch `updated_at`), so it would reject
legitimate edits during a lunch service. `HANDOFF.md` §65 has the detail and the
attack.

### `POST /api/inventory/products/[productId]/stock`

**Request** — `{ "delta": 24 }`

| Field | Type | Notes |
|---|---|---|
| `delta` | int | **Signed and relative.** Non-zero, \|delta\| ≤ **1000** (tighter than the staff route's 10000) |

**Relative here, absolute only at creation, and the difference is the argument:**
at creation the row does not exist, so nothing can have reserved stock on it and
an absolute quantity is exactly right. Afterwards the shelf is live — "set stock
to 7" is a read-then-write with a human in the middle, and a checkout that
reserves a unit between the count and the submit gets silently un-reserved
(CLAUDE.md §2.4). **Compute the delta on screen** (they counted 7, the screen
showed 9, send `-2`); the database does not care who is holding the clipboard.

Applied by `adjust_stock()` — check and write in one `UPDATE`. **P4b adds no SQL
and needs no migration; `manual_constraints.sql` does not need re-running.**
Verified: 20 simultaneous `+1` returned 20 **distinct** quantities and landed
exactly `+20`. Works on inactive products, which is exactly when a miscount is
found.

**Response 200**

```json
{
  "productId": "cmtlfpsen0001v57dkjtmrxpf",
  "name": "Cheese Puff Cup",
  "slug": "cheese-puff-cup",
  "stockQty": 31,
  "delta": -3,
  "previousStockQty": 34,
  "active": true,
  "allergens": ["DAIRY"]
}
```

`stockQty` is authoritative — read out of the same `UPDATE`, so it already
includes any concurrent checkout. It will sometimes not equal what the editor
expected; **show this number, not their arithmetic.**

**Errors**

| `code` | HTTP | Cause |
|---|---|---|
| `INVALID_INPUT` | 400 | `delta` missing, zero, fractional, out of range, or an unknown key (including an attempted `stockQty`) |
| `INVENTORY_UNAUTHORIZED` | 401 | No inventory session |
| `PRODUCT_UNAVAILABLE` | 409 | No such product, or a malformed id |
| `STOCK_ADJUSTMENT_REJECTED` | 409 | Would leave a negative quantity. Carries `productId`, current `stockQty`, `delta` |
| `INTERNAL` | 500 | Usually: `manual_constraints.sql` was never applied, so `adjust_stock` does not exist |

**The inherited hazard, and it must be in the UI.** `lib/db/release.ts` restocks
without a ceiling when a card order expires or a payment fails (`HANDOFF.md` §7).
Adjusting for an order that then releases adds the quantity twice. **Adjust for
what is physically on the shelf** — which is the only thing this role can see
anyway, since orders are not reachable from here.

---

Planned, in build order (shipped rows marked):

| Phase | Endpoint | Purpose | Status |
|---|---|---|---|
| P2 | `GET /api/products` | Catalog with category, rarity and allergen-exclusion filtering | **Shipped** — §6 above |
| P2 | `GET /api/slots` | Pickup windows with live remaining capacity | **Shipped** — §6 above |
| P3 | `POST /api/checkout` | Validate, reprice, hold stock and a seat, create the order, open a PaymentIntent | **Shipped** — §6 above |
| P3 | `POST /api/webhooks/stripe` | The only writer of `PAID`. Replay-protected | **Shipped** — §6 above |
| P3 | `GET /api/orders/[orderNumber]` | Confirmation page polling | **Shipped** — §6 above. Authorised by the per-order checkout cookie (`docs/HANDOFF.md` §22, resolved) |
| P3 | `GET /api/cron/sweep` | Expire unpaid card orders and release what they held | **Shipped** — §6 above |
| P4 | `POST /api/admin/login` · `POST /api/admin/logout` · `GET /api/admin/session` | Staff sign-in on a shared passcode (placeholder) | **Shipped** — §6a |
| P4 | `GET /api/admin/orders` | The pick list: one service day grouped by pickup window | **Shipped** — §6a |
| P4 | `POST /api/admin/orders/[orderNumber]/pack` | Mark packed | **Shipped** — §6a |
| P4 | `POST /api/admin/orders/[orderNumber]/pickup` | Mark picked up, pickup code verified | **Shipped** — §6a |
| P4 | `POST /api/admin/orders/[orderNumber]/cash` | Record cash collected on a `CASH_AT_PICKUP` order | **Shipped** — §6a |
| P4 | `POST /api/admin/orders/[orderNumber]/refund` | Manual refund, amount always recomputed from the order | **Shipped** — §6a |
| P4 | `POST /api/admin/products/[productId]/stock` | Atomic relative stock adjustment | **Shipped** — §6a |
| P4b | `POST /api/inventory/login` · `POST /api/inventory/logout` · `GET /api/inventory/session` | Inventory-editor sign-in on its own passcode and its own secret | **Shipped** — §6b |
| P4b | `GET /api/inventory/products` | Every product, active and inactive, every stock level | **Shipped** — §6b |
| P4b | `POST /api/inventory/products` | Create a product. Allergens mandatory and affirmed | **Shipped** — §6b |
| P4b | `GET` · `PATCH /api/inventory/products/[productId]` | Read and edit name, description, price, category, rarity, allergens, photo URL, active, sort order | **Shipped** — §6b |
| P4b | `POST /api/inventory/products/[productId]/stock` | Atomic relative stock adjustment | **Shipped** — §6b |
| P4b | photo upload | Real object storage | **Not built, deliberately** — needs a storage credential (`HANDOFF.md` §64). `imageUrl` takes a URL today. No stub exists |

---

## 7. Changelog

| Date | Phase | Change |
|---|---|---|
| 2026-09-02 | P1 | Schema, constraints, atomic functions, seed and shared libs landed. Conventions, error codes and shared types published. No endpoints yet |
| 2026-09-02 | P1 | Manager review: real branded catalog items added to `prisma/seed.ts` (Doritos ×5, Kool-Aid Jammers ×3, chip assortment ×3), `components/ui/rarity.ts` P0 placeholder deleted and `RarityCard` swapped onto the canonical `@prisma/client`/`lib/rarity.ts` types (HANDOFF §5, resolved). Independently re-verified: fresh migrate + constraints + double seed, `tsc --noEmit`, full `eslint .` |
| 2026-09-03 | P3 | `POST /api/checkout`, `POST /api/webhooks/stripe` and `GET /api/cron/sweep` shipped and documented in §6, plus `lib/codes.ts`, `lib/rate-limit.ts`, `lib/timezone.ts`, `lib/stripe/{client,payments}.ts`, `lib/db/release.ts`, `lib/email.ts`, `checkoutSchema` in `lib/validation.ts`, and `vercel.json`. **Card and cash are both live** (manager decision, resolving BUILDPLAN.md's open item). The timezone bug from HANDOFF §3/§13 is fixed at both call sites: `lib/timezone.ts` pins `America/Vancouver`, the cutoff derives the slot's real instant from it, and `GET /api/slots` now floors "today" on the school's calendar day — at 00:25 UTC the old code returned 18 slots and dropped the school's current afternoon; it returns 21. Deviations from backend.md, all hardenings, are listed in `HANDOFF.md` §18. Verified against the seeded dev database: cash order lands `RESERVED` with stock and `booked_count` decremented, partial-failure rollback leaves nothing behind, 20-way slot and stock races produce exactly one winner, signed webhook flips the order to `PAID`, replay and concurrent triple replay are no-ops, a tampered `amount_received` is refused, a decline releases stock and seat, and the sweep expires and restocks an aged order and is a no-op on the second run |
| 2026-09-03 | P3 | `GET /api/orders/[orderNumber]` shipped and documented in §6, unblocking the confirmation page (`HANDOFF.md` §22, resolved by the manager in favour of option 3). Added `lib/order-session.ts`, the `ORDER_NOT_FOUND` code in `lib/errors.ts`, and the `ORDER_SESSION_SECRET` environment variable; `POST /api/checkout` now sets a signed, httpOnly, per-order cookie (`ll_ord_<orderNumber>`, `Path=/api/orders`, 48 h) on both the cash and card responses and refuses up front if the signing secret is missing in production. The response carries status, the three amounts, the line snapshots including full allergens, the pickup window's label/time/location/date, and the pickup code **only** for `RESERVED` or `PAID`; it carries no student name, email, phone or homeroom. Verified end to end against the dev database: cash order readable with its code, card order readable while `PENDING` **without** a code and with one after a signed `payment_intent.succeeded`, an expired order readable as `EXPIRED` with no code, and no cookie / tampered signature / wrong signing key / expired token / a different order's cookie renamed onto this order all returning the identical `ORDER_NOT_FOUND` |
| 2026-09-03 | P3 | Three confirmed concurrency bugs fixed (`HANDOFF.md` §31, §32, §33), no endpoint signature changed. (1) The daily spend cap moved inside the checkout transaction behind a per-(email, school day) `pg_advisory_xact_lock`; six concurrent 300c checkouts for one address against the 1500c cap now commit 1500c, not 1800c, and the sequential 5-accepted/1-refused case and the exact-boundary case are unchanged. Consequence for clients: `PAST_CUTOFF` is now evaluated before `SPEND_CAP_EXCEEDED` when both apply. (2) `webhook_events` gained a nullable `processed_at` (migration `20260903055030_webhook_event_processed_at`) and the route became a two-phase claim: a claim left unfinished for more than 3 minutes is reclaimed and reprocessed, so a killed handler no longer answers `already processed` forever for a payment it never recorded, while a claim younger than that is still trusted and concurrent duplicate delivery stays idempotent. (3) `charge.refunded` now transitions any non-`REFUNDED` order to `REFUNDED` and clears `expiresAt`, so an out-of-order refund no longer strands the order at `PAID`; `paidAt` is deliberately not fabricated in that case. Verified against a dedicated Postgres database over real HTTP, and the full qa suite re-run: 75 passed, plus the two `it.fails` markers for §31 and §33 now reporting "expected to fail but passed" |
| 2026-09-04 | P4 | **Staff admin backend shipped**, all eight routes documented in the new §6a: `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session`, `GET /api/admin/orders`, and `POST` `…/orders/[orderNumber]/{pack,pickup,cash,refund}` and `…/products/[productId]/stock`. Added `lib/admin-session.ts` (HMAC-SHA256 session cookie on its own `ADMIN_SESSION_SECRET`, separate from the student receipt cookie — verified non-interchangeable in both directions), `lib/db/admin.ts`, the admin schemas in `lib/validation.ts`, seven error codes in `lib/errors.ts`, `refundOrderPayment()` in `lib/stripe/payments.ts`, and `adjust_stock(text,int)` in `manual_constraints.sql` (**re-run that file everywhere**; no Prisma migration). New env vars `ADMIN_PASSCODE` (shared staff passcode, **placeholder pending a human decision**, min 8 chars, no default in any environment) alongside the existing `ADMIN_SESSION_SECRET`; both fail closed. Verified against the seeded dev database over real HTTP: full lunch-service walkthrough (pack → cash → pickup) on both cash and card, every error path, `PENDING` orders refused for packing, the cash guard refusing a handover, card refund through the (simulated) Stripe seam with the seat released 6→5 and stock deliberately unchanged, 15-way concurrent races on all four order actions each resolving to exactly one change, 40 concurrent stock adjustments landing exactly ±40 with 40 distinct returned quantities, 20 concurrent checkouts interleaved with 20 concurrent adjustments composing exactly and deadlock-free, login rate limiting (10 × 401 then 429, malformed bodies counted too), all four fail-closed configuration modes, and a full-log PII grep returning zero hits for any test student's name, email, phone or pickup code. `tsc --noEmit`, full `eslint .`, `next build` (all eight routes `ƒ` dynamic) clean; the pre-existing suite re-run green at 106 + 25 |
| 2026-09-05 | P4b | **Restricted inventory editor shipped**, six routes documented in the new §6b: `POST /api/inventory/login`, `POST /api/inventory/logout`, `GET /api/inventory/session`, `GET`+`POST /api/inventory/products`, `GET`+`PATCH /api/inventory/products/[productId]`, `POST /api/inventory/products/[productId]/stock`. Added `lib/inventory-session.ts` (its own module, its own `INVENTORY_SESSION_SECRET`, its own `ll_inventory` cookie — **not** a role flag on `lib/admin-session.ts`, which was not touched), `lib/db/inventory.ts`, four inventory schemas in `lib/validation.ts`, four error codes in `lib/errors.ts` (`INVENTORY_UNAUTHORIZED`, `INVENTORY_NOT_CONFIGURED`, `PRODUCT_SLUG_TAKEN`, `ALLERGENS_NOT_REVIEWED`), and `scripts/verify-inventory-isolation.mjs`. New env vars `INVENTORY_SESSION_SECRET` and `INVENTORY_PASSCODE` (**must differ from `ADMIN_PASSCODE`**; min 8 chars, no default, no dev fallback, both fail closed). **No schema migration and no `manual_constraints.sql` change** — the stock route reuses P4's `adjust_stock()`. Allergens are mandatory and explicitly affirmed on every create, every allergen edit and every publish; publishing an empty allergen list additionally requires the empty list to be restated. Photo is a validated URL field; **no upload endpoint was built or stubbed** (`HANDOFF.md` §64). Verified over real HTTP against the seeded dev database — 113 runtime assertions, 0 failures: the isolation script (with a negative control), a staff cookie and a staff token renamed onto `ll_inventory` refused on all six routes, an inventory cookie and an inventory token renamed onto `ll_admin` refused on all seven admin routes plus the receipt and cron routes, full CRUD, every allergen refusal, price/URL/strict-key refusals, stock deltas including 20-way concurrency landing exactly +20 with 20 distinct quantities, all four configuration modes fail-closed (503, staff sign-in unaffected), the production build's `Secure` cookie, login rate limiting in its own key space, a zero-hit PII grep of the full server log, and a zero-hit secret scan of 304 built bundle files. `tsc --noEmit`, `eslint .`, `next build` clean (all six routes `ƒ`); pre-existing suites re-run green at 25 unit + 40 api + 66 concurrency |
| 2026-09-02 | P2 | `GET /api/products` and `GET /api/slots` shipped and documented in §6. `lib/validation.ts` added with `productQuerySchema` (`checkoutSchema` follows in P3, deliberately not stubbed). Two hardenings over the spec sketch, both noted in `HANDOFF.md` §P2: `excludeAllergens` tokens are validated against the `Allergen` enum instead of passed through as free strings, and a bad query param returns `INVALID_INPUT` instead of an unhandled `ZodError`. Verified against the seeded dev database with curl in both `next dev` and `next build && next start` — allergen exclusion confirmed to drop a product on ANY match (`PEANUTS` removes Trail Mix Bag, whose list is `PEANUTS`/`TREE_NUTS`/`SOY`), `remaining`/`full` confirmed against `book_slot()`-modified counts, `Cache-Control: no-store` confirmed on both, both routes confirmed `ƒ` (dynamic) in the production build |

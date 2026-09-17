import { z } from "zod";
import { Allergen, OrderStatus, Rarity } from "@prisma/client";

// Request-boundary validation. Every route parses its input through a schema in
// this file before it touches the database — nothing downstream re-checks.
//
// P2 published productQuerySchema. P3 added checkoutSchema. P4 adds the staff
// admin schemas at the bottom.

/// `Product.category` is a plain String column, not a Postgres enum
/// (docs/HANDOFF.md §8). These four values are the whole accepted set and this
/// schema is the only thing enforcing that, so anything not listed here reaches
/// Prisma as an unmatchable string and silently returns an empty catalog. Reject
/// it at the boundary instead.
export const PRODUCT_CATEGORIES = [
  "sweet",
  "savory",
  "drinks",
  "healthy",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const productQuerySchema = z.object({
  category: z.enum(PRODUCT_CATEGORIES).optional(),

  rarity: z.enum(Rarity).optional(),

  /// Comma-separated allergen tokens to exclude. Validated against the Allergen
  /// enum rather than passed through as free strings (backend.md §9 casts these
  /// `as any`).
  ///
  /// This is the safety-critical difference: `NOT hasSome ["MILK"]` excludes
  /// nothing, because the enum value is `DAIRY`. A typo, a stale client, or an
  /// allergen name from some other list would then quietly serve dairy to a
  /// student who asked for it to be filtered out — the request appears to have
  /// worked. CLAUDE.md §2.8 says allergen data is never inferred and never
  /// defaulted; an unrecognised token is therefore a 400, never a no-op.
  ///
  /// Tokens are trimmed and de-duplicated. Matching is exact and case-sensitive:
  /// callers build these from the `Allergen` enum, and accepting near-misses is
  /// how a wrong value gets normalised into a right-looking one.
  excludeAllergens: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(z.array(z.enum(Allergen)))
    .transform((list) => [...new Set(list)]),
});

export type ProductQuery = z.infer<typeof productQuerySchema>;

export const accountSignupSchema = z.object({
  username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().trim().toLowerCase().pipe(z.email().max(160)),
  password: z.string().min(8).max(200),
});

export const accountLoginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(160)),
  password: z.string().min(1).max(200),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/checkout
// ─────────────────────────────────────────────────────────────────────────────

/// Everything a student submits. This is the only trust boundary the checkout
/// route has: past this point every value is either from here or from the
/// database, and nothing downstream re-validates.
///
/// Note what is *not* here: no prices, no totals that matter, no order status,
/// no pickup code. The server derives all of those. `clientTotalCents` is the
/// single exception and it is evidence, not input (see below).
export const checkoutSchema = z.object({
  studentName: z.string().trim().min(2).max(80),

  /// Lower-cased at the boundary so the daily spend cap cannot be sidestepped
  /// by capitalising a letter — the cap aggregates on exact string equality.
  ///
  /// `.trim().toLowerCase().pipe(z.email())` and not backend.md's
  /// `z.string().trim().toLowerCase().email()`: in zod 4 the format check on
  /// `z.email()` runs before any transform in the same chain, so the sketch's
  /// order rejects `"  Student@example.com "` — a value a browser autofill
  /// produces routinely. Piping runs the normalisation first, then validates.
  email: z.string().trim().toLowerCase().pipe(z.email().max(160)),

  /// Deliberately loose. A stricter Canadian-format regex rejects legitimate
  /// numbers (extensions, an international parent) and the phone is only ever
  /// used by a human calling about a bagged order.
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{10,20}$/, "Enter a valid phone number"),

  homeroom: z.string().trim().max(20).optional(),

  slotId: z.cuid(),

  paymentMethod: z.enum(["CARD", "CASH_AT_PICKUP"]),

  items: z
    .array(
      z.object({
        productId: z.cuid(),
        /// Per-line cap. The daily spend cap is the real limit; this stops a
        /// single fat-fingered line from reserving a product's whole shelf.
        qty: z.number().int().min(1).max(10),
      }),
    )
    .min(1)
    .max(20)
    // Reject duplicate lines rather than silently merging them — a duplicate
    // means the client cart is corrupt and we want to know. The database says
    // the same thing with @@unique([orderId, productId]) on OrderItem.
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      { message: "Duplicate items in cart" },
    ),

  /// Accepted, logged when it disagrees, then discarded. Never used in any
  /// calculation and never charged (CLAUDE.md §2.2). It exists so a
  /// client/server price disagreement shows up in the logs instead of only in
  /// a confused student.
  clientTotalCents: z.number().int().optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// P4 — staff admin (app/api/admin/**)
// ─────────────────────────────────────────────────────────────────────────────
//
// Note what is absent from every schema below, deliberately: no amounts, no
// statuses to write, no prices. Staff say *which* order and *what happened*;
// the server decides what that means and what it costs. A refund body carrying
// an amount would be a client-supplied money value, which CLAUDE.md §2.2 does
// not allow from any client, including an authenticated one.

/// `POST /api/admin/login`. A single shared passcode — see lib/admin-session.ts
/// and the placeholder flagged in docs/HANDOFF.md.
export const adminLoginSchema = z.object({
  /// Not trimmed. A passcode may legitimately contain leading or trailing
  /// spaces, and silently editing a credential before comparing it means the
  /// value that works is not the value that was configured.
  passcode: z.string().min(1).max(200),
});

/// `GET /api/admin/orders`. The pick list.
export const adminOrdersQuerySchema = z.object({
  /// The school's calendar day, `YYYY-MM-DD`. Defaults to today in the school's
  /// timezone (lib/timezone.ts). Matched against `PickupSlot.serviceDate`, which
  /// is a date key stored at midnight UTC — not an instant.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),

  /// Narrow to one pickup window, for the screen staff have open at the locker.
  slotId: z.cuid().optional(),

  /// Comma-separated `OrderStatus` values. Omitted means the default working
  /// set (see the route). Validated against the enum for the same reason
  /// `excludeAllergens` is: an unmatched status string filters nothing in a
  /// Prisma `in`, so a request that looked filtered would silently list orders
  /// staff asked not to see.
  status: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(z.array(z.enum(OrderStatus)))
    .transform((list) => [...new Set(list)]),
});

export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;

/// The pickup code as read aloud at the locker. Upper-cased and trimmed because
/// a phone keyboard will capitalise inconsistently and staff retype it in a
/// hurry; the alphabet in lib/codes.ts is upper-case only, so this normalisation
/// cannot turn one valid code into a different valid code.
const pickupCodeInput = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/, "Pickup codes are four characters");

/// `POST /api/admin/orders/[orderNumber]/pickup`. The handover.
export const adminPickupSchema = z.object({
  /// Required, always. This is the one moment where the person in front of
  /// staff is matched to the bag, and a handover route that accepts "trust me,
  /// it's them" is a route that hands a peanut-allergic student someone else's
  /// order.
  pickupCode: pickupCodeInput,
});

/// `POST /api/admin/orders/[orderNumber]/cash`. Money changing hands.
export const adminCashSchema = z.object({
  /// Optional here, unlike the handover: staff may take the money while the bag
  /// is still on the bench, before the student is standing there. When it *is*
  /// supplied it is checked, so a scanner-driven UI gets the same protection.
  pickupCode: pickupCodeInput.optional(),
});

/// `POST /api/admin/orders/[orderNumber]/refund`.
export const adminRefundSchema = z.object({
  // There is deliberately no `reason` / free-text note field here or on the
  // stock route. There is nowhere safe to put one yet: no audit table exists
  // (docs/HANDOFF.md), and a staff note is exactly where a child's name ends up
  // — "returned by Jamie in 9B" — which then has to be logged or stored, and
  // CLAUDE.md §2.6 says no. Accepting the field and silently discarding it
  // would be worse: staff would believe the note was kept. When an audit log
  // lands with a retention decision behind it, the field lands with it.

  /// Give the pickup window's seat back as well as the money.
  ///
  /// Default `false`, deliberately. `booked_count` is physical handout
  /// throughput, and a refund late in a service does not create the staff-time
  /// to hand out one more bag — over-booking a window that is already packed is
  /// a worse failure than under-reporting a free seat. Staff who know the
  /// window still has room tick this; docs/HANDOFF.md §21 asked P4 for the
  /// control and this is it.
  releaseSlotSeat: z.boolean().optional().default(false),
});

/// `POST /api/admin/products/[productId]/stock`.
export const adminStockAdjustSchema = z.object({
  /// A RELATIVE change, never an absolute quantity. This is not a UI
  /// preference: "set stock to 7" is a read-then-write with a human in the
  /// middle, and a checkout that reserved a unit between the shelf count and
  /// the submit gets silently un-reserved (CLAUDE.md §2.4). A delta composes
  /// with concurrent reservations; an absolute value clobbers them.
  delta: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: "Adjustment cannot be zero" })
    .refine((n) => Math.abs(n) <= 10_000, {
      message: "Adjustment is too large",
    }),
  // No `reason` field. See the note in adminRefundSchema.
});

// ─────────────────────────────────────────────────────────────────────────────
// P4b — restricted inventory editor (app/api/inventory/**)
// ─────────────────────────────────────────────────────────────────────────────
//
// These schemas ARE the authorisation boundary's second half. The first half is
// lib/inventory-session.ts, which decides *who* is calling; this decides *what
// they may write*, and the answer is "named columns of Product, nothing else".
//
// Three rules hold across every schema below, and each one is load-bearing:
//
//   1. `.strict()` everywhere. An unknown key is a 400, never a silently
//      dropped one. `{"stockQty": 999}` on the edit route, `{"status": "PAID"}`
//      anywhere, a typo — all rejected loudly. Zod's default is to strip
//      unknown keys, which would let a client believe a write happened.
//   2. No field here names anything outside Product. There is no order id, no
//      email, no setting key, no Stripe anything to put in a body.
//   3. Allergens are affirmed explicitly, never inferred (CLAUDE.md §2.8).
//      See `allergensReviewed` below.
//
// The route handlers additionally copy parsed fields into Prisma one by one
// rather than spreading the parsed object, so even a schema mistake cannot turn
// into an unintended column write.

/// `POST /api/inventory/login`. A single shared passcode, distinct from the
/// staff one — see lib/inventory-session.ts.
export const inventoryLoginSchema = z
  .object({
    /// Not trimmed, same reasoning as adminLoginSchema.
    passcode: z.string().min(1).max(200),
  })
  .strict();

/// Product name. Same 2..80 bounds as a student name — a catalog row printed on
/// a pick list has the same width budget as anything else on it.
const productName = z.string().trim().min(2).max(80);

/// Shown to students on the catalog card. Required and non-empty on create:
/// there is no honest default for "what is this snack", and an empty
/// description on a shelf item is how a product ships unexplained.
const productDescription = z.string().trim().min(1).max(400);

/// Integer cents, and bounded on BOTH sides deliberately.
///
/// This is the one field in this role's scope that is money. `POST
/// /api/checkout` reprices every cart from `Product.priceCents` (CLAUDE.md
/// §2.2), so whatever is written here is what a card is charged. The bounds are
/// guard rails around a fat finger, not a pricing policy:
///
///   · min 1 cent — a zero-price product is a free-snack backdoor, and there is
///     deliberately no comp/free-order path in this system (docs/HANDOFF.md
///     §56). If free items are genuinely wanted that is a human decision.
///   · max 5000 cents ($50) — two orders of magnitude above a $1.75 snack.
///     `1795` typed for `175` is caught by a human noticing; `17500` is caught
///     here.
///
/// Both numbers are flagged in docs/HANDOFF.md for confirmation.
const productPriceCents = z
  .number()
  .int("Price must be a whole number of cents")
  .min(1, "Price must be at least 1 cent")
  .max(5_000, "Price looks too high — enter cents, not dollars");

/// Absolute stock, accepted ONLY at creation time. See
/// `inventoryStockAdjustSchema` for why every later change is a delta.
const productStockQty = z
  .number()
  .int("Stock must be a whole number")
  .min(0)
  .max(10_000);

/// Display ordering on the catalog page. Cosmetic; lower sorts first.
const productSortOrder = z.number().int().min(0).max(9_999);

/// Photo location.
///
/// Two accepted shapes and nothing else:
///
///   /products/foo.svg      site-relative, which is what prisma/seed.ts writes
///                          and what `public/` serves today
///   https://host/foo.jpg   an absolute HTTPS URL
///
/// Rejected on purpose: `http://` (a mixed-content image on an HTTPS school
/// page silently fails to load), `data:` (megabytes of base64 in a String
/// column), `javascript:`/`blob:`/`file:`, and protocol-relative `//host/x`
/// — which reads as a path and behaves as a remote origin, so it is exactly the
/// value that slips a third-party URL past a naive "starts with /" check.
///
/// This field is a URL, not an upload. There is no upload endpoint and none is
/// stubbed: real object storage needs a real credential nobody has issued yet
/// (docs/HANDOFF.md, P4b). A remote host here is also a third-party request
/// from a student's browser, so a `NEXT_PUBLIC_SITE_URL`-relative path stays the
/// recommendation until an allow-list is agreed.
const productImageUrl = z
  .string()
  .trim()
  .min(1, "A photo URL is required")
  .max(512)
  .refine(
    (v) => {
      if (v.startsWith("//") || v.includes("\\")) return false;
      if (v.startsWith("/")) return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(v);
      try {
        return new URL(v).protocol === "https:";
      } catch {
        return false;
      }
    },
    {
      message:
        "Use a site path like /products/name.svg or a full https:// address",
    },
  );

/// The allergen list itself. Validated against the `Allergen` enum and
/// de-duplicated; an unrecognised token is a 400, never a quietly dropped one,
/// for the same reason `excludeAllergens` rejects them: a mis-spelled allergen
/// that validates is a product that appears tagged and filters as untagged.
const productAllergens = z
  .array(z.enum(Allergen))
  .max(11)
  .transform((list) => [...new Set(list)]);

/// The affirmation. `true` and only `true`.
///
/// An empty `allergens` array is legitimate — a bottle of water contains none of
/// Canada's priority allergens — and it is indistinguishable, as data, from a
/// form nobody filled in. That ambiguity is the whole risk CLAUDE.md §2.8 is
/// about, and it already exists in the seeded catalog (docs/HANDOFF.md §16: 8
/// products assert "no allergens" without review).
///
/// So the review is carried explicitly instead of being read out of the array's
/// length. `allergens: []` with `allergensReviewed: true` means "checked, none
/// present" and is accepted. `allergens: []` without it, or with `false`, is
/// refused with ALLERGENS_NOT_REVIEWED.
///
/// The alternative — demanding at least one allergen — is worse than useless: it
/// teaches an editor to tick a box that is not true in order to save a bottle of
/// water, and a false PEANUTS tag is how students learn to ignore the tags.
///
/// NOT PERSISTED. There is no column for it, so this is an affirmation at the
/// moment of writing and not a durable record that a review happened. A
/// `allergensReviewedAt` column would make it durable and is flagged in
/// docs/HANDOFF.md as a schema decision, not one to make silently here.
const allergensReviewed = z.literal(true, {
  message: "Confirm the allergen list has been checked",
});

/// `POST /api/inventory/products` — create.
///
/// Everything is required except `slug` and `sortOrder`. Nothing is defaulted:
/// a create route that fills in blanks is a create route that invents catalog
/// data, and one of these blanks is allergens.
export const inventoryProductCreateSchema = z
  .object({
    name: productName,

    /// Optional. Derived from `name` when absent (lib/db/inventory.ts). The
    /// stable key seeds and fixtures upsert on, so it is settable exactly once,
    /// at creation, and never editable afterwards — a renamed slug turns the
    /// next seed run into a duplicate insert rather than an update.
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(64)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lower-case letters, numbers and single hyphens",
      )
      .optional(),

    description: productDescription,
    priceCents: productPriceCents,
    category: z.enum(PRODUCT_CATEGORIES),

    /// In the scope list as "type" only by a generous reading, and required by
    /// the schema with no default. Included because it is cosmetic display data
    /// that cannot touch money or PII, and because defaulting every new product
    /// to COMMON would be the same kind of silent inference the allergen rule
    /// exists to forbid. Flagged in docs/HANDOFF.md.
    rarity: z.enum(Rarity),

    allergens: productAllergens,
    allergensReviewed,

    /// Absolute, and correct here specifically because the row does not exist
    /// yet: nothing can have reserved stock on a product that has never been
    /// saved, so there is no concurrent write to clobber. Every subsequent
    /// change is a delta.
    stockQty: productStockQty,

    imageUrl: productImageUrl,

    /// Explicit. A product that appears in the shop the instant it is saved,
    /// because the field defaulted to `true`, is a publication nobody decided
    /// to make.
    active: z.boolean(),

    sortOrder: productSortOrder.optional(),
  })
  .strict();

export type InventoryProductCreate = z.infer<typeof inventoryProductCreateSchema>;

/// `PATCH /api/inventory/products/[productId]` — edit.
///
/// Every field optional, at least one required. Note what is NOT here:
///
///   · `stockQty` — an absolute set is a read-then-write (CLAUDE.md §2.4). Use
///     the stock route. `.strict()` turns an attempt into a 400 rather than a
///     silent no-op, so a client cannot believe it adjusted stock here.
///   · `slug` — the stable seed key, write-once at creation.
///   · anything at all outside Product.
export const inventoryProductUpdateSchema = z
  .object({
    name: productName.optional(),
    description: productDescription.optional(),
    priceCents: productPriceCents.optional(),
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    rarity: z.enum(Rarity).optional(),
    allergens: productAllergens.optional(),
    allergensReviewed: allergensReviewed.optional(),
    imageUrl: productImageUrl.optional(),
    active: z.boolean().optional(),
    sortOrder: productSortOrder.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Nothing to change",
  })
  // ── The publish gate, at the request boundary ──────────────────────────────
  // Changing the allergen list, or putting a product in front of students,
  // requires the affirmation in the same request.
  //
  // One further gate needs the stored row and therefore lives in the route:
  // publishing a product whose allergen list is EMPTY additionally requires the
  // empty list to be transmitted explicitly, so the affirmation is made against
  // a list somebody actually looked at rather than against a blank column.
  .refine((v) => !(v.allergens !== undefined && v.allergensReviewed !== true), {
    path: ["allergensReviewed"],
    message: "Confirm the allergen list has been checked",
  })
  .refine((v) => !(v.active === true && v.allergensReviewed !== true), {
    path: ["allergensReviewed"],
    message: "Confirm the allergen list before putting this on sale",
  });

export type InventoryProductUpdate = z.infer<typeof inventoryProductUpdateSchema>;

/// `POST /api/inventory/products/[productId]/stock`.
///
/// A RELATIVE change, exactly like the staff route, and for exactly the same
/// reason: "set stock to 7" is a read-then-write with a human in the middle, and
/// a checkout that reserved a unit between the count and the submit gets
/// silently un-reserved (CLAUDE.md §2.4). The person counting the box is
/// thirteen, which is an argument for computing the delta for them in the UI —
/// not for relaxing the invariant, which does not care who is holding the
/// clipboard.
///
/// Bounded tighter than the staff route's ±10000: this role restocks a shelf
/// from a delivery, and a four-digit correction on a school snack catalog is a
/// typo far more often than it is a pallet.
export const inventoryStockAdjustSchema = z
  .object({
    delta: z
      .number()
      .int()
      .refine((n) => n !== 0, { message: "Adjustment cannot be zero" })
      .refine((n) => Math.abs(n) <= 1_000, {
        message: "Adjustment is too large",
      }),
  })
  .strict();

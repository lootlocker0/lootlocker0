export const ERROR_CODES = {
  INVALID_INPUT: { status: 400, message: "Check the highlighted fields." },
  // Returned by GET /api/orders/[orderNumber] for a genuinely unknown order
  // number AND for every failed authorisation of a real one: no cookie, an
  // expired or forged cookie, or a valid cookie belonging to a different order.
  // The cases are deliberately indistinguishable — `LL-#####` is a 90,000-value
  // space and an error that says "wrong cookie" is an oracle that confirms the
  // order exists (same reasoning as SLOT_FULL in checkout).
  ORDER_NOT_FOUND: { status: 404, message: "We couldn't find that order." },
  PAST_CUTOFF: { status: 409, message: "Ordering closed for that pickup time." },
  SLOT_FULL: { status: 409, message: "That pickup time just filled up." },
  OUT_OF_STOCK: { status: 409, message: "An item just sold out." },
  SPEND_CAP_EXCEEDED: { status: 409, message: "Daily spending limit reached." },
  PRODUCT_UNAVAILABLE: {
    status: 409,
    message: "An item is no longer available.",
  },
  PAYMENT_FAILED: { status: 402, message: "Payment was declined." },
  RATE_LIMITED: { status: 429, message: "Too many attempts. Wait a minute." },
  INTERNAL: { status: 500, message: "Something broke on our end." },
  ACCOUNT_UNAUTHORIZED: { status: 401, message: "Email or password is incorrect." },
  ACCOUNT_NOT_CONFIGURED: { status: 503, message: "Account sign-in is not configured on this server." },
  OAUTH_FAILED: { status: 400, message: "Google sign-in could not be completed." },
  USERNAME_TAKEN: { status: 409, message: "That username is already in use." },
  EMAIL_TAKEN: { status: 409, message: "That email is already in use." },

  // ── P4, staff admin (app/api/admin/**) ────────────────────────────────────
  // Returned to an authenticated staff member, not to a student, so unlike
  // ORDER_NOT_FOUND these are allowed to say what actually went wrong: staff are
  // standing at a locker with a queue and need to know whether to collect money,
  // re-read the code, or call someone.

  /// No admin session cookie, an expired or forged one, or a wrong passcode at
  /// the login route. Deliberately one code for all of those — the login form
  /// already knows it just submitted a passcode, so nothing needs the
  /// distinction, and not making it keeps the passcode out of a timing oracle.
  ADMIN_UNAUTHORIZED: { status: 401, message: "Staff sign-in required." },
  /// ADMIN_SESSION_SECRET or ADMIN_PASSCODE is missing (or the passcode is too
  /// short to be worth anything). Fail closed and say so, rather than falling
  /// back to a default password — see lib/admin-session.ts.
  ADMIN_NOT_CONFIGURED: {
    status: 503,
    message: "Staff sign-in is not configured on this server.",
  },
  /// The order exists but is not in a status this action is allowed from.
  /// Detail: `status` (current), `expected` (the statuses that would work).
  INVALID_STATUS_TRANSITION: {
    status: 409,
    message: "That order is not in a state where this is allowed.",
  },
  /// The code the student read out does not match the order. Detail: none —
  /// nothing about the real code ever travels in an error.
  PICKUP_CODE_MISMATCH: {
    status: 409,
    message: "That pickup code does not match this order.",
  },
  /// A cash order reached the locker without its money being recorded. Detail:
  /// `totalCents` (what to collect).
  CASH_NOT_COLLECTED: {
    status: 409,
    message: "Cash has not been recorded for this order yet.",
  },
  /// e.g. recording cash against a card order. Detail: `paymentMethod`.
  PAYMENT_METHOD_MISMATCH: {
    status: 409,
    message: "That action does not apply to this payment method.",
  },
  /// Stripe refused or could not be reached. The order is deliberately left
  /// un-refunded rather than marked REFUNDED for money that never moved.
  REFUND_FAILED: {
    status: 502,
    message: "The refund could not be completed at the payment provider.",
  },
  /// The adjustment would take stock below zero, or the product is gone.
  /// Detail: `productId`, and `stockQty` when the product exists.
  STOCK_ADJUSTMENT_REJECTED: {
    status: 409,
    message: "That stock adjustment would leave a negative quantity.",
  },

  // ── P4b, restricted inventory editor (app/api/inventory/**) ───────────────
  // Deliberately their OWN codes rather than reusing ADMIN_UNAUTHORIZED. The
  // two roles are separate systems (lib/inventory-session.ts): a client that
  // receives one of these must show the inventory sign-in form, never the staff
  // one, and a 401 in one namespace must never read as a hint about the other.

  /// No inventory session cookie, an expired or forged one, a cookie signed
  /// with some other system's secret (a staff `ll_admin` token renamed onto
  /// `ll_inventory` lands here), or a wrong passcode at the login route.
  INVENTORY_UNAUTHORIZED: {
    status: 401,
    message: "Inventory sign-in required.",
  },
  /// INVENTORY_SESSION_SECRET or INVENTORY_PASSCODE is missing, or the passcode
  /// is too short to be worth anything. Fail closed and say so rather than
  /// falling back to a default — see lib/inventory-session.ts.
  INVENTORY_NOT_CONFIGURED: {
    status: 503,
    message: "Inventory sign-in is not configured on this server.",
  },
  /// A product with this slug already exists. Detail: `slug`. Raised instead of
  /// silently suffixing a unique-enough slug, because two near-identical
  /// products in a catalog is a mistake worth stopping, not a naming problem
  /// worth solving automatically.
  PRODUCT_SLUG_TAKEN: {
    status: 409,
    message: "A product with that name already exists.",
  },
  /// Allergen data is missing or unreviewed on a create, an allergen edit, or a
  /// publish (CLAUDE.md §2.8 — never inferred, never defaulted). Detail:
  /// `fields`, the same shape INVALID_INPUT uses, so one form renderer handles
  /// both. Separate from INVALID_INPUT because this one is a safety refusal and
  /// a client should be able to say so in those words.
  ALLERGENS_NOT_REVIEWED: {
    status: 400,
    message: "Allergens must be reviewed before a product can be saved.",
  },
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

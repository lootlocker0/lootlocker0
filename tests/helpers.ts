/* eslint-disable @typescript-eslint/no-explicit-any --
 * API responses are asserted as untyped JSON on purpose. Typing them against a
 * hand-written interface would mean the suite tests the interface it wrote
 * rather than the bytes the route actually returned — a field silently renamed
 * or dropped would still typecheck.
 */
import { randomBytes } from "crypto";
import Stripe from "stripe";
import type { Allergen, Order, OrderItem, Rarity } from "@prisma/client";
import { testDb } from "./setup/db";
import { BASE_URL, CRON_SECRET, STRIPE_WEBHOOK_SECRET } from "./setup/env";
import { readServerLog } from "./setup/server";
import { schoolParts } from "@/lib/timezone";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
  cookies: string[];
}

async function readResponse(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain-text responses (the webhook, the sweep's 401) are normal */
  }
  return {
    status: res.status,
    body: body as any,
    text,
    headers: res.headers,
    cookies: res.headers.getSetCookie?.() ?? [],
  };
}

let ipCounter = 0;

export interface CheckoutOpts {
  /**
   * Every request gets a distinct `x-forwarded-for` by default. With
   * `RATE_LIMIT_DISABLED=1` this changes nothing; it means the same suite also
   * behaves under `memory` mode, and it documents which tests are deliberately
   * sharing an IP (the rate-limit test pins one).
   */
  ip?: string;
  cookie?: string;
}

export async function postCheckout(
  payload: unknown,
  opts: CheckoutOpts = {},
): Promise<ApiResponse> {
  const ip = opts.ip ?? `10.0.${Math.floor(ipCounter / 250) % 250}.${ipCounter++ % 250}`;
  const res = await fetch(`${BASE_URL}/api/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return readResponse(res);
}

export async function getOrder(
  orderNumber: string,
  cookie?: string,
): Promise<ApiResponse> {
  const res = await fetch(`${BASE_URL}/api/orders/${orderNumber}`, {
    headers: cookie ? { cookie } : {},
  });
  return readResponse(res);
}

export async function getProducts(
  query: Record<string, string> = {},
): Promise<ApiResponse> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${BASE_URL}/api/products${qs ? `?${qs}` : ""}`);
  return readResponse(res);
}

export async function runSweep(
  opts: { secret?: string | null } = {},
): Promise<ApiResponse> {
  const secret = opts.secret === undefined ? CRON_SECRET : opts.secret;
  const res = await fetch(`${BASE_URL}/api/cron/sweep`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
  return readResponse(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook forgery — local HMAC, no Stripe account (HANDOFF §20)
// ─────────────────────────────────────────────────────────────────────────────

const stripeSdk = new Stripe("sk_test_placeholder");

export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  eventId?: string,
): Record<string, unknown> {
  return {
    id: eventId ?? `evt_${randomBytes(12).toString("hex")}`,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

export function paymentIntentSucceeded(
  intentId: string,
  amountReceived: number,
  eventId?: string,
) {
  return stripeEvent(
    "payment_intent.succeeded",
    {
      id: intentId,
      object: "payment_intent",
      amount: amountReceived,
      amount_received: amountReceived,
      currency: "cad",
      status: "succeeded",
    },
    eventId,
  );
}

export function paymentIntentFailed(intentId: string, eventId?: string) {
  return stripeEvent(
    "payment_intent.payment_failed",
    {
      id: intentId,
      object: "payment_intent",
      amount: 0,
      amount_received: 0,
      currency: "cad",
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", message: "Your card was declined." },
    },
    eventId,
  );
}

export function chargeRefunded(intentId: string, eventId?: string) {
  return stripeEvent(
    "charge.refunded",
    {
      id: `ch_${randomBytes(10).toString("hex")}`,
      object: "charge",
      payment_intent: intentId,
      refunded: true,
    },
    eventId,
  );
}

export async function postWebhook(
  event: Record<string, unknown>,
  opts: { sign?: boolean; secret?: string; signature?: string } = {},
): Promise<ApiResponse> {
  const payload = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (opts.signature !== undefined) {
    headers["stripe-signature"] = opts.signature;
  } else if (opts.sign !== false) {
    headers["stripe-signature"] = stripeSdk.webhooks.generateTestHeaderString({
      payload,
      secret: opts.secret ?? STRIPE_WEBHOOK_SECRET,
    });
  }

  const res = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
    method: "POST",
    headers,
    body: payload,
  });
  return readResponse(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Server log assertions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The email seam is `lib/email.ts`, which logs `confirmation_email_not_sent`
 * and resolves (delivery is a §7 human escalation — HANDOFF §23). It runs in
 * the dev server process, so there is no in-process spy to assert on the way
 * qa.md's `emailSpy` assumes. Counting its log line for one order id is the
 * equivalent assertion and it is the same thing that would break if a replayed
 * webhook ever notified twice.
 */
export function countLogEvent(event: string, mustContain?: string): number {
  const lines = readServerLog().split("\n");
  let n = 0;
  for (const line of lines) {
    if (!line.includes(`"event":"${event}"`)) continue;
    if (mustContain && !line.includes(mustContain)) continue;
    n++;
  }
  return n;
}

export function confirmationsSentFor(orderId: string): number {
  return countLogEvent("confirmation_email_not_sent", `"orderId":"${orderId}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(3).toString("hex")}`;

export interface SeedProductOpts {
  name?: string;
  slug?: string;
  priceCents?: number;
  stockQty?: number;
  active?: boolean;
  allergens?: Allergen[];
  rarity?: Rarity;
  category?: string;
}

export async function seedProduct(opts: SeedProductOpts = {}) {
  const id = uniq();
  return testDb.product.create({
    data: {
      slug: opts.slug ?? `qa-${id}`,
      name: opts.name ?? `QA Product ${id}`,
      description: "Seeded by the QA suite.",
      priceCents: opts.priceCents ?? 500,
      category: opts.category ?? "sweet",
      rarity: opts.rarity ?? "COMMON",
      allergens: opts.allergens ?? [],
      stockQty: opts.stockQty ?? 10,
      active: opts.active ?? true,
      imageUrl: `/products/qa-${id}.svg`,
    },
  });
}

export interface SeedSlotOpts {
  capacity?: number;
  /** Minutes from now, expressed on the SCHOOL's clock. Default 180. */
  startsInMinutes?: number;
  /** Overrides `startsInMinutes` entirely. */
  serviceDate?: Date;
  startTime?: string;
  active?: boolean;
  label?: string;
  location?: string;
}

/**
 * Builds a pickup window that starts `startsInMinutes` from now **in
 * America/Vancouver**, not in the server's timezone.
 *
 * This matters (HANDOFF §17). `PickupSlot.serviceDate` is a date key stored at
 * midnight UTC and `startTime` is a Vancouver wall clock; a fixture that
 * computes either from the local `Date` getters will agree with a broken
 * server-local cutoff and disagree with a correct one. The suite runs with
 * `TZ=Asia/Tokyo` on both sides precisely so that a fixture built this way and
 * a route using `lib/timezone.ts` have to agree across a calendar-day boundary.
 */
export async function seedSlot(opts: SeedSlotOpts = {}) {
  const startsIn = opts.startsInMinutes ?? 180;
  const target = new Date(Date.now() + startsIn * 60_000);
  const p = schoolParts(target);

  const serviceDate =
    opts.serviceDate ?? new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0));
  const startTime =
    opts.startTime ??
    `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;

  return testDb.pickupSlot.create({
    data: {
      label: opts.label ?? `QA Window ${uniq()}`,
      startTime,
      // Unique per slot: @@unique([serviceDate, startTime, location]) otherwise
      // collides for two windows seeded in the same minute.
      location: opts.location ?? `Locker bank ${uniq()}`,
      serviceDate,
      capacity: opts.capacity ?? 10,
      bookedCount: 0,
      active: opts.active ?? true,
    },
  });
}

export const seedSlotMinutesFromNow = (m: number, capacity = 10) =>
  seedSlot({ startsInMinutes: m, capacity });

export interface CheckoutPayloadOpts {
  slotId: string;
  items: { productId: string; qty: number }[];
  email?: string;
  studentName?: string;
  phone?: string;
  homeroom?: string;
  paymentMethod?: "CARD" | "CASH_AT_PICKUP";
  clientTotalCents?: number;
}

export function checkoutPayload(opts: CheckoutPayloadOpts) {
  return {
    studentName: opts.studentName ?? "QA Student",
    email: opts.email ?? `qa-${uniq()}@school.ca`,
    phone: opts.phone ?? "604-555-0100",
    ...(opts.homeroom ? { homeroom: opts.homeroom } : {}),
    slotId: opts.slotId,
    paymentMethod: opts.paymentMethod ?? "CASH_AT_PICKUP",
    items: opts.items,
    ...(opts.clientTotalCents !== undefined
      ? { clientTotalCents: opts.clientTotalCents }
      : {}),
  };
}

export type SeededOrder = Order & {
  items: OrderItem[];
  cookie: string;
  clientSecret?: string;
};

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

/**
 * A real PENDING card order, created by driving the real checkout route rather
 * than inserting rows.
 *
 * Deliberate: a hand-inserted fixture cannot reproduce the stock and seat holds
 * the release path is supposed to give back, and `order_total_consistent` /
 * `booked_within_capacity` reject sloppy inserts anyway (HANDOFF §7).
 */
export async function seedPendingCardOrder(
  opts: {
    totalCents?: number;
    qty?: number;
    stockQty?: number;
    capacity?: number;
    expiresAt?: Date | null;
    email?: string;
    /** Attributes the order to a signed-in account, exactly like a browser
     *  carrying `ll_account` at checkout. Omit for a guest order. */
    accountCookie?: string;
  } = {},
): Promise<SeededOrder> {
  const totalCents = opts.totalCents ?? 500;
  const qty = opts.qty ?? 1;
  if (totalCents % qty !== 0) {
    throw new Error("seedPendingCardOrder: totalCents must divide by qty");
  }

  const slot = await seedSlot({ capacity: opts.capacity ?? 10 });
  const product = await seedProduct({
    priceCents: totalCents / qty,
    stockQty: opts.stockQty ?? 20,
  });

  const r = await postCheckout(
    checkoutPayload({
      slotId: slot.id,
      email: opts.email,
      paymentMethod: "CARD",
      items: [{ productId: product.id, qty }],
    }),
    { cookie: opts.accountCookie },
  );
  if (r.status !== 200) {
    throw new Error(`seedPendingCardOrder: checkout failed ${r.status} ${r.text}`);
  }

  if (opts.expiresAt !== undefined) {
    await testDb.order.update({
      where: { orderNumber: r.body.orderNumber },
      data: { expiresAt: opts.expiresAt },
    });
  }

  const order = await testDb.order.findUniqueOrThrow({
    where: { orderNumber: r.body.orderNumber },
    include: { items: true },
  });

  return {
    ...order,
    cookie: cookieHeaderFrom(r.cookies),
    clientSecret: r.body.clientSecret,
  };
}

/** A PAID card order: the same thing, then a signed succeeded webhook. */
export async function seedPaidOrder(
  opts: Parameters<typeof seedPendingCardOrder>[0] = {},
): Promise<SeededOrder> {
  const order = await seedPendingCardOrder(opts);
  const r = await postWebhook(
    paymentIntentSucceeded(order.stripePaymentIntentId!, order.totalCents),
  );
  if (r.status !== 200) throw new Error(`seedPaidOrder: webhook ${r.status} ${r.text}`);
  const refreshed = await testDb.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { items: true },
  });
  if (refreshed.status !== "PAID") {
    throw new Error(`seedPaidOrder: expected PAID, got ${refreshed.status}`);
  }
  return { ...refreshed, cookie: order.cookie };
}

/**
 * One cash checkout for `cents`, which lands RESERVED and therefore counts
 * against the daily cap immediately (PENDING is excluded from the aggregate by
 * design — HANDOFF §21).
 */
export async function spendAttempt(
  email: string,
  cents: number,
  slotId: string,
): Promise<ApiResponse> {
  const product = await seedProduct({ priceCents: cents, stockQty: 100 });
  return postCheckout(
    checkoutPayload({
      slotId,
      email,
      items: [{ productId: product.id, qty: 1 }],
      paymentMethod: "CASH_AT_PICKUP",
    }),
  );
}

export async function spend(email: string, cents: number, slotId: string) {
  const r = await spendAttempt(email, cents, slotId);
  if (r.status !== 200) throw new Error(`spend(${cents}) failed: ${r.status} ${r.text}`);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff admin (§6a) and inventory editor (§6b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `tests/setup/env.ts` does NOT pin these — `next dev` reads them from the
 * repo's `.env`, which is where the dev values live. Kept as constants here so
 * a suite that needs to prove the two credentials are different has something
 * to compare, and so a missing `.env` fails with a readable message rather than
 * a wall of 503s.
 */
export const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE ?? "dev-staff-passcode";
export const INVENTORY_PASSCODE = process.env.INVENTORY_PASSCODE ?? "dev-inventory-passcode";

async function loginCookie(path: string, passcode: string): Promise<string> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.7.7.${ipCounter++ % 250}` },
    body: JSON.stringify({ passcode }),
  });
  if (res.status !== 200) {
    throw new Error(
      `${path} failed ${res.status}: ${await res.text()}\n` +
        `The dev server reads ADMIN_PASSCODE / INVENTORY_PASSCODE from the repo's ` +
        `.env (tests/setup/env.ts deliberately does not override them). If this is ` +
        `a 503, that file is missing or the passcode is under 8 characters.`,
    );
  }
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

export const adminCookie = () => loginCookie("/api/admin/login", ADMIN_PASSCODE);
export const inventoryCookie = () => loginCookie("/api/inventory/login", INVENTORY_PASSCODE);

export async function adminPost(
  path: string,
  cookie: string,
  body: unknown = {},
): Promise<ApiResponse> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return readResponse(res);
}

export async function inventoryRequest(
  method: "GET" | "POST" | "PATCH",
  path: string,
  cookie: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return readResponse(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// The Locker account (§6c) — no secret to configure. Unlike admin/inventory,
// the session cookie carries a random token whose hash is looked up in
// `account_sessions`, so there is nothing for tests/setup/env.ts to pin.
// ─────────────────────────────────────────────────────────────────────────────

export interface SignedUpAccount {
  user: { id: string; username: string; email: string; rewardPoints: number };
  cookie: string;
}

/**
 * Creates a real account through the real signup route (not an insert — the
 * password hash, the session row, and the `ll_account` cookie all have to be
 * genuine for a test that then drives checkout/webhooks/refunds as that
 * account).
 */
export async function signupAccount(
  opts: { username?: string; email?: string; password?: string } = {},
): Promise<SignedUpAccount> {
  const id = uniq();
  const res = await fetch(`${BASE_URL}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: opts.username ?? `qa_${id}`,
      email: opts.email ?? `qa-account-${id}@school.ca`,
      password: opts.password ?? "qa-password-1234",
    }),
  });
  const r = await readResponse(res);
  if (r.status !== 200) {
    throw new Error(`signupAccount: signup failed ${r.status} ${r.text}`);
  }
  return { user: r.body.user, cookie: cookieHeaderFrom(r.cookies) };
}

export async function getAccountMe(cookie?: string): Promise<ApiResponse> {
  const res = await fetch(`${BASE_URL}/api/account/me`, {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  });
  return readResponse(res);
}

export async function getAccountOrders(cookie?: string): Promise<ApiResponse> {
  const res = await fetch(`${BASE_URL}/api/account/orders`, {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  });
  return readResponse(res);
}

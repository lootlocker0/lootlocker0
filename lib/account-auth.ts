import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import type { NextRequest } from "next/server";
import { db } from "./db";
import { AppError } from "./errors";

const scrypt = promisify(nodeScrypt);
const ACCOUNT_SESSION_COOKIE = "ll_account";
const ACCOUNT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_COOKIE = "ll_oauth_state";
const IS_PROD = process.env.NODE_ENV === "production";

export const accountUserSelect = {
  id: true,
  username: true,
  name: true,
  email: true,
  rewardPoints: true,
} as const;

export type AccountUser = {
  id: string;
  username: string;
  name: string | null;
  email: string;
  rewardPoints: number;
};

export function publicAccountUser(user: AccountUser): { user: AccountUser } {
  return { user };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const [saltHex, digestHex] = stored.split(":");
  if (!saltHex || !digestHex || !/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(digestHex)) {
    return false;
  }
  const expected = Buffer.from(digestHex, "hex");
  const actual = (await scrypt(password, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createAccountSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.accountSession.create({
    data: {
      tokenHash: hash(token),
      userId,
      expiresAt: new Date(Date.now() + ACCOUNT_SESSION_TTL_SECONDS * 1000),
    },
  });
  return {
    name: ACCOUNT_SESSION_COOKIE,
    value: token,
    httpOnly: true as const,
    secure: IS_PROD,
    sameSite: "lax" as const,
    path: "/",
    maxAge: ACCOUNT_SESSION_TTL_SECONDS,
  };
}

export function clearAccountSessionCookie() {
  return {
    name: ACCOUNT_SESSION_COOKIE,
    value: "",
    httpOnly: true as const,
    secure: IS_PROD,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}

export async function getAccountUser(req: NextRequest): Promise<AccountUser | null> {
  const token = req.cookies.get(ACCOUNT_SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.accountSession.findUnique({
    where: { tokenHash: hash(token) },
    include: { user: { select: accountUserSelect } },
  });
  if (!session) return null;
  if (session.expiresAt <= new Date()) {
    await db.accountSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.user;
}

export async function requireAccountUser(req: NextRequest): Promise<AccountUser> {
  const user = await getAccountUser(req);
  if (!user) throw new AppError("ACCOUNT_UNAUTHORIZED");
  return user;
}

export async function revokeAccountSession(req: NextRequest): Promise<void> {
  const token = req.cookies.get(ACCOUNT_SESSION_COOKIE)?.value;
  if (token) {
    await db.accountSession.deleteMany({ where: { tokenHash: hash(token) } });
  }
}

export function assertGoogleOAuthConfigured(): void {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    throw new AppError("ACCOUNT_NOT_CONFIGURED");
  }
}

export async function createOAuthState(): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  await db.oAuthState.create({
    data: {
      stateHash: hash(state),
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    },
  });
  return state;
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const result = await db.oAuthState.deleteMany({
    where: { stateHash: hash(state), expiresAt: { gt: new Date() } },
  });
  return result.count === 1;
}

/// The DB-side `state` row alone proves the value is genuine and single-use —
/// it does NOT prove the browser presenting it at `/callback` is the one that
/// started the flow at `/start`. Without that binding, an attacker can start
/// their own sign-in, capture the resulting `?code=...&state=...` URL before
/// their own browser ever loads it, and hand that link to someone else: the
/// victim's browser completes a real, valid, single-use OAuth exchange and
/// walks away signed into the ATTACKER's account (classic OAuth login CSRF /
/// session fixation). This cookie is the fix: `/start` sets it to the same
/// value handed to Google, `/callback` requires the incoming `state` query
/// param to match this cookie — held only by the browser that began the
/// flow — before it ever touches the database. httpOnly (never read by page
/// JS) and short-lived (matches the state row's own TTL); `secure` only in
/// production so http-only local dev keeps working.
export function oauthStateCookie(state: string) {
  return {
    name: OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true as const,
    secure: IS_PROD,
    sameSite: "lax" as const,
    path: "/api/account/google",
    maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
  };
}

export function clearedOAuthStateCookie() {
  return {
    name: OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true as const,
    secure: IS_PROD,
    sameSite: "lax" as const,
    path: "/api/account/google",
    maxAge: 0,
  };
}

/// Timing-safe: both sides are attacker-influenced-length-adjacent random
/// tokens, so a naive `===` would leak a byte-at-a-time timing oracle the
/// same way every other signed-cookie comparison in this codebase avoids.
export function oauthStateMatchesCookie(req: NextRequest, state: string): boolean {
  const cookieValue = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!cookieValue) return false;
  const a = Buffer.from(cookieValue, "utf8");
  const b = Buffer.from(state, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function accountSessionCookieName(): string {
  return ACCOUNT_SESSION_COOKIE;
}
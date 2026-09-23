import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import {
  assertGoogleOAuthConfigured,
  clearedOAuthStateCookie,
  consumeOAuthState,
  createAccountSession,
  accountUserSelect,
  oauthStateMatchesCookie,
} from "@/lib/account-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GoogleProfile = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

function usernameBase(email: string, name: unknown): string {
  const source = typeof name === "string" && name.trim() ? name : email.split("@")[0];
  const base = source.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
  return base.length >= 3 ? base : `locker${email.replace(/[^a-z0-9]/gi, "").slice(0, 20)}`;
}

/// Google's real, properly-spaced/-cased display name ("Tahmeed Hossain"),
/// kept separate from `username` (the compressed, unique login handle
/// `usernameBase` derives from it). Every display surface must read
/// `name ?? username`, not `username` alone — see the field's schema comment.
function displayName(name: unknown): string | null {
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null;
}

async function upsertGoogleUser(profile: GoogleProfile) {
  if (typeof profile.sub !== "string" || typeof profile.email !== "string" || profile.email_verified !== true) {
    throw new AppError("OAUTH_FAILED");
  }
  const email = profile.email.trim().toLowerCase();
  const name = displayName(profile.name);

  const existingGoogle = await db.user.findUnique({ where: { googleId: profile.sub } });
  if (existingGoogle) {
    // Backfill for an account created before this field existed, or whose
    // name was never captured on an earlier login — never overwrite one
    // that's already set (Google's name could change; the account owner's
    // idea of their name, once recorded, isn't second-guessed by a login).
    if (!existingGoogle.name && name) {
      return db.user.update({ where: { id: existingGoogle.id }, data: { name }, select: accountUserSelect });
    }
    return db.user.findUniqueOrThrow({ where: { id: existingGoogle.id }, select: accountUserSelect });
  }

  const existingEmail = await db.user.findUnique({ where: { email } });
  if (existingEmail) {
    if (existingEmail.googleId && existingEmail.googleId !== profile.sub) throw new AppError("OAUTH_FAILED");
    // Google has already proven ownership of this email (email_verified must
    // be true, checked above). Linking here is the moment the real owner is
    // proven — not whoever set the original password. If an attacker had
    // created this account with a password to squat the email, their
    // password must stop working and their sessions must die right now, or
    // linking a Google identity would do nothing to close their access.
    const [updated] = await db.$transaction([
      db.user.update({
        where: { id: existingEmail.id },
        data: {
          googleId: profile.sub,
          passwordHash: null,
          ...(!existingEmail.name && name ? { name } : {}),
        },
        select: accountUserSelect,
      }),
      db.accountSession.deleteMany({ where: { userId: existingEmail.id } }),
    ]);
    return updated;
  }

  const base = usernameBase(email, profile.name);
  for (let suffix = 0; suffix < 10; suffix++) {
    const username = `${base}${suffix ? suffix : ""}`.slice(0, 30);
    try {
      return await db.user.create({
        data: { username, name, email, googleId: profile.sub },
        select: accountUserSelect,
      });
    } catch (error) {
      if ((error as { code?: string })?.code !== "P2002") throw error;
    }
  }
  throw new AppError("OAUTH_FAILED");
}

export async function GET(req: NextRequest) {
  try {
    assertGoogleOAuthConfigured();
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    // Cookie check first — cheap, no DB round trip, and it's the check that
    // actually stops OAuth login CSRF (see oauthStateCookie's comment): the
    // DB-side consumeOAuthState alone proves the value is genuine and
    // single-use, not that THIS browser is the one /start issued it to.
    //
    // Logged separately (not just a single collapsed OAUTH_FAILED) because the
    // four ways this can fail point at completely different problems — a
    // cookie mismatch means the browser/cookie plumbing is wrong, an expired
    // state means the user sat on Google's consent screen too long, and this
    // is the only place that distinction is visible at all.
    if (!code || !state) {
      logEvent("oauth_callback_denied", { reason: "missing_code_or_state" });
      throw new AppError("OAUTH_FAILED");
    }
    if (!oauthStateMatchesCookie(req, state)) {
      logEvent("oauth_callback_denied", { reason: "state_cookie_mismatch" });
      throw new AppError("OAUTH_FAILED");
    }
    if (!(await consumeOAuthState(state))) {
      logEvent("oauth_callback_denied", { reason: "state_row_missing_or_expired" });
      throw new AppError("OAUTH_FAILED");
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenResponse.ok) throw new AppError("OAUTH_FAILED");
    const tokens = (await tokenResponse.json()) as { access_token?: unknown };
    if (typeof tokens.access_token !== "string") throw new AppError("OAUTH_FAILED");

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResponse.ok) throw new AppError("OAUTH_FAILED");
    const user = await upsertGoogleUser((await profileResponse.json()) as GoogleProfile);
    const cookie = await createAccountSession(user.id);
    const response = NextResponse.redirect(new URL("/", process.env.NEXT_PUBLIC_SITE_URL ?? req.nextUrl.origin));
    response.cookies.set(cookie);
    response.cookies.set(clearedOAuthStateCookie());
    return response;
  } catch (error) {
    // errorResponse() returns a plain Fetch Response (Response.json(...)),
    // not a NextResponse, so it has no .cookies API to clear the state
    // cookie on. Rebuild it as a NextResponse with the identical body/status
    // rather than changing errorResponse()'s shared return type for every
    // other route in the codebase.
    const errRes = errorResponse(error);
    const body = await errRes.json();
    const response = NextResponse.json(body, { status: errRes.status });
    // Single-use either way: a failed attempt must not leave a live
    // state-bound cookie for a later request to reuse.
    response.cookies.set(clearedOAuthStateCookie());
    return response;
  }
}
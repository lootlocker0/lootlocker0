import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import {
  assertGoogleOAuthConfigured,
  consumeOAuthState,
  createAccountSession,
  accountUserSelect,
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

async function upsertGoogleUser(profile: GoogleProfile) {
  if (typeof profile.sub !== "string" || typeof profile.email !== "string" || profile.email_verified !== true) {
    throw new AppError("OAUTH_FAILED");
  }
  const email = profile.email.trim().toLowerCase();
  const existingGoogle = await db.user.findUnique({ where: { googleId: profile.sub } });
  if (existingGoogle) return db.user.findUniqueOrThrow({ where: { id: existingGoogle.id }, select: accountUserSelect });

  const existingEmail = await db.user.findUnique({ where: { email } });
  if (existingEmail) {
    if (existingEmail.googleId && existingEmail.googleId !== profile.sub) throw new AppError("OAUTH_FAILED");
    return db.user.update({
      where: { id: existingEmail.id },
      data: { googleId: profile.sub },
      select: accountUserSelect,
    });
  }

  const base = usernameBase(email, profile.name);
  for (let suffix = 0; suffix < 10; suffix++) {
    const username = `${base}${suffix ? suffix : ""}`.slice(0, 30);
    try {
      return await db.user.create({
        data: { username, email, googleId: profile.sub },
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
    if (!code || !state || !(await consumeOAuthState(state))) throw new AppError("OAUTH_FAILED");

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
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
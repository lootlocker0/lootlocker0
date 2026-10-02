import { NextResponse, type NextRequest } from "next/server";
import {
  assertGoogleOAuthConfigured,
  createOAuthState,
  oauthStateCookie,
} from "@/lib/account-auth";
import { AppError, errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    assertGoogleOAuthConfigured();
    const state = await createOAuthState();
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    const response = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    // Binds this flow to THIS browser — see the comment on oauthStateCookie.
    // Without it, the state row alone only proves the value is genuine and
    // single-use, not that the browser at /callback is the one that started
    // this request.
    response.cookies.set(oauthStateCookie(state));
    return response;
  } catch (error) {
    if (error instanceof AppError && error.code === "ACCOUNT_NOT_CONFIGURED") {
      return NextResponse.redirect(new URL("/locker?oauth=not_configured", req.url));
    }
    return errorResponse(error);
  }
}
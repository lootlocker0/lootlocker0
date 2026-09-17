import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/errors";
import { clearAccountSessionCookie, revokeAccountSession } from "@/lib/account-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await revokeAccountSession(req);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(clearAccountSessionCookie());
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/errors";
import { requireAccountUser, publicAccountUser } from "@/lib/account-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    return NextResponse.json(publicAccountUser(await requireAccountUser(req)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
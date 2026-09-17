import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { accountLoginSchema } from "@/lib/validation";
import {
  createAccountSession,
  publicAccountUser,
  verifyPassword,
} from "@/lib/account-auth";
import { createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`account:login:ip:${ip}`, 10, 300);
    await rateLimit("account:login:global", 120, 300);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new AppError("INVALID_INPUT", { fields: { _body: ["Request body must be JSON."] } });
    }
    const parsed = accountLoginSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", { fields: parsed.error.flatten().fieldErrors });
    }
    await rateLimit(
      `account:login:email:${createHash("sha256").update(parsed.data.email).digest("hex").slice(0, 16)}`,
      10,
      300,
    );
    const user = await db.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      throw new AppError("ACCOUNT_UNAUTHORIZED");
    }
    const cookie = await createAccountSession(user.id);
    const response = NextResponse.json(
      publicAccountUser({ id: user.id, username: user.username, email: user.email, rewardPoints: user.rewardPoints }),
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(cookie);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
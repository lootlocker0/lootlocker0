import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { accountSignupSchema } from "@/lib/validation";
import {
  accountUserSelect,
  createAccountSession,
  hashPassword,
  publicAccountUser,
} from "@/lib/account-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`account:signup:ip:${ip}`, 10, 300);
    await rateLimit("account:signup:global", 60, 300);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new AppError("INVALID_INPUT", { fields: { _body: ["Request body must be JSON."] } });
    }
    const parsed = accountSignupSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", { fields: parsed.error.flatten().fieldErrors });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const user = await db.user.create({
      data: {
        username: parsed.data.username,
        email: parsed.data.email,
        passwordHash,
      },
      select: accountUserSelect,
    }).catch((error: unknown) => {
      if ((error as { code?: string })?.code === "P2002") {
        const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? "");
        throw new AppError(target.includes("username") ? "USERNAME_TAKEN" : "EMAIL_TAKEN");
      }
      throw error;
    });
    const cookie = await createAccountSession(user.id);
    const response = NextResponse.json(publicAccountUser(user), { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(cookie);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
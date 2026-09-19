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
        // Prisma 7 + the pg driver adapter nests the real constraint name
        // under `meta.driverAdapterError.cause`, not the flat `meta.target`
        // string/array Prisma's built-in query engine used to report — see
        // lib/db.ts's "DELTA FROM CLAUDE.md §4" note on the same adapter
        // migration. `meta.target` is `undefined` under this adapter, so
        // checking it alone always fell through to EMAIL_TAKEN, even for a
        // username-only collision. Both the constraint's index name
        // ("users_username_key") and the raw Postgres error message contain
        // the column name; checking both is belt-and-suspenders against
        // either shape changing again.
        const meta = (error as { meta?: Record<string, unknown> }).meta ?? {};
        const driverCause = (
          meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined
        )?.cause;
        const haystack = [
          meta.target,
          (driverCause?.constraint as { index?: unknown } | undefined)?.index,
          driverCause?.originalMessage,
        ]
          .map((v) => String(v ?? ""))
          .join(" ");
        throw new AppError(haystack.includes("username") ? "USERNAME_TAKEN" : "EMAIL_TAKEN");
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
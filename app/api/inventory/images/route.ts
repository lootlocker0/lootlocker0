import type { NextRequest } from "next/server";
import { requireInventorySession } from "@/lib/inventory-session";
import { AppError, errorResponse } from "@/lib/errors";
import { saveProductImage } from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: NextRequest) {
  try {
    requireInventorySession(req);
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      throw new AppError("INVALID_INPUT", { fields: { file: ["Choose an image file."] } });
    }

    const extension = MIME_TO_EXTENSION[file.type];
    if (!extension) {
      throw new AppError("INVALID_INPUT", {
        fields: { file: ["Use a JPG, PNG, WEBP, or GIF image."] },
      });
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      throw new AppError("INVALID_INPUT", {
        fields: { file: ["Image must be larger than 0 bytes and no bigger than 5 MB."] },
      });
    }

    const imageUrl = await saveProductImage(file, extension);

    return Response.json(
      { imageUrl },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
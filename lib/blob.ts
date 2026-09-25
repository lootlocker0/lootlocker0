import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";
import { AppError } from "./errors";
import { logEvent } from "./log";

// Product image uploads (app/api/inventory/images/route.ts) need somewhere to
// actually persist the file. Vercel's serverless functions run on a
// read-only filesystem outside `/tmp` — a plain fs.writeFile into `public/`
// works in local dev (a real disk) but throws on Vercel. Modes, resolved once
// per process, mirror lib/rate-limit.ts's shape:
//
//   blob         BLOB_READ_WRITE_TOKEN present. Real Vercel Blob storage —
//                works identically in dev, preview, and production, and the
//                URL it returns survives a redeploy.
//   disk         No token and not production. Writes into
//                public/ProductImages for local dev convenience only; never
//                reachable in production (see fail-closed below).
//   fail-closed  Production, no token. Throw a clear, diagnosable error
//                rather than let a raw fs write hit the read-only filesystem
//                and surface a cryptic EROFS to an inventory editor.

const IS_PROD = process.env.NODE_ENV === "production";

type Mode = "blob" | "disk" | "fail-closed";

function resolveMode(): Mode {
  if (process.env.BLOB_READ_WRITE_TOKEN) return "blob";
  if (!IS_PROD) return "disk";
  return "fail-closed";
}

export const imageStorageMode: Mode = resolveMode();

logEvent("image_storage_mode", { mode: imageStorageMode });

/** Saves an uploaded product image and returns the URL to store on the
 *  product — a real `https://` URL in `blob` mode, a site-relative path in
 *  `disk` mode. `lib/validation.ts`'s `productImageUrl` schema accepts both
 *  shapes already. */
export async function saveProductImage(file: File, extension: string): Promise<string> {
  const filename = `${randomUUID()}.${extension}`;

  switch (imageStorageMode) {
    case "blob": {
      const blob = await put(`ProductImages/${filename}`, file, {
        access: "public",
        contentType: file.type,
        addRandomSuffix: false,
      });
      return blob.url;
    }

    case "disk": {
      const directory = path.join(process.cwd(), "public", "ProductImages");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, filename), Buffer.from(await file.arrayBuffer()), {
        flag: "wx",
      });
      return `/ProductImages/${filename}`;
    }

    case "fail-closed":
      logEvent("image_storage_misconfigured");
      throw new AppError("IMAGE_STORAGE_NOT_CONFIGURED");
  }
}

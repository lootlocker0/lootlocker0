import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { imageStorageMode, saveProductImage } from "@/lib/blob";

/**
 * The disk fallback only, in this environment (no BLOB_READ_WRITE_TOKEN, not
 * production) — proved directly, same reasoning as rate-limit.test.ts's
 * "runs in memory mode here, not disabled". The `blob` mode itself needs a
 * real Vercel Blob token this harness doesn't have, so it isn't exercised
 * here; the switch in lib/blob.ts is small enough that disk-mode coverage is
 * the useful signal.
 */
describe("product image storage", () => {
  const written: string[] = [];

  afterEach(async () => {
    await Promise.all(
      written.splice(0).map((p) => rm(path.join(process.cwd(), "public", p), { force: true })),
    );
  });

  it("runs in disk mode here, not blob or fail-closed", () => {
    expect(imageStorageMode).toBe("disk");
  });

  it("writes the file under public/ProductImages and returns a site-relative path", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "test.png", { type: "image/png" });
    const url = await saveProductImage(file, "png");
    written.push(url);

    expect(url).toMatch(/^\/ProductImages\/[0-9a-f-]+\.png$/);
    const { size } = await import("node:fs/promises").then((fs) =>
      fs.stat(path.join(process.cwd(), "public", url)),
    );
    expect(size).toBe(4);
  });

  it("gives each upload a distinct filename", async () => {
    const file = new File([new Uint8Array([9])], "a.jpg", { type: "image/jpeg" });
    const [a, b] = await Promise.all([saveProductImage(file, "jpg"), saveProductImage(file, "jpg")]);
    written.push(a, b);
    expect(a).not.toBe(b);
  });
});

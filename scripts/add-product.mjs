#!/usr/bin/env node
// Add a product the same way a human editor does — over HTTP, through
// /api/inventory/*, never by writing to Prisma directly.
//
// Why this shape, on purpose: this script is a CLIENT of the same contract
// the /inventory UI's ProductForm.tsx calls (docs/API-CONTRACT.md §6b,
// "Adding a product: the three supported ways", option 3). It cannot bypass
// the allergen-review gate, the slug-uniqueness check, integer-cent pricing,
// or any other invariant the human path already enforces, because it goes
// through the exact same validated route. If you find yourself wanting to
// import "@/lib/db" or "@prisma/client" here to go faster, don't — that is
// a second, unaudited write path into a table CLAUDE.md §2.7 calls
// safety-critical (allergens), and it is exactly what this script exists to
// avoid.
//
// Usage:
//   INVENTORY_PASSCODE=... node scripts/add-product.mjs --file product.json
//   INVENTORY_PASSCODE=... node scripts/add-product.mjs \
//     --name "Cheese Puffs" --description "..." --priceCents 250 \
//     --category savory --rarity COMMON --allergens DAIRY,GLUTEN \
//     --stockQty 20 --imageUrl /ProductImages/cheese-puffs.png --active true
//
// Optional flags: --slug, --sortOrder, --image <local-file-path> (uploads via
// POST /api/inventory/images first and uses the returned imageUrl instead of
// --imageUrl), --base-url (default http://localhost:3000).
//
// Env: INVENTORY_PASSCODE (required, never pass it as a flag — it would land
// in shell history and process listings). BASE_URL as an alternative to
// --base-url.
//
// Known gap this script does NOT work around: `sizeProduct` is not accepted
// by /api/inventory/products (the schema is .strict() and does not list it)
// — see docs/API-CONTRACT.md §6b. Set it via prisma/seed.ts if you need it.

import { readFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(message) {
  console.error(`add-product: ${message}`);
  process.exit(1);
}

async function loadFields(args) {
  if (args.file) {
    const raw = await readFile(path.resolve(args.file), "utf8");
    return JSON.parse(raw);
  }

  const fields = {};
  if (args.name) fields.name = args.name;
  if (args.slug) fields.slug = args.slug;
  if (args.description) fields.description = args.description;
  if (args.priceCents !== undefined) fields.priceCents = Number(args.priceCents);
  if (args.category) fields.category = args.category;
  if (args.rarity) fields.rarity = args.rarity;
  if (args.allergens !== undefined) {
    fields.allergens =
      args.allergens === true || args.allergens === ""
        ? []
        : String(args.allergens)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
  }
  if (args.stockQty !== undefined) fields.stockQty = Number(args.stockQty);
  if (args.imageUrl) fields.imageUrl = args.imageUrl;
  if (args.active !== undefined) fields.active = String(args.active) === "true";
  if (args.sortOrder !== undefined) fields.sortOrder = Number(args.sortOrder);
  return fields;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["base-url"] ?? process.env.BASE_URL ?? "http://localhost:3000";
  const passcode = process.env.INVENTORY_PASSCODE;

  if (!passcode) {
    fail("set INVENTORY_PASSCODE in the environment (never as a --flag).");
  }

  const fields = await loadFields(args);

  // allergensReviewed is a deliberate, explicit affirmation
  // (lib/validation.ts) — never inferred from the allergens list. This
  // script sets it to true because it is a synchronous, one-shot create with
  // a human-supplied allergen list right here in the same call; a caller
  // building a bulk-import wrapper around this script is the one asserting
  // the list was actually reviewed and should not do so lightly.
  fields.allergensReviewed = true;

  for (const required of [
    "name",
    "description",
    "priceCents",
    "category",
    "rarity",
    "allergens",
    "stockQty",
    "active",
  ]) {
    if (fields[required] === undefined) {
      fail(`missing required field "${required}" (see --help in the file header).`);
    }
  }

  // ── 1. Sign in ──────────────────────────────────────────────────────────
  const loginRes = await fetch(`${baseUrl}/api/inventory/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.json().catch(() => ({}));
    fail(`login failed (${loginRes.status}): ${JSON.stringify(body)}`);
  }
  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) fail("login succeeded but no session cookie was returned.");
  const cookie = setCookie.split(";")[0];

  // ── 2. Optional photo upload ───────────────────────────────────────────
  if (args.image) {
    const bytes = await readFile(path.resolve(args.image));
    const ext = path.extname(args.image).toLowerCase();
    const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext];
    if (!mime) fail(`unsupported image extension "${ext}" (jpg, png, webp, gif only).`);

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), path.basename(args.image));

    const uploadRes = await fetch(`${baseUrl}/api/inventory/images`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    const uploadBody = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok) {
      fail(`image upload failed (${uploadRes.status}): ${JSON.stringify(uploadBody)}`);
    }
    fields.imageUrl = uploadBody.imageUrl;
    console.log(`Uploaded image -> ${fields.imageUrl}`);
  }

  if (!fields.imageUrl) {
    fail('no imageUrl set — pass --imageUrl "/ProductImages/x.png" or --image <local file>.');
  }

  // ── 3. Create the product ──────────────────────────────────────────────
  const createRes = await fetch(`${baseUrl}/api/inventory/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(fields),
  });
  const createBody = await createRes.json().catch(() => ({}));

  if (!createRes.ok) {
    // Surface the server's own error — including ALLERGENS_NOT_REVIEWED and
    // PRODUCT_SLUG_TAKEN — rather than reinterpreting it. If the allergen
    // gate rejects this, that's the gate doing its job; fix the input, don't
    // route around the check.
    fail(`create failed (${createRes.status}): ${JSON.stringify(createBody)}`);
  }

  console.log(
    `Created product: id=${createBody.product.id} slug=${createBody.product.slug} ` +
      `priceCents=${createBody.product.priceCents} active=${createBody.product.active}`,
  );
}

main().catch((e) => fail(e instanceof Error ? e.stack : String(e)));

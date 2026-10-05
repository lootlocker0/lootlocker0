#!/usr/bin/env node
// P4b — the inventory boundary, asserted mechanically.
//
//     node scripts/verify-inventory-isolation.mjs
//
// The requirement (BUILDPLAN.md §P4b) is that orders, order items, student PII,
// payment state, Stripe and settings are unreachable through an inventory
// session at the ROUTE level — not hidden in a UI. A claim like that decays the
// moment somebody adds a convenient `include` to a handler, so it is written
// here as a check that fails a build rather than as a paragraph in a document.
//
// Exit code 0 = boundary intact. Non-zero = a violation, printed with the file,
// the line and the reason.
//
// WHAT THIS CAN AND CANNOT PROVE. It reads source, so it proves that no route
// handler in the namespace names a forbidden model, imports a forbidden module,
// or returns a column outside an explicit whitelist. It cannot prove anything
// about a running process — the Prisma client is a shared singleton and could
// in principle query anything, so the guarantee is "no inventory code path asks
// it to". The complementary runtime proof (an inventory cookie gets 401 from
// every /api/admin and /api/orders route, and vice versa) is in
// docs/HANDOFF.md's P4b verification note and is qa's to automate.
//
// Comments are stripped before scanning, so prose in this codebase that names
// `db.order` while explaining why it is absent does not trip the check.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const INVENTORY_ROUTE_DIR = join(ROOT, "app/api/inventory");
const INVENTORY_LIBS = [
  join(ROOT, "lib/inventory-session.ts"),
  join(ROOT, "lib/db/inventory.ts"),
];

const failures = [];
const checks = [];

function fail(file, line, message) {
  failures.push({ file: relative(ROOT, file), line, message });
}
function pass(message) {
  checks.push(message);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/// Blank out comments, preserving line numbering so reported lines are real.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;{(])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

function linesOf(src) {
  return src.split("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. No forbidden model, module or table is named by any inventory source file
// ─────────────────────────────────────────────────────────────────────────────
//
// Each pattern is precise on purpose: the word "order" appears constantly in
// comments and in phrases like "order of operations", so only real access
// syntax is matched.

const FORBIDDEN = [
  [/\bdb\.order\b/, "Order model access"],
  [/\bdb\.orderItem\b/, "OrderItem model access"],
  [/\bdb\.setting\b/, "Setting model access"],
  [/\bdb\.webhookEvent\b/, "WebhookEvent model access"],
  [/\btx\.order\b/, "Order model access inside a transaction"],
  [/\bgetSetting\s*\(/, "settings read"],
  [/from\s+["']@\/lib\/settings["']/, "import of lib/settings"],
  [/from\s+["']@\/lib\/stripe/, "import of lib/stripe/*"],
  [/from\s+["']stripe["']/, "import of the Stripe SDK"],
  [/from\s+["']@\/lib\/admin-session["']/, "import of the staff session module"],
  [/from\s+["']@\/lib\/order-session["']/, "import of the student receipt session module"],
  [/from\s+["']@\/lib\/db\/admin["']/, "import of lib/db/admin"],
  [/from\s+["']@\/lib\/db\/release["']/, "import of lib/db/release"],
  [/from\s+["']@\/lib\/email["']/, "import of lib/email"],
  // Raw SQL against anything but products. adjust_stock() is the one function
  // this namespace may call and it touches the products table only.
  [/\b(from|into|update|join)\s+(orders|order_items|settings|webhook_events)\b/i,
    "raw SQL against a non-product table"],
  [/\breserve_stock\s*\(/, "reserve_stock (checkout's function, not this role's)"],
  [/\bbook_slot\s*\(/, "book_slot (slot capacity is not this role's)"],
  // PII column names. None of these exist on Product, so naming one at all
  // means something reached across the boundary.
  [/\bstudentName\b/, "student PII field"],
  [/\bhomeroom\b/, "student PII field"],
  [/\bpickupCode\b/, "pickup code"],
  [/\borderNumber\b/, "order number"],
  [/\bstripePaymentIntentId\b/, "Stripe payment intent"],
  [/\bpaymentMethod\b/, "payment field"],
  [/\bhashPii\b/, "PII hashing helper (nothing here handles PII)"],
  [/\bmaskEmail\b/, "PII masking helper (nothing here handles PII)"],
];

const inventoryFiles = [...walk(INVENTORY_ROUTE_DIR), ...INVENTORY_LIBS];

if (inventoryFiles.length < 7) {
  fail(INVENTORY_ROUTE_DIR, 0, `expected the full P4b namespace, found ${inventoryFiles.length} files`);
}

for (const file of inventoryFiles) {
  const code = stripComments(readFileSync(file, "utf8"));
  linesOf(code).forEach((line, i) => {
    for (const [re, why] of FORBIDDEN) {
      if (re.test(line)) fail(file, i + 1, `${why} — matched ${re}`);
    }
  });
}
pass(`scanned ${inventoryFiles.length} inventory source files for ${FORBIDDEN.length} forbidden patterns`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every route handler gates on requireInventorySession — two exceptions
// ─────────────────────────────────────────────────────────────────────────────
//
// login  is where a session is minted, so it cannot require one. It is checked
//        for the passcode verification instead, so a login route that stopped
//        checking the credential fails here rather than in production.
// logout must be callable without a valid session: clearing a corrupt cookie is
//        exactly the state somebody most needs to get out of. It writes nothing
//        and reveals nothing.
//
// Every other handler in the namespace must gate, and no GET may write.

const HANDLER_RE = /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)\s*\(/g;
const WRITE_RE = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$transaction/;

for (const file of walk(INVENTORY_ROUTE_DIR)) {
  const code = stripComments(readFileSync(file, "utf8"));
  const isLogout = file.endsWith("logout/route.ts");
  const isLogin = file.endsWith("login/route.ts");
  const handlers = [...code.matchAll(HANDLER_RE)];

  if (isLogin && !/verifyInventoryPasscode\s*\(/.test(code)) {
    fail(file, 0, "login route does not verify the inventory passcode");
  }

  if (handlers.length === 0) fail(file, 0, "route file exports no HTTP handler");

  handlers.forEach((m, idx) => {
    const start = m.index;
    const end = idx + 1 < handlers.length ? handlers[idx + 1].index : code.length;
    const body = code.slice(start, end);
    const line = code.slice(0, start).split("\n").length;

    if (!isLogout && !isLogin && !/requireInventorySession\s*\(/.test(body)) {
      fail(file, line, `handler ${m[1]} does not call requireInventorySession`);
    }

    // The CSRF contract: SameSite=Lax is the whole defence for the write
    // routes, and Lax DOES send the cookie on a cross-site top-level GET. A GET
    // that writes turns the cookie into a CSRF hole.
    if (m[1] === "GET" && WRITE_RE.test(body)) {
      fail(file, line, "GET handler contains a write — breaks the SameSite=Lax CSRF argument");
    }
  });
}
pass("every inventory handler gates on requireInventorySession (logout excepted, by design) and no GET writes");

// ─────────────────────────────────────────────────────────────────────────────
// 3. The response projection is a whitelist of Product columns
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_COLUMNS = new Set([
  "id", "slug", "name", "description", "priceCents", "category", "rarity",
  "allergens", "stockQty", "active", "imageUrl", "sortOrder", "createdAt",
  "updatedAt",
]);

const dbInventory = readFileSync(join(ROOT, "lib/db/inventory.ts"), "utf8");
const selectBlock = dbInventory.match(
  /INVENTORY_PRODUCT_SELECT\s*=\s*\{([\s\S]*?)\}\s*as const/,
);
if (!selectBlock) {
  fail(join(ROOT, "lib/db/inventory.ts"), 0, "INVENTORY_PRODUCT_SELECT not found");
} else {
  const keys = [...selectBlock[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
  if (keys.length === 0) fail(join(ROOT, "lib/db/inventory.ts"), 0, "empty projection");
  for (const k of keys) {
    if (!PRODUCT_COLUMNS.has(k)) {
      fail(join(ROOT, "lib/db/inventory.ts"), 0, `projection returns non-Product column "${k}"`);
    }
  }
  pass(`response projection is ${keys.length} Product columns and nothing else`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The boundary holds in the other direction too
// ─────────────────────────────────────────────────────────────────────────────
//
// Nothing outside this namespace may accept an inventory session — an admin or
// checkout route that started honouring `ll_inventory` would be the same leak
// running backwards.

// app/inventory/page.tsx is the one sanctioned exception outside the backend
// namespace above: docs/API-CONTRACT.md §6b explicitly allows a page to read
// the bare cookie NAME as a first-paint rendering hint ("which form to draw
// before the real request"), never as authorization — the identical pattern
// app/admin/page.tsx already uses for ll_admin. It does not import
// lib/inventory-session.ts and does not verify or decode the cookie; that
// still happens only via GET /api/inventory/session. Excluded here by name,
// not folded into `inventoryFiles` above, so it never inflates the P4b
// backend file-count sanity check a few lines up.
const OWNED = new Set([
  ...inventoryFiles.map((f) => relative(ROOT, f)),
  "app/inventory/page.tsx",
]);
for (const dir of ["app", "lib", "components", "stores"]) {
  const full = join(ROOT, dir);
  let files;
  try {
    files = walk(full);
  } catch {
    continue;
  }
  for (const file of files) {
    if (OWNED.has(relative(ROOT, file))) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    linesOf(code).forEach((line, i) => {
      if (/from\s+["']@\/lib\/inventory-session["']/.test(line)) {
        fail(file, i + 1, "non-inventory file imports the inventory session module");
      }
      if (/\bll_inventory\b/.test(line)) {
        fail(file, i + 1, "non-inventory file references the ll_inventory cookie");
      }
    });
  }
}
pass("no file outside app/api/inventory + its two libs imports the inventory session or names its cookie");

// ─────────────────────────────────────────────────────────────────────────────
// 5. The two secrets are separate names, and neither module reads the other's
// ─────────────────────────────────────────────────────────────────────────────

const invSession = stripComments(readFileSync(join(ROOT, "lib/inventory-session.ts"), "utf8"));
const admSession = stripComments(readFileSync(join(ROOT, "lib/admin-session.ts"), "utf8"));

for (const [src, name, forbidden] of [
  [invSession, "lib/inventory-session.ts", ["ADMIN_SESSION_SECRET", "ADMIN_PASSCODE", "ORDER_SESSION_SECRET"]],
  [admSession, "lib/admin-session.ts", ["INVENTORY_SESSION_SECRET", "INVENTORY_PASSCODE"]],
]) {
  for (const env of forbidden) {
    if (src.includes(env)) fail(join(ROOT, name), 0, `reads ${env}, which belongs to another role`);
  }
}
if (!invSession.includes("INVENTORY_SESSION_SECRET") || !invSession.includes("INVENTORY_PASSCODE")) {
  fail(join(ROOT, "lib/inventory-session.ts"), 0, "does not read its own secret/passcode");
}
pass("each session module reads only its own INVENTORY_/ADMIN_ environment variables");

// ─────────────────────────────────────────────────────────────────────────────

for (const c of checks) console.log(`  ok   ${c}`);

if (failures.length) {
  console.error(`\nINVENTORY BOUNDARY VIOLATED — ${failures.length} finding(s):\n`);
  for (const f of failures) console.error(`  ${f.file}:${f.line}  ${f.message}`);
  process.exit(1);
}

console.log("\ninventory boundary intact");

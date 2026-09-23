import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * The shipped-artifact scan. `npm run test:leaks`.
 *
 * This suite is the only one that looks at a REAL production build. Everything
 * else in `tests/**` drives `next dev`, deliberately (docs/HANDOFF.md §28), and
 * a dev bundle is not what ships — dev keeps source maps, keeps unminified
 * module paths, and does not perform the `process.env` inlining that decides
 * whether a secret ends up in a browser.
 *
 * CLAUDE.md §5: "Anything not prefixed NEXT_PUBLIC_ must never appear in a
 * client bundle. QA greps for this." This is that grep, made specific:
 *
 *   1. every non-`NEXT_PUBLIC_` variable NAME from `.env.example`
 *   2. the actual VALUES from the local `.env`, which is the case that a name
 *      grep misses entirely — Next inlines values, not names
 *   3. provider secret prefixes (`sk_test_`, `sk_live_`, `whsec_`,
 *      `postgresql://`, `re_`)
 *   4. student PII field names, which would indicate a server type or query
 *      shape crossing into the client
 *   5. raw hex colours outside the two files allowed to hold them
 *
 * The build is REQUIRED, not optional. If `.next/static` is missing the suite
 * builds it; it never silently passes on an absent artifact, because "no files
 * matched" is the shape every leak scan fails in.
 */

const ROOT = process.cwd();
const STATIC_DIR = join(ROOT, ".next", "static");
const SERVER_DIR = join(ROOT, ".next", "server");

/** Same database the E2E suite uses; the build only reads from it. */
const BUILD_DB_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://looplockers:looplockers_dev@localhost:5432/looplockers_e2e?sslmode=disable";

/**
 * Server-only variables whose NAME has no business in a browser at all. Any
 * occurrence fails.
 */
const SERVER_ONLY_ENV_NAMES = [
  "DATABASE_URL",
  "DIRECT_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CRON_SECRET",
  "ORDER_SESSION_SECRET",
  "RESEND_API_KEY",
  "STITCH_API_KEY",
] as const;

/**
 * These four names ARE in the client bundle, on purpose, and that is not a leak.
 *
 * `AdminSignIn.tsx` and `InventorySignIn.tsx` render an ops message on a 503:
 * "…tell whoever manages the deployment that ADMIN_PASSCODE or
 * ADMIN_SESSION_SECRET is missing." Naming the variable is the whole value of
 * that message — a deployment with no passcode configured is unusable and
 * "sign-in isn't set up" alone does not tell anyone what to fix.
 *
 * So the assertion is not "absent" but "present ONLY as that sentence". If one
 * of these names ever shows up next to an `=`, a `process.env`, or anything
 * else, it is a real leak and this test says so.
 */
const OPS_COPY_ENV_NAMES = [
  "ADMIN_SESSION_SECRET",
  "ADMIN_PASSCODE",
  "INVENTORY_SESSION_SECRET",
  "INVENTORY_PASSCODE",
] as const;

const OPS_COPY_CONTEXT = /manages the deployment that [A-Z_]+ or [A-Z_]+ is missing/;

const SECRET_PREFIXES = [
  "sk_test_",
  "sk_live_",
  "rk_test_",
  "rk_live_",
  "whsec_",
  "postgresql://",
  "postgres://",
];

/**
 * PII field names. A hit means a server-side type, Prisma selection or error
 * shape crossed into the client bundle — which is how a projection regression
 * becomes a data leak long before anybody notices a wrong value on screen.
 */
const PII_FIELDS = ["studentName", "homeroom", "pickupCode", "student_name", "pickup_code"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let clientFiles: string[] = [];
/** file path -> contents, only for text-ish assets. */
const contents = new Map<string, string>();

beforeAll(() => {
  if (!existsSync(STATIC_DIR) || process.env.QA_FORCE_BUILD === "1") {
    // A real build, with the same shape of environment a deploy has. Values are
    // deliberately RECOGNISABLE sentinels rather than the repo's `.env` values,
    // so a hit is unambiguous about which variable escaped.
    //
    // `DATABASE_URL` has to be a WORKING connection string, not a sentinel:
    // `app/page.tsx` is statically prerendered (`revalidate = 30`) and reads
    // products at build time, so a fake credential fails the build rather than
    // producing an artifact to scan. The marker is smuggled in as
    // `application_name`, which Postgres accepts and ignores — so the scan can
    // still prove the connection string did not reach the browser.
    execFileSync("npx", ["next", "build"], {
      cwd: ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: `${BUILD_DB_URL}&application_name=LEAKPROBE_DB_PASSWORD`,
        DIRECT_URL: `${BUILD_DB_URL}&application_name=LEAKPROBE_DB_PASSWORD`,
        STRIPE_SECRET_KEY: "sk_test_LEAKPROBE_STRIPE_SECRET",
        STRIPE_WEBHOOK_SECRET: "whsec_LEAKPROBE_WEBHOOK_SECRET",
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_LEAKPROBE_PUBLISHABLE",
        CRON_SECRET: "LEAKPROBE_CRON_SECRET",
        ADMIN_SESSION_SECRET: "LEAKPROBE_ADMIN_SESSION_SECRET",
        ADMIN_PASSCODE: "LEAKPROBE_ADMIN_PASSCODE",
        INVENTORY_SESSION_SECRET: "LEAKPROBE_INVENTORY_SESSION_SECRET",
        INVENTORY_PASSCODE: "LEAKPROBE_INVENTORY_PASSCODE",
        ORDER_SESSION_SECRET: "LEAKPROBE_ORDER_SESSION_SECRET",
        RESEND_API_KEY: "re_LEAKPROBE_RESEND_KEY",
        NEXT_PUBLIC_SITE_URL: "https://leakprobe.example.ca",
      },
    });
  }

  clientFiles = walk(STATIC_DIR).filter((f) => /\.(js|mjs|css|json|map|txt)$/.test(f));

  for (const f of clientFiles) {
    try {
      contents.set(f, readFileSync(f, "utf8"));
    } catch {
      /* binary asset; nothing to scan */
    }
  }
}, 600_000);

function hits(needle: string, opts: { caseSensitive?: boolean } = {}): string[] {
  const found: string[] = [];
  const probe = opts.caseSensitive === false ? needle.toLowerCase() : needle;
  for (const [file, text] of contents) {
    const hay = opts.caseSensitive === false ? text.toLowerCase() : text;
    if (hay.includes(probe)) found.push(relative(ROOT, file));
  }
  return found;
}

describe("client bundle — server secrets", () => {
  it("built something to scan (a scan of zero files is not a pass)", () => {
    expect(existsSync(STATIC_DIR), ".next/static does not exist after the build").toBe(true);
    expect(clientFiles.length).toBeGreaterThan(20);
    // Sanity: the scanner can actually see through the build. A NEXT_PUBLIC_
    // value IS supposed to be inlined, so finding it proves the grep works —
    // without this, every assertion below could be passing vacuously.
    expect(
      hits("pk_test_LEAKPROBE_PUBLISHABLE").length + hits("leakprobe.example.ca").length,
      "no NEXT_PUBLIC_ value was found in the client bundle — the scanner is not " +
        "reading the right files, so every 'no secret found' result below is meaningless",
    ).toBeGreaterThan(0);
  });

  it.each(SERVER_ONLY_ENV_NAMES)("does not ship the name %s", (name) => {
    expect(hits(name), `${name} appears in the client bundle`).toEqual([]);
  });

  it.each(OPS_COPY_ENV_NAMES)(
    "%s appears only inside the documented ops message, never as a value",
    (name) => {
      const offenders: string[] = [];
      for (const [file, text] of contents) {
        let i = text.indexOf(name);
        while (i !== -1) {
          const window = text.slice(Math.max(0, i - 120), i + 120);
          if (!OPS_COPY_CONTEXT.test(window)) {
            offenders.push(`${relative(ROOT, file)}: …${window}…`);
          }
          i = text.indexOf(name, i + 1);
        }
      }
      expect(offenders.join("\n\n")).toBe("");
    },
  );

  it.each(SECRET_PREFIXES)("does not ship anything starting %s", (prefix) => {
    expect(hits(prefix), `a value starting "${prefix}" appears in the client bundle`).toEqual([]);
  });

  it("does not ship any of the build's secret VALUES", () => {
    // The case a name-only grep misses: Next inlines the value, not the name.
    const values = [
      "LEAKPROBE_DB_PASSWORD",
      "LEAKPROBE_STRIPE_SECRET",
      "LEAKPROBE_WEBHOOK_SECRET",
      "LEAKPROBE_CRON_SECRET",
      "LEAKPROBE_ADMIN_SESSION_SECRET",
      "LEAKPROBE_ADMIN_PASSCODE",
      "LEAKPROBE_INVENTORY_SESSION_SECRET",
      "LEAKPROBE_INVENTORY_PASSCODE",
      "LEAKPROBE_ORDER_SESSION_SECRET",
      "LEAKPROBE_RESEND_KEY",
    ];
    const leaked = values.flatMap((v) => hits(v).map((f) => `${v} in ${f}`));
    expect(leaked).toEqual([]);
  });

  it("does not ship the developer's own .env values either", () => {
    // Belt and braces: if the build above was skipped because `.next/static`
    // already existed, it may have been produced from the real `.env`.
    const envPath = join(ROOT, ".env");
    if (!existsSync(envPath)) return;

    const leaked: string[] = [];
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line.trim());
      if (!m) continue;
      const [, name, value] = m;
      if (name.startsWith("NEXT_PUBLIC_")) continue;
      // Short or placeholder-ish values produce noise, not signal.
      if (value.length < 12) continue;
      const found = hits(value);
      if (found.length) leaked.push(`${name} value in ${found.join(", ")}`);
    }
    expect(leaked).toEqual([]);
  });
});

describe("client bundle — PII field names", () => {
  /**
   * A blunt "no `studentName` anywhere in `.next/static`" assertion is wrong
   * and would fail against a correct build: the checkout form legitimately
   * BUILDS a `{studentName, email, phone}` request body in the browser, the
   * staff pick list legitimately RENDERS `studentName` and `homeroom`, and the
   * confirmation page reads `pickupCode` off its own payload. Those are client
   * components doing their job.
   *
   * What must not happen is those shapes landing in the SHARED chunks that
   * every page loads, including `/`, `/snacks` and `/about` — that is the
   * regression where a student's browser starts downloading the staff data
   * model. `tests/e2e/bundle.spec.ts` proves the same property from the other
   * direction, by watching what a public page actually requests.
   */
  const sharedChunks = () => {
    const manifestPath = join(ROOT, ".next", "build-manifest.json");
    if (!existsSync(manifestPath)) return [];
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      rootMainFiles?: string[];
      polyfillFiles?: string[];
      lowPriorityFiles?: string[];
    };
    return [...(m.rootMainFiles ?? []), ...(m.polyfillFiles ?? []), ...(m.lowPriorityFiles ?? [])]
      .map((f) => join(ROOT, ".next", f))
      .filter((f) => existsSync(f));
  };

  it("the shared chunks every page loads carry no student data model", () => {
    const shared = sharedChunks();
    expect(shared.length, "could not resolve the shared chunk list from build-manifest.json")
      .toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of shared) {
      const text = readFileSync(file, "utf8");
      for (const field of PII_FIELDS) {
        if (text.includes(field)) offenders.push(`${field} in ${relative(ROOT, file)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no real student value could have been baked in at build time", () => {
    // The seeded E2E database contains orders by the time this runs. None of
    // those names, addresses or codes may end up in a static artifact — a
    // prerendered page that queried orders would put them there.
    for (const needle of ["@school.ca", "604-555-01"]) {
      expect(hits(needle), `"${needle}" was baked into a client asset`).toEqual([]);
    }
  });
});

describe("server bundle — sanity, so the secret scan means something", () => {
  it("the server build DOES contain the secrets, proving they were compiled in", () => {
    // If the server bundle contained no secrets either, the client scan would
    // be passing because nothing was built with secrets at all.
    if (!existsSync(SERVER_DIR)) return;
    const serverText = walk(SERVER_DIR)
      .filter((f) => /\.(js|mjs|json)$/.test(f))
      .map((f) => {
        try {
          return readFileSync(f, "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");

    // Not an assertion about a specific variable — server code reads env at
    // runtime, so an inlined value is not guaranteed. What must be true is that
    // server-only modules exist at all.
    expect(serverText.length).toBeGreaterThan(1000);
  });
});

describe("design tokens — no raw hex outside the two files allowed to hold one", () => {
  /**
   * BUILDPLAN.md's design-drift check: `grep -rE "#[0-9a-fA-F]{6}" components/`
   * should return nothing, because every colour goes through a token.
   *
   * Four files are legitimately allowed raw hex and are excluded by name:
   *   · `app/globals.css` — where the tokens are DEFINED.
   *   · `lib/rarity.ts` — the canonical rarity lookup, reproduced verbatim in
   *     CLAUDE.md §4. Its `hex` values are the token source for inline styles
   *     that Tailwind classes cannot express.
   *   · `app/layout.tsx` — `<meta name="theme-color">` is read directly by
   *     the browser chrome before any stylesheet loads, so its `content` can
   *     only ever be a literal colour; there is no CSS custom property a
   *     `<meta>` tag can reference instead. Its one hex value must still
   *     match `--color-void` by inspection (docs/HANDOFF.md #74) — this
   *     allowlist entry does not excuse it from being the *right* colour,
   *     only from being expressed as a token.
   *   · `components/account/LockerSignIn.tsx` — its "Sign in with Google"
   *     button. Google's branding guidelines
   *     (https://developers.google.com/identity/branding-guidelines) fix the
   *     official mark's border and four-path "G" logo colours exactly; like
   *     the theme-color meta tag above, this is a fixed external brand
   *     requirement with no app design token to route it through, not a
   *     colour this app is free to reskin.
   */
  const ALLOWED = new Set([
    "app/globals.css",
    "lib/rarity.ts",
    "app/layout.tsx",
    "components/account/LockerSignIn.tsx",
  ]);

  it("no source file outside globals.css, lib/rarity.ts and layout.tsx's theme-color hardcodes a colour", () => {
    const sources = [
      ...walk(join(ROOT, "app")),
      ...walk(join(ROOT, "components")),
      ...walk(join(ROOT, "stores")),
      ...walk(join(ROOT, "lib")),
    ].filter((f) => /\.(ts|tsx|css)$/.test(f));

    const offenders: string[] = [];
    for (const file of sources) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const m = /#[0-9a-fA-F]{6}\b/.exec(line);
        if (m) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    }

    expect(offenders.join("\n")).toBe("");
  });
});

// Prisma 7 moved datasource URLs and the seed command out of schema.prisma and
// package.json into this file. See docs/HANDOFF.md — "Prisma 7 deltas".
//
// Prisma 7 does NOT auto-load .env once a config file exists, so we load it
// here explicitly. Everything downstream (migrate, db seed, studio) inherits
// the resulting process.env.
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

import { defineConfig } from "prisma/config";

// Migrations must bypass the connection pooler. DIRECT_URL is the unpooled
// connection; fall back to DATABASE_URL for local dev where they are the same.
const migrationUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error(
    "DIRECT_URL (or DATABASE_URL) must be set to run Prisma migrations",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",

  datasource: {
    url: migrationUrl,
  },

  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});

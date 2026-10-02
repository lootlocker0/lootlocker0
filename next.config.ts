import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev`/`next build` otherwise appends an AI-agent-rules block to
  // CLAUDE.md on every run. CLAUDE.md is manager-only (its own ownership
  // map says so) and this file is the actual orchestration contract every
  // agent reads first — it should never be silently rewritten by tooling.
  agentRules: false,

  images: {
    // next/image refuses to load an external host that isn't explicitly
    // allow-listed here — without this, every product photo uploaded via
    // lib/blob.ts's Vercel Blob storage 404s silently and ProductImage.tsx's
    // onError fallback renders the rarity-placeholder icon instead. The
    // store-specific subdomain is unique per Blob store, hence the wildcard;
    // this is Vercel's own documented pattern for next/image + Blob.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.public.blob.vercel-storage.com",
      },
    ],
  },
};

export default nextConfig;

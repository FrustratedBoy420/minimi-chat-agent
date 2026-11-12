import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM + data files that must be loaded from node_modules at runtime,
  // not bundled by Next.js.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Lets the live smoke test run its own dev server next to a developer's `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;

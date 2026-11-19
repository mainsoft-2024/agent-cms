import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pglite (local and CI database) ships WASM; keep it out of the server bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Starter pages read by lib/seed.ts on first start.
  outputFileTracingIncludes: { "/**": ["./content/**/*.md"] },
  turbopack: {
    // The library is linked from the repository root (`file:../..`).
    root: new URL("../..", import.meta.url).pathname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      // `/docs/install.md` → the markdown of one page (for agents and "Copy as markdown").
      { source: "/docs/:slug.md", destination: "/md/docs/:slug" },
      { source: "/ko/docs/:slug.md", destination: "/md/docs-ko/:slug" },
    ];
  },
};

export default nextConfig;

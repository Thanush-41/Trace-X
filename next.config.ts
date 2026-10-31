import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // libSQL ships a native binding; keep it out of the server bundle.
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Bundled sample datasets are read from disk at runtime.
  outputFileTracingIncludes: {
    "/api/samples": ["./data/samples/**/*"],
    "/api/samples/load": ["./data/samples/**/*"],
    "/api/evaluate": ["./data/samples/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** Monorepo: trace files from `orbitalpha-trading/` root, not a parent lockfile. */
  outputFileTracingRoot: path.join(here, ".."),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8787/api/:path*",
      },
      {
        source: "/health",
        destination: "http://127.0.0.1:8787/health",
      },
    ];
  },
};

export default nextConfig;

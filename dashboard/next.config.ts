import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { resolveDashboardApiUpstreamBase } from "./lib/api-upstream-base";

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** Monorepo: trace files from `orbitalpha-trading/` root, not a parent lockfile. */
  outputFileTracingRoot: path.join(here, ".."),
  /**
   * `/api/*` 는 `app/api/[...path]/route.ts` 가 ORBITALPHA_TRADING_API_ORIGIN(기본 127.0.0.1:8787)으로 프록시.
   * rewrites 만으로는 정적 배포/앞단 Nginx에서 404가 나기 쉬우므로 Route Handler를 단일 경로로 사용.
   */
  async rewrites() {
    const api = resolveDashboardApiUpstreamBase();
    return [{ source: "/health", destination: `${api}/health` }];
  },
};

export default nextConfig;

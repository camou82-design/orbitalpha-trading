/**
 * Fastify API 루트 (경로 접두사 `/api/...` 없음). `.../api` 로 끝나면 이중 `/api/api` 가 되므로 제거한다.
 */
export function resolveDashboardApiUpstreamBase(): string {
  const raw =
    process.env.ORBITALPHA_TRADING_API_ORIGIN?.trim() ||
    process.env.ORBITALPHA_TRADING_INTERNAL_API_URL?.trim() ||
    process.env.ORBITALPHA_TRADING_DASHBOARD_API_PROXY?.trim() ||
    "";
  let base = raw.replace(/\/$/, "");
  if (!base) base = "http://127.0.0.1:8787";
  base = base.replace(/\/api$/i, "");
  return base;
}

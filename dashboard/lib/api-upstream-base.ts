/**
 * Fastify upstream: bare origin only (no trailing slash). Trailing path segment `api` is stripped so the dashboard proxy can append `/api/...` once.
 */
export function resolveDashboardApiUpstreamBase(): string {
  const raw =
    process.env.ORBITALPHA_TRADING_API_ORIGIN?.trim() ||
    process.env.ORBITALPHA_TRADING_INTERNAL_API_URL?.trim() ||
    process.env.ORBITALPHA_TRADING_DASHBOARD_API_PROXY?.trim() ||
    "";
  let base = raw.replace(/\/$/, "");
  if (!base) base = "http://127.0.0.1:8787";
  while (/\/api$/i.test(base)) {
    base = base.replace(/\/api$/i, "");
  }
  return base;
}

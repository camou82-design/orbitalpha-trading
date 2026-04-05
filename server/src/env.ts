import { z } from "zod";
import { DEFAULT_TRADING_COMPANY_ID, DEFAULT_TRADING_SERVICE_ID } from "@orbitalpha/shared";

/**
 * 환경변수는 `ORBITALPHA_TRADING_*` 네임스페이스만 사용한다 (shopping / homepage / jj-admin 과 분리).
 * 구버전 `ORBITALPHA_COMPANY_ID` 등은 임시 호환용으로만 읽는다.
 */
const envSchema = z.object({
  companyId: z.string().min(1).default(DEFAULT_TRADING_COMPANY_ID),
  serviceId: z.string().min(1).default(DEFAULT_TRADING_SERVICE_ID),
  /**
   * 거래량 임계 fallback — `VOLUME_THRESHOLD_BY_MARKET`에 없는 마켓만 적용.
   */
  volumeThresholdMain: z.coerce.number().positive().default(1.15),
  port: z.coerce.number().int().positive().default(8787),
  /** 서버 전용 — 대시보드 번들에 넣지 말 것 */
  upbitAccessKey: z.string().optional(),
  upbitSecretKey: z.string().optional(),
  tradingMode: z.enum(["paper", "live"]).default("paper"),
  liveOrderConfirm: z.boolean().default(false),
  tradingLoginId: z.string().min(1).default("admin"),
  tradingLoginPassword: z.string().min(1).default("955104"),
  dashboardOrigin: z.string().url().default("http://localhost:3010"),
  /**
   * Nginx 등 리버스 프록시 뒤에서 `X-Forwarded-Proto` 등을 신뢰한다.
   * HTTPS 배포 시 true 권장.
   */
  trustProxy: z.coerce.boolean().default(false),
  /**
   * 세션 쿠키에 `Secure` 강제 (Next→내부 8787 구간에서 proto 헤더가 끊길 때 HTTPS에 필요).
   * 프로덕션 HTTPS에서는 1 권장.
   */
  sessionCookieSecure: z.coerce.boolean().default(false),
  /** 예: `.orbitalpha.kr` — 미설정 시 호스트 기본(현재 도메인만). 잘못 쓰면 쿠키가 안 잡힘. */
  sessionCookieDomain: z.string().min(1).optional(),
  /** 콤마 구분 마켓 코드, 예: KRW-TRX — 해당 종목은 스캔·WS 구독에서 제외 */
  excludedMarkets: z.array(z.string()).default([]),
  debugLogEnabled: z.boolean().default(false),
  futuresPaperApiUrl: z.string().optional(),
  futuresPaperApiSecret: z.string().optional(),
});

export type Env = z.infer<typeof envSchema> & { corsAllowlist: string[] };

function first(
  ...vals: (string | undefined)[]
): string | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

export function loadEnv(): Env {
  const companyId = first(
    process.env.ORBITALPHA_TRADING_COMPANY_ID,
    process.env.ORBITALPHA_COMPANY_ID,
  );
  const serviceId = first(
    process.env.ORBITALPHA_TRADING_SERVICE_ID,
    process.env.ORBITALPHA_SERVICE_ID,
  );
  const port = first(process.env.ORBITALPHA_TRADING_PORT);
  const upbitAccessKey = first(
    process.env.UPBIT_ACCESS_KEY,
  );
  const upbitSecretKey = first(
    process.env.UPBIT_SECRET_KEY,
  );
  const dashboardOrigin = first(
    process.env.ORBITALPHA_TRADING_DASHBOARD_ORIGIN,
    process.env.DASHBOARD_ORIGIN,
  );
  const tradingMode = first(
    process.env.ORBITALPHA_TRADING_MODE,
    process.env.TRADING_MODE,
  );
  const liveOrderConfirmRaw = first(
    process.env.ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM,
    process.env.LIVE_ORDER_CONFIRM,
  );
  const tradingLoginId = first(
    process.env.TRADING_LOGIN_ID,
    process.env.ORBITALPHA_TRADING_LOGIN_ID,
    process.env.TRADING_ADMIN_ID,
    process.env.ORBITALPHA_TRADING_ADMIN_ID,
  );
  const tradingLoginPassword = first(
    process.env.TRADING_LOGIN_PASSWORD,
    process.env.ORBITALPHA_TRADING_LOGIN_PASSWORD,
    process.env.TRADING_ADMIN_PASSWORD,
    process.env.ORBITALPHA_TRADING_ADMIN_PASSWORD,
  );

  const excludeMarketsRaw = first(process.env.ORBITALPHA_TRADING_EXCLUDE_MARKETS);
  const excludedMarkets = (excludeMarketsRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const volumeThresholdMain = first(
    process.env.ORBITALPHA_TRADING_VOLUME_THRESHOLD_MAIN,
    process.env.ORBITALPHA_TRADING_VOLUME_THRESHOLD,
  );
  const debugLogEnabledRaw = first(process.env.DEBUG_LOG_ENABLED, process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED);
  const trustProxyRaw = first(process.env.ORBITALPHA_TRADING_TRUST_PROXY);
  const sessionCookieSecureRaw = first(process.env.ORBITALPHA_TRADING_SESSION_COOKIE_SECURE);
  const sessionCookieDomain = first(process.env.ORBITALPHA_TRADING_SESSION_COOKIE_DOMAIN);
  const corsOriginsRaw = first(process.env.ORBITALPHA_TRADING_CORS_ORIGINS);
  const corsOrigins = (corsOriginsRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const parsed = envSchema.safeParse({
    companyId: companyId ?? DEFAULT_TRADING_COMPANY_ID,
    serviceId: serviceId ?? DEFAULT_TRADING_SERVICE_ID,
    volumeThresholdMain: volumeThresholdMain ?? 1.15,
    port: port ?? 8787,
    upbitAccessKey,
    upbitSecretKey,
    tradingMode: tradingMode ?? "paper",
    liveOrderConfirm: (liveOrderConfirmRaw ?? "false").toLowerCase() === "true",
    tradingLoginId: tradingLoginId ?? "admin",
    tradingLoginPassword: tradingLoginPassword ?? "955104",
    dashboardOrigin: dashboardOrigin ?? "http://localhost:3010",
    trustProxy: (trustProxyRaw ?? "false").toLowerCase() === "true",
    sessionCookieSecure: (sessionCookieSecureRaw ?? "false").toLowerCase() === "true",
    sessionCookieDomain: sessionCookieDomain?.trim() || undefined,
    excludedMarkets,
    debugLogEnabled: (debugLogEnabledRaw ?? "false").toLowerCase() === "true",
    futuresPaperApiUrl: first(process.env.FUTURES_PAPER_API_URL, process.env.ORBITALPHA_FUTURES_PAPER_API_URL),
    futuresPaperApiSecret: first(process.env.FUTURES_PAPER_API_SECRET, process.env.ORBITALPHA_FUTURES_PAPER_API_SECRET),
  });

  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid ORBITALPHA_TRADING_* environment variables");
  }

  const e = parsed.data;
  const corsAllowlist =
    corsOrigins.length > 0
      ? corsOrigins.map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          throw new Error(`Invalid ORBITALPHA_TRADING_CORS_ORIGINS entry: ${o}`);
        }
      })
      : [e.dashboardOrigin];
  const hasKey = Boolean(e.upbitAccessKey) || Boolean(e.upbitSecretKey);
  if (hasKey && (!e.upbitAccessKey || !e.upbitSecretKey)) {
    throw new Error(
      "ORBITALPHA_TRADING_UPBIT_ACCESS_KEY and ORBITALPHA_TRADING_UPBIT_SECRET_KEY must both be set or both omitted",
    );
  }
  return { ...e, corsAllowlist };
}


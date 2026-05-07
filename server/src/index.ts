import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import {
  THIS_REPO_SERVICE_LINE,
  TRADING_PRODUCT_NAMESPACE,
  mvpSignalPayloadV2Schema,
} from "@orbitalpha/shared";
import { loadEnv } from "./env.js";
import { getMonitorInstanceSnapshot } from "./monitor-instance-meta.js";
import { acquireSignalServerProcessLock } from "./monitor-process-lock.js";
import { startSignalMonitor } from "./signal-monitor.js";
import { readRecentLogs } from "./log-store.js";
import { resolveWatchMarkets } from "./upbit-public.js";
import { VOLUME_THRESHOLD_BY_MARKET } from "./volume-thresholds.js";
import { createTradeControl } from "./trade-control.js";
import { createLiveDataStrategy } from "./live-strategy.js";
import { createPumpScanner } from "./pump-scanner.js";
import { assertOrderBuyAllowed, createMarketStateFilter } from "./market-state-filter.js";
import { createOperationalLogger } from "./operational-logs.js";
import { readReplayRange } from "./replay-store.js";
import { createPaperTradingEngine } from "./paper-trading.js";
import { readLiveStrategyTradesRecent } from "./recent-strategy-trades.js";
import { liveExecutionStateRuntimePath, runtimeRoot, surgeCandidatesRuntimePath } from "./runtime-paths.js";

const cwd = process.cwd();
const runtimeDir = runtimeRoot();
const surgeCandidatesPath = surgeCandidatesRuntimePath();
const liveExecutionStatePath = liveExecutionStateRuntimePath();
const envRoots = [cwd, path.dirname(cwd)];
const envFiles = [".env", ".env.local"];
const envLoadMeta: Array<{ file: string; exists: boolean; loaded: boolean; parsed_keys: string[] }> = [];
for (const root of envRoots) {
  for (const file of envFiles) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) {
      const r = dotenv.config({ path: full, override: true });
      envLoadMeta.push({
        file: full,
        exists: true,
        loaded: !Boolean(r.error),
        parsed_keys: Object.keys(r.parsed ?? {}),
      });
    } else {
      envLoadMeta.push({
        file: full,
        exists: false,
        loaded: false,
        parsed_keys: [],
      });
    }
  }
}

function maskKey(value?: string): string | null {
  if (!value) return null;
  const head = value.slice(0, 4);
  const tail = value.slice(-2);
  return `${head}***${tail} (len:${value.length})`;
}

function keyFingerprint(value?: string): string | null {
  if (!value) return null;
  const h = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return h.slice(0, 12);
}

const API_CACHE_MAX_ARRAY_ITEMS = Math.max(50, Number(process.env.API_CACHE_MAX_ARRAY_ITEMS ?? 150));
const API_CACHE_MAX_MAP_ITEMS = Math.max(50, Number(process.env.API_CACHE_MAX_MAP_ITEMS ?? 150));
const API_CACHE_MAX_OBJECT_KEYS = Math.max(50, Number(process.env.API_CACHE_MAX_OBJECT_KEYS ?? 200));

function trimCacheSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, API_CACHE_MAX_ARRAY_ITEMS).map((v) => trimCacheSnapshot(v, seen));
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of value.entries()) {
      if (n >= API_CACHE_MAX_MAP_ITEMS) break;
      out[String(k)] = trimCacheSnapshot(v, seen);
      n += 1;
    }
    return out;
  }
  if (typeof value === "object") {
    try {
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) return null;
      seen.add(obj);
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (n >= API_CACHE_MAX_OBJECT_KEYS) break;
        out[k] = trimCacheSnapshot(v, seen);
        n += 1;
      }
      return out;
    } catch {
      return null;
    }
  }
  return value;
}

function serializeBoundedCacheBody(value: unknown): string {
  return JSON.stringify(trimCacheSnapshot(value));
}

function parseBoundedCacheBody<T>(json: string): T {
  return JSON.parse(json) as T;
}

let cachedEgressIp: { ip: string; atMs: number } | null = null;
async function getEgressPublicIp(): Promise<string | null> {
  const now = Date.now();
  if (cachedEgressIp && now - cachedEgressIp.atMs < 60_000) return cachedEgressIp.ip;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch("https://api.ipify.org?format=json", {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    const j = (await r.json()) as { ip?: string };
    const ip = typeof j.ip === "string" ? j.ip : null;
    if (ip) cachedEgressIp = { ip, atMs: now };
    return ip;
  } catch {
    return null;
  }
}

function isEntrySignalAllowed(payload: unknown, activeMonitorInstanceId?: string): { ok: boolean; reason?: string } {
  const p = mvpSignalPayloadV2Schema.safeParse(payload);
  if (!p.success) return { ok: false, reason: "latest signal payload is invalid" };
  if (activeMonitorInstanceId && p.data.monitor_instance_id !== activeMonitorInstanceId) {
    return { ok: false, reason: "signal monitor instance mismatch" };
  }
  const signalType = (p.data.signal_type ?? "").toUpperCase();
  if (signalType === "LOW") return { ok: false, reason: "LOW signal strength blocks entry" };
  const volume = p.data.filters.find((f) => f.id === "volume_increase");
  if (!volume?.passed) return { ok: false, reason: "volume_increase filter not passed" };
  return { ok: true };
}
const TRADE_STATUS_CACHE_TTL_MS = 2500;
const TRADE_STATUS_SLOW_FALLBACK_MS = 3000;
let tradeStatusCache: { at: number; body: any } | null = null;
let tradeStatusInFlight: Promise<any> | null = null;
let tradeStatusInFlightStartedAt: number | null = null;

async function main() {
  const env = loadEnv();

  const procLock = acquireSignalServerProcessLock();
  if (!procLock) {
    console.error(
      "[orbitalpha-trading] 다른 signal 서버 프로세스가 이미 실행 중인 것으로 보입니다 (락 파일). 종료 후 다시 시도하거나 ORBITALPHA_TRADING_DISABLE_MONITOR_LOCK=1 로 우회하세요.",
    );
    process.exit(1);
  }

  const app = Fastify({ logger: true, trustProxy: env.trustProxy });
  const opLog = createOperationalLogger({ debugEnabled: env.debugLogEnabled });

  // Engine split prep (shadow only): create runtime file paths and initial shapes.
  // No order authority is delegated here.
  try {
    if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
    if (!fs.existsSync(surgeCandidatesPath)) {
      fs.writeFileSync(
        surgeCandidatesPath,
        JSON.stringify(
          {
            kind: "surge_candidates_shadow",
            updated_at: null,
            items: [],
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    if (!fs.existsSync(liveExecutionStatePath)) {
      fs.writeFileSync(
        liveExecutionStatePath,
        JSON.stringify(
          {
            kind: "live_execution_state_shadow",
            updated_at: null,
            order_authority: "live_execution_only",
            shadow_mode: true,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    app.log.info(
      {
        tag: "SURGE_SCANNER_WORKER_SHADOW_READY",
        worker: "engine2_surge_scanner",
        order_authority: "none",
        path: surgeCandidatesPath.replace(/\\/g, "/"),
        runtime_root: runtimeDir.replace(/\\/g, "/"),
      },
      "SURGE_SCANNER_WORKER_SHADOW_READY",
    );
    app.log.info({ tag: "LIVE_EXECUTION_WORKER_SHADOW_READY", path: liveExecutionStatePath.replace(/\\/g, "/") }, "LIVE_EXECUTION_WORKER_SHADOW_READY");
  } catch (e) {
    app.log.warn({ tag: "RUNTIME_FILE_INIT_FAILED", err: String(e) }, "runtime file init failed");
  }
  const SESSION_COOKIE = "orbitalpha_trading_session";
  const sessions = new Map<string, { user_id: string; created_at: string }>();

  // Login rate limiting: IP -> { attempts: number, lastAttempt: number }
  const loginAttempts = new Map<string, { count: number; lastMs: number }>();
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS = 15 * 60 * 1000; // 15 mins

  const readSessionToken = (cookieHeader?: string) => {
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(";").map((v) => v.trim());
    const hit = parts.find((v) => v.startsWith(`${SESSION_COOKIE}=`));
    if (!hit) return null;
    const eq = hit.indexOf("=");
    if (eq === -1) return null;
    return decodeURIComponent(hit.slice(eq + 1));
  };

  const getSession = (cookieHeader?: string) => {
    const token = readSessionToken(cookieHeader);
    if (!token) return null;
    return sessions.get(token) ?? null;
  };

  const sessionCookieAttrs = (req: FastifyRequest) => {
    const proto = String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]!
      .trim()
      .toLowerCase();
    const secure = env.sessionCookieSecure || proto === "https";
    return { secure, domain: env.sessionCookieDomain };
  };

  const setSessionCookie = (
    reply: { header: (name: string, value: string) => void },
    req: FastifyRequest,
    token: string,
  ) => {
    const { secure, domain } = sessionCookieAttrs(req);
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=43200",
    ];
    if (secure) parts.push("Secure");
    if (domain) parts.push(`Domain=${domain}`);
    reply.header("set-cookie", parts.join("; "));
  };

  const clearSessionCookie = (reply: { header: (name: string, value: string) => void }, req: FastifyRequest) => {
    const { secure, domain } = sessionCookieAttrs(req);
    const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (secure) parts.push("Secure");
    if (domain) parts.push(`Domain=${domain}`);
    reply.header("set-cookie", parts.join("; "));
  };

  const protectedPrefixes = [
    "/api/v1/trade/",
    "/api/v1/trades/",
    "/api/v1/account/",
    "/api/v1/orders/",
    "/api/v1/replay/",
    "/api/v1/debug/",
    "/api/v1/paper/",
    "/api/status",
    "/status",
  ];
  const authAllowList = new Set([
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
    "/api/v1/auth/session",
    "/api/v1/auth/me",
    "/api/session",
    "/api/health",
    "/api/logout",
    "/session",
    "/health",
    "/logout",
  ]);

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0] ?? req.url;
    if (authAllowList.has(url)) return;
    if (!protectedPrefixes.some((p) => url.startsWith(p))) return;
    const s = getSession(req.headers.cookie);
    if (!s) {
      req.log.warn(
        { route: url, account_sync_failure_code: "auth_cookie_missing", msg: "no session for protected API" },
        "protected_api_unauthorized",
      );
      reply.code(401);
      return reply.send({
        ok: false,
        error: "Unauthorized",
        account_sync_failure_code: "auth_cookie_missing",
        account_sync_failure_message: "Session cookie missing or not sent (protected trade API)",
      });
    }
  });
  app.log.info(
    {
      env_root: cwd,
      env_files: envLoadMeta,
      process_env_access_key_present: Boolean(process.env.UPBIT_ACCESS_KEY),
      process_env_secret_key_present: Boolean(process.env.UPBIT_SECRET_KEY),
      upbit_access_key_present: Boolean(env.upbitAccessKey),
      upbit_access_key_masked: maskKey(env.upbitAccessKey),
      upbit_access_key_fingerprint: keyFingerprint(env.upbitAccessKey),
      upbit_secret_key_present: Boolean(env.upbitSecretKey),
      trading_mode: env.tradingMode,
      live_order_confirm: env.liveOrderConfirm,
    },
    "Upbit env check",
  );
  void (async () => {
    const ip = await getEgressPublicIp();
    app.log.info({ egress_public_ip: ip }, "Egress public IP (server process)");
  })();

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, env.corsAllowlist.includes(origin));
    },
    credentials: true,
  });
  app.log.info(
    {
      trust_proxy: env.trustProxy,
      session_cookie_secure: env.sessionCookieSecure,
      cors_allowlist: env.corsAllowlist,
    },
    "session_cookie_and_cors",
  );

  const monitor = startSignalMonitor(env);
  const liveScannerRuntimeModeRaw = String(process.env.LIVE_SCANNER_RUNTIME_MODE ?? "legacy").toLowerCase().trim();
  const liveScannerRuntimeMode =
    liveScannerRuntimeModeRaw === "legacy" || liveScannerRuntimeModeRaw === "shadow" || liveScannerRuntimeModeRaw === "external"
      ? liveScannerRuntimeModeRaw
      : "legacy";
  const engine1PumpScannerDisabled = String(process.env.ENGINE1_PUMP_SCANNER_DISABLED ?? "false").toLowerCase() === "true";
  const engine1PumpScannerIntervalRaw = String(process.env.ENGINE1_PUMP_SCANNER_INTERVAL_MS ?? "").trim();
  const engine1PumpScannerIntervalParsed =
    engine1PumpScannerIntervalRaw.length > 0 ? Number(engine1PumpScannerIntervalRaw) : Number.NaN;
  const hasEngine1IntervalEnv =
    engine1PumpScannerIntervalRaw.length > 0 && Number.isFinite(engine1PumpScannerIntervalParsed) && engine1PumpScannerIntervalParsed > 0;
  const engine1PumpScannerIntervalMsFromEnv = hasEngine1IntervalEnv ? Math.max(1_000, engine1PumpScannerIntervalParsed) : null;
  const marketFilter = createMarketStateFilter({
    companyId: env.companyId,
    serviceId: env.serviceId,
    readLogs: (limit: number) => readRecentLogs(env.companyId, env.serviceId, limit),
    onEvent: (row) => opLog.event(row),
  });
  const trade = createTradeControl(env, {
    onEvent: (row) => opLog.event(row),
    assertBuyGate: async (ctx) => {
      let snap;
      try {
        snap = marketFilter.status() || await marketFilter.evaluate();
      } catch (e) {
        snap = marketFilter.status();
        if (!snap) throw new Error(`market_filter_failed_and_no_fallback: ${String(e)}`);
        app.log.warn({ tag: "MARKET_FILTER_FALLBACK_USED", err: String(e) }, "market filter failed, using fallback status");
      }
      const r = assertOrderBuyAllowed(snap, {
        kind: ctx.isAdditionalBuy ? "add_to_position" : "new_entry",
        signalPayload: ctx.signalPayload,
      });
      const btcState = snap.market_state === "risk_on" ? "strong" : snap.market_state === "neutral" ? "neutral" : "weak";
      app.log.info(
        {
          gate_kind: ctx.isAdditionalBuy ? "add_to_position" : "new_entry",
          tag: "DEBUG_MARKET_FILTER_RESULT",
          symbol: ctx.market,
          btc_state: btcState,
          allow: r.ok,
          size_scale: r.size_scale,
          blocked_reason: r.blocked_reason,
        },
        "DEBUG_MARKET_FILTER_RESULT",
      );
      if (!r.ok) throw new Error(`order_entry_gate: ${r.blocked_reason}`);
    },
  });
  let pumpScannerRef: ReturnType<typeof createPumpScanner> | null = null;
  const strategy = createLiveDataStrategy({
    companyId: env.companyId,
    serviceId: env.serviceId,
    readLogs: (limit: number) => readRecentLogs(env.companyId, env.serviceId, limit),
    getScannerSignals: () => (pumpScannerRef ? pumpScannerRef.signalFeed() : []),
    trade,
    marketState: marketFilter,
    onEvent: (row) => opLog.event(row),
  });
  await strategy.init();
  app.log.info({ tag: "DEBUG_LIVE_LOOP_STARTED", stage: "strategy_init_done" }, "DEBUG_LIVE_LOOP_STARTED");
  const pumpScanner = createPumpScanner(() => Object.keys((strategy.status() as any).open_positions ?? {}), {
    onEvent: (row) => opLog.event(row),
  });
  pumpScannerRef = pumpScanner;
  const paper = createPaperTradingEngine({
    companyId: env.companyId,
    serviceId: env.serviceId,
    getScannerSignals: () => pumpScanner.signalFeed(),
  });
  await paper.init();
  trade.setRecoveryReady(true);
  let lastStrategyTickAt: string | null = null;
  let lastScannerTickAt: string | null = null;
  let lastMarketStateTickAt: string | null = null;
  app.log.info({ tag: "DEBUG_LIVE_LOOP_STARTED", interval_ms: 30_000 }, "DEBUG_LIVE_LOOP_STARTED");
  const strategyTimer = setInterval(() => {
    lastStrategyTickAt = new Date().toISOString();
    app.log.info({ tag: "DEBUG_LIVE_LOOP_TICK", ts: lastStrategyTickAt }, "DEBUG_LIVE_LOOP_TICK");
    void strategy.tick().catch((e) => app.log.error({ err: String(e) }, "strategy_tick_failed"));
  }, 30_000);
  const scannerIntervalMsResolved = (() => {
    if (engine1PumpScannerDisabled) return null;
    const baseInterval = engine1PumpScannerIntervalMsFromEnv ?? pumpScanner.intervalMs;
    if (liveScannerRuntimeMode === "external") {
      const externalFloor = 10 * 60_000;
      return Math.max(externalFloor, baseInterval);
    }
    return baseInterval;
  })();
  const scannerIntervalMs = scannerIntervalMsResolved;
  const scannerIntervalSource = hasEngine1IntervalEnv ? "env" : "pumpScanner.intervalMs";
  const scannerTimer =
    scannerIntervalMs === null
      ? null
      : setInterval(() => {
          lastScannerTickAt = new Date().toISOString();
          void pumpScanner.tick().catch((e) => app.log.error({ err: String(e) }, "pump_scanner_tick_failed"));
        }, scannerIntervalMs);
  app.log.info(
    {
      tag: "ENGINE1_SCANNER_RUNTIME_MODE",
      mode: liveScannerRuntimeMode,
      engine1_scanner_disabled: engine1PumpScannerDisabled,
      engine1_scanner_interval_ms: scannerIntervalMs,
      interval_source: scannerIntervalSource,
      order_input_source: "legacy",
    },
    "ENGINE1_SCANNER_RUNTIME_MODE",
  );
  let marketStateTickInFlight = false;
  let marketStateFailCount = 0;
  let nextMarketStateEvalAt = 0;
  const marketStateTimer = setInterval(() => {
    const now = Date.now();
    if (marketStateTickInFlight || now < nextMarketStateEvalAt) return;

    lastMarketStateTickAt = new Date().toISOString();
    marketStateTickInFlight = true;
    void marketFilter.evaluate()
      .then(() => {
        marketStateFailCount = 0;
        nextMarketStateEvalAt = 0;
      })
      .catch((e) => {
        marketStateFailCount++;
        const backoffMs = Math.min(300_000, 15_000 * Math.pow(2, Math.min(marketStateFailCount - 1, 5)));
        nextMarketStateEvalAt = Date.now() + backoffMs;
        app.log.error({ err: String(e), failCount: marketStateFailCount, nextEvalInMs: backoffMs }, "market_state_tick_failed_storm_prevented");
      })
      .finally(() => {
        marketStateTickInFlight = false;
      });
  }, 15_000);
  const snapshotTimer = setInterval(() => {
    void (async () => {
      const ts = new Date().toISOString();
      const t = await trade.status();
      const s = strategy.status();
      const m = marketFilter.status() ?? (await marketFilter.evaluate());
      const rows = await readRecentLogs(env.companyId, env.serviceId, 120);
      const oneMinAgo = Date.now() - 60_000;
      const signalLastMin = rows.filter((r) => r.kind === "signal" && Date.parse(r.ts) >= oneMinAgo);
      const failToday = rows.filter((r) => r.kind === "upbit" && /error|failed/i.test(r.message)).length;
      await opLog.snapshot({
        timestamp: ts,
        market_state: m.market_state,
        auto_trade_enabled: Boolean(t.auto_trade_enabled),
        safety_guard_state: (s as any).safety_guard_state ?? (t.auto_trade_enabled ? "active" : "idle"),
        total_asset_krw: Number(t.krw_available ?? 0),
        balance_krw: Number(t.krw_available ?? 0),
        available_krw_for_strategy: Math.max(0, Number(t.krw_available ?? 0) - Number(s.strategy_invested_krw ?? 0)),
        invested_krw_for_strategy: Number(s.strategy_invested_krw ?? 0),
        daily_pnl_net: Number(s.strategy_pnl_krw ?? 0),
        open_positions_count: Object.values((s as any).open_positions ?? {}).filter((p: any) => Number(p.qty ?? 0) > 0).length,
        open_markets: Object.entries((s as any).open_positions ?? {}).filter(([, p]: any) => Number(p.qty ?? 0) > 0).map(([mk]) => mk).slice(0, 4),
        signal_count_last_min: signalLastMin.length,
        order_fail_count_today: failToday,
        consecutive_losses: Number((s as any).consecutive_losses ?? 0),
        top_signal_markets: signalLastMin.slice(0, 3).map((r) => ((r.payload as any)?.market ?? "UNK")),
        api_connected: Boolean(t.api_connected),
      });
      await opLog.maintainRetention();
    })().catch((e) => app.log.error({ err: String(e) }, "snapshot_tick_failed"));
  }, 60_000);
  const paperTimer = setInterval(() => {
    void paper.tick().catch((e) => app.log.error({ err: String(e) }, "paper_tick_failed"));
  }, 15_000);
  if (scannerTimer && liveScannerRuntimeMode !== "external") {
    lastScannerTickAt = new Date().toISOString();
    void pumpScanner.tick().catch((e) => app.log.error({ err: String(e) }, "pump_scanner_tick_failed"));
  }
  lastMarketStateTickAt = new Date().toISOString();
  void marketFilter.evaluate().catch((e) => app.log.error({ err: String(e) }, "market_state_tick_failed"));
  await opLog.event({
    timestamp: new Date().toISOString(),
    event_type: "server_started",
    market: null,
    strategy_type: null,
    market_state: null,
    side: null,
    reason: "boot",
    balance_krw: null,
    position_qty: null,
    avg_buy_price: null,
    current_price: null,
    pnl_net: null,
    pnl_net_pct: null,
    note: "server start",
  });

  const monitorSnap = () => {
    const m = getMonitorInstanceSnapshot();
    return {
      monitor_instance_id: m.monitor_instance_id,
      monitor_started_at: m.monitor_started_at,
      process_pid: process.pid,
      last_strategy_tick_at: lastStrategyTickAt,
      last_scanner_tick_at: lastScannerTickAt,
      last_market_state_tick_at: lastMarketStateTickAt,
    };
  };

  const evaluateOrderGuard = async (side: "buy" | "sell", market?: string) => {
    const st = await trade.status();
    const ss = strategy.status() as any;
    if (!st.api_connected) return { ok: false, code: "manual_order_rejected_api", reason: "api disconnected" };
    if (!st.live_enabled) return { ok: false, code: "manual_order_rejected_guard", reason: "live disabled" };
    if (!st.recovery_ready) return { ok: false, code: "manual_order_rejected_recovery", reason: "recovery not ready" };
    if (side === "buy") {
      if (ss.safety_guard_state === "자동정지") return { ok: false, code: "manual_order_rejected_guard", reason: "safety guard stopped" };
      if (market) {
        const cool = (ss.reentry_cooldowns ?? {})[market] as string | undefined;
        if (cool && Date.now() < Date.parse(cool)) return { ok: false, code: "manual_order_rejected_cooldown", reason: "reentry cooldown active" };
      }
      const openCount = Object.values(ss.open_positions ?? {}).filter((p: any) => Number(p?.qty ?? 0) > 0).length;
      const maxPos = Number(ss.max_positions ?? 2);
      if (openCount >= maxPos) return { ok: false, code: "manual_order_rejected_max_positions", reason: "max positions reached" };
    }
    return { ok: true, st, ss };
  };

  app.get("/health", async () => ({
    ok: true,
    product: TRADING_PRODUCT_NAMESPACE,
    service_line: THIS_REPO_SERVICE_LINE,
    company_id: env.companyId,
    service_id: env.serviceId,
    ...monitorSnap(),
    watch_markets: await resolveWatchMarkets(env.excludedMarkets),
    excluded_markets: env.excludedMarkets,
    volume_threshold_fallback: env.volumeThresholdMain,
    volume_thresholds_by_market: VOLUME_THRESHOLD_BY_MARKET,
    volume_threshold_alt: { "095": 0.95, "075": 0.75 },
    upbit_keys_loaded: Boolean(env.upbitAccessKey && env.upbitSecretKey),
    egress_public_ip: await getEgressPublicIp(),
  }));

  app.get("/api/v1/context", async () => ({
    product: TRADING_PRODUCT_NAMESPACE,
    service_line: THIS_REPO_SERVICE_LINE,
    company_id: env.companyId,
    service_id: env.serviceId,
    ...monitorSnap(),
    watch_markets: await resolveWatchMarkets(env.excludedMarkets),
    excluded_markets: env.excludedMarkets,
    volume_threshold_fallback: env.volumeThresholdMain,
    volume_thresholds_by_market: VOLUME_THRESHOLD_BY_MARKET,
    volume_threshold_alt: { "095": 0.95, "075": 0.75 },
  }));

  /**
   * Session endpoint must stay lightweight: never wait for ticker-heavy valuation path.
   */
  app.addHook("onRequest", async (req, reply) => {
    const pathOnly = req.url.split("?", 1)[0] ?? req.url;
    if (pathOnly.startsWith("/api/") && pathOnly.slice("/api/".length).startsWith("api/")) {
      app.log.warn(
        { url: req.url, method: req.method },
        "CRITICAL: duplicated API path prefix detected. Check Nginx proxy_pass or dashboard upstream origin settings.",
      );
    }
  });

  const TRADE_STATUS_SLOW_MS = Math.min(
    30_000,
    Math.max(1500, Number(process.env.ORBITALPHA_TRADE_STATUS_SLOW_LOG_MS ?? 2500)),
  );

  /**
   * Auth session must not block on Upbit-heavy `trade.statusLightweight()`.
   * Trading flags are loaded separately via `/api/v1/trade/status` or `/api/v1/trade/status-lightweight`.
   */
  const buildAuthSessionPayload = async (req: FastifyRequest) => {
    const s = getSession(req.headers.cookie);
    if (!s) {
      return {
        authenticated: false,
        message: "세션 없음",
        auto_trade_enabled: null,
        recovery_ready: null,
        safety_guard_state: "주의" as const,
        can_enable_auto_trade: false,
        cannot_enable_reason: "unauthenticated" as const,
        trade_status_pending: true,
      };
    }
    req.log.info(
      {
        route: "session",
        authenticated: true,
        user_id: s.user_id,
      },
      "DEBUG_AUTH_SESSION_VERIFIED",
    );
    const ss = strategy.status() as { safety_guard_state?: string };
    const startedAtMs = Date.now();
    const safety = (ss.safety_guard_state ?? "주의") as "정상" | "주의" | "자동정지";
    const payload = {
      authenticated: true as const,
      user_id: s.user_id,
      trade_status_available: false,
      trade_status_pending: true,
      trade_status_fetch_hint: "GET /api/v1/trade/status or /api/v1/trade/status-lightweight",
      trade_status_error: null,
      trade_status_fallback_used: false,
      trade_status_fallback_age_ms: null,
      session_status_degraded: false,
      auto_trade_enabled: null as boolean | null,
      auto_trade_changed_at: null as string | null,
      live_enabled: null as boolean | null,
      api_connected: null as boolean | null,
      recovery_ready: null as boolean | null,
      safety_guard_state: safety,
      can_enable_auto_trade: false,
      cannot_enable_reason: "trade_status_pending" as const,
    };
    req.log.info(
      JSON.stringify({
        tag: "DASHBOARD_SESSION_FAST_OK",
        route: "session",
        authenticated: true,
        user_id: s.user_id,
        ms: Date.now() - startedAtMs,
        safety_guard_state: safety,
      }),
    );
    return payload;
  };

  /** Alias routes — 본문은 `/api/v1/auth/session` 과 동일 필드로 맞춤 */
  const sessionHandler = async (req: FastifyRequest) => buildAuthSessionPayload(req);

  app.get("/api/session", sessionHandler);
  app.get("/session", sessionHandler);

  app.get("/api/status", async (req) => buildTradeStatusResponse(req, "GET /api/status"));
  app.get("/status", async (req) => buildTradeStatusResponse(req, "GET /status"));

  const healthHandler = async () => ({ ok: true, ...monitorSnap() });
  app.get("/api/health", healthHandler);
  // app.get("/health", ...) 는 이미 위에 있으므로 생략하거나 덮어쓰기.

  const logoutHandler = async (req: FastifyRequest, reply: any) => {
    const token = readSessionToken(req.headers.cookie);
    if (token) sessions.delete(token);
    clearSessionCookie(reply, req);
    return { authenticated: false };
  };

  app.post("/api/logout", logoutHandler);
  app.post("/logout", logoutHandler);


  app.get("/api/v1/logs", async (req) => {
    const q = req.query as { limit?: string };
    const requested = Number(q.limit ?? 80);
    const limit = Math.min(200, Math.max(1, Number.isFinite(requested) ? requested : 80));
    // Lightweight caching to avoid dashboard stampede
    const now = Date.now();
    const cacheTtlMs = 1500;
    (globalThis as any).__orbitalpha_logs_cache ??= { at: 0, limit: 0, bodyJson: "" };
    const c = (globalThis as any).__orbitalpha_logs_cache as { at: number; limit: number; bodyJson: string };
    if (c.bodyJson && c.limit === limit && now - c.at < cacheTtlMs) {
      return parseBoundedCacheBody<{ items: unknown[] }>(c.bodyJson);
    }
    const rows = (await readRecentLogs(env.companyId, env.serviceId, limit)).slice(0, API_CACHE_MAX_ARRAY_ITEMS);
    const body = { items: rows };
    c.at = now;
    c.limit = limit;
    c.bodyJson = serializeBoundedCacheBody(body);
    return body;
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] ?? req.ip ?? "unknown");
    const nowMs = Date.now();

    // Check lockout
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.count >= MAX_ATTEMPTS && nowMs - attempt.lastMs < LOCKOUT_MS) {
      reply.code(429);
      return {
        authenticated: false,
        message: `Too many login attempts. Please try again in ${Math.ceil((LOCKOUT_MS - (nowMs - attempt.lastMs)) / 60000)} minutes.`
      };
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = String(body.id ?? body.loginId ?? body.userId ?? "").trim();
    const password = String(body.password ?? "").trim();

    // Password verification (SHA256 hash comparison)
    const submittedHash = crypto.createHash("sha256").update(password).digest("hex");
    const idOk = id === env.adminLoginId;
    const pwOk = crypto.timingSafeEqual(
      Buffer.from(submittedHash),
      Buffer.from(env.adminPasswordHash)
    );
    const ok = idOk && pwOk;

    if (!ok) {
      // Update attempts
      const cur = loginAttempts.get(ip) ?? { count: 0, lastMs: 0 };
      loginAttempts.set(ip, { count: cur.count + 1, lastMs: nowMs });

      app.log.warn({ route: "auth_login", user_id: id, ip, success: false }, "Auth login failed");
      reply.code(401);
      return { authenticated: false, message: "아이디 또는 비밀번호가 올바르지 않습니다" };
    }

    // Success: Reset attempts
    loginAttempts.delete(ip);

    app.log.info({ route: "auth_login", user_id: id, ip, success: true }, "Auth login success");
    await opLog.event({
      timestamp: new Date().toISOString(),
      event_type: ok ? "auth_login_success" : "auth_login_failed",
      market: null,
      strategy_type: null,
      market_state: null,
      side: null,
      reason: ok ? "credentials_ok" : "credentials_invalid",
      balance_krw: null,
      position_qty: null,
      avg_buy_price: null,
      current_price: null,
      pnl_net: null,
      pnl_net_pct: null,
      note: id || null,
    });
    if (!ok) {
      reply.code(401);
      return { authenticated: false, message: "아이디 또는 비밀번호가 올바르지 않습니다" };
    }
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    sessions.set(token, { user_id: id, created_at: now });
    setSessionCookie(reply, req, token);
    /** 로그인 응답은 세션 확정만 즉시 반환. 거래/자동매매 상태는 `/api/v1/auth/session`·`/api/status`에서 조회. */
    return {
      authenticated: true,
      user_id: id,
    };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const token = readSessionToken(req.headers.cookie);
    if (token) sessions.delete(token);
    clearSessionCookie(reply, req);
    app.log.info({ route: "auth_logout" }, "Auth logout");
    await opLog.event({
      timestamp: new Date().toISOString(),
      event_type: "auth_logout",
      market: null,
      strategy_type: null,
      market_state: null,
      side: null,
      reason: "user_logout",
      balance_krw: null,
      position_qty: null,
      avg_buy_price: null,
      current_price: null,
      pnl_net: null,
      pnl_net_pct: null,
      note: null,
    });
    return { authenticated: false };
  });

  app.get("/api/v1/auth/session", async (req) => buildAuthSessionPayload(req));

  app.get("/api/v1/auth/me", async (req, reply) => {
    const s = getSession(req.headers.cookie);
    if (!s) {
      reply.code(401);
      return { authenticated: false };
    }
    return { authenticated: true, user_id: s.user_id };
  });

  app.get("/api/v1/debug/egress-ip", async () => {
    const ip = await getEgressPublicIp();
    return { ok: Boolean(ip), egress_public_ip: ip, checked_at: new Date().toISOString() };
  });

  app.get("/api/v1/debug/env", async () => ({
    ok: true,
    env_root: cwd,
    env_files: envLoadMeta,
    upbit_access_key_present: Boolean(env.upbitAccessKey),
    upbit_access_key_masked: maskKey(env.upbitAccessKey),
    upbit_access_key_fingerprint: keyFingerprint(env.upbitAccessKey),
    upbit_secret_key_present: Boolean(env.upbitSecretKey),
    trading_mode: env.tradingMode,
    live_order_confirm: env.liveOrderConfirm,
  }));

  /** 동일 페이로드(account_portfolio 포함) — 레거시 클라이언트가 /account/status 를 호출하는 경우 대비. */
  const buildTradeStatusResponse = async (req: FastifyRequest, route: string) => {
    const now = Date.now();

    // 1. Cache hit check
    if (tradeStatusCache && now - tradeStatusCache.at < TRADE_STATUS_CACHE_TTL_MS) {
      req.log.info(
        JSON.stringify({
          tag: "DASHBOARD_TRADE_STATUS_CACHE_HIT",
          endpoint: route,
          age_ms: now - tradeStatusCache.at,
        }),
      );
      return tradeStatusCache.body;
    }

    // 2. In-flight reset/fallback
    if (tradeStatusInFlight && tradeStatusInFlightStartedAt && now - tradeStatusInFlightStartedAt > 10_000) {
      req.log.warn(
        JSON.stringify({
          tag: "DASHBOARD_TRADE_STATUS_STALE_IN_FLIGHT_RESET",
          endpoint: route,
          elapsed_ms: now - tradeStatusInFlightStartedAt,
        }),
      );
      tradeStatusInFlight = null;
      tradeStatusInFlightStartedAt = null;
    }

    if (tradeStatusInFlight) {
      if (tradeStatusCache) {
        req.log.info(
          JSON.stringify({
            tag: "DASHBOARD_TRADE_STATUS_IN_FLIGHT_LAST_GOOD_RETURNED",
            endpoint: route,
            last_good_age_ms: now - tradeStatusCache.at,
          }),
        );
        return {
          ...tradeStatusCache.body,
          degraded: true,
          degraded_reason: "trade_status_inflight_last_good_fallback",
          last_good_age_ms: now - tradeStatusCache.at,
        };
      }
      req.log.info(
        JSON.stringify({
          tag: "DASHBOARD_TRADE_STATUS_IN_FLIGHT_DEDUPED",
          endpoint: route,
        }),
      );
      return tradeStatusInFlight;
    }

    const t0 = Date.now();
    tradeStatusInFlightStartedAt = t0;
    const calculationPromise = (async () => {
      try {
        const body = await trade.status();
        tradeStatusCache = { at: Date.now(), body };
        return body;
      } finally {
        tradeStatusInFlight = null;
        tradeStatusInFlightStartedAt = null;
      }
    })();

    tradeStatusInFlight = calculationPromise;

    // 3. Last good fallback with timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("TRADE_STATUS_SLOW_FALLBACK")), TRADE_STATUS_SLOW_FALLBACK_MS),
    );

    try {
      const body = await Promise.race([calculationPromise, timeoutPromise]);
      const ms = Date.now() - t0;
      if (ms >= TRADE_STATUS_SLOW_MS) {
        req.log.warn(
          JSON.stringify({
            tag: "DASHBOARD_TRADE_STATUS_SLOW",
            endpoint: route,
            ms,
            threshold_ms: TRADE_STATUS_SLOW_MS,
          }),
        );
      }
      if (!body.api_connected) {
        const egressIp = await getEgressPublicIp();
        req.log.warn(
          {
            route,
            api_connected: false,
            account_sync_failure_code: body.account_sync_failure_code,
            account_sync_failure_message: body.account_sync_failure_message,
            api_reason: body.api_reason,
            env_access_key_present: body.env_access_key_present,
            env_secret_key_present: body.env_secret_key_present,
            upbit_access_key_masked: body.env_access_key_masked,
            upbit_access_key_fingerprint: (body as any).env_access_key_fingerprint ?? null,
            egress_public_ip: egressIp,
          },
          "trade_status_account_sync_failed",
        );
      }
      return body;
    } catch (err: any) {
      if (err.message === "TRADE_STATUS_SLOW_FALLBACK" && tradeStatusCache) {
        req.log.warn(
          JSON.stringify({
            tag: "DASHBOARD_TRADE_STATUS_FALLBACK_LAST_GOOD",
            endpoint: route,
            last_good_age_ms: now - tradeStatusCache.at,
          }),
        );
        return {
          ...tradeStatusCache.body,
          degraded: true,
          degraded_reason: "trade_status_inflight_last_good_fallback",
          last_good_age_ms: now - tradeStatusCache.at,
        };
      }
      // Re-throw if it wasn't a timeout fallback or if we have no cache
      return calculationPromise;
    }
  };

  app.get("/api/v1/trade/status", async (req) => buildTradeStatusResponse(req, "GET /api/v1/trade/status"));
  app.get("/api/v1/account/status", async (req) => buildTradeStatusResponse(req, "GET /api/v1/account/status"));

  /**
   * Account holdings classification endpoint.
   * - managed_position: strategy engine currently manages this holding (slots/exit policy applies)
   * - passive_holding: real account holding but NOT managed by strategy (excluded from slots/add/exit policies)
   *
   * This endpoint is diagnostic + UI-safe: it does NOT affect entry decisions.
   */
  app.get("/api/v1/account/holdings", async (req) => {
    const t0 = Date.now();
    const tradeStatus = await trade.status();
    const strategyStatus = strategy.status() as any;
    const balances = Array.isArray(tradeStatus?.balances) ? tradeStatus.balances : [];

    const DUST_NOTIONAL_KRW = 1000;
    const held = balances
      .map((b: any) => {
        const currency = String(b?.currency ?? "").toUpperCase();
        if (!currency || currency === "KRW") return null;
        const qty = Number(b?.balance ?? 0) + Number(b?.locked ?? 0);
        const avg = Number(b?.avg_buy_price ?? 0);
        const notional = qty * avg;
        if (!(qty > 0) || !(notional >= DUST_NOTIONAL_KRW)) return null;
        return { market: `KRW-${currency}`, currency, qty, avg_buy_price: avg, notional_cost_krw: notional };
      })
      .filter((x: any): x is { market: string; currency: string; qty: number; avg_buy_price: number; notional_cost_krw: number } => Boolean(x));

    const openPositions = (strategyStatus?.open_positions ?? {}) as Record<string, any>;
    const earlyPositions = (strategyStatus?.early_positions ?? {}) as Record<string, any>;
    const managedMarkets = new Set<string>([
      ...Object.keys(openPositions).filter((m) => Number(openPositions[m]?.qty ?? 0) > 0),
      ...Object.keys(earlyPositions).filter((m) => Number(earlyPositions[m]?.qty ?? 0) > 0),
    ]);

    // Latest signal meta (for holding monitor) from logs, scoped to held+managed set only.
    const watchSet = new Set<string>([...held.map((h) => h.market), ...managedMarkets]);
    const rows = await readRecentLogs(env.companyId, env.serviceId, 500);
    const latestSignalByMarket: Record<string, { ts: string; payload: any } | null> = {};
    for (const m of watchSet) latestSignalByMarket[m] = null;
    for (const row of rows) {
      if (row.kind !== "signal" || !row.payload) continue;
      const p = row.payload as any;
      const mk = typeof p?.market === "string" ? p.market : null;
      if (!mk || !watchSet.has(mk)) continue;
      if (latestSignalByMarket[mk] === null) latestSignalByMarket[mk] = { ts: row.ts, payload: p };
    }

    const holdings = held.map((h) => {
      const managed = managedMarkets.has(h.market);
      const pos = openPositions[h.market] ?? earlyPositions[h.market] ?? null;
      const signalMeta = latestSignalByMarket[h.market];
      const volume_ratio =
        typeof signalMeta?.payload?.volume_ratio === "number"
          ? signalMeta.payload.volume_ratio
          : typeof signalMeta?.payload?.volume_multiple === "number"
            ? signalMeta.payload.volume_multiple
            : null;

      const exit_policy = managed
        ? {
            kind: "engine_exit_policy",
            engine_bucket: typeof pos?.engine_bucket === "string" ? pos.engine_bucket : null,
            strict_exit: Boolean(pos?.strict_exit ?? false),
          }
        : null;

      return {
        ...h,
        holding_kind: managed ? ("managed_position" as const) : ("passive_holding" as const),
        managed_position: managed ? pos : null,
        exit_policy,
        signal_meta: signalMeta
          ? {
              ts: signalMeta.ts,
              source_kind: typeof signalMeta.payload?.source_kind === "string" ? signalMeta.payload.source_kind : null,
              filter_pass: Boolean(signalMeta.payload?.filter_pass ?? false),
              volume_ratio,
            }
          : null,
      };
    });

    const passiveCount = holdings.filter((h) => h.holding_kind === "passive_holding").length;
    const managedCount = holdings.filter((h) => h.holding_kind === "managed_position").length;
    const usedSlots = managedCount;

    req.log.info(
      {
        tag: "SPOT_ACCOUNT_HOLDING_CLASSIFICATION_PROOF",
        ts: new Date().toISOString(),
        holdings_count: holdings.length,
        managed_count: managedCount,
        passive_count: passiveCount,
        used_slots: usedSlots,
        sample_managed: holdings.filter((h) => h.holding_kind === "managed_position").map((h) => h.market).slice(0, 10),
        sample_passive: holdings.filter((h) => h.holding_kind === "passive_holding").map((h) => h.market).slice(0, 10),
      },
      "SPOT_ACCOUNT_HOLDING_CLASSIFICATION_PROOF",
    );
    req.log.info(
      {
        tag: "SPOT_HOLDING_MONITOR_DATA_PROOF",
        ts: new Date().toISOString(),
        holdings_count: holdings.length,
        signal_meta_present_count: holdings.filter((h) => Boolean(h.signal_meta)).length,
        signal_meta_missing_count: holdings.filter((h) => !h.signal_meta).length,
        signal_meta_missing_markets: holdings.filter((h) => !h.signal_meta).map((h) => h.market).slice(0, 15),
      },
      "SPOT_HOLDING_MONITOR_DATA_PROOF",
    );
    req.log.info(
      {
        tag: "SPOT_HOLDING_EXIT_POLICY_PROOF",
        ts: new Date().toISOString(),
        managed_count: managedCount,
        exit_policy_attached_count: holdings.filter((h) => h.holding_kind === "managed_position" && h.exit_policy).length,
        missing_exit_policy_markets: holdings
          .filter((h) => h.holding_kind === "managed_position" && !h.exit_policy)
          .map((h) => h.market)
          .slice(0, 15),
      },
      "SPOT_HOLDING_EXIT_POLICY_PROOF",
    );
    req.log.info(
      {
        tag: "SPOT_SLOT_USAGE_RECONCILE_PROOF",
        ts: new Date().toISOString(),
        used_slots: usedSlots,
        managed_count: managedCount,
        note: "used_slots counts only managed holdings; passive excluded",
      },
      "SPOT_SLOT_USAGE_RECONCILE_PROOF",
    );

    return {
      ok: true,
      updated_at: new Date().toISOString(),
      used_slots: usedSlots,
      holdings,
      strategy: {
        max_positions: Number(strategyStatus?.max_positions ?? 0),
        open_positions_count: Object.keys(openPositions).filter((m) => Number(openPositions[m]?.qty ?? 0) > 0).length,
        early_positions_count: Object.keys(earlyPositions).filter((m) => Number(earlyPositions[m]?.qty ?? 0) > 0).length,
      },
      ms: Date.now() - t0,
    };
  });

  app.get("/api/v1/trade/status-lightweight", async (req) => {
    const t0 = Date.now();
    const st = await trade.statusLightweight();
    const ms = Date.now() - t0;
    req.log.info(
      JSON.stringify({
        tag: "TRADE_STATUS_LIGHTWEIGHT_LATENCY",
        ms,
        api_connected: st.api_connected,
        auto_trade_enabled: st.auto_trade_enabled,
      }),
    );
    if (ms >= TRADE_STATUS_SLOW_MS) {
      req.log.warn(
        JSON.stringify({
          tag: "DASHBOARD_TRADE_STATUS_SLOW",
          endpoint: "GET /api/v1/trade/status-lightweight",
          ms,
          threshold_ms: TRADE_STATUS_SLOW_MS,
        }),
      );
    }
    return st;
  });
  app.get("/api/v1/trades/recent", async (req) => {
    const q = req.query as { limit?: string };
    const n = Number(q.limit ?? 10);
    const limit = Number.isFinite(n) ? n : 10;
    const { relativePath, items, total_rows_in_file } = await readLiveStrategyTradesRecent({
      companyId: env.companyId,
      serviceId: env.serviceId,
      limit,
    });
    return {
      ok: true,
      count: items.length,
      limit: Math.max(1, Math.min(50, limit)),
      source: relativePath.replace(/\\/g, "/"),
      total_rows_in_file,
      items,
    };
  });
  app.get("/api/v1/strategy/status", async () => {
    const s = strategy.status();
    const t = await trade.status();
    const krwAvailable = Number(t.krw_available ?? 0);
    const invested = Number(s.strategy_invested_krw ?? 0);
    const strategyAvailable = Math.max(0, Math.floor(krwAvailable - invested));
    return {
      ...s,
      strategy_available_krw: strategyAvailable,
    };
  });
  app.get("/api/v1/scanner/status", async () => {
    const now = Date.now();
    const ttlMs = 1200;
    (globalThis as any).__orbitalpha_scanner_cache ??= { at: 0, bodyJson: "" };
    const c = (globalThis as any).__orbitalpha_scanner_cache as { at: number; bodyJson: string };
    if (c.bodyJson && now - c.at < ttlMs) return parseBoundedCacheBody(c.bodyJson);
    const body = await pumpScanner.status();
    c.at = now;
    c.bodyJson = serializeBoundedCacheBody(body);
    return body;
  });
  app.get("/api/v1/paper/status", async () => {
    const now = Date.now();
    const ttlMs = 2500;
    (globalThis as any).__orbitalpha_paper_cache ??= { at: 0, bodyJson: "" };
    const c = (globalThis as any).__orbitalpha_paper_cache as { at: number; bodyJson: string };
    
    const sendWithCache = (out: any, isCache: boolean) => {
      const updatedAt = out.updated_at || new Date().toISOString();
      const ageMs = now - (isCache ? c.at : now);
      const stale = isCache && ageMs > 10000;
      
      const body = {
        ...out,
        status_code: stale ? "stale" : out.status_code || "ok",
        status_age_ms: ageMs,
        data_source: isCache ? (stale ? "stale_cache" : "cache") : "live",
        source_name: "local_paper_engine",
        source_path: typeof out?.files?.state === "string" ? out.files.state : null,
      };

      app.log.info(
        {
          tag: "SURGE_REAL_TRADE_JUDGMENT_API_PROOF",
          status_code: body.status_code,
          data_source: body.data_source,
          universe_count: Number(body.universe_count ?? 0),
          candidate_count: Number(body.candidate_count ?? 0),
          shadow_v2_count: Number(body.shadow_v2_count ?? 0),
          preferred_shadow_v2_source: body.preferred_shadow_v2_source,
          preferred_shadow_v2_count: body.preferred_shadow_v2_count,
          local_shadow_v2_enabled: body.local_shadow_v2_enabled,
          local_shadow_v2_count: body.local_shadow_v2_count,
          worker_shadow_v2_snapshot_exists: body.worker_shadow_v2_snapshot_exists,
          worker_shadow_v2_available: body.worker_shadow_v2_available,
          worker_shadow_v2_stale: body.worker_shadow_v2_stale,
          worker_shadow_v2_count: body.worker_shadow_v2_count,
          worker_shadow_v2_age_ms: body.worker_shadow_v2_age_ms,
          degraded_reasons: body.degraded_reasons ?? [],
          status_age_ms: body.status_age_ms,
        },
        "SURGE_REAL_TRADE_JUDGMENT_API_PROOF",
      );

      if (!isCache) {
        c.at = now;
        c.bodyJson = serializeBoundedCacheBody(body);
      }
      return body;
    };

    if (c.bodyJson && now - c.at < ttlMs) {
      return sendWithCache(parseBoundedCacheBody(c.bodyJson), true);
    }

    try {
      const out = (await paper.status()) as any;
      return sendWithCache(out, false);
    } catch (e) {
      app.log.error({ tag: "PAPER_STATUS_API_ERROR", error: String(e) });
      
      // Attempt to fallback to last known cache if available
      if (c.bodyJson) {
        try {
          const fallback = parseBoundedCacheBody(c.bodyJson) as any;
          if (fallback) {
            const reasons = Array.isArray(fallback.degraded_reasons) ? [...fallback.degraded_reasons] : [];
            if (!reasons.includes("fallback_stale_cache")) {
              reasons.push("fallback_stale_cache");
            }
            return {
              ...fallback,
              status_code: "stale",
              data_source: "stale_cache",
              degraded_reasons: reasons,
              last_error: String(e),
              status_updated_at: new Date().toISOString(),
            };
          }
        } catch (parseErr) {
          app.log.error({ tag: "PAPER_STATUS_CACHE_PARSE_ERROR", error: String(parseErr) });
        }
      }

      const errorBody = {
        status_code: "error",
        status_message: "내부 엔진 오류 발생 (Fallback 실패)",
        status_updated_at: new Date().toISOString(),
        status_age_ms: 0,
        data_source: "live",
        has_universe: false,
        has_candidate: false,
        has_shadow_v2: false,
        universe_count: 0,
        candidate_count: 0,
        shadow_v2_count: 0,
        degraded_reasons: ["internal_engine_error", "fallback_failed"],
        last_error: String(e),
        holdings: [],
        recent_history: [],
        surge_v2_shadow: [],
        paper_surge_pattern_stats: [],
      };
      return errorBody;
    }
  });
  app.get("/api/v1/market-state", async () => {
    const now = Date.now();
    const ttlMs = 1200;
    (globalThis as any).__orbitalpha_market_state_cache ??= { at: 0, body: null as any };
    const c = (globalThis as any).__orbitalpha_market_state_cache as { at: number; body: any };
    if (c.body && now - c.at < ttlMs) return c.body;
    const latest = marketFilter.status();
    const body = latest ? latest : await marketFilter.evaluate();
    c.at = now;
    c.body = body;
    return body;
  });

  // Shadow status endpoint: read-only runtime file inspection (no worker control, no orders)
  app.get("/api/v1/surge-shadow/status", async () => {
    const modeRaw = String(process.env.LIVE_SURGE_CANDIDATE_SOURCE ?? "legacy").toLowerCase().trim();
    const shadow_mode = modeRaw === "shadow" || modeRaw === "file";
    const exists = fs.existsSync(surgeCandidatesPath);
    let updated_at: string | null = null;
    let items_count = 0;
    let first_symbols: string[] = [];
    if (exists) {
      try {
        const raw = fs.readFileSync(surgeCandidatesPath, "utf8");
        const j = raw ? (JSON.parse(raw) as any) : null;
        updated_at = typeof j?.updated_at === "string" ? j.updated_at : null;
        const items = Array.isArray(j?.items) ? j.items : [];
        items_count = items.length;
        first_symbols = items
          .map((x: any) => (typeof x?.market === "string" ? x.market : null))
          .filter((s: any): s is string => typeof s === "string" && s.startsWith("KRW-"))
          .slice(0, 8);
      } catch {
        // ignore parse failures; still report exists
      }
    }
    const age_seconds =
      updated_at && Number.isFinite(Date.parse(updated_at))
        ? Math.max(0, Math.floor((Date.now() - Date.parse(updated_at)) / 1000))
        : null;
    return {
      ok: true,
      exists,
      path: surgeCandidatesPath.replace(/\\/g, "/"),
      updated_at,
      age_seconds,
      items_count,
      first_symbols,
      mode: liveScannerRuntimeMode,
      file_exists: exists,
      shadow_mode,
      order_authority: "none",
      worker: "engine2_surge_scanner",
      engine1_scanner_mode: liveScannerRuntimeMode,
    };
  });
  app.get("/api/v1/replay/query", async (req, reply) => {
    const q = req.query as { start?: string; end?: string; market?: string };
    const start = q.start ?? "";
    const end = q.end ?? "";
    if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      reply.code(400);
      return { ok: false, error: "start/end ISO timestamp required" };
    }
    const rows = await readReplayRange({
      startTs: start,
      endTs: end,
      market: q.market,
    });
    return { ok: true, ...rows };
  });

  app.post("/api/v1/trade/auto-toggle", async (req, reply) => {
    const s = getSession(req.headers.cookie);
    if (!s) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }
    const body = (req.body ?? {}) as { enabled?: boolean; risk_ack?: boolean; operatorExplicit?: boolean };
    const enabled = body.enabled === true;
    if (enabled && body.risk_ack !== true) {
      reply.code(400);
      return { ok: false, error: "risk acknowledgement required to enable auto trade" };
    }
    const st0 = await trade.status();
    const ss0 = strategy.status() as any;
    const cannotEnableReason =
      !st0.api_connected
        ? "api disconnected"
        : !st0.live_enabled
          ? "live disabled"
          : !st0.recovery_ready
            ? "recovery not ready"
            : ss0.safety_guard_state === "자동정지"
              ? "safety guard stopped"
              : null;
    if (enabled && cannotEnableReason) {
      await opLog.event({
        timestamp: new Date().toISOString(),
        event_type: "auto_trade_enable_rejected",
        market: null,
        strategy_type: null,
        market_state: null,
        side: null,
        reason: cannotEnableReason,
        balance_krw: Number(st0.krw_available ?? 0),
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: Number((ss0?.strategy_pnl_krw ?? 0)),
        pnl_net_pct: null,
        note: null,
      });
      reply.code(400);
      return { ok: false, error: cannotEnableReason, can_enable_auto_trade: false, cannot_enable_reason: cannotEnableReason };
    }
    const isOperator = body.operatorExplicit === true;
    await trade.setAutoTradeEnabled(enabled, { isOperator });
    const st = await trade.status();
    return {
      ok: true,
      authenticated: true,
      user_id: s.user_id,
      auto_trade_enabled: st.auto_trade_enabled,
      live_enabled: st.live_enabled,
      api_connected: st.api_connected,
      recovery_ready: st.recovery_ready === true,
      safety_guard_state: ss0.safety_guard_state ?? "주의",
      can_enable_auto_trade: cannotEnableReason === null,
      cannot_enable_reason: cannotEnableReason,
      auto_trade_changed_at: st.auto_trade_changed_at,
    };
  });

  app.post("/api/v1/trade/check", async (_req, reply) => {
    try {
      const c = await trade.connectionCheck();
      return { ok: c.connected, ...c };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "connection check failed";
      reply.code(400);
      return { ok: false, error: msg };
    }
  });

  app.post("/api/v1/trade/buy", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { market?: string; confirm?: boolean };
      const market = body.market ?? "";
      const confirm = body.confirm === true;
      await opLog.event({
        timestamp: new Date().toISOString(),
        event_type: "manual_order_attempt",
        market,
        strategy_type: null,
        market_state: null,
        side: "buy",
        reason: "manual_buy",
        balance_krw: null,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      const guard = await evaluateOrderGuard("buy", market);
      if (!guard.ok) {
        await opLog.event({
          timestamp: new Date().toISOString(),
          event_type: guard.code ?? "manual_order_rejected_guard",
          market,
          strategy_type: null,
          market_state: null,
          side: "buy",
          reason: guard.reason ?? "guard_rejected",
          balance_krw: null,
          position_qty: null,
          avg_buy_price: null,
          current_price: null,
          pnl_net: null,
          pnl_net_pct: null,
          note: null,
        });
        reply.code(400);
        return { ok: false, error: guard.reason ?? "guard_rejected" };
      }
      const m = monitorSnap();
      const rows = await readRecentLogs(env.companyId, env.serviceId, 300);
      const latestSignal = rows.find((row) => {
        if (row.kind !== "signal") return false;
        const payload = row.payload as { market?: string } | undefined;
        return payload?.market === market;
      });
      const allowed = isEntrySignalAllowed(latestSignal?.payload, m.monitor_instance_id ?? undefined);
      if (!allowed.ok) {
        await opLog.event({
          timestamp: new Date().toISOString(),
          event_type: "entry_candidate_rejected",
          market,
          strategy_type: null,
          market_state: null,
          side: "buy",
          reason: allowed.reason ?? "signal_gate",
          balance_krw: null,
          position_qty: null,
          avg_buy_price: null,
          current_price: null,
          pnl_net: null,
          pnl_net_pct: null,
          note: null,
        });
        reply.code(400);
        return { ok: false, error: allowed.reason ?? "entry not allowed by signal gate" };
      }
      const order = await trade.placeBuy(market, confirm, undefined, "stable", "strategy", latestSignal?.payload);
      await opLog.event({
        timestamp: new Date().toISOString(),
        event_type: "manual_order_filled",
        market,
        strategy_type: null,
        market_state: null,
        side: "buy",
        reason: "manual_buy_filled",
        balance_krw: null,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      return { ok: true, order };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "buy failed";
      await opLog.event({
        timestamp: new Date().toISOString(),
        event_type: "manual_order_failed",
        market: null,
        strategy_type: null,
        market_state: null,
        side: "buy",
        reason: msg,
        balance_krw: null,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      reply.code(400);
      return { ok: false, error: msg };
    }
  });

  app.post("/api/v1/trade/sell", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { market?: string; confirm?: boolean };
      const market = body.market ?? "";
      const confirm = body.confirm === true;
      await opLog.event({
        timestamp: new Date().toISOString(),
        event_type: "manual_order_attempt",
        market,
        strategy_type: null,
        market_state: null,
        side: "sell",
        reason: "manual_sell",
        balance_krw: null,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      const guard = await evaluateOrderGuard("sell", market);
      if (!guard.ok) {
        await opLog.event({
          timestamp: new Date().toISOString(),
          event_type: guard.code ?? "manual_order_rejected_guard",
          market,
          strategy_type: null,
          market_state: null,
          side: "sell",
          reason: guard.reason ?? "guard_rejected",
          balance_krw: null,
          position_qty: null,
          avg_buy_price: null,
          current_price: null,
          pnl_net: null,
          pnl_net_pct: null,
          note: null,
        });
        reply.code(400);
        return { ok: false, error: guard.reason ?? "guard_rejected" };
      }
      const order = await trade.placeSell(market, confirm);
      await opLog.event({
        timestamp: new Date().toISOString(),
        event_type: "manual_order_filled",
        market,
        strategy_type: null,
        market_state: null,
        side: "sell",
        reason: "manual_sell_filled",
        balance_krw: null,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      return { ok: true, order };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "sell failed";
      await opLog.event({
        timestamp: new Date().toISOString(),
        event_type: "manual_order_failed",
        market: null,
        strategy_type: null,
        market_state: null,
        side: "sell",
        reason: msg,
        balance_krw: null,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      reply.code(400);
      return { ok: false, error: msg };
    }
  });

  const close = async () => {
    clearInterval(strategyTimer);
    if (scannerTimer) clearInterval(scannerTimer);
    clearInterval(marketStateTimer);
    clearInterval(snapshotTimer);
    clearInterval(paperTimer);
    monitor.stop();
    trade.setRecoveryReady(false);
    await opLog.event({
      timestamp: new Date().toISOString(),
      event_type: "server_stopped",
      market: null,
      strategy_type: null,
      market_state: null,
      side: null,
      reason: "shutdown",
      balance_krw: null,
      position_qty: null,
      avg_buy_price: null,
      current_price: null,
      pnl_net: null,
      pnl_net_pct: null,
      note: null,
    });
    procLock.release();
    await app.close();
  };

  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));

  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
  } catch (e) {
    monitor.stop();
    procLock.release();
    throw e;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

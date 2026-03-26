import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import Fastify from "fastify";
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
import { getMvpWatchMarkets } from "./upbit-public.js";
import { VOLUME_THRESHOLD_BY_MARKET } from "./volume-thresholds.js";
import { createTradeControl } from "./trade-control.js";
import { createLiveDataStrategy } from "./live-strategy.js";
import { createPumpScanner } from "./pump-scanner.js";
import { createMarketStateFilter } from "./market-state-filter.js";
import { createOperationalLogger } from "./operational-logs.js";
import { readReplayRange } from "./replay-store.js";

const cwd = process.cwd();
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

let cachedEgressIp: { ip: string; atMs: number } | null = null;
async function getEgressPublicIp(): Promise<string | null> {
  const now = Date.now();
  if (cachedEgressIp && now - cachedEgressIp.atMs < 60_000) return cachedEgressIp.ip;
  try {
    const r = await fetch("https://api.ipify.org?format=json", { headers: { Accept: "application/json" } });
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

async function main() {
  const env = loadEnv();

  const procLock = acquireSignalServerProcessLock();
  if (!procLock) {
    console.error(
      "[orbitalpha-trading] 다른 signal 서버 프로세스가 이미 실행 중인 것으로 보입니다 (락 파일). 종료 후 다시 시도하거나 ORBITALPHA_TRADING_DISABLE_MONITOR_LOCK=1 로 우회하세요.",
    );
    process.exit(1);
  }

  const app = Fastify({ logger: true });
  const opLog = createOperationalLogger({ debugEnabled: env.debugLogEnabled });
  const SESSION_COOKIE = "orbitalpha_trading_session";
  const sessions = new Map<string, { user_id: string; created_at: string }>();

  const readSessionToken = (cookieHeader?: string) => {
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(";").map((v) => v.trim());
    const hit = parts.find((v) => v.startsWith(`${SESSION_COOKIE}=`));
    if (!hit) return null;
    return decodeURIComponent(hit.split("=")[1] ?? "");
  };

  const getSession = (cookieHeader?: string) => {
    const token = readSessionToken(cookieHeader);
    if (!token) return null;
    return sessions.get(token) ?? null;
  };

  const setSessionCookie = (reply: { header: (name: string, value: string) => void }, token: string) => {
    reply.header("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  };

  const clearSessionCookie = (reply: { header: (name: string, value: string) => void }) => {
    reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  };

  const protectedPrefixes = ["/api/v1/trade/", "/api/v1/account/", "/api/v1/orders/", "/api/v1/replay/", "/api/v1/debug/"];
  const authAllowList = new Set(["/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/session", "/api/v1/auth/me"]);

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
    origin: env.dashboardOrigin,
    credentials: true,
  });

  const monitor = startSignalMonitor(env);
  const trade = createTradeControl(env, { onEvent: (row) => opLog.event(row) });
  const marketFilter = createMarketStateFilter({
    companyId: env.companyId,
    serviceId: env.serviceId,
    readLogs: (limit: number) => readRecentLogs(env.companyId, env.serviceId, limit),
    onEvent: (row) => opLog.event(row),
  });
  const strategy = createLiveDataStrategy({
    companyId: env.companyId,
    serviceId: env.serviceId,
    readLogs: (limit: number) => readRecentLogs(env.companyId, env.serviceId, limit),
    trade,
    marketState: marketFilter,
    onEvent: (row) => opLog.event(row),
  });
  await strategy.init();
  trade.setRecoveryReady(true);
  const pumpScanner = createPumpScanner();
  let lastStrategyTickAt: string | null = null;
  let lastScannerTickAt: string | null = null;
  let lastMarketStateTickAt: string | null = null;
  const strategyTimer = setInterval(() => {
    lastStrategyTickAt = new Date().toISOString();
    void strategy.tick().catch((e) => app.log.error({ err: String(e) }, "strategy_tick_failed"));
  }, 15_000);
  const scannerTimer = setInterval(() => {
    lastScannerTickAt = new Date().toISOString();
    void pumpScanner.tick().catch((e) => app.log.error({ err: String(e) }, "pump_scanner_tick_failed"));
  }, pumpScanner.intervalMs);
  const marketStateTimer = setInterval(() => {
    lastMarketStateTickAt = new Date().toISOString();
    void marketFilter.evaluate().catch((e) => app.log.error({ err: String(e) }, "market_state_tick_failed"));
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
  lastScannerTickAt = new Date().toISOString();
  void pumpScanner.tick().catch((e) => app.log.error({ err: String(e) }, "pump_scanner_tick_failed"));
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

  const evaluateOrderGuard = async (market?: string) => {
    const st = await trade.status();
    const ss = strategy.status() as any;
    if (!st.api_connected) return { ok: false, code: "manual_order_rejected_api", reason: "api disconnected" };
    if (!st.live_enabled) return { ok: false, code: "manual_order_rejected_guard", reason: "live disabled" };
    if (!st.recovery_ready) return { ok: false, code: "manual_order_rejected_recovery", reason: "recovery not ready" };
    if (ss.safety_guard_state === "자동정지") return { ok: false, code: "manual_order_rejected_guard", reason: "safety guard stopped" };
    if (market) {
      const cool = (ss.reentry_cooldowns ?? {})[market] as string | undefined;
      if (cool && Date.now() < Date.parse(cool)) return { ok: false, code: "manual_order_rejected_cooldown", reason: "reentry cooldown active" };
    }
    const openCount = Object.values(ss.open_positions ?? {}).filter((p: any) => Number(p?.qty ?? 0) > 0).length;
    const maxPos = Number(ss.max_positions ?? 2);
    if (openCount >= maxPos) return { ok: false, code: "manual_order_rejected_max_positions", reason: "max positions reached" };
    return { ok: true, st, ss };
  };

  app.get("/health", async () => ({
    ok: true,
    product: TRADING_PRODUCT_NAMESPACE,
    service_line: THIS_REPO_SERVICE_LINE,
    company_id: env.companyId,
    service_id: env.serviceId,
    ...monitorSnap(),
    watch_markets: getMvpWatchMarkets(env.excludedMarkets),
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
    watch_markets: getMvpWatchMarkets(env.excludedMarkets),
    excluded_markets: env.excludedMarkets,
    volume_threshold_fallback: env.volumeThresholdMain,
    volume_thresholds_by_market: VOLUME_THRESHOLD_BY_MARKET,
    volume_threshold_alt: { "095": 0.95, "075": 0.75 },
  }));

  app.get("/api/v1/logs", async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100)));
    const rows = await readRecentLogs(env.companyId, env.serviceId, limit);
    return { items: rows };
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; password?: string };
    const id = (body.id ?? "").trim();
    const password = body.password ?? "";
    const ok = id === env.tradingLoginId && password === env.tradingLoginPassword;
    app.log.info({ route: "auth_login", user_id: id, success: ok }, "Auth login attempt");
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
    setSessionCookie(reply, token);
    const st = await trade.status();
    return {
      authenticated: true,
      user_id: id,
      auto_trade_enabled: st.auto_trade_enabled,
      auto_trade_changed_at: st.auto_trade_changed_at,
    };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const token = readSessionToken(req.headers.cookie);
    if (token) sessions.delete(token);
    await trade.setAutoTradeEnabled(false);
    clearSessionCookie(reply);
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
    return { authenticated: false, auto_trade_enabled: false };
  });

  app.get("/api/v1/auth/session", async (req, reply) => {
    const s = getSession(req.headers.cookie);
    if (!s) {
      reply.code(401);
      return {
        authenticated: false,
        message: "세션 만료",
        auto_trade_enabled: false,
        recovery_ready: false,
        safety_guard_state: "주의",
        can_enable_auto_trade: false,
        cannot_enable_reason: "unauthenticated",
      };
    }
    const st = await trade.status();
    const ss = strategy.status() as any;
    const cannotEnableReason =
      !st.api_connected
        ? "api disconnected"
        : !st.live_enabled
          ? "live disabled"
          : !st.recovery_ready
            ? "recovery not ready"
            : ss.safety_guard_state === "자동정지"
              ? "safety guard stopped"
              : null;
    return {
      authenticated: true,
      user_id: s.user_id,
      auto_trade_enabled: st.auto_trade_enabled,
      auto_trade_changed_at: st.auto_trade_changed_at,
      live_enabled: st.live_enabled,
      api_connected: st.api_connected,
      recovery_ready: st.recovery_ready === true,
      safety_guard_state: ss.safety_guard_state ?? "주의",
      can_enable_auto_trade: cannotEnableReason === null,
      cannot_enable_reason: cannotEnableReason,
    };
  });

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

  app.get("/api/v1/trade/status", async (req) => {
    const body = await trade.status();
    if (!body.api_connected) {
      const egressIp = await getEgressPublicIp();
      req.log.warn(
        {
          route: "GET /api/v1/trade/status",
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
  app.get("/api/v1/scanner/status", async () => pumpScanner.status());
  app.get("/api/v1/market-state", async () => {
    const latest = marketFilter.status();
    if (latest) return latest;
    return marketFilter.evaluate();
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
    const body = (req.body ?? {}) as { enabled?: boolean; risk_ack?: boolean };
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
    await trade.setAutoTradeEnabled(enabled);
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
      const guard = await evaluateOrderGuard(market);
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
      const ms = await marketFilter.evaluate();
      const mg = marketFilter.entryGate(latestSignal?.payload, ms);
      if (!mg.ok) {
        await opLog.event({
          timestamp: new Date().toISOString(),
          event_type: "entry_candidate_rejected",
          market,
          strategy_type: null,
          market_state: ms.market_state,
          side: "buy",
          reason: mg.reason ?? "market_state_gate",
          balance_krw: null,
          position_qty: null,
          avg_buy_price: null,
          current_price: null,
          pnl_net: null,
          pnl_net_pct: null,
          note: null,
        });
        reply.code(400);
        return { ok: false, error: mg.reason ?? "entry blocked by market state filter", market_state: ms.market_state };
      }
      const order = await trade.placeBuy(market, confirm);
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
      const guard = await evaluateOrderGuard(market);
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
    clearInterval(scannerTimer);
    clearInterval(marketStateTimer);
    clearInterval(snapshotTimer);
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

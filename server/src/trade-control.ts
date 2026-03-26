import type { Env } from "./env.js";
import { appendLog } from "./log-store.js";
import { fetchAccounts, placeMarketBuy, placeMarketSell, type UpbitAccount } from "./upbit-private.js";
import { companyIdSchema, serviceIdSchema } from "@orbitalpha/shared";
import type { StrategyType } from "./strategy-risk-config.js";
import { STRATEGY_RISK_CONFIG } from "./strategy-risk-config.js";
import crypto from "node:crypto";

type TradeOrderSide = "buy" | "sell";

type TradeOrderSnapshot = {
  ts: string;
  market: string;
  side: TradeOrderSide;
  amount_krw: number;
  status: "ok" | "error";
  detail: string;
  order_uuid?: string;
};

type TradeState = {
  inFlight: boolean;
  lastOrderAtMs: number;
  lastOrderKey: string | null;
  testMarket: "KRW-BTC" | "KRW-XRP" | null;
  lastOrder: TradeOrderSnapshot | null;
  lastError: string | null;
  autoTradeEnabled: boolean;
  autoTradeChangedAt: string | null;
  recoveryReady: boolean;
  strategyPositions: Record<
    "KRW-BTC" | "KRW-ETH" | "KRW-XRP" | "KRW-TRX",
    {
      qty: number;
      avg: number;
      entries: number;
      realized_pnl: number;
      strategy_type: StrategyType;
      stop_loss_pct: number;
      breakeven_arm_pct: number;
      partial_take_profit_pct: number;
      trailing_from_peak_pct: number;
    }
  >;
};

const TEST_ORDER_KRW = 5000;
const COOLDOWN_MS = 20_000;
const ALLOWED_MARKETS = new Set(["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"]);
const MAX_CONCURRENT_STRATEGY_POSITIONS = 2;
const MAX_ENTRIES_PER_MARKET = 2; // 최초 1 + 추가 1
const STRATEGY_RULES = {
  tp1_pct: 2.5,
  tp2_pct: 5.0,
  tp3_pct: 8.0,
  sl_pct: -3.0,
  trailing_arm_pct: 2.0,
  trailing_after_tp2_keep_pct: 2.0,
  split_take_profit: [30, 40, 30] as const,
  reentry_min_closed_candles: 1,
  min_signal_strength_for_entry: "MID",
  require_volume_increase_for_entry: true,
  manual_approval_default: true,
  fixed_order_krw: TEST_ORDER_KRW,
};

function maskKey(value?: string): string | null {
  if (!value) return null;
  return `${value.slice(0, 4)}***${value.slice(-2)} (len:${value.length})`;
}

function keyFingerprint(value?: string): string | null {
  if (!value) return null;
  const h = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return h.slice(0, 12);
}

/** Maps Upbit / network errors to a stable code for logs and API clients. */
export function classifyAccountsSyncError(err: unknown): { code: string; reason: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const snip = msg.length > 800 ? `${msg.slice(0, 800)}…` : msg;

  if (/no_authorization_ip/i.test(msg)) return { code: "no_authorization_ip", reason: snip };
  if (/invalid_access_key/i.test(msg)) return { code: "invalid_access_key", reason: snip };
  if (/insufficient_scope/i.test(msg)) return { code: "insufficient_scope", reason: snip };
  if (/jwt/i.test(msg) && /verif/i.test(msg)) return { code: "jwt_verification_failed", reason: snip };

  const nameM = msg.match(/"name"\s*:\s*"([^"]+)"/);
  if (nameM?.[1]) return { code: nameM[1], reason: snip };

  const st = msg.match(/->\s*(\d{3})\s*:/);
  if (st?.[1]) return { code: `upbit_http_${st[1]}`, reason: snip };

  if (/fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(msg)) {
    return { code: "upbit_network_error", reason: snip };
  }
  if (/timeout|Timeout|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|aborted/i.test(msg)) {
    return { code: "upbit_timeout", reason: snip };
  }

  return { code: "accounts_fetch_failed", reason: snip };
}

type ConnectionBalances = Array<{
  currency: string;
  balance: number;
  locked: number;
  avg_buy_price: number;
  unit_currency: string;
}>;

type ConnectionResult = {
  connected: boolean;
  reason: string | null;
  failure_code: string | null;
  balances: ConnectionBalances;
  krw_available: number;
  access_key_masked: string | null;
  access_key_fingerprint: string | null;
};

export function createTradeControl(
  env: Env,
  hooks?: {
    onEvent?: (row: {
      timestamp: string;
      event_type: string;
      market: string | null;
      strategy_type: string | null;
      market_state: string | null;
      side: string | null;
      reason: string | null;
      balance_krw: number | null;
      position_qty: number | null;
      avg_buy_price: number | null;
      current_price: number | null;
      pnl_net: number | null;
      pnl_net_pct: number | null;
      note: string | null;
    }) => Promise<void>;
  },
) {
  const companyId = companyIdSchema.parse(env.companyId);
  const serviceId = serviceIdSchema.parse(env.serviceId);
  const state: TradeState = {
    inFlight: false,
    lastOrderAtMs: 0,
    lastOrderKey: null,
    testMarket: null,
    lastOrder: null,
    lastError: null,
    autoTradeEnabled: false,
    autoTradeChangedAt: null,
    recoveryReady: false,
    strategyPositions: {
      "KRW-BTC": { qty: 0, avg: 0, entries: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
      "KRW-ETH": { qty: 0, avg: 0, entries: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
      "KRW-XRP": { qty: 0, avg: 0, entries: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
      "KRW-TRX": { qty: 0, avg: 0, entries: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
    },
  };

  const isLiveEnabled = () =>
    env.tradingMode === "live" && env.liveOrderConfirm === true && Boolean(env.upbitAccessKey && env.upbitSecretKey);

  const log = async (message: string, payload?: Record<string, unknown>) => {
    await appendLog({
      company_id: companyId,
      service_id: serviceId,
      ts: new Date().toISOString(),
      kind: "upbit",
      message,
      payload,
    });
  };

  const parseKrwBalance = (accounts: UpbitAccount[]) => {
    const krw = accounts.find((a) => a.currency === "KRW");
    return Number(krw?.balance ?? 0);
  };

  const accountSnapshot = (accounts: UpbitAccount[]) =>
    accounts.map((a) => ({
      currency: a.currency,
      balance: Number(a.balance),
      locked: Number(a.locked),
      avg_buy_price: Number(a.avg_buy_price),
      unit_currency: a.unit_currency,
    }));

  const getConnectionStatus = async (): Promise<ConnectionResult> => {
    if (!env.upbitAccessKey || !env.upbitSecretKey) {
      return {
        connected: false,
        reason: "API keys not configured",
        failure_code: "env_key_missing",
        balances: [],
        krw_available: 0,
        access_key_masked: maskKey(env.upbitAccessKey),
        access_key_fingerprint: keyFingerprint(env.upbitAccessKey),
      };
    }
    try {
      const accounts = await fetchAccounts(env.upbitAccessKey, env.upbitSecretKey);
      return {
        connected: true,
        reason: null,
        failure_code: null,
        balances: accountSnapshot(accounts),
        krw_available: parseKrwBalance(accounts),
        access_key_masked: maskKey(env.upbitAccessKey),
        access_key_fingerprint: keyFingerprint(env.upbitAccessKey),
      };
    } catch (e) {
      const { code, reason } = classifyAccountsSyncError(e);
      return {
        connected: false,
        reason,
        failure_code: code,
        balances: [],
        krw_available: 0,
        access_key_masked: maskKey(env.upbitAccessKey),
        access_key_fingerprint: keyFingerprint(env.upbitAccessKey),
      };
    }
  };

  const ensureOrderAllowed = async (side: TradeOrderSide, market: string, confirm: boolean) => {
    if (!state.autoTradeEnabled) throw new Error("Auto trade is disabled");
    if (!ALLOWED_MARKETS.has(market)) throw new Error("Only KRW-BTC or KRW-XRP allowed for test");
    if (!confirm) throw new Error("confirm=true required");
    if (!isLiveEnabled()) throw new Error("Live trading is disabled by environment guards");
    if (state.inFlight) throw new Error("Another order is in progress");
    const now = Date.now();
    if (now - state.lastOrderAtMs < COOLDOWN_MS) throw new Error(`Cooldown active: wait ${COOLDOWN_MS}ms`);
    const key = `${side}:${market}:${Math.floor(now / 1000)}`;
    if (state.lastOrderKey === key) throw new Error("Duplicate order blocked");
    if (side === "buy") {
      const openPositions = Object.values(state.strategyPositions).filter((p) => p.qty > 0).length;
      if (openPositions >= MAX_CONCURRENT_STRATEGY_POSITIONS) {
        throw new Error(`Max concurrent strategy positions is ${MAX_CONCURRENT_STRATEGY_POSITIONS}`);
      }
      const p = state.strategyPositions[market as keyof typeof state.strategyPositions];
      if (p && p.entries >= MAX_ENTRIES_PER_MARKET) {
        throw new Error(`Additional entry limit reached for ${market}`);
      }
    }
    const conn = await getConnectionStatus();
    if (!conn.connected) throw new Error(conn.reason ?? "Connection failed");
    return conn;
  };

  const setAutoTradeEnabled = async (enabled: boolean) => {
    state.autoTradeEnabled = enabled;
    state.autoTradeChangedAt = new Date().toISOString();
    await log(enabled ? "auto_trade_enabled" : "auto_trade_disabled", { enabled, changed_at: state.autoTradeChangedAt });
    await hooks?.onEvent?.({
      timestamp: state.autoTradeChangedAt ?? new Date().toISOString(),
      event_type: enabled ? "auto_trade_enabled" : "auto_trade_disabled",
      market: null,
      strategy_type: null,
      market_state: null,
      side: null,
      reason: enabled ? "ON" : "OFF",
      balance_krw: null,
      position_qty: null,
      avg_buy_price: null,
      current_price: null,
      pnl_net: null,
      pnl_net_pct: null,
      note: null,
    });
  };

  const setRecoveryReady = (ready: boolean) => {
    state.recoveryReady = ready;
  };

  const markOrderResult = (snap: TradeOrderSnapshot) => {
    state.lastOrder = snap;
    state.lastOrderAtMs = Date.now();
    state.lastOrderKey = `${snap.side}:${snap.market}:${Math.floor(state.lastOrderAtMs / 1000)}`;
    state.lastError = snap.status === "error" ? snap.detail : null;
    if (!state.testMarket) state.testMarket = snap.market as "KRW-BTC" | "KRW-XRP";
  };

  const placeBuy = async (market: string, confirm: boolean, amountKrw = TEST_ORDER_KRW, strategyType: StrategyType = "stable") => {
    const conn = await ensureOrderAllowed("buy", market, confirm);
    if (conn.krw_available < amountKrw) throw new Error(`Not enough KRW. required=${amountKrw}`);
    state.inFlight = true;
    try {
      await log("manual_buy_request", { market, amount_krw: amountKrw, mode: env.tradingMode });
      await hooks?.onEvent?.({
        timestamp: new Date().toISOString(),
        event_type: "order_attempt",
        market,
        strategy_type: strategyType,
        market_state: null,
        side: "buy",
        reason: "manual_buy_request",
        balance_krw: conn.krw_available,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      const rsp = await placeMarketBuy({
        accessKey: env.upbitAccessKey!,
        secretKey: env.upbitSecretKey!,
        market,
        krwAmount: amountKrw,
      });
      const snap: TradeOrderSnapshot = {
        ts: new Date().toISOString(),
        market,
        side: "buy",
        amount_krw: amountKrw,
        status: "ok",
        detail: rsp.state,
        order_uuid: rsp.uuid,
      };
      markOrderResult(snap);
      const executed = Number(rsp.executed_volume ?? "0");
      const pos = state.strategyPositions[market as keyof typeof state.strategyPositions];
      if (pos && Number.isFinite(executed) && executed > 0) {
        const nextQty = pos.qty + executed;
        const nextCost = pos.qty * pos.avg + amountKrw;
        pos.qty = nextQty;
        pos.avg = nextQty > 0 ? nextCost / nextQty : 0;
        pos.entries += 1;
        pos.strategy_type = strategyType;
        const rule = strategyType === "momentum" ? STRATEGY_RISK_CONFIG.momentum : STRATEGY_RISK_CONFIG.stable;
        pos.stop_loss_pct = rule.stop_loss_pct;
        pos.breakeven_arm_pct = rule.breakeven_arm_pct;
        pos.partial_take_profit_pct = rule.partial_take_profit_pct;
        pos.trailing_from_peak_pct = rule.trailing_from_peak_pct;
      }
      await log("manual_buy_response", { market, amount_krw: amountKrw, order: rsp });
      await hooks?.onEvent?.({
        timestamp: snap.ts,
        event_type: "order_filled",
        market,
        strategy_type: strategyType,
        market_state: null,
        side: "buy",
        reason: "manual_buy_response",
        balance_krw: conn.krw_available - amountKrw,
        position_qty: Number(rsp.executed_volume ?? "0"),
        avg_buy_price: amountKrw,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: rsp.uuid ?? null,
      });
      return snap;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "buy failed";
      const snap: TradeOrderSnapshot = {
        ts: new Date().toISOString(),
        market,
        side: "buy",
        amount_krw: amountKrw,
        status: "error",
        detail: msg,
      };
      markOrderResult(snap);
      await log("manual_buy_error", { market, amount_krw: amountKrw, error: msg });
      await hooks?.onEvent?.({
        timestamp: snap.ts,
        event_type: "order_failed",
        market,
        strategy_type: strategyType,
        market_state: null,
        side: "buy",
        reason: msg,
        balance_krw: conn.krw_available,
        position_qty: null,
        avg_buy_price: null,
        current_price: null,
        pnl_net: null,
        pnl_net_pct: null,
        note: null,
      });
      throw e;
    } finally {
      state.inFlight = false;
    }
  };

  const placeSell = async (market: string, confirm: boolean, ratio = 1) => {
    await ensureOrderAllowed("sell", market, confirm);
    state.inFlight = true;
    try {
      const pos = state.strategyPositions[market as keyof typeof state.strategyPositions];
      const volume = (pos?.qty ?? 0) * Math.min(1, Math.max(0.01, ratio));
      if (!Number.isFinite(volume) || volume <= 0) throw new Error(`No strategy position to sell for ${market}`);

      await log("manual_sell_request", { market, volume, mode: env.tradingMode });
      const rsp = await placeMarketSell({
        accessKey: env.upbitAccessKey!,
        secretKey: env.upbitSecretKey!,
        market,
        volume,
      });
      const snap: TradeOrderSnapshot = {
        ts: new Date().toISOString(),
        market,
        side: "sell",
        amount_krw: TEST_ORDER_KRW,
        status: "ok",
        detail: rsp.state,
        order_uuid: rsp.uuid,
      };
      markOrderResult(snap);
      if (pos) {
        const remain = Math.max(0, pos.qty - volume);
        pos.qty = remain;
        if (remain <= 0) {
          pos.avg = 0;
          pos.entries = 0;
        }
      }
      await log("manual_sell_response", { market, volume, order: rsp });
      return snap;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "sell failed";
      const snap: TradeOrderSnapshot = {
        ts: new Date().toISOString(),
        market,
        side: "sell",
        amount_krw: TEST_ORDER_KRW,
        status: "error",
        detail: msg,
      };
      markOrderResult(snap);
      await log("manual_sell_error", { market, error: msg });
      throw e;
    } finally {
      state.inFlight = false;
    }
  };

  const status = async () => {
    const conn = await getConnectionStatus();
    const strategyPositions = state.strategyPositions;
    const strategyXrpQty = strategyPositions["KRW-XRP"].qty;
    const xrpAccount = conn.balances.find((b) => b.currency === "XRP");
    const legacyXrpQty = Math.max(0, Number(xrpAccount?.balance ?? 0) - strategyXrpQty);
    const legacyXrpAvg = Number(xrpAccount?.avg_buy_price ?? 0);
    return {
      trading_mode: env.tradingMode,
      live_order_confirm: env.liveOrderConfirm,
      live_enabled: isLiveEnabled(),
      env_access_key_present: Boolean(env.upbitAccessKey),
      env_access_key_masked: maskKey(env.upbitAccessKey),
      env_access_key_fingerprint: conn.access_key_fingerprint,
      env_secret_key_present: Boolean(env.upbitSecretKey),
      api_connected: conn.connected,
      api_reason: conn.reason,
      account_sync_failure_code: conn.connected ? null : conn.failure_code,
      account_sync_failure_message: conn.connected ? null : conn.reason,
      krw_available: conn.krw_available,
      balances: conn.balances,
      test_order_krw: TEST_ORDER_KRW,
      cooldown_ms: COOLDOWN_MS,
      test_market: state.testMarket,
      last_order: state.lastOrder,
      last_error: state.lastError,
      in_flight: state.inFlight,
      auto_trade_enabled: state.autoTradeEnabled,
      auto_trade_changed_at: state.autoTradeChangedAt,
      recovery_ready: state.recoveryReady,
      strategy_rules: STRATEGY_RULES,
      strategy_risk_rules: STRATEGY_RISK_CONFIG,
      legacy_position: {
        market: "KRW-XRP",
        qty: legacyXrpQty,
        avg: legacyXrpAvg,
        excluded_from_strategy: true,
      },
      strategy_positions: strategyPositions,
      pnl_summary: {
        legacy_position_pnl: null,
        strategy_position_pnl: Object.values(strategyPositions).reduce((acc, p) => acc + p.realized_pnl, 0),
        total_pnl: null,
      },
    };
  };

  return {
    status,
    connectionCheck: getConnectionStatus,
    placeBuy,
    placeSell,
    setAutoTradeEnabled,
    setRecoveryReady,
  };
}

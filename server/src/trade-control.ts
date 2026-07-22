import type { Env } from "./env.js";
import {
  buildEffectiveValuationPriceMap,
  computeAccountValuationFromPrices,
  normalizeBalanceCurrency,
  resolveTickerPricesForBalances,
  sanitizeAccountPortfolioSnapshot,
  type AccountPortfolioSnapshot,
} from "./account-portfolio.js";
import {
  peekMinuteCandleCache,
  lastGoodTickerCache,
  tickerSourceMap,
  tickerAgeMap,
} from "./upbit-public.js";
import { appendLog } from "./log-store.js";
import { fetchAccounts, placeMarketBuy, placeMarketSell, fetchOrderDetails, fetchOrderByIdentifier, type UpbitAccount } from "./upbit-private.js";
import { companyIdSchema, serviceIdSchema } from "@orbitalpha/shared";
import type { StrategyType } from "./strategy-risk-config.js";
import { ORDER_LIMITS } from "@orbitalpha/shared";
import { STRATEGY_RISK_CONFIG, grossPnlPct, netPnlPctPerUnit } from "./strategy-risk-config.js";
import { computeLiveCapitalPolicyV4 } from "./live-capital-policy-v4.js";
import crypto from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const marketCodeForCurrency = (currency: string) => `KRW-${normalizeBalanceCurrency(currency)}`;

type TradeOrderSide = "buy" | "sell";
type PositionBucket = "strategy" | "legacy";
type ManagedMarket = string;

type LegacyBucketState = {
  qty: number;
  avg: number;
  dca_count: number;
  dca_max: number;
  /** 누적 DCA 매수 KRW (한도 게이트용). */
  dca_krw_total: number;
  dca_locked: boolean;
  next_dca_at: string | null;
  exit_stage: 0 | 1 | 2;
  exit_status: "평단 복귀 대기" | "1차 탈출" | "분할 청산 중";
};

type TradeOrderSnapshot = {
  ts: string;
  market: string;
  side: TradeOrderSide;
  amount_krw: number;
  status: "ok" | "error";
  detail: string;
  order_uuid?: string;
  identifier?: string;
};

type TradeState = {
  inFlight: boolean;
  /** 진행중 주문이 매수일 때만 설정 — SURGE/CORE 예약금 배분 근거 */
  inFlightBuyMarket: string | null;
  lastOrderAtMs: number;
  lastOrderKey: string | null;
  testMarket: "KRW-BTC" | "KRW-XRP" | null;
  lastOrder: TradeOrderSnapshot | null;
  lastError: string | null;
  autoTradeEnabled: boolean;
  autoTradeChangedAt: string | null;
  recoveryReady: boolean;
  /** 티커 실패 시에도 동일 스냅샷 기준 유지 — 빈 맵으로 재계산하지 않음 */
  lastGoodMarkPrices: Record<string, number> | null;
  strategyPositions: Record<
    ManagedMarket,
    {
      qty: number;
      avg: number;
      entries: number;
      /** 전략 매수 누적 KRW (추가매수 한도). */
      invested_krw_total: number;
      realized_pnl: number;
      strategy_type: StrategyType;
      stop_loss_pct: number;
      stop_loss_price?: number;
      breakeven_arm_pct: number;
      partial_take_profit_pct: number;
      trailing_from_peak_pct: number;
      
      // Profit Protect
      profit_protected?: boolean;
      partial_tp_count?: number;
      realized_partial_profit?: number;
      last_realized_profit_order_uuid?: string;
      last_profit_protect_exit_attempt_ms?: number;
      last_dust_log_ms?: number;
      
      // SURGE V2 specific
      strict_exit?: boolean;
      exit_policy_attached?: boolean;
      surge_entry_mode?: string;
      surge_stop_price?: number;
      surge_take_profit_price?: number;
      surge_trailing_start_pct?: number;
      surge_trailing_gap_pct?: number;
      entry_stop_price?: number;
      entry_target_price?: number;
      entry_risk_reward?: number;
    }
  >;
  legacyBuckets: Record<ManagedMarket, LegacyBucketState>;
  dailyRiskKillSwitchActive?: boolean;
};

const TEST_ORDER_KRW = 5000;
const COOLDOWN_MS = 20_000;
const ALLOWED_MARKETS = new Set(["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"]);
const MANAGED_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"] as const;
const MAX_CONCURRENT_STRATEGY_POSITIONS = (() => {
  const raw = process.env.LIVE_MAX_POSITIONS_CAP;
  const n = raw === undefined || raw === "" ? 10 : Number(raw);
  const cap = Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : 10;
  console.info(JSON.stringify({
    tag: "SPOT_SLOT_LIMIT_CONFIG_PROOF",
    ts: new Date().toISOString(),
    configured_max_slots: cap
  }));
  return cap;
})();
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

function getKstTime(date: Date = new Date()) {
  const kstMs = date.getTime() + (9 * 60 * 60 * 1000);
  const kstDate = new Date(kstMs);
  const hour = kstDate.getUTCHours();
  const minute = kstDate.getUTCMinutes();
  return { hour, minute };
}

function getKstDateString(date: Date) {
  const kstMs = date.getTime() + (9 * 60 * 60 * 1000);
  const kstDate = new Date(kstMs);
  const year = kstDate.getUTCFullYear();
  const month = String(kstDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kstDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

type LightweightStatus = {
  api_connected: boolean;
  api_reason: string | null;
  account_sync_failure_code: string | null;
  account_sync_failure_message: string | null;
  auto_trade_enabled: boolean;
  auto_trade_changed_at: string | null;
  live_enabled: boolean;
  recovery_ready: boolean;
  env_access_key_present: boolean;
  env_secret_key_present: boolean;
  krw_available: number;
  balances: ConnectionBalances;
  entry_time_window_open: boolean;
  next_entry_allowed_at_kst: string;
};

const TRADE_CONTROL_STATE_FILE = path.join(process.cwd(), "data", "runtime", "trade-control-state.json");

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
      type?: string;
      final_close?: boolean;
      partial_exit?: boolean;
      stage?: string;
    }) => Promise<void>;
    /** 매수 직전 — 시장 스냅샷·entry 게이트 재검사 (신규/추가 공통). */
    assertBuyGate?: (ctx: {
      market: string;
      bucket: PositionBucket;
      isAdditionalBuy: boolean;
      signalPayload: unknown | undefined;
      strategyType?: string;
    }) => Promise<void>;
  },
) {
  const companyId = companyIdSchema.parse(env.companyId);
  const serviceId = serviceIdSchema.parse(env.serviceId);
  const state: TradeState = {
    inFlight: false,
    inFlightBuyMarket: null,
    lastOrderAtMs: 0,
    lastOrderKey: null,
    testMarket: null,
    lastOrder: null,
    lastError: null,
    autoTradeEnabled: false,
    autoTradeChangedAt: null,
    recoveryReady: false,
    lastGoodMarkPrices: null,
    strategyPositions: {
      "KRW-BTC": { qty: 0, avg: 0, entries: 0, invested_krw_total: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
      "KRW-ETH": { qty: 0, avg: 0, entries: 0, invested_krw_total: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
      "KRW-SOL": { qty: 0, avg: 0, entries: 0, invested_krw_total: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
      "KRW-XRP": { qty: 0, avg: 0, entries: 0, invested_krw_total: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
      "KRW-TRX": { qty: 0, avg: 0, entries: 0, invested_krw_total: 0, realized_pnl: 0, strategy_type: "stable", stop_loss_pct: STRATEGY_RISK_CONFIG.stable.stop_loss_pct, breakeven_arm_pct: STRATEGY_RISK_CONFIG.stable.breakeven_arm_pct, partial_take_profit_pct: STRATEGY_RISK_CONFIG.stable.partial_take_profit_pct, trailing_from_peak_pct: STRATEGY_RISK_CONFIG.stable.trailing_from_peak_pct },
    },
    legacyBuckets: {
      "KRW-BTC": { qty: 0, avg: 0, dca_count: 0, dca_max: ORDER_LIMITS.MAX_LEGACY_DCA_COUNT_PER_MARKET, dca_krw_total: 0, dca_locked: false, next_dca_at: null, exit_stage: 0, exit_status: "평단 복귀 대기" },
      "KRW-ETH": { qty: 0, avg: 0, dca_count: 0, dca_max: ORDER_LIMITS.MAX_LEGACY_DCA_COUNT_PER_MARKET, dca_krw_total: 0, dca_locked: false, next_dca_at: null, exit_stage: 0, exit_status: "평단 복귀 대기" },
      "KRW-SOL": { qty: 0, avg: 0, dca_count: 0, dca_max: ORDER_LIMITS.MAX_LEGACY_DCA_COUNT_PER_MARKET, dca_krw_total: 0, dca_locked: false, next_dca_at: null, exit_stage: 0, exit_status: "평단 복귀 대기" },
      "KRW-XRP": { qty: 0, avg: 0, dca_count: 0, dca_max: ORDER_LIMITS.MAX_LEGACY_DCA_COUNT_PER_MARKET, dca_krw_total: 0, dca_locked: false, next_dca_at: null, exit_stage: 0, exit_status: "평단 복귀 대기" },
      "KRW-TRX": { qty: 0, avg: 0, dca_count: 0, dca_max: ORDER_LIMITS.MAX_LEGACY_DCA_COUNT_PER_MARKET, dca_krw_total: 0, dca_locked: false, next_dca_at: null, exit_stage: 0, exit_status: "평단 복귀 대기" },
    },
  };
  const loadPersistedAutoTradeState = () => {
    try {
      if (!existsSync(TRADE_CONTROL_STATE_FILE)) {
        console.info(
          JSON.stringify({
            tag: "TRADE_CONTROL_STATE_RESTORED",
            ts: new Date().toISOString(),
            autoTradeEnabled: state.autoTradeEnabled,
            autoTradeChangedAt: state.autoTradeChangedAt,
            state_file: TRADE_CONTROL_STATE_FILE,
          }),
        );
        return;
      }
      const raw = readFileSync(TRADE_CONTROL_STATE_FILE, "utf8");
      const parsed = JSON.parse(raw) as any;
      state.autoTradeEnabled = Boolean(parsed.autoTradeEnabled);
      state.autoTradeChangedAt = typeof parsed.autoTradeChangedAt === "string" ? parsed.autoTradeChangedAt : null;
      if (parsed.strategyPositions) state.strategyPositions = { ...state.strategyPositions, ...parsed.strategyPositions };
      if (parsed.legacyBuckets) state.legacyBuckets = { ...state.legacyBuckets, ...parsed.legacyBuckets };
      console.info(
        JSON.stringify({
          tag: "TRADE_CONTROL_STATE_RESTORED",
          ts: new Date().toISOString(),
          autoTradeEnabled: state.autoTradeEnabled,
          autoTradeChangedAt: state.autoTradeChangedAt,
          state_file: TRADE_CONTROL_STATE_FILE,
        }),
      );
    } catch (e) {
      state.autoTradeEnabled = false;
      state.autoTradeChangedAt = null;
      console.info(
        JSON.stringify({
          tag: "TRADE_CONTROL_STATE_LOAD_FAILED",
          ts: new Date().toISOString(),
          state_file: TRADE_CONTROL_STATE_FILE,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      console.info(
        JSON.stringify({
          tag: "TRADE_CONTROL_STATE_RESTORED",
          ts: new Date().toISOString(),
          autoTradeEnabled: state.autoTradeEnabled,
          autoTradeChangedAt: state.autoTradeChangedAt,
          state_file: TRADE_CONTROL_STATE_FILE,
        }),
      );
    }
  };
  const persistAutoTradeState = () => {
    try {
      mkdirSync(path.dirname(TRADE_CONTROL_STATE_FILE), { recursive: true });
      writeFileSync(
        TRADE_CONTROL_STATE_FILE,
        JSON.stringify(
          {
            autoTradeEnabled: state.autoTradeEnabled,
            autoTradeChangedAt: state.autoTradeChangedAt,
            strategyPositions: state.strategyPositions,
            legacyBuckets: state.legacyBuckets,
          },
          null,
          2,
        ),
        "utf8",
      );
      console.info(
        JSON.stringify({
          tag: "TRADE_CONTROL_STATE_SAVED",
          ts: new Date().toISOString(),
          autoTradeEnabled: state.autoTradeEnabled,
          autoTradeChangedAt: state.autoTradeChangedAt,
          state_file: TRADE_CONTROL_STATE_FILE,
        }),
      );
    } catch (e) {
      console.info(
        JSON.stringify({
          tag: "TRADE_CONTROL_STATE_SAVE_FAILED",
          ts: new Date().toISOString(),
          state_file: TRADE_CONTROL_STATE_FILE,
          autoTradeEnabled: state.autoTradeEnabled,
          autoTradeChangedAt: state.autoTradeChangedAt,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };
  loadPersistedAutoTradeState();

  const computeKrwFunds = (conn: ConnectionResult) => {
    const krwAcc = conn.balances.find((b) => b.currency === "KRW");
    const krwAvailable = Number(krwAcc?.balance ?? conn.krw_available ?? 0);
    const krwLocked = Number(krwAcc?.locked ?? 0);
    const totalKrw = Math.max(0, krwAvailable + krwLocked);
    const strategyAllocatedKrw = Math.max(
      0,
      Object.values(state.strategyPositions).reduce((acc, p) => acc + Math.max(0, Number(p.qty ?? 0) * Math.max(0, Number(p.avg ?? 0))), 0),
    );
    const reservedKrw = Math.max(0, krwLocked + (state.inFlight ? TEST_ORDER_KRW : 0));
    const protectiveReserveKrw = Math.max(0, Number(process.env.ORBITALPHA_TRADING_PROTECTIVE_RESERVE_KRW ?? 30_000));
    const pumpPaperAllocatedKrw = Math.max(0, Number(process.env.ORBITALPHA_TRADING_PUMP_PAPER_ALLOCATED_KRW ?? 50_000));
    const liveOrderAvailableKrw = Math.max(0, totalKrw - protectiveReserveKrw - strategyAllocatedKrw - reservedKrw);
    return {
      total_krw: totalKrw,
      live_order_available_krw: liveOrderAvailableKrw,
      reserved_krw: reservedKrw,
      strategy_allocated_krw: strategyAllocatedKrw,
      pump_paper_allocated_krw: pumpPaperAllocatedKrw,
      protective_reserve_krw: protectiveReserveKrw,
    };
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

  const statusLightweight = async (): Promise<LightweightStatus> => {
    const conn = await getConnectionStatus();
    if (conn.connected && Array.isArray(conn.balances) && conn.balances.length > 0) {
      reconcileAuthoritativeStrategyBook(conn.balances);
    }
    syncLegacyBuckets(conn.balances);

    const now = new Date();
    const { hour: kstHour, minute: kstMin } = getKstTime(now);
    const kstMinutes = kstHour * 60 + kstMin;
    const entry_time_window_open = !(kstMinutes >= 0 && kstMinutes < 510);
    let next_entry_allowed_at_kst = "";
    if (!entry_time_window_open) {
      next_entry_allowed_at_kst = `${getKstDateString(now)} 08:30:00 KST`;
    } else {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      next_entry_allowed_at_kst = `${getKstDateString(tomorrow)} 08:30:00 KST`;
    }

    return {
      api_connected: conn.connected,
      api_reason: conn.reason,
      account_sync_failure_code: conn.connected ? null : conn.failure_code,
      account_sync_failure_message: conn.connected ? null : conn.reason,
      auto_trade_enabled: state.autoTradeEnabled,
      auto_trade_changed_at: state.autoTradeChangedAt,
      live_enabled: isLiveEnabled(),
      recovery_ready: state.recoveryReady,
      env_access_key_present: Boolean(env.upbitAccessKey),
      env_secret_key_present: Boolean(env.upbitSecretKey),
      krw_available: conn.krw_available,
      balances: conn.balances,
      entry_time_window_open,
      next_entry_allowed_at_kst,
    };
  };

  /** 계좌 실물 수량(balance+locked)이 전략 장부보다 작거나 0이면 strategyPositions를 즉시 맞춘다(수동 청산·외부 매도 후 장부 유령 방지). */
  const reconcileAuthoritativeStrategyBook = (balances: ConnectionBalances) => {
    const zeroed: string[] = [];
    const clamped: string[] = [];
    const allStrategyMarkets = new Set([...MANAGED_MARKETS, ...Object.keys(state.strategyPositions)]);
    for (const market of allStrategyMarkets) {
      const currency = market.replace("KRW-", "");
      const account = balances.find((b) => b.currency === currency);
      const totalQty = Number(account?.balance ?? 0) + Number(account?.locked ?? 0);
      const pos = state.strategyPositions[market];
      const prevQty = Number(pos?.qty ?? 0);
      if (prevQty <= 0) continue;
      if (totalQty <= 0) {
        pos.qty = 0;
        pos.avg = 0;
        pos.entries = 0;
        pos.invested_krw_total = 0;
        zeroed.push(market);
        continue;
      }
      if (prevQty > totalQty + 1e-12) {
        const nextQty = Math.max(0, totalQty);
        const inv = Number(pos.invested_krw_total ?? 0);
        pos.qty = nextQty;
        if (nextQty <= 0) {
          pos.avg = 0;
          pos.entries = 0;
          pos.invested_krw_total = 0;
        } else if (prevQty > 0) {
          pos.invested_krw_total = Math.max(0, inv * (nextQty / prevQty));
        }
        clamped.push(market);
      }
    }
    return { zeroed, clamped };
  };

  const syncLegacyBuckets = (balances: ConnectionBalances) => {
    const allLegacyMarkets = new Set([...MANAGED_MARKETS, ...Object.keys(state.legacyBuckets)]);
    for (const market of allLegacyMarkets) {
      const currency = market.replace("KRW-", "");
      const account = balances.find((b) => b.currency === currency);
      const accountQty = Number(account?.balance ?? 0) + Number(account?.locked ?? 0);
      const strategyQty = Number(state.strategyPositions[market].qty ?? 0);
      const legacyQty = Math.max(0, accountQty - strategyQty);
      const bucket = state.legacyBuckets[market];
      bucket.qty = legacyQty;
      bucket.avg = legacyQty > 0 ? Number(account?.avg_buy_price ?? 0) : 0;
      if (legacyQty <= 0) {
        bucket.exit_stage = 0;
        bucket.exit_status = "평단 복귀 대기";
        bucket.dca_locked = false;
        bucket.next_dca_at = null;
        bucket.dca_count = 0;
        bucket.dca_krw_total = 0;
      }
    }
  };

  const ensureOrderCommonAllowed = async (market: string, confirm: boolean, bucket: PositionBucket = "strategy") => {
    if (bucket === "legacy" && !ALLOWED_MARKETS.has(market)) throw new Error("Legacy bucket market is not managed");
    if (bucket === "strategy" && !market.startsWith("KRW-")) throw new Error("Only KRW-* market is allowed");
    if (!confirm) throw new Error("confirm=true required");
    if (!isLiveEnabled()) throw new Error("Live trading is disabled by environment guards");
    if (state.inFlight) throw new Error("Another order is in progress");
    const conn = await getConnectionStatus();
    if (!conn.connected) throw new Error(conn.reason ?? "Connection failed");
    reconcileAuthoritativeStrategyBook(conn.balances);
    syncLegacyBuckets(conn.balances);
    return conn;
  };

  const ensureEntryAllowed = async (side: TradeOrderSide, market: string, confirm: boolean, bucket: PositionBucket = "strategy") => {
    if (!state.autoTradeEnabled) throw new Error("Auto trade is disabled");
    const conn = await ensureOrderCommonAllowed(market, confirm, bucket);
    const now = Date.now();
    if (now - state.lastOrderAtMs < COOLDOWN_MS) throw new Error(`Cooldown active: wait ${COOLDOWN_MS}ms`);
    const key = `${side}:${market}:${Math.floor(now / 1000)}`;
    if (state.lastOrderKey === key) throw new Error("Duplicate order blocked");
    if (side === "buy" && bucket === "strategy") {
      const p = state.strategyPositions[market];
      const openingNewMarket = (p?.qty ?? 0) <= 0;
      if (openingNewMarket) {
        const openPositions = Object.entries(state.strategyPositions).filter(([m, x]) => {
          if (x.qty <= 0) return false;
          if (m === "KRW-TRUST") return true;
          const evalKrw = x.qty * x.avg;
          const isDust = evalKrw < 5000 || x.qty < 0.0001;
          if (isDust) {
            console.info(JSON.stringify({
              tag: "SPOT_DUST_POSITION_EXCLUDED_FROM_SLOT_PROOF",
              ts: new Date().toISOString(),
              market: m,
              qty: x.qty,
              eval_krw: evalKrw,
              reason: "dust_evaluation_excluded_from_slot_count"
            }));
            return false;
          }
          return true;
        }).length;
        if (openPositions >= MAX_CONCURRENT_STRATEGY_POSITIONS) {
          throw new Error(`Max concurrent strategy positions is ${MAX_CONCURRENT_STRATEGY_POSITIONS}`);
        }
      }
      if (p && p.entries >= ORDER_LIMITS.MAX_STRATEGY_ENTRIES_PER_MARKET) {
        throw new Error(`Additional entry limit reached for ${market}`);
      }
    }
    if (side === "buy" && bucket === "legacy") {
      const lb = state.legacyBuckets[market as ManagedMarket];
      if (lb.dca_locked || lb.dca_count >= lb.dca_max) {
        throw new Error(`Legacy DCA limit reached for ${market}`);
      }
    }
    return conn;
  };

  const ensureExitAllowed = async (side: TradeOrderSide, market: string, confirm: boolean, bucket: PositionBucket = "strategy") => {
    const conn = await ensureOrderCommonAllowed(market, confirm, bucket);
    const pos = state.strategyPositions[market];
    const legacyPos = state.legacyBuckets[market as ManagedMarket];
    const baseQty = bucket === "legacy" ? legacyPos?.qty ?? 0 : pos?.qty ?? 0;
    if (!Number.isFinite(baseQty) || baseQty <= 0) {
      throw new Error(`No ${bucket} position to sell for ${market}`);
    }
    return conn;
  };

  const setAutoTradeEnabled = async (enabled: boolean, meta?: { isOperator?: boolean }) => {
    const isOperator = meta?.isOperator === true;
    if (!enabled && !isOperator) {
      console.info(
        JSON.stringify({
          tag: "TRADE_CONTROL_DISABLE_REJECTED_NON_OPERATOR",
          ts: new Date().toISOString(),
          reason: "Auto-trade disable requires explicit operator action",
        }),
      );
      return;
    }

    if (isOperator) {
      console.info(
        JSON.stringify({
          tag: "AUTO_TRADE_OPERATOR_TOGGLE_PROOF",
          ts: new Date().toISOString(),
          target_state: enabled ? "ON" : "OFF",
        }),
      );
    }

    state.autoTradeEnabled = enabled;
    state.autoTradeChangedAt = new Date().toISOString();
    persistAutoTradeState();
    await log(enabled ? "auto_trade_enabled" : "auto_trade_disabled", { 
      enabled, 
      changed_at: state.autoTradeChangedAt, 
      is_operator: isOperator 
    });
    await hooks?.onEvent?.({
      timestamp: state.autoTradeChangedAt ?? new Date().toISOString(),
      event_type: enabled ? "auto_trade_enabled" : "auto_trade_disabled",
      market: null,
      strategy_type: null,
      market_state: null,
      side: null,
      reason: isOperator ? (enabled ? "OPERATOR_ON" : "OPERATOR_OFF") : (enabled ? "ON" : "OFF"),
      balance_krw: null,
      position_qty: null,
      avg_buy_price: null,
      current_price: null,
      pnl_net: null,
      pnl_net_pct: null,
      note: isOperator ? "operator_action" : null,
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

  const placeBuy = async (
    market: string,
    confirm: boolean,
    amountKrw = TEST_ORDER_KRW,
    strategyType: StrategyType = "stable",
    bucket: PositionBucket = "strategy",
    signalPayload?: unknown,
    path?: string,
    logicalOrderId?: string,
  ) => {
    if (state.dailyRiskKillSwitchActive) {
      console.info(
        JSON.stringify({
          tag: "ENTRY_DAILY_RISK_BLOCK",
          ts: new Date().toISOString(),
          market,
          blocked_before_placebuy: true,
          reason: "daily_risk_kill_switch_active",
        })
      );
      throw new Error("daily_risk_kill_switch_active");
    }

    // 00:00 ~ 08:30 KST 신규 진입 차단 필터
    const now = new Date();
    const { hour: kstHour, minute: kstMin } = getKstTime(now);
    const kstMinutes = kstHour * 60 + kstMin;
    const isNightBlocked = kstMinutes >= 0 && kstMinutes < 510;

    if (isNightBlocked) {
      let finalPath = path;
      if (!finalPath) {
        if (signalPayload && typeof signalPayload === "object") {
          const sp = signalPayload as any;
          if (sp.__early_promote_fill) finalPath = "early_promote_fill";
          else if (sp.__rescue_add) finalPath = "rescue_add";
          else if (sp.__early_entry) finalPath = "early_entry";
          else if (sp.surge_entry_mode || sp.__surge_stop_price) finalPath = "surge_normal";
          else finalPath = "normal";
        } else {
          finalPath = "normal";
        }
      }

      console.info(
        JSON.stringify({
          tag: "ENTRY_TIME_WINDOW_BLOCK",
          ts: now.toISOString(),
          market,
          path: finalPath,
          kst_hour: kstHour,
          kst_minute: kstMin,
          blocked_before_placebuy: true,
          reason: "night_low_liquidity_window",
        })
      );
      throw new Error("night_low_liquidity_window");
    }
    const posPre = state.strategyPositions[market as keyof typeof state.strategyPositions];
    const strategyQtyPre = Number(posPre?.qty ?? 0);
    const isAdditionalBuy = bucket === "legacy" || strategyQtyPre > 0;
    await hooks?.assertBuyGate?.({
      market,
      bucket,
      isAdditionalBuy,
      signalPayload,
      strategyType,
    });
    if (bucket === "legacy") {
      const lb = state.legacyBuckets[market as ManagedMarket];
      if (lb.dca_locked || lb.dca_count >= lb.dca_max) {
        throw new Error(`Legacy DCA limit reached for ${market}`);
      }
      if (lb.dca_krw_total + amountKrw > ORDER_LIMITS.MAX_LEGACY_DCA_KRW_PER_MARKET) {
        throw new Error(`Legacy DCA KRW limit exceeded for ${market}`);
      }
    }
    if (bucket === "strategy") {
      const posPre = state.strategyPositions[market];
      const curInv = Number(posPre?.invested_krw_total ?? 0);
      if (curInv + amountKrw > ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET) {
        throw new Error(`Strategy invested KRW limit exceeded for ${market}`);
      }
    }
    const conn = await ensureEntryAllowed("buy", market, confirm, bucket);
    const funds = computeKrwFunds(conn);
    if (funds.live_order_available_krw < 5000) throw new Error("Live order available KRW is below minimum order amount");
    if (funds.live_order_available_krw < amountKrw) throw new Error(`Not enough live-order KRW. available=${funds.live_order_available_krw}`);
    state.inFlight = true;
    state.inFlightBuyMarket = market;
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
        balance_krw: funds.total_krw,
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
        identifier: logicalOrderId,
      });
      const snap: TradeOrderSnapshot = {
        ts: new Date().toISOString(),
        market,
        side: "buy",
        amount_krw: amountKrw,
        status: "ok",
        detail: rsp.state,
        order_uuid: rsp.uuid,
        identifier: rsp.identifier || logicalOrderId,
      };
      markOrderResult(snap);
      let executed = Number(rsp.executed_volume ?? "0");

      // [FIX] executed_volume=0 시 UUID 기반 주문 재조회로 실제 체결량 확인 (최대 2회, 300ms 간격)
      if (bucket === "strategy" && !(executed > 0) && rsp.uuid && env.upbitAccessKey && env.upbitSecretKey) {
        console.error(
          JSON.stringify({
            tag: "TRADE_CONTROL_EXECUTED_VOLUME_ZERO_WARNING",
            ts: new Date().toISOString(),
            market,
            order_uuid: rsp.uuid,
            raw_executed_volume: rsp.executed_volume,
            amount_krw: amountKrw,
            reason: "executed_volume_zero_on_initial_response_attempting_retry",
          }),
        );
        for (let retryIdx = 0; retryIdx < 2; retryIdx++) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const orderDetail = await fetchOrderDetails(env.upbitAccessKey, env.upbitSecretKey, rsp.uuid);
            const retryExecuted = Number(orderDetail?.executed_volume ?? "0");
            console.info(
              JSON.stringify({
                tag: "TRADE_CONTROL_BUY_FILL_RESOLVED_AFTER_RETRY",
                ts: new Date().toISOString(),
                market,
                order_uuid: rsp.uuid,
                retry_index: retryIdx,
                retry_executed_volume: retryExecuted,
                order_state: orderDetail?.state ?? null,
                resolved: retryExecuted > 0,
              }),
            );
            if (retryExecuted > 0) {
              executed = retryExecuted;
              break;
            }
          } catch (retryErr) {
            console.error(
              JSON.stringify({
                tag: "TRADE_CONTROL_BUY_FILL_RETRY_FETCH_ERROR",
                ts: new Date().toISOString(),
                market,
                order_uuid: rsp.uuid,
                retry_index: retryIdx,
                error: retryErr instanceof Error ? retryErr.message.slice(0, 200) : String(retryErr).slice(0, 200),
              }),
            );
          }
        }
        if (!(executed > 0)) {
          console.error(
            JSON.stringify({
              tag: "TRADE_CONTROL_BUY_FILL_UNRESOLVED_PENDING",
              ts: new Date().toISOString(),
              market,
              order_uuid: rsp.uuid,
              amount_krw: amountKrw,
              reason: "executed_volume_still_zero_after_2_retries_skipping_qty_registration",
              action: "strategyPositions qty NOT updated to avoid phantom zero-qty position",
            }),
          );
        }
      }

      if (bucket === "strategy" && !state.strategyPositions[market]) {
        state.strategyPositions[market] = {
          qty: 0, avg: 0, entries: 0, invested_krw_total: 0, realized_pnl: 0,
          strategy_type: strategyType,
          stop_loss_pct: STRATEGY_RISK_CONFIG[strategyType].stop_loss_pct,
          breakeven_arm_pct: STRATEGY_RISK_CONFIG[strategyType].breakeven_arm_pct,
          partial_take_profit_pct: STRATEGY_RISK_CONFIG[strategyType].partial_take_profit_pct,
          trailing_from_peak_pct: STRATEGY_RISK_CONFIG[strategyType].trailing_from_peak_pct
        };
      }
      const pos = state.strategyPositions[market];
      if (bucket === "strategy" && pos && Number.isFinite(executed) && executed > 0) {
        const nextQty = pos.qty + executed;
        const nextCost = pos.qty * pos.avg + amountKrw;
        pos.qty = nextQty;
        pos.avg = nextQty > 0 ? nextCost / nextQty : 0;
        pos.entries += 1;
        pos.invested_krw_total = (pos.invested_krw_total ?? 0) + amountKrw;
        pos.strategy_type = strategyType;
        const rule = strategyType === "momentum" ? STRATEGY_RISK_CONFIG.momentum : STRATEGY_RISK_CONFIG.stable;
        pos.stop_loss_pct = rule.stop_loss_pct;
        pos.breakeven_arm_pct = rule.breakeven_arm_pct;
        pos.partial_take_profit_pct = rule.partial_take_profit_pct;
        pos.trailing_from_peak_pct = rule.trailing_from_peak_pct;
        
        if (signalPayload && typeof signalPayload === "object") {
          const sp = signalPayload as any;
          if (sp.strict_exit === true) pos.strict_exit = true;
          if (sp.exit_policy_attached === true) pos.exit_policy_attached = true;
          if (typeof sp.surge_entry_mode === "string") pos.surge_entry_mode = sp.surge_entry_mode;
          if (typeof sp.surge_stop_price === "number") pos.surge_stop_price = sp.surge_stop_price;
          if (typeof sp.surge_take_profit_price === "number") pos.surge_take_profit_price = sp.surge_take_profit_price;
          if (typeof sp.surge_trailing_start_pct === "number") pos.surge_trailing_start_pct = sp.surge_trailing_start_pct;
          if (typeof sp.surge_trailing_gap_pct === "number") pos.surge_trailing_gap_pct = sp.surge_trailing_gap_pct;
          if (typeof sp.entry_stop_price === "number") pos.entry_stop_price = sp.entry_stop_price;
          if (typeof sp.entry_target_price === "number") pos.entry_target_price = sp.entry_target_price;
          if (typeof sp.entry_risk_reward === "number") pos.entry_risk_reward = sp.entry_risk_reward;

          if (sp.exit_policy_attached) {
            console.info(JSON.stringify({
              tag: "TRADE_CONTROL_EXIT_POLICY_ATTACHED_PROOF",
              ts: new Date().toISOString(),
              market,
              strict_exit: pos.strict_exit,
              exit_policy_attached: pos.exit_policy_attached,
              surge_stop_price: pos.surge_stop_price,
              surge_take_profit_price: pos.surge_take_profit_price,
              surge_trailing_start_pct: pos.surge_trailing_start_pct,
              surge_trailing_gap_pct: pos.surge_trailing_gap_pct,
            }));
          }
        }
      }
      if (bucket === "legacy") {
        if (!state.legacyBuckets[market]) {
          state.legacyBuckets[market] = {
            qty: 0, avg: 0, dca_count: 0, dca_max: ORDER_LIMITS.MAX_LEGACY_DCA_COUNT_PER_MARKET,
            dca_krw_total: 0, dca_locked: false, next_dca_at: null, exit_stage: 0, exit_status: "평단 복귀 대기"
          };
        }
        const lb = state.legacyBuckets[market];
        lb.dca_krw_total += amountKrw;
        lb.dca_count = Math.min(lb.dca_count + 1, lb.dca_max);
        lb.dca_locked = lb.dca_count >= lb.dca_max;
        lb.next_dca_at = new Date(Date.now() + 20 * 60_000).toISOString();
        lb.exit_status = lb.exit_stage === 0 ? "평단 복귀 대기" : lb.exit_stage === 1 ? "1차 탈출" : "분할 청산 중";
      }
      await log("manual_buy_response", { market, amount_krw: amountKrw, order: rsp });
      persistAutoTradeState();
      await hooks?.onEvent?.({
        timestamp: snap.ts,
        event_type: "order_filled",
        market,
        strategy_type: bucket === "legacy" ? "legacy" : strategyType,
        market_state: null,
        side: "buy",
        reason: "manual_buy_response",
        balance_krw: Math.max(0, funds.total_krw - amountKrw),
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
        balance_krw: funds.total_krw,
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
      state.inFlightBuyMarket = null;
    }
  };

  const placeSell = async (market: string, confirm: boolean, ratio = 1, bucket: PositionBucket = "strategy") => {
    const conn = await ensureExitAllowed("sell", market, confirm, bucket);
    state.inFlight = true;
    state.inFlightBuyMarket = null;
    try {
      const pos = state.strategyPositions[market];
      const legacyPos = state.legacyBuckets[market];
      const baseQty = bucket === "legacy" ? legacyPos?.qty ?? 0 : pos?.qty ?? 0;
      const volume = baseQty * Math.min(1, Math.max(0.01, ratio));
      if (!Number.isFinite(volume) || volume <= 0) throw new Error(`No ${bucket} position to sell for ${market}`);

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
      if (bucket === "strategy" && pos) {
        const prevQty = pos.qty;
        const remain = Math.max(0, pos.qty - volume);
        pos.qty = remain;
        if (remain <= 0) {
          pos.avg = 0;
          pos.entries = 0;
          pos.invested_krw_total = 0;
        } else if (prevQty > 0) {
          pos.invested_krw_total = Math.max(0, (pos.invested_krw_total ?? 0) * (remain / prevQty));
        }
      }
      if (bucket === "legacy" && legacyPos) {
        const prevLQty = legacyPos.qty;
        const remain = Math.max(0, legacyPos.qty - volume);
        legacyPos.qty = remain;
        if (remain <= 0) {
          legacyPos.avg = 0;
          legacyPos.exit_stage = 0;
          legacyPos.exit_status = "평단 복귀 대기";
          legacyPos.dca_krw_total = 0;
          legacyPos.dca_count = 0;
          legacyPos.dca_locked = false;
        } else {
          if (prevLQty > 0) {
            legacyPos.dca_krw_total = Math.max(0, legacyPos.dca_krw_total * (remain / prevLQty));
          }
          legacyPos.exit_stage = legacyPos.exit_stage >= 2 ? 2 : (legacyPos.exit_stage + 1) as 0 | 1 | 2;
          legacyPos.exit_status = legacyPos.exit_stage === 0 ? "평단 복귀 대기" : legacyPos.exit_stage === 1 ? "1차 탈출" : "분할 청산 중";
        }
      }
      await log("manual_sell_response", { market, volume, order: rsp });
      persistAutoTradeState();
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
      state.inFlightBuyMarket = null;
    }
  };

  const status = async () => {
    const conn = await getConnectionStatus();
    const strategyPositions = Object.fromEntries(
      Object.entries(state.strategyPositions).filter(([m, x]) => {
        if (x.qty <= 0) return false;
        if (m === "KRW-TRUST") return true;
        const evalKrw = x.qty * x.avg;
        const isDust = evalKrw < 5000 || x.qty < 0.0001;
        if (isDust) {
          console.info(JSON.stringify({
            tag: "SPOT_ACCOUNT_HOLDING_CLASSIFICATION_PROOF",
            ts: new Date().toISOString(),
            market: m,
            qty: x.qty,
            eval_krw: evalKrw,
            reason: "classified_as_dust_in_status_read"
          }));
          return false;
        }
        return true;
      })
    );
    let ledger_reconcile: { zeroed: string[]; clamped: string[] } | null = null;
    if (conn.connected && Array.isArray(conn.balances) && conn.balances.length > 0) {
      ledger_reconcile = reconcileAuthoritativeStrategyBook(conn.balances);
    }
    syncLegacyBuckets(conn.balances);
    const funds = computeKrwFunds(conn);

      let account_portfolio: AccountPortfolioSnapshot | null = null;
      let mark_prices: Record<string, number> | null = null;
      type PricingDebugRow = {
        avg_buy_price: number;
        quantity: number;
        current_price_used_for_display: number;
        current_price_used_for_sell_decision: number;
        pnl_percent_display: number;
        pnl_percent_sell_decision: number;
        net_pnl_percent_after_fees: number;
        intended_sell_ratio: null;
        intended_sell_qty: null;
        intended_sell_value_krw: null;
        blocked_reason: null;
        ticker_from_rest_this_request: boolean;
      };
      let pricing_debug: Record<string, PricingDebugRow> | null = null;
      let mark_prices_stale = false;
      let market_data_degraded = false;
      let valuation_unavailable = false;
      let market_data_failure_code: string | null = null;
      let market_data_failure_message: string | null = null;
      if (conn.connected) {
        const rawBalances = Array.isArray(conn.balances) ? conn.balances : [];
        const balanceRows = rawBalances.map((b) => ({
          currency: normalizeBalanceCurrency(b.currency),
          balance: Number(b.balance),
          locked: Number(b.locked),
          avg_buy_price: Number(b.avg_buy_price),
        }));
        try {
          const marketDataTimeoutMs = Math.max(
            600,
            Math.min(2500, Number(process.env.ORBITALPHA_TRADE_STATUS_MARKET_DATA_TIMEOUT_MS ?? 1200)),
          );
          const timed = await Promise.race([
            resolveTickerPricesForBalances(balanceRows, state.lastGoodMarkPrices),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error("MARKET_DATA_TIMEOUT")), marketDataTimeoutMs),
            ),
          ]);
          const { merged, rest_fresh_markets } = timed;
          state.lastGoodMarkPrices = merged;
          const effective = buildEffectiveValuationPriceMap(balanceRows, merged);
          const snap = computeAccountValuationFromPrices(balanceRows, effective, new Date().toISOString());
          account_portfolio = sanitizeAccountPortfolioSnapshot(snap.portfolio);
          mark_prices = snap.mark_prices;
          const dbg: Record<string, any> = {};
          const marketsToEvaluate = new Set<string>(MANAGED_MARKETS);
          for (const row of balanceRows) {
            if (row.currency === "KRW") continue;
            marketsToEvaluate.add(marketCodeForCurrency(row.currency));
          }

          for (const m of marketsToEvaluate) {
            const cur = m.replace("KRW-", "");
            const row = balanceRows.find((r) => r.currency === cur);
            const qty = row ? row.balance + row.locked : 0;
            const avg = row ? row.avg_buy_price : 0;
            
            // 0원 표시 방지용 Fallback 체인 적용
            let mark = effective[m] ?? 0;
            const fromRest = rest_fresh_markets.has(m);
            
            // 만약 보유/관리 종목인데도 가격을 구하지 못했다면 lastGoodTickerCache나 candle close를 강제 적용
            if (mark <= 0 && (MANAGED_MARKETS.includes(m as any) || qty > 0)) {
              const lg = lastGoodTickerCache.get(m);
              if (lg && lg.trade_price > 0) {
                mark = lg.trade_price;
              } else {
                const candle = peekMinuteCandleCache(m, 1, 1);
                if (candle && candle.rows.length > 0) {
                  mark = candle.rows[0].trade_price;
                }
              }
            }
            
            if (qty > 0 && mark > 0 && !fromRest) mark_prices_stale = true;
            
            // missing 판정
            const isMissing = mark <= 0;
            
            const gd = qty > 0 && avg > 0 && mark > 0 ? grossPnlPct(avg, mark) : 0;
            const nd = qty > 0 && avg > 0 && mark > 0 ? netPnlPctPerUnit(avg, mark) : 0;
            dbg[m] = {
              avg_buy_price: avg,
              quantity: qty,
              current_price_used_for_display: isMissing ? null : mark, // 0 대신 null
              current_price_used_for_sell_decision: isMissing ? null : mark,
              pnl_percent_display: gd,
              pnl_percent_sell_decision: gd,
              net_pnl_percent_after_fees: nd,
              intended_sell_ratio: null,
              intended_sell_qty: null,
              intended_sell_value_krw: null,
              blocked_reason: null,
              ticker_from_rest_this_request: fromRest,
              price_status: isMissing ? "missing" : (fromRest ? "live" : "stale"),
              price_source: isMissing ? "missing" : (fromRest ? "live" : (tickerSourceMap.get(m) ?? "last_good_cache")),
            };
          }
          pricing_debug = dbg;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          market_data_degraded = true;
          valuation_unavailable = true;
          market_data_failure_code = /429|too_many_requests/i.test(msg)
            ? "ticker_rate_limited"
            : /timeout|aborted|MARKET_DATA_TIMEOUT/i.test(msg)
              ? "ticker_timeout"
              : "ticker_fetch_failed";
          market_data_failure_message = msg.slice(0, 280);
          await log("account_valuation_error", { error: msg.slice(0, 400) });
          const effective = buildEffectiveValuationPriceMap(balanceRows, state.lastGoodMarkPrices ?? {});
          const snap = computeAccountValuationFromPrices(balanceRows, effective, new Date().toISOString());
          account_portfolio = sanitizeAccountPortfolioSnapshot(snap.portfolio);
          mark_prices = snap.mark_prices;
          mark_prices_stale = true;
        }
        if (account_portfolio === null) {
          const br = (Array.isArray(conn.balances) ? conn.balances : []).map((b) => ({
            currency: normalizeBalanceCurrency(b.currency),
            balance: Number(b.balance),
            locked: Number(b.locked),
            avg_buy_price: Number(b.avg_buy_price),
          }));
          const eff = buildEffectiveValuationPriceMap(br, state.lastGoodMarkPrices ?? {});
          const snap = computeAccountValuationFromPrices(br, eff, new Date().toISOString());
          account_portfolio = sanitizeAccountPortfolioSnapshot(snap.portfolio);
          mark_prices = snap.mark_prices;
          mark_prices_stale = true;
        }
      }
      const allKnownMarkets = new Set([...MANAGED_MARKETS, ...Object.keys(state.legacyBuckets), ...Object.keys(state.strategyPositions)]);
      const legacyPositions = Object.fromEntries(
        [...allKnownMarkets].map((market) => [
          market,
          {
            market,
            qty: state.legacyBuckets[market]?.qty ?? 0,
            avg: state.legacyBuckets[market]?.avg ?? 0,
            stop_loss_disabled: true,
            dca_count: state.legacyBuckets[market]?.dca_count ?? 0,
            dca_max: state.legacyBuckets[market]?.dca_max ?? 0,
            dca_available: !state.legacyBuckets[market]?.dca_locked,
            dca_krw_total: state.legacyBuckets[market]?.dca_krw_total ?? 0,
            dca_krw_cap: ORDER_LIMITS.MAX_LEGACY_DCA_KRW_PER_MARKET,
            next_dca_at: state.legacyBuckets[market]?.next_dca_at ?? null,
            exit_status: state.legacyBuckets[market]?.exit_status ?? "평단 복귀 대기",
          },
        ]),
      );
    const mpForCap = mark_prices && typeof mark_prices === "object" ? mark_prices : {};
    const capitalV4 = computeLiveCapitalPolicyV4({
      balances: conn.balances ?? [],
      markPriceOrAvgByMarket: (mk, avgFb) => {
        const px = Number((mpForCap as Record<string, number>)[mk]);
        return Number.isFinite(px) && px > 0 ? px : Number.isFinite(avgFb) && avgFb > 0 ? avgFb : 0;
      },
      accountPortfolioTotalEvaluatedKrw: account_portfolio?.total_evaluated_krw ?? null,
      totalKrwFallback: funds.total_krw,
      reservedKrw: funds.reserved_krw,
      inFlightMarket: state.inFlightBuyMarket,
      inFlight: state.inFlight && state.inFlightBuyMarket != null,
    });
    let missing_count = 0;
    const missing_markets: string[] = [];

    const mappedBalances = (conn.balances ?? []).map((b) => {
      const isKrw = b.currency === "KRW";
      if (isKrw) {
        return {
          ...b,
          qty: Number(b.balance) + Number(b.locked),
          current_price: 1,
          pnl_krw: 0,
          pnl_pct: 0,
          price_status: "live" as const,
          price_source: "live" as const,
        };
      }
      const m = marketCodeForCurrency(b.currency);
      const qty = Number(b.balance) + Number(b.locked);
      const avg = Number(b.avg_buy_price ?? 0);
      
      let currentPrice: number | null = null;
      let priceSource: "live" | "last_good_cache" | "candle_fallback" | "missing" | "fresh_cache" | "cache" = "missing";
      let priceStatus: "live" | "stale" | "missing" = "missing";
      
      // pricing_debug 또는 state.lastGoodMarkPrices 에서 가격 획득
      if (state.lastGoodMarkPrices && state.lastGoodMarkPrices[m] && state.lastGoodMarkPrices[m] > 0) {
        currentPrice = state.lastGoodMarkPrices[m];
        // pricing_debug의 값과 tickerSourceMap을 대조하여 live/stale 판정
        const sourceFromMap = tickerSourceMap.get(m);
        priceSource = sourceFromMap === "live" ? "live" : (sourceFromMap ?? "last_good_cache");
        priceStatus = sourceFromMap === "live" ? "live" : "stale";
      }
      
      // 보유/관리종목 0원 표시 방지 강제 적용
      if (!currentPrice && (MANAGED_MARKETS.includes(m as any) || qty > 0)) {
        const lg = lastGoodTickerCache.get(m);
        if (lg && lg.trade_price > 0) {
          currentPrice = lg.trade_price;
          priceSource = "last_good_cache";
          priceStatus = "stale";
        } else {
          const candle = peekMinuteCandleCache(m, 1, 1);
          if (candle && candle.rows.length > 0) {
            currentPrice = candle.rows[0].trade_price;
            priceSource = "candle_fallback";
            priceStatus = "stale";
          }
        }
      }
      
      if (currentPrice && currentPrice > 0) {
        const evalPnlKrw = (currentPrice - avg) * qty;
        const evalPnlPct = avg > 0 ? ((currentPrice - avg) / avg) * 100 : 0;
        return {
          ...b,
          qty,
          current_price: currentPrice,
          pnl_krw: evalPnlKrw,
          pnl_pct: evalPnlPct,
          price_status: priceStatus,
          price_source: priceSource,
        };
      } else {
        missing_count++;
        missing_markets.push(m);
        return {
          ...b,
          qty,
          current_price: null,
          pnl_krw: null,
          pnl_pct: null,
          price_status: "missing" as const,
          price_source: "missing" as const,
        };
      }
    });

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
      total_krw: funds.total_krw,
      live_order_available_krw: funds.live_order_available_krw,
      reserved_krw: funds.reserved_krw,
      strategy_allocated_krw: funds.strategy_allocated_krw,
      pump_paper_allocated_krw: funds.pump_paper_allocated_krw,
      protective_reserve_krw: funds.protective_reserve_krw,
      balances: mappedBalances,
      missing_count,
      missing_markets,
      price_status: market_data_degraded ? "degraded" : (mark_prices_stale ? "stale" : "live"),
      price_source: market_data_degraded ? "degraded_fallback" : (mark_prices_stale ? "last_good_cache" : "live"),
      test_order_krw: TEST_ORDER_KRW,
      order_limits: ORDER_LIMITS,
      cooldown_ms: COOLDOWN_MS,
      test_market: state.testMarket,
      last_order: state.lastOrder,
      last_error: state.lastError,
      in_flight: state.inFlight,
      in_flight_buy_market: state.inFlightBuyMarket,
      auto_trade_enabled: state.autoTradeEnabled,
      auto_trade_changed_at: state.autoTradeChangedAt,
      recovery_ready: state.recoveryReady,
      strategy_rules: STRATEGY_RULES,
      strategy_risk_rules: STRATEGY_RISK_CONFIG,
      legacy_position: {
        market: "KRW-XRP",
        qty: legacyPositions["KRW-XRP"].qty,
        avg: legacyPositions["KRW-XRP"].avg,
        excluded_from_strategy: true,
      },
      legacy_positions: legacyPositions,
      strategy_positions: strategyPositions,
      ledger_reconcile,
      pnl_summary: {
        legacy_position_pnl: null,
        strategy_position_pnl: Object.values(strategyPositions).reduce((acc, p) => acc + p.realized_pnl, 0),
        total_pnl: null,
      },
      account_portfolio,
      mark_prices,
      mark_prices_stale,
      market_data_degraded,
      valuation_unavailable,
      market_data_failure_code,
      market_data_failure_message,
      pricing_debug,
      spot_trading_equity_krw: capitalV4.spotTradingEquityKrw,
      excluded_usdt_value_krw: capitalV4.excludedUsdtValueKrw,
      okx_transfer_reserve_krw: capitalV4.okxTransferReserveKrw,
      total_asset_equity_krw: capitalV4.totalAssetEquityKrw,
      core_cap_amount: capitalV4.coreCapAmount,
      surge_cap_amount: capitalV4.surgeCapAmount,
      core_used_capital_krw: capitalV4.coreUsedCapitalKrw,
      surge_used_capital_krw: capitalV4.surgeUsedCapitalKrw,
      core_holdings_evaluation_krw: capitalV4.coreHoldingsEvaluationKrw,
      surge_holdings_evaluation_krw: capitalV4.surgeHoldingsEvaluationKrw,
      core_pending_buy_reserved_krw: capitalV4.corePendingBuyReservedKrw,
      surge_pending_buy_reserved_krw: capitalV4.surgePendingBuyReservedKrw,
      core_remaining_krw: capitalV4.coreRemainingKrw,
      surge_remaining_krw: capitalV4.surgeRemainingKrw,
      spotTradingEquityKrw: capitalV4.spotTradingEquityKrw,
      excludedUsdtValueKrw: capitalV4.excludedUsdtValueKrw,
      okxTransferReserveKrw: capitalV4.okxTransferReserveKrw,
      totalAssetEquityKrw: capitalV4.totalAssetEquityKrw,
      coreCapAmount: capitalV4.coreCapAmount,
      surgeCapAmount: capitalV4.surgeCapAmount,
      coreUsedCapital: capitalV4.coreUsedCapitalKrw,
      surgeUsedCapital: capitalV4.surgeUsedCapitalKrw,
      coreHoldingsEvaluationKrw: capitalV4.coreHoldingsEvaluationKrw,
      surgeHoldingsEvaluationKrw: capitalV4.surgeHoldingsEvaluationKrw,
      corePendingBuyReserved: capitalV4.corePendingBuyReservedKrw,
      surgePendingBuyReserved: capitalV4.surgePendingBuyReservedKrw,
      coreRemaining: capitalV4.coreRemainingKrw,
      surgeRemaining: capitalV4.surgeRemainingKrw,
      entry_time_window_open: (() => {
        const { hour, minute } = getKstTime(new Date());
        return !(hour * 60 + minute >= 0 && hour * 60 + minute < 510);
      })(),
      next_entry_allowed_at_kst: (() => {
        const now = new Date();
        const { hour, minute } = getKstTime(now);
        const isOpen = !(hour * 60 + minute >= 0 && hour * 60 + minute < 510);
        if (!isOpen) {
          return `${getKstDateString(now)} 08:30:00 KST`;
        } else {
          const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          return `${getKstDateString(tomorrow)} 08:30:00 KST`;
        }
      })(),
    };
  };

  return {
    status,
    statusLightweight,
    connectionCheck: getConnectionStatus,
    placeBuy,
    placeSell,
    setDailyRiskKillSwitch: (active: boolean) => {
      state.dailyRiskKillSwitchActive = active;
    },
    placeLegacyDcaBuy: (market: string, confirm: boolean, amountKrw = TEST_ORDER_KRW, signalPayload?: unknown) =>
      placeBuy(market, confirm, amountKrw, "stable", "legacy", signalPayload),
    placeLegacyExitSell: (market: string, confirm: boolean, ratio = 1) =>
      placeSell(market, confirm, ratio, "legacy"),
    setAutoTradeEnabled,
    setRecoveryReady,
    syncManagedPosition: async (market: string, qty: number, avg: number, strategyType: StrategyType, stopLossPct?: number, stopLossPrice?: number) => {
      const rule = strategyType === "momentum" ? STRATEGY_RISK_CONFIG.momentum : STRATEGY_RISK_CONFIG.stable;
      let finalStopLossPct = stopLossPct ?? rule.stop_loss_pct;
      let finalStopLossPrice = stopLossPrice;
      
      const existing = state.strategyPositions[market];
      
      if (!existing || existing.qty <= 0) {
        if (!(finalStopLossPrice! > 0) && avg > 0) {
          finalStopLossPrice = avg * (1 + finalStopLossPct / 100);
        }
        state.strategyPositions[market] = {
          qty,
          avg,
          entries: 1,
          invested_krw_total: qty * avg,
          realized_pnl: 0,
          strategy_type: strategyType,
          stop_loss_pct: finalStopLossPct,
          stop_loss_price: finalStopLossPrice,
          breakeven_arm_pct: rule.breakeven_arm_pct,
          partial_take_profit_pct: rule.partial_take_profit_pct,
          trailing_from_peak_pct: rule.trailing_from_peak_pct,
          profit_protected: false,
          partial_tp_count: 0,
          realized_partial_profit: 0,
        };
        persistAutoTradeState();
        return true;
      }

      // Update existing position
      finalStopLossPct = stopLossPct ?? existing.stop_loss_pct ?? rule.stop_loss_pct;
      if (!(finalStopLossPrice! > 0) && avg > 0) {
        finalStopLossPrice = avg * (1 + finalStopLossPct / 100);
      }
      
      const previousStopLossPrice = existing.stop_loss_price;
      
      existing.qty = qty;
      existing.avg = avg;
      existing.invested_krw_total = qty * avg;
      existing.strategy_type = strategyType;
      existing.stop_loss_pct = finalStopLossPct;
      existing.stop_loss_price = finalStopLossPrice;
      
      console.info(JSON.stringify({
        tag: "SPOT_MANAGED_POSITION_STOP_LOSS_BACKFILLED_PROOF",
        ts: new Date().toISOString(),
        market,
        qty,
        avg,
        previous_stop_loss_price: previousStopLossPrice ?? null,
        stop_loss_price: finalStopLossPrice,
        stop_loss_pct: finalStopLossPct,
        source: "syncManagedPosition"
      }));
      
      persistAutoTradeState();
      return true;
    },
    fetchOrderByIdentifier: async (identifier: string) => {
      if (!env.upbitAccessKey || !env.upbitSecretKey) throw new Error("Upbit API keys missing");
      return await fetchOrderByIdentifier(env.upbitAccessKey, env.upbitSecretKey, identifier);
    },
  };
}

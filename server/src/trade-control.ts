import type { Env } from "./env.js";
import {
  buildEffectiveValuationPriceMap,
  computeAccountValuationFromPrices,
  normalizeBalanceCurrency,
  resolveTickerPricesForBalances,
  sanitizeAccountPortfolioSnapshot,
  type AccountPortfolioSnapshot,
} from "./account-portfolio.js";
import { appendLog } from "./log-store.js";
import { fetchAccounts, placeMarketBuy, placeMarketSell, type UpbitAccount } from "./upbit-private.js";
import { companyIdSchema, serviceIdSchema } from "@orbitalpha/shared";
import type { StrategyType } from "./strategy-risk-config.js";
import { ORDER_LIMITS } from "@orbitalpha/shared";
import { STRATEGY_RISK_CONFIG, grossPnlPct, netPnlPctPerUnit } from "./strategy-risk-config.js";
import crypto from "node:crypto";

type TradeOrderSide = "buy" | "sell";
type PositionBucket = "strategy" | "legacy";
type ManagedMarket = "KRW-BTC" | "KRW-ETH" | "KRW-SOL" | "KRW-XRP" | "KRW-TRX";

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
      breakeven_arm_pct: number;
      partial_take_profit_pct: number;
      trailing_from_peak_pct: number;
    }
  >;
  legacyBuckets: Record<ManagedMarket, LegacyBucketState>;
};

const TEST_ORDER_KRW = 5000;
const COOLDOWN_MS = 20_000;
const ALLOWED_MARKETS = new Set(["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"]);
const MANAGED_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"] as const;
const MAX_CONCURRENT_STRATEGY_POSITIONS = (() => {
  const raw = process.env.LIVE_MAX_POSITIONS_CAP;
  const n = raw === undefined || raw === "" ? 6 : Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(12, Math.floor(n))) : 6;
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
    /** 매수 직전 — 시장 스냅샷·entry 게이트 재검사 (신규/추가 공통). */
    assertBuyGate?: (ctx: {
      market: string;
      bucket: PositionBucket;
      isAdditionalBuy: boolean;
      signalPayload: unknown | undefined;
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

  /** 계좌 실물 수량(balance+locked)이 전략 장부보다 작거나 0이면 strategyPositions를 즉시 맞춘다(수동 청산·외부 매도 후 장부 유령 방지). */
  const reconcileAuthoritativeStrategyBook = (balances: ConnectionBalances) => {
    const zeroed: string[] = [];
    const clamped: string[] = [];
    for (const market of MANAGED_MARKETS) {
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
    for (const market of MANAGED_MARKETS) {
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

  const ensureOrderAllowed = async (side: TradeOrderSide, market: string, confirm: boolean, bucket: PositionBucket = "strategy") => {
    if (!state.autoTradeEnabled) throw new Error("Auto trade is disabled");
    if (bucket === "legacy" && !ALLOWED_MARKETS.has(market)) throw new Error("Legacy bucket market is not managed");
    if (bucket === "strategy" && !market.startsWith("KRW-")) throw new Error("Only KRW-* market is allowed");
    if (!confirm) throw new Error("confirm=true required");
    if (!isLiveEnabled()) throw new Error("Live trading is disabled by environment guards");
    if (state.inFlight) throw new Error("Another order is in progress");
    const now = Date.now();
    if (now - state.lastOrderAtMs < COOLDOWN_MS) throw new Error(`Cooldown active: wait ${COOLDOWN_MS}ms`);
    const key = `${side}:${market}:${Math.floor(now / 1000)}`;
    if (state.lastOrderKey === key) throw new Error("Duplicate order blocked");
    if (side === "buy" && bucket === "strategy") {
      const p = state.strategyPositions[market as keyof typeof state.strategyPositions];
      const openingNewMarket = (p?.qty ?? 0) <= 0;
      if (openingNewMarket) {
        const openPositions = Object.values(state.strategyPositions).filter((x) => x.qty > 0).length;
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
    const conn = await getConnectionStatus();
    if (!conn.connected) throw new Error(conn.reason ?? "Connection failed");
    reconcileAuthoritativeStrategyBook(conn.balances);
    syncLegacyBuckets(conn.balances);
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

  const placeBuy = async (
    market: string,
    confirm: boolean,
    amountKrw = TEST_ORDER_KRW,
    strategyType: StrategyType = "stable",
    bucket: PositionBucket = "strategy",
    signalPayload?: unknown,
  ) => {
    const posPre = state.strategyPositions[market as keyof typeof state.strategyPositions];
    const strategyQtyPre = Number(posPre?.qty ?? 0);
    const isAdditionalBuy = bucket === "legacy" || strategyQtyPre > 0;
    await hooks?.assertBuyGate?.({
      market,
      bucket,
      isAdditionalBuy,
      signalPayload,
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
      const posPre = state.strategyPositions[market as keyof typeof state.strategyPositions];
      const curInv = Number(posPre?.invested_krw_total ?? 0);
      if (curInv + amountKrw > ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET) {
        throw new Error(`Strategy invested KRW limit exceeded for ${market}`);
      }
    }
    const conn = await ensureOrderAllowed("buy", market, confirm, bucket);
    const funds = computeKrwFunds(conn);
    if (funds.live_order_available_krw < 5000) throw new Error("Live order available KRW is below minimum order amount");
    if (funds.live_order_available_krw < amountKrw) throw new Error(`Not enough live-order KRW. available=${funds.live_order_available_krw}`);
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
      }
      if (bucket === "legacy") {
        const lb = state.legacyBuckets[market as ManagedMarket];
        lb.dca_krw_total += amountKrw;
        lb.dca_count = Math.min(lb.dca_count + 1, lb.dca_max);
        lb.dca_locked = lb.dca_count >= lb.dca_max;
        lb.next_dca_at = new Date(Date.now() + 20 * 60_000).toISOString();
        lb.exit_status = lb.exit_stage === 0 ? "평단 복귀 대기" : lb.exit_stage === 1 ? "1차 탈출" : "분할 청산 중";
      }
      await log("manual_buy_response", { market, amount_krw: amountKrw, order: rsp });
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
    }
  };

  const placeSell = async (market: string, confirm: boolean, ratio = 1, bucket: PositionBucket = "strategy") => {
    const conn = await ensureOrderAllowed("sell", market, confirm, bucket);
    state.inFlight = true;
    try {
      const pos = state.strategyPositions[market as keyof typeof state.strategyPositions];
      const legacyPos = state.legacyBuckets[market as ManagedMarket];
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
      if (conn.connected) {
        const rawBalances = Array.isArray(conn.balances) ? conn.balances : [];
        const balanceRows = rawBalances.map((b) => ({
          currency: normalizeBalanceCurrency(b.currency),
          balance: Number(b.balance),
          locked: Number(b.locked),
          avg_buy_price: Number(b.avg_buy_price),
        }));
        try {
          const { merged, rest_fresh_markets } = await resolveTickerPricesForBalances(balanceRows, state.lastGoodMarkPrices);
          state.lastGoodMarkPrices = merged;
          const effective = buildEffectiveValuationPriceMap(balanceRows, merged);
          const snap = computeAccountValuationFromPrices(balanceRows, effective, new Date().toISOString());
          account_portfolio = sanitizeAccountPortfolioSnapshot(snap.portfolio);
          mark_prices = snap.mark_prices;
          const dbg: Record<string, PricingDebugRow> = {};
          for (const m of MANAGED_MARKETS) {
            const cur = m.replace("KRW-", "");
            const row = balanceRows.find((r) => r.currency === cur);
            const qty = row ? row.balance + row.locked : 0;
            const avg = row ? row.avg_buy_price : 0;
            const mark = effective[m] ?? 0;
            const fromRest = rest_fresh_markets.has(m);
            if (qty > 0 && mark > 0 && !fromRest) mark_prices_stale = true;
            const gd = qty > 0 && avg > 0 && mark > 0 ? grossPnlPct(avg, mark) : 0;
            const nd = qty > 0 && avg > 0 && mark > 0 ? netPnlPctPerUnit(avg, mark) : 0;
            dbg[m] = {
              avg_buy_price: avg,
              quantity: qty,
              current_price_used_for_display: mark,
              current_price_used_for_sell_decision: mark,
              pnl_percent_display: gd,
              pnl_percent_sell_decision: gd,
              net_pnl_percent_after_fees: nd,
              intended_sell_ratio: null,
              intended_sell_qty: null,
              intended_sell_value_krw: null,
              blocked_reason: null,
              ticker_from_rest_this_request: fromRest,
            };
          }
          pricing_debug = dbg;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
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
      const legacyPositions = Object.fromEntries(
        MANAGED_MARKETS.map((market) => [
          market,
          {
            market,
            qty: state.legacyBuckets[market].qty,
            avg: state.legacyBuckets[market].avg,
            stop_loss_disabled: true,
            dca_count: state.legacyBuckets[market].dca_count,
            dca_max: state.legacyBuckets[market].dca_max,
            dca_available: !state.legacyBuckets[market].dca_locked,
            dca_krw_total: state.legacyBuckets[market].dca_krw_total,
            dca_krw_cap: ORDER_LIMITS.MAX_LEGACY_DCA_KRW_PER_MARKET,
            next_dca_at: state.legacyBuckets[market].next_dca_at,
            exit_status: state.legacyBuckets[market].exit_status,
          },
        ]),
      );
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
      balances: conn.balances,
      test_order_krw: TEST_ORDER_KRW,
      order_limits: ORDER_LIMITS,
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
      pricing_debug,
    };
  };

  return {
    status,
    connectionCheck: getConnectionStatus,
    placeBuy,
    placeSell,
    placeLegacyDcaBuy: (market: string, confirm: boolean, amountKrw = TEST_ORDER_KRW, signalPayload?: unknown) =>
      placeBuy(market, confirm, amountKrw, "stable", "legacy", signalPayload),
    placeLegacyExitSell: (market: string, confirm: boolean, ratio = 1) =>
      placeSell(market, confirm, ratio, "legacy"),
    setAutoTradeEnabled,
    setRecoveryReady,
  };
}

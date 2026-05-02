"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import type { SignalLogEntry } from "@orbitalpha/shared";
import {
  DEFAULT_TRADING_COMPANY_ID,
  DEFAULT_TRADING_SERVICE_ID,
  mvpSignalPayloadV1Schema,
  mvpSignalPayloadV2Schema,
  ORDER_LIMITS,
  runEntryScoreGate,
  THIS_REPO_SERVICE_LINE,
} from "@orbitalpha/shared";
import {
  fetchTradeStatusDetailed,
  fetchTradeStatusOnce,
  fetchTradeStatusUntilSyncedWithLog,
  isSoftTradeStatusFailureCode,
} from "@/lib/trade-status-fetch";
import { UI } from "@/app/trading/ui-constants";
import { useTradingEngineInsights } from "@/app/trading/hooks/use-trading-engine-insights";
import { SignalHistorySection } from "@/app/trading/sections/signal-history-section";

const apiBase = "";

function parseSignalPayload(row: SignalLogEntry) {
  if (row.kind !== "signal" || !row.payload) return null;
  const v2 = mvpSignalPayloadV2Schema.safeParse(row.payload);
  if (v2.success) return { kind: "v2" as const, p: v2.data };
  const v1 = mvpSignalPayloadV1Schema.safeParse(row.payload);
  if (v1.success) return { kind: "v1" as const, p: v1.data };
  return null;
}

function isPass(parsed: NonNullable<ReturnType<typeof parseSignalPayload>>): boolean {
  return parsed.kind === "v2" ? parsed.p.filter_pass : parsed.p.passed;
}

/** 서버 `assertOrderBuyAllowed`·한도와 동일 기준으로 추가매수 가능 여부 문구 생성. */
function formatAdditionalBuyStatus(params: {
  hasHolding: boolean;
  apiConnected: boolean;
  autoTradeEnabled: boolean;
  safetyStop: boolean;
  marketState: MarketStateStatus | null;
  orderLimits: typeof ORDER_LIMITS;
  stepKrw: number;
  signalPayload: unknown | undefined;
  strategyQty: number;
  legacyQty: number;
  entries: number;
  investedKrw: number;
  legacyDcaCount: number;
  legacyDcaMax: number;
  legacyDcaAvailable: boolean;
  legacyDcaKrw: number;
}): string {
  const {
    hasHolding,
    apiConnected,
    autoTradeEnabled,
    safetyStop,
    marketState,
    orderLimits,
    stepKrw,
    signalPayload,
    strategyQty,
    legacyQty,
    entries,
    investedKrw,
    legacyDcaCount,
    legacyDcaMax,
    legacyDcaAvailable,
    legacyDcaKrw,
  } = params;

  if (!hasHolding) return "보유 없음";
  if (!apiConnected) return "API 미연결";
  if (!autoTradeEnabled) return "자동매매 OFF";
  if (safetyStop) return "계좌보호 자동정지";
  if (!marketState) return "시장 스냅샷 로딩 중";

  const ms = marketState.market_state;
  if (ms === "risk_off" || marketState.regime_allows_new_and_additional_buys === false) {
    return "risk_off: 신규·추가 진입 차단";
  }

  const parts: string[] = [];
  if (strategyQty > 0) {
    if (entries >= orderLimits.MAX_STRATEGY_ENTRIES_PER_MARKET) {
      parts.push(`전략: 분할진입 ${orderLimits.MAX_STRATEGY_ENTRIES_PER_MARKET}회 상한`);
    } else if (investedKrw + stepKrw > orderLimits.MAX_STRATEGY_INVESTED_KRW_PER_MARKET) {
      parts.push("전략: 누적 투입 KRW 상한");
    } else {
      // 서버 게이트(추가매수)는 risk_off에서만 차단이며, score gate는 신규진입 전용이다.
      parts.push("전략 추가: 가능");
    }
  }

  if (parts.length === 0) return "해당 없음";
  return parts.join(" · ");
}

const FILTER_LABELS: Record<string, string> = {
  volume_increase: "거래량 증가",
  box_breakout: "박스 상단 돌파",
  pullback_reclaim: "짧은 눌림 후 재상승",
  upper_wick: "윗꼬리 과다",
  no_vertical_spike: "단기 수직 급등 제외",
  volume_spike_close_fail: "거래량 급증 후 종가 유지",
  data: "데이터 충분성",
};

/** 6개 필터 중 정확히 5개 통과 + 전체 미통과 → 마지막 1조건 탈락 후보 */
function isNearMissFiveOfSix(parsed: NonNullable<ReturnType<typeof parseSignalPayload>>): boolean {
  if (parsed.kind !== "v2") return false;
  const { filter_pass, filters } = parsed.p;
  if (filter_pass) return false;
  if (filters.length !== 6) return false;
  return filters.filter((f) => f.passed).length === 5;
}

function singleFailedFilterId(parsed: NonNullable<ReturnType<typeof parseSignalPayload>>): string | null {
  if (parsed.kind !== "v2") return null;
  const failed = parsed.p.filters.filter((f) => !f.passed);
  return failed.length === 1 ? failed[0]!.id : null;
}

const DASHBOARD_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;
const UPBIT_FEE_RATE = 0.0005;

/** API 구버전 대비 — 서버 `volume-thresholds`와 동기 */
const DEFAULT_VOLUME_THRESHOLDS_BY_MARKET: Record<string, number> = {
  "KRW-BTC": 0.75,
  "KRW-ETH": 1.15,
  "KRW-XRP": 0.75,
  "KRW-TRX": 1.15,
};

type Ctx = {
  company_id: string;
  service_id: string;
  product?: string;
  service_line?: string;
  monitor_instance_id?: string | null;
  monitor_started_at?: string | null;
  last_strategy_tick_at?: string | null;
  last_scanner_tick_at?: string | null;
  last_market_state_tick_at?: string | null;
  watch_markets?: string[];
  excluded_markets?: string[];
  volume_threshold_fallback?: number;
  volume_thresholds_by_market?: Record<string, number>;
  volume_threshold_alt?: { "095": number; "075": number };
} | null;

type TradeStatus = {
  trading_mode: "paper" | "live";
  live_order_confirm: boolean;
  live_enabled: boolean;
  env_access_key_present?: boolean;
  env_access_key_masked?: string | null;
  env_secret_key_present?: boolean;
  api_connected: boolean;
  api_reason: string | null;
  recovery_ready?: boolean;
  account_sync_failure_code?: string | null;
  account_sync_failure_message?: string | null;
  krw_available: number;
  total_krw?: number;
  live_order_available_krw?: number;
  reserved_krw?: number;
  strategy_allocated_krw?: number;
  pump_paper_allocated_krw?: number;
  balances: Array<{
    currency: string;
    balance: number;
    locked: number;
    avg_buy_price: number;
    unit_currency: string;
  }>;
  test_order_krw: number;
  order_limits?: typeof ORDER_LIMITS;
  cooldown_ms: number;
  test_market: "KRW-BTC" | "KRW-XRP" | null;
  last_order: {
    ts: string;
    market: string;
    side: "buy" | "sell";
    amount_krw: number;
    status: "ok" | "error";
    detail: string;
    order_uuid?: string;
  } | null;
  last_error: string | null;
  in_flight: boolean;
  auto_trade_enabled?: boolean;
  auto_trade_changed_at?: string | null;
  legacy_position?: {
    market: string;
    qty: number;
    avg: number;
    excluded_from_strategy: boolean;
  };
  legacy_positions?: Record<
    string,
    {
      market: string;
      qty: number;
      avg: number;
      stop_loss_disabled: boolean;
      dca_count: number;
      dca_max: number;
      dca_available: boolean;
      dca_krw_total?: number;
      dca_krw_cap?: number;
      next_dca_at: string | null;
      exit_status: string;
    }
  >;
  strategy_positions?: Record<
    string,
    {
      qty: number;
      avg: number;
      entries: number;
      invested_krw_total?: number;
      realized_pnl: number;
      strategy_type?: "stable" | "momentum";
      stop_loss_pct?: number;
      breakeven_arm_pct?: number;
      partial_take_profit_pct?: number;
      trailing_from_peak_pct?: number;
    }
  >;
  pnl_summary?: {
    legacy_position_pnl: number | null;
    strategy_position_pnl: number;
    total_pnl: number | null;
  };
  /** API 연결 시에만 채움 — 총평가·순손익·수익률 단일 기준(서버 계좌+동일 티커 스냅샷). */
  account_portfolio?: {
    total_evaluated_krw: number;
    krw_available_krw: number;
    krw_total_krw: number;
    buy_cost_krw: number;
    estimated_fees_krw: number;
    net_pnl_krw: number;
    net_return_pct: number;
    as_of: string;
  } | null;
  /** `account_portfolio` 산출에 사용한 현재가(대시보드 4종목). */
  mark_prices?: Record<string, number> | null;
};

/** 서버 `account_portfolio` — 필드 누락·NaN 이 있어도 KPI는 유한 숫자로만 표시. */
function accountPortfolioForKpi(ap: TradeStatus["account_portfolio"]): NonNullable<TradeStatus["account_portfolio"]> | null {
  if (ap == null || typeof ap !== "object") return null;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    total_evaluated_krw: n(ap.total_evaluated_krw),
    krw_available_krw: n(ap.krw_available_krw),
    krw_total_krw: n(ap.krw_total_krw),
    buy_cost_krw: n(ap.buy_cost_krw),
    estimated_fees_krw: n(ap.estimated_fees_krw),
    net_pnl_krw: n(ap.net_pnl_krw),
    net_return_pct: n(ap.net_return_pct),
    as_of: typeof ap.as_of === "string" ? ap.as_of : "",
  } as NonNullable<TradeStatus["account_portfolio"]>;
}

/** 상단 KPI — `ready`일 때만 숫자 표시(서버 account_portfolio 단일 출처). */
type AssetSummaryKpi =
  | {
    kpi: "ready";
    krw: number;
    totalAssets: number;
    totalBuy: number;
    totalEval: number;
    netPnl: number;
    netRet: number;
    totalFees: number;
  }
  | { kpi: "pending" }
  | { kpi: "unavailable" };

type LiveOperatingCapital = {
  totalOperatingKrw: number | null;
};

type AuthSession = {
  authenticated: boolean;
  user_id?: string;
  /** When true, auto/live/api flags are loaded via `/api/v1/trade/status`, not from this session payload. */
  trade_status_pending?: boolean;
  trade_status_available?: boolean;
  trade_status_fetch_hint?: string;
  auto_trade_enabled?: boolean | null;
  live_enabled?: boolean | null;
  api_connected?: boolean | null;
  recovery_ready?: boolean | null;
  safety_guard_state?: "정상" | "주의" | "자동정지";
  can_enable_auto_trade?: boolean;
  cannot_enable_reason?: string | null;
  session_status_degraded?: boolean;
  auto_trade_changed_at?: string | null;
  message?: string;
};

type StrategyStatus = {
  mode: string;
  strategy_tag: string;
  strategy_available_krw: number | null;
  strategy_invested_krw: number;
  strategy_pnl_krw: number;
  strategy_win_rate: number;
  strategy_total_fills: number;
  strategy_take_profit_count: number;
  strategy_stop_loss_count: number;
  strategy_avg_holding_minutes: number;
  safety_guard_state?: "정상" | "주의" | "자동정지";
  safety_guard_reason?: string | null;
  order_fail_count_today?: number;
  consecutive_losses?: number;
  max_positions?: number;
  reentry_cooldowns?: Record<string, string>;
  open_positions?: Record<
    string,
    {
      strategy_type: "stable" | "momentum";
      breakeven_armed: boolean;
      partial_tp_done: boolean;
      trailing_stop_price: number;
      highest_price_after_entry: number;
      current_net_pnl_pct: number;
      remaining_qty: number;
    }
  >;
};

/** 감시·카드에 쓸 마켓: 기본 4종 + (실제 보유·전략/레거시/오픈포지션 마켓). slice(4) 제한 없음. */
function deriveDisplayMarkets(trade: TradeStatus | null, strategy: StrategyStatus | null): string[] {
  const extra = new Set<string>();
  const DUST_NOTIONAL_KRW = 1000;
  if (trade) {
    for (const b of trade.balances ?? []) {
      if (b.currency === "KRW") continue;
      const m = `KRW-${b.currency}`;
      const qtyRaw = Number(b.balance ?? 0) + Number(b.locked ?? 0);
      const avg = Number(b.avg_buy_price ?? 0);
      const notionalByCost = qtyRaw * avg;
      if (Number.isFinite(qtyRaw) && qtyRaw > 0 && notionalByCost >= DUST_NOTIONAL_KRW) extra.add(m);
    }
    for (const k of Object.keys(trade.strategy_positions ?? {})) {
      if (k.startsWith("KRW-")) extra.add(k);
    }
    for (const k of Object.keys(trade.legacy_positions ?? {})) {
      if (k.startsWith("KRW-")) extra.add(k);
    }
    for (const k of Object.keys(strategy?.open_positions ?? {})) {
      if (k.startsWith("KRW-")) extra.add(k);
    }
  }
  for (const m of DASHBOARD_MARKETS) extra.delete(m);
  const extrasSorted = [...extra].sort();
  return [...DASHBOARD_MARKETS, ...extrasSorted];
}

type PumpScannerStatus = {
  mode?: string;
  updated_at: string | null;
  items: Array<{
    rank: number;
    market: string;
    score: number;
    status: "진입직전" | "모니터링" | "제외";
    volume_multiple: number;
    breakout: boolean;
    close_upper_hold: boolean;
    rise_3m_pct: number;
    exclude_reasons?: string[];
    captured_at?: string | null;
    return_3m_pct?: number | null;
    return_5m_pct?: number | null;
    return_10m_pct?: number | null;
    updated_at: string;
  }>;
};

type PaperSurgePatternStats = {
  profile_key: string;
  sample_count: number;
  profit_count: number;
  win_count: number;
  loss_count: number;
  win_rate: number;
  fast_profit_rate: number;
  target_tp_rate: number;
  surge_stop_loss_rate: number;
  volume_fade_loss_rate: number;
  high_rejected_loss_rate: number;
  profile_unknown_loss_rate: number;
  early_entry_loss_rate: number;
  chase_loss_rate: number;
  volume_hold_profit_count: number;
  clean_candle_profit_count: number;
  avg_pnl_pct: number;
  confidence: "low" | "medium" | "high";
  suggested_size_multiplier: number;
  updated_at: string;
};

type PaperStatus = {
  mode: string;
  updated_at: string;
  config: {
    start_krw: number;
    entry_krw_per_trade: number;
    max_open_positions: number;
    take_profit_pct: number;
    stop_loss_pct: number;
    timeout_minutes: number;
    fee_rate: number;
  };
  account: {
    total_asset_krw: number;
    cash_krw: number;
    holdings_eval_krw: number;
    total_pnl_krw: number;
    total_return_pct: number;
    open_unrealized_pnl_krw: number;
  };
  counters: {
    open_positions: number;
    closed_wins: number;
    closed_losses: number;
    closed_timeouts: number;
  };
  holdings: Array<{
    market: string;
    entry_ts: string;
    entry_price: number;
    current_price: number;
    qty: number;
    invested_krw: number;
    unrealized_pnl_krw: number;
    unrealized_pnl_pct: number;
    signal_strength: string;
  }>;
  recent_history: Array<{
    ts: string;
    market: string;
    state: "SIGNAL" | "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT" | "SKIPPED";
    note: string;
    signal_strength: string | null;
    entry_price: number | null;
    exit_price: number | null;
    qty: number | null;
    pnl_krw: number | null;
    pnl_pct: number | null;
    paper_risk_tags?: string[];
    profile_reason?: string;
    profile_reference_reason?: string;
    entry_profile_key?: string;
  }>;
  paper_surge_pattern_stats?: PaperSurgePatternStats[];
};

type PaperPanelSummary = {
  totalEquity: number;
  cashKrw: number;
  unrealizedPnl: number;
  realizedPnl: number;
  returnPct: number;
  openPositions: Array<{
    market: string;
    entryTs: string;
    signalStrength: string;
    unrealizedPnlPct: number;
  }>;
  recentTrades: Array<{
    ts: string;
    market: string;
    state: string;
    note: string;
    pnlPct: number | null;
    paperRiskTags: string[];
    profileReason: string;
    entryProfileKey: string;
  }>;
  maxOpenPositions: number;
  startKrw: number;
  entryPerTradeKrw: number;
  takeProfitPct: number;
  stopLossPct: number;
  timeoutMinutes: number;
  updatedAt: string | null;
  experienceStats: PaperSurgePatternStats[];

  statusCode: string;
  statusMessage: string;
  statusAgeMs: number;
  dataSource: string;
  universeCount: number;
  candidateCount: number;
  shadowV2Count: number;
  degradedReasons: string[];
  lastError: string | null;
};

type MarketStateStatus = {
  timestamp: string;
  market_state: "risk_on" | "neutral" | "risk_off";
  entry_policy: "적극 진입" | "선별 진입" | "신규 진입 차단";
  market_bonus: number;
  min_entry_score: number;
  regime_allows_new_and_additional_buys?: boolean;
  order_limits?: typeof ORDER_LIMITS;
  btc_5m_trend: "up" | "down" | "flat";
  btc_15m_trend: "up" | "down" | "flat";
  breadth_ratio: number;
  recent_close_bias: "up" | "down" | "flat";
};

/** 로그(최신순)에서 가장 최근 signal_monitor_started의 인스턴스 id */
function latestMonitorInstanceIdFromLogs(logs: SignalLogEntry[]): string | undefined {
  for (const row of logs) {
    if (row.kind !== "system" || row.message !== "signal_monitor_started") continue;
    const id = (row.payload as { monitor_instance_id?: string } | undefined)?.monitor_instance_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/** 현재 API가 알려준 인스턴스만 집계에 포함 (구버전 로그는 id 없으면 제외) */
function signalMatchesActiveMonitor(row: SignalLogEntry, activeId: string | undefined): boolean {
  if (row.kind !== "signal") return true;
  if (!activeId) return true;
  const p = row.payload as { v?: number; monitor_instance_id?: string };
  if (p?.v === 2) return p.monitor_instance_id === activeId;
  return false;
}

function volumeFilterRow(parsed: NonNullable<ReturnType<typeof parseSignalPayload>>) {
  if (parsed.kind !== "v2") return null;
  return parsed.p.filters.find((f) => f.id === "volume_increase") ?? null;
}

function toEpochMs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
}

function formatTsLocal(ts: string): string {
  const n = Date.parse(ts);
  if (Number.isNaN(n)) return ts;
  return new Date(n).toLocaleString("ko-KR", { hour12: false });
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function resolveAutoTradeGate(params: {
  session: AuthSession;
  trade: TradeStatus | null;
  strategy: StrategyStatus | null;
}): { canEnable: boolean; reason: string | null; softDelay: boolean } {
  const { session, trade, strategy } = params;
  const rawReason = typeof session.cannot_enable_reason === "string" ? session.cannot_enable_reason : null;
  const tradeStatusPending =
    rawReason === "trade_status_pending" || session.trade_status_pending === true || session.trade_status_available === false;
  const softDelay = false;
  if (trade?.api_connected === false) return { canEnable: false, reason: "api disconnected", softDelay };
  if (trade?.live_enabled === false) return { canEnable: false, reason: "live disabled", softDelay };
  if (trade?.recovery_ready === false) return { canEnable: false, reason: "recovery not ready", softDelay };
  if (strategy?.safety_guard_state === "자동정지") return { canEnable: false, reason: "safety guard stopped", softDelay };
  if (rawReason === "unauthenticated") return { canEnable: false, reason: rawReason, softDelay };
  if (tradeStatusPending && !trade) return { canEnable: false, reason: "거래 상태 확인 중", softDelay };
  if (session.can_enable_auto_trade === true) return { canEnable: true, reason: null, softDelay };
  if (trade && tradeStatusPending) {
    return { canEnable: true, reason: null, softDelay };
  }
  if (rawReason) return { canEnable: false, reason: rawReason, softDelay };
  return { canEnable: false, reason: "조건 미충족", softDelay };
}

function toPaperPanelSummary(raw: unknown): PaperPanelSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const account = (r.account && typeof r.account === "object" && r.account !== null ? r.account : {}) as Record<string, unknown>;
  const config = (r.config && typeof r.config === "object" && r.config !== null ? r.config : {}) as Record<string, unknown>;
  const holdingsRaw = Array.isArray(r.holdings) ? r.holdings : [];
  const historyRaw = Array.isArray(r.recent_history) ? r.recent_history : [];
  const statsRaw = Array.isArray(r.paper_surge_pattern_stats) ? r.paper_surge_pattern_stats : [];

  const openPositions = holdingsRaw.map((h: unknown) => {
    const o = h && typeof h === "object" ? (h as Record<string, unknown>) : {};
    return {
      market: typeof o.market === "string" ? o.market : "UNKNOWN",
      entryTs: typeof o.entry_ts === "string" ? o.entry_ts : "",
      signalStrength: typeof o.signal_strength === "string" ? o.signal_strength : "-",
      unrealizedPnlPct: safeNum(o.unrealized_pnl_pct),
    };
  });

  const recentTrades = historyRaw.map((h: unknown) => {
    const o = h && typeof h === "object" ? (h as Record<string, unknown>) : {};
    return {
      ts: typeof o.ts === "string" ? o.ts : "",
      market: typeof o.market === "string" ? o.market : "UNKNOWN",
      state: typeof o.state === "string" ? o.state : "UNKNOWN",
      note: typeof o.note === "string" ? o.note : "-",
      pnlPct: o.pnl_pct == null ? null : safeNum(o.pnl_pct),
      paperRiskTags: Array.isArray(o.paper_risk_tags) ? o.paper_risk_tags.map(String) : [],
      profileReason: String(o.profile_reason ?? o.profile_reference_reason ?? "-"),
      entryProfileKey: String(o.entry_profile_key ?? "-"),
    };
  });

  return {
    totalEquity: safeNum(account.total_asset_krw),
    cashKrw: safeNum(account.cash_krw),
    unrealizedPnl: safeNum(account.open_unrealized_pnl_krw),
    realizedPnl: safeNum(account.total_pnl_krw),
    returnPct: safeNum(account.total_return_pct),
    openPositions,
    recentTrades,
    maxOpenPositions: safeNum(config.max_open_positions),
    startKrw: safeNum(config.start_krw),
    entryPerTradeKrw: safeNum(config.entry_krw_per_trade),
    takeProfitPct: safeNum(config.take_profit_pct),
    stopLossPct: safeNum(config.stop_loss_pct),
    timeoutMinutes: safeNum(config.timeout_minutes),
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
    experienceStats: statsRaw as PaperSurgePatternStats[],

    statusCode: String(r.status_code ?? "calculating"),
    statusMessage: String(r.status_message ?? "데이터 확인 중"),
    statusAgeMs: safeNum(r.status_age_ms),
    dataSource: String(r.data_source ?? "live"),
    candidateCount: safeNum(r.candidate_count),
    shadowV2Count: safeNum(r.shadow_v2_count),
    degradedReasons: Array.isArray(r.degraded_reasons) ? r.degraded_reasons.map(String) : [],
    lastError: typeof r.last_error === "string" ? r.last_error : null,
    universeCount: safeNum(r.universe_count),
  };
}

function deriveLiveOperatingCapital(trade: TradeStatus | null): LiveOperatingCapital {
  if (!trade) return { totalOperatingKrw: null };
  const apTotal = Number(trade.account_portfolio?.total_evaluated_krw);
  if (Number.isFinite(apTotal) && apTotal > 0) {
    return { totalOperatingKrw: apTotal };
  }

  const totalKrw = Number(trade.total_krw);
  if (Number.isFinite(totalKrw) && totalKrw > 0) {
    return { totalOperatingKrw: totalKrw };
  }

  const krwAvailable = Number(trade.krw_available);
  const safeKrwAvailable = Number.isFinite(krwAvailable) ? Math.max(0, krwAvailable) : 0;
  const markPrices = trade.mark_prices ?? {};
  let holdingsEvaluated = 0;
  for (const bal of Array.isArray(trade.balances) ? trade.balances : []) {
    const currency = String(bal?.currency ?? "").toUpperCase();
    if (!currency || currency === "KRW") continue;
    const qty = Math.max(0, Number(bal?.balance ?? 0)) + Math.max(0, Number(bal?.locked ?? 0));
    if (!(qty > 0)) continue;
    const market = `KRW-${currency}`;
    const markPrice = Number((markPrices as Record<string, unknown>)[market]);
    const avgBuy = Number(bal?.avg_buy_price ?? 0);
    const px = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : Number.isFinite(avgBuy) && avgBuy > 0 ? avgBuy : 0;
    if (px <= 0) continue;
    holdingsEvaluated += qty * px;
  }
  const combined = safeKrwAvailable + holdingsEvaluated;
  if (combined > 0) {
    return { totalOperatingKrw: combined };
  }
  return { totalOperatingKrw: null };
}

function failedFilterLabels(parsed: NonNullable<ReturnType<typeof parseSignalPayload>>): string {
  if (parsed.kind !== "v2") return "";
  return parsed.p.filters
    .filter((f) => !f.passed)
    .map((f) => FILTER_LABELS[f.id] ?? f.label)
    .join(", ");
}


function SignalEvalCard({
  entry,
  parsed,
  nearMiss,
}: {
  entry: SignalLogEntry;
  parsed: NonNullable<ReturnType<typeof parseSignalPayload>>;
  nearMiss?: boolean;
}) {
  const p = parsed.p;
  const market = p.market;
  const pass = parsed.kind === "v2" ? parsed.p.filter_pass : parsed.p.passed;
  const reason = parsed.kind === "v2" ? parsed.p.signal_reason : parsed.p.summary;
  const failReason = parsed.kind === "v2" ? parsed.p.filter_fail_reason : null;
  const sigType =
    parsed.kind === "v2"
      ? parsed.p.signal_type
      : parsed.p.passed
        ? "spot_mvp_v1"
        : "none";

  const border = nearMiss ? "1px solid #d97706" : pass ? "1px solid #22c55e" : "1px solid #334155";
  const bg = nearMiss ? "#1c1410" : "#0f1623";

  return (
    <article
      style={{
        background: bg,
        border,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        fontSize: "0.88rem",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem 1rem",
          alignItems: "baseline",
          marginBottom: "0.5rem",
        }}
      >
        {nearMiss ? (
          <span style={{ fontSize: "0.72rem", padding: "0.12rem 0.4rem", borderRadius: 4, background: "#92400e", color: "#ffedd5" }}>
            5/6 준통과
          </span>
        ) : (
          <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>signal</span>
        )}
        <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>{entry.ts}</span>
        <strong style={{ fontSize: "1rem" }}>{market}</strong>
        <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>{sigType}</span>
        <span
          style={{
            fontSize: "0.75rem",
            padding: "0.15rem 0.45rem",
            borderRadius: 4,
            background: pass ? "#14532d" : "#451a1a",
            color: "#e5e7eb",
          }}
        >
          {pass ? "통과" : "탈락"}
        </span>
        {nearMiss && parsed.kind === "v2" ? (
          <span style={{ fontSize: "0.78rem", color: "#fdba74" }}>
            마지막 탈락: <strong>{FILTER_LABELS[singleFailedFilterId(parsed) ?? ""] ?? "?"}</strong>
          </span>
        ) : null}
      </div>
      {!pass && parsed.kind === "v2" && failedFilterLabels(parsed) ? (
        <div
          style={{
            marginBottom: "0.5rem",
            padding: "0.4rem 0.55rem",
            background: "#1e1b2e",
            borderRadius: 6,
            border: "1px solid #6366f1",
            fontSize: "0.84rem",
            color: "#e0e7ff",
          }}
        >
          <strong>이번 평가 탈락 필터</strong> — {failedFilterLabels(parsed)}
        </div>
      ) : null}
      <div style={{ marginBottom: "0.5rem", lineHeight: 1.45 }}>
        <strong>이유</strong> — {reason}
      </div>
      {nearMiss && parsed.kind === "v2" && typeof parsed.p.volume_ratio === "number" ? (
        <div
          style={{
            fontSize: "0.82rem",
            marginBottom: "0.5rem",
            padding: "0.45rem 0.6rem",
            background: "#292018",
            borderRadius: 6,
            border: "1px solid #b45309",
            color: "#fde68a",
          }}
        >
          <strong>현재 종목 거래량 기준 ({parsed.p.volume_threshold_main ?? "?"})</strong>
          {" → "}
          거래량 증가 필터:{" "}
          {volumeFilterRow(parsed)?.passed ? (
            <span style={{ color: "#86efac" }}>통과</span>
          ) : (
            <span style={{ color: "#fca5a5" }}>탈락</span>
          )}
          {" · "}
          volume_ratio={parsed.p.volume_ratio.toFixed(3)}
        </div>
      ) : null}
      {parsed.kind === "v2" &&
        typeof parsed.p.pullback_relaxed_pass === "boolean" &&
        typeof parsed.p.would_pass_with_pullback_relaxed === "boolean" ? (
        <div
          style={{
            fontSize: "0.82rem",
            marginBottom: "0.5rem",
            padding: "0.45rem 0.6rem",
            background: "#0f172a",
            borderRadius: 6,
            border: "1px solid #334155",
            color: "#cbd5e1",
          }}
        >
          <div style={{ marginBottom: 4, color: "#94a3b8", fontSize: "0.78rem" }}>패턴 보조 판정 (메인 조건 불변)</div>
          <div>
            눌림 완화 기준:{" "}
            {parsed.p.pullback_relaxed_pass ? (
              <span style={{ color: "#86efac" }}>충족</span>
            ) : (
              <span style={{ color: "#fca5a5" }}>미충족</span>
            )}
            {" · 눌림만 완화 시 전체 "}
            {parsed.p.would_pass_with_pullback_relaxed ? (
              <span style={{ color: "#4ade80" }}>통과</span>
            ) : (
              <span style={{ color: "#f87171" }}>여전히 탈락</span>
            )}
          </div>
        </div>
      ) : null}
      {parsed.kind === "v2" &&
        typeof parsed.p.vol_close_relaxed_a_pass === "boolean" &&
        typeof parsed.p.vol_close_relaxed_b_pass === "boolean" &&
        typeof parsed.p.would_pass_with_vol_close_relaxed_a === "boolean" &&
        typeof parsed.p.would_pass_with_vol_close_relaxed_b === "boolean" ? (
        <div
          style={{
            fontSize: "0.82rem",
            marginBottom: "0.5rem",
            padding: "0.45rem 0.6rem",
            background: "#1a1628",
            borderRadius: 6,
            border: "1px solid #7c3aed",
            color: "#e9d5ff",
          }}
        >
          <div style={{ marginBottom: 4, color: "#c4b5fd", fontSize: "0.78rem" }}>
            종가 유지 보조 판정 (메인: 급증 시 양봉·캔들 내 ≥38% — 불변)
          </div>
          <div>
            A (cl≥시가×0.998 · 캔들내≥28%):{" "}
            {parsed.p.vol_close_relaxed_a_pass ? (
              <span style={{ color: "#86efac" }}>충족</span>
            ) : (
              <span style={{ color: "#fca5a5" }}>미충족</span>
            )}
            {" · 종가만 A로 완화 시 전체 "}
            {parsed.p.would_pass_with_vol_close_relaxed_a ? (
              <span style={{ color: "#4ade80" }}>통과</span>
            ) : (
              <span style={{ color: "#f87171" }}>여전히 탈락</span>
            )}
          </div>
          <div style={{ marginTop: 6 }}>
            B (cl≥시가×0.996 · 캔들내≥20%):{" "}
            {parsed.p.vol_close_relaxed_b_pass ? (
              <span style={{ color: "#86efac" }}>충족</span>
            ) : (
              <span style={{ color: "#fca5a5" }}>미충족</span>
            )}
            {" · 종가만 B로 완화 시 전체 "}
            {parsed.p.would_pass_with_vol_close_relaxed_b ? (
              <span style={{ color: "#4ade80" }}>통과</span>
            ) : (
              <span style={{ color: "#f87171" }}>여전히 탈락</span>
            )}
          </div>
        </div>
      ) : null}
      {parsed.kind === "v2" &&
        typeof parsed.p.breakout_relaxed_a_pass === "boolean" &&
        typeof parsed.p.breakout_relaxed_b_pass === "boolean" &&
        typeof parsed.p.would_pass_with_breakout_relaxed_a === "boolean" &&
        typeof parsed.p.would_pass_with_breakout_relaxed_b === "boolean" ? (
        <div
          style={{
            fontSize: "0.82rem",
            marginBottom: "0.5rem",
            padding: "0.45rem 0.6rem",
            background: "#0c1a14",
            borderRadius: 6,
            border: "1px solid #166534",
            color: "#bbf7d0",
          }}
        >
          <div style={{ marginBottom: 4, color: "#86efac", fontSize: "0.78rem" }}>돌파 보조 판정 (메인 99.8% 불변)</div>
          <div>
            A (고가 ≥ 저항 99.7%):{" "}
            {parsed.p.breakout_relaxed_a_pass ? (
              <span style={{ color: "#86efac" }}>충족</span>
            ) : (
              <span style={{ color: "#fca5a5" }}>미충족</span>
            )}
            {" · 돌파만 A로 완화 시 전체 "}
            {parsed.p.would_pass_with_breakout_relaxed_a ? (
              <span style={{ color: "#4ade80" }}>통과</span>
            ) : (
              <span style={{ color: "#f87171" }}>여전히 탈락</span>
            )}
          </div>
          <div style={{ marginTop: 6 }}>
            B (고가 ≥ 저항 99.4%):{" "}
            {parsed.p.breakout_relaxed_b_pass ? (
              <span style={{ color: "#86efac" }}>충족</span>
            ) : (
              <span style={{ color: "#fca5a5" }}>미충족</span>
            )}
            {" · 돌파만 B로 완화 시 전체 "}
            {parsed.p.would_pass_with_breakout_relaxed_b ? (
              <span style={{ color: "#4ade80" }}>통과</span>
            ) : (
              <span style={{ color: "#f87171" }}>여전히 탈락</span>
            )}
          </div>
        </div>
      ) : null}
      {parsed.kind === "v2" &&
        typeof parsed.p.pair_pass_breakout_b_and_pullback_relaxed === "boolean" &&
        typeof parsed.p.pair_pass_breakout_b_and_vol_close_a === "boolean" ? (
        <div
          style={{
            fontSize: "0.8rem",
            marginBottom: "0.5rem",
            padding: "0.4rem 0.55rem",
            background: "#111827",
            borderRadius: 6,
            border: "1px solid #4b5563",
            color: "#e5e7eb",
          }}
        >
          <div style={{ color: "#9ca3af", fontSize: "0.75rem", marginBottom: 6 }}>복합 보조 (검증)</div>
          <div>
            돌파B+눌림완화 동시 → 전체 통과?{" "}
            {parsed.p.pair_pass_breakout_b_and_pullback_relaxed ? (
              <span style={{ color: "#4ade80" }}>예</span>
            ) : (
              <span style={{ color: "#f87171" }}>아니오</span>
            )}
          </div>
          <div style={{ marginTop: 4 }}>
            돌파B+종가유지A 동시 → 전체 통과?{" "}
            {parsed.p.pair_pass_breakout_b_and_vol_close_a ? (
              <span style={{ color: "#4ade80" }}>예</span>
            ) : (
              <span style={{ color: "#f87171" }}>아니오</span>
            )}
          </div>
        </div>
      ) : null}
      {parsed.kind === "v2" &&
        typeof parsed.p.volume_ratio === "number" &&
        typeof parsed.p.would_pass_at_095 === "boolean" ? (
        <div
          style={{
            fontSize: "0.82rem",
            marginBottom: "0.5rem",
            padding: "0.45rem 0.6rem",
            background: "#0c1220",
            borderRadius: 6,
            border: "1px solid #1e3a5f",
          }}
        >
          <div style={{ color: "#93c5fd" }}>
            volume_ratio={parsed.p.volume_ratio.toFixed(3)} · 종목 기준≥{parsed.p.volume_threshold_main ?? "?"}
          </div>
          {!pass ? (
            <div style={{ marginTop: 6, color: "var(--muted)" }}>
              메인 탈락 시 보조: 임계 <strong>0.95</strong>면 전체 통과{" "}
              <span style={{ color: parsed.p.would_pass_at_095 ? "#4ade80" : "#f87171" }}>
                {parsed.p.would_pass_at_095 ? "예" : "아니오"}
              </span>
              {" · "}
              <strong>0.75</strong>면{" "}
              <span style={{ color: parsed.p.would_pass_at_075 ? "#4ade80" : "#f87171" }}>
                {parsed.p.would_pass_at_075 ? "예" : "아니오"}
              </span>
            </div>
          ) : (
            <div style={{ marginTop: 6, color: "#86efac" }}>메인 임계로 이미 통과</div>
          )}
        </div>
      ) : null}
      {!pass && failReason ? (
        <div style={{ color: "#fca5a5", fontSize: "0.82rem", marginBottom: "0.5rem" }}>
          <strong>탈락 상세</strong> — {failReason}
        </div>
      ) : null}
      {parsed.kind === "v1" ? (
        <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", color: "var(--muted)", fontSize: "0.82rem" }}>
          {parsed.p.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
      <div style={{ marginTop: "0.65rem" }}>
        <strong style={{ fontSize: "0.85rem" }}>필터</strong>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: "0.35rem",
            fontSize: "0.8rem",
          }}
        >
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={{ padding: "0.25rem 0.5rem 0.25rem 0" }}>조건</th>
              <th style={{ padding: "0.25rem 0.5rem" }}>결과</th>
              <th style={{ padding: "0.25rem 0" }}>비고</th>
            </tr>
          </thead>
          <tbody>
            {p.filters.map((f) => (
              <tr key={f.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "0.35rem 0.5rem 0.35rem 0" }}>{f.label}</td>
                <td style={{ padding: "0.35rem 0.5rem", color: f.passed ? "#4ade80" : "#f87171" }}>
                  {f.passed ? "통과" : "탈락"}
                </td>
                <td style={{ padding: "0.35rem 0", color: "var(--muted)" }}>{f.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

const FILTER_ORDER = [
  "volume_increase",
  "box_breakout",
  "pullback_reclaim",
  "upper_wick",
  "no_vertical_spike",
  "volume_spike_close_fail",
  "data",
] as const;
const FAIL_SUMMARY_IDS = [
  "volume_increase",
  "box_breakout",
  "pullback_reclaim",
  "upper_wick",
  "volume_spike_close_fail",
] as const;

export default function HomePage() {
  const router = useRouter();
  const pathname = usePathname();
  const [ctx, setCtx] = useState<Ctx>(null);
  const [logs, setLogs] = useState<SignalLogEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [trade, setTrade] = useState<TradeStatus | null>(null);
  const [currentSession, setCurrentSession] = useState<AuthSession | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [sessionPanelWarning, setSessionPanelWarning] = useState<{ code: string; message: string } | null>(null);
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
  const [autoTradeChangedAt, setAutoTradeChangedAt] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [canEnableAutoTrade, setCanEnableAutoTrade] = useState(false);
  const [cannotEnableReason, setCannotEnableReason] = useState<string | null>(null);
  const [authState, setAuthState] = useState<"ok" | "loading" | "expired" | "error">("loading");
  const [strategy, setStrategy] = useState<StrategyStatus | null>(null);
  const [scanner, setScanner] = useState<PumpScannerStatus | null>(null);
  const [paper, setPaper] = useState<PaperStatus | null>(null);
  const [paperPanelError, setPaperPanelError] = useState<string | null>(null);
  const [marketState, setMarketState] = useState<MarketStateStatus | null>(null);
  const [accountSyncState, setAccountSyncState] = useState<"idle" | "syncing" | "ok" | "error" | "failed">("idle");
  const [lastClientTradeFailure, setLastClientTradeFailure] = useState<{ code: string; message: string } | null>(null);
  const tradeInitialSyncDoneRef = useRef(false);
  const fastShellLoggedRef = useRef(false);
  const mountedAtRef = useRef<number>(Date.now());
  const prevPathnameRef = useRef<string | null>(null);
  const pollInFlightRef = useRef(new Map<string, AbortController>());
  const pollJsonSeqRef = useRef(0);
  const tradePollSeqRef = useRef(0);
  const pollSigRef = useRef(new Map<string, string>());
  const pollTimersRef = useRef(new Map<string, number>());
  const isHiddenRef = useRef(false);

  const devLog = (row: Record<string, unknown>) => {
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") return;
    console.info(JSON.stringify(row));
  };

  const asRecord = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
  const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

  const abortAllPolls = () => {
    for (const [, ctrl] of pollInFlightRef.current) ctrl.abort();
    pollInFlightRef.current.clear();
  };

  const setIfChanged = <T,>(key: string, next: T, setter: (v: T) => void, signature?: (v: T) => unknown) => {
    let sig: string | null = null;
    try {
      const src = signature ? signature(next) : next;
      sig = JSON.stringify(src);
    } catch {
      sig = null;
    }
    const prev = pollSigRef.current.get(key);
    if (sig && prev === sig) {
      devLog({ tag: "DASHBOARD_POLL_STATE_UNCHANGED", key });
      return;
    }
    if (sig) pollSigRef.current.set(key, sig);
    setter(next);
  };

  const pollJson = async <T,>(
    key: string,
    url: string,
    opts: {
      timeoutMs: number;
      onOk: (data: T) => void;
      onHttp?: (status: number, bodyText: string) => void;
      onErr?: (e: unknown) => void;
    },
  ) => {
    const slotKey = `${key}:${++pollJsonSeqRef.current}`;
    const ctrl = new AbortController();
    pollInFlightRef.current.set(slotKey, ctrl);
    const tid = window.setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const r = await fetch(url, { cache: "no-store", credentials: "include", signal: ctrl.signal });
      const text = await r.text().catch(() => "");
      if (!r.ok) {
        opts.onHttp?.(r.status, text);
        return;
      }
      let j: T | null = null;
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        try {
          j = JSON.parse(trimmed) as T;
        } catch {
          j = null;
        }
      }
      if (j !== null && typeof j === "object") {
        opts.onOk(j);
      } else {
        opts.onErr?.(new Error("poll_json_empty_or_invalid"));
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") devLog({ tag: "DASHBOARD_POLL_ABORTED", key, url });
      opts.onErr?.(e);
    } finally {
      window.clearTimeout(tid);
      pollInFlightRef.current.delete(slotKey);
    }
  };

  useEffect(() => {
    if (authState !== "loading") return;
    const tid = window.setTimeout(() => {
      devLog({ tag: "DASHBOARD_AUTH_LOADING_WATCHDOG", ms: 4500 });
      setSessionPanelWarning((prev) =>
        prev ?? {
          code: "auth_loading_watchdog",
          message: "세션 확인 지연 — 대시보드를 먼저 표시합니다 (네트워크/API 상태를 확인하세요)",
        },
      );
      setAuthState((prev) => (prev === "loading" ? "ok" : prev));
    }, 4500);
    return () => window.clearTimeout(tid);
  }, [authState]);

  const scheduleLoop = (key: string, run: () => Promise<void>, visibleMs: number, hiddenMs: number) => {
    const tick = async () => {
      await run();
      const ms = isHiddenRef.current ? hiddenMs : visibleMs;
      const t = window.setTimeout(tick, ms);
      pollTimersRef.current.set(key, t);
    };
    void tick();
  };

  const {
    heldLiveSymbols,
    scannerItemsExcludingHeld,
    accountPositionsCount,
    accountTotalEquity,
    accountAvailableKrw,
    accountPnlKrw,
    accountPnlPct,
    strategyOpenPositions,
    strategyMaxPositions,
    strategyRemainingSlots,
    strategyUsableKrw,
    perPositionBudgetKrw,
    strategyCurrentUsedKrw,
    strategyMaxNeededKrw,
    entryPossible,
    blockReason,
    engineStatusLine,
  } = useTradingEngineInsights({
    trade,
    strategy,
    scanner,
    accountPortfolioForKpi: (v) => accountPortfolioForKpi(v as TradeStatus["account_portfolio"]),
  });

  useEffect(() => {
    const prev = prevPathnameRef.current;
    prevPathnameRef.current = pathname;
    const onTrading =
      pathname === "/" || pathname === "/trading" || pathname.startsWith("/trading/");
    if (onTrading && prev !== pathname) {
      tradeInitialSyncDoneRef.current = false;
    }
  }, [pathname]);

  const tradeRef = useRef<TradeStatus | null>(null);
  useEffect(() => {
    tradeRef.current = trade;
  }, [trade]);
  useEffect(() => {
    if (authState !== "ok" || fastShellLoggedRef.current) return;
    fastShellLoggedRef.current = true;
    devLog({
      tag: "DASHBOARD_SHELL_RENDERED_FAST",
      ms_after_mount: Math.max(0, Date.now() - mountedAtRef.current),
      auth_state: authState,
      trade_loaded: Boolean(tradeRef.current),
    });
  }, [authState]);

  useEffect(() => {
    let cancelled = false;
    setErr(null);

    const visibilityHandler = () => {
      isHiddenRef.current = Boolean(document.hidden);
    };
    visibilityHandler();
    document.addEventListener("visibilitychange", visibilityHandler);

    if (typeof window !== "undefined") {
      const isLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches ?? false;
      devLog({ tag: "DASHBOARD_RENDER_LIGHT_MODE", light: isLight });
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("account_sync") === "1") {
        tradeInitialSyncDoneRef.current = false;
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
      }
    }

    const pollSessionOnce = async () => {
      const ts = Date.now();
      await pollJson<AuthSession>(
        "auth_session",
        `/api/v1/auth/session?_=${ts}`,
        {
          timeoutMs: 12_000,
          onHttp: (status) => {
            if (cancelled) return;
            if (status === 401) {
              setSessionPanelWarning(null);
              setAuthState("expired");
              setAccountSyncState("idle");
              tradeInitialSyncDoneRef.current = false;
              router.replace("/login?reason=session_expired");
              return;
            }
            const code = `session_http_${status}`;
            const message =
              status === 502 ? "세션 API 일시 실패 (502) — 대시보드는 유지됩니다" : `세션 API 오류 (HTTP ${status}) — 대시보드는 유지됩니다`;
            setSessionPanelWarning({ code, message });
            setAuthState((prev) => (prev === "loading" ? "ok" : prev));
          },
          onOk: (session) => {
            if (cancelled) return;
            setSessionPanelWarning(null);
            if (session.authenticated !== true) {
              setAuthState("expired");
              setAccountSyncState("idle");
              tradeInitialSyncDoneRef.current = false;
              router.replace("/login");
              return;
            }
            setAuthState("ok");
            setCurrentSession(session);
            setSessionUserId(session.user_id ?? null);
            if (typeof session.auto_trade_enabled === "boolean") {
              setAutoTradeEnabled(session.auto_trade_enabled);
              setAutoTradeChangedAt(typeof session.auto_trade_changed_at === "string" ? session.auto_trade_changed_at : null);
            }
          },
          onErr: (e) => {
            if (cancelled) return;
            const msg = e instanceof Error ? e.message : "session_fetch_failed";
            setSessionPanelWarning({ code: "session_fetch_failed", message: msg.slice(0, 180) });
            setAuthState((prev) => (prev === "loading" ? "ok" : prev));
          },
        },
      );
    };

    const pollTradeOnce = async () => {
      const slotKey = `trade_status:${++tradePollSeqRef.current}`;
      const ctrl = new AbortController();
      pollInFlightRef.current.set(slotKey, ctrl);
      const tid = window.setTimeout(() => ctrl.abort(), 6500);
      try {
        const ts = Date.now();
        const tradePollRes = await fetchTradeStatusDetailed(apiBase, { signal: ctrl.signal, timeoutMs: 6000, cacheBust: ts });
        if (cancelled) return;
        const t = tradePollRes.payload;
        if (t) {
          setIfChanged(
            "trade",
            t as TradeStatus,
            setTrade,
            (p) => ({
              api_connected: (p as TradeStatus).api_connected,
              live_enabled: (p as TradeStatus).live_enabled,
              auto_trade_enabled: (p as TradeStatus).auto_trade_enabled,
              recovery_ready: (p as TradeStatus).recovery_ready,
              total_krw: (p as TradeStatus).total_krw,
              krw_available: (p as TradeStatus).krw_available,
              reserved_krw: (p as TradeStatus).reserved_krw,
              strategy_allocated_krw: (p as TradeStatus).strategy_allocated_krw,
              pump_paper_allocated_krw: (p as TradeStatus).pump_paper_allocated_krw,
              open_positions_count: (() => {
                const rec = asRecord(p);
                const pos = rec.strategy_positions;
                if (!pos || typeof pos !== "object") return 0;
                return Object.values(pos as Record<string, unknown>).filter((v) => Number(asRecord(v).qty ?? 0) > 0).length;
              })(),
              balances_len: Array.isArray((p as TradeStatus).balances) ? (p as TradeStatus).balances.length : 0,
            }),
          );
          setLastClientTradeFailure(null);
          const p = t as TradeStatus;
          if (p.api_connected) setAccountSyncState("ok");
          else if (p.env_access_key_present && p.env_secret_key_present) setAccountSyncState("error");
          else setAccountSyncState("ok");
          setAuthState((prev) => (prev === "loading" ? "ok" : prev));
        } else if (tradePollRes.failureCode) {
          setLastClientTradeFailure({ code: tradePollRes.failureCode, message: tradePollRes.failureMessage ?? "" });
        }
      } finally {
        window.clearTimeout(tid);
        pollInFlightRef.current.delete(slotKey);
      }
    };

    const bootstrap = async () => {
      await pollSessionOnce();

      // start loops (staggered & independent)
      scheduleLoop("auth_session", pollSessionOnce, 45_000, 60_000);
      scheduleLoop("trade_status", pollTradeOnce, 7_000, 10_000);
      scheduleLoop(
        "context",
        async () => {
          const ts = Date.now();
          await pollJson<Record<string, unknown>>("context", `/api/v1/context?_=${ts}`, {
            timeoutMs: 8000,
            onOk: (c) => {
              if (cancelled) return;
              const cr = asRecord(c);
              const next = {
                company_id: typeof cr.company_id === "string" ? cr.company_id : DEFAULT_TRADING_COMPANY_ID,
                service_id: typeof cr.service_id === "string" ? cr.service_id : DEFAULT_TRADING_SERVICE_ID,
                product: cr.product,
                service_line: typeof cr.service_line === "string" ? cr.service_line : THIS_REPO_SERVICE_LINE,
                monitor_instance_id: typeof cr.monitor_instance_id === "string" ? cr.monitor_instance_id : null,
                monitor_started_at: typeof cr.monitor_started_at === "string" ? cr.monitor_started_at : null,
                watch_markets: Array.isArray(cr.watch_markets) ? (cr.watch_markets as string[]) : ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"],
                excluded_markets: Array.isArray(cr.excluded_markets) ? (cr.excluded_markets as string[]) : [],
                volume_threshold_fallback:
                  typeof cr.volume_threshold_fallback === "number"
                    ? cr.volume_threshold_fallback
                    : typeof cr.volume_threshold_main === "number"
                      ? cr.volume_threshold_main
                      : 1.15,
                volume_thresholds_by_market:
                  cr.volume_thresholds_by_market && typeof cr.volume_thresholds_by_market === "object"
                    ? (cr.volume_thresholds_by_market as Record<string, number>)
                    : DEFAULT_VOLUME_THRESHOLDS_BY_MARKET,
                volume_threshold_alt:
                  cr.volume_threshold_alt && typeof cr.volume_threshold_alt === "object" ? cr.volume_threshold_alt : { "095": 0.95, "075": 0.75 },
              } as Ctx;
              setIfChanged("ctx", next, setCtx);
            },
          });
        },
        30_000,
        60_000,
      );

      scheduleLoop(
        "logs",
        async () => {
          const ts = Date.now();
          await pollJson<{ items?: SignalLogEntry[] }>("logs", `/api/v1/logs?limit=80&_=${ts}`, {
            timeoutMs: 9000,
            onOk: (l) => {
              if (cancelled) return;
              const items = Array.isArray(l.items) ? l.items : [];
              setIfChanged("logs", items, setLogs, (rows) => ({ len: rows.length, head: rows[0]?.ts, tail: rows[rows.length - 1]?.ts }));
            },
          });
        },
        25_000,
        60_000,
      );

      scheduleLoop(
        "strategy",
        async () => {
          const ts = Date.now();
          await pollJson<StrategyStatus>("strategy", `/api/v1/strategy/status?_=${ts}`, {
            timeoutMs: 9000,
            onOk: (s) => {
              if (cancelled) return;
              setIfChanged("strategy", s, setStrategy, (x) => ({
                safety_guard_state: asRecord(x).safety_guard_state,
                open_positions_count: (() => {
                  const r = asRecord(x);
                  const pos = r.open_positions;
                  if (!pos || typeof pos !== "object") return 0;
                  return Object.values(pos as Record<string, unknown>).filter((v) => Number(asRecord(v).qty ?? 0) > 0).length;
                })(),
                pnl: asRecord(x).strategy_pnl_krw,
                invested: asRecord(x).strategy_invested_krw,
                total_fills: asRecord(x).strategy_total_fills,
              }));
            },
          });
        },
        15_000,
        30_000,
      );

      scheduleLoop(
        "scanner",
        async () => {
          const ts = Date.now();
          await pollJson<PumpScannerStatus>("scanner", `/api/v1/scanner/status?_=${ts}`, {
            timeoutMs: 9000,
            onOk: (sc) => {
              if (cancelled) return;
              const r = asRecord(sc);
              setIfChanged("scanner", sc, setScanner, (x) => ({
                updated_at: asRecord(x).updated_at,
                items_len: asArray(r.items).length,
              }));
            },
          });
        },
        10_000,
        30_000,
      );

      scheduleLoop(
        "paper",
        async () => {
          const ts = Date.now();
          await pollJson<PaperStatus>("paper", `/api/v1/paper/status?_=${ts}`, {
            timeoutMs: 12_000,
            onOk: (paperStatus) => {
              if (cancelled) return;
              if (paperStatus && typeof paperStatus === "object") {
                if (typeof process === "undefined" || process.env?.NODE_ENV !== "production") {
                  try {
                    const p = asRecord(paperStatus);
                    const holdingsRaw = asArray(p.holdings);
                    const counters = asRecord(p.counters);
                    const config = asRecord(p.config);
                    devLog({
                      tag: "DEBUG_PAPER_DASHBOARD_BINDING",
                      ts: new Date().toISOString(),
                      positions_count: holdingsRaw.length,
                      open_positions: Number(counters.open_positions ?? holdingsRaw.length),
                      max_open: Number(config.max_open_positions ?? 0),
                      recent_history_count: asArray(p.recent_history).length,
                      uses_live_recent_api: false,
                    });
                  } catch {
                    // ignore
                  }
                }
                setIfChanged("paper", paperStatus as PaperStatus, setPaper, (x) => ({
                  updated_at: asRecord(x).updated_at,
                  holdings_len: asArray(asRecord(x).holdings).length,
                }));
                setPaperPanelError(null);
              } else {
                setPaper(null);
                setPaperPanelError("급등주 판단 데이터를 불러오지 못했습니다");
              }
            },
            onHttp: () => {
              if (cancelled) return;
              setPaper(null);
              setPaperPanelError("급등주 판단 데이터 갱신 지연");
            },
            onErr: () => {
              if (cancelled) return;
              setPaper(null);
              setPaperPanelError("급등주 판단 데이터 갱신 지연");
            },
          });
        },
        30_000,
        60_000,
      );

      scheduleLoop(
        "market_state",
        async () => {
          const ts = Date.now();
          await pollJson<MarketStateStatus>("market_state", `/api/v1/market-state?_=${ts}`, {
            timeoutMs: 9000,
            onOk: (m) => {
              if (cancelled) return;
              const r = asRecord(m);
              setIfChanged("market_state", m, setMarketState, () => ({
                entry_policy: r.entry_policy,
                btc_5m_trend: r.btc_5m_trend,
                btc_15m_trend: r.btc_15m_trend,
              }));
            },
          });
        },
        15_000,
        30_000,
      );

      // UI updated clock (cheap) - keep modest even when hidden
      scheduleLoop(
        "updated_at",
        async () => {
          if (cancelled) return;
          setLastUpdatedAt(new Date().toLocaleTimeString("ko-KR", { hour12: false }));
        },
        5_000,
        30_000,
      );

      // Initial trade/account sync should not block dashboard shell rendering.
      if (!tradeInitialSyncDoneRef.current) {
        setAccountSyncState("syncing");
        const syncStartedAt = Date.now();
        devLog({ tag: "DASHBOARD_INITIAL_TRADE_SYNC_BACKGROUND_START" });
        void fetchTradeStatusUntilSyncedWithLog(apiBase, {
          maxAttempts: 10,
          maxWallMs: 9_000,
          logContext: "dashboard_initial_background",
        })
          .then((syncResult) => {
            if (cancelled) return;
            tradeInitialSyncDoneRef.current = true;
            const primed = syncResult.payload;
            if (primed) {
              const p = primed as TradeStatus;
              setTrade(p);
              setLastClientTradeFailure(null);
              if (p.api_connected) setAccountSyncState("ok");
              else if (p.env_access_key_present && p.env_secret_key_present) setAccountSyncState("error");
              else setAccountSyncState("ok");
              devLog({
                tag: "DASHBOARD_INITIAL_TRADE_SYNC_BACKGROUND_DONE",
                ok: true,
                ms: Date.now() - syncStartedAt,
                attempts: syncResult.attempts,
                failure_code: null,
              });
            } else {
              const lf = syncResult.lastFetch;
              if (lf?.failureCode) setLastClientTradeFailure({ code: lf.failureCode, message: lf.failureMessage ?? "" });
              if (lf?.failureCode && !isSoftTradeStatusFailureCode(lf.failureCode)) setAccountSyncState("error");
              devLog({
                tag: "DASHBOARD_INITIAL_TRADE_SYNC_BACKGROUND_DONE",
                ok: false,
                ms: Date.now() - syncStartedAt,
                attempts: syncResult.attempts,
                failure_code: lf?.failureCode ?? null,
              });
            }
          })
          .catch((e) => {
            if (cancelled) return;
            setAccountSyncState("error");
            const msg = e instanceof Error ? e.message : String(e);
            setLastClientTradeFailure({ code: "initial_sync_failed", message: msg.slice(0, 240) });
            devLog({
              tag: "DASHBOARD_INITIAL_TRADE_SYNC_BACKGROUND_DONE",
              ok: false,
              ms: Date.now() - syncStartedAt,
              attempts: 0,
              failure_code: "initial_sync_failed",
            });
          });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", visibilityHandler);
      abortAllPolls();
      for (const [, t] of pollTimersRef.current) window.clearTimeout(t);
      pollTimersRef.current.clear();
    };
  }, [router, pathname]);

  useEffect(() => {
    if (!currentSession) return;
    const gate = resolveAutoTradeGate({ session: currentSession, trade, strategy });
    setCanEnableAutoTrade(gate.canEnable);
    setCannotEnableReason(gate.reason);
  }, [currentSession, trade, strategy]);

  const activeMonitorInstanceId = useMemo(() => {
    const fromCtx = ctx?.monitor_instance_id;
    if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
    return latestMonitorInstanceIdFromLogs(logs);
  }, [ctx, logs]);

  const signalEvents = useMemo(() => {
    const rows: SignalLogEntry[] = [];
    for (const row of logs) {
      if (row.kind !== "signal") continue;
      if (!signalMatchesActiveMonitor(row, activeMonitorInstanceId)) continue;
      rows.push(row);
    }
    rows.sort((a, b) => toEpochMs(b.ts) - toEpochMs(a.ts));
    return rows;
  }, [logs, activeMonitorInstanceId]);

  const { signalRows, systemRows, passCount } = useMemo(() => {
    const signalRows: { entry: SignalLogEntry; parsed: NonNullable<ReturnType<typeof parseSignalPayload>> }[] = [];
    const systemRows: SignalLogEntry[] = [];

    for (const row of signalEvents) {
      const parsed = parseSignalPayload(row);
      if (parsed) signalRows.push({ entry: row, parsed });
    }
    for (const row of logs) {
      if (row.kind === "system" || row.kind === "upbit") {
        systemRows.push(row);
      }
    }
    signalRows.sort((a, b) => toEpochMs(b.entry.ts) - toEpochMs(a.entry.ts));
    systemRows.sort((a, b) => toEpochMs(b.ts) - toEpochMs(a.ts));
    const passCount = signalRows.filter((r) => isPass(r.parsed)).length;
    return { signalRows, systemRows, passCount };
  }, [logs, signalEvents]);

  const recentFillRows = useMemo(() => signalEvents.filter((e) => {
    const parsed = parseSignalPayload(e);
    return parsed ? isPass(parsed) : false;
  }).slice(0, 8), [signalEvents]);
  const runState = err ? "오류" : activeMonitorInstanceId ? "실행 중" : "대기";

  const recentServerTickTs = useMemo(() => {
    const candidates = [ctx?.last_strategy_tick_at, ctx?.last_market_state_tick_at].filter((v): v is string => typeof v === "string" && v.length > 0);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Date.parse(b) - Date.parse(a));
    return candidates[0] ?? null;
  }, [ctx]);

  const recentScannerCalcTs = useMemo(() => {
    const fromCtx = ctx?.last_scanner_tick_at;
    if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
    const fromScanner = scanner?.updated_at;
    return typeof fromScanner === "string" && fromScanner.length > 0 ? fromScanner : null;
  }, [ctx, scanner]);

  const entryBlockReason = useMemo(() => {
    if (!trade?.api_connected) return "API 미연결";
    if (!autoTradeEnabled) return "자동매매 OFF";
    const policy = marketState?.entry_policy;
    if (policy === "신규 진입 차단") return "시장 상태: 신규 진입 차단";
    if (policy === "선별 진입") {
      if (!scanner?.items?.length) return "급등 후보 없음";
      return "선별 진입 모드 유지";
    }
    if (!scanner?.items?.length) return "급등 후보 없음";
    return "조건 대기";
  }, [trade, autoTradeEnabled, marketState, scanner]);

  const displayMarkets = useMemo(() => deriveDisplayMarkets(trade, strategy), [trade, strategy]);

  const latestByMarket = useMemo(() => {
    const displaySet = new Set(displayMarkets);
    const result: Record<string, { entry: SignalLogEntry; parsed: NonNullable<ReturnType<typeof parseSignalPayload>> } | null> =
      {};
    for (const m of displayMarkets) result[m] = null;

    for (const r of signalRows) {
      const market = r.parsed.p.market;
      if (!displaySet.has(market)) continue;
      if (result[market] === null) {
        result[market] = r;
      }
    }
    return result;
  }, [signalRows, displayMarkets]);

  type CardTone = "pass" | "near" | "fail" | "none";

  function getCardTone(parsed: NonNullable<ReturnType<typeof parseSignalPayload>> | null | undefined): CardTone {
    if (!parsed) return "none";
    if (isPass(parsed)) return "pass";
    if (isNearMissFiveOfSix(parsed)) return "near";
    return "fail";
  }

  function getCardVolumeRatio(parsed: NonNullable<ReturnType<typeof parseSignalPayload>> | null | undefined): string {
    if (!parsed) return "—";
    if (parsed.kind === "v2" && typeof parsed.p.volume_ratio === "number") return parsed.p.volume_ratio.toFixed(3);
    return "—";
  }

  function getSignalStrength(parsed: NonNullable<ReturnType<typeof parseSignalPayload>> | null | undefined): string {
    if (!parsed) return "LOW";
    if (isPass(parsed)) return "HIGH";
    if (isNearMissFiveOfSix(parsed)) return "MID";
    return "LOW";
  }

  function getCardFailReason(parsed: NonNullable<ReturnType<typeof parseSignalPayload>> | null | undefined): string {
    if (!parsed) return "—";
    if (parsed.kind !== "v2") return parsed.p.summary ?? "—";

    // 준통과는 정의상 “마지막으로 탈락한 1개 필터”가 존재
    if (isNearMissFiveOfSix(parsed)) {
      const id = singleFailedFilterId(parsed);
      return (id ? FILTER_LABELS[id] ?? id : parsed.p.signal_reason) ?? "—";
    }

    const failed = parsed.p.filters.filter((f) => !f.passed).map((f) => f.id);
    if (failed.length === 0) return "—";

    const best = failed.reduce((acc, id) => {
      const ia = FILTER_ORDER.indexOf(acc as (typeof FILTER_ORDER)[number]);
      const ib = FILTER_ORDER.indexOf(id as (typeof FILTER_ORDER)[number]);
      if (ia === -1 && ib === -1) return id.localeCompare(acc) < 0 ? id : acc;
      if (ia === -1) return id;
      if (ib === -1) return acc;
      return ib < ia ? id : acc;
    }, failed[0]!);

    return FILTER_LABELS[best] ?? best;
  }

  const latestCycleRows = useMemo(
    () =>
      Object.values(latestByMarket)
        .filter(
          (r): r is { entry: SignalLogEntry; parsed: NonNullable<ReturnType<typeof parseSignalPayload>> } =>
            Boolean(r),
        )
        .sort((a, b) => toEpochMs(b.entry.ts) - toEpochMs(a.entry.ts))
        .slice(0, 4),
    [latestByMarket],
  );

  const latestSignalTs = latestCycleRows[0]?.entry?.ts ? formatTsLocal(latestCycleRows[0].entry.ts) : "-";

  const marketStatusSummary = useMemo(() => {
    let pass = 0;
    let watch = 0;
    let fail = 0;
    for (const m of displayMarkets) {
      const parsed = latestByMarket[m]?.parsed;
      const tone = getCardTone(parsed);
      if (tone === "pass") pass += 1;
      else if (tone === "near") watch += 1;
      else fail += 1;
    }
    return { pass, watch, fail };
  }, [latestByMarket, displayMarkets]);

  const holdingCards = useMemo(() => {
    const valuationTrade = trade;
    const byCurrency = new Map((valuationTrade?.balances ?? []).map((b) => [b.currency, b]));
    const strategyByMarket = valuationTrade?.strategy_positions ?? {};
    const legacyByMarket = valuationTrade?.legacy_positions ?? {};
    const DUST_NOTIONAL_KRW = 1000;
    return displayMarkets.map((m) => {
      const currency = m.replace("KRW-", "");
      const bal = byCurrency.get(currency);
      const qtyRaw = Number(bal?.balance ?? 0) + Number(bal?.locked ?? 0);
      const avg = Number(bal?.avg_buy_price ?? 0);
      const notionalByCost = qtyRaw * avg;
      const qty = Number.isFinite(qtyRaw) && notionalByCost >= DUST_NOTIONAL_KRW ? Math.max(0, qtyRaw) : 0;
      const strategyQtyRaw = Number(strategyByMarket[m]?.qty ?? 0);
      const strategyQty = Number.isFinite(strategyQtyRaw) ? Math.max(0, Math.min(strategyQtyRaw, qty)) : 0;
      const legacyMeta = legacyByMarket[m];
      const legacyQty = Number.isFinite(Number(legacyMeta?.qty ?? NaN))
        ? Math.max(0, Number(legacyMeta?.qty ?? 0))
        : Math.max(0, qty - strategyQty);
      const legacyAvg = Number(legacyMeta?.avg ?? avg);
      const mp = valuationTrade?.mark_prices?.[m];
      const now = typeof mp === "number" && mp > 0 ? mp : 0;
      const evalAmount = qty > 0 && now > 0 ? qty * now : 0;
      const cost = qty > 0 && avg > 0 ? qty * avg : 0;
      const estimatedFees = evalAmount > 0 && cost > 0 ? cost * UPBIT_FEE_RATE + evalAmount * UPBIT_FEE_RATE : 0;
      const netPnl = evalAmount > 0 && cost > 0 ? evalAmount - cost - estimatedFees : 0;
      /** 업비트 보유 화면 수익률과 동일: 평단 대비 현재가 변동률(수수료 이중 차감 % 아님) */
      const netRet = cost > 0 && avg > 0 && now > 0 ? ((now / avg) - 1) * 100 : 0;
      const strategyMeta = strategyByMarket[m];
      const livePos = strategy?.open_positions?.[m];
      return {
        market: m,
        currency,
        qty,
        avg,
        now,
        evalAmount,
        cost,
        estimatedFees,
        netPnl,
        netRet,
        legacyQty,
        legacyAvg,
        strategyQty,
        strategyAvg: Number(strategyMeta?.avg ?? 0),
        strategyInvestedKrw: Number(strategyMeta?.invested_krw_total ?? 0),
        legacyDcaCount: Number(legacyMeta?.dca_count ?? 0),
        legacyDcaMax: Number(legacyMeta?.dca_max ?? ORDER_LIMITS.MAX_LEGACY_DCA_COUNT_PER_MARKET),
        legacyDcaKrwTotal: Number(legacyMeta?.dca_krw_total ?? 0),
        legacyDcaAvailable: Boolean(legacyMeta?.dca_available ?? true),
        legacyNextDcaAt: typeof legacyMeta?.next_dca_at === "string" ? legacyMeta.next_dca_at : null,
        legacyExitStatus: typeof legacyMeta?.exit_status === "string" ? legacyMeta.exit_status : "평단 복귀 대기",
        legacyStopLossDisabled: Boolean(legacyMeta?.stop_loss_disabled ?? true),
        strategyType: livePos?.strategy_type ?? strategyMeta?.strategy_type ?? "stable",
        stopLossPct: Number(strategyMeta?.stop_loss_pct ?? -2),
        currentNetPnlPct: Number(livePos?.current_net_pnl_pct ?? 0),
        breakevenArmed: Boolean(livePos?.breakeven_armed),
        partialTpDone: Boolean(livePos?.partial_tp_done),
        trailingStopPrice: Number(livePos?.trailing_stop_price ?? 0),
      };
    });
  }, [trade, strategy, displayMarkets]);

  const holdingQtyByMarket = useMemo(() => {
    const map: Record<string, number> = {};
    for (const h of holdingCards) map[h.market] = h.qty;
    return map;
  }, [holdingCards]);

  const paperSummary = useMemo<PaperPanelSummary>(() => toPaperPanelSummary(paper), [paper]);
  const liveOperatingCapital = useMemo(() => deriveLiveOperatingCapital(trade), [trade]);

  const assetSummary = useMemo((): AssetSummaryKpi => {
    if (!trade) return { kpi: "unavailable" };
    const apiOk =
      trade.api_connected === true ||
      (trade as { api_connected?: unknown }).api_connected === "true" ||
      (trade as { api_connected?: unknown }).api_connected === 1;
    const ap0 = accountPortfolioForKpi(trade.account_portfolio);
    if (apiOk && ap0) {
      const ap = ap0;
      const buyCost = Number(ap.buy_cost_krw);
      const fees = Number(ap.estimated_fees_krw);
      return {
        kpi: "ready",
        krw: Number(ap.krw_total_krw),
        totalAssets: Number(ap.total_evaluated_krw),
        totalBuy: Number.isFinite(buyCost) ? buyCost : 0,
        totalEval: Number(ap.total_evaluated_krw) - Number(ap.krw_total_krw),
        netPnl: Number(ap.net_pnl_krw),
        netRet: Number(ap.net_return_pct),
        totalFees: Number.isFinite(fees) ? fees : 0,
      };
    }
    if (apiOk) return { kpi: "pending" };
    return { kpi: "unavailable" };
  }, [trade]);

  const tradeReadyLabel = useMemo(() => {
    if (accountSyncState === "syncing") return "계좌 동기화 중";
    if (trade?.live_enabled && trade?.api_connected) return "실거래 가능";
    if (trade?.api_connected) return "API 연결됨 · 승인 필요";
    return "API 확인 필요";
  }, [trade, accountSyncState]);

  const accountSyncFailureDisplay = useMemo(() => {
    if (trade?.api_connected) return null;
    const code = trade?.account_sync_failure_code;
    const msg = trade?.account_sync_failure_message ?? trade?.api_reason;
    if (typeof code === "string" && code.length > 0) {
      return `${code}${msg ? ` — ${msg}` : ""}`.slice(0, 220);
    }
    if (typeof msg === "string" && msg.length > 0) return msg.slice(0, 220);
    if (lastClientTradeFailure) {
      return `${lastClientTradeFailure.code} — ${lastClientTradeFailure.message}`.slice(0, 220);
    }
    return null;
  }, [trade, lastClientTradeFailure]);

  const statusRefreshDelayDisplay = useMemo(() => {
    if (!lastClientTradeFailure) return null;
    if (!isSoftTradeStatusFailureCode(lastClientTradeFailure.code)) return null;
    return `상태 갱신 지연: ${lastClientTradeFailure.code}${lastClientTradeFailure.message ? ` — ${lastClientTradeFailure.message}` : ""}`.slice(0, 220);
  }, [lastClientTradeFailure]);
  const tradeStatusPendingDisplay = useMemo(() => {
    if (trade) return null;
    // NOTE: If trade status is pending/failing, we MUST NOT default to 'OFF'.
    // We preserve the last known state and show this label instead.
    if (accountSyncState === "syncing" || accountSyncState === "idle") return "거래 상태 확인 중...";
    return null;
  }, [trade, accountSyncState]);
  const sessionDelayNotice = useMemo(() => {
    const reason = currentSession?.cannot_enable_reason;
    if (reason === "light_status_timeout" || reason === "session_status_delayed") return "세션 보조: 상태 갱신 지연(레거시)";
    return null;
  }, [currentSession]);

  const onToggleAutoTrade = async (enabled: boolean) => {
    if (enabled) {
      const ok = window.confirm("자동매매를 활성화합니다. 실제 주문이 실행될 수 있습니다.");
      if (!ok) return;
    }
    setToggleBusy(true);
    try {
      const res = await fetch(`/api/v1/trade/auto-toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled, risk_ack: enabled ? true : false, operatorExplicit: true }),
      });
      if (res.status === 401) {
        router.replace("/login?reason=session_expired");
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "자동매매 상태 변경 실패");
      setAutoTradeEnabled(Boolean(body.auto_trade_enabled));
      setAutoTradeChangedAt(typeof body.auto_trade_changed_at === "string" ? body.auto_trade_changed_at : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "toggle failed");
    } finally {
      setToggleBusy(false);
    }
  };

  const onLogout = async () => {
    try {
      await fetch(`/api/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      router.replace("/login?reason=logged_out");
    }
  };

  if (authState === "expired") {
    return (
      <div style={{ background: UI.pageOuterBg, minHeight: "100vh", display: "grid", placeItems: "center", color: UI.body }}>
        세션이 만료되었습니다. 로그인 페이지로 이동합니다.
      </div>
    );
  }

  // NOTE: auth/session 오류는 전체 화면을 죽이지 않는다. (401/unauthenticated만 만료 처리)

  // Keep dashboard shell visible while trade/account sync runs in background.

  return (
    <div style={{ background: UI.pageOuterBg, minHeight: "100vh", padding: "1rem 0.85rem" }}>
      <main
        style={{
          padding: "1.1rem",
          maxWidth: 1240,
          margin: "0 auto",
          color: UI.body,
          background: UI.pageBg,
          border: "1px solid #2a4671",
          borderRadius: 14,
          boxShadow: "0 0 0 1px #1d3558 inset, 0 24px 60px rgba(2, 6, 23, 0.55)",
        }}
      >
        {authState === "loading" ? (
          <div
            role="status"
            style={{
              marginBottom: "0.85rem",
              padding: "0.55rem 0.85rem",
              borderRadius: 10,
              border: `1px solid ${UI.borderSoft}`,
              background: UI.cardSoftBg,
              color: UI.watch,
              fontWeight: 800,
              fontSize: "0.84rem",
            }}
          >
            인증 상태 확인 중...
          </div>
        ) : null}
        <header
          style={{
            marginBottom: "0.9rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.8rem",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ fontSize: "1.35rem", fontWeight: 900, letterSpacing: "0.03em", margin: 0, color: UI.title }}>
              Orbitalpha Trading
            </h1>
            <p style={{ margin: "0.22rem 0 0", fontSize: "0.8rem", color: UI.muted, fontWeight: 600 }}>Signals / Auto Trade</p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <Link
              href="/replay"
              style={{
                borderRadius: 8,
                border: `1px solid ${UI.borderSoft}`,
                background: UI.cardSoftBg,
                color: UI.body,
                fontWeight: 700,
                padding: "0.28rem 0.68rem",
                textDecoration: "none",
                fontSize: "0.76rem",
              }}
            >
              리플레이
            </Link>
            <button
              type="button"
              onClick={onLogout}
              style={{
                borderRadius: 8,
                border: `1px solid ${UI.borderSoft}`,
                background: UI.cardSoftBg,
                color: UI.body,
                fontWeight: 700,
                padding: "0.28rem 0.68rem",
                cursor: "pointer",
                fontSize: "0.76rem",
              }}
            >
              로그아웃
            </button>
          </div>
        </header>

        <section
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            marginBottom: "0.8rem",
            fontSize: "0.78rem",
          }}
        >
          <span style={{ color: UI.muted }}>실행 상태 <strong style={{ color: err ? UI.watch : UI.pass }}>{runState}</strong></span>
          <span style={{ color: UI.muted }}>
            시장 상태{" "}
            <strong style={{ color: marketState?.market_state === "risk_off" ? UI.watch : UI.pass }}>
              {marketState?.market_state === "risk_on"
                ? "상방장"
                : marketState?.market_state === "neutral"
                  ? "횡보장"
                  : marketState?.market_state === "risk_off"
                    ? "하락장"
                    : "-"}
            </strong>
          </span>
          <span style={{ color: UI.muted }}>신규 진입 <strong style={{ color: marketState?.entry_policy === "신규 진입 차단" ? UI.watch : UI.body }}>{marketState?.entry_policy ?? "-"}</strong></span>
        </section>

        <section
          style={{
            background: UI.panelBg,
            border: `1px solid ${UI.border}`,
            borderRadius: 12,
            padding: "0.95rem 1rem",
            marginBottom: "1rem",
            boxShadow: `0 0 0 1px #1b3558 inset, ${UI.panelGlow}`,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: "0.8rem",
            }}
          >
            <div style={{ background: UI.cardSoftBg, border: `1px solid ${UI.borderSoft}`, borderRadius: 10, padding: "0.8rem" }}>
              <div style={{ fontSize: "0.73rem", color: UI.muted, marginBottom: 3, fontWeight: 600 }}>총 보유자산</div>
              <div style={{ fontSize: "1.55rem", fontWeight: 900, color: UI.title, lineHeight: 1.05 }}>
                {assetSummary.kpi === "ready" ? Math.round(assetSummary.totalAssets).toLocaleString() : "—"}
              </div>
            </div>
            <div style={{ background: UI.cardSoftBg, border: `1px solid ${UI.borderSoft}`, borderRadius: 10, padding: "0.8rem" }}>
              <div style={{ fontSize: "0.75rem", color: UI.muted, marginBottom: 2, fontWeight: 600 }}>보유 KRW</div>
              <div style={{ fontSize: "1.55rem", fontWeight: 900, color: UI.title, lineHeight: 1.05 }}>
                {assetSummary.kpi === "ready" ? Math.round(assetSummary.krw).toLocaleString() : "—"}
              </div>
            </div>
            <div style={{ background: UI.cardSoftBg, border: `1px solid ${UI.borderSoft}`, borderRadius: 10, padding: "0.8rem" }}>
              <div style={{ fontSize: "0.75rem", color: UI.muted, marginBottom: 2, fontWeight: 600 }}>순평가손익</div>
              <div
                style={{
                  fontSize: "1.55rem",
                  fontWeight: 900,
                  color:
                    assetSummary.kpi === "ready" ? (assetSummary.netPnl >= 0 ? UI.pass : UI.watch) : UI.muted,
                  lineHeight: 1.05,
                }}
              >
                {assetSummary.kpi === "ready" ? Math.round(assetSummary.netPnl).toLocaleString() : "—"}
              </div>
            </div>
            <div style={{ background: UI.cardSoftBg, border: `1px solid ${UI.borderSoft}`, borderRadius: 10, padding: "0.8rem" }}>
              <div style={{ fontSize: "0.75rem", color: UI.muted, marginBottom: 2, fontWeight: 600 }}>순수익률</div>
              <div
                style={{
                  fontSize: "1.55rem",
                  fontWeight: 900,
                  color:
                    assetSummary.kpi === "ready" ? (assetSummary.netRet >= 0 ? UI.pass : UI.watch) : UI.muted,
                  lineHeight: 1.05,
                }}
              >
                {assetSummary.kpi === "ready" ? `${assetSummary.netRet.toFixed(2)}%` : "—"}
              </div>
            </div>
          </div>
          <section
            style={{
              marginTop: "0.75rem",
              borderTop: `1px solid ${UI.borderSoft}`,
              paddingTop: "0.7rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.7rem",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", fontSize: "0.78rem", color: UI.muted }}>
              <span>API <strong style={{ color: trade?.api_connected ? UI.pass : UI.watch }}>{accountSyncState === "syncing" ? "동기화중" : trade?.api_connected ? "연결됨" : "미연결"}</strong></span>
              <span>자동매매 <strong style={{ color: autoTradeEnabled ? UI.pass : UI.watch }}>{autoTradeEnabled ? "ON" : "OFF"}</strong></span>
              <span>계좌보호 <strong style={{ color: strategy?.safety_guard_state === "자동정지" ? UI.watch : UI.body }}>{strategy?.safety_guard_state ?? "-"}</strong></span>
              <span>실거래 <strong style={{ color: trade?.api_connected ? UI.pass : UI.watch }}>{tradeReadyLabel}</strong></span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <button
                type="button"
                onClick={() => void onToggleAutoTrade(!autoTradeEnabled)}
                disabled={toggleBusy || (!autoTradeEnabled && !canEnableAutoTrade)}
                style={{
                  borderRadius: 999,
                  border: `1px solid ${UI.borderSoft}`,
                  background: autoTradeEnabled ? UI.passBg : UI.cardSoftBg,
                  color: UI.body,
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  padding: "0.2rem 0.65rem",
                  cursor: toggleBusy ? "not-allowed" : "pointer",
                  opacity: toggleBusy ? 0.6 : 1,
                }}
              >
                자동매매 {autoTradeEnabled ? "OFF" : "ON"}
              </button>
              {!autoTradeEnabled && !canEnableAutoTrade ? (
                <div style={{ fontSize: "0.7rem", color: UI.watch }}>ON 불가: {cannotEnableReason ?? "조건 미충족"}</div>
              ) : null}
              {!autoTradeEnabled && canEnableAutoTrade && sessionDelayNotice ? (
                <div style={{ fontSize: "0.7rem", color: UI.mutedSoft }}>{sessionDelayNotice}</div>
              ) : null}
            </div>
          </section>
          {tradeStatusPendingDisplay ? (
            <div style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: UI.mutedSoft }}>
              {tradeStatusPendingDisplay}
            </div>
          ) : null}
          {accountSyncFailureDisplay ? (
            <div style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: UI.watch }}>
              계좌 동기화 실패 사유: {accountSyncFailureDisplay}
            </div>
          ) : null}
          {!accountSyncFailureDisplay && statusRefreshDelayDisplay ? (
            <div style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: UI.mutedSoft }}>
              {statusRefreshDelayDisplay}
            </div>
          ) : null}
          <details style={{ marginTop: "0.55rem" }}>
            <summary style={{ cursor: "pointer", color: UI.muted, fontSize: "0.74rem" }}>운영 정보 보기</summary>
            {sessionPanelWarning ? (
              <div style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: UI.watch }}>
                세션 경고: <strong>{sessionPanelWarning.code}</strong> — {sessionPanelWarning.message}
              </div>
            ) : null}
            <div style={{ marginTop: "0.45rem", display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.55rem", fontSize: "0.74rem", color: UI.mutedSoft }}>
              <div>로그인 상태: <strong style={{ color: UI.body }}>인증됨</strong></div>
              <div>세션 사용자 ID: <strong style={{ color: UI.body }}>{sessionUserId ?? "-"}</strong></div>
              <div>최근 체결/신호: <strong style={{ color: UI.body }}>{latestSignalTs}</strong></div>
              <div>최근 서버 틱: <strong style={{ color: UI.body }}>{recentServerTickTs ? formatTsLocal(recentServerTickTs) : "-"}</strong></div>
              <div>최근 스캐너 계산: <strong style={{ color: UI.body }}>{recentScannerCalcTs ? formatTsLocal(recentScannerCalcTs) : "-"}</strong></div>
              <div>monitor: <strong style={{ color: UI.body }}>{ctx?.monitor_instance_id ?? activeMonitorInstanceId ?? "-"}</strong></div>
              <div>scope: <strong style={{ color: UI.body }}>{ctx?.company_id ?? DEFAULT_TRADING_COMPANY_ID}/{ctx?.service_id ?? DEFAULT_TRADING_SERVICE_ID}</strong></div>
              <div>갱신: <strong style={{ color: UI.body }}>{lastUpdatedAt ?? "-"}</strong></div>
              <div>시장근거: <strong style={{ color: UI.body }}>5m {marketState?.btc_5m_trend ?? "-"} / 15m {marketState?.btc_15m_trend ?? "-"} / close {marketState?.recent_close_bias ?? "-"}</strong></div>
              <div>총 보유 KRW: <strong style={{ color: UI.body }}>{Math.round(Number(trade?.account_portfolio?.krw_total_krw ?? trade?.total_krw ?? trade?.krw_available ?? 0)).toLocaleString()}</strong></div>
              <div>실주문 가능 KRW: <strong style={{ color: UI.body }}>{Math.round(Number(trade?.live_order_available_krw ?? 0)).toLocaleString()}</strong></div>
              <div>예약/미체결 KRW: <strong style={{ color: UI.body }}>{Math.round(Number(trade?.reserved_krw ?? 0)).toLocaleString()}</strong></div>
              <div>기존 전략 투입 KRW: <strong style={{ color: UI.body }}>{Math.round(Number(trade?.strategy_allocated_krw ?? 0)).toLocaleString()}</strong></div>
              <div>급등주 실거래 한도 사용액: <strong style={{ color: UI.body }}>{Math.round(Number(trade?.pump_paper_allocated_krw ?? 0)).toLocaleString()}</strong></div>
            </div>
            <div style={{ marginTop: "0.35rem", fontSize: "0.72rem", color: UI.mutedSoft }}>
              총 보유 KRW = 사용 가능 KRW + 이미 투입 KRW · 모든 손익은 수수료 반영 후 순금액 기준
            </div>
            <div style={{ marginTop: "0.35rem", fontSize: "0.72rem", color: UI.mutedSoft }}>
              신규 전략 사용 가능 KRW {Math.round(strategy?.strategy_available_krw ?? 0).toLocaleString()} · 이미 투입 KRW {Math.round(strategy?.strategy_invested_krw ?? 0).toLocaleString()} · 누적 순손익 {Math.round(strategy?.strategy_pnl_krw ?? 0).toLocaleString()} · 승률 {(strategy?.strategy_win_rate ?? 0).toFixed(1)}% · 체결 수 {strategy?.strategy_total_fills ?? 0}
            </div>
          </details>
        </section>

        <section style={{ fontSize: "0.86rem", color: UI.muted, marginBottom: "0.45rem", fontWeight: 800, letterSpacing: "0.03em" }}>
          계좌 상태
        </section>
        <section
          style={{
            background: UI.cardBg,
            border: `1px solid ${UI.border}`,
            borderRadius: 12,
            padding: "0.8rem 1rem",
            marginBottom: "0.85rem",
            boxShadow: "0 0 0 1px #1b3558 inset, 0 10px 24px rgba(2, 6, 23, 0.32)",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: "0.78rem", color: UI.body }}>
            <div>총 자산: <strong>{Math.round(accountTotalEquity).toLocaleString()}</strong></div>
            <div>보유 종목 수: <strong>{accountPositionsCount}</strong></div>
            <div>가용 현금: <strong>{Math.round(accountAvailableKrw).toLocaleString()}</strong></div>
            <div>
              평가손익:{" "}
              <strong style={{ color: accountPnlKrw >= 0 ? UI.pass : UI.fail }}>
                {Math.round(accountPnlKrw).toLocaleString()} ({accountPnlPct.toFixed(2)}%)
              </strong>
            </div>
          </div>
        </section>

        <section style={{ fontSize: "0.86rem", color: UI.muted, marginBottom: "0.45rem", fontWeight: 800, letterSpacing: "0.03em" }}>
          전략 운용 상태
        </section>
        <section
          style={{
            background: UI.cardBg,
            border: `1px solid ${UI.border}`,
            borderRadius: 12,
            padding: "0.8rem 1rem",
            marginBottom: "1.05rem",
            boxShadow: "0 0 0 1px #1b3558 inset, 0 10px 24px rgba(2, 6, 23, 0.32)",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: "0.78rem", color: UI.body }}>
            <div>사용 중 슬롯: <strong>{strategyOpenPositions}/{strategyMaxPositions}</strong></div>
            <div>남은 슬롯: <strong>{strategyRemainingSlots}</strong></div>
            <div>종목당 투자금: <strong>{Math.round(perPositionBudgetKrw).toLocaleString()}</strong></div>
            <div>현재 사용 자금: <strong>{Math.round(strategyCurrentUsedKrw).toLocaleString()}</strong></div>
            <div>최대 필요 자금: <strong>{Math.round(strategyMaxNeededKrw).toLocaleString()}</strong></div>
            <div>
              신규 진입 가능 여부:{" "}
              <strong style={{ color: entryPossible ? UI.pass : UI.fail }}>
                {entryPossible ? "YES" : "NO"}
              </strong>
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: "0.78rem", color: UI.mutedSoft }}>
            엔진 상태: <strong style={{ color: entryPossible ? UI.pass : UI.watch }}>{engineStatusLine}</strong>
          </div>
        </section>

        <section style={{ fontSize: "0.86rem", color: UI.muted, marginBottom: "0.45rem", fontWeight: 800, letterSpacing: "0.03em" }}>
          계좌 보유 종목 (Account Holdings)
        </section>
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "0.9rem",
            marginBottom: "1.15rem",
          }}
        >
          {holdingCards.map((h) => {
            const pnlColor = h.netPnl > 0 ? "#22c55e" : h.netPnl < 0 ? "#ef4444" : UI.muted;
            const retColor = h.netRet > 0 ? "#22c55e" : h.netRet < 0 ? "#ef4444" : UI.muted;
            const hasHolding = h.qty > 0;
            const latest = latestByMarket[h.market] ?? null;
            const entries = Number((trade?.strategy_positions?.[h.market]?.entries as number | undefined) ?? 0);
            const orderLimits = trade?.order_limits ?? marketState?.order_limits ?? ORDER_LIMITS;
            const additionalBuyStatus = formatAdditionalBuyStatus({
              hasHolding,
              apiConnected: Boolean(trade?.api_connected),
              autoTradeEnabled,
              safetyStop: strategy?.safety_guard_state === "자동정지",
              marketState,
              orderLimits,
              stepKrw: Number(trade?.test_order_krw ?? 5000),
              signalPayload: latest?.entry?.payload,
              strategyQty: h.strategyQty,
              legacyQty: h.legacyQty,
              entries,
              investedKrw: h.strategyInvestedKrw,
              legacyDcaCount: h.legacyDcaCount,
              legacyDcaMax: h.legacyDcaMax,
              legacyDcaAvailable: h.legacyDcaAvailable,
              legacyDcaKrw: h.legacyDcaKrwTotal,
            });
            return (
              <article
                key={`asset-${h.market}`}
                style={{
                  background: UI.cardBg,
                  border: hasHolding ? `1px solid ${UI.border}` : `1px solid ${UI.borderSoft}`,
                  borderRadius: 12,
                  padding: "0.75rem 0.85rem",
                  boxShadow: "0 0 0 1px #1b3558 inset, 0 10px 24px rgba(2, 6, 23, 0.24)",
                  opacity: hasHolding ? 1 : 0.9,
                }}
              >
                <div style={{ fontSize: "1.02rem", color: UI.title, fontWeight: 900, letterSpacing: "0.02em", marginBottom: 8 }}>{h.currency}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, fontSize: "0.8rem" }}>
                  <span style={{ color: UI.mutedSoft }}>보유수량</span>
                  <strong style={{ color: UI.body }}>{h.qty.toLocaleString(undefined, { maximumFractionDigits: 8 })}</strong>
                  <span style={{ color: UI.mutedSoft }}>평균매수가</span>
                  <strong style={{ color: UI.body }}>{h.avg > 0 ? h.avg.toLocaleString() : "-"}</strong>
                  <span style={{ color: UI.mutedSoft }}>순수익률</span>
                  <strong style={{ color: retColor, fontWeight: 800 }}>{h.evalAmount > 0 ? `${h.netRet.toFixed(2)}%` : "-"}</strong>
                  <span style={{ color: UI.mutedSoft }}>탈출 정책</span>
                  <strong style={{ color: UI.body }}>회복·익절 우선</strong>
                </div>
                <div style={{ marginTop: 8, fontSize: "0.72rem", color: UI.mutedSoft, lineHeight: 1.3 }}>
                  추가매수(전략·레거시): <strong style={{ color: UI.body }}>{additionalBuyStatus}</strong>
                </div>
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer", color: UI.muted, fontSize: "0.72rem" }}>상세</summary>
                  <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr auto", gap: 6, fontSize: "0.76rem" }}>
                    <span style={{ color: UI.mutedSoft }}>평가금액</span>
                    <strong style={{ color: UI.body }}>{h.evalAmount > 0 ? Math.round(h.evalAmount).toLocaleString() : "-"}</strong>
                    <span style={{ color: UI.mutedSoft }}>순평가손익</span>
                    <strong style={{ color: pnlColor }}>{h.evalAmount > 0 ? Math.round(h.netPnl).toLocaleString() : "-"}</strong>
                    <span style={{ color: UI.mutedSoft }}>기존 보유 수량</span>
                    <strong style={{ color: UI.body }}>{h.legacyQty.toLocaleString(undefined, { maximumFractionDigits: 8 })}</strong>
                    <span style={{ color: UI.mutedSoft }}>기존 보유 평균단가</span>
                    <strong style={{ color: UI.body }}>{h.legacyAvg > 0 ? h.legacyAvg.toLocaleString() : "-"}</strong>
                    <span style={{ color: UI.mutedSoft }}>신규 전략 수량</span>
                    <strong style={{ color: UI.body }}>{h.strategyQty.toLocaleString(undefined, { maximumFractionDigits: 8 })}</strong>
                    <span style={{ color: UI.mutedSoft }}>신규 전략 평균단가</span>
                    <strong style={{ color: UI.body }}>{h.strategyAvg > 0 ? h.strategyAvg.toLocaleString() : "-"}</strong>
                    <span style={{ color: UI.mutedSoft }}>물타기 횟수</span>
                    <strong style={{ color: UI.body }}>{h.legacyDcaCount}/{h.legacyDcaMax}</strong>
                    <span style={{ color: UI.mutedSoft }}>다음 물타기 가능</span>
                    <strong style={{ color: h.legacyDcaAvailable ? UI.pass : UI.watch }}>
                      {h.legacyDcaAvailable ? "가능" : "잠금"}
                      {h.legacyNextDcaAt ? ` (${formatTsLocal(h.legacyNextDcaAt)})` : ""}
                    </strong>
                    <span style={{ color: UI.mutedSoft }}>탈출 목표 상태</span>
                    <strong style={{ color: UI.body }}>{h.legacyExitStatus}</strong>
                    <span style={{ color: UI.mutedSoft }}>기존 보유 손절</span>
                    <strong style={{ color: UI.body }}>{h.legacyStopLossDisabled ? "비활성" : "활성"}</strong>
                    <span style={{ color: UI.mutedSoft }}>전략 유형</span>
                    <strong style={{ color: UI.body }}>{h.strategyType === "momentum" ? "급등형" : "안정형"}</strong>
                    <span style={{ color: UI.mutedSoft }}>현재 순이익률</span>
                    <strong style={{ color: h.currentNetPnlPct >= 0 ? UI.pass : UI.watch }}>{h.currentNetPnlPct.toFixed(2)}%</strong>
                    <span style={{ color: UI.mutedSoft }}>브레이크이븐</span>
                    <strong style={{ color: UI.body }}>{h.breakevenArmed ? "활성" : "대기"}</strong>
                    <span style={{ color: UI.mutedSoft }}>1차 익절</span>
                    <strong style={{ color: UI.body }}>{h.partialTpDone ? "완료" : "미완료"}</strong>
                    <span style={{ color: UI.mutedSoft }}>트레일링 기준가</span>
                    <strong style={{ color: UI.body }}>{h.trailingStopPrice > 0 ? Math.round(h.trailingStopPrice).toLocaleString() : "-"}</strong>
                    <span style={{ color: UI.mutedSoft }}>전략 누적 매수 KRW</span>
                    <strong style={{ color: UI.body }}>
                      {Math.round(h.strategyInvestedKrw).toLocaleString()} / {ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET.toLocaleString()}
                    </strong>
                    <span style={{ color: UI.mutedSoft }}>레거시 DCA 누적 KRW</span>
                    <strong style={{ color: UI.body }}>
                      {Math.round(h.legacyDcaKrwTotal).toLocaleString()} / {ORDER_LIMITS.MAX_LEGACY_DCA_KRW_PER_MARKET.toLocaleString()}
                    </strong>
                    <span style={{ color: UI.mutedSoft }}>참고 손실률 필드(즉시청산 미사용)</span>
                    <strong style={{ color: UI.body }}>{h.stopLossPct.toFixed(1)}%</strong>
                  </div>
                </details>
              </article>
            );
          })}
        </section>

        <section style={{ fontSize: "0.86rem", color: UI.muted, marginBottom: "0.45rem", fontWeight: 800, letterSpacing: "0.03em" }}>보유 종목 모니터</section>
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "0.8rem",
            marginBottom: "1rem",
          }}
        >
          {displayMarkets.map((market) => {
            const latest = latestByMarket[market];
            const parsed = latest?.parsed;
            const tone = getCardTone(parsed);
            const holdingQty = holdingQtyByMarket[market] ?? 0;
            const hasHolding = holdingQty > 0;

            const statusLabel = hasHolding
              ? tone === "pass"
                ? "보유중"
                : "보유 + 신호약함"
              : tone === "fail"
                ? "탈락"
                : "미보유";

            const statusColor =
              tone === "pass" ? UI.pass : tone === "near" ? UI.watch : tone === "fail" ? UI.fail : UI.muted;

            const failReason = tone === "fail" || tone === "near" ? getCardFailReason(parsed) : "—";
            const volumeRatio = getCardVolumeRatio(parsed);
            const short = market.replace("KRW-", "");
            const latestTs = latest?.entry?.ts ? formatTsLocal(latest.entry.ts) : "-";

            return (
              <article
                key={market}
                style={{
                  background: UI.cardBg,
                  border: `1px solid ${tone === "pass" ? "#2dd4bf88" : tone === "near" ? "#f59e0b99" : tone === "fail" ? "#ef444499" : UI.border
                    }`,
                  borderRadius: 12,
                  padding: "0.72rem 0.8rem",
                  minHeight: 100,
                  boxShadow: tone === "pass"
                    ? "0 0 0 1px #075985 inset, 0 0 13px #0284c722"
                    : tone === "near"
                      ? "0 0 0 1px #9a3412 inset, 0 0 10px #f59e0b1a"
                      : tone === "fail"
                        ? "0 0 0 1px #7f1d1d inset, 0 0 9px #ef44441a"
                        : "0 0 0 1px #1b3558 inset",
                }}
              >
                <div style={{ height: 1, marginBottom: 6, background: "linear-gradient(90deg, #3b82f6, transparent)" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                  <strong style={{ fontSize: "1.08rem", color: UI.title, fontWeight: 900, letterSpacing: "0.02em" }}>{short}</strong>
                  <span
                    style={{
                      fontSize: "0.8rem",
                      padding: "0.18rem 0.55rem",
                      borderRadius: 999,
                      background: tone === "pass" ? UI.passBg : tone === "near" ? UI.watchBg : tone === "fail" ? UI.failBg : "#e2e8f0",
                      color: statusColor,
                      fontWeight: 700,
                      border: `1px solid ${tone === "pass" ? "#0369a1" : tone === "near" ? "#b45309" : tone === "fail" ? "#b91c1c" : "#64748b"}`,
                    }}
                  >
                    {statusLabel}
                  </span>
                </div>
                <div style={{ color: UI.mutedSoft, fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.03em", marginBottom: 2 }}>핵심 사유</div>
                <div style={{ color: UI.body, fontSize: "0.8rem", lineHeight: 1.3, minHeight: 30, fontWeight: 700 }}>
                  {tone === "none" ? "핵심: 데이터 없음" : `핵심: ${failReason}`}
                </div>
                <div style={{ marginTop: 8, color: UI.mutedSoft, fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.03em" }}>VOLUME RATIO</div>
                <div style={{ color: UI.title, fontSize: "0.94rem", fontWeight: 800 }}>volume_ratio {volumeRatio}</div>
                <div style={{ marginTop: 6, color: UI.mutedSoft, fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.03em" }}>신호 강도</div>
                <div style={{ color: tone === "pass" ? UI.pass : tone === "near" ? UI.watch : UI.fail, fontSize: "0.9rem", fontWeight: 800 }}>
                  {getSignalStrength(parsed)}
                </div>
                <div style={{ marginTop: 4, color: UI.mutedSoft, fontSize: "0.73rem", fontWeight: 600 }}>신호 {latestTs}</div>
              </article>
            );
          })}
        </section>

        <section
          style={{
            background: UI.cardBg,
            border: `1px solid ${UI.border}`,
            borderRadius: 12,
            padding: "0.8rem 1rem",
            marginBottom: "0.9rem",
            boxShadow: "0 0 0 1px #1b3558 inset, 0 10px 24px rgba(2, 6, 23, 0.32)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.55rem" }}>
            <div style={{ fontSize: "0.9rem", color: UI.title, fontWeight: 800, letterSpacing: "0.02em" }}>급등주 스캐너</div>
            <div style={{ fontSize: "0.74rem", color: UI.mutedSoft, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "#f59e0b" }}>
                {scanner?.mode === "paper_validation" ? "실거래 후보 검증중" : "실거래 후보 검증중"}
              </span>
              갱신 {scanner?.updated_at ? formatTsLocal(scanner.updated_at) : "-"}
            </div>
          </div>
          <div style={{ fontSize: "0.72rem", color: UI.mutedSoft, marginTop: -4, marginBottom: 12, lineHeight: 1.4 }}>
            스캐너 신호는 즉시 진입이 아니라, 원형 매매법 + 검증이력 경험치 + live 리스크 게이트를 통과해야 실거래 후보가 됩니다.
          </div>
          {scannerItemsExcludingHeld.after.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "38px 88px 58px 70px 82px 62px 72px 78px 58px 58px 58px 1fr",
                  gap: 8,
                  alignItems: "center",
                  padding: "0 0.45rem",
                  fontSize: "0.66rem",
                  color: UI.mutedSoft,
                }}
              >
                <span>#</span>
                <span>코인</span>
                <span>점수</span>
                <span>상태</span>
                <span>배수</span>
                <span>돌파</span>
                <span>상단</span>
                <span>3분</span>
                <span>3분후</span>
                <span>5분후</span>
                <span>10분후</span>
                <span>갱신</span>
              </div>
              {scannerItemsExcludingHeld.after.map((it) => {
                const reasonsText = it.exclude_reasons?.slice(0, 2).join(", ");
                const statusLabel =
                  it.status === "제외" && reasonsText
                    ? `${it.status} · ${reasonsText}`.slice(0, 26)
                    : it.status;

                const ret3 = it.return_3m_pct ?? null;
                const ret5 = it.return_5m_pct ?? null;
                const ret10 = it.return_10m_pct ?? null;

                return (
                  <div
                    key={`${it.rank}-${it.market}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "38px 88px 58px 70px 82px 62px 72px 78px 58px 58px 58px 1fr",
                      gap: 8,
                      alignItems: "center",
                      padding: "0.35rem 0.45rem",
                      border: "1px solid #28456f",
                      borderRadius: 6,
                      fontSize: "0.76rem",
                      background: UI.cardSoftBg,
                    }}
                  >
                    <strong style={{ color: UI.title }}>#{it.rank}</strong>
                    <strong style={{ color: UI.title }}>{it.market.replace("KRW-", "")}</strong>
                    <span style={{ color: it.score >= 80 ? "#22c55e" : it.score >= 65 ? "#f59e0b" : UI.body, fontWeight: 800 }}>{it.score.toFixed(1)}</span>
                    <span style={{ color: it.status === "진입직전" ? "#22c55e" : it.status === "모니터링" ? "#f59e0b" : UI.body }}>{statusLabel}</span>
                    <span style={{ color: UI.body }}>x{it.volume_multiple.toFixed(2)}</span>
                    <span style={{ color: it.breakout ? "#22c55e" : UI.muted }}>{it.breakout ? "돌파" : "-"}</span>
                    <span style={{ color: it.close_upper_hold ? "#22c55e" : UI.muted }}>{it.close_upper_hold ? "상단유지" : "-"}</span>
                    <span style={{ color: it.rise_3m_pct >= 0 ? "#22c55e" : "#ef4444" }}>{it.rise_3m_pct.toFixed(2)}%</span>
                    <span style={{ color: ret3 == null ? UI.mutedSoft : ret3 >= 0 ? "#22c55e" : "#ef4444" }}>{ret3 == null ? "-" : `${ret3.toFixed(2)}%`}</span>
                    <span style={{ color: ret5 == null ? UI.mutedSoft : ret5 >= 0 ? "#22c55e" : "#ef4444" }}>{ret5 == null ? "-" : `${ret5.toFixed(2)}%`}</span>
                    <span style={{ color: ret10 == null ? UI.mutedSoft : ret10 >= 0 ? "#22c55e" : "#ef4444" }}>{ret10 == null ? "-" : `${ret10.toFixed(2)}%`}</span>
                    <span style={{ color: UI.mutedSoft }}>
                      {formatTsLocal(it.updated_at)}
                      {it.captured_at ? (
                        <span style={{ marginLeft: 8, fontSize: "0.68rem" }}>
                          cap {formatTsLocal(it.captured_at)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={{ margin: 0, color: UI.muted, fontSize: "0.82rem" }}>급등주 실거래 후보 수집 및 경험치 대조 중...</p>
          )}
        </section>

        <section
          style={{
            background: UI.cardBg,
            border: `1px solid ${UI.border}`,
            borderRadius: 12,
            padding: "1rem",
            marginBottom: "0.9rem",
            boxShadow: "0 0 0 1px #1b3558 inset, 0 10px 24px rgba(2, 6, 23, 0.32)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.55rem" }}>
            <div>
              <div style={{ fontSize: "0.95rem", color: UI.title, fontWeight: 900, letterSpacing: "0.02em" }}>급등주 실거래 판단 엔진</div>
              <div style={{ fontSize: "0.72rem", color: UI.mutedSoft, marginTop: 2 }}>급등주 후보의 과거 검증 결과를 원인별 경험치로 분석해 실거래 진입금액·감액·차단 판단에 반영합니다.</div>
            </div>
            <div style={{ fontSize: "0.74rem", color: UI.mutedSoft }}>
              갱신 {paperSummary.updatedAt ? formatTsLocal(paperSummary.updatedAt) : "-"}
            </div>
          </div>

          {(() => {
            try {
              const sc = paperSummary.statusCode;
              const isError = sc === "error";

              if (paperPanelError || isError) {
                return (
                  <div style={{ padding: "1rem", background: UI.errorChipBg, border: `1px solid ${UI.errorChipBorder}`, borderRadius: 10 }}>
                    <p style={{ margin: 0, color: UI.error, fontSize: "0.85rem", fontWeight: 700 }}>데이터를 불러오지 못했습니다</p>
                    {paperSummary.lastError && <p style={{ margin: "0.4rem 0 0", color: UI.error, fontSize: "0.72rem" }}>사유: {paperSummary.lastError}</p>}
                  </div>
                );
              }
              if (!paper) {
                return <p style={{ margin: 0, color: UI.muted, fontSize: "0.82rem" }}>아직 표시할 급등주 판단 표본이 없습니다. 서버가 기존 검증 이력을 불러오면 profile별 경험치가 표시됩니다.</p>;
              }

              if (sc === "empty_universe") {
                return <p style={{ margin: "0.5rem 0", color: UI.muted, fontSize: "0.85rem", textAlign: "center", padding: "1.5rem", background: UI.cardSoftBg, borderRadius: 10, border: `1px dashed ${UI.borderSoft}` }}>현재 감시 유니버스가 없습니다</p>;
              }
              if (sc === "no_candidate") {
                return <p style={{ margin: "0.5rem 0", color: UI.muted, fontSize: "0.85rem", textAlign: "center", padding: "1.5rem", background: UI.cardSoftBg, borderRadius: 10, border: `1px dashed ${UI.borderSoft}` }}>현재 실거래 후보가 없습니다</p>;
              }
              if (sc === "calculating") {
                return <p style={{ margin: "0.5rem 0", color: UI.watch, fontSize: "0.85rem", textAlign: "center", padding: "1.5rem", background: UI.cardSoftBg, borderRadius: 10 }}>계산 중입니다...</p>;
              }

              const stats = paperSummary.experienceStats ?? [];
              const totalSamples = stats.reduce((acc, s) => acc + s.sample_count, 0);
              const totalWins = stats.reduce((acc, s) => acc + s.win_count, 0);
              const totalLosses = stats.reduce((acc, s) => acc + s.loss_count, 0);
              const avgPnl = totalSamples > 0 ? stats.reduce((acc, s) => acc + s.avg_pnl_pct * s.sample_count, 0) / totalSamples : 0;

              const totalFastProfit = stats.reduce((acc, s) => acc + s.fast_profit_rate * s.sample_count, 0);
              const totalTargetTp = stats.reduce((acc, s) => acc + s.target_tp_rate * s.sample_count, 0);
              const totalVolHold = stats.reduce((acc, s) => acc + s.volume_hold_profit_count, 0);
              const totalCleanCandle = stats.reduce((acc, s) => acc + s.clean_candle_profit_count, 0);

              const totalSurgeSL = stats.reduce((acc, s) => acc + s.surge_stop_loss_rate * s.sample_count, 0);
              const totalVolFade = stats.reduce((acc, s) => acc + s.volume_fade_loss_rate * s.sample_count, 0);
              const totalHighRej = stats.reduce((acc, s) => acc + s.high_rejected_loss_rate * s.sample_count, 0);
              const totalUnknown = stats.reduce((acc, s) => acc + s.profile_unknown_loss_rate * s.sample_count, 0);
              const totalEarly = stats.reduce((acc, s) => acc + s.early_entry_loss_rate * s.sample_count, 0);
              const totalChase = stats.reduce((acc, s) => acc + s.chase_loss_rate * s.sample_count, 0);

              const liveReflection = autoTradeEnabled ? "ON" : "대기";

              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  {/* 1단: 요약 카드 */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "0.5rem" }}>
                    {[
                      { label: "경험치 프로필", value: `${stats.length}개` },
                      { label: "총 표본", value: `${totalSamples}건` },
                      { label: "수익 표본", value: `${totalWins}건`, color: UI.pass },
                      { label: "손실 표본", value: `${totalLosses}건`, color: UI.fail },
                      { label: "평균 손익", value: `${avgPnl.toFixed(2)}%`, color: avgPnl >= 0 ? UI.pass : UI.fail },
                      { label: "실거래 판단 반영", value: liveReflection, color: autoTradeEnabled ? UI.pass : UI.watch },
                    ].map((c, i) => (
                      <div key={i} style={{ background: UI.cardSoftBg, border: `1px solid ${UI.borderSoft}`, borderRadius: 8, padding: "0.6rem", textAlign: "center" }}>
                        <div style={{ fontSize: "0.68rem", color: UI.mutedSoft, marginBottom: 4 }}>{c.label}</div>
                        <div style={{ fontSize: "1.1rem", fontWeight: 900, color: c.color ?? UI.title }}>{c.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* 2단: 이익/손실 원인 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                    <div style={{ background: "#061a12", border: "1px solid #14532d", borderRadius: 10, padding: "0.8rem" }}>
                      <div style={{ fontSize: "0.85rem", color: "#4ade80", fontWeight: 900, marginBottom: 10 }}>이익 원인 분석</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem 1rem", fontSize: "0.78rem" }}>
                        <div style={{ color: UI.mutedSoft }}>빠른 수익 전환</div><strong style={{ textAlign: "right" }}>{(totalSamples > 0 ? (totalFastProfit / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                        <div style={{ color: UI.mutedSoft }}>목표가 도달</div><strong style={{ textAlign: "right" }}>{(totalSamples > 0 ? (totalTargetTp / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                        <div style={{ color: UI.mutedSoft }}>거래량 유지</div><strong style={{ textAlign: "right" }}>{totalVolHold}건</strong>
                        <div style={{ color: UI.mutedSoft }}>깨끗한 캔들</div><strong style={{ textAlign: "right" }}>{totalCleanCandle}건</strong>
                      </div>
                    </div>
                    <div style={{ background: "#1a0b0b", border: "1px solid #7f1d1d", borderRadius: 10, padding: "0.8rem" }}>
                      <div style={{ fontSize: "0.85rem", color: "#f87171", fontWeight: 900, marginBottom: 10 }}>손실 원인 분석</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem 1rem", fontSize: "0.74rem" }}>
                        <div style={{ color: UI.mutedSoft }}>급등 손절</div><strong style={{ textAlign: "right", color: "#fca5a5" }}>{(totalSamples > 0 ? (totalSurgeSL / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                        <div style={{ color: UI.mutedSoft }}>거래량 꺼짐</div><strong style={{ textAlign: "right" }}>{(totalSamples > 0 ? (totalVolFade / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                        <div style={{ color: UI.mutedSoft }}>윗꼬리/거절</div><strong style={{ textAlign: "right" }}>{(totalSamples > 0 ? (totalHighRej / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                        <div style={{ color: UI.mutedSoft }}>Unknown 진입</div><strong style={{ textAlign: "right" }}>{(totalSamples > 0 ? (totalUnknown / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                        <div style={{ color: UI.mutedSoft }}>빠른진입(초입실패)</div><strong style={{ textAlign: "right" }}>{(totalSamples > 0 ? (totalEarly / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                        <div style={{ color: UI.mutedSoft }}>추격진입</div><strong style={{ textAlign: "right" }}>{(totalSamples > 0 ? (totalChase / totalSamples * 100).toFixed(1) : "0.0")}%</strong>
                      </div>
                    </div>
                  </div>

                  {/* 3단: 실거래 자금 상태 */}
                  <div style={{ background: UI.cardSoftBg, border: `1px solid ${UI.borderSoft}`, borderRadius: 10, padding: "0.8rem" }}>
                    <div style={{ fontSize: "0.85rem", color: UI.title, fontWeight: 900, marginBottom: 8 }}>실거래 급등주 자금 상태</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem", fontSize: "0.8rem" }}>
                      {(() => {
                        const totalOperatingKrw = liveOperatingCapital.totalOperatingKrw;
                        const surgeLiveCap = totalOperatingKrw != null ? totalOperatingKrw * 0.5 : null;
                        const usedKrw = Math.max(0, Number(trade?.pump_paper_allocated_krw ?? 0));
                        const remainingKrw = surgeLiveCap != null ? surgeLiveCap - usedKrw : null;
                        return (
                          <>
                            <div>
                              <div style={{ color: UI.mutedSoft, fontSize: "0.7rem", marginBottom: 2 }}>실거래 총 운용금액</div>
                              <strong>{totalOperatingKrw != null ? `${Math.round(totalOperatingKrw).toLocaleString()}원` : "수집 대기"}</strong>
                            </div>
                            <div>
                              <div style={{ color: UI.mutedSoft, fontSize: "0.7rem", marginBottom: 2 }}>급등주 실거래 한도 = 실거래 총 운용금액의 50%</div>
                              <strong>{surgeLiveCap != null ? `${Math.round(surgeLiveCap).toLocaleString()}원` : "수집 대기"}</strong>
                            </div>
                            <div>
                              <div style={{ color: UI.mutedSoft, fontSize: "0.7rem", marginBottom: 2 }}>현재 급등주 사용액</div>
                              <strong>{Math.round(usedKrw).toLocaleString()}원</strong>
                            </div>
                            <div>
                              <div style={{ color: UI.mutedSoft, fontSize: "0.7rem", marginBottom: 2 }}>남은 급등주 한도</div>
                              <strong>{remainingKrw != null ? `${Math.round(remainingKrw).toLocaleString()}원` : "수집 대기"}</strong>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {/* 4단: 경험치 프로필 테이블 */}
                  <div style={{ border: `1px solid ${UI.borderSoft}`, borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ background: UI.cardSoftBg, padding: "0.6rem 0.8rem", fontSize: "0.82rem", fontWeight: 900, borderBottom: `1px solid ${UI.borderSoft}` }}>경험치 프로필 (Profiles)</div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.72rem", textAlign: "left" }}>
                        <thead>
                          <tr style={{ background: "#0f172a", color: UI.mutedSoft }}>
                            <th style={{ padding: "0.6rem 0.8rem" }}>profile_key</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>표본</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>승률</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>평균손익</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>신뢰도</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>Sizing</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>Fast%</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>SurgeSL%</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>EarlySL%</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>Fade%</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>HighRej%</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>Unk%</th>
                            <th style={{ padding: "0.6rem 0.8rem" }}>Live 판단</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.map((s, i) => {
                            let liveLabel = "관찰";
                            let liveColor: string = UI.muted;
                            if (s.confidence === "high" && s.avg_pnl_pct > 0 && s.fast_profit_rate > 0.4) { liveLabel = "확대"; liveColor = UI.pass; }
                            else if (s.avg_pnl_pct < 0 || s.surge_stop_loss_rate > 0.3) { liveLabel = "감액"; liveColor = UI.watch; }
                            else if (s.profile_unknown_loss_rate > 0.4) { liveLabel = "차단후보"; liveColor = UI.fail; }
                            else if (s.sample_count < 5) { liveLabel = "관찰"; liveColor = UI.muted; }

                            return (
                              <tr key={i} style={{ borderBottom: `1px solid ${UI.borderSoft}`, background: i % 2 === 0 ? "transparent" : "#0a101f" }}>
                                <td style={{ padding: "0.5rem 0.8rem", color: UI.mutedSoft, fontSize: "0.65rem", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.profile_key}>{s.profile_key}</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{s.sample_count}</td>
                                <td style={{ padding: "0.5rem 0.8rem", color: s.win_rate >= 0.5 ? UI.pass : UI.fail }}>{(s.win_rate * 100).toFixed(1)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem", color: s.avg_pnl_pct >= 0 ? UI.pass : UI.fail }}>{s.avg_pnl_pct.toFixed(2)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{s.confidence}</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>x{s.suggested_size_multiplier.toFixed(1)}</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{(s.fast_profit_rate * 100).toFixed(0)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{(s.surge_stop_loss_rate * 100).toFixed(0)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{(s.early_entry_loss_rate * 100).toFixed(0)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{(s.volume_fade_loss_rate * 100).toFixed(0)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{(s.high_rejected_loss_rate * 100).toFixed(0)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}>{(s.profile_unknown_loss_rate * 100).toFixed(0)}%</td>
                                <td style={{ padding: "0.5rem 0.8rem" }}><span style={{ color: liveColor, fontWeight: 900 }}>{liveLabel}</span></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* 5단: 최근 급등주 판단 표본 내역 */}
                  <div style={{ border: `1px solid ${UI.borderSoft}`, borderRadius: 10, padding: "0.8rem", background: UI.cardSoftBg }}>
                    <div style={{ fontSize: "0.85rem", color: UI.title, fontWeight: 900, marginBottom: 10 }}>최근 급등주 판단 이력</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {(paperSummary.recentTrades ?? []).length > 0 ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "85px 70px 90px 65px 120px 140px 100px 1fr", gap: 8, fontSize: "0.65rem", color: UI.mutedSoft, padding: "0 4px", borderBottom: "1px solid #1e293b", paddingBottom: 4 }}>
                            <span>시간</span><span>종목</span><span>상태</span><span>손익%</span><span>진입사유</span><span>경험치분류</span><span>RiskTags</span><span>반영결과</span>
                          </div>
                          {paperSummary.recentTrades.slice(0, 15).map((row, idx) => {
                            let expLabel = "실거래 판단 표본 수집";
                            let reflection = "-";
                            if (row.state === "CLOSED_WIN") { expLabel = "이익 / 패턴 적중"; reflection = "Live 유지/확대"; }
                            if (row.state === "CLOSED_LOSS") { 
                              expLabel = row.note.includes("surge_stop_loss") ? "손실 / 급등 손절" : "손실 / 흐름 이탈";
                              reflection = "다음 유사 패턴 감액";
                            }
                            if (row.note.includes("unknown")) { expLabel = "unknown 표본 수집"; reflection = "Live 고신뢰 아님"; }
                            if (row.state === "OPEN") { expLabel = "진입 / 추적 중"; reflection = "검증이력 진행 중"; }

                            return (
                              <div
                                key={idx}
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "85px 70px 90px 65px 120px 140px 100px 1fr",
                                  gap: 8,
                                  fontSize: "0.72rem",
                                  color: UI.body,
                                  alignItems: "center",
                                  padding: "4px",
                                  borderBottom: "1px solid #1e293b44"
                                }}
                              >
                                <span style={{ color: UI.mutedSoft, fontSize: "0.65rem" }}>{row.ts ? row.ts.slice(11, 19) : "-"}</span>
                                <strong>{row.market.replace("KRW-", "")}</strong>
                                <span style={{ 
                                  color: row.state.includes("WIN") ? UI.pass : row.state.includes("LOSS") ? UI.fail : UI.body,
                                  fontSize: "0.68rem"
                                }}>
                                  {row.state}
                                </span>
                                <span style={{ 
                                  color: row.pnlPct != null ? (row.pnlPct >= 0 ? UI.pass : UI.fail) : UI.body,
                                  fontSize: "0.68rem"
                                }}>
                                  {row.pnlPct != null ? `${row.pnlPct.toFixed(2)}%` : "-"}
                                </span>
                                <span style={{ fontSize: "0.68rem", color: UI.mutedSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.profileReason}>{row.profileReason}</span>
                                <span style={{ fontSize: "0.68rem" }}>{expLabel}</span>
                                <span style={{ fontSize: "0.65rem", color: "#f59e0b" }}>{row.paperRiskTags.slice(0, 1).join(", ")}</span>
                                <span style={{ fontSize: "0.68rem", color: UI.mutedSoft }}>{reflection}</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ fontSize: "0.74rem", color: UI.mutedSoft }}>급등주 판단 데이터 수집 중</div>
                      )}
                    </div>
                  </div>

                  {/* 진단 영역 */}
                  <div 
                    style={{ 
                      marginTop: "0.5rem", 
                      padding: "0.6rem 0.8rem", 
                      background: UI.cardSoftBg, 
                      borderRadius: 8, 
                      border: `1px solid ${UI.borderSoft}`,
                      fontSize: "0.72rem",
                      color: UI.mutedSoft,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "1rem",
                      flexWrap: "wrap"
                    }}
                  >
                    <div style={{ display: "flex", gap: "1rem" }}>
                      <span>Status: <strong style={{ color: paperSummary.statusCode === "ok" ? UI.pass : UI.watch }}>{paperSummary.statusCode.toUpperCase()}</strong></span>
                      <span>Source: <strong>{paperSummary.dataSource}</strong></span>
                      <span>Age: <strong>{paperSummary.statusAgeMs}ms</strong></span>
                    </div>
                    <div style={{ display: "flex", gap: "1rem" }}>
                      <span>Universe: <strong>{paperSummary.universeCount}</strong></span>
                      <span>Candidates: <strong>{paperSummary.candidateCount}</strong></span>
                      <span>ShadowV2: <strong>{paperSummary.shadowV2Count}</strong></span>
                    </div>
                    {paperSummary.degradedReasons.length > 0 && (
                      <div style={{ width: "100%", marginTop: 4, color: UI.watch }}>
                        Degraded: {paperSummary.degradedReasons.join(", ")}
                      </div>
                    )}
                    {paperSummary.statusCode === "stale" && (
                      <div style={{ width: "100%", marginTop: 4, color: UI.watch }}>
                        주의: 오래된 캐시 데이터를 표시 중입니다.
                      </div>
                    )}
                    {paperSummary.statusCode === "degraded" && (
                      <div style={{ width: "100%", marginTop: 4, color: UI.watch }}>
                        주의: 일부 데이터 누락으로 제한 표시 중입니다.
                      </div>
                    )}
                  </div>
                </div>
              );
            } catch (err) {
              return <p style={{ margin: 0, color: UI.muted, fontSize: "0.82rem" }}>UI 렌더링 중 오류가 발생했습니다: {String(err)}</p>;
            }
          })()}
        </section>

        <SignalHistorySection
          recentFillRows={recentFillRows}
          latestCycleRows={latestCycleRows}
          parseSignalPayload={parseSignalPayload}
          isPass={isPass}
          isNearMissFiveOfSix={isNearMissFiveOfSix}
          getCardFailReason={getCardFailReason}
          formatTsLocal={formatTsLocal}
          paperStats={paperSummary?.experienceStats ?? []}
          autoTradeEnabled={autoTradeEnabled}
        />

        {err ? (
          <p
            role="alert"
            style={{
              color: UI.error,
              marginTop: "0.75rem",
              fontSize: "0.82rem",
              background: UI.errorChipBg,
              border: `1px solid ${UI.errorChipBorder}`,
              borderRadius: 999,
              display: "inline-block",
              padding: "0.2rem 0.65rem",
              fontWeight: 700,
            }}
          >
            오류: {err}
          </p>
        ) : null}
      </main>
    </div>
  );
}

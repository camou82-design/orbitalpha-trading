"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** 브라우저/중간 프록시가 GET을 재사용하지 않도록 요청 헤더 보강 */
const REALTIME_FETCH_HEADERS: HeadersInit = {
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

type DashboardFreshTier = "live" | "delayed" | "stale" | "frozen";

function dashboardTierFromAgeSeconds(ageSec: number | null): DashboardFreshTier {
  if (ageSec === null || !Number.isFinite(ageSec)) return "frozen";
  if (ageSec <= 15) return "live";
  if (ageSec <= 60) return "delayed";
  if (ageSec <= 180) return "stale";
  return "frozen";
}

function dashboardTierLabelKo(t: DashboardFreshTier): string {
  switch (t) {
    case "live":
      return "실시간 정상";
    case "delayed":
      return "지연 중";
    case "stale":
      return "오래된 데이터, 매매 판단 금지";
    case "frozen":
      return "화면 고정 의심, 서버 로그 기준 확인 필요";
  }
}

function readTradeDashboardRuntime(trade: unknown): Record<string, unknown> | null {
  if (!trade || typeof trade !== "object") return null;
  const dr = (trade as Record<string, unknown>).dashboard_runtime;
  return dr && typeof dr === "object" ? (dr as Record<string, unknown>) : null;
}

function parseDashboardPositionRow(dr: Record<string, unknown> | null, market: string): Record<string, unknown> | undefined {
  if (!dr) return undefined;
  const ps = dr.position_source_summary as Record<string, unknown> | undefined;
  const by = ps && typeof ps === "object" ? (ps.by_market as Record<string, unknown> | undefined) : undefined;
  const row = by?.[market];
  return row && typeof row === "object" ? (row as Record<string, unknown>) : undefined;
}

function parseAgeSecondsMaybe(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 1000);
}

function parseDashboardSectionStatus(ageSeconds: number | null): DashboardFreshTier {
  return dashboardTierFromAgeSeconds(ageSeconds);
}

function parseIsoField(v: unknown): string | null {
  return typeof v === "string" && v.length > 2 ? v : null;
}

function parseDashboardTimeline(trade: unknown, dashboardReceivedAtIso: string | null, dashboardRenderedAtIso: string | null) {
  const dr = readTradeDashboardRuntime(trade);
  const cap = dr?.capital_policy_latest as Record<string, unknown> | undefined;
  const holdings = dr?.holdings_snapshot as Record<string, unknown> | undefined;
  return {
    dr,
    server_now: parseIsoField(dr?.server_now),
    api_response_at: parseIsoField(dr?.api_response_at),
    live_loop_latest_ts: parseIsoField(dr?.live_loop_latest_ts),
    capital_policy_updated_at: parseIsoField(cap?.source_updated_at),
    holdings_updated_at: parseIsoField(holdings?.source_updated_at),
    scanner_updated_at: parseIsoField(dr?.scanner_updated_at),
    candidate_updated_at: parseIsoField(dr?.candidate_updated_at),
    position_state_updated_at: parseIsoField(dr?.position_state_updated_at),
    dashboard_received_at: dashboardReceivedAtIso,
    dashboard_rendered_at: dashboardRenderedAtIso,
    liveAgeSec: parseAgeSecondsMaybe(parseIsoField(dr?.live_loop_latest_ts)),
  };
}

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

const CORE_TRADE_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX", "KRW-DOGE"] as const;
const DASHBOARD_MARKETS = CORE_TRADE_MARKETS;
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
  spot_trading_equity_krw?: number;
  excluded_usdt_value_krw?: number;
  okx_transfer_reserve_krw?: number;
  total_asset_equity_krw?: number;
  core_cap_amount?: number;
  surge_cap_amount?: number;
  core_used_capital_krw?: number;
  surge_used_capital_krw?: number;
  core_pending_buy_reserved_krw?: number;
  surge_pending_buy_reserved_krw?: number;
  core_remaining_krw?: number;
  surge_remaining_krw?: number;
  spotTradingEquityKrw?: number;
  excludedUsdtValueKrw?: number;
  okxTransferReserveKrw?: number;
  totalAssetEquityKrw?: number;
  coreCapAmount?: number;
  surgeCapAmount?: number;
  coreUsedCapital?: number;
  surgeUsedCapital?: number;
  corePendingBuyReserved?: number;
  surgePendingBuyReserved?: number;
  coreRemaining?: number;
  surgeRemaining?: number;
  degraded?: boolean;
  degraded_reason?: string;
  last_good_age_ms?: number;
  dashboard_runtime?: Record<string, unknown>;
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
  diagnostics?: {
    universe_count: number;
    scanned_count: number;
    candidate_count: number;
    watchlist_added_count: number;
    watchlist_watching_count: number;
    surge_v2_eval_count: number;
    final_buy_attempt_count: number;
    skipped_by_reason: Record<string, number>;
    updated_at: string;
  } | null;
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
  early_positions?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  surge_watchlist?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  morning_surge_watchlist?: Record<string, any>;
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

type LiveCapitalApiReady = {
  ready: true;
  totalAssetEquityKrw: number;
  excludedUsdtValueKrw: number;
  okxTransferReserveKrw: number;
  spotTradingEquityKrw: number;
  availableKrw: number;
  coreCapAmount: number;
  surgeCapAmount: number;
  coreUsedCapital: number;
  surgeUsedCapital: number;
  corePendingBuyReserved: number;
  surgePendingBuyReserved: number;
  coreRemaining: number;
  surgeRemaining: number;
};

type LiveCapitalApiState = LiveCapitalApiReady | { ready: false; reason: string };

function readFinite(tr: Record<string, unknown>, snake: string, camel: string): number | null {
  const raw = tr[snake] !== undefined && tr[snake] !== null ? tr[snake] : tr[camel];
  const x = Number(raw);
  return Number.isFinite(x) ? x : null;
}

/** 서버 필드만 사용. 누락 시 ready=false (구형 클라이언트 추정 금지). */
function deriveLiveCapitalApiState(trade: TradeStatus | null, krwAvailableFallback: number): LiveCapitalApiState {
  if (!trade?.api_connected) return { ready: false, reason: "API 미연결" };
  const t = trade as unknown as Record<string, unknown>;
  const totalAssetEquityKrw = readFinite(t, "total_asset_equity_krw", "totalAssetEquityKrw");
  const spotTradingEquityKrw = readFinite(t, "spot_trading_equity_krw", "spotTradingEquityKrw");
  const excludedUsdtValueKrw = readFinite(t, "excluded_usdt_value_krw", "excludedUsdtValueKrw");
  const okxTransferReserveKrwRaw = readFinite(t, "okx_transfer_reserve_krw", "okxTransferReserveKrw");
  const okxTransferReserveKrw =
    okxTransferReserveKrwRaw ??
    (excludedUsdtValueKrw != null ? excludedUsdtValueKrw : null);
  const coreCapAmount = readFinite(t, "core_cap_amount", "coreCapAmount");
  const surgeCapAmount = readFinite(t, "surge_cap_amount", "surgeCapAmount");
  const coreUsedCapital = readFinite(t, "core_used_capital_krw", "coreUsedCapital");
  const surgeUsedCapital = readFinite(t, "surge_used_capital_krw", "surgeUsedCapital");
  const corePendingBuyReserved =
    readFinite(t, "core_pending_buy_reserved_krw", "corePendingBuyReserved") ?? 0;
  const surgePendingBuyReserved =
    readFinite(t, "surge_pending_buy_reserved_krw", "surgePendingBuyReserved") ?? 0;
  const coreRemaining = readFinite(t, "core_remaining_krw", "coreRemaining");
  const surgeRemaining = readFinite(t, "surge_remaining_krw", "surgeRemaining");
  const apKrw = trade.account_portfolio?.krw_available_krw;
  const availableKrw = Number.isFinite(Number(apKrw)) ? Number(apKrw) : krwAvailableFallback;

  if (
    totalAssetEquityKrw == null ||
    spotTradingEquityKrw == null ||
    excludedUsdtValueKrw == null ||
    okxTransferReserveKrw == null ||
    coreCapAmount == null ||
    surgeCapAmount == null ||
    coreUsedCapital == null ||
    surgeUsedCapital == null ||
    coreRemaining == null ||
    surgeRemaining == null
  ) {
    return { ready: false, reason: "데이터 대기" };
  }

  return {
    ready: true,
    totalAssetEquityKrw,
    spotTradingEquityKrw,
    excludedUsdtValueKrw,
    okxTransferReserveKrw,
    availableKrw,
    coreCapAmount,
    surgeCapAmount,
    coreUsedCapital,
    surgeUsedCapital,
    corePendingBuyReserved,
    surgePendingBuyReserved,
    coreRemaining,
    surgeRemaining,
  };
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
  const [lastKnownAutoTradeEnabled, setLastKnownAutoTradeEnabled] = useState<boolean | null>(null);
  const [autoTradeStatusConfirmedSource, setAutoTradeStatusConfirmedSource] = useState<"server" | "session" | "uncertain">("uncertain");
  const [autoTradeChangedAt, setAutoTradeChangedAt] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [canEnableAutoTrade, setCanEnableAutoTrade] = useState(false);
  const [cannotEnableReason, setCannotEnableReason] = useState<string | null>(null);
  const [authState, setAuthState] = useState<"ok" | "loading" | "expired" | "error">("loading");
  const [strategy, setStrategy] = useState<StrategyStatus | null>(null);
  const [scanner, setScanner] = useState<PumpScannerStatus | null>(null);
  const [paper, setPaper] = useState<PaperStatus | null>(null);
  const [accountHoldings, setAccountHoldings] = useState<{ used_slots?: number; holdings?: Array<Record<string, unknown>> } | null>(null);
  const [paperPanelError, setPaperPanelError] = useState<string | null>(null);
  const [marketState, setMarketState] = useState<MarketStateStatus | null>(null);
  const [accountSyncState, setAccountSyncState] = useState<"idle" | "syncing" | "ok" | "error" | "failed">("idle");
  const [dashTradeRefreshing, setDashTradeRefreshing] = useState(false);
  const [lastTradePollOkAtMs, setLastTradePollOkAtMs] = useState<number | null>(null);
  const [lastTradePollErrAtMs, setLastTradePollErrAtMs] = useState<number | null>(null);
  const [tradePollFailStreak, setTradePollFailStreak] = useState(0);
  const [dashboardReceivedAtIso, setDashboardReceivedAtIso] = useState<string | null>(null);
  const [dashboardRenderedAtIso, setDashboardRenderedAtIso] = useState<string | null>(null);
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
      const r = await fetch(url, {
        cache: "no-store",
        credentials: "include",
        signal: ctrl.signal,
        headers: REALTIME_FETCH_HEADERS,
      });
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
    accountHoldings,
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

            const payloadVal = session.auto_trade_enabled;
            if (typeof payloadVal === "boolean") {
              const prev = autoTradeEnabled;
              setAutoTradeEnabled(payloadVal);
              setLastKnownAutoTradeEnabled(payloadVal);
              setAutoTradeStatusConfirmedSource("session");
              setAutoTradeChangedAt(typeof session.auto_trade_changed_at === "string" ? session.auto_trade_changed_at : null);

              if (prev !== payloadVal) {
                devLog({
                  tag: "AUTO_TRADE_STATUS_POLLING_GAP_PROTECTION_PROOF",
                  source: "session_poll",
                  prev_state: prev,
                  next_state: payloadVal,
                  action: "update",
                  reason: "session_payload_confirmed"
                });
              }
            } else {
              devLog({
                tag: "AUTO_TRADE_STATUS_POLLING_GAP_PROTECTION_PROOF",
                source: "session_poll",
                prev_state: autoTradeEnabled,
                next_candidate: payloadVal,
                action: "preserve",
                reason: payloadVal === null ? "session_payload_null" : "session_payload_missing"
              });
              // Do NOT setAutoTradeEnabled(false) here. Maintain last known.
            }
          },
          onErr: (e) => {
            if (cancelled) return;
            const msg = e instanceof Error ? e.message : "session_fetch_failed";
            setSessionPanelWarning({ code: "session_fetch_failed", message: msg.slice(0, 180) });
            setAuthState((prev) => (prev === "loading" ? "ok" : prev));

            devLog({
              tag: "DASHBOARD_TRADE_STATUS_401_PRESERVE_LAST_KNOWN_AUTO_TRADE",
              error: msg,
              last_known: lastKnownAutoTradeEnabled,
              current_ui_state: autoTradeEnabled
            });
            setAutoTradeStatusConfirmedSource("uncertain");
          },
        },
      );
    };

    const pollTradeOnce = async () => {
      setDashTradeRefreshing(true);
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
            const castT = t as TradeStatus;
            /** 평가·가격·cap 변동까지 반영하려면 거래 상태는 매 폴링 갱신(시그니처 dedupe 금지) */
            setDashboardReceivedAtIso(new Date().toISOString());
            setTrade(castT);
            const softStale = tradePollRes.failureCode === "soft_fetch_failed_with_last_good";
            if (softStale) {
              setLastTradePollErrAtMs(Date.now());
              setTradePollFailStreak((x) => x + 1);
              console.info(
                JSON.stringify({
                  tag: "DASHBOARD_FETCH_FRESHNESS_PROOF",
                  section: "trade_status",
                  status: "stale",
                  reason: tradePollRes.failureMessage ?? tradePollRes.failureCode,
                  server_now: parseIsoField(readTradeDashboardRuntime(castT)?.server_now ?? null),
                  dashboard_received_at: new Date().toISOString(),
                  api_response_at: parseIsoField(readTradeDashboardRuntime(castT)?.api_response_at ?? null),
                  source_updated_at: parseIsoField(readTradeDashboardRuntime(castT)?.live_loop_latest_ts ?? null),
                  displayed_value: "last_good_payload",
                  source_value: "last_good_payload",
                  age_seconds: null,
                }),
              );
            } else {
              setLastTradePollOkAtMs(Date.now());
              setTradePollFailStreak(0);
            }

            const serverVal = castT.auto_trade_enabled;
            if (typeof serverVal === "boolean") {
              const prev = autoTradeEnabled;
              setAutoTradeEnabled(serverVal);
              setLastKnownAutoTradeEnabled(serverVal);
              setAutoTradeStatusConfirmedSource("server");
              if (prev !== serverVal) {
                devLog({
                  tag: "AUTO_TRADE_STATUS_POLLING_GAP_PROTECTION_PROOF",
                  source: "trade_poll",
                  prev_state: prev,
                  next_state: serverVal,
                  action: "update",
                  reason: "server_payload_confirmed"
                });
              }
            } else {
              devLog({
                tag: "AUTO_TRADE_STATUS_POLLING_GAP_PROTECTION_PROOF",
                source: "trade_poll",
                prev_state: autoTradeEnabled,
                next_candidate: serverVal,
                action: "preserve",
                reason: serverVal === null ? "server_payload_null" : "server_payload_missing"
              });
            }

            setLastClientTradeFailure(null);
            const p = t as TradeStatus;
            if (p.api_connected) setAccountSyncState("ok");
            else if (p.env_access_key_present && p.env_secret_key_present) setAccountSyncState("error");
            else setAccountSyncState("ok");
            setAuthState((prev) => (prev === "loading" ? "ok" : prev));
          } else if (tradePollRes.failureCode) {
            setLastTradePollErrAtMs(Date.now());
            setTradePollFailStreak((x) => x + 1);
            setLastClientTradeFailure({ code: tradePollRes.failureCode, message: tradePollRes.failureMessage ?? "" });
            devLog({
              tag: "DASHBOARD_TRADE_STATUS_401_PRESERVE_LAST_KNOWN_AUTO_TRADE",
              error: tradePollRes.failureCode,
              last_known: lastKnownAutoTradeEnabled,
              current_ui_state: autoTradeEnabled
            });
            setAutoTradeStatusConfirmedSource("uncertain");
          } else {
            setLastTradePollErrAtMs(Date.now());
            setTradePollFailStreak((x) => x + 1);
          }
      } catch {
        setLastTradePollErrAtMs(Date.now());
        setTradePollFailStreak((x) => x + 1);
      } finally {
        window.clearTimeout(tid);
        pollInFlightRef.current.delete(slotKey);
        setDashTradeRefreshing(false);
      }
    };

    const bootstrap = async () => {
      await pollSessionOnce();

      // start loops (staggered & independent)
      scheduleLoop("auth_session", pollSessionOnce, 45_000, 60_000);
      scheduleLoop("trade_status", pollTradeOnce, 4_000, 9_000);
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
        20_000,
        55_000,
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
        20_000,
        55_000,
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
                sg: asRecord(x).safety_guard_state,
                open: asRecord(x).open_positions,
                early: asRecord(x).early_positions,
                pnl: asRecord(x).strategy_pnl_krw,
                invested: asRecord(x).strategy_invested_krw,
              }));
            },
          });
        },
        4000,
        9000,
      );

      scheduleLoop(
        "account_holdings",
        async () => {
          const ts = Date.now();
          await pollJson<{ used_slots?: number; holdings?: Array<Record<string, unknown>> }>(
            "account_holdings",
            `/api/v1/account/holdings?_=${ts}`,
            {
              timeoutMs: 9000,
              onOk: (h) => {
                if (cancelled) return;
                setIfChanged(
                  "account_holdings",
                  h,
                  setAccountHoldings,
                  (x) =>
                    `${Number(asRecord(x).used_slots ?? 0)}|${JSON.stringify(asArray(asRecord(x).holdings))}`,
                );
              },
            },
          );
        },
        4000,
        9000,
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
                items_ser: JSON.stringify(asArray(r.items)),
              }));
            },
          });
        },
        3500,
        9000,
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
        20_000,
        55_000,
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
                ms: String(r.market_state ?? ""),
              }));
            },
          });
        },
        3500,
        9000,
      );

      // UI updated clock (cheap) — 루프 주기와 맞춰 운영자에게 “틱 변화” 피드백
      scheduleLoop(
        "updated_at",
        async () => {
          if (cancelled) return;
          setLastUpdatedAt(new Date().toLocaleTimeString("ko-KR", { hour12: false }));
        },
        4_000,
        15000,
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
    const drTs = parseIsoField(readTradeDashboardRuntime(trade)?.live_loop_latest_ts);
    if (drTs) return drTs;
    const candidates = [ctx?.last_strategy_tick_at, ctx?.last_market_state_tick_at].filter((v): v is string => typeof v === "string" && v.length > 0);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Date.parse(b) - Date.parse(a));
    return candidates[0] ?? null;
  }, [trade, ctx]);

  const dashTimeline = useMemo(
    () => parseDashboardTimeline(trade, dashboardReceivedAtIso, dashboardRenderedAtIso),
    [trade, dashboardReceivedAtIso, dashboardRenderedAtIso],
  );

  const liveFreshTier = useMemo(() => dashboardTierFromAgeSeconds(dashTimeline.liveAgeSec), [dashTimeline.liveAgeSec]);

  const capitalPolicyAgeSec = useMemo(
    () => parseAgeSecondsMaybe(dashTimeline.capital_policy_updated_at),
    [dashTimeline.capital_policy_updated_at],
  );
  const holdingsEvalAgeSec = useMemo(
    () => parseAgeSecondsMaybe(dashTimeline.holdings_updated_at),
    [dashTimeline.holdings_updated_at],
  );
  const scannerDataAgeSec = useMemo(
    () => parseAgeSecondsMaybe(dashTimeline.scanner_updated_at),
    [dashTimeline.scanner_updated_at],
  );
  const candidateDataAgeSec = useMemo(
    () => parseAgeSecondsMaybe(dashTimeline.candidate_updated_at),
    [dashTimeline.candidate_updated_at],
  );

  const tierChip = (t: DashboardFreshTier) => (
    <span
      style={{
        fontSize: "0.62rem",
        fontWeight: 900,
        padding: "0.12rem 0.45rem",
        borderRadius: 6,
        border: "1px solid #334155",
        color: t === "live" ? "#22c55e" : t === "delayed" ? "#eab308" : t === "stale" ? "#fb923c" : "#ef4444",
        background: "#0b1220",
      }}
    >
      {t.toUpperCase()}
    </span>
  );

  useLayoutEffect(() => {
    setDashboardRenderedAtIso(new Date().toISOString());
  }, [trade]);

  useEffect(() => {
    const tl = dashTimeline;
    const row = {
      tag: "DASHBOARD_RENDER_STATE_PROOF",
      server_now: tl.server_now,
      dashboard_received_at: tl.dashboard_received_at,
      dashboard_rendered_at: tl.dashboard_rendered_at,
      api_response_at: tl.api_response_at,
      live_loop_latest_ts: tl.live_loop_latest_ts,
      capital_policy_updated_at: tl.capital_policy_updated_at,
      holdings_updated_at: tl.holdings_updated_at,
      scanner_updated_at: tl.scanner_updated_at,
      candidate_updated_at: tl.candidate_updated_at,
      position_state_updated_at: tl.position_state_updated_at,
      live_loop_age_seconds: dashTimeline.liveAgeSec,
      live_tier: liveFreshTier,
      trade_poll_fail_streak: tradePollFailStreak,
      degraded: Boolean((trade as TradeStatus | null)?.degraded),
    };
    console.info(JSON.stringify(row));
  }, [trade, dashTimeline, liveFreshTier, tradePollFailStreak]);

  useEffect(() => {
    const tl = dashTimeline;
    const staleish = liveFreshTier === "stale" || liveFreshTier === "frozen";
    if (staleish) {
      console.info(
        JSON.stringify({
          tag: "DASHBOARD_STALE_DATA_PROOF",
          server_now: tl.server_now,
          dashboard_received_at: tl.dashboard_received_at,
          api_response_at: tl.api_response_at,
          source_updated_at: tl.live_loop_latest_ts,
          age_seconds: dashTimeline.liveAgeSec,
          section: "live_loop",
          status: liveFreshTier,
          displayed_value: tl.live_loop_latest_ts,
          reason: "live_strategy_tick_age_vs_client_clock",
        }),
      );
    }
    const axl = parseDashboardPositionRow(tl.dr, "KRW-AXL");
    if (axl) {
      console.info(
        JSON.stringify({
          tag: "DASHBOARD_POSITION_SOURCE_PROOF",
          market: "KRW-AXL",
          server_now: tl.server_now,
          dashboard_received_at: tl.dashboard_received_at,
          row: axl,
        }),
      );
    }
  }, [trade, dashTimeline, liveFreshTier]);

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

  const managedMarketSet = useMemo(() => {
    const out = new Set<string>();
    for (const [m, meta] of Object.entries(trade?.strategy_positions ?? {})) {
      if (!m.startsWith("KRW-")) continue;
      if (Number((meta as { qty?: unknown } | null | undefined)?.qty ?? 0) > 0) out.add(m);
    }
    for (const [m, pos] of Object.entries(strategy?.open_positions ?? {})) {
      if (!m.startsWith("KRW-")) continue;
      if (Number((pos as { remaining_qty?: unknown } | null | undefined)?.remaining_qty ?? 0) > 0) out.add(m);
    }
    return out;
  }, [trade, strategy]);

  const passiveHoldingCards = useMemo(
    () =>
      holdingCards.filter(
        (h) => h.qty > 0 && !managedMarketSet.has(h.market) && String(h.currency).toUpperCase() !== "USDT",
      ),
    [holdingCards, managedMarketSet],
  );

  const okxUsdtHolding = useMemo(() => {
    const b = (trade?.balances ?? []).find((x) => String(x?.currency ?? "").toUpperCase() === "USDT");
    if (!b) return null;
    const qty = Number(b.balance ?? 0) + Number(b.locked ?? 0);
    return { qty, locked: Number(b.locked ?? 0) };
  }, [trade?.balances]);

  const managedHoldingCards = useMemo(
    () => holdingCards.filter((h) => h.qty > 0 && managedMarketSet.has(h.market)),
    [holdingCards, managedMarketSet],
  );

  const paperSummary = useMemo<PaperPanelSummary>(() => toPaperPanelSummary(paper), [paper]);

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

  const netRetVal = assetSummary.kpi === "ready" ? assetSummary.netRet : 0;
  const netPnlVal = assetSummary.kpi === "ready" ? assetSummary.netPnl : 0;

  const tradeReadyLabel = useMemo(() => {
    if (accountSyncState === "syncing") return "계좌 동기화 중";
    if (trade?.live_enabled && trade?.api_connected) return "실거래 가능";
    if (trade?.api_connected) return "API 연결됨 · 승인 필요";
    return "API 확인 필요";
  }, [trade, accountSyncState]);

  const liveCapitalApi = useMemo(
    () => deriveLiveCapitalApiState(trade, Number.isFinite(accountAvailableKrw) ? accountAvailableKrw : Number(trade?.krw_available ?? 0)),
    [trade, accountAvailableKrw],
  );

  const surgeUiDiagnostics = useMemo(() => {
    const scannerItems = scanner?.items ?? [];
    const filterPassApprox = scannerItems.filter((it) => Boolean(it.breakout) && Boolean(it.close_upper_hold)).length;
    const coreSetUi = new Set<string>(CORE_TRADE_MARKETS as unknown as string[]);
    const nonCoreRow = signalRows.find(
      (r) => !coreSetUi.has(r.parsed.p.market) && r.parsed.kind === "v2" && !r.parsed.p.filter_pass,
    );
    const recentBlock = nonCoreRow ? getCardFailReason(nonCoreRow.parsed) : "—";
    const surgeCapLine = liveCapitalApi.ready
      ? liveCapitalApi.surgeRemaining >= 5000
        ? "매수 가능 (SURGE cap)"
        : "SURGE cap 차단"
      : "데이터 대기";
    return {
      filterPassApprox,
      signalLogFilterPassApprox: signalRows.filter((r) => r.parsed.kind === "v2" && r.parsed.p.filter_pass).length,
      recentBlockReason: recentBlock,
      surgeCapLine,
      noCandidateReason: entryBlockReason,
      lastRefresh:
        scanner?.updated_at ??
        dashTimeline.dashboard_received_at ??
        recentScannerCalcTs ??
        dashTimeline.live_loop_latest_ts ??
        null,
    };
  }, [scanner, signalRows, liveCapitalApi, entryBlockReason, recentScannerCalcTs, dashTimeline.dashboard_received_at, dashTimeline.live_loop_latest_ts]);

  const coreTradeStatusLabel = (market: string) => {
    const parsed = latestByMarket[market]?.parsed;
    if (!parsed) return "데이터 부족";
    if (managedMarketSet.has(market)) return "보유 중";
    const tone = getCardTone(parsed);
    if (tone === "pass") return "진입 가능";
    if (tone === "none") return "평가 대기";
    return "조건 미충족";
  };

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
      const res = await fetch(`/api/v1/trade/auto-toggle?_=${Date.now()}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(REALTIME_FETCH_HEADERS as Record<string, string>),
        },
        cache: "no-store",
        credentials: "include",
        body: JSON.stringify({ enabled, risk_ack: enabled ? true : false, operatorExplicit: true }),
      });
      if (res.status === 401) {
        router.replace("/login?reason=session_expired");
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "자동매매 상태 변경 실패");
      const nextVal = Boolean(body.auto_trade_enabled);
      setAutoTradeEnabled(nextVal);
      setLastKnownAutoTradeEnabled(nextVal);
      setAutoTradeStatusConfirmedSource("server");
      setAutoTradeChangedAt(typeof body.auto_trade_changed_at === "string" ? body.auto_trade_changed_at : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "toggle failed");
    } finally {
      setToggleBusy(false);
    }
  };

  const onLogout = async () => {
    try {
      await fetch(`/api/v1/auth/logout?_=${Date.now()}`, {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: REALTIME_FETCH_HEADERS,
      });
    } finally {
      router.replace("/login?reason=logged_out");
    }
  };

  const [graphTab, setGraphTab] = useState<"1D" | "1W" | "1M" | "ALL">("1D");

  // Keep dashboard shell visible while trade/account sync runs in background.

  // 1. 기간 필터별 포트폴리오 히스토리 계산
  const filteredHistory = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history = (dashTimeline.dr?.portfolio_history as any[]) ?? [];
    if (history.length === 0) return [];
    
    const now = Date.now();
    let limitMs = 0;
    if (graphTab === "1D") limitMs = 24 * 60 * 60 * 1000;
    else if (graphTab === "1W") limitMs = 7 * 24 * 60 * 60 * 1000;
    else if (graphTab === "1M") limitMs = 30 * 24 * 60 * 60 * 1000;
    else return history; // ALL

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return history.filter((h: any) => now - new Date(h.ts).getTime() <= limitMs);
  }, [dashTimeline.dr?.portfolio_history, graphTab]);

  // 2. 실제 지갑 (balances) 기준 보유 현황 목록 및 관리 여부 계산
  const actualBalances = useMemo(() => {
    const rawBalances = trade?.balances ?? [];
    const openKeys = Object.keys(strategy?.open_positions ?? {});
    const earlyKeys = Object.keys(strategy?.early_positions ?? {});
    const managedSet = new Set([...openKeys, ...earlyKeys]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rawBalances.map((b: any) => {
      const isKrw = b.currency === "KRW";
      const currencyKey = `KRW-${b.currency}`;
      
      const isManaged = !isKrw && managedSet.has(currencyKey);
      
      return {
        currency: b.currency,
        qty: Number(b.qty ?? 0),
        avg_buy_price: Number(b.avg_buy_price ?? 0),
        current_price: Number(b.current_price ?? 0),
        pnl_krw: Number(b.pnl_krw ?? 0),
        pnl_pct: Number(b.pnl_pct ?? 0),
        is_managed: isManaged,
      };
    });
  }, [trade?.balances, strategy?.open_positions, strategy?.early_positions]);

  const managedSymbolsSet = useMemo(() => {
    const openKeys = Object.keys(strategy?.open_positions ?? {});
    const earlyKeys = Object.keys(strategy?.early_positions ?? {});
    return new Set([...openKeys, ...earlyKeys]);
  }, [strategy?.open_positions, strategy?.early_positions]);

  const visibleBalances = useMemo(() => {
    const MIN_VISIBLE_BALANCE_KRW = 1000;
    return actualBalances.filter((row) => {
      if (row.currency === "KRW") return true;
      const currencyKey = `KRW-${row.currency}`;
      const isManaged = row.is_managed === true || managedSymbolsSet.has(currencyKey);
      if (isManaged) return true;
      const valueKrw = Number(row.qty ?? 0) * Number(row.current_price ?? 0);
      return valueKrw >= MIN_VISIBLE_BALANCE_KRW;
    });
  }, [actualBalances, managedSymbolsSet]);

  const managedPositionsKeys = useMemo(() => {
    const openKeys = Object.keys(strategy?.open_positions ?? {});
    const earlyKeys = Object.keys(strategy?.early_positions ?? {});
    return Array.from(new Set([...openKeys, ...earlyKeys]));
  }, [strategy?.open_positions, strategy?.early_positions]);

  // 3. 손실 현황 패널 요약 데이터 계산
  const lossSummary = useMemo(() => {
    let totalPnlKrw = 0;
    let lossCount = 0;
    let totalCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let maxLossItem: any = null;

    actualBalances.forEach((item) => {
      if (item.currency === "KRW") return;
      totalCount++;
      totalPnlKrw += item.pnl_krw;
      if (item.pnl_krw < 0) {
        lossCount++;
        if (!maxLossItem || item.pnl_krw < maxLossItem.pnl_krw) {
          maxLossItem = item;
        }
      }
    });

    const totalAsset = (liveCapitalApi.ready ? liveCapitalApi.totalAssetEquityKrw : 0) || 1;
    const dailyLossPct = (totalPnlKrw / totalAsset) * 100;

    return {
      totalPnlKrw,
      lossCount,
      totalCount,
      maxLossItem,
      dailyLossPct,
    };
  }, [actualBalances, liveCapitalApi]);

  if (authState === "expired") {
    return (
      <div style={{ background: UI.pageOuterBg, minHeight: "100vh", display: "grid", placeItems: "center", color: UI.body }}>
        세션이 만료되었습니다. 로그인 페이지로 이동합니다.
      </div>
    );
  }

  // NOTE: auth/session 오류는 전체 화면을 죽이지 않는다. (401/unauthenticated만 만료 처리)

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

        {/* 1. 상단 헤더 정리 */}
        <header
          style={{
            marginBottom: "0.9rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.8rem",
            flexWrap: "wrap",
            borderBottom: `1px solid ${UI.borderSoft}`,
            paddingBottom: "0.8rem"
          }}
        >
          <div>
            <h1 style={{ fontSize: "1.35rem", fontWeight: 900, letterSpacing: "0.03em", margin: 0, color: UI.title }}>
              Orbitalpha Trading
            </h1>
            <p style={{ margin: "0.22rem 0 0", fontSize: "0.76rem", color: UI.muted, fontWeight: 600 }}>대표 계좌 현황 및 주요 지표</p>
          </div>
          
          <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "0.74rem", background: "#0a192f", border: `1px solid ${UI.borderSoft}`, padding: "0.25rem 0.55rem", borderRadius: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: trade?.api_connected ? UI.pass : UI.fail }} />
              API: <strong style={{ color: trade?.api_connected ? UI.pass : UI.fail }}>{trade?.api_connected ? "연결됨" : "미연결"}</strong>
            </span>

            <span style={{ fontSize: "0.74rem", background: "#0a192f", border: `1px solid ${UI.borderSoft}`, padding: "0.25rem 0.55rem", borderRadius: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: autoTradeEnabled ? UI.pass : UI.fail }} />
              자동매매: <strong style={{ color: autoTradeEnabled ? UI.pass : UI.fail }}>{autoTradeEnabled ? "ON" : "OFF"}</strong>
            </span>

            <span style={{ fontSize: "0.74rem", background: "#0a192f", border: `1px solid ${UI.borderSoft}`, padding: "0.25rem 0.55rem", borderRadius: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
              시장: <strong style={{ color: marketState?.market_state === "risk_off" ? UI.watch : UI.pass }}>
                {marketState?.market_state === "risk_on" ? "상방장" : marketState?.market_state === "neutral" ? "횡보장" : marketState?.market_state === "risk_off" ? "하락장" : "-"}
              </strong>
            </span>

            <span style={{ fontSize: "0.72rem", color: UI.mutedSoft }}>
              업데이트: {lastTradePollOkAtMs ? new Date(lastTradePollOkAtMs).toLocaleTimeString("ko-KR", { hour12: false }) : "—"}
            </span>

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

        {/* 긴급 운영 수정 상태 배너 */}
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.85rem 1.1rem",
            borderRadius: 12,
            background: "#1e1b4b",
            border: "1px solid #4338ca",
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <span style={{
              fontSize: "0.72rem",
              background: trade?.live_order_confirm ? "#b91c1c" : "#0f766e",
              color: "#ffffff",
              padding: "0.15rem 0.45rem",
              borderRadius: 6,
              fontWeight: 800,
              letterSpacing: "0.02em"
            }}>
              {trade?.live_order_confirm ? "LIVE ORDER ACTIVE (실주문 기동)" : "LIVE ORDER CONFIRM OFF (실주문 잠금)"}
            </span>
            <span style={{
              fontSize: "0.72rem",
              background: autoTradeEnabled ? "#b91c1c" : "#1e293b",
              color: "#ffffff",
              padding: "0.15rem 0.45rem",
              borderRadius: 6,
              fontWeight: 800,
            }}>
              자동매매: {autoTradeEnabled ? "ON" : "OFF (정지)"}
            </span>
            <span style={{
              fontSize: "0.72rem",
              background: "#6b21a8",
              color: "#ffffff",
              padding: "0.15rem 0.45rem",
              borderRadius: 6,
              fontWeight: 800,
            }}>
              보호 상태: 비관리 보유분(passive_holding) 청산 대상 제외 보장
            </span>
          </div>
          <div style={{ fontSize: "0.76rem", color: "#cbd5e1", fontWeight: 500, lineHeight: 1.4 }}>
            {!trade?.live_order_confirm ? (
              <span>⚠️ <strong>현재 실주문 잠금 상태 (LIVE_ORDER_CONFIRM=false)</strong>입니다. 어떠한 경우에도 실제 매수/매도 주문이 거래소로 전송되지 않고 Mocking 처리됩니다.</span>
            ) : (
              <span>🔴 <strong>실주문 활성화 상태</strong>입니다. 환경 변수와 자동매매 설정을 확인하십시오.</span>
            )}
            {!autoTradeEnabled && (
              <span style={{ marginLeft: "0.5rem" }}>🤖 <strong>자동매매 OFF</strong> 상태로 봇이 자동으로 진입이나 청산을 수행하지 않습니다.</span>
            )}
          </div>
        </div>

        {/* 2. 상단 KPI 카드 4개만 유지 */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          <div style={{ background: UI.cardBg, border: `1px solid ${UI.border}`, borderRadius: 12, padding: "0.9rem 1rem", boxShadow: "0 4px 20px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: "0.74rem", color: UI.muted, marginBottom: 5, fontWeight: 700 }}>총 자산</div>
            <div style={{ fontSize: "1.65rem", fontWeight: 900, color: UI.title, lineHeight: 1.1 }}>
              {liveCapitalApi.ready ? Math.round(liveCapitalApi.totalAssetEquityKrw).toLocaleString() : "데이터 대기"}
            </div>
            <div style={{ fontSize: "0.68rem", color: UI.mutedSoft, marginTop: 4 }}>
              실거래 분배 기준: {liveCapitalApi.ready ? Math.round(liveCapitalApi.spotTradingEquityKrw).toLocaleString() : "—"} KRW
            </div>
          </div>

          <div style={{ background: UI.cardBg, border: `1px solid ${UI.border}`, borderRadius: 12, padding: "0.9rem 1rem", boxShadow: "0 4px 20px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: "0.74rem", color: UI.muted, marginBottom: 5, fontWeight: 700 }}>보유 가능 KRW</div>
            <div style={{ fontSize: "1.65rem", fontWeight: 900, color: UI.title, lineHeight: 1.1 }}>
              {liveCapitalApi.ready ? Math.round(liveCapitalApi.availableKrw).toLocaleString() : "—"}
            </div>
            <div style={{ fontSize: "0.68rem", color: UI.mutedSoft, marginTop: 4 }}>
              대시보드 가용액 기준
            </div>
          </div>

          <div style={{ background: UI.cardBg, border: `1px solid ${UI.border}`, borderRadius: 12, padding: "0.9rem 1rem", boxShadow: "0 4px 20px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: "0.74rem", color: UI.muted, marginBottom: 5, fontWeight: 700 }}>오늘 손익</div>
            <div style={{ fontSize: "1.65rem", fontWeight: 900, color: accountPnlKrw >= 0 ? UI.pass : UI.watch, lineHeight: 1.1 }}>
              {accountPnlKrw >= 0 ? "+" : ""}{Math.round(accountPnlKrw).toLocaleString()}
            </div>
            <div style={{ fontSize: "0.68rem", color: accountPnlKrw >= 0 ? UI.pass : UI.watch, marginTop: 4, fontWeight: 700 }}>
              {accountPnlPct >= 0 ? "+" : ""}{accountPnlPct.toFixed(2)}% (실현손익)
            </div>
          </div>

          <div style={{ background: UI.cardBg, border: `1px solid ${UI.border}`, borderRadius: 12, padding: "0.9rem 1rem", boxShadow: "0 4px 20px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: "0.74rem", color: UI.muted, marginBottom: 5, fontWeight: 700 }}>총 수익률 / 평가손익</div>
            <div style={{ fontSize: "1.65rem", fontWeight: 900, color: netRetVal >= 0 ? UI.pass : UI.watch, lineHeight: 1.1 }}>
              {assetSummary.kpi === "ready" ? `${netRetVal >= 0 ? "+" : ""}${netRetVal.toFixed(2)}%` : "—"}
            </div>
            <div style={{ fontSize: "0.68rem", color: netPnlVal >= 0 ? UI.pass : UI.watch, marginTop: 4, fontWeight: 700 }}>
              평가손익: {assetSummary.kpi === "ready" ? `${netPnlVal >= 0 ? "+" : ""}${Math.round(netPnlVal).toLocaleString()}` : "—"} KRW
            </div>
          </div>
        </section>

        {/* 3. 메인 그래프 추가 */}
        <section
          style={{
            background: UI.cardBg,
            border: `1px solid ${UI.border}`,
            borderRadius: 12,
            padding: "1rem",
            marginBottom: "1rem",
            boxShadow: "0 4px 20px rgba(0,0,0,0.25)"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.7rem", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: "0.9rem", color: UI.title, fontWeight: 900 }}>포트폴리오 가치 추이 (KRW)</div>
            <div style={{ display: "flex", gap: "0.3rem" }}>
              {(["1D", "1W", "1M", "ALL"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setGraphTab(tab)}
                  style={{
                    background: graphTab === tab ? "#3b82f6" : UI.cardSoftBg,
                    border: `1px solid ${graphTab === tab ? "#60a5fa" : UI.borderSoft}`,
                    borderRadius: 6,
                    color: UI.title,
                    fontSize: "0.68rem",
                    fontWeight: 700,
                    padding: "0.22rem 0.55rem",
                    cursor: "pointer"
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
          
          <div style={{ background: "#090d16", border: "1px solid #1e293b", borderRadius: 8, padding: "0.8rem 0.4rem" }}>
            <SvgPortfolioChart history={filteredHistory} />
          </div>
        </section>

        {/* 4. 하단 2열 레이아웃 */}
        <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: "0.9rem", alignItems: "start", marginBottom: "1rem" }}>
          
          {/* 좌측: 실제 보유 현황 테이블 */}
          <section
            style={{
              background: UI.cardBg,
              border: `1px solid ${UI.border}`,
              borderRadius: 12,
              padding: "1rem",
              boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
              overflow: "hidden"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.7rem", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: "0.9rem", color: UI.title, fontWeight: 900 }}>실제 보유 현황 (Balances)</div>
              <div style={{ fontSize: "0.7rem", color: UI.mutedSoft, fontWeight: 500 }}>
                ※ 1,000원 미만 비관리 잔고는 화면에서만 숨김 처리되며, 총자산/평가손익/합계에는 포함됩니다.
              </div>
            </div>
            
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e293b", color: UI.mutedSoft }}>
                    <th style={{ padding: "0.5rem 0.4rem" }}>자산</th>
                    <th style={{ padding: "0.5rem 0.4rem", textAlign: "right" }}>보유 수량</th>
                    <th style={{ padding: "0.5rem 0.4rem", textAlign: "right" }}>평균 매수가</th>
                    <th style={{ padding: "0.5rem 0.4rem", textAlign: "right" }}>현재가</th>
                    <th style={{ padding: "0.5rem 0.4rem", textAlign: "right" }}>평가손익 (KRW)</th>
                    <th style={{ padding: "0.5rem 0.4rem", textAlign: "right" }}>수익률 (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleBalances.map((item, idx) => {
                    const isKrw = item.currency === "KRW";
                    return (
                      <tr key={idx} style={{ borderBottom: "1px solid #1e293b33", background: idx % 2 === 0 ? "transparent" : "#0d1525" }}>
                        <td style={{ padding: "0.55rem 0.4rem", fontWeight: 800 }}>
                          <span style={{ color: UI.title }}>{item.currency}</span>
                          {!isKrw && (
                            <span 
                              style={{ 
                                marginLeft: 6, 
                                fontSize: "0.6rem", 
                                background: item.is_managed ? "rgba(16, 185, 129, 0.15)" : "rgba(107, 114, 128, 0.15)",
                                border: `1px solid ${item.is_managed ? "#10b981" : "#6b7280"}`,
                                color: item.is_managed ? "#34d399" : "#9ca3af",
                                padding: "1px 4px", 
                                borderRadius: 4,
                                fontWeight: 700
                              }}
                            >
                              {item.is_managed ? "자동 관리" : "비관리"}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "0.55rem 0.4rem", textAlign: "right", fontFamily: "monospace" }}>
                          {item.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </td>
                        <td style={{ padding: "0.55rem 0.4rem", textAlign: "right", fontFamily: "monospace" }}>
                          {isKrw ? "—" : `${Math.round(item.avg_buy_price).toLocaleString()}원`}
                        </td>
                        <td style={{ padding: "0.55rem 0.4rem", textAlign: "right", fontFamily: "monospace" }}>
                          {isKrw ? "—" : `${Math.round(item.current_price).toLocaleString()}원`}
                        </td>
                        <td style={{ 
                          padding: "0.55rem 0.4rem", 
                          textAlign: "right", 
                          fontFamily: "monospace",
                          color: isKrw ? UI.body : item.pnl_krw >= 0 ? UI.pass : UI.watch,
                          fontWeight: 700
                        }}>
                          {isKrw ? "—" : `${item.pnl_krw >= 0 ? "+" : ""}${Math.round(item.pnl_krw).toLocaleString()}원`}
                        </td>
                        <td style={{ 
                          padding: "0.55rem 0.4rem", 
                          textAlign: "right", 
                          fontFamily: "monospace",
                          color: isKrw ? UI.body : item.pnl_pct >= 0 ? UI.pass : UI.watch,
                          fontWeight: 700
                        }}>
                          {isKrw ? "—" : `${item.pnl_pct >= 0 ? "+" : ""}${item.pnl_pct.toFixed(2)}%`}
                        </td>
                      </tr>
                    );
                  })}
                  <tr style={{ background: "#0a1220", borderTop: "2px solid #1e293b", fontWeight: 800 }}>
                    <td style={{ padding: "0.6rem 0.4rem", color: UI.title }}>합계 (숨김 잔고 포함)</td>
                    <td colSpan={3} />
                    <td style={{ 
                      padding: "0.6rem 0.4rem", 
                      textAlign: "right", 
                      fontFamily: "monospace",
                      color: lossSummary.totalPnlKrw >= 0 ? UI.pass : UI.watch,
                      fontSize: "0.85rem"
                    }}>
                      {lossSummary.totalPnlKrw >= 0 ? "+" : ""}{Math.round(lossSummary.totalPnlKrw).toLocaleString()}원
                    </td>
                    <td style={{ 
                      padding: "0.6rem 0.4rem", 
                      textAlign: "right", 
                      fontFamily: "monospace",
                      color: lossSummary.totalPnlKrw >= 0 ? UI.pass : UI.watch,
                      fontSize: "0.85rem"
                    }}>
                      {assetSummary.kpi === "ready" ? `${netRetVal >= 0 ? "+" : ""}${netRetVal.toFixed(2)}%` : "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 우측: 손실 현황 / 자동관리 / 스캐너 요약 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
            
            {/* 5. 손실 현황 카드 */}
            <div
              style={{
                background: UI.cardBg,
                border: `1px solid ${UI.border}`,
                borderRadius: 12,
                padding: "0.9rem 1rem",
                boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
              }}
            >
              <div style={{ fontSize: "0.82rem", color: "#f87171", fontWeight: 900, marginBottom: "0.6rem", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444" }} />
                손실 현황 (Loss Status)
              </div>
              
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.78rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: UI.mutedSoft }}>총 평가손익:</span>
                  <strong style={{ color: lossSummary.totalPnlKrw >= 0 ? UI.pass : UI.watch }}>
                    {lossSummary.totalPnlKrw >= 0 ? "+" : ""}{Math.round(lossSummary.totalPnlKrw).toLocaleString()} KRW
                  </strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: UI.mutedSoft }}>손실 종목 수:</span>
                  <strong style={{ color: lossSummary.lossCount > 0 ? UI.watch : UI.body }}>
                    {lossSummary.lossCount} / {lossSummary.totalCount}
                  </strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: UI.mutedSoft }}>최대 손실 종목:</span>
                  <strong style={{ color: UI.watch }}>
                    {lossSummary.maxLossItem 
                      ? `${lossSummary.maxLossItem.currency} (${Math.round(lossSummary.maxLossItem.pnl_krw).toLocaleString()} KRW / ${lossSummary.maxLossItem.pnl_pct.toFixed(2)}%)`
                      : "없음"}
                  </strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: UI.mutedSoft }}>당일 손실률 (자산대비):</span>
                  <strong style={{ color: lossSummary.dailyLossPct >= 0 ? UI.pass : UI.watch }}>
                    {lossSummary.dailyLossPct >= 0 ? "+" : ""}{lossSummary.dailyLossPct.toFixed(2)}%
                  </strong>
                </div>
              </div>
            </div>

            {/* 6. 자동 관리 포지션 요약 */}
            <div
              style={{
                background: UI.cardBg,
                border: `1px solid ${UI.border}`,
                borderRadius: 12,
                padding: "0.9rem 1rem",
                boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.55rem" }}>
                <div style={{ fontSize: "0.82rem", color: UI.title, fontWeight: 900 }}>자동 관리 포지션 요약</div>
                <div style={{ fontSize: "0.72rem", color: UI.mutedSoft }}>관리 수: {managedPositionsKeys.length}</div>
              </div>

              {managedPositionsKeys.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.74rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", color: UI.mutedSoft }}>
                    <span>현재 가동 중인 자동매매 수:</span>
                    <strong style={{ color: UI.title }}>{managedPositionsKeys.length}개 종목</strong>
                  </div>
                  <a 
                    href="#managed-positions-section"
                    style={{ 
                      marginTop: 6, 
                      color: "#3b82f6", 
                      textDecoration: "none", 
                      fontSize: "0.7rem", 
                      fontWeight: 700,
                      textAlign: "right",
                      display: "block"
                    }}
                  >
                    자동 관리 포지션 상세 보기 &darr;
                  </a>
                </div>
              ) : (
                <div style={{ fontSize: "0.74rem", color: UI.mutedSoft, textAlign: "center", padding: "0.4rem 0" }}>
                  현재 자동 관리 중인 포지션이 없습니다.
                </div>
              )}
            </div>

            {/* 7. 스캐너 요약 */}
            <div
              style={{
                background: UI.cardBg,
                border: `1px solid ${UI.border}`,
                borderRadius: 12,
                padding: "0.9rem 1rem",
                boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
              }}
            >
              <div style={{ fontSize: "0.82rem", color: UI.title, fontWeight: 900, marginBottom: "0.55rem" }}>스캐너 요약 (24시간 누계)</div>
              
              <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: "0.74rem", color: UI.mutedSoft }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>실거래 후보:</span>
                  <strong style={{ color: (scannerItemsExcludingHeld?.after?.length ?? 0) > 0 ? UI.pass : UI.body }}>
                    {scannerItemsExcludingHeld?.after?.length ?? 0}개
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Watchlist 감시 중:</span>
                  <strong style={{ color: (Object.keys(strategy?.surge_watchlist || {}).length + Object.keys(strategy?.morning_surge_watchlist || {}).length) > 0 ? UI.watch : UI.body }}>
                    {Object.keys(strategy?.surge_watchlist || {}).length + Object.keys(strategy?.morning_surge_watchlist || {}).length} / 20
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>최근 신호 (24h):</span>
                  <strong>{logs.length}건</strong>
                </div>
              </div>
            </div>

            {/* 7-2. 스캐너 진단 */}
            <div
              style={{
                background: UI.cardBg,
                border: `1px solid ${UI.border}`,
                borderRadius: 12,
                padding: "0.9rem 1rem",
                boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
              }}
            >
              <div style={{ fontSize: "0.82rem", color: UI.title, fontWeight: 900, marginBottom: "0.55rem" }}>스캐너 진단 (최근 틱 기준)</div>
              
              {strategy?.diagnostics ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: "0.74rem", color: UI.mutedSoft }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>전체 감시 대상:</span>
                    <strong style={{ color: UI.title }}>{strategy.diagnostics.universe_count ?? 0}개</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>최근 신호 평가:</span>
                    <strong style={{ color: UI.title }}>{strategy.diagnostics.scanned_count ?? 0}개</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Watchlist 편입:</span>
                    <strong style={{ color: UI.title }}>{strategy.diagnostics.watchlist_added_count ?? 0}개</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Watchlist 감시 중:</span>
                    <strong style={{ color: UI.title }}>{strategy.diagnostics.watchlist_watching_count ?? 0}개</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>실거래 후보:</span>
                    <strong style={{ color: (strategy.diagnostics.candidate_count ?? 0) > 0 ? UI.pass : UI.body }}>
                      {strategy.diagnostics.candidate_count ?? 0}개
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>V2 엔진 판단:</span>
                    <strong style={{ color: UI.title }}>{strategy.diagnostics.surge_v2_eval_count ?? 0}회</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>최종 매수 시도:</span>
                    <strong style={{ color: UI.title }}>{strategy.diagnostics.final_buy_attempt_count ?? 0}회</strong>
                  </div>
                  {strategy.diagnostics.skipped_by_reason && Object.keys(strategy.diagnostics.skipped_by_reason).length > 0 && (
                    <div style={{ marginTop: 6, borderTop: "1px solid #1e293b", paddingTop: 6 }}>
                      <div style={{ fontWeight: 800, color: UI.title, marginBottom: 4 }}>주요 탈락 사유:</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 120, overflowY: "auto", paddingRight: 4 }}>
                        {Object.entries(strategy.diagnostics.skipped_by_reason)
                          .sort((a, b) => b[1] - a[1])
                          .map(([reason, count]) => (
                            <div key={reason} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem" }}>
                              <span style={{ fontFamily: "monospace" }}>{reason}:</span>
                              <strong style={{ color: UI.watch }}>{count}건</strong>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: "0.74rem", color: UI.mutedSoft, textAlign: "center", padding: "0.4rem 0" }}>
                  진단 데이터 대기 중...
                </div>
              )}
            </div>

          </div>
        </div>

        {/* 8. 접힘 영역 (운영 정보, 상세 로그, 최근 신호, 스캐너 상세) */}
        <section style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "1.2rem" }}>
          
          <details 
            style={{ 
              background: "#080e18", 
              border: `1px solid ${UI.borderSoft}`, 
              borderRadius: 8, 
              padding: "0.6rem 0.8rem" 
            }}
          >
            <summary style={{ cursor: "pointer", color: UI.title, fontSize: "0.8rem", fontWeight: 800 }}>
              운영 정보 보기 ( timestamps 및 내부 상태 )
            </summary>
            
            <div style={{ marginTop: "0.8rem", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, fontSize: "0.72rem", color: UI.mutedSoft }}>
              <div>로그인 상태: <strong style={{ color: UI.body }}>인증됨</strong></div>
              <div>세션 사용자: <strong style={{ color: UI.body }}>{sessionUserId ?? "—"}</strong></div>
              <div>실행 프로세스 PID: <strong style={{ color: UI.body }}>{String(dashTimeline.dr?.process_pid ?? "—")}</strong></div>
              <div>모니터 인스턴스 ID: <strong style={{ color: UI.body }}>{String(dashTimeline.dr?.monitor_instance_id ?? "—")}</strong></div>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <div>마켓 상태 평가: <strong style={{ color: UI.body }}>{String((marketState as any)?.status ?? "—")}</strong></div>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <div>BTC 24h 변동: <strong style={{ color: UI.body }}>{(Number((trade as any)?.btc_change_24h ?? 0) * 100).toFixed(2)}%</strong></div>
              <div>git_head: <strong style={{ color: UI.body }}>{String(dashTimeline.dr?.git_head ?? "—")}</strong></div>
              
              <div style={{ gridColumn: "1 / -1", borderTop: "1px solid #1e293b", paddingTop: 8, marginTop: 4, fontWeight: 700, color: UI.title }}>
                세부 타임스탬프 (Stale 감지용)
              </div>
              <div>server_now: {dashTimeline.server_now ?? "—"}</div>
              <div>api_response_at: {dashTimeline.api_response_at ?? "—"}</div>
              <div>live_loop_latest_ts: {dashTimeline.live_loop_latest_ts ?? "—"} ({dashTimeline.liveAgeSec != null ? `${dashTimeline.liveAgeSec.toFixed(0)}s` : "?"})</div>
              <div>capital_policy_updated_at: {dashTimeline.capital_policy_updated_at ?? "—"}</div>
              <div>holdings_updated_at: {dashTimeline.holdings_updated_at ?? "—"}</div>
              <div>scanner_updated_at: {dashTimeline.scanner_updated_at ?? "—"}</div>
              <div>candidate_updated_at: {dashTimeline.candidate_updated_at ?? "—"}</div>
              <div>position_state_updated_at: {dashTimeline.position_state_updated_at ?? "—"}</div>
              <div>dashboard_received_at: {dashTimeline.dashboard_received_at ?? "—"}</div>
              <div>dashboard_rendered_at: {dashTimeline.dashboard_rendered_at ?? "—"}</div>
            </div>
            
            {sessionPanelWarning && (
              <div style={{ marginTop: "0.8rem", fontSize: "0.72rem", color: UI.watch, borderTop: "1px solid #7f1d1d", paddingTop: 6 }}>
                세션 경고: <strong>{sessionPanelWarning.code}</strong> — {sessionPanelWarning.message}
              </div>
            )}
            
            <div style={{ marginTop: "0.8rem", display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                onClick={() => void onToggleAutoTrade(!autoTradeEnabled)}
                disabled={toggleBusy || autoTradeStatusConfirmedSource === "uncertain"}
                style={{
                  borderRadius: 6,
                  border: `1px solid ${UI.borderSoft}`,
                  background: autoTradeEnabled ? UI.passBg : UI.cardSoftBg,
                  color: UI.body,
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  padding: "0.25rem 0.6rem",
                  cursor: "pointer"
                }}
              >
                자동매매 강제 토글
              </button>
            </div>
          </details>

          <div id="managed-positions-section" style={{ background: "#080e18", border: `1px solid ${UI.borderSoft}`, borderRadius: 8, padding: "0.6rem 0.8rem" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 800, color: UI.title, marginBottom: 8 }}>
              자동 관리 포지션 상세 (Managed Positions)
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {(() => {
                if (managedPositionsKeys.length === 0) {
                  return (
                    <div style={{ fontSize: "0.78rem", color: UI.mutedSoft, padding: "0.8rem", textAlign: "center" }}>
                      현재 로봇 엔진이 실시간 추적 및 자동 대응 중인 포지션이 없습니다.
                    </div>
                  );
                }

                return managedPositionsKeys.map((mk) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const p = (strategy?.open_positions?.[mk] ?? strategy?.early_positions?.[mk]) as any;
                  if (!p) return null;
                  
                  const isEarly = !strategy?.open_positions?.[mk] && !!strategy?.early_positions?.[mk];
                  const pnlColor = (p.current_net_pnl_pct ?? 0) >= 0 ? UI.pass : UI.watch;
                  
                  return (
                    <div 
                      key={`pos-${mk}`} 
                      style={{ 
                        background: UI.cardBg, 
                        border: `1px solid ${UI.border}`, 
                        borderRadius: 8, 
                        padding: "0.65rem 0.85rem",
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                        gap: 10
                      }}
                    >
                      <div>
                        <strong style={{ color: UI.title, fontSize: "0.85rem" }}>{mk.replace("KRW-", "")}</strong>
                        {isEarly && <span style={{ marginLeft: 6, fontSize: "0.65rem", color: "#f59e0b", border: "1px solid #f59e0b", padding: "1px 4px", borderRadius: 4 }}>Early 진입</span>}
                        <div style={{ fontSize: "0.68rem", color: UI.mutedSoft, marginTop: 3 }}>수량: {p.remaining_qty?.toLocaleString() ?? p.qty?.toLocaleString()}</div>
                      </div>
                      
                      <div>
                        <div style={{ fontSize: "0.68rem", color: UI.mutedSoft }}>진입평단 / 현재가</div>
                        <div style={{ fontSize: "0.78rem" }}>{Math.round(p.entry_price).toLocaleString()}원 / {Math.round(p.current_price ?? p.entry_price).toLocaleString()}원</div>
                      </div>

                      <div>
                        <div style={{ fontSize: "0.68rem", color: UI.mutedSoft }}>평가 손익</div>
                        <div style={{ fontSize: "0.8rem", color: pnlColor, fontWeight: 800 }}>
                          {Math.round(p.pnl_krw ?? 0).toLocaleString()} KRW ({(p.current_net_pnl_pct ?? 0).toFixed(2)}%)
                        </div>
                      </div>

                      <div>
                        <div style={{ fontSize: "0.68rem", color: UI.mutedSoft }}>손절가 / 트레일링 스탑</div>
                        <div style={{ fontSize: "0.74rem" }}>
                          Stop: {p.stop_loss_price ? `${Math.round(p.stop_loss_price).toLocaleString()}원` : "없음"} 
                          {p.trailing_stop_price ? ` / Trail: ${Math.round(p.trailing_stop_price).toLocaleString()}원` : ""}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          <details 
            style={{ 
              background: "#080e18", 
              border: `1px solid ${UI.borderSoft}`, 
              borderRadius: 8, 
              padding: "0.6rem 0.8rem" 
            }}
          >
            <summary style={{ cursor: "pointer", color: UI.title, fontSize: "0.8rem", fontWeight: 800 }}>
              급등주 스캐너 상세 보기 ( 실거래 후보 리스트 )
            </summary>
            
            <div style={{ marginTop: "0.8rem" }}>
              <div style={{ fontSize: "0.7rem", color: UI.mutedSoft, marginBottom: 8 }}>
                * 스캐너에서 통과된 종목들의 세부 필터링 및 판단 내역입니다.
              </div>

              <div style={{ marginBottom: "1rem" }}>
                {(() => {
                  const watchlist = Object.values(strategy?.surge_watchlist || {});
                  const morningWatchlist = Object.values(strategy?.morning_surge_watchlist || {});
                  const mergedList = [...watchlist, ...morningWatchlist];
                  
                  if (mergedList.length === 0) {
                    return <div style={{ fontSize: "0.74rem", color: UI.mutedSoft }}>감시 중인 Watchlist 없음</div>;
                  }

                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowX: "auto" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "70px 90px 90px 90px 90px 70px 70px 70px 70px 70px 1fr", gap: 8, fontSize: "0.64rem", color: UI.mutedSoft, minWidth: "900px" }}>
                        <span>코인</span><span>상태</span><span>최초감지가</span><span>최고가</span><span>눌림저가</span><span>눌림%</span><span>1m%</span><span>3m%</span><span>5m%</span><span>거래량배수</span><span>조건</span>
                      </div>
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {mergedList.map((it: any) => {
                        const pullbackPct = it.pullback_low_price && it.local_high_price 
                          ? ((it.local_high_price - it.pullback_low_price) / it.local_high_price * 100).toFixed(2)
                          : "-";
                        
                        return (
                          <div key={it.market} style={{ display: "grid", gridTemplateColumns: "70px 90px 90px 90px 90px 70px 70px 70px 70px 70px 1fr", gap: 8, fontSize: "0.72rem", color: UI.body, minWidth: "900px", borderBottom: "1px solid #1e293b22", padding: "4px 0" }}>
                            <strong>{it.market.replace("KRW-", "")}</strong>
                            <span>{it.status}</span>
                            <span>{Math.round(it.first_detected_price).toLocaleString()}원</span>
                            <span>{Math.round(it.local_high_price).toLocaleString()}원</span>
                            <span>{it.pullback_low_price ? `${Math.round(it.pullback_low_price).toLocaleString()}원` : "-"}</span>
                            <span>{pullbackPct}%</span>
                            <span>{it.recent1mRet ? `${it.recent1mRet.toFixed(1)}%` : "-"}</span>
                            <span>{it.recent3mRet ? `${it.recent3mRet.toFixed(1)}%` : "-"}</span>
                            <span>{it.recent5mRet ? `${it.recent5mRet.toFixed(1)}%` : "-"}</span>
                            <span>{it.volumeRatio1m5 ? `${it.volumeRatio1m5.toFixed(1)}x` : "-"}</span>
                            <span>{it.reason}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {(scannerItemsExcludingHeld?.after?.length ?? 0) > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {scannerItemsExcludingHeld.after.map((it: any) => (
                    <div key={it.market} style={{ padding: "0.5rem", background: UI.cardSoftBg, borderRadius: 6, fontSize: "0.74rem" }}>
                      <strong>{it.market.replace("KRW-", "")}</strong> - Score: {it.score} / {it.reason}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: "0.74rem", color: UI.mutedSoft }}>실거래 후보 없음</div>
              )}
            </div>
          </details>

          <details 
            style={{ 
              background: "#080e18", 
              border: `1px solid ${UI.borderSoft}`, 
              borderRadius: 8, 
              padding: "0.6rem 0.8rem" 
            }}
          >
            <summary style={{ cursor: "pointer", color: UI.title, fontSize: "0.8rem", fontWeight: 800 }}>
              최근 전체 신호 보기 ( Signal History )
            </summary>
            
            <div style={{ marginTop: "0.8rem" }}>
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
            </div>
          </details>

          <details 
            style={{ 
              background: "#080e18", 
              border: `1px solid ${UI.borderSoft}`, 
              borderRadius: 8, 
              padding: "0.6rem 0.8rem" 
            }}
          >
            <summary style={{ cursor: "pointer", color: UI.title, fontSize: "0.8rem", fontWeight: 800 }}>
              급등주 실거래 판단 엔진 및 통계 보기
            </summary>
            
            <div style={{ marginTop: "0.8rem", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: "0.76rem", color: UI.mutedSoft }}>
                * 경험치 분석 테이블과 요약 분석입니다.
              </div>

              {(() => {
                try {
                  const stats = paperSummary.experienceStats ?? [];
                  const totalSamples = stats.reduce((acc, s) => acc + s.sample_count, 0);
                  const totalWins = stats.reduce((acc, s) => acc + s.win_count, 0);
                  const totalLosses = stats.reduce((acc, s) => acc + s.loss_count, 0);
                  const avgPnl = totalSamples > 0 ? stats.reduce((acc, s) => acc + s.avg_pnl_pct * s.sample_count, 0) / totalSamples : 0;
                  
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
                        <div style={{ background: UI.cardSoftBg, borderRadius: 6, padding: 8 }}>
                          <div style={{ fontSize: "0.65rem", color: UI.mutedSoft }}>총 표본</div>
                          <div style={{ fontSize: "1.1rem", fontWeight: 900 }}>{totalSamples}건</div>
                        </div>
                        <div style={{ background: UI.cardSoftBg, borderRadius: 6, padding: 8 }}>
                          <div style={{ fontSize: "0.65rem", color: UI.mutedSoft }}>평균 손익</div>
                          <div style={{ fontSize: "1.1rem", fontWeight: 900, color: avgPnl >= 0 ? UI.pass : UI.fail }}>{avgPnl.toFixed(2)}%</div>
                        </div>
                        <div style={{ background: UI.cardSoftBg, borderRadius: 6, padding: 8 }}>
                          <div style={{ fontSize: "0.65rem", color: UI.mutedSoft }}>수익/손실</div>
                          <div style={{ fontSize: "1.1rem", fontWeight: 900 }}>{totalWins}승 / {totalLosses}패</div>
                        </div>
                      </div>
                      
                      <table style={{ width: "100%", fontSize: "0.72rem", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ background: "#0a101f", color: UI.mutedSoft }}>
                            <th style={{ padding: 4 }}>Key</th>
                            <th style={{ padding: 4 }}>표본</th>
                            <th style={{ padding: 4 }}>승률</th>
                            <th style={{ padding: 4 }}>평균손익</th>
                            <th style={{ padding: 4 }}>Live 판단</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.map((s, idx) => (
                            <tr key={idx} style={{ borderBottom: "1px solid #1e293b33" }}>
                              <td style={{ padding: 4 }}>{s.profile_key}</td>
                              <td style={{ padding: 4 }}>{s.sample_count}</td>
                              <td style={{ padding: 4 }}>{(s.win_rate * 100).toFixed(0)}%</td>
                              <td style={{ padding: 4 }}>{s.avg_pnl_pct.toFixed(2)}%</td>
                              <td style={{ padding: 4 }}>x{s.suggested_size_multiplier.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                } catch {
                  return null;
                }
              })()}
            </div>
          </details>

        </section>

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SvgPortfolioChart = ({ history }: { history: any[] }) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  
  if (history.length === 0) {
    return (
      <div style={{ height: 260, display: "grid", placeItems: "center", color: UI.muted }}>
        충분한 역사 데이터가 수집되지 않았습니다 (1분 주기 수집 대기 중)
      </div>
    );
  }

  const padding = { top: 20, right: 30, bottom: 30, left: 60 };
  const width = 800;
  const height = 260;

  const vals = history.map(h => Number(h.total_asset_equity_krw ?? 0));
  const minVal = Math.min(...vals) * 0.999;
  const maxVal = Math.max(...vals) * 1.001;
  const range = maxVal - minVal || 1;

  const points = history.map((h, i) => {
    const x = padding.left + (i * (width - padding.left - padding.right)) / Math.max(1, history.length - 1);
    const y = height - padding.bottom - ((Number(h.total_asset_equity_krw ?? 0) - minVal) / range) * (height - padding.top - padding.bottom);
    return { x, y, val: Number(h.total_asset_equity_krw ?? 0), ts: h.ts, item: h };
  });

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaD = `${pathD} L ${points[points.length - 1].x} ${height - padding.bottom} L ${points[0].x} ${height - padding.bottom} Z`;

  const firstVal = vals[0] || 0;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((r, idx) => {
          const y = padding.top + r * (height - padding.top - padding.bottom);
          const v = maxVal - r * range;
          return (
            <g key={`guide-${idx}`}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="#1e293b"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <text
                x={padding.left - 10}
                y={y + 4}
                fill={UI.mutedSoft}
                fontSize={10}
                textAnchor="end"
                fontFamily="monospace"
              >
                {Math.round(v).toLocaleString()}
              </text>
            </g>
          );
        })}

        <path d={areaD} fill="url(#chartGrad)" />

        {points.map((p, idx) => {
          if (p.val < firstVal && idx > 0) {
            const prevP = points[idx - 1];
            return (
              <line
                key={`loss-seg-${idx}`}
                x1={prevP.x}
                y1={prevP.y}
                x2={p.x}
                y2={p.y}
                stroke="#ef4444"
                strokeWidth={2.5}
              />
            );
          }
          return null;
        })}

        <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={2} />

        {hoveredIdx !== null && points[hoveredIdx] && (
          <g>
            <line
              x1={points[hoveredIdx].x}
              y1={padding.top}
              x2={points[hoveredIdx].x}
              y2={height - padding.bottom}
              stroke="#60a5fa"
              strokeWidth={1.5}
              strokeDasharray="2 2"
            />
            <circle cx={points[hoveredIdx].x} cy={points[hoveredIdx].y} r={5} fill="#60a5fa" stroke="#0f172a" strokeWidth={2} />
          </g>
        )}

        {points.map((p, idx) => {
          const segmentWidth = (width - padding.left - padding.right) / Math.max(1, history.length - 1);
          return (
            <rect
              key={`detect-${idx}`}
              x={p.x - segmentWidth / 2}
              y={0}
              width={segmentWidth}
              height={height}
              fill="transparent"
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          );
        })}
      </svg>

      {hoveredIdx !== null && points[hoveredIdx] && (
        <div
          style={{
            position: "absolute",
            left: `${(points[hoveredIdx].x / width) * 100}%`,
            top: `${(points[hoveredIdx].y / height) * 100 - 60}%`,
            transform: "translateX(-50%)",
            background: "#0f172a",
            border: "1px solid #3b82f6",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: "0.72rem",
            color: UI.title,
            zIndex: 10,
            pointerEvents: "none",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap"
          }}
        >
          <div style={{ fontWeight: 800 }}>{Math.round(points[hoveredIdx].val).toLocaleString()} KRW</div>
          <div style={{ fontSize: "0.62rem", color: UI.mutedSoft }}>
            {new Date(points[hoveredIdx].ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
          </div>
          {points[hoveredIdx].item.unrealized_pnl_krw !== 0 && (
            <div style={{ fontSize: "0.64rem", color: points[hoveredIdx].item.unrealized_pnl_krw >= 0 ? UI.pass : UI.watch }}>
              평가손익: {Math.round(points[hoveredIdx].item.unrealized_pnl_krw).toLocaleString()} KRW
            </div>
          )}
        </div>
      )}
    </div>
  );
};

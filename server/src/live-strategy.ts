import fs from "node:fs/promises";
import path from "node:path";
import type { SignalLogEntry } from "@orbitalpha/shared";
import {
  companyIdSchema,
  mvpSignalPayloadV2Schema,
  ORDER_LIMITS,
  serviceIdSchema,
  signalStrengthScore,
} from "@orbitalpha/shared";
import { tradingDataRoot } from "./paths.js";
import { appendLog } from "./log-store.js";
import { fetchMinuteCandles, fetchTickers, partitionKrwMarketsByUpbitValidity } from "./upbit-public.js";
import {
  LIVE_ENTRY_SIGNAL_GATES,
  RECOVERY_EXIT_CONFIG,
  STRATEGY_RISK_CONFIG,
  STRICT_NEW_POSITION_EXIT,
  UPBIT_FEE_RATE,
  UPBIT_MIN_ORDER_KRW,
  grossPnlPct,
  netPnlPctPerUnit,
  type StopTriggerKind,
  type StrategyType,
} from "./strategy-risk-config.js";
import { ENTRY_PIPELINE_MID_SCORE_FLOOR, evaluateSpotLongEntryPipeline } from "./live-entry-pipeline.js";

type TradeApi = {
  status: () => Promise<any>;
  placeBuy: (
    market: string,
    confirm: boolean,
    amountKrw?: number,
    strategyType?: StrategyType,
    bucket?: "strategy" | "legacy",
    signalPayload?: unknown,
  ) => Promise<any>;
  placeSell: (market: string, confirm: boolean, ratio?: number) => Promise<any>;
  placeLegacyDcaBuy?: (market: string, confirm: boolean, amountKrw?: number, signalPayload?: unknown) => Promise<any>;
  placeLegacyExitSell?: (market: string, confirm: boolean, ratio?: number) => Promise<any>;
  setAutoTradeEnabled?: (enabled: boolean) => Promise<void>;
};

type MarketStateApi = {
  evaluate: () => Promise<{
    market_state: "risk_on" | "neutral" | "risk_off";
    min_entry_score: number;
    market_bonus: number;
    btc_5m_trend?: "up" | "down" | "flat";
    btc_15m_trend?: "up" | "down" | "flat";
  }>;
  entryGate: (
    payload: unknown,
    s: { market_state: "risk_on" | "neutral" | "risk_off"; min_entry_score: number; market_bonus: number; [k: string]: unknown },
  ) => { ok: boolean; reason?: string; score: number };
};

type StrategyPosition = {
  strategy_type: StrategyType;
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  order_krw: number;
  reason_enter: string;
  signal_strength: string;
  volume_ratio: number;
  position_stage?: "early_candidate" | "early_active" | "normal_active" | "scaled_out_partial" | "cooldown" | "closed";
  partial_tp_done: boolean;
  max_pnl_pct: number;
  min_pnl_pct?: number;
  breakeven_armed: boolean;
  highest_price_after_entry: number;
  trailing_stop_price: number;
  realized_partial_profit: number;
  remaining_qty: number;
  current_net_pnl_pct: number;
  breakeven_armed_at: string | null;
  partial_tp_at: string | null;
  /** 복원 시 없으면 기존 보유 — 신규만 엄격 손익 곡선 */
  strict_exit?: boolean;
};

type EarlyEntryPosition = {
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  order_krw: number;
  signal_ts: string | null;
  signal_strength: string;
  /** early entry 당시 최근 로컬 고점(돌파 기준) */
  entry_recent_high: number;
  /** early entry 당시 volume ratio(1m notional / prev5 avg) */
  entry_volume_ratio_1m5: number;
  /** 승격 여부(정상 포지션으로 이동 완료) */
  promoted: boolean;
  position_stage?: "early_candidate" | "early_active" | "normal_active" | "scaled_out_partial" | "cooldown" | "closed";
};

type StrategyTradeRow = {
  timestamp: string;
  entry_ts: string;
  market: string;
  action: "buy" | "sell";
  order_krw: number;
  filled_qty: number;
  avg_buy_price: number;
  exit_price: number | null;
  pnl_krw: number;
  pnl_pct: number;
  reason_enter: string;
  reason_exit: string;
  holding_minutes: number;
  signal_strength: string;
  volume_ratio: number;
  strategy_tag: "live_data_mode_v1";
  strategy_type: StrategyType;
  stop_trigger_kind: StopTriggerKind | null;
  current_net_pnl_pct: number;
  liquidation_reason: string;
  remaining_qty: number;
  highest_price_after_entry: number;
  trailing_stop_price: number;
  breakeven_armed_at: string | null;
  partial_tp_at: string | null;
};

type DailyStats = {
  date: string;
  entry_count: number;
  loss_pct: number;
  stop_by_market: Record<string, number>;
};

type PersistedState = {
  positions: Record<string, StrategyPosition>;
  early_positions: Record<string, EarlyEntryPosition>;
  trades: StrategyTradeRow[];
  daily: DailyStats;
  cooldown_until: Record<string, string>;
  safety_guard: {
    state: "정상" | "주의" | "자동정지";
    reason: string | null;
    order_fail_count_today: number;
    consecutive_losses: number;
    max_positions: number;
  };
  legacy: {
    dca_count: Record<string, number>;
    dca_locked: Record<string, boolean>;
    next_dca_at: Record<string, string>;
    exit_stage: Record<string, 0 | 1 | 2>;
  };
  regime?: {
    btc_filter_state: "strong" | "neutral" | "weak";
    conservative_mode: boolean;
    exception_entry_allowed: boolean;
    exception_candidates: Array<{ market: string; reason: string; relative_strength: number; signal_score: number }>;
    exception_slot_market: string | null;
    entry_size_pct: number;
    last_updated_at: string;
  };
};

const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"] as const;
const LEADER_MARKETS = new Set<string>(MARKETS as unknown as string[]);
const RISK_OFF_ENTRY_SCALE = 0.5;
const EXISTING_POSITION_MIN_KRW = Math.max(1000, Number(process.env.LIVE_EXISTING_POSITION_MIN_KRW ?? 5000));
const DEBUG_FORCE_BASE_GATE = String(process.env.DEBUG_FORCE_BASE_GATE ?? "").toLowerCase() === "true";
/** 운영에서 `DEBUG_LIVE_ENTRY_POLICY_SNAPSHOT`으로 dist 빌드 정합성 확인. 2=동일심볼은 same_symbol_open_continue_entry_eval 만(레거시 차단 문자열 없음). */
const LIVE_PRECHECK_EMITTER_REVISION = 2;
/** 운영에서 dist 실행 코드가 최신인지 확인용(로그에 항상 포함). */
const LIVE_STRATEGY_TRACE_REVISION = 4;
const LIVE_LEGACY_DCA_BUY_ENABLED = String(process.env.LIVE_LEGACY_DCA_BUY_ENABLED ?? "false").toLowerCase() === "true";
const LIVE_ENTRY_UTILIZATION_TARGET = Math.max(0.05, Math.min(0.98, Number(process.env.LIVE_ENTRY_UTILIZATION_TARGET ?? 0.85)));
const LIVE_MIN_ENTRY_KRW = Math.max(5_000, Number(process.env.LIVE_MIN_ENTRY_KRW ?? 50_000));
const LIVE_MAX_ENTRY_KRW = Math.max(LIVE_MIN_ENTRY_KRW, Number(process.env.LIVE_MAX_ENTRY_KRW ?? 250_000));
const LIVE_MAX_POSITIONS_CAP = (() => {
  const raw = process.env.LIVE_MAX_POSITIONS_CAP;
  const n = raw === undefined || raw === "" ? 6 : Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(12, Math.floor(n))) : 6;
})();
const LIVE_CAPITAL_BUFFER_RATIO = Math.max(0, Math.min(0.5, Number(process.env.LIVE_CAPITAL_BUFFER_RATIO ?? 0.1)));

// --- Exit stabilization (grace + fee-aware loss guard) ---
const LIVE_EXIT_GRACE_SECONDS = (() => {
  const raw = process.env.LIVE_EXIT_GRACE_SECONDS;
  const n = raw === undefined || raw === "" ? 120 : Number(raw);
  return Number.isFinite(n) ? Math.max(30, Math.min(600, Math.floor(n))) : 120;
})();
const LIVE_EXIT_FEE_BUFFER_PCT = (() => {
  const raw = process.env.LIVE_EXIT_FEE_BUFFER_PCT;
  const n = raw === undefined || raw === "" ? 0.25 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(2.0, n)) : 0.25;
})();
/** 미세 손실 즉시청산 방지: 이 손실(%)보다 작으면(덜 음수면) 조기 stop성 exit를 억제 */
const LIVE_MIN_EXIT_LOSS_PCT = (() => {
  const raw = process.env.LIVE_MIN_EXIT_LOSS_PCT;
  const n = raw === undefined || raw === "" ? -0.45 : Number(raw);
  return Number.isFinite(n) ? Math.max(-5, Math.min(-0.05, n)) : -0.45;
})();
/** 급락/비상 손절(%) — grace 중에도 허용 */
const LIVE_EMERGENCY_STOP_LOSS_PCT = (() => {
  const raw = process.env.LIVE_EMERGENCY_STOP_LOSS_PCT;
  const n = raw === undefined || raw === "" ? -1.8 : Number(raw);
  return Number.isFinite(n) ? Math.max(-20, Math.min(-0.5, n)) : -1.8;
})();
/** 진입 직후(초) stop성 exit 억제 구간 — grace와 별개로 “미세 손실” 방어용 */
const LIVE_EXIT_EARLY_LOSS_GUARD_SECONDS = (() => {
  const raw = process.env.LIVE_EXIT_EARLY_LOSS_GUARD_SECONDS;
  const n = raw === undefined || raw === "" ? 300 : Number(raw);
  return Number.isFinite(n) ? Math.max(60, Math.min(1800, Math.floor(n))) : 300;
})();

// --- Entry timing (avoid late chase entries) ---
const LIVE_ENTRY_SIGNAL_STALE_SECONDS = (() => {
  const raw = process.env.LIVE_ENTRY_SIGNAL_STALE_SECONDS;
  const n = raw === undefined || raw === "" ? 240 : Number(raw);
  return Number.isFinite(n) ? Math.max(30, Math.min(1800, Math.floor(n))) : 240;
})();
const LIVE_MAX_CHASE_FROM_SIGNAL_PCT = (() => {
  const raw = process.env.LIVE_MAX_CHASE_FROM_SIGNAL_PCT;
  const n = raw === undefined || raw === "" ? 1.2 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.2, Math.min(8, n)) : 1.2;
})();
/** 최근 로컬 고점에 너무 근접(되밀림 여지 적음)한 추격 진입 차단: (고점-현재)/고점*100 < 이 값이면 차단 */
const LIVE_MAX_ENTRY_NEAR_HIGH_PCT = (() => {
  const raw = process.env.LIVE_MAX_ENTRY_NEAR_HIGH_PCT;
  const n = raw === undefined || raw === "" ? 0.35 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.05, Math.min(3, n)) : 0.35;
})();
const LIVE_WEAK_MARKET_MIN_SCORE = (() => {
  const raw = process.env.LIVE_WEAK_MARKET_MIN_SCORE;
  const n = raw === undefined || raw === "" ? 84 : Number(raw);
  return Number.isFinite(n) ? Math.max(50, Math.min(100, n)) : 84;
})();
const LIVE_WEAK_MARKET_MAX_CHASE_PCT = (() => {
  const raw = process.env.LIVE_WEAK_MARKET_MAX_CHASE_PCT;
  const n = raw === undefined || raw === "" ? 0.7 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(5, n)) : 0.7;
})();
const LIVE_WEAK_MARKET_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.LIVE_WEAK_MARKET_MIN_VOLUME_RATIO;
  const n = raw === undefined || raw === "" ? 1.25 : Number(raw);
  return Number.isFinite(n) ? Math.max(1.0, Math.min(5, n)) : 1.25;
})();

// --- Weak-market exit small relax (keep protection, reduce over-sensitivity) ---
const LIVE_BTC_WEAK_TIGHT_STOP_PCT = (() => {
  const raw = process.env.LIVE_BTC_WEAK_TIGHT_STOP_PCT;
  const n = raw === undefined || raw === "" ? -1.1 : Number(raw);
  return Number.isFinite(n) ? Math.max(-5, Math.min(-0.2, n)) : -1.1;
})();
const LIVE_STABLE_WEAK_REBOUND_TIME_STOP_MINUTES = (() => {
  const raw = process.env.LIVE_STABLE_WEAK_REBOUND_TIME_STOP_MINUTES;
  const n = raw === undefined || raw === "" ? 18 : Number(raw);
  return Number.isFinite(n) ? Math.max(6, Math.min(90, Math.floor(n))) : 18;
})();

// --- Position management (stage/partial TP/breakeven/cooldown) ---
const LIVE_PARTIAL_TAKE_PROFIT_PCT = (() => {
  const raw = process.env.LIVE_PARTIAL_TAKE_PROFIT_PCT;
  const n = raw === undefined || raw === "" ? 1.5 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.3, Math.min(6, n)) : 1.5;
})();
const LIVE_PARTIAL_TAKE_PROFIT_RATIO = (() => {
  const raw = process.env.LIVE_PARTIAL_TAKE_PROFIT_RATIO;
  const n = raw === undefined || raw === "" ? 0.4 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(0.8, n)) : 0.4;
})();
const LIVE_RUNNER_TRAIL_FROM_PEAK_PCT = (() => {
  const raw = process.env.LIVE_RUNNER_TRAIL_FROM_PEAK_PCT;
  const n = raw === undefined || raw === "" ? 1.2 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.3, Math.min(6, n)) : 1.2;
})();

/** late_entry_guard: 고득점·신선 신호·저추격 구간에서만 near_high / vol_fade 를 축소진입으로 완화 (실거래 전용). */
const LIVE_LATE_ENTRY_SOFT_MIN_SCORE = (() => {
  const raw = process.env.LIVE_LATE_ENTRY_SOFT_MIN_SCORE;
  const n = raw === undefined || raw === "" ? 90 : Number(raw);
  return Number.isFinite(n) ? Math.max(80, Math.min(100, n)) : 90;
})();
const LIVE_LATE_ENTRY_SOFT_MAX_SIGNAL_SEC = (() => {
  const raw = process.env.LIVE_LATE_ENTRY_SOFT_MAX_SIGNAL_SEC;
  const n = raw === undefined || raw === "" ? 135 : Number(raw);
  return Number.isFinite(n) ? Math.max(20, Math.min(600, Math.floor(n))) : 135;
})();
const LIVE_LATE_ENTRY_SOFT_CHASE_FRAC = (() => {
  const raw = process.env.LIVE_LATE_ENTRY_SOFT_CHASE_FRAC;
  const n = raw === undefined || raw === "" ? 0.55 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.2, Math.min(0.95, n)) : 0.55;
})();
const LIVE_LATE_ENTRY_SOFT_SIZE_MULT_NEAR_HIGH = (() => {
  const raw = process.env.LIVE_LATE_ENTRY_SOFT_SIZE_MULT_NEAR_HIGH;
  const n = raw === undefined || raw === "" ? 0.62 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.25, Math.min(1, n)) : 0.62;
})();
const LIVE_LATE_ENTRY_SOFT_SIZE_MULT_VOL_FADE = (() => {
  const raw = process.env.LIVE_LATE_ENTRY_SOFT_SIZE_MULT_VOL_FADE;
  const n = raw === undefined || raw === "" ? 0.68 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.25, Math.min(1, n)) : 0.68;
})();
const LIVE_LATE_ENTRY_NEAR_HIGH_HARD_PCT = (() => {
  const raw = process.env.LIVE_LATE_ENTRY_NEAR_HIGH_HARD_PCT;
  const n = raw === undefined || raw === "" ? 0.12 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.03, Math.min(LIVE_MAX_ENTRY_NEAR_HIGH_PCT, n)) : 0.12;
})();
const LIVE_LATE_ENTRY_VOLUME_HARD_RATIO = (() => {
  const raw = process.env.LIVE_LATE_ENTRY_VOLUME_HARD_RATIO;
  const n = raw === undefined || raw === "" ? 0.38 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.15, Math.min(0.6, n)) : 0.38;
})();

/** partial TP 이후 잔존이 장기간 슬롯만 점유할 때 완전 청산으로 승격 (실거래 전용). */
const LIVE_RESIDUAL_MIN_MINUTES_AFTER_PARTIAL = (() => {
  const raw = process.env.LIVE_RESIDUAL_MIN_MINUTES_AFTER_PARTIAL;
  const n = raw === undefined || raw === "" ? 36 * 60 : Number(raw);
  return Number.isFinite(n) ? Math.max(120, Math.min(10 * 24 * 60, Math.floor(n))) : 36 * 60;
})();
const LIVE_RESIDUAL_PEAK_GIVEBACK_PCT = (() => {
  const raw = process.env.LIVE_RESIDUAL_PEAK_GIVEBACK_PCT;
  const n = raw === undefined || raw === "" ? 0.42 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.15, Math.min(3, n)) : 0.42;
})();
const LIVE_RESIDUAL_STALL_PNL_CAP = (() => {
  const raw = process.env.LIVE_RESIDUAL_STALL_PNL_CAP;
  const n = raw === undefined || raw === "" ? 1.35 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.3, Math.min(4, n)) : 1.35;
})();
const LIVE_RESIDUAL_MAX_HOLD_MINUTES = (() => {
  const raw = process.env.LIVE_RESIDUAL_MAX_HOLD_MINUTES;
  const n = raw === undefined || raw === "" ? 4.5 * 24 * 60 : Number(raw);
  return Number.isFinite(n) ? Math.max(24 * 60, Math.min(14 * 24 * 60, Math.floor(n))) : 4.5 * 24 * 60;
})();

const LIVE_BREAK_EVEN_ARM_PCT = (() => {
  const raw = process.env.LIVE_BREAK_EVEN_ARM_PCT;
  const n = raw === undefined || raw === "" ? 1.0 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.2, Math.min(6, n)) : 1.0;
})();
const LIVE_BREAK_EVEN_LOCK_PCT = (() => {
  const raw = process.env.LIVE_BREAK_EVEN_LOCK_PCT;
  const n = raw === undefined || raw === "" ? 0.05 : Number(raw);
  return Number.isFinite(n) ? Math.max(-0.2, Math.min(1.0, n)) : 0.05;
})();
const LIVE_REENTRY_COOLDOWN_SECONDS = (() => {
  const raw = process.env.LIVE_REENTRY_COOLDOWN_SECONDS;
  const n = raw === undefined || raw === "" ? 20 * 60 : Number(raw);
  return Number.isFinite(n) ? Math.max(60, Math.min(6 * 3600, Math.floor(n))) : 20 * 60;
})();
const LIVE_REENTRY_COOLDOWN_EARLY_FAIL_SECONDS = (() => {
  const raw = process.env.LIVE_REENTRY_COOLDOWN_EARLY_FAIL_SECONDS;
  const n = raw === undefined || raw === "" ? 12 * 60 : Number(raw);
  return Number.isFinite(n) ? Math.max(60, Math.min(3 * 3600, Math.floor(n))) : 12 * 60;
})();
const LIVE_EARLY_PROMOTION_PCT = (() => {
  const raw = process.env.LIVE_EARLY_PROMOTION_PCT;
  const n = raw === undefined || raw === "" ? 0.5 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.2, Math.min(3, n)) : 0.5;
})();
const LIVE_EARLY_PROMOTION_MAX_SECONDS = (() => {
  const raw = process.env.LIVE_EARLY_PROMOTION_MAX_SECONDS;
  const n = raw === undefined || raw === "" ? 120 : Number(raw);
  return Number.isFinite(n) ? Math.max(10, Math.min(600, Math.floor(n))) : 120;
})();

// --- Early entry (pre-breakout small scout slot) ---
const LIVE_EARLY_ENTRY_ENABLED = String(process.env.LIVE_EARLY_ENTRY_ENABLED ?? "false").toLowerCase() === "true";
const LIVE_EARLY_ENTRY_MAX_OPEN = (() => {
  const raw = process.env.LIVE_EARLY_ENTRY_MAX_OPEN;
  const n = raw === undefined || raw === "" ? 1 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.floor(n))) : 1;
})();
const LIVE_EARLY_ENTRY_NEAR_HIGH_PCT = (() => {
  const raw = process.env.LIVE_EARLY_ENTRY_NEAR_HIGH_PCT;
  const n = raw === undefined || raw === "" ? 0.3 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.05, Math.min(3, n)) : 0.3;
})();
const LIVE_EARLY_ENTRY_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.LIVE_EARLY_ENTRY_MIN_VOLUME_RATIO;
  const n = raw === undefined || raw === "" ? 1.3 : Number(raw);
  return Number.isFinite(n) ? Math.max(1.0, Math.min(6, n)) : 1.3;
})();
const LIVE_EARLY_ENTRY_MAX_SIGNAL_SECONDS = (() => {
  const raw = process.env.LIVE_EARLY_ENTRY_MAX_SIGNAL_SECONDS;
  const n = raw === undefined || raw === "" ? 30 : Number(raw);
  return Number.isFinite(n) ? Math.max(5, Math.min(300, Math.floor(n))) : 30;
})();
const LIVE_EARLY_ENTRY_SIZE_RATIO = (() => {
  const raw = process.env.LIVE_EARLY_ENTRY_SIZE_RATIO;
  const n = raw === undefined || raw === "" ? 0.4 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(0.8, n)) : 0.4;
})();
const LIVE_EARLY_ENTRY_FAIL_SECONDS = (() => {
  const raw = process.env.LIVE_EARLY_ENTRY_FAIL_SECONDS;
  const n = raw === undefined || raw === "" ? 90 : Number(raw);
  return Number.isFinite(n) ? Math.max(30, Math.min(600, Math.floor(n))) : 90;
})();
const LIVE_EARLY_ENTRY_FAIL_LOSS_PCT = (() => {
  const raw = process.env.LIVE_EARLY_ENTRY_FAIL_LOSS_PCT;
  const n = raw === undefined || raw === "" ? -0.7 : Number(raw);
  return Number.isFinite(n) ? Math.max(-5, Math.min(-0.1, n)) : -0.7;
})();

/** 명시적 true/false만 인정, 미설정이면 null */
function parseEnvBoolExplicit(value: string | undefined): boolean | null {
  if (value === undefined || value === "") return null;
  const s = String(value).toLowerCase().trim();
  if (s === "true" || value === "1" || s === "yes") return true;
  if (s === "false" || value === "0" || s === "no") return false;
  return null;
}

/**
 * true: 거래소 의미 보유 심볼을 entry_universe 에서 제외 (옵션).
 * 기본 false — 기존 현물 보유가 있어도 전략이 해당 종목을 후보로 평가 가능.
 * 우선순위: LIVE_EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE → DEBUG_EXCLUDE_HELD_SYMBOLS(레거시) → 기본 false
 */
function resolveExcludeHeldSymbolsFromUniverse(): boolean {
  const live = parseEnvBoolExplicit(process.env.LIVE_EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE);
  if (live !== null) return live;
  const dbg = parseEnvBoolExplicit(process.env.DEBUG_EXCLUDE_HELD_SYMBOLS);
  if (dbg !== null) return dbg;
  return false;
}

const EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE = resolveExcludeHeldSymbolsFromUniverse();

/**
 * 스냅샷·디버그용 감사 필드만. 유니버스/프리체크는 항상 오픈 심볼 평가를 막지 않음.
 * (과거 false 시 universe 제외·동일 심볼 오픈 포지션 시 조기 return 하던 프리체크가 있었음 — 제거됨.)
 */
function resolveLiveAllowEntryEvalOnOpenStrategySymbol(): boolean {
  const v = parseEnvBoolExplicit(process.env.LIVE_ALLOW_ENTRY_EVAL_ON_OPEN_STRATEGY_SYMBOL);
  if (v !== null) return v;
  return true;
}

const LIVE_ALLOW_ENTRY_EVAL_ON_OPEN_STRATEGY_SYMBOL = resolveLiveAllowEntryEvalOnOpenStrategySymbol();
const DEBUG_INCLUDE_UNIVERSE_MARKETS = String(process.env.DEBUG_INCLUDE_UNIVERSE_MARKETS ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s.startsWith("KRW-"));

function classifySignalMonitorErrorSnippet(err: string): { primary_reason: string; classification_tags: string[] } {
  const e = err.toLowerCase();
  const classification_tags: string[] = [];
  if (/429|too many requests/.test(e)) classification_tags.push("volume_filter_failed");
  if (/404|code not found|invalid_market|unknown market|not found/.test(e)) classification_tags.push("invalid_market_data");
  if (/candle|캔들|\[\]|empty|length|too short/.test(e)) classification_tags.push("insufficient_candles");
  if (/ema|indicator|nan|undefined/.test(e)) classification_tags.push("indicator_not_ready");
  let primary_reason = "signal_monitor_scan_failed";
  if (classification_tags.includes("invalid_market_data")) primary_reason = "invalid_market_data";
  else if (classification_tags.includes("insufficient_candles")) primary_reason = "insufficient_candles";
  else if (classification_tags.includes("volume_filter_failed")) primary_reason = "volume_filter_failed";
  else if (classification_tags.includes("indicator_not_ready")) primary_reason = "indicator_not_ready";
  return { primary_reason, classification_tags };
}

/** signal-monitor JSONL에 왜 해당 심볼 신호가 없는지 단계별로 분해 (pump-scanner 피드와는 별도 채널). */
function buildLiveSignalMissingDetail(market: string, logs: SignalLogEntry[]): Record<string, unknown> {
  let rawSignalRows = 0;
  let parsedOkRows = 0;
  let parsedFailRows = 0;
  let newestRawSignalTs: string | null = null;
  let lastZodIssue: string | null = null;

  let scanFailNewestTs: string | null = null;
  let scanFailNewestErr: string | null = null;
  let scanFailCount = 0;
  let cooldownRows = 0;

  for (const row of logs) {
    const msg = String(row.message ?? "");
    if (msg === `market_scan_failed:${market}`) {
      scanFailCount += 1;
      if (!scanFailNewestTs) {
        scanFailNewestTs = row.ts;
        scanFailNewestErr = String((row.payload as { error?: unknown })?.error ?? "").slice(0, 500);
      }
    }
    if (msg === `market_scan_skipped_cooldown:${market}`) {
      cooldownRows += 1;
    }
  }

  for (const row of logs) {
    if (row.kind !== "signal" || !row.payload || typeof row.payload !== "object") continue;
    const pay = row.payload as Record<string, unknown>;
    if (pay.market !== market) continue;
    rawSignalRows += 1;
    if (!newestRawSignalTs) newestRawSignalTs = row.ts;
    const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
    if (p.success) {
      parsedOkRows += 1;
    } else {
      parsedFailRows += 1;
      if (!lastZodIssue && p.error?.issues?.[0]) {
        const iss = p.error.issues[0]!;
        lastZodIssue = `${iss.path.join(".")}: ${iss.message}`;
      }
    }
  }

  const scanClass = scanFailNewestErr
    ? classifySignalMonitorErrorSnippet(scanFailNewestErr)
    : { primary_reason: "signal_monitor_scan_failed", classification_tags: [] as string[] };

  const classification_tags = [...scanClass.classification_tags];
  const hints: string[] = [
    "live_strategy_uses_readLogs_kind_signal_only",
    "pump_scanner_signalFeed_is_not_written_to_this_log_stream",
  ];

  let primary_reason = "not_in_signal_monitor_logs";

  if (parsedOkRows > 0) {
    primary_reason = "unexpected_parsed_ok_but_signal_map_miss";
    hints.push("check_latestAllSignals_fill_order_and_log_window");
  } else if (rawSignalRows > 0) {
    primary_reason = "signal_payload_schema_mismatch";
    if (lastZodIssue) hints.push(`zod_first_issue:${lastZodIssue}`);
  } else if (scanFailNewestErr) {
    primary_reason = scanClass.primary_reason;
  } else if (cooldownRows > 0) {
    primary_reason = "signal_monitor_cooldown_skips";
    hints.push("only_system_cooldown_rows_no_signal_append_in_window");
  }

  return {
    primary_reason,
    signal_source: "signal_monitor_jsonl",
    raw_signal_rows: rawSignalRows,
    parsed_ok_rows: parsedOkRows,
    parsed_fail_rows: parsedFailRows,
    newest_raw_signal_ts: newestRawSignalTs,
    scan_fail_count: scanFailCount,
    last_scan_fail_ts: scanFailNewestTs,
    last_scan_fail_error: scanFailNewestErr,
    cooldown_rows_seen: cooldownRows,
    classification_tags,
    hints,
  };
}

function todayKst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

function minutesSince(ts: string) {
  return Math.max(0, (Date.now() - Date.parse(ts)) / 60_000);
}

function accountTotalSpotQtyForMarket(market: string, balances: unknown[] | undefined): number {
  const cur = market.replace("KRW-", "").toUpperCase();
  const row = Array.isArray(balances)
    ? (balances as any[]).find((b) => String(b?.currency ?? "").toUpperCase() === cur)
    : undefined;
  return Number(row?.balance ?? 0) + Number(row?.locked ?? 0);
}

export function createLiveDataStrategy(opts: {
  companyId: string;
  serviceId: string;
  readLogs: (limit: number) => Promise<SignalLogEntry[]>;
  trade: TradeApi;
  marketState: MarketStateApi;
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
}) {
  const baseDir = path.join(tradingDataRoot(), "strategy", opts.companyId, opts.serviceId);
  const tradesFile = path.join(baseDir, "live_strategy_trades.json");
  const dailyFile = path.join(baseDir, "live_strategy_daily_stats.json");
  const state: PersistedState = {
    positions: {},
    early_positions: {},
    trades: [],
    daily: { date: todayKst(), entry_count: 0, loss_pct: 0, stop_by_market: {} },
    cooldown_until: {},
    safety_guard: {
      state: "주의",
      reason: "state_restore_pending",
      order_fail_count_today: 0,
      consecutive_losses: 0,
      max_positions: LIVE_MAX_POSITIONS_CAP,
    },
    legacy: {
      dca_count: {},
      dca_locked: {},
      next_dca_at: {},
      exit_stage: {},
    },
    regime: {
      btc_filter_state: "neutral",
      conservative_mode: false,
      exception_entry_allowed: false,
      exception_candidates: [],
      exception_slot_market: null,
      entry_size_pct: 1,
      last_updated_at: new Date().toISOString(),
    },
  };

  const persist = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(tradesFile, JSON.stringify(state.trades, null, 2), "utf8");
    await fs.writeFile(
      dailyFile,
      JSON.stringify(
        {
          daily: state.daily,
          positions: state.positions,
          early_positions: state.early_positions,
          cooldown_until: state.cooldown_until,
          safety_guard: state.safety_guard,
          legacy: state.legacy,
          regime: state.regime,
        },
        null,
        2,
      ),
      "utf8",
    );
  };

  const restore = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    try {
      state.trades = JSON.parse(await fs.readFile(tradesFile, "utf8"));
    } catch {}
    try {
      const d = JSON.parse(await fs.readFile(dailyFile, "utf8"));
      state.daily = d.daily ?? state.daily;
      state.positions = d.positions ?? state.positions;
      state.early_positions = d.early_positions ?? state.early_positions;
      state.cooldown_until = d.cooldown_until ?? state.cooldown_until;
      state.safety_guard = d.safety_guard ?? state.safety_guard;
      state.legacy = d.legacy ?? state.legacy;
      state.regime = d.regime ?? state.regime;
    } catch {}
    state.safety_guard.state = "정상";
    state.safety_guard.reason = null;
  };

  const emitStageChange = (args: {
    symbol: string;
    from_stage: StrategyPosition["position_stage"] | EarlyEntryPosition["position_stage"] | null;
    to_stage: StrategyPosition["position_stage"] | EarlyEntryPosition["position_stage"];
    reason: string;
    entry_price: number;
    current_price: number;
    net_pnl_pct: number;
    held_seconds: number;
  }) => {
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_POSITION_STAGE_CHANGE",
        ts: new Date().toISOString(),
        ...args,
      }),
    );
  };

  const summarize = () => {
    const sells = state.trades.filter((t) => t.action === "sell" && t.filled_qty > 0);
    const wins = sells.filter((t) => t.pnl_krw > 0).length;
    const tpCount = sells.filter((t) => t.reason_exit.startsWith("tp")).length;
    const slCount = sells.filter((t) => t.reason_exit.includes("stop")).length;
    const avgHold = sells.length > 0 ? sells.reduce((a, b) => a + b.holding_minutes, 0) / sells.length : 0;
    const pnl = sells.reduce((a, b) => a + b.pnl_krw, 0);
    const usedKrw =
      Object.values(state.positions).reduce((a, p) => a + p.order_krw, 0) +
      Object.values(state.early_positions).reduce((a, p) => a + p.order_krw, 0);
    return {
      mode: "data_accum_live",
      strategy_tag: "live_data_mode_v1",
      strategy_available_krw: null,
      strategy_invested_krw: usedKrw,
      strategy_pnl_krw: pnl,
      strategy_win_rate: sells.length > 0 ? (wins / sells.length) * 100 : 0,
      strategy_total_fills: state.trades.length,
      strategy_take_profit_count: tpCount,
      strategy_stop_loss_count: slCount,
      strategy_avg_holding_minutes: avgHold,
      legacy_asset_pnl: null,
      strategy_asset_pnl: pnl,
      total_asset_pnl: null,
      files: { trades: tradesFile, daily: dailyFile },
      open_positions: state.positions,
      safety_guard_state: state.safety_guard.state,
      safety_guard_reason: state.safety_guard.reason,
      order_fail_count_today: state.safety_guard.order_fail_count_today,
      consecutive_losses: state.safety_guard.consecutive_losses,
      max_positions: state.safety_guard.max_positions,
      reentry_cooldowns: state.cooldown_until,
      legacy_management: state.legacy,
      regime: state.regime,
    };
  };

  const legacySignalAllowsDca = (sig: any): boolean => {
    if (!sig?.p) return false;
    const p = sig.p;
    const volumeOkay = Number(p.volume_ratio ?? 0) >= 0.85;
    const filters = Array.isArray(p.filters) ? p.filters : [];
    const passed = new Set(filters.filter((f: any) => f?.passed === true).map((f: any) => String(f.id)));
    const reboundPattern =
      passed.has("box_breakout") ||
      passed.has("pullback_reclaim") ||
      passed.has("volume_spike_close_fail");
    return volumeOkay && reboundPattern;
  };

  const legacySignalWeakening = (sig: any): boolean => {
    if (!sig?.p) return false;
    const p = sig.p;
    const filters = Array.isArray(p.filters) ? p.filters : [];
    const closeHold = filters.find((f: any) => String(f?.id) === "volume_spike_close_fail");
    const volume = Number(p.volume_ratio ?? 0);
    return (closeHold && closeHold.passed === false) || volume < 0.75;
  };

  const runTick = async () => {
    try {
    // 운영 최종값 단일화: persisted 값과 무관하게 매 tick env cap으로 재설정.
    state.safety_guard.max_positions = LIVE_MAX_POSITIONS_CAP;

    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_LOOP_TICK",
        ts: new Date().toISOString(),
        safety_guard_state: state.safety_guard.state,
        live_strategy_trace_revision: LIVE_STRATEGY_TRACE_REVISION,
      }),
    );
    if (state.daily.date !== todayKst()) {
      state.daily = { date: todayKst(), entry_count: 0, loss_pct: 0, stop_by_market: {} };
      state.safety_guard.order_fail_count_today = 0;
      state.safety_guard.consecutive_losses = 0;
      if (state.safety_guard.state === "자동정지") {
        state.safety_guard.state = "주의";
        state.safety_guard.reason = "daily_reset";
      }
    }

    const tstatus = await opts.trade.status();
    if (!tstatus.auto_trade_enabled || !tstatus.api_connected || !tstatus.live_enabled) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_LOOP_SKIP",
          reason: "trade_status_guard",
          stage: "before_signal_load",
          auto_trade_enabled: Boolean(tstatus.auto_trade_enabled),
          api_connected: Boolean(tstatus.api_connected),
          live_enabled: Boolean(tstatus.live_enabled),
        }),
      );
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_EXIT",
          ts: new Date().toISOString(),
          stage: "before_signal_load",
          reason: "trade_status_guard",
          watch_markets_count: null,
          signal_map_count: null,
          markets_with_filter_pass_count: null,
          base_entry_universe_count: null,
          entry_universe_count: null,
          symbol: null,
          note: "trade status guard return",
        }),
      );
      return;
    }

    // 계좌 실물 + trade-control ledger 기준으로 persisted 전략 상태를 정리 (수동 청산·외부 매도 후 유령 슬롯 방지).
    const balArr = Array.isArray(tstatus.balances) ? tstatus.balances : [];
    const lr = (tstatus as any).ledger_reconcile as { zeroed: string[]; clamped: string[] } | null | undefined;
    const reconcileActions: string[] = [];
    const strategyPosSnap = ((tstatus as any).strategy_positions ?? {}) as Record<string, { qty?: number }>;
    for (const m of new Set([...Object.keys(state.positions), ...Object.keys(state.early_positions)])) {
      const totalSpot = accountTotalSpotQtyForMarket(m, balArr);
      const stratQty = Number(strategyPosSnap[m]?.qty ?? 0);
      if (state.positions[m]) {
        if (totalSpot <= 0 && stratQty <= 0) {
          delete state.positions[m];
          delete state.cooldown_until[m];
          reconcileActions.push(`${m}:cleared_strategy_state_account_and_ledger_zero`);
        } else if (stratQty <= 0 && totalSpot > 0) {
          delete state.positions[m];
          delete state.cooldown_until[m];
          reconcileActions.push(`${m}:cleared_orphan_strategy_state_ledger_zero_nonzero_spot`);
        } else if (stratQty > 0) {
          const p = state.positions[m]!;
          if (Math.abs(p.qty - stratQty) > 1e-10) {
            p.qty = stratQty;
            p.remaining_qty = stratQty;
            reconcileActions.push(`${m}:synced_qty_to_ledger_qty=${stratQty}`);
          }
        }
      }
      if (state.early_positions[m] && totalSpot <= 0) {
        delete state.early_positions[m];
        delete state.cooldown_until[m];
        reconcileActions.push(`${m}:cleared_early_state_zero_spot`);
      }
    }
    if (lr?.zeroed?.length) {
      for (const m of lr.zeroed) reconcileActions.push(`${m}:trade_control_strategy_qty_zeroed`);
    }
    if (lr?.clamped?.length) {
      for (const m of lr.clamped) reconcileActions.push(`${m}:trade_control_strategy_qty_clamped`);
    }
    if (reconcileActions.length > 0) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_STATE_RECONCILE_RESULT",
          ts: new Date().toISOString(),
          actions: reconcileActions,
          ledger_reconcile: lr ?? null,
        }),
      );
      await persist();
    }

    // holdings_universe: 현재 계좌 보유 종목(관리/청산/표시용). discovery/entry_universe/precheck 경로에서는 제외한다.
    const heldSymbols = Array.from(balArr)
      .map((b: any) => {
        const currency = String(b?.currency ?? "").toUpperCase();
        const qty = Number(b?.balance ?? 0) + Number(b?.locked ?? 0);
        if (!currency || currency === "KRW" || !(qty > 0)) return null;
        return `KRW-${currency}`;
      })
      .filter((x: any): x is string => Boolean(x) && String(x).startsWith("KRW-"));
    const heldSymbolSet = new Set<string>([...heldSymbols, ...Object.keys(state.positions)]);
    if (state.safety_guard.state === "자동정지") {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_LOOP_SKIP",
          reason: "safety_guard_stopped",
          stage: "before_signal_load",
          safety_guard_state: state.safety_guard.state,
          safety_guard_reason: state.safety_guard.reason,
        }),
      );
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_EXIT",
          ts: new Date().toISOString(),
          stage: "before_signal_load",
          reason: "safety_guard_stopped",
          watch_markets_count: null,
          signal_map_count: null,
          markets_with_filter_pass_count: null,
          base_entry_universe_count: null,
          entry_universe_count: null,
          symbol: null,
          note: String(state.safety_guard.reason ?? ""),
        }),
      );
      return;
    }
    const latestByMarket = new Map<string, any>();
    const latestAllSignals = new Map<string, any>();
    const logs = await opts.readLogs(220);
    const marketState = await opts.marketState.evaluate();
    const conservativeMode = marketState.market_state === "risk_off";
    for (const row of logs) {
      if (row.kind !== "signal" || !row.payload) continue;
      const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
      if (!p.success) continue;
      if (!latestAllSignals.has(p.data.market)) latestAllSignals.set(p.data.market, { ts: row.ts, p: p.data });
      if (!MARKETS.includes(p.data.market as any)) continue;
      if (!latestByMarket.has(p.data.market)) latestByMarket.set(p.data.market, { ts: row.ts, p: p.data });
    }

    const includeValidity = await partitionKrwMarketsByUpbitValidity(DEBUG_INCLUDE_UNIVERSE_MARKETS);
    const debugUniverseExtra = includeValidity.skippedBecauseUnknown
      ? [...DEBUG_INCLUDE_UNIVERSE_MARKETS]
      : includeValidity.accepted;
    if (!includeValidity.skippedBecauseUnknown && includeValidity.rejected.length > 0) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_INCLUDE_MARKET_REJECTED_BY_UPBIT_VALIDITY",
          rejected: includeValidity.rejected,
          env_raw: DEBUG_INCLUDE_UNIVERSE_MARKETS,
        }),
      );
    }

    const logMapValidity = await partitionKrwMarketsByUpbitValidity([...latestAllSignals.keys()]);
    if (!logMapValidity.skippedBecauseUnknown) {
      const keepLogMarkets = new Set(logMapValidity.accepted);
      for (const k of [...latestAllSignals.keys()]) {
        if (!keepLogMarkets.has(k)) {
          latestAllSignals.delete(k);
          console.info(
            JSON.stringify({
              tag: "DEBUG_STALE_INVALID_MARKET_PRUNED_FROM_SIGNAL_MAP",
              symbol: k,
              reason: "not_in_upbit_valid_set_or_blacklisted",
              ingress_path: "historical_signal_jsonl_or_delisted_ticker",
            }),
          );
        }
      }
    }

    const exceptionPool = Array.from(latestAllSignals.entries())
      .filter(([m]) => !LEADER_MARKETS.has(m) && m.startsWith("KRW-"))
      .map(([market, sig]) => {
        const gate = opts.marketState.entryGate(sig.p, marketState);
        const signalScore = Number(gate.score ?? 0);
        const vol = Number(sig.p.volume_ratio ?? 0);
        const reasonText = String(sig.p.signal_reason ?? "").toLowerCase();
        const rise3m = Number(sig.p.momentum_3m_pct ?? sig.p.price_change_3m_pct ?? 0);
        const trendOk = reasonText.includes("breakout") || reasonText.includes("trend") || reasonText.includes("reclaim");
        return { market, sig, signalScore, vol, rise3m, trendOk };
      })
      .filter((x) => x.signalScore >= 86 && x.vol >= 1.2 && x.rise3m >= 0.8 && x.trendOk)
      .sort((a, b) => b.signalScore - a.signalScore || b.vol - a.vol);
    const exceptionSlotMarket = exceptionPool[0]?.market ?? null;
    const watchMarkets = Array.from(
      new Set([...MARKETS, ...(exceptionSlotMarket ? [exceptionSlotMarket] : []), ...debugUniverseExtra]),
    );

    const allSignalsArr = Array.from(latestAllSignals.values());
    const filterPassCount = allSignalsArr.filter((x) => Boolean(x?.p?.filter_pass)).length;
    const signalMapCount = latestAllSignals.size;
    const marketSignalsCount = latestByMarket.size;
    const topSignals = Array.from(latestAllSignals.entries())
      .map(([m, s]) => {
        const gate = opts.marketState.entryGate(s.p, marketState);
        const score = Number(gate.score ?? 0);
        const vol = Number(s.p.volume_ratio ?? 0);
        return { market: m, score, vol, filter_pass: Boolean(s.p.filter_pass) };
      })
      .sort((a, b) => b.score - a.score || b.vol - a.vol)
      .slice(0, 8);
    console.info(
      JSON.stringify({
        tag: "DEBUG_SCANNER_UNIVERSE",
        ts: new Date().toISOString(),
        live_strategy_trace_revision: LIVE_STRATEGY_TRACE_REVISION,
        watchlist_count: watchMarkets.length,
        signal_map_count: signalMapCount,
        market_signal_count: marketSignalsCount,
        filter_pass_count: filterPassCount,
        top_symbols: topSignals.map((x) => `${x.market}:${x.score.toFixed(1)}:vr_${x.vol.toFixed(2)}${x.filter_pass ? ":pass" : ""}`),
      }),
    );

    // DEBUG_SCANNER_UNIVERSE 직후 도달 보장 로그 (여기가 안 보이면 dist/런타임 불일치 또는 즉시 예외).
    console.info(
      JSON.stringify({
        tag: "DEBUG_AFTER_SCANNER_REACHED",
        ts: new Date().toISOString(),
        live_strategy_trace_revision: LIVE_STRATEGY_TRACE_REVISION,
        watch_markets_count: watchMarkets.length,
        signal_map_count: signalMapCount,
        planned_entry_universe_count: watchMarkets.length, // entryUniverse 계산 전이므로 예정값으로만 남김
        planned_entry_universe_symbols: watchMarkets.slice(0, 5),
      }),
    );

    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_STAGE_TRACE",
        ts: new Date().toISOString(),
        stage: "scanner_universe_ready",
        watch_markets_count: watchMarkets.length,
        signal_map_count: signalMapCount,
        entry_universe_count: null,
        first_symbols: watchMarkets.slice(0, 8),
      }),
    );

    // entryUniverse 입력(신호/필터/완화 플래그) 가시화 — 스캐너 이후 단계가 왜 조용한지 판별.
    const marketsWithSignal = Array.from(latestAllSignals.keys()).slice(0, 40);
    const filterPassCandidates = Array.from(latestAllSignals.entries())
      .filter(([, s]) => Boolean(s?.p?.filter_pass))
      .map(([m]) => m);
    const marketsWithFilterPass = filterPassCandidates.slice(0, 40);
    const filterPassCandidatesExcludingHeld = filterPassCandidates.filter((m) => !heldSymbolSet.has(m));
    const marketsWithFilterPassExcludingHeld = filterPassCandidatesExcludingHeld.slice(0, 40);
    console.info(
      JSON.stringify({
        tag: "DEBUG_DISCOVERY_UNIVERSE_EXCLUDING_HELD",
        ts: new Date().toISOString(),
        held_symbols: Array.from(heldSymbolSet).slice(0, 20),
        filter_pass_symbols: marketsWithFilterPass.slice(0, 20),
        discovery_symbols: marketsWithFilterPassExcludingHeld.slice(0, 20),
        excluded_held_symbols: marketsWithFilterPass.filter((m) => heldSymbolSet.has(m)).slice(0, 20),
        discovery_count: marketsWithFilterPassExcludingHeld.length,
      }),
    );
    const marketsWithScore = topSignals.slice(0, 12).map((x) => `${x.market}:${x.score.toFixed(1)}`);
    const relaxedFlagCounts = Array.from(latestAllSignals.values()).reduce(
      (acc, s) => {
        const p = s?.p;
        if (!p) return acc;
        if (p.would_pass_with_pullback_relaxed) acc.pullback_relaxed += 1;
        if (p.would_pass_with_vol_close_relaxed_a) acc.vol_close_relaxed_a += 1;
        if (p.would_pass_with_breakout_relaxed_a) acc.breakout_relaxed_a += 1;
        if (p.pair_pass_breakout_b_and_pullback_relaxed) acc.pair_breakout_pullback += 1;
        if (p.pair_pass_breakout_b_and_vol_close_a) acc.pair_breakout_volclose += 1;
        return acc;
      },
      {
        pullback_relaxed: 0,
        vol_close_relaxed_a: 0,
        breakout_relaxed_a: 0,
        pair_breakout_pullback: 0,
        pair_breakout_volclose: 0,
      },
    );
    console.info(
      JSON.stringify({
        tag: "DEBUG_ENTRY_UNIVERSE_INPUT",
        ts: new Date().toISOString(),
        watch_markets_count: watchMarkets.length,
        signal_map_count: signalMapCount,
        filter_pass_count: filterPassCount,
        markets_with_signal: marketsWithSignal,
        markets_with_filter_pass: marketsWithFilterPass,
        markets_with_score: marketsWithScore,
        relaxed_flag_counts: relaxedFlagCounts,
      }),
    );

    // filter_pass 후보가 downstream 입력으로 실제로 핸드오프되는지 진단.
    console.info(
      JSON.stringify({
        tag: "DEBUG_FILTER_PASS_HANDOFF",
        ts: new Date().toISOString(),
        filter_pass_count: filterPassCount,
        filter_pass_symbols: marketsWithFilterPass.slice(0, 10),
        source_array_name: "filterPassCandidates",
        watch_markets_count: watchMarkets.length,
        watch_markets_symbols: watchMarkets.slice(0, 10),
      }),
    );

    // filter_pass=false가 많은 경우, 어떤 하위 필터가 가장 자주 실패하는지 집계(원인 계수화).
    const filterFailBreakdown = (() => {
      const out = {
        volume_failed_count: 0,
        breakout_failed_count: 0,
        trend_failed_count: 0,
        vol_close_failed_count: 0,
        pullback_failed_count: 0,
        data_failed_count: 0,
        other_failed_count: 0,
        samples: [] as string[],
      };
      for (const [m, s] of latestAllSignals.entries()) {
        const p = s?.p;
        const filters = Array.isArray(p?.filters) ? p.filters : [];
        if (filters.length === 0) continue;
        const failed = filters.filter((f: any) => f && f.passed === false).map((f: any) => String(f.id));
        if (failed.length === 0) continue;
        for (const id of failed) {
          if (id.includes("volume_increase")) out.volume_failed_count += 1;
          else if (id.includes("box_breakout")) out.breakout_failed_count += 1;
          else if (id.includes("pullback")) out.pullback_failed_count += 1;
          else if (id.includes("vol") && id.includes("close")) out.vol_close_failed_count += 1;
          else if (id.includes("data")) out.data_failed_count += 1;
          else if (id.includes("trend") || id.includes("ema")) out.trend_failed_count += 1;
          else out.other_failed_count += 1;
        }
        if (out.samples.length < 8) out.samples.push(`${m}:${failed.slice(0, 3).join(",")}`);
      }
      return out;
    })();
    console.info(
      JSON.stringify({
        tag: "DEBUG_FILTER_PASS_BREAKDOWN",
        ts: new Date().toISOString(),
        ...filterFailBreakdown,
      }),
    );

    // 진입 후보 집합(base/precheck)과 ticker fetch 집합(보유/기준가 보강)을 개념적으로 분리한다.
    const fallbackUsedForPrimary = filterPassCandidates.length === 0;
    const tickerRequestSourceKind = fallbackUsedForPrimary ? "fallback" : "filter_pass_primary";
    const watchMarketsExcludingHeld = watchMarkets.filter((m) => !heldSymbolSet.has(m));
    const primaryForUniverse = fallbackUsedForPrimary ? watchMarketsExcludingHeld : filterPassCandidatesExcludingHeld;
    const baseInputSymbols = Array.from(
      new Set([...primaryForUniverse, ...(exceptionSlotMarket ? [exceptionSlotMarket] : []), ...debugUniverseExtra]),
    );
    // 보유 포지션 평가/표시 보강 + BTC 기준가 보강(레짐/스케일 계산용)
    const heldExtraSymbols = Array.from(new Set(["KRW-BTC", ...Array.from(heldSymbolSet)])).filter((m) => m.startsWith("KRW-"));
    const tickerRequestedSymbols = Array.from(new Set([...baseInputSymbols, ...heldExtraSymbols]));
    console.info(
      JSON.stringify({
        tag: "DEBUG_TICKER_REQUEST_SOURCE",
        ts: new Date().toISOString(),
        stage: "after_scanner_before_tickers",
        source_kind: tickerRequestSourceKind,
        base_input_symbols: baseInputSymbols.slice(0, 20),
        held_extra_symbols: heldExtraSymbols.slice(0, 20),
        ticker_requested_symbols: tickerRequestedSymbols.slice(0, 20),
        filter_pass_symbols: filterPassCandidates.slice(0, 20),
        watch_markets_symbols: watchMarkets.slice(0, 20),
        held_symbols: Array.from(heldSymbolSet).slice(0, 20),
        discovery_symbols: primaryForUniverse.slice(0, 20),
        open_position_symbols: Object.keys(state.positions),
      }),
    );
    console.info(
      JSON.stringify({
        tag: "DEBUG_TICKER_FETCH_START",
        ts: new Date().toISOString(),
        stage: "after_scanner_before_tickers",
        requested_count: tickerRequestedSymbols.length,
        requested_symbols: tickerRequestedSymbols.slice(0, 20),
      }),
    );
    let tickerRows: Awaited<ReturnType<typeof fetchTickers>> = [];
    try {
      tickerRows = await fetchTickers(tickerRequestedSymbols, { debugCaller: "live-strategy" });
    } catch (e) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_TICKER_FETCH_ERROR",
          ts: new Date().toISOString(),
          stage: "after_scanner_before_tickers",
          reason: "fetch_tickers_throw",
          error_message: e instanceof Error ? e.message : String(e),
          requested_symbols: tickerRequestedSymbols.slice(0, 30),
        }),
      );
      throw e;
    }
    console.info(
      JSON.stringify({
        tag: "DEBUG_TICKER_FETCH_DONE",
        ts: new Date().toISOString(),
        stage: "after_scanner_after_tickers",
        requested_count: tickerRequestedSymbols.length,
        ticker_rows_count: tickerRows.length,
        ticker_symbols: tickerRows.map((r) => r.market).slice(0, 20),
      }),
    );
    const priceBy = new Map(tickerRows.map((r) => [r.market, r.trade_price]));
    const changeRateBy = new Map(tickerRows.map((r) => [r.market, Number(r.signed_change_rate ?? 0)]));
    const btcChange = Number(changeRateBy.get("KRW-BTC") ?? 0);
    const btcTier: "strong" | "neutral" | "weak" =
      conservativeMode || btcChange <= -0.004 ? "weak" : btcChange >= 0.002 ? "strong" : "neutral";
    const entrySizePct = btcTier === "strong" ? 1 : btcTier === "neutral" ? 0.75 : RISK_OFF_ENTRY_SCALE;
    const exceptionCandidates: Array<{ market: string; reason: string; relative_strength: number; signal_score: number }> = [];
    if (exceptionSlotMarket) {
      const x = exceptionPool[0]!;
      const rel = (Number(changeRateBy.get(exceptionSlotMarket) ?? 0) - btcChange) * 100;
      exceptionCandidates.push({
        market: exceptionSlotMarket,
        reason: `exception_slot:rel_${rel.toFixed(2)}:score_${x.signalScore.toFixed(1)}:vol_${x.vol.toFixed(2)}:rise_${x.rise3m.toFixed(2)}`,
        relative_strength: Number(rel.toFixed(3)),
        signal_score: Number(x.signalScore.toFixed(1)),
      });
    }
    exceptionCandidates.sort((a, b) => b.signal_score - a.signal_score || b.relative_strength - a.relative_strength);
    state.regime = {
      btc_filter_state: btcTier,
      conservative_mode: conservativeMode,
      exception_entry_allowed: true,
      exception_candidates: exceptionCandidates.slice(0, 1),
      exception_slot_market: exceptionSlotMarket,
      entry_size_pct: entrySizePct,
      last_updated_at: new Date().toISOString(),
    };

    // legacy buckets: no stop-loss, limited DCA, staged recovery exits.
    const legacyByMarket = (tstatus.legacy_positions ?? {}) as Record<
      string,
      { qty?: number; avg?: number; dca_count?: number; dca_max?: number; dca_available?: boolean; exit_status?: string }
    >;
    for (const market of MARKETS) {
      const legacy = legacyByMarket[market];
      const legacyQty = Number(legacy?.qty ?? 0);
      const legacyAvg = Number(legacy?.avg ?? 0);
      if (legacyQty <= 0 || legacyAvg <= 0) continue;
      const rawPxL = priceBy.get(market);
      const hasTickerL = typeof rawPxL === "number" && Number.isFinite(rawPxL) && rawPxL > 0;
      const now = hasTickerL ? rawPxL : legacyAvg;
      const pnlGross = grossPnlPct(legacyAvg, now);
      const sig = latestByMarket.get(market);
      const stage = state.legacy.exit_stage[market] ?? 0;
      const dcaCount = state.legacy.dca_count[market] ?? Number(legacy?.dca_count ?? 0);
      const dcaMax = Number(legacy?.dca_max ?? 3);
      const locked = state.legacy.dca_locked[market] ?? !(legacy?.dca_available ?? true);
      const nextDcaAt = state.legacy.next_dca_at[market];
      const dcaCooldownPassed = !nextDcaAt || Date.now() >= Date.parse(nextDcaAt);

      // 레거시 DCA 매수는 기본 비활성화 (새 진입/추가매수 정책에 통합).
      if (LIVE_LEGACY_DCA_BUY_ENABLED && pnlGross >= 0) {
        if (opts.trade.placeLegacyDcaBuy && !locked && dcaCount < dcaMax && dcaCooldownPassed) {
          const krw = Number(tstatus.krw_available ?? 0);
          const orderKrw = Math.floor(Math.max(5000, Math.min(12000, krw * 0.06)));
          if (orderKrw >= 5000 && krw > orderKrw * 1.2 && legacySignalAllowsDca(sig)) {
            try {
              await opts.trade.placeLegacyDcaBuy(market, true, orderKrw, sig?.p);
              state.legacy.dca_count[market] = dcaCount + 1;
              state.legacy.next_dca_at[market] = new Date(Date.now() + 20 * 60_000).toISOString();
              state.legacy.dca_locked[market] = dcaCount + 1 >= dcaMax;
            } catch {}
          }
        }
      }

      // Recovery exits: break-even partial -> small profit partial -> weaken signal trim.
      if (!opts.trade.placeLegacyExitSell) continue;
      const shouldStage1 = stage < 1 && pnlGross >= 0;
      const shouldStage2 = stage < 2 && pnlGross >= 0.9;
      const shouldTrimWeak = stage >= 1 && pnlGross >= 0.4 && legacySignalWeakening(sig);
      const tryLegacySell = async (ratio: number): Promise<boolean> => {
        if (!hasTickerL) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: "take_profit_blocked: stale mark price",
            payload: { market, bucket: "legacy", blockedReason: "missing ticker trade_price" },
          });
          return false;
        }
        const vol = legacyQty * Math.min(1, Math.max(0.01, ratio));
        if (vol * now < UPBIT_MIN_ORDER_KRW) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: "take_profit_blocked: order value below 5000 KRW",
            payload: {
              market,
              bucket: "legacy",
              intendedSellQty: vol,
              intendedSellValueKRW: vol * now,
              blockedReason: "order value below 5000 KRW",
            },
          });
          return false;
        }
        try {
          await opts.trade.placeLegacyExitSell!(market, true, ratio);
          return true;
        } catch {
          return false;
        }
      };
      try {
        if (shouldStage1) {
          if (await tryLegacySell(0.35)) state.legacy.exit_stage[market] = 1;
        } else if (shouldStage2) {
          if (await tryLegacySell(0.35)) state.legacy.exit_stage[market] = 2;
        } else if (shouldTrimWeak) {
          await tryLegacySell(0.5);
        }
      } catch {}
    }

    // early exits/promote — early entry 전용(실패 빠른 컷 / 성공 시 normal로 승격)
    for (const market of Object.keys(state.early_positions)) {
      const ep = state.early_positions[market]!;
      const rawPx = priceBy.get(market);
      const hasTicker = typeof rawPx === "number" && Number.isFinite(rawPx) && rawPx > 0;
      if (!hasTicker) continue;
      const now = rawPx;
      const pnlGross = grossPnlPct(ep.entry_price, now);
      const heldMs = Math.max(0, Date.now() - Date.parse(ep.entry_ts));
      const heldSec = Math.floor(heldMs / 1000);
      const breakoutNow = now >= ep.entry_recent_high && ep.entry_recent_high > 0;
      const promoteNow = breakoutNow || pnlGross >= LIVE_EARLY_PROMOTION_PCT || heldSec >= LIVE_EARLY_PROMOTION_MAX_SECONDS;

      if (promoteNow) {
        // 승격: normal 포지션으로 이동 (기존 exit 로직 적용)
        const stNow = await opts.trade.status();
        const currency = market.replace("KRW-", "");
        const bNow = stNow.balances?.find((x: any) => x.currency === currency);
        const qty =
          bNow !== undefined ? Number(bNow.balance ?? 0) + Number(bNow.locked ?? 0) : Number(ep.qty ?? 0);
        state.positions[market] = {
          market,
          strategy_type: "momentum",
          entry_ts: ep.entry_ts,
          entry_price: ep.entry_price,
          qty,
          order_krw: ep.order_krw,
          reason_enter: `early_entry_promoted|signal_ts=${ep.signal_ts ?? "na"}`,
          signal_strength: ep.signal_strength,
          volume_ratio: ep.entry_volume_ratio_1m5,
          position_stage: "normal_active",
          partial_tp_done: false,
          max_pnl_pct: pnlGross,
          min_pnl_pct: Math.min(0, pnlGross),
          breakeven_armed: false,
          highest_price_after_entry: Math.max(ep.entry_price, now),
          trailing_stop_price: 0,
          realized_partial_profit: 0,
          remaining_qty: qty,
          current_net_pnl_pct: pnlGross,
          breakeven_armed_at: null,
          partial_tp_at: null,
          strict_exit: true,
        };
        emitStageChange({
          symbol: market,
          from_stage: ep.position_stage ?? "early_active",
          to_stage: "normal_active",
          reason: breakoutNow ? "early_breakout_promote" : pnlGross >= LIVE_EARLY_PROMOTION_PCT ? "early_profit_promote" : "early_followthrough_promote",
          entry_price: ep.entry_price,
          current_price: now,
          net_pnl_pct: pnlGross,
          held_seconds: heldSec,
        });
        ep.promoted = true;
        delete state.early_positions[market];
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_EARLY_ENTRY_EXIT",
            ts: new Date().toISOString(),
            symbol: market,
            early_entry_fail_triggered: false,
            exit_reason: "promoted_to_normal",
            held_seconds: heldSec,
            pnl_gross_pct: pnlGross,
          }),
        );
        continue;
      }

      const failByTime = heldSec >= LIVE_EARLY_ENTRY_FAIL_SECONDS && !breakoutNow;
      const failByLoss = pnlGross <= LIVE_EARLY_ENTRY_FAIL_LOSS_PCT;
      if (!failByTime && !failByLoss) continue;

      const exitReason = failByLoss ? "early_entry_fail_loss" : "early_entry_breakout_failed";
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_ENTRY_EXIT",
          ts: new Date().toISOString(),
          symbol: market,
          early_entry_fail_triggered: true,
          exit_reason: exitReason,
          held_seconds: heldSec,
          pnl_gross_pct: pnlGross,
        }),
      );
      try {
        await opts.trade.placeSell(market, true, 1);
      } catch {
        continue;
      }
      delete state.early_positions[market];
      state.cooldown_until[market] = new Date(Date.now() + LIVE_REENTRY_COOLDOWN_EARLY_FAIL_SECONDS * 1000).toISOString();
    }

    // exits — 익절/손절 판단은 업비트 보유 화면과 동일한 평단 대비 가격 변동률(gross) 기준
    for (const market of Object.keys(state.positions)) {
      const p = state.positions[market]!;
      const rawPx = priceBy.get(market);
      const hasTicker = typeof rawPx === "number" && Number.isFinite(rawPx) && rawPx > 0;
      if (!hasTicker) {
        continue;
      }
      const now = rawPx;
      const pnlGross = grossPnlPct(p.entry_price, now);
      const heldMs = Math.max(0, Date.now() - Date.parse(p.entry_ts));
      const withinGracePeriod = heldMs < LIVE_EXIT_GRACE_SECONDS * 1000;
      const feeRoundTripPct = UPBIT_FEE_RATE * 2 * 100;
      const netPnlPctEst = pnlGross - feeRoundTripPct - LIVE_EXIT_FEE_BUFFER_PCT;
      p.max_pnl_pct = Math.max(p.max_pnl_pct, pnlGross);
      p.min_pnl_pct = Math.min(Number(p.min_pnl_pct ?? 0), pnlGross);
      p.current_net_pnl_pct = pnlGross;
      if (now > p.highest_price_after_entry) {
        p.highest_price_after_entry = now;
        state.trades.push({
          timestamp: new Date().toISOString(),
          entry_ts: p.entry_ts,
          market,
          action: "sell",
          order_krw: 0,
          filled_qty: 0,
          avg_buy_price: p.entry_price,
          exit_price: now,
          pnl_krw: 0,
          pnl_pct: pnlGross,
          reason_enter: p.reason_enter,
          reason_exit: "highest_price_update",
          holding_minutes: minutesSince(p.entry_ts),
          signal_strength: p.signal_strength,
          volume_ratio: p.volume_ratio,
          strategy_tag: "live_data_mode_v1",
          strategy_type: p.strategy_type,
          stop_trigger_kind: null,
          current_net_pnl_pct: pnlGross,
          liquidation_reason: "highest_price_update",
          remaining_qty: p.qty,
          highest_price_after_entry: p.highest_price_after_entry,
          trailing_stop_price: p.trailing_stop_price,
          breakeven_armed_at: p.breakeven_armed_at,
          partial_tp_at: p.partial_tp_at,
        });
      }
      const holdMin = minutesSince(p.entry_ts);
      let reasonExit = "";
      let stopTriggerKind: StopTriggerKind | null = null;
      let ratio = 1;
      const weakModeTighterStop = (state.regime?.btc_filter_state ?? "neutral") === "weak" ? LIVE_BTC_WEAK_TIGHT_STOP_PCT : null;
      if (weakModeTighterStop !== null && pnlGross <= weakModeTighterStop) {
        reasonExit = "weak_market_price_stop";
        stopTriggerKind = "price_stop";
      }
      // Emergency stop loss — always allowed even within grace period.
      if (!reasonExit && pnlGross <= LIVE_EMERGENCY_STOP_LOSS_PCT) {
        reasonExit = "emergency_stop_loss";
        stopTriggerKind = "price_stop";
      }
      if (!reasonExit && p.strategy_type === "stable") {
        const xs = p.strict_exit ? STRICT_NEW_POSITION_EXIT.stable : null;
        const s = xs
          ? {
              breakeven_arm_pct: xs.breakeven_arm_pct,
              breakeven_floor_pct: xs.breakeven_floor_pct,
              partial_take_profit_pct: xs.partial_tp_pct,
              partial_take_profit_ratio: xs.partial_tp_ratio,
              trailing_from_peak_pct: xs.trailing_peak_pct,
            }
          : STRATEGY_RISK_CONFIG.stable;
        const weakHoldMin = xs ? xs.weak_hold_stop_minutes : LIVE_STABLE_WEAK_REBOUND_TIME_STOP_MINUTES;
        const recv = xs
          ? {
              giveup_minutes: xs.giveup_minutes,
              min_peak_pct_to_skip_catastrophic: xs.min_peak_pct_skip_catastrophic,
              catastrophic_exit_pct: xs.catastrophic_exit_pct,
            }
          : RECOVERY_EXIT_CONFIG.stable;

        if (xs) {
          if (holdMin >= xs.hard_stop_min_hold_min && pnlGross <= xs.hard_stop_pct) {
            reasonExit = "strict_hard_stop_loss";
            stopTriggerKind = "price_stop";
          }
          if (!reasonExit && holdMin >= xs.early_cut_minutes && p.max_pnl_pct < xs.early_cut_max_peak_pct && pnlGross <= xs.early_cut_pnl_pct) {
            reasonExit = "strict_early_loss_cut";
            stopTriggerKind = "price_stop";
          }
        }
        if (!reasonExit) {
          if (!p.breakeven_armed && pnlGross >= s.breakeven_arm_pct) {
            p.breakeven_armed = true;
            p.breakeven_armed_at = new Date().toISOString();
            state.trades.push({
              timestamp: p.breakeven_armed_at,
              entry_ts: p.entry_ts,
              market,
              action: "buy",
              order_krw: 0,
              filled_qty: 0,
              avg_buy_price: p.entry_price,
              exit_price: now,
              pnl_krw: 0,
              pnl_pct: pnlGross,
              reason_enter: p.reason_enter,
              reason_exit: "breakeven_armed",
              holding_minutes: holdMin,
              signal_strength: p.signal_strength,
              volume_ratio: p.volume_ratio,
              strategy_tag: "live_data_mode_v1",
              strategy_type: p.strategy_type,
              stop_trigger_kind: "breakeven_protect",
              current_net_pnl_pct: pnlGross,
              liquidation_reason: "breakeven_armed",
              remaining_qty: p.qty,
              highest_price_after_entry: p.highest_price_after_entry,
              trailing_stop_price: p.trailing_stop_price,
              breakeven_armed_at: p.breakeven_armed_at,
              partial_tp_at: p.partial_tp_at,
            });
            await opts.onEvent?.({
              timestamp: p.breakeven_armed_at,
              event_type: "breakeven_armed",
              market,
              strategy_type: p.strategy_type,
              market_state: null,
              side: "sell",
              reason: "breakeven_protect",
              balance_krw: null,
              position_qty: p.qty,
              avg_buy_price: p.entry_price,
              current_price: now,
              pnl_net: null,
              pnl_net_pct: pnlGross,
              note: p.strict_exit ? "stable breakeven armed (strict_new)" : "stable breakeven armed",
            });
          }
          p.trailing_stop_price = p.highest_price_after_entry * (1 - s.trailing_from_peak_pct / 100);
          // break-even / stop-up (env)
          if (!reasonExit) {
            if (!p.breakeven_armed && pnlGross >= LIVE_BREAK_EVEN_ARM_PCT) {
              p.breakeven_armed = true;
              p.breakeven_armed_at = new Date().toISOString();
              console.info(
                JSON.stringify({
                  tag: "DEBUG_LIVE_STOP_UP_ARMED",
                  ts: p.breakeven_armed_at,
                  symbol: market,
                  entry_price: p.entry_price,
                  current_price: now,
                  gross_pnl_pct: pnlGross,
                  break_even_arm_pct: LIVE_BREAK_EVEN_ARM_PCT,
                  break_even_lock_pct: LIVE_BREAK_EVEN_LOCK_PCT,
                }),
              );
            }
            if (p.breakeven_armed && pnlGross <= LIVE_BREAK_EVEN_LOCK_PCT) {
              reasonExit = "break_even_stop";
              stopTriggerKind = "breakeven_protect";
            }
          }
          // partial TP (env) — before legacy strict partial/trailing
          if (!reasonExit && !p.partial_tp_done && pnlGross >= LIVE_PARTIAL_TAKE_PROFIT_PCT) {
            reasonExit = "partial_take_profit";
            ratio = LIVE_PARTIAL_TAKE_PROFIT_RATIO;
            stopTriggerKind = null;
          }
          // runner trail (env) for scaled out positions
          if (!reasonExit && p.partial_tp_done && p.highest_price_after_entry > 0) {
            const dd = ((p.highest_price_after_entry - now) / p.highest_price_after_entry) * 100;
            if (dd >= LIVE_RUNNER_TRAIL_FROM_PEAK_PCT) {
              reasonExit = "trail_from_peak_stop";
              stopTriggerKind = "time_stop";
            }
          }
          if (!reasonExit && p.partial_tp_done && p.partial_tp_at) {
            const minSincePartial = minutesSince(p.partial_tp_at);
            const peakGiveback = p.max_pnl_pct - pnlGross;
            const stalledFromPeak =
              minSincePartial >= LIVE_RESIDUAL_MIN_MINUTES_AFTER_PARTIAL &&
              peakGiveback >= LIVE_RESIDUAL_PEAK_GIVEBACK_PCT &&
              pnlGross < LIVE_RESIDUAL_STALL_PNL_CAP;
            const slotHog =
              holdMin >= LIVE_RESIDUAL_MAX_HOLD_MINUTES && p.max_pnl_pct < 3.5 && pnlGross < 2.2;
            if (stalledFromPeak || slotHog) {
              reasonExit = "residual_full_exit_escalation";
              ratio = 1;
              stopTriggerKind = "time_stop";
              console.info(
                JSON.stringify({
                  tag: "DEBUG_LIVE_RESIDUAL_EXIT_ESCALATION",
                  ts: new Date().toISOString(),
                  symbol: market,
                  strategy_type: "stable",
                  stalled_from_peak: stalledFromPeak,
                  slot_hog: slotHog,
                  minutes_since_partial: Math.round(minSincePartial),
                  peak_giveback_pct: Number(peakGiveback.toFixed(4)),
                  gross_pnl_pct: pnlGross,
                  hold_minutes: holdMin,
                }),
              );
            }
          }
          if (!p.partial_tp_done && pnlGross >= s.partial_take_profit_pct) {
            reasonExit = p.strict_exit ? "partial_take_profit_1st_strict" : "partial_take_profit";
            ratio = s.partial_take_profit_ratio;
            stopTriggerKind = null;
          } else if (p.partial_tp_done && now <= p.trailing_stop_price) {
            reasonExit = p.strict_exit ? "trailing_runner_exit_strict" : "trailing_take_profit";
            stopTriggerKind = "time_stop";
          } else if (p.breakeven_armed && pnlGross <= s.breakeven_floor_pct) {
            reasonExit = "breakeven_exit";
            stopTriggerKind = "breakeven_protect";
          } else if (
            holdMin >= recv.giveup_minutes &&
            p.max_pnl_pct < recv.min_peak_pct_to_skip_catastrophic &&
            pnlGross <= recv.catastrophic_exit_pct
          ) {
            reasonExit = `stable_catastrophic_exit_${recv.catastrophic_exit_pct}`;
            stopTriggerKind = "price_stop";
          } else if (holdMin >= weakHoldMin && p.max_pnl_pct < 0.35 && pnlGross < 0) {
            reasonExit = "weak_market_time_stop";
            stopTriggerKind = "time_stop";
          }
        }
      } else if (!reasonExit) {
        const xm = p.strict_exit ? STRICT_NEW_POSITION_EXIT.momentum : null;
        const m = xm
          ? {
              breakeven_arm_pct: xm.breakeven_arm_pct,
              breakeven_floor_pct: xm.breakeven_floor_pct,
              partial_take_profit_pct: xm.partial_tp_pct,
              partial_take_profit_ratio: xm.partial_tp_ratio,
              trailing_from_peak_pct: xm.trailing_peak_pct,
              time_stop_min_minutes: STRATEGY_RISK_CONFIG.momentum.time_stop_min_minutes,
              time_stop_max_minutes: STRATEGY_RISK_CONFIG.momentum.time_stop_max_minutes,
            }
          : STRATEGY_RISK_CONFIG.momentum;
        const recvM = xm
          ? {
              giveup_minutes: xm.giveup_minutes,
              min_peak_pct_to_skip_catastrophic: xm.min_peak_pct_skip_catastrophic,
              catastrophic_exit_pct: xm.catastrophic_exit_pct,
            }
          : RECOVERY_EXIT_CONFIG.momentum;

        if (xm) {
          if (holdMin >= xm.hard_stop_min_hold_min && pnlGross <= xm.hard_stop_pct) {
            reasonExit = "strict_hard_stop_loss";
            stopTriggerKind = "price_stop";
          }
          if (!reasonExit && holdMin >= xm.early_cut_minutes && p.max_pnl_pct < xm.early_cut_max_peak_pct && pnlGross <= xm.early_cut_pnl_pct) {
            reasonExit = "strict_early_loss_cut";
            stopTriggerKind = "price_stop";
          }
        }
        if (!reasonExit) {
          if (!p.breakeven_armed && pnlGross >= m.breakeven_arm_pct) {
            p.breakeven_armed = true;
            p.breakeven_armed_at = new Date().toISOString();
            state.trades.push({
              timestamp: p.breakeven_armed_at,
              entry_ts: p.entry_ts,
              market,
              action: "buy",
              order_krw: 0,
              filled_qty: 0,
              avg_buy_price: p.entry_price,
              exit_price: now,
              pnl_krw: 0,
              pnl_pct: pnlGross,
              reason_enter: p.reason_enter,
              reason_exit: "breakeven_armed",
              holding_minutes: holdMin,
              signal_strength: p.signal_strength,
              volume_ratio: p.volume_ratio,
              strategy_tag: "live_data_mode_v1",
              strategy_type: p.strategy_type,
              stop_trigger_kind: "breakeven_protect",
              current_net_pnl_pct: pnlGross,
              liquidation_reason: "breakeven_armed",
              remaining_qty: p.qty,
              highest_price_after_entry: p.highest_price_after_entry,
              trailing_stop_price: p.trailing_stop_price,
              breakeven_armed_at: p.breakeven_armed_at,
              partial_tp_at: p.partial_tp_at,
            });
            await opts.onEvent?.({
              timestamp: p.breakeven_armed_at,
              event_type: "breakeven_armed",
              market,
              strategy_type: p.strategy_type,
              market_state: null,
              side: "sell",
              reason: "breakeven_protect",
              balance_krw: null,
              position_qty: p.qty,
              avg_buy_price: p.entry_price,
              current_price: now,
              pnl_net: null,
              pnl_net_pct: pnlGross,
              note: p.strict_exit ? "momentum breakeven armed (strict_new)" : "momentum breakeven armed",
            });
          }
          p.trailing_stop_price = p.highest_price_after_entry * (1 - m.trailing_from_peak_pct / 100);
          if (!reasonExit && p.partial_tp_done && p.partial_tp_at) {
            const minSincePartial = minutesSince(p.partial_tp_at);
            const peakGiveback = p.max_pnl_pct - pnlGross;
            const stalledFromPeak =
              minSincePartial >= LIVE_RESIDUAL_MIN_MINUTES_AFTER_PARTIAL &&
              peakGiveback >= LIVE_RESIDUAL_PEAK_GIVEBACK_PCT &&
              pnlGross < LIVE_RESIDUAL_STALL_PNL_CAP;
            const slotHog =
              holdMin >= LIVE_RESIDUAL_MAX_HOLD_MINUTES && p.max_pnl_pct < 3.5 && pnlGross < 2.2;
            if (stalledFromPeak || slotHog) {
              reasonExit = "residual_full_exit_escalation";
              ratio = 1;
              stopTriggerKind = "time_stop";
              console.info(
                JSON.stringify({
                  tag: "DEBUG_LIVE_RESIDUAL_EXIT_ESCALATION",
                  ts: new Date().toISOString(),
                  symbol: market,
                  strategy_type: "momentum",
                  stalled_from_peak: stalledFromPeak,
                  slot_hog: slotHog,
                  minutes_since_partial: Math.round(minSincePartial),
                  peak_giveback_pct: Number(peakGiveback.toFixed(4)),
                  gross_pnl_pct: pnlGross,
                  hold_minutes: holdMin,
                }),
              );
            }
          }
          if (!p.partial_tp_done && pnlGross >= m.partial_take_profit_pct) {
            reasonExit = p.strict_exit ? "partial_take_profit_1st_strict" : "partial_take_profit";
            ratio = m.partial_take_profit_ratio;
          } else if (p.partial_tp_done && now <= p.trailing_stop_price) {
            reasonExit = p.strict_exit ? "trailing_runner_exit_strict" : "trailing_take_profit";
            stopTriggerKind = "time_stop";
          } else if (p.breakeven_armed && pnlGross <= m.breakeven_floor_pct) {
            reasonExit = "momentum_breakeven_protect";
            stopTriggerKind = "breakeven_protect";
          } else if (
            holdMin >= recvM.giveup_minutes &&
            p.max_pnl_pct < recvM.min_peak_pct_to_skip_catastrophic &&
            pnlGross <= recvM.catastrophic_exit_pct
          ) {
            reasonExit = `momentum_catastrophic_exit_${recvM.catastrophic_exit_pct}`;
            stopTriggerKind = "price_stop";
          } else {
            try {
              const c1 = await fetchMinuteCandles(market, 1, 8);
              const last = c1[c1.length - 1];
              const prev = c1[c1.length - 2];
              if (last && prev) {
                const lastNotional = last.candle_acc_trade_volume * last.trade_price;
                const prevNotional = Math.max(1, prev.candle_acc_trade_volume * prev.trade_price);
                const dealDrop = lastNotional / prevNotional < 0.45;
                const range = Math.max(1e-9, last.high_price - last.low_price);
                const closeLow = (last.trade_price - last.low_price) / range < 0.28;
                const upperWickWeak = (last.high_price - last.trade_price) / range > 0.55 && last.trade_price <= last.opening_price;
                const breakoutLowBreak = last.trade_price < prev.low_price;
                if (dealDrop || closeLow || upperWickWeak || breakoutLowBreak) {
                  reasonExit = "momentum_pattern_break";
                  stopTriggerKind = "pattern_break";
                }
              }
            } catch {}
            if (!reasonExit && holdMin >= m.time_stop_min_minutes && holdMin <= m.time_stop_max_minutes && p.max_pnl_pct < 0.8 && pnlGross <= -0.1) {
              reasonExit = "momentum_time_stop";
              stopTriggerKind = "time_stop";
            }
          }
        }
      }
      if (!reasonExit) continue;

      // Early micro-loss guard: avoid selling on tiny negative noise immediately after entry.
      const isStopLike =
        /stop|loss|catastrophic|time_stop_weak_rebound|momentum_time_stop|residual_full_exit_escalation/i.test(reasonExit) ||
        stopTriggerKind === "price_stop";
      const withinEarlyLossGuard = heldMs < LIVE_EXIT_EARLY_LOSS_GUARD_SECONDS * 1000;
      const blockedByMicroLoss = withinEarlyLossGuard && isStopLike && netPnlPctEst > LIVE_MIN_EXIT_LOSS_PCT && reasonExit !== "emergency_stop_loss";

      const emergencyExit =
        reasonExit === "emergency_stop_loss" ||
        reasonExit === "weak_market_price_stop" ||
        reasonExit === "strict_hard_stop_loss" ||
        reasonExit === "strict_early_loss_cut";

      const exitBlockedByGrace = withinGracePeriod && !emergencyExit;
      const exitAllowed = !exitBlockedByGrace && !blockedByMicroLoss;

      const beforeQty = p.qty;
      const ratioClamped = Math.min(1, Math.max(0.01, ratio));
      const intendedSellQty = beforeQty * ratioClamped;
      const intendedSellValueKrw = intendedSellQty * now;
      const pnlNetUnit = netPnlPctPerUnit(p.entry_price, now);

      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EXIT_DECISION",
          ts: new Date().toISOString(),
          symbol: market,
          position_id: `${market}|${p.entry_ts}`,
          opened_at: p.entry_ts,
          held_seconds: Math.floor(heldMs / 1000),
          within_grace_period: withinGracePeriod,
          entry_price: p.entry_price,
          current_price: now,
          peak_price_after_entry: p.highest_price_after_entry,
          drawdown_from_peak_pct: grossPnlPct(p.highest_price_after_entry, now),
          gross_pnl_pct: pnlGross,
          net_pnl_pct: netPnlPctEst,
          market_state: state.regime?.btc_filter_state ?? null,
          exit_reason: exitBlockedByGrace ? "blocked_by_grace_period" : blockedByMicroLoss ? "blocked_by_micro_loss_guard" : reasonExit,
          exit_reason_detail: {
            chosen_reason: reasonExit,
            stop_trigger_kind: stopTriggerKind,
            legacy_reason_alias:
              reasonExit === "weak_market_price_stop"
                ? "btc_weak_tight_stop"
                : reasonExit === "weak_market_time_stop"
                  ? "stable_time_stop_weak_rebound"
                  : null,
            fee_round_trip_pct: feeRoundTripPct,
            fee_buffer_pct: LIVE_EXIT_FEE_BUFFER_PCT,
            min_exit_loss_pct: LIVE_MIN_EXIT_LOSS_PCT,
            emergency_stop_loss_pct: LIVE_EMERGENCY_STOP_LOSS_PCT,
            grace_seconds: LIVE_EXIT_GRACE_SECONDS,
            early_loss_guard_seconds: LIVE_EXIT_EARLY_LOSS_GUARD_SECONDS,
          },
          exit_blocked_by_grace_period: exitBlockedByGrace,
          exit_allowed: exitAllowed,
          emergency_exit: emergencyExit,
          trend_state: null,
          pullback_state: null,
        }),
      );

      if (!exitAllowed) {
        continue;
      }

      if (intendedSellQty <= 0) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "take_profit_blocked: quantity zero",
          payload: { market, reason_exit: reasonExit, quantity: beforeQty },
        });
        continue;
      }
      if (intendedSellValueKrw < UPBIT_MIN_ORDER_KRW) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "take_profit_blocked: order value below 5000 KRW",
          payload: {
            market,
            reason_exit: reasonExit,
            avg_buy_price: p.entry_price,
            current_price_used_for_display: now,
            current_price_used_for_sell_decision: now,
            quantity: beforeQty,
            pnl_percent_display: pnlGross,
            pnl_percent_sell_decision: pnlGross,
            net_pnl_percent_after_fees: pnlNetUnit,
            intended_sell_ratio: ratioClamped,
            intended_sell_qty: intendedSellQty,
            intended_sell_value_krw: intendedSellValueKrw,
            blockedReason: "order value below 5000 KRW",
          },
        });
        continue;
      }

      try {
        await opts.trade.placeSell(market, true, ratio);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "take_profit_blocked: sell_failed",
          payload: {
            market,
            reason_exit: reasonExit,
            error: msg.slice(0, 400),
            intended_sell_qty: intendedSellQty,
            intended_sell_value_krw: intendedSellValueKrw,
            blockedReason: "sell_failed",
          },
        });
        continue;
      }
      const after = await opts.trade.status();
      const qtyAfter = Number(after.strategy_positions?.[market]?.qty ?? 0);
      const soldQty = Math.max(0, beforeQty - qtyAfter);
      const grossSell = soldQty * now;
      const principal = soldQty * p.entry_price;
      const buyFee = principal * UPBIT_FEE_RATE;
      const sellFee = grossSell * UPBIT_FEE_RATE;
      const netPnlKrw = grossSell - principal - buyFee - sellFee;
      const netPnlPctValue = principal > 0 ? (netPnlKrw / principal) * 100 : 0;
      const row: StrategyTradeRow = {
        timestamp: new Date().toISOString(),
        entry_ts: p.entry_ts,
        market,
        action: "sell",
        order_krw: Math.round(Math.max(0, soldQty * now)),
        filled_qty: soldQty,
        avg_buy_price: p.entry_price,
        exit_price: now,
        pnl_krw: Math.round(netPnlKrw),
        pnl_pct: netPnlPctValue,
        reason_enter: p.reason_enter,
        reason_exit: reasonExit,
        holding_minutes: holdMin,
        signal_strength: p.signal_strength,
        volume_ratio: p.volume_ratio,
        strategy_tag: "live_data_mode_v1",
        strategy_type: p.strategy_type,
        stop_trigger_kind: stopTriggerKind,
        current_net_pnl_pct: netPnlPctValue,
        liquidation_reason: reasonExit,
        remaining_qty: qtyAfter,
        highest_price_after_entry: p.highest_price_after_entry,
        trailing_stop_price: p.trailing_stop_price,
        breakeven_armed_at: p.breakeven_armed_at,
        partial_tp_at: p.partial_tp_at,
      };
      state.trades.push(row);
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_SELL_FILLED",
          ts: new Date().toISOString(),
          symbol: market,
          position_id: `${market}|${p.entry_ts}`,
          opened_at: p.entry_ts,
          filled_qty: soldQty,
          filled_price: now,
          pnl_pct: netPnlPctValue,
          pnl_krw: Math.round(netPnlKrw),
          exit_reason: reasonExit,
          open_positions_after: qtyAfter <= 0 ? Math.max(0, Object.keys(state.positions).length - 1) : Object.keys(state.positions).length,
        }),
      );
      await opts.onEvent?.({
        timestamp: row.timestamp,
        event_type:
          reasonExit === "partial_take_profit" || reasonExit === "partial_take_profit_1st_strict"
            ? "partial_take_profit"
            : reasonExit === "trailing_take_profit" || reasonExit === "trailing_runner_exit_strict"
              ? "trailing_take_profit"
              : reasonExit === "breakeven_exit" || reasonExit === "momentum_breakeven_protect"
                ? "breakeven_exit"
                : reasonExit === "momentum_pattern_break"
                  ? "pattern_break_exit"
                  : reasonExit === "momentum_time_stop" ||
                      reasonExit === "stable_time_stop_weak_rebound" ||
                      reasonExit === "residual_full_exit_escalation"
                    ? "time_stop_exit"
                    : "stop_loss",
        market,
        strategy_type: p.strategy_type,
        market_state: null,
        side: "sell",
        reason: reasonExit,
        balance_krw: null,
        position_qty: qtyAfter,
        avg_buy_price: p.entry_price,
        current_price: now,
        pnl_net: Math.round(netPnlKrw),
        pnl_net_pct: netPnlPctValue,
        note: null,
      });
      if (netPnlKrw < 0) {
        state.daily.stop_by_market[market] = (state.daily.stop_by_market[market] ?? 0) + 1;
        state.daily.loss_pct -= Math.abs(netPnlPctValue);
        state.safety_guard.consecutive_losses += 1;
      } else {
        state.safety_guard.consecutive_losses = 0;
      }
      if (qtyAfter <= 0) {
        delete state.positions[market];
        const baseCdSec = LIVE_REENTRY_COOLDOWN_SECONDS;
        state.cooldown_until[market] = new Date(Date.now() + baseCdSec * 1000).toISOString();
        emitStageChange({
          symbol: market,
          from_stage: p.position_stage ?? "normal_active",
          to_stage: "closed",
          reason: `exit:${reasonExit}`,
          entry_price: p.entry_price,
          current_price: now,
          net_pnl_pct: netPnlPctValue,
          held_seconds: Math.floor((Date.now() - Date.parse(p.entry_ts)) / 1000),
        });
      } else {
        if (!p.partial_tp_done && (reasonExit === "partial_take_profit" || reasonExit === "partial_take_profit_1st_strict")) {
          p.partial_tp_done = true;
          p.partial_tp_at = new Date().toISOString();
          p.realized_partial_profit += Math.round(netPnlKrw);
          const prevStage = p.position_stage ?? "normal_active";
          p.position_stage = "scaled_out_partial";
          emitStageChange({
            symbol: market,
            from_stage: prevStage,
            to_stage: "scaled_out_partial",
            reason: "partial_take_profit",
            entry_price: p.entry_price,
            current_price: now,
            net_pnl_pct: netPnlPctValue,
            held_seconds: Math.floor((Date.now() - Date.parse(p.entry_ts)) / 1000),
          });
          console.info(
            JSON.stringify({
              tag: "DEBUG_LIVE_PARTIAL_TAKE_PROFIT",
              ts: new Date().toISOString(),
              symbol: market,
              ratio: ratioClamped,
              filled_qty: soldQty,
              filled_price: now,
              pnl_pct: netPnlPctValue,
              pnl_krw: Math.round(netPnlKrw),
              stage: "scaled_out_partial",
            }),
          );
        }
        p.qty = qtyAfter;
        p.remaining_qty = qtyAfter;
      }
    }

    // entries
    if (state.daily.entry_count >= 6) {
      await persist();
      return;
    }
    if (state.daily.loss_pct <= -2.5) {
      state.safety_guard.state = "자동정지";
      state.safety_guard.reason = "daily_pnl_limit_-2.5";
      await opts.trade.setAutoTradeEnabled?.(false);
      await opts.onEvent?.({
        timestamp: new Date().toISOString(),
        event_type: "safety_guard_stopped",
        market: null,
        strategy_type: null,
        market_state: null,
        side: null,
        reason: "daily_pnl_limit_-2.5",
        balance_krw: Number(tstatus.krw_available ?? 0),
        position_qty: Object.keys(state.positions).length,
        avg_buy_price: null,
        current_price: null,
        pnl_net: Number(summarize().strategy_pnl_krw ?? 0),
        pnl_net_pct: state.daily.loss_pct,
        note: null,
      });
      await persist();
      return;
    }
    if (state.safety_guard.consecutive_losses >= 3) {
      state.safety_guard.state = "자동정지";
      state.safety_guard.reason = "consecutive_losses_3";
      await opts.trade.setAutoTradeEnabled?.(false);
      await opts.onEvent?.({
        timestamp: new Date().toISOString(),
        event_type: "safety_guard_stopped",
        market: null,
        strategy_type: null,
        market_state: null,
        side: null,
        reason: "consecutive_losses_3",
        balance_krw: Number(tstatus.krw_available ?? 0),
        position_qty: Object.keys(state.positions).length,
        avg_buy_price: null,
        current_price: null,
        pnl_net: Number(summarize().strategy_pnl_krw ?? 0),
        pnl_net_pct: null,
        note: null,
      });
      await persist();
      return;
    }
    const exceptionSlot = state.regime?.exception_slot_market ?? null;
    const fallbackUsed = filterPassCandidatesExcludingHeld.length === 0;
    const inputSourceKind = fallbackUsed ? "legacy_fallback" : "filter_pass_primary";
    const primary = fallbackUsed ? watchMarkets.filter((m) => !heldSymbolSet.has(m)) : filterPassCandidatesExcludingHeld;
    const baseEntryUniverseInput = Array.from(new Set([...primary, ...(exceptionSlot ? [exceptionSlot] : []), ...debugUniverseExtra]));
    console.info(
      JSON.stringify({
        tag: "DEBUG_ENTRY_INPUT_SOURCE",
        ts: new Date().toISOString(),
        stage: "before_base_entry_universe",
        input_source_kind: inputSourceKind,
        input_count: baseEntryUniverseInput.length,
        input_symbols: baseEntryUniverseInput.slice(0, 12),
        filter_pass_count: filterPassCandidatesExcludingHeld.length,
        fallback_used: fallbackUsed,
        note: fallbackUsed
          ? "filter_pass_candidates empty → fallback to watchMarkets"
          : "primary=filter_pass_candidates + secondary(exceptionSlot, debugUniverseExtra)",
      }),
    );
    const baseEntryUniverse = baseEntryUniverseInput;
    console.info(
      JSON.stringify({
        tag: "DEBUG_BASE_ENTRY_SOURCE_MATCH",
        ts: new Date().toISOString(),
        stage: "after_base_entry_universe",
        base_input_symbols: baseEntryUniverse.slice(0, 20),
        held_extra_symbols: heldExtraSymbols.slice(0, 20),
        ticker_requested_symbols: tickerRequestedSymbols.slice(0, 20),
        symbols_match_boolean:
          baseEntryUniverse.length === tickerRequestedSymbols.length &&
          baseEntryUniverse.every((m) => tickerRequestedSymbols.includes(m)),
        ticker_is_superset_of_base: baseEntryUniverse.every((m) => tickerRequestedSymbols.includes(m)),
        base_only_symbols: baseEntryUniverse.filter((m) => !tickerRequestedSymbols.includes(m)).slice(0, 20),
        ticker_extra_symbols: tickerRequestedSymbols.filter((m) => !baseEntryUniverse.includes(m)).slice(0, 20),
        match_interpretation: (() => {
          const baseOnly = baseEntryUniverse.filter((m) => !tickerRequestedSymbols.includes(m));
          const tickerSuperset = baseOnly.length === 0;
          const exact =
            baseEntryUniverse.length === tickerRequestedSymbols.length &&
            tickerRequestedSymbols.every((m) => baseEntryUniverse.includes(m));
          if (exact) return "exact_match";
          if (tickerSuperset) return "superset_with_held_extra";
          return "mismatch_missing_base_symbol";
        })(),
      }),
    );
    console.info(
      JSON.stringify({
        tag: "DEBUG_BASE_ENTRY_UNIVERSE_CREATED",
        ts: new Date().toISOString(),
        stage: "after_base_entry_universe",
        source_input_kind: inputSourceKind,
        base_entry_universe_count: baseEntryUniverse.length,
        base_entry_universe_symbols: baseEntryUniverse.slice(0, 12),
      }),
    );

    // max_positions cap 상태를 더 자세히 로깅하고, 조기 종료되더라도 입력 source 로그는 이미 남긴 상태여야 함.
    const openCount = Object.keys(state.positions).length;
    if (openCount >= state.safety_guard.max_positions) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_POSITION_CAP_STATE",
          ts: new Date().toISOString(),
          open_positions: openCount,
          max_positions: state.safety_guard.max_positions,
          open_position_symbols: Object.keys(state.positions),
          entry_universe_count: null,
          filter_pass_count: filterPassCount,
          requested_symbols: tickerRequestedSymbols.slice(0, 20),
          note: "max_positions reached; precheck loop skipped",
        }),
      );
      await persist();
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_EXIT",
          ts: new Date().toISOString(),
          stage: "after_base_entry_universe",
          reason: "max_positions_reached",
          watch_markets_count: watchMarkets.length,
          signal_map_count: signalMapCount,
          markets_with_filter_pass_count: filterPassCount,
          base_entry_universe_count: baseEntryUniverse.length,
          entry_universe_count: null,
          symbol: null,
          note: "open positions already at cap",
        }),
      );
      return;
    }
    const openStrategyMarkets = new Set(Object.keys(state.positions));
    const heldMeaningfulMarkets = new Set<string>();
    if (EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE) {
      for (const b of Array.isArray(tstatus.balances) ? tstatus.balances : []) {
        const currency = String((b as any).currency ?? "").toUpperCase();
        if (!currency || currency === "KRW") continue;
        const mk = `KRW-${currency}`;
        const qty = Number((b as any).balance ?? 0) + Number((b as any).locked ?? 0);
        const px = Number(priceBy.get(mk) ?? (b as any).avg_buy_price ?? 0);
        const valueKrw = qty > 0 && px > 0 ? qty * px : 0;
        if (valueKrw >= EXISTING_POSITION_MIN_KRW) heldMeaningfulMarkets.add(mk);
      }
    }
    /** discovery_universe: 신규 급등주 탐색/진입용. 현재 보유(holdings) 종목은 제외한다. */
    const entryUniverse = baseEntryUniverse.filter((m) => {
      if (heldSymbolSet.has(m)) return false;
      if (heldMeaningfulMarkets.has(m)) return false;
      return true;
    });

    // --- Capital allocation (weighted) ---
    const strategyUsableKrwForAlloc = Math.max(
      0,
      Number(tstatus.strategy_available_krw ?? tstatus.live_order_available_krw ?? tstatus.krw_available ?? 0),
    );
    const capitalForNewEntriesKrwBase = Math.floor(strategyUsableKrwForAlloc * (1 - LIVE_CAPITAL_BUFFER_RATIO));
    const capitalForNewEntriesKrw = Math.floor(capitalForNewEntriesKrwBase * entrySizePct);
    const maxSymbolCapRatio = 0.25;
    const maxSymbolCapKrw = Math.floor(capitalForNewEntriesKrw * maxSymbolCapRatio);
    const minOrderKrw = Math.max(UPBIT_MIN_ORDER_KRW, LIVE_MIN_ENTRY_KRW);

    const candidateMeta = entryUniverse
      .map((m) => {
        const s = latestAllSignals.get(m);
        if (!s?.p) return null;
        const gate = opts.marketState.entryGate(s.p, marketState);
        const score = Number(gate.score ?? 0);
        const tier = score >= 90 ? "A" : score >= 80 ? "B" : "C";
        const weight = tier === "A" ? 1.35 : tier === "B" ? 1.0 : 0.7;
        return { symbol: m, score, tier, weight };
      })
      .filter((x): x is { symbol: string; score: number; tier: "A" | "B" | "C"; weight: number } => Boolean(x));
    const totalWeight = candidateMeta.reduce((acc, x) => acc + x.weight, 0);
    const perPositionBudgetBySymbol = new Map<string, number>();
    if (totalWeight > 0 && capitalForNewEntriesKrw > 0) {
      for (const c of candidateMeta) {
        const raw = Math.floor(capitalForNewEntriesKrw * (c.weight / totalWeight));
        const capped = Math.min(maxSymbolCapKrw > 0 ? maxSymbolCapKrw : raw, raw);
        const clipped = Math.max(minOrderKrw, Math.min(LIVE_MAX_ENTRY_KRW, capped));
        perPositionBudgetBySymbol.set(c.symbol, clipped);
      }
    }
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_CAPITAL_POLICY",
        ts: new Date().toISOString(),
        max_positions_cap: state.safety_guard.max_positions,
        strategy_usable_krw: strategyUsableKrwForAlloc,
        capital_buffer_ratio: LIVE_CAPITAL_BUFFER_RATIO,
        capital_for_new_entries_krw: capitalForNewEntriesKrw,
        allocation_mode: "weighted",
        max_symbol_cap_ratio: maxSymbolCapRatio,
        candidate_weights: candidateMeta
          .sort((a, b) => b.score - a.score)
          .slice(0, 12)
          .map((x) => ({ symbol: x.symbol, entry_score: Number(x.score.toFixed(2)), tier: x.tier, weight: x.weight })),
        per_position_budget_krw_by_symbol: Array.from(perPositionBudgetBySymbol.entries())
          .slice(0, 12)
          .map(([symbol, krw]) => ({ symbol, per_position_budget_krw: krw })),
        open_positions: Object.keys(state.positions).length,
        remaining_slots: Math.max(0, state.safety_guard.max_positions - Object.keys(state.positions).length),
      }),
    );
    console.info(
      JSON.stringify({
        tag: "DEBUG_ENTRY_UNIVERSE_CREATED",
        ts: new Date().toISOString(),
        stage: "after_entry_universe_filter",
        held_symbols: Array.from(heldSymbolSet).slice(0, 20),
        excluded_held_symbols: baseEntryUniverse.filter((m) => heldSymbolSet.has(m)).slice(0, 20),
        markets_with_filter_pass_count: filterPassCount,
        markets_with_filter_pass_symbols: marketsWithFilterPass.slice(0, 10),
        base_entry_universe_count: baseEntryUniverse.length,
        base_entry_universe_symbols: baseEntryUniverse.slice(0, 10),
        entry_universe_count: entryUniverse.length,
        entry_universe_symbols: entryUniverse.slice(0, 5),
        dropped_symbols_with_reason: baseEntryUniverse
          .filter((m) => !entryUniverse.includes(m))
          .map((m) => ({
            symbol: m,
            reason: heldSymbolSet.has(m) ? "held" : heldMeaningfulMarkets.has(m) ? "held_meaningful" : "excluded",
          }))
          .slice(0, 20),
      }),
    );
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_STAGE_TRACE",
        ts: new Date().toISOString(),
        stage: "entry_universe_created",
        watch_markets_count: watchMarkets.length,
        signal_map_count: signalMapCount,
        entry_universe_count: entryUniverse.length,
        first_symbols: entryUniverse.slice(0, 8),
        entry_universe_symbols: entryUniverse.slice(0, 5),
        dropped_symbols_with_reason: baseEntryUniverse
          .filter((m) => !entryUniverse.includes(m))
          .map((m) => ({ symbol: m, reason: heldMeaningfulMarkets.has(m) ? "held_meaningful" : "filtered" }))
          .slice(0, 20),
      }),
    );

    if (entryUniverse.length === 0) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_EXIT",
          ts: new Date().toISOString(),
          stage: "after_entry_universe_filter",
          reason: "entry_universe_empty",
          watch_markets_count: watchMarkets.length,
          signal_map_count: signalMapCount,
          markets_with_filter_pass_count: filterPassCount,
          base_entry_universe_count: baseEntryUniverse.length,
          entry_universe_count: 0,
          symbol: null,
          note: "no symbols left for precheck loop",
        }),
      );
    }

    const accountHoldSnapshot: Record<string, { qty: number; value_krw: number; meaningful: boolean }> = {};
    for (const b of Array.isArray(tstatus.balances) ? tstatus.balances : []) {
      const currency = String((b as any).currency ?? "").toUpperCase();
      if (!currency || currency === "KRW") continue;
      const mk = `KRW-${currency}`;
      const qty = Number((b as any).balance ?? 0) + Number((b as any).locked ?? 0);
      const px = Number(priceBy.get(mk) ?? (b as any).avg_buy_price ?? 0);
      const valueKrw = qty > 0 && px > 0 ? qty * px : 0;
      accountHoldSnapshot[mk] = {
        qty,
        value_krw: Number(valueKrw.toFixed(2)),
        meaningful: valueKrw >= EXISTING_POSITION_MIN_KRW,
      };
    }

    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_ENTRY_POLICY_SNAPSHOT",
        ts: new Date().toISOString(),
        precheck_emitter_revision: LIVE_PRECHECK_EMITTER_REVISION,
        live_allow_entry_eval_on_open_strategy_symbol: LIVE_ALLOW_ENTRY_EVAL_ON_OPEN_STRATEGY_SYMBOL,
        exclude_held_symbols_from_universe: EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE,
        max_positions_cap: state.safety_guard.max_positions,
        leader_core_one_symbol_precheck_removed: true,
        exception_one_slot_precheck_removed: true,
        note: "legacy_leader_slot_and_exception_slot_count_prechecks_removed; max_positions_cooldown_pipeline_gates_remain",
      }),
    );
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_CANDIDATE_UNIVERSE",
        exclude_held_symbols_from_universe: EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE,
        live_allow_entry_eval_on_open_strategy_symbol: LIVE_ALLOW_ENTRY_EVAL_ON_OPEN_STRATEGY_SYMBOL,
        exclude_held_resolved_by:
          parseEnvBoolExplicit(process.env.LIVE_EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE) !== null
            ? "LIVE_EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE"
            : parseEnvBoolExplicit(process.env.DEBUG_EXCLUDE_HELD_SYMBOLS) !== null
              ? "DEBUG_EXCLUDE_HELD_SYMBOLS"
              : "default_false",
        debug_exclude_held_symbols_legacy_env:
          process.env.DEBUG_EXCLUDE_HELD_SYMBOLS !== undefined && process.env.DEBUG_EXCLUDE_HELD_SYMBOLS !== "",
        live_exclude_held_env_set:
          process.env.LIVE_EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE !== undefined &&
          process.env.LIVE_EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE !== "",
        strategy_open_markets: [...openStrategyMarkets],
        strategy_open_excluded_from_universe: [],
        exchange_meaningful_hold_markets_removed_from_universe: [...heldMeaningfulMarkets],
        account_hold_snapshot_by_market: accountHoldSnapshot,
        debug_include_universe_markets_env: DEBUG_INCLUDE_UNIVERSE_MARKETS,
        debug_include_universe_markets_resolved: debugUniverseExtra,
        entry_universe: entryUniverse,
      }),
    );

    // 매 틱 1회 — 후보 생성/선정 요약 및 0건 원인 집계.
    const skippedByReason: Record<string, number> = {};
    const bumpSkip = (reason: string) => {
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
    };
    let scannedCount = 0;
    let candidateCount = 0;
    let selectedCount = 0;
    const topCandidates: Array<{ market: string; score: number; vol: number; breakout: boolean }> = [];

    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_STAGE_TRACE",
        ts: new Date().toISOString(),
        stage: "before_entry_universe_loop",
        watch_markets_count: watchMarkets.length,
        signal_map_count: signalMapCount,
        entry_universe_count: entryUniverse.length,
        first_symbols: entryUniverse.slice(0, 8),
      }),
    );

    for (const market of entryUniverse) {
      if (scannedCount === 0) {
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_STAGE_TRACE",
            ts: new Date().toISOString(),
            stage: "entered_entry_universe_loop",
            watch_markets_count: watchMarkets.length,
            signal_map_count: signalMapCount,
            entry_universe_count: entryUniverse.length,
            first_symbols: entryUniverse.slice(0, 8),
          }),
        );
      }
      scannedCount += 1;
      let lateEntrySizingMultiplier = 1;
      const emitEval = (tag: string, payload: Record<string, unknown>) => {
        console.info(
          JSON.stringify({
            tag,
            symbol: market,
            ts: new Date().toISOString(),
            ...payload,
          }),
        );
      };

      // precheck 루프 진입 강제 로그 (이게 없으면 entryUniverse가 비었거나 루프 전에서 끊긴 것)
      const sigPre = latestAllSignals.get(market);
      const gatePre = sigPre ? opts.marketState.entryGate(sigPre.p, marketState) : null;
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_PRECHECK_ENTER",
          ts: new Date().toISOString(),
          stage: "precheck_enter",
          symbol: market,
          entry_score: gatePre ? Number(gatePre.score ?? 0) : null,
          market_state: marketState.market_state,
          position_exists: Boolean(state.positions[market]),
          open_positions: Object.keys(state.positions).length,
          max_positions: state.safety_guard.max_positions,
        }),
      );
      const acctSnap = accountHoldSnapshot[market];
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_SYMBOL_EVAL_START",
          symbol: market,
          ts: new Date().toISOString(),
          live_allow_entry_eval_on_open_strategy_symbol: LIVE_ALLOW_ENTRY_EVAL_ON_OPEN_STRATEGY_SYMBOL,
          open_strategy_positions_count: Object.keys(state.positions).length,
          strategy_position_exists: Boolean(state.positions[market]),
          account_existing_qty: acctSnap?.qty ?? 0,
          account_existing_value_krw: acctSnap?.value_krw ?? 0,
          account_meaningful_hold: acctSnap?.meaningful ?? false,
          entry_universe_includes_symbol: true,
        }),
      );
      if (Object.keys(state.positions).length >= state.safety_guard.max_positions) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "max_positions_reached" });
        bumpSkip("max_positions_reached");
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_EARLY_EXIT",
            ts: new Date().toISOString(),
            stage: "inside_precheck_loop",
            reason: "break:max_positions_reached",
            watch_markets_count: watchMarkets.length,
            signal_map_count: signalMapCount,
            markets_with_filter_pass_count: filterPassCount,
            base_entry_universe_count: baseEntryUniverse.length,
            entry_universe_count: entryUniverse.length,
            symbol: market,
            note: "break from loop due to max positions cap",
          }),
        );
        break;
      }

      // (moved to top of loop) keep only one PRECHECK_ENTER per symbol
      if (state.positions[market]) {
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: "same_symbol_open_continue_entry_eval",
          precheck_domain: "strategy_state",
          strategy_position_exists: true,
          blocks_entry: false,
          note: "open_strategy_position_does_not_skip_pipeline_or_order_attempt",
        });
      }
      const cool = state.cooldown_until[market];
      if (cool && Date.now() < Date.parse(cool)) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "cooldown_active", cooldown_until: cool });
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_REENTRY_BLOCKED",
            ts: new Date().toISOString(),
            symbol: market,
            cooldown_until: cool,
            seconds_remaining: Math.max(0, Math.floor((Date.parse(cool) - Date.now()) / 1000)),
            prior_exit_reason: null,
          }),
        );
        if (LIVE_EARLY_ENTRY_ENABLED) {
          const scoreCd = gatePre ? Number(gatePre.score ?? 0) : null;
          const vrCd = sigPre ? Number(sigPre.p.volume_ratio ?? 0) : null;
          const momCd = sigPre
            ? Number((sigPre.p as any).momentum_3m_pct ?? (sigPre.p as any).price_change_3m_pct ?? 0)
            : null;
          console.info(
            JSON.stringify({
              tag: "DEBUG_LIVE_EARLY_CANDIDATE",
              ts: new Date().toISOString(),
              symbol: market,
              score: scoreCd,
              volume_ratio: vrCd,
              price_position: null,
              ema_gap: null,
              momentum: momCd,
              market_state: marketState.market_state,
            }),
          );
          console.info(
            JSON.stringify({
              tag: "DEBUG_LIVE_EARLY_ENTRY_DECISION",
              ts: new Date().toISOString(),
              symbol: market,
              decision: "block",
              block_reason: "cooldown_active",
              block_reason_detail: `cooldown_until:${cool}`,
              timing_state: "late",
              volume_state: "alive",
              position_state: state.positions[market] ? "holding" : "empty",
            }),
          );
          console.info(
            JSON.stringify({
              tag: "DEBUG_LIVE_ENTRY_SUMMARY",
              ts: new Date().toISOString(),
              symbol: market,
              line: `${market} | early_candidate=yes | decision=block | reason=cooldown_active | score=${scoreCd === null ? "na" : Math.round(scoreCd)} | vr=${vrCd === null ? "na" : Number(vrCd).toFixed(2)}`,
            }),
          );
        }
        bumpSkip("cooldown_active");
        continue;
      }
      if ((state.daily.stop_by_market[market] ?? 0) >= 2) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "stop_count_limit_reached" });
        bumpSkip("stop_count_limit_reached");
        continue;
      }
      const isExceptionMarket = !LEADER_MARKETS.has(market);
      const sig = latestAllSignals.get(market);
      if (!sig) {
        const missingDetail = buildLiveSignalMissingDetail(market, logs);
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_SIGNAL_MISSING_DETAIL",
            symbol: market,
            ...missingDetail,
          }),
        );
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: String(missingDetail.primary_reason ?? "signal_missing"),
          signal_missing_detail: true,
        });
        bumpSkip(String(missingDetail.primary_reason ?? "signal_missing"));
        continue;
      }
      const exception = state.regime?.exception_candidates.find((x) => x.market === market) ?? null;
      const rawStrength = signalStrengthScore(sig.p);
      if (rawStrength >= ENTRY_PIPELINE_MID_SCORE_FLOOR) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "candidate_detected",
          payload: {
            symbol: market,
            signal_strength_score: rawStrength,
            filter_pass: Boolean(sig.p.filter_pass),
          },
        });
        emitEval("candidate_detected", {
          signal_strength_score: rawStrength,
          filter_pass: Boolean(sig.p.filter_pass),
        });
      }
      if (rawStrength < ENTRY_PIPELINE_MID_SCORE_FLOOR) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "blocked_low_signal",
          payload: { symbol: market, signal_strength_score: rawStrength, floor: ENTRY_PIPELINE_MID_SCORE_FLOOR },
        });
        emitEval("blocked_low_signal", { signal_strength_score: rawStrength });
        continue;
      }
      if (marketState.market_state === "risk_off") {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "entry_skipped_risk_off",
          payload: { symbol: market, market_state: marketState.market_state, note: "no_exception_entries" },
        });
        emitEval("entry_skipped_risk_off", { symbol: market, market_state: marketState.market_state });
        continue;
      }

      // Late-entry diagnostics & guard (entry timing)
      const signalTs = typeof sig.ts === "string" ? sig.ts : null;
      const signalTsMs = signalTs ? Date.parse(signalTs) : NaN;
      const nowMs = Date.now();
      const secondsSinceSignal = Number.isFinite(signalTsMs) ? Math.max(0, Math.floor((nowMs - signalTsMs) / 1000)) : null;
      const currentPrice = Number(priceBy.get(market) ?? 0);
      // Approximate signal price by nearest minute candle close at/before signal timestamp.
      let signalPriceApprox: number | null = null;
      let recent1mRet: number | null = null;
      let recent3mRet: number | null = null;
      let recent5mRet: number | null = null;
      let localHigh: number | null = null;
      let distanceFromLocalHighPct: number | null = null;
      let priceChangeSinceSignalPct: number | null = null;
      let volumeFadeTriggered = false;
      let volumeRatio1m5: number | null = null;
      try {
        // Small window; used for timing guard + high proximity.
        const c1 = await fetchMinuteCandles(market, 1, 12);
        const closes = c1.map((x: any) => Number(x.trade_price ?? 0)).filter((n: number) => Number.isFinite(n) && n > 0);
        const highs = c1.map((x: any) => Number(x.high_price ?? 0)).filter((n: number) => Number.isFinite(n) && n > 0);
        if (highs.length > 0) localHigh = Math.max(...highs);
        if (localHigh && currentPrice > 0) distanceFromLocalHighPct = ((localHigh - currentPrice) / localHigh) * 100;
        if (closes.length >= 2) recent1mRet = ((closes[closes.length - 1] / closes[closes.length - 2]) - 1) * 100;
        if (closes.length >= 4) recent3mRet = ((closes[closes.length - 1] / closes[closes.length - 4]) - 1) * 100;
        if (closes.length >= 6) recent5mRet = ((closes[closes.length - 1] / closes[closes.length - 6]) - 1) * 100;

        if (Number.isFinite(signalTsMs)) {
          // candle timestamp is `candle_date_time_utc` in upbit response (string ISO-ish). fall back other keys.
          let best: { t: number; px: number } | null = null;
          for (const x of c1 as any[]) {
            const tRaw = String((x as any).candle_date_time_utc ?? (x as any).candle_date_time_kst ?? "");
            const t = Date.parse(tRaw);
            const px = Number((x as any).trade_price ?? 0);
            if (!Number.isFinite(t) || !(px > 0)) continue;
            if (t <= signalTsMs && (!best || t > best.t)) best = { t, px };
          }
          if (best) signalPriceApprox = best.px;
          if (signalPriceApprox && currentPrice > 0) priceChangeSinceSignalPct = ((currentPrice / signalPriceApprox) - 1) * 100;
        }

        // Volume fade heuristic: latest notional vs avg previous 5 notional.
        if (c1.length >= 7) {
          const last = c1[c1.length - 1] as any;
          const prev5 = c1.slice(-6, -1) as any[];
          const lastNotional = Number(last.candle_acc_trade_volume ?? 0) * Number(last.trade_price ?? 0);
          const prevAvg =
            prev5.reduce((acc, r) => acc + Number(r.candle_acc_trade_volume ?? 0) * Number(r.trade_price ?? 0), 0) /
            Math.max(1, prev5.length);
          if (Number.isFinite(lastNotional) && Number.isFinite(prevAvg) && prevAvg > 0) {
            volumeRatio1m5 = lastNotional / prevAvg;
            volumeFadeTriggered = volumeRatio1m5 < 0.65;
          }
        }
      } catch {
        // candle fetch failures shouldn't block entry evaluation; guard will fall back to null fields.
      }

      const gateTiming = opts.marketState.entryGate(sig.p, marketState);
      const score = Number(gateTiming.score ?? 0);
      const volumeRatio = Number(sig.p.volume_ratio ?? 0);
      const btcTierNow = state.regime?.btc_filter_state ?? "neutral";

      const stdBlockReason = (raw: string | null): string => {
        if (!raw) return "base_gate_failed";
        const s = raw.toLowerCase();
        if (s === "cooldown_active" || s.includes("cooldown")) return "cooldown_active";
        if (s.includes("volume_fade")) return "volume_faded";
        if (s.includes("too_near_local_high") || s.includes("near_high")) return "near_high_entry";
        if (s.includes("signal_stale") || s.includes("stale") || s.includes("timing")) return "timing_late";
        if (s.includes("risk_off")) return "market_risk_off";
        if (s.includes("duplicate_symbol") || s.includes("position") || s.includes("already")) return "position_exists";
        if (s.includes("signal_missing")) return "signal_missing";
        if (s.includes("gate")) return "base_gate_failed";
        return "base_gate_failed";
      };

      const timingState: "early" | "mid" | "late" =
        secondsSinceSignal === null
          ? "late"
          : secondsSinceSignal <= LIVE_EARLY_ENTRY_MAX_SIGNAL_SECONDS
            ? "early"
            : secondsSinceSignal <= (btcTierNow === "weak" ? Math.min(LIVE_ENTRY_SIGNAL_STALE_SECONDS, 180) : LIVE_ENTRY_SIGNAL_STALE_SECONDS)
              ? "mid"
              : "late";
      const volumeState: "alive" | "faded" = volumeFadeTriggered || (volumeRatio1m5 !== null && volumeRatio1m5 < 0.65) ? "faded" : "alive";
      const positionState: "empty" | "holding" = state.positions[market] ? "holding" : "empty";

      // ① EARLY 후보 포착 — “초입 후보까지는 왔다” 확인용 (candidate → decision → summary 연결의 시작점)
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_CANDIDATE",
          ts: new Date().toISOString(),
          symbol: market,
          score,
          volume_ratio: volumeRatio1m5 ?? volumeRatio,
          price_position: distanceFromLocalHighPct,
          ema_gap: null,
          momentum: Number((sig.p as any).momentum_3m_pct ?? (sig.p as any).price_change_3m_pct ?? 0),
          market_state: marketState.market_state,
        }),
      );

      let lateEntryGuardTriggered = false;
      let lateEntryGuardReason: string | null = null;
      let lateTimingTier: "pass" | "hard_block" | "reduced_size_allowed" = "pass";
      const staleLimit = btcTierNow === "weak" ? Math.min(LIVE_ENTRY_SIGNAL_STALE_SECONDS, 180) : LIVE_ENTRY_SIGNAL_STALE_SECONDS;
      const chaseLimit = btcTierNow === "weak" ? LIVE_WEAK_MARKET_MAX_CHASE_PCT : LIVE_MAX_CHASE_FROM_SIGNAL_PCT;
      const chaseSoftCap = chaseLimit * LIVE_LATE_ENTRY_SOFT_CHASE_FRAC;
      // risk_off 는 위에서 continue 되어 이 지점에서는 market_state 가 risk_on | neutral 로 좁혀짐.
      const softContextForMicroGuard =
        score >= LIVE_LATE_ENTRY_SOFT_MIN_SCORE &&
        secondsSinceSignal !== null &&
        secondsSinceSignal <= LIVE_LATE_ENTRY_SOFT_MAX_SIGNAL_SEC &&
        (priceChangeSinceSignalPct === null || priceChangeSinceSignalPct <= chaseSoftCap);

      if (secondsSinceSignal !== null && secondsSinceSignal > staleLimit) {
        lateEntryGuardTriggered = true;
        lateTimingTier = "hard_block";
        lateEntryGuardReason = `signal_stale:${secondsSinceSignal}s>${staleLimit}s`;
      } else if (priceChangeSinceSignalPct !== null && priceChangeSinceSignalPct > chaseLimit) {
        lateEntryGuardTriggered = true;
        lateTimingTier = "hard_block";
        lateEntryGuardReason = `chase_from_signal:${priceChangeSinceSignalPct.toFixed(3)}pct>${chaseLimit}pct`;
      } else {
        const nearHighProblem =
          distanceFromLocalHighPct !== null && distanceFromLocalHighPct < LIVE_MAX_ENTRY_NEAR_HIGH_PCT;
        const volFadeProblem =
          volumeFadeTriggered || (volumeRatio1m5 !== null && volumeRatio1m5 < 0.65);
        if (nearHighProblem) {
          const severeNearHigh =
            distanceFromLocalHighPct !== null && distanceFromLocalHighPct < LIVE_LATE_ENTRY_NEAR_HIGH_HARD_PCT;
          if (severeNearHigh || !softContextForMicroGuard) {
            lateEntryGuardTriggered = true;
            lateTimingTier = "hard_block";
            lateEntryGuardReason = `too_near_local_high:${distanceFromLocalHighPct!.toFixed(3)}pct<${LIVE_MAX_ENTRY_NEAR_HIGH_PCT}pct`;
          } else {
            lateTimingTier = "reduced_size_allowed";
            lateEntrySizingMultiplier *= LIVE_LATE_ENTRY_SOFT_SIZE_MULT_NEAR_HIGH;
            lateEntryGuardReason = `too_near_local_high_soft:${distanceFromLocalHighPct!.toFixed(3)}pct<${LIVE_MAX_ENTRY_NEAR_HIGH_PCT}pct`;
          }
        }
        if (!lateEntryGuardTriggered && volFadeProblem) {
          const severeVol = volumeRatio1m5 !== null && volumeRatio1m5 < LIVE_LATE_ENTRY_VOLUME_HARD_RATIO;
          if (severeVol || !softContextForMicroGuard) {
            lateEntryGuardTriggered = true;
            lateTimingTier = "hard_block";
            lateEntryGuardReason =
              volumeRatio1m5 !== null
                ? `volume_fade_after_spike:${volumeRatio1m5.toFixed(3)}<0.65`
                : "volume_fade_after_spike";
          } else {
            lateTimingTier = "reduced_size_allowed";
            lateEntrySizingMultiplier *= LIVE_LATE_ENTRY_SOFT_SIZE_MULT_VOL_FADE;
            const vr = volumeRatio1m5 !== null ? volumeRatio1m5.toFixed(3) : "na";
            lateEntryGuardReason =
              lateEntryGuardReason !== null
                ? `${lateEntryGuardReason}|volume_fade_after_spike_soft:${vr}`
                : `volume_fade_after_spike_soft:${vr}`;
          }
        }
      }

      let entryAllowedByTiming = !lateEntryGuardTriggered;
      if (btcTierNow === "weak") {
        if (score < LIVE_WEAK_MARKET_MIN_SCORE) {
          entryAllowedByTiming = false;
          lateEntryGuardTriggered = true;
          lateTimingTier = "hard_block";
          lateEntrySizingMultiplier = 1;
          lateEntryGuardReason = `weak_market_min_score:${score.toFixed(2)}<${LIVE_WEAK_MARKET_MIN_SCORE}`;
        } else if (volumeRatio > 0 && volumeRatio < LIVE_WEAK_MARKET_MIN_VOLUME_RATIO) {
          entryAllowedByTiming = false;
          lateEntryGuardTriggered = true;
          lateTimingTier = "hard_block";
          lateEntrySizingMultiplier = 1;
          lateEntryGuardReason = `weak_market_min_volume_ratio:${volumeRatio.toFixed(3)}<${LIVE_WEAK_MARKET_MIN_VOLUME_RATIO}`;
        }
      }

      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_LATE_ENTRY_GUARD_RESULT",
          ts: new Date().toISOString(),
          symbol: market,
          late_timing_tier: lateTimingTier,
          late_entry_hard_block: lateEntryGuardTriggered,
          late_entry_sizing_multiplier: Number(lateEntrySizingMultiplier.toFixed(4)),
          late_entry_guard_reason: lateEntryGuardReason,
          soft_context_ok: softContextForMicroGuard,
          seconds_since_signal: secondsSinceSignal,
          price_change_since_signal_pct: priceChangeSinceSignalPct,
          distance_from_local_high_pct: distanceFromLocalHighPct,
          volume_ratio_1m5: volumeRatio1m5,
        }),
      );

      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_ENTRY_DECISION",
          ts: new Date().toISOString(),
          symbol: market,
          market_state: marketState.market_state,
          btc_tier: btcTierNow,
          score,
          entry_allowed: entryAllowedByTiming,
          entry_block_reason: entryAllowedByTiming ? null : lateEntryGuardReason,
          late_timing_tier: lateTimingTier,
          late_entry_sizing_multiplier: Number(lateEntrySizingMultiplier.toFixed(4)),
          current_price: currentPrice,
          signal_price: signalPriceApprox,
          signal_ts: signalTs,
          seconds_since_signal: secondsSinceSignal,
          price_change_since_signal_pct: priceChangeSinceSignalPct,
          recent_1m_return_pct: recent1mRet,
          recent_3m_return_pct: recent3mRet,
          recent_5m_return_pct: recent5mRet,
          distance_from_recent_breakout_pct: null,
          distance_from_local_high_pct: distanceFromLocalHighPct,
          volume_ratio: volumeRatio,
          volume_ratio_1m5: volumeRatio1m5,
          late_entry_guard_triggered: lateEntryGuardTriggered,
          late_entry_guard_reason: lateEntryGuardReason,
        }),
      );

      // Early entry decision (additional scout slot; does not modify normal entry path)
      if (LIVE_EARLY_ENTRY_ENABLED) {
        const earlySlotsUsed = Object.keys(state.early_positions).length;
        const secondsFreshOk = secondsSinceSignal !== null && secondsSinceSignal <= LIVE_EARLY_ENTRY_MAX_SIGNAL_SECONDS;
        const nearHighOk = distanceFromLocalHighPct !== null && distanceFromLocalHighPct <= LIVE_EARLY_ENTRY_NEAR_HIGH_PCT;
        const volOk = volumeRatio1m5 !== null && volumeRatio1m5 >= LIVE_EARLY_ENTRY_MIN_VOLUME_RATIO;
        const earlyMinScoreDefault = Math.max(0, marketState.min_entry_score - 7);
        const earlyMinScore = (() => {
          const raw = process.env.LIVE_EARLY_ENTRY_MIN_SCORE;
          const n = raw === undefined || raw === "" ? earlyMinScoreDefault : Number(raw);
          return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : earlyMinScoreDefault;
        })();
        const scoreOk = score >= earlyMinScore;
        const notAlready = !state.positions[market] && !state.early_positions[market];
        const earlySlotOk = earlySlotsUsed < LIVE_EARLY_ENTRY_MAX_OPEN;
        const weakTier = btcTierNow === "weak";
        const weakOk = !weakTier || (score >= LIVE_WEAK_MARKET_MIN_SCORE && (volumeRatio1m5 ?? 0) >= Math.max(LIVE_EARLY_ENTRY_MIN_VOLUME_RATIO, 1.45));

        const earlyAllowed =
          notAlready && earlySlotOk && weakOk && secondsFreshOk && nearHighOk && volOk && scoreOk && currentPrice > 0 && localHigh !== null;
        const rawEarlyReason = !notAlready
          ? "position_exists"
          : !earlySlotOk
            ? "base_gate_failed"
            : !weakOk
              ? "market_risk_off"
              : !secondsFreshOk
                ? "timing_late"
                : !nearHighOk
                  ? "near_high_entry"
                  : !volOk
                    ? "volume_faded"
                    : !scoreOk
                      ? "base_gate_failed"
                      : currentPrice <= 0
                        ? "base_gate_failed"
                        : "none";
        const earlyDecision = earlyAllowed ? "enter" : "block";
        const earlyBlockReason = earlyAllowed ? null : stdBlockReason(rawEarlyReason);

        // ② 최종 진입 직전 상태 (early)
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_EARLY_ENTRY_DECISION",
            ts: new Date().toISOString(),
            symbol: market,
            decision: earlyDecision,
            block_reason: earlyBlockReason,
            block_reason_detail: earlyAllowed ? null : rawEarlyReason,
            timing_state: timingState,
            volume_state: volumeState,
            position_state: positionState,
          }),
        );

        // ③ 최종 요약(한 줄)
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_ENTRY_SUMMARY",
            ts: new Date().toISOString(),
            symbol: market,
            line: `${market} | early_candidate=yes | decision=${earlyDecision} | reason=${earlyAllowed ? "none" : earlyBlockReason} | score=${Math.round(
              score,
            )} | vr=${Number((volumeRatio1m5 ?? volumeRatio) || 0).toFixed(2)}`,
          }),
        );

        if (earlyAllowed) {
          const minOrderKrw = Math.max(UPBIT_MIN_ORDER_KRW, LIVE_MIN_ENTRY_KRW);
          const baseBudget = perPositionBudgetBySymbol.get(market) ?? minOrderKrw;
          const earlyOrderKrw = Math.max(UPBIT_MIN_ORDER_KRW, Math.floor(baseBudget * LIVE_EARLY_ENTRY_SIZE_RATIO));
          try {
            await opts.trade.placeBuy(market, true, earlyOrderKrw, "momentum", "strategy", {
              ...sig.p,
              __early_entry: true,
              __early_entry_size_ratio: LIVE_EARLY_ENTRY_SIZE_RATIO,
            });
            const stEarly = await opts.trade.status();
            const currency = market.replace("KRW-", "");
            const bEarly = stEarly.balances?.find((x: any) => x.currency === currency);
            const qtyEarly = Number(bEarly?.balance ?? 0) + Number(bEarly?.locked ?? 0);
            state.early_positions[market] = {
              market,
              entry_ts: new Date().toISOString(),
              entry_price: currentPrice,
              qty: qtyEarly,
              order_krw: earlyOrderKrw,
              signal_ts: signalTs,
              signal_strength: sig.p.signal_type ?? "MID",
              entry_recent_high: Number(localHigh ?? currentPrice),
              entry_volume_ratio_1m5: Number(volumeRatio1m5 ?? 0),
              promoted: false,
            };
            console.info(
              JSON.stringify({
                tag: "DEBUG_LIVE_EARLY_ENTRY_FILLED",
                ts: new Date().toISOString(),
                symbol: market,
                near_high_pct: distanceFromLocalHighPct,
                volume_ratio: volumeRatio1m5,
                seconds_since_signal: secondsSinceSignal,
                early_entry_allowed: true,
                early_entry_reason: "filled",
                size_ratio: LIVE_EARLY_ENTRY_SIZE_RATIO,
                order_krw: earlyOrderKrw,
                filled_qty: qtyEarly,
                filled_price: currentPrice,
              }),
            );
            bumpSkip("early_entry_filled");
            continue; // do not run normal entry in same tick for same symbol
          } catch {
            // fall through to normal path; early is best-effort scout slot
          }
        }
      }

      if (!entryAllowedByTiming) {
        const reasonStd = stdBlockReason(lateEntryGuardReason);
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_ENTRY_SUMMARY",
            ts: new Date().toISOString(),
            symbol: market,
            line: `${market} | early_candidate=yes | decision=block | reason=${reasonStd} | score=${Math.round(score)} | vr=${Number(
              (volumeRatio1m5 ?? volumeRatio) || 0,
            ).toFixed(2)}`,
          }),
        );
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_ENTRY_TIMING_GUARD",
            ts: new Date().toISOString(),
            symbol: market,
            block_reason: reasonStd,
            late_entry_guard_triggered: true,
            late_entry_guard_reason: lateEntryGuardReason,
            seconds_since_signal: secondsSinceSignal,
            price_change_since_signal_pct: priceChangeSinceSignalPct,
            distance_from_local_high_pct: distanceFromLocalHighPct,
            volume_fade_triggered: volumeFadeTriggered,
            btc_tier: btcTierNow,
          }),
        );
        bumpSkip("late_entry_guard");
        continue;
      }
      const sigTypeUpper = (sig.p.signal_type ?? "").toUpperCase();
      if (sigTypeUpper === "LOW") {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "entry_blocked_signal_strength",
          payload: { symbol: market, signal_type: sigTypeUpper, reason: "LOW_never_enters" },
        });
        emitEval("entry_blocked_signal_strength", { symbol: market, signal_type: "LOW" });
        continue;
      }
      if (sigTypeUpper === "MID") {
        const gatePrev = opts.marketState.entryGate(sig.p, marketState);
        const composite = Number(gatePrev.score ?? 0);
        if (rawStrength < LIVE_ENTRY_SIGNAL_GATES.mid_min_raw_strength_score || composite < LIVE_ENTRY_SIGNAL_GATES.mid_min_entry_gate_score) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: "entry_blocked_signal_strength",
            payload: {
              symbol: market,
              signal_type: "MID",
              raw_strength: rawStrength,
              composite_score: composite,
              need_raw_gte: LIVE_ENTRY_SIGNAL_GATES.mid_min_raw_strength_score,
              need_composite_gte: LIVE_ENTRY_SIGNAL_GATES.mid_min_entry_gate_score,
            },
          });
          emitEval("entry_blocked_signal_strength", {
            symbol: market,
            signal_type: "MID",
            raw_strength: rawStrength,
            composite_score: composite,
          });
          continue;
        }
      }
      const filterPass = Boolean(sig.p.filter_pass);
      const signalTypeLow = (sig.p.signal_type ?? "").toUpperCase() === "LOW";
      const gate = opts.marketState.entryGate(sig.p, marketState);
      const baseGateOriginalResult = Boolean(gate.ok);
      const gateOk = DEBUG_FORCE_BASE_GATE ? true : baseGateOriginalResult;
      const signalScore = Number(gate.score ?? 0);
      const rel = (Number(changeRateBy.get(market) ?? 0) - btcChange) * 100;
      const vol = Number(sig.p.volume_ratio ?? 0);
      const reasonText = String(sig.p.signal_reason ?? "").toLowerCase();
      const parsedV2 = mvpSignalPayloadV2Schema.safeParse(sig.p);
      const breakoutRelaxed =
        parsedV2.success &&
        (Boolean(parsedV2.data.would_pass_with_breakout_relaxed_a) ||
          Boolean(parsedV2.data.would_pass_with_breakout_relaxed_b) ||
          Boolean(parsedV2.data.breakout_relaxed_a_pass) ||
          Boolean(parsedV2.data.breakout_relaxed_b_pass) ||
          Boolean(parsedV2.data.pair_pass_breakout_b_and_pullback_relaxed) ||
          Boolean(parsedV2.data.pair_pass_breakout_b_and_vol_close_a));
      const breakout = reasonText.includes("breakout") || breakoutRelaxed;
      const trendOk = reasonText.includes("breakout") || reasonText.includes("trend") || reasonText.includes("reclaim");
      const openForGate = Object.keys(state.positions).length;
      const minBaseScore = openForGate >= 1 ? 88 : 83;
      const minBaseVol = openForGate >= 1 ? 1.14 : 1.08;
      const earlySurgeOk = !breakout && trendOk && vol >= 1.25 && signalScore >= (openForGate >= 1 ? 84 : 80);
      emitEval("DEBUG_LIVE_SIGNAL_SCORE", {
        score: Number(signalScore.toFixed(2)),
        volume_ratio: Number(vol.toFixed(3)),
        relative_strength: Number(rel.toFixed(3)),
        trend_ok: trendOk,
        breakout,
        breakout_relaxed: breakoutRelaxed,
        early_surge_ok: earlySurgeOk,
      });
      const strongSymbolOverride = signalScore >= 80 && rel >= 0.5 && vol >= 1.05 && trendOk;
      let detailedReason: string | null = null;
      if (!gateOk) {
        if (signalTypeLow || signalScore < minBaseScore) detailedReason = "score_below_threshold";
        else if (vol < minBaseVol) detailedReason = "volume_ratio_low";
        else if (!trendOk) detailedReason = "trend_not_ok";
        else if (!breakout && !earlySurgeOk) detailedReason = "no_breakout";
        else if (!filterPass || !baseGateOriginalResult) detailedReason = "base_gate_failed";
      }
      emitEval("DEBUG_LIVE_BASE_GATE_RESULT", {
        score: Number(signalScore.toFixed(2)),
        volume_ratio: Number(vol.toFixed(3)),
        relative_strength: Number(rel.toFixed(3)),
        trend_ok: trendOk,
        breakout,
        breakout_relaxed: breakoutRelaxed,
        early_surge_ok: earlySurgeOk,
        filter_pass: filterPass,
        signal_type: sig.p.signal_type ?? "MID",
        base_gate_ok: gateOk,
        base_gate_original_result: baseGateOriginalResult,
        base_gate_forced: DEBUG_FORCE_BASE_GATE,
        strong_symbol_override: strongSymbolOverride,
        return_reason: !gateOk && !strongSymbolOverride ? detailedReason ?? "base_gate_failed" : null,
      });
      if (!detailedReason) {
        candidateCount += 1;
        topCandidates.push({ market, score: signalScore, vol, breakout });
        if (candidateCount <= 2) {
          console.info(
            JSON.stringify({
              tag: "DEBUG_LIVE_CANDIDATE_TRACE",
              ts: new Date().toISOString(),
              symbol: market,
              score: Number(signalScore.toFixed(2)),
              filter_pass: filterPass,
              breakout,
              skipped_reason: null,
            }),
          );
        }
      } else {
        bumpSkip(detailedReason);
        if (candidateCount === 0 && scannedCount <= 2) {
          console.info(
            JSON.stringify({
              tag: "DEBUG_LIVE_CANDIDATE_TRACE",
              ts: new Date().toISOString(),
              symbol: market,
              score: Number(signalScore.toFixed(2)),
              filter_pass: filterPass,
              breakout,
              skipped_reason: detailedReason,
            }),
          );
        }
      }
      await appendLog({
        company_id: companyIdSchema.parse(opts.companyId),
        service_id: serviceIdSchema.parse(opts.serviceId),
        ts: new Date().toISOString(),
        kind: "system",
        message: "DEBUG_STRONG_CHECK",
        payload: {
          symbol: market,
          volume_ratio: Number(vol.toFixed(3)),
          score: Number(signalScore.toFixed(2)),
          btc_state: btcTier,
          relative_strength: Number(rel.toFixed(3)),
          trend_ok: trendOk,
          gate_ok: gateOk,
          base_gate_original_result: baseGateOriginalResult,
          base_gate_forced: DEBUG_FORCE_BASE_GATE,
          strong_symbol_override: strongSymbolOverride,
        },
      });
      if (isExceptionMarket && !exception) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "exception_not_selected" });
        bumpSkip("exception_not_selected");
        continue;
      }
      if (!gateOk && !strongSymbolOverride) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: detailedReason ?? "base_gate_failed" });
        bumpSkip(detailedReason ?? "base_gate_failed");
        continue;
      }

      let entryPipelineDetail: Record<string, unknown> = {};
      try {
        const candles5 = await fetchMinuteCandles(market, 5, 48);
        const pr = evaluateSpotLongEntryPipeline({
          market,
          payload: sig.p,
          candles5,
          marketState: {
            market_state: marketState.market_state,
            btc_5m_trend: marketState.btc_5m_trend ?? "flat",
            btc_15m_trend: marketState.btc_15m_trend ?? "flat",
          },
          volumeRatio: vol,
        });
        if (!pr.ok) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: pr.message,
            payload: pr.detail,
          });
          emitEval(pr.message, pr.detail);
          emitEval("DEBUG_LIVE_DECISION_LINE", {
            available_krw: Number((await opts.trade.status()).live_order_available_krw ?? 0),
            planned_entry_krw: null,
            entry_score: Number(signalScore.toFixed(2)),
            min_entry_score: marketState.min_entry_score,
            volume_ratio: Number(vol.toFixed(3)),
            breakout,
            breakout_relaxed: breakoutRelaxed,
            final_block_reason: pr.message,
          });
          bumpSkip(pr.message);
          continue;
        }
        entryPipelineDetail = pr.detail;
      } catch (e) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "blocked_trend_filter",
          payload: {
            symbol: market,
            sub: "candles_fetch_failed",
            error: String(e).slice(0, 400),
          },
        });
        emitEval("blocked_trend_filter", { symbol: market, sub: "candles_fetch_failed" });
        emitEval("DEBUG_LIVE_DECISION_LINE", {
          available_krw: Number((await opts.trade.status()).live_order_available_krw ?? 0),
          planned_entry_krw: null,
          entry_score: Number(signalScore.toFixed(2)),
          min_entry_score: marketState.min_entry_score,
          volume_ratio: Number(vol.toFixed(3)),
          breakout,
          breakout_relaxed: breakoutRelaxed,
          final_block_reason: "candles_fetch_failed",
        });
        bumpSkip("candles_fetch_failed");
        continue;
      }

      const st = await opts.trade.status();
      const currency = market.replace("KRW-", "");
      const bExist = st.balances?.find((x: any) => x.currency === currency);
      const existingQty = Number(bExist?.balance ?? 0) + Number(bExist?.locked ?? 0);
      const markPrice = Number(priceBy.get(market) ?? 0);
      const existingValueKrw = existingQty > 0 && markPrice > 0 ? existingQty * markPrice : 0;
      const meaningfulExistingHold = existingValueKrw >= EXISTING_POSITION_MIN_KRW;
      emitEval("DEBUG_LIVE_EXCHANGE_HOLD_INFO", {
        precheck_domain: "exchange_account",
        account_existing_qty: existingQty,
        account_existing_value_krw: Number(existingValueKrw.toFixed(2)),
        meaningful_exchange_hold: meaningfulExistingHold,
        existing_position_min_krw: EXISTING_POSITION_MIN_KRW,
        strategy_position_exists: Boolean(state.positions[market]),
        blocks_entry: false,
        note: "exchange_hold_does_not_block_strategy_entry_eval",
      });
    const liveOrderAvailableKrw = Math.max(0, Number(st.live_order_available_krw ?? st.krw_available ?? 0));
      const openCountNow = Object.keys(state.positions).length;
      const remainingSlots = Math.max(0, state.safety_guard.max_positions - openCountNow);
      const maxAllocKrw = Math.floor(liveOrderAvailableKrw * LIVE_ENTRY_UTILIZATION_TARGET * entrySizePct);
      const baseBudget = perPositionBudgetBySymbol.get(market) ?? minOrderKrw;
      let orderKrw = Math.max(minOrderKrw, Math.min(LIVE_MAX_ENTRY_KRW, baseBudget));
      if (isExceptionMarket) orderKrw = Math.floor(orderKrw * 0.9);
      if (lateEntrySizingMultiplier < 1 - 1e-9) {
        orderKrw = Math.max(minOrderKrw, Math.floor(orderKrw * lateEntrySizingMultiplier));
      }

      const stPos = st.strategy_positions?.[market];
      const investedSoFar = Math.max(0, Number(stPos?.invested_krw_total ?? 0));
      const remainingPerMarket = Math.max(0, ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET - investedSoFar);
      orderKrw = Math.min(orderKrw, remainingPerMarket);

      const gateScore = Number(opts.marketState.entryGate(sig.p, marketState).score ?? 0);
      emitEval("DEBUG_LIVE_ORDER_SIZING", {
        available_krw: liveOrderAvailableKrw,
        max_alloc_krw: maxAllocKrw,
        planned_entry_krw: orderKrw,
        late_entry_sizing_multiplier: lateEntrySizingMultiplier,
        min_entry_krw: minOrderKrw,
        max_entry_krw: LIVE_MAX_ENTRY_KRW,
        allocation_mode: "weighted",
        allocation_weight: candidateMeta.find((c) => c.symbol === market)?.weight ?? null,
        allocation_tier: candidateMeta.find((c) => c.symbol === market)?.tier ?? null,
        per_position_budget_krw: baseBudget,
        max_symbol_cap_ratio: 0.25,
        per_market_cap_krw: ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET,
        per_market_remaining_krw: remainingPerMarket,
        entry_score: gateScore,
        min_entry_score: marketState.min_entry_score,
        entry_size_pct: entrySizePct,
        legacy_dca_buy_enabled: LIVE_LEGACY_DCA_BUY_ENABLED,
      });
      if (orderKrw < 5000) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "order_krw_below_min", order_krw: orderKrw });
        bumpSkip("order_krw_below_min");
        continue;
      }
      if (liveOrderAvailableKrw < orderKrw) {
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: "insufficient_live_order_krw",
          live_order_available_krw: liveOrderAvailableKrw,
          order_krw: orderKrw,
        });
        bumpSkip("insufficient_live_order_krw");
        continue;
      }
      const strategyType: StrategyType = marketState.market_state === "risk_on" ? "momentum" : "stable";
      const signalPayloadForBuy = {
        ...sig.p,
        __allow_risk_scaled_entry: true,
        __strong_symbol_override: strongSymbolOverride,
        __risk_off_exception_reason: exception?.reason,
      };
      try {
        await opts.trade.placeBuy(market, true, orderKrw, strategyType, "strategy", signalPayloadForBuy);
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "entry_opened",
          payload: {
            symbol: market,
            order_krw: orderKrw,
            strategy_type: strategyType,
            entry_pipeline: entryPipelineDetail,
          },
        });
        emitEval("entry_opened", { symbol: market, order_krw: orderKrw });
        selectedCount += 1;
      } catch (e) {
        state.safety_guard.order_fail_count_today += 1;
        if (state.safety_guard.order_fail_count_today >= 3) {
          state.safety_guard.state = "자동정지";
          state.safety_guard.reason = "order_failures";
          await opts.trade.setAutoTradeEnabled?.(false);
          await opts.onEvent?.({
            timestamp: new Date().toISOString(),
            event_type: "safety_guard_stopped",
            market,
            strategy_type: strategyType,
            market_state: marketState.market_state,
            side: "buy",
            reason: "order_failures",
            balance_krw: Number(st.krw_available ?? 0),
            position_qty: null,
            avg_buy_price: null,
            current_price: null,
            pnl_net: null,
            pnl_net_pct: null,
            note: e instanceof Error ? e.message : "buy_failed",
          });
        }
        await persist();
        bumpSkip("order_failed");
        continue;
      }
      const price = priceBy.get(market) ?? 0;
      const st2 = await opts.trade.status();
      const bFill = st2.balances?.find((x: any) => x.currency === currency);
      const qty = Number(bFill?.balance ?? 0) + Number(bFill?.locked ?? 0);
      const strategyPositionExistsBefore = Boolean(state.positions[market]);
      state.positions[market] = {
        market,
        strategy_type: strategyType,
        entry_ts: new Date().toISOString(),
        entry_price: price,
        qty,
        order_krw: orderKrw,
        reason_enter: exception
          ? `exception_slot_entry:${exception.reason}`
          : entrySizePct < 1
            ? `${sig.p.signal_reason ?? "signal_pass"}:btc_risk_scaled_${entrySizePct}`
            : sig.p.signal_reason ?? "signal_pass",
        signal_strength: sig.p.signal_type ?? "MID",
        volume_ratio: Number(sig.p.volume_ratio ?? 0),
        position_stage: "normal_active",
        partial_tp_done: false,
        max_pnl_pct: 0,
        min_pnl_pct: 0,
        breakeven_armed: false,
        highest_price_after_entry: price,
        trailing_stop_price: 0,
        realized_partial_profit: 0,
        remaining_qty: qty,
        current_net_pnl_pct: 0,
        breakeven_armed_at: null,
        partial_tp_at: null,
        strict_exit: true,
      };
      state.daily.entry_count += 1;
      state.cooldown_until[market] = new Date(Date.now() + (isExceptionMarket ? 28 : 18) * 60_000).toISOString();
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_BUY_FILLED",
          ts: new Date().toISOString(),
          symbol: market,
          order_krw: orderKrw,
          filled_qty: qty,
          filled_price: price,
          strategy_position_exists_before: strategyPositionExistsBefore,
          open_positions_after: Object.keys(state.positions).length,
          reason: state.positions[market]?.reason_enter ?? null,
        }),
      );
      state.trades.push({
        timestamp: new Date().toISOString(),
        entry_ts: new Date().toISOString(),
        market,
        action: "buy",
        order_krw: orderKrw,
        filled_qty: qty,
        avg_buy_price: price,
        exit_price: null,
        pnl_krw: 0,
        pnl_pct: 0,
        reason_enter: sig.p.signal_reason ?? "signal_pass",
        reason_exit: "",
        holding_minutes: 0,
        signal_strength: sig.p.signal_type ?? "MID",
        volume_ratio: Number(sig.p.volume_ratio ?? 0),
        strategy_tag: "live_data_mode_v1",
        strategy_type: strategyType,
        stop_trigger_kind: null,
        current_net_pnl_pct: 0,
        liquidation_reason: "",
        remaining_qty: qty,
        highest_price_after_entry: price,
        trailing_stop_price: 0,
        breakeven_armed_at: null,
        partial_tp_at: null,
      });
      await opts.onEvent?.({
        timestamp: new Date().toISOString(),
        event_type: "order_filled",
        market,
        strategy_type: strategyType,
        market_state: marketState.market_state,
        side: "buy",
        reason: exception ? exception.reason : sig.p.signal_reason ?? "signal_pass",
        balance_krw: Number(st2.krw_available ?? 0),
        position_qty: qty,
        avg_buy_price: price,
        current_price: price,
        pnl_net: 0,
        pnl_net_pct: 0,
        note: [
          "strategy entry",
          `btc_risk_scaled:${entrySizePct}`,
          strongSymbolOverride ? "strong_symbol_override" : null,
          exception ? "selective_entry_allowed" : null,
        ]
          .filter(Boolean)
          .join("|"),
      });
    }

    topCandidates.sort((a, b) => b.score - a.score || b.vol - a.vol);
    const topSymbols = topCandidates
      .slice(0, 8)
      .map((x) => `${x.market}:${x.score.toFixed(1)}:vr_${x.vol.toFixed(2)}${x.breakout ? ":br" : ""}`);
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_CANDIDATE_SUMMARY",
        ts: new Date().toISOString(),
        universe_count: entryUniverse.length,
        scanned_count: scannedCount,
        candidate_count: candidateCount,
        selected_count: selectedCount,
        skipped_by_reason: skippedByReason,
        top_symbols: topSymbols,
      }),
    );
    if (candidateCount === 0) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EMPTY_CANDIDATES",
          ts: new Date().toISOString(),
          no_watchlist: entryUniverse.length === 0,
          no_signal: Boolean(skippedByReason["not_in_signal_monitor_logs"] ?? 0) || signalMapCount === 0,
          no_filter_pass: filterPassCount === 0,
          rate_limited:
            Boolean(skippedByReason["candles_fetch_failed"] ?? 0) ||
            Boolean(skippedByReason["volume_filter_failed"] ?? 0),
          no_breakout: Boolean(skippedByReason["no_breakout"] ?? 0),
          market_state_block: marketState.market_state === "risk_off",
          max_positions_reached: Boolean(skippedByReason["max_positions_reached"] ?? 0),
          skipped_by_reason: skippedByReason,
        }),
      );
    }
    await persist();
    } catch (e) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_TICK_ERROR",
          ts: new Date().toISOString(),
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? String(e.stack ?? "").slice(0, 800) : null,
        }),
      );
    }
  };

  return {
    init: restore,
    tick: runTick,
    status: summarize,
    files: { tradesFile, dailyFile },
  };
}

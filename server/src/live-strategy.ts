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
import { fetchMinuteCandles, fetchTickers, partitionKrwMarketsByUpbitValidity, type UpbitCandle } from "./upbit-public.js";
import { LogDeduper } from "./log-deduper.js";
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
import {
  ENTRY_PIPELINE_MID_SCORE_FLOOR,
  evaluateSpotLongEntryPipeline,
} from "./live-entry-pipeline.js";
import { readJsonFile } from "./runtime-file-io.js";
import { surgeCandidatesRuntimePath } from "./runtime-paths.js";
import {
  isSurgePosition,
  evaluateSurgeEntryPipeline,
  evaluateSurgeExit,
} from "./surge-v2/index.js";

function num(x: unknown): number {
  return typeof x === "number" ? x : Number(x);
}

function emaLast(closes: readonly number[], period: number): number | null {
  // 250 -> 200 대응: EMA 200 계산 시 180개 이상이면 허용 (A안)
  if (closes.length < Math.min(period, 180)) return null;
  const k = 2 / (period + 1);
  let e = closes[0]!;
  for (let i = 1; i < closes.length; i++) e = closes[i]! * k + e * (1 - k);
  return e;
}

function mean(values: number[]): number {
  const xs = values.filter((n) => Number.isFinite(n));
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}


type UpbitBalance = {
  currency: string;
  balance: string | number;
  locked: string | number;
  avg_buy_price: string | number;
};

type TradeStatus = {
  auto_trade_enabled: boolean;
  api_connected: boolean;
  live_enabled: boolean;
  balances: UpbitBalance[];
  ledger_reconcile?: { zeroed: string[]; clamped: string[] } | null;
  strategy_positions?: Record<string, { qty: number; invested_krw_total?: number }>;
  legacy_positions?: { market: string; qty: number }[] | Record<string, { market: string; qty: number }>;
  krw_available?: number;
  live_order_available_krw?: number;
  strategy_available_krw?: number;
};

type SignalPayloadV2 = {
  market: string;
  signal_type?: string;
  signal_reason?: string;
  volume_ratio?: number;
  filters?: { id: string; passed: boolean }[];
  momentum_3m_pct?: number;
  price_change_3m_pct?: number;
  [key: string]: unknown;
};

type ScannerFeedSignal = {
  market?: string;
  score?: number;
  signal_key?: string;
  reason?: string;
  volume_multiple?: number;
  captured_at?: string | null;
  updated_at?: string | null;
  signal_ts?: string | null;
  [key: string]: unknown;
};

type TradeApi = {
  status: () => Promise<TradeStatus>;
  placeBuy: (
    market: string,
    confirm: boolean,
    amountKrw?: number,
    strategyType?: StrategyType,
    bucket?: "strategy" | "legacy",
    signalPayload?: unknown,
  ) => Promise<{ ok?: boolean; reason?: string } | Record<string, unknown>>;
  placeSell: (market: string, confirm: boolean, ratio?: number) => Promise<{ ok?: boolean; reason?: string } | Record<string, unknown>>;
  placeLegacyDcaBuy?: (market: string, confirm: boolean, amountKrw?: number, signalPayload?: unknown) => Promise<{ ok?: boolean; reason?: string } | Record<string, unknown>>;
  placeLegacyExitSell?: (market: string, confirm: boolean, ratio?: number) => Promise<{ ok?: boolean; reason?: string } | Record<string, unknown>>;
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
  entry_origin?: "auto_trade" | "external";
  entry_mode?: "SURGE_V2" | "CORE";
  market_state_at_entry?: "risk_on" | "neutral" | "risk_off";
  btc_tier_at_entry?: "strong" | "neutral" | "weak";
  volatility_pct_at_entry?: number;
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
  position_id?: string;
  entry_profile_key?: string;
  entry_profile_decision?: "allow" | "block" | "unknown";
  target_budget_krw?: number;
  filled_entry_krw?: number;
  /** Original Setup fields */
  original_setup_mode?: OriginalSetupMode;
  original_setup_reason?: string;
  entry_stop_price?: number;
  entry_target_price?: number;
  entry_risk_reward?: number;
  entry_candle_low?: number;
  previous_swing_low?: number;
  ema50?: number;
  ema200?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  volumeRatio?: number;
  engine_bucket?: "surge" | "core" | "legacy";
  is_relaxed_probe?: boolean;
  softened_reasons?: string[];
};

type EarlyEntryPosition = {
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  order_krw: number;
  signal_ts: string | null;
  signal_strength: string;
  entry_origin?: "auto_trade" | "external";
  entry_mode?: "SURGE_V2" | "CORE";
  market_state_at_entry?: "risk_on" | "neutral" | "risk_off";
  btc_tier_at_entry?: "strong" | "neutral" | "weak";
  volatility_pct_at_entry?: number;
  /** early entry 당시 최근 로컬 고점(돌파 기준) */
  entry_recent_high: number;
  /** early entry 당시 volume ratio(1m notional / prev5 avg) */
  entry_volume_ratio_1m5: number;
  /** 승격 여부(정상 포지션으로 이동 완료) */
  promoted: boolean;
  position_stage?: "early_candidate" | "early_active" | "normal_active" | "scaled_out_partial" | "cooldown" | "closed";
  /** 진입 시 설정된 전체 목표 예산 (normal 승격 시 이 금액까지 채움) */
  target_budget_krw?: number;
  /** 실제 체결된 금액 (수수료 제외 순수 매수액) */
  filled_entry_krw?: number;
  /** Original Setup fields */
  original_setup_mode?: OriginalSetupMode;
  original_setup_reason?: string;
  entry_stop_price?: number;
  entry_target_price?: number;
  entry_risk_reward?: number;
  entry_candle_low?: number;
  previous_swing_low?: number;
  ema50?: number;
  ema200?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  volumeRatio?: number;
  engine_bucket?: "surge" | "core" | "legacy";
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
  position_id?: string;
  entry_profile_key?: string;
  entry_profile_decision?: "allow" | "block" | "unknown";
  target_budget_krw?: number;
  filled_entry_krw?: number;
  exit_reason_detail?: string;
  exit_authority_class?: string;
  partial_tp_done?: boolean;
  breakeven_armed?: boolean;
  runner_trail_active?: boolean;
  realized_partial_profit?: number;
  final_net_pnl_pct?: number;
  /** Original Setup fields */
  original_setup_mode?: OriginalSetupMode;
  original_setup_reason?: string;
  entry_stop_price?: number;
  entry_target_price?: number;
  entry_risk_reward?: number;
  stochK?: number;
  stochD?: number;
  rsi?: number;
  ema50?: number;
  ema200?: number;
  volumeRatio?: number;
};

type OriginalSetupMode = "safe" | "aggressive" | "none" | "relaxed_probe";
type OriginalSpotSetupResult = {
  ok: boolean;
  mode: OriginalSetupMode;
  reason: string;
  stopPrice?: number;
  targetPrice?: number;
  riskReward?: number;
  candleLow?: number;
  swingLow?: number;
  ema50?: number;
  ema200?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  volumeRatio?: number;
  effective_volume_threshold?: number;
  volume_relaxed_applied?: boolean;
  // Detailed flags
  safePriceAboveEma200?: boolean;
  pullbackToEma200?: boolean;
  stochOversoldBullishCross?: boolean;
  isBullish?: boolean;
  safe_condition_pass?: boolean;
  aggressiveEmaStack?: boolean;
  aggressivePriceAbove?: boolean;
  aggressiveRsiOk?: boolean;
  aggressiveVolumeOk?: boolean;
  aggressiveRiskRewardOk?: boolean;
  aggressive_condition_pass?: boolean;
  failed_conditions?: string[];
  /** CORE_TREND_ENTRY 전용 — original aggressive_* 의미와 분리 */
  stoch_assist_pass?: boolean;
  stoch_assist_score?: number;
  core_trend_entry_pass?: boolean;
  core_trend_reject_reason?: string | null;
};

type CandidateMeta = {
  market: string;
  score: number;
  tier: EntryQualityTier;
  setupMode: OriginalSetupMode;
  riskReward: number;
  setupReason: string;
  stopPrice: number;
  targetPrice: number;
  candleLow: number;
  swingLow: number;
  candle_source?: "live_fetch" | "last_good_cache";
  candle_cache_age_ms?: number | null;
  ema50?: number;
  ema200?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  volumeRatio?: number;
  setup?: OriginalSpotSetupResult;
  paper_profile_key?: string;
  paper_pattern_multiplier?: number;
  risk_tag_multiplier?: number;
  engine_bucket?: "surge" | "other";
  surge_shadow_setup?: SurgeEntrySetupResult;
  is_core_relaxed_candidate?: boolean;
  is_relaxed_probe?: boolean;
  softened_reasons?: string[];
  relaxed_multiplier?: number;
  gate_ok?: boolean;
  gate_reason?: string;
  real_signal_present: boolean;
  is_fresh_signal?: boolean;
  is_watch_candidate?: boolean;
};

type SurgeEntrySetupResult = {
  ok: boolean;
  score: number;
  grade: string;
  reason: string;
  failed_conditions?: string[];
  ema50?: number;
  ema200?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  volumeRatio?: number;
  stopPrice?: number;
  targetPrice?: number;
  riskReward?: number;
  priceAboveEma20?: boolean;
  highReclaim?: boolean;
  overextended?: boolean;
  wickOk?: boolean;
  rrOk?: boolean;
  probe_allowed?: boolean;
};

type PaperSurgePatternStats = {
  profile_key: string;
  sample_count: number;
  profit_count?: number;
  win_count: number;
  loss_count: number;
  fast_profit_count?: number;
  target_tp_count?: number;
  partial_tp_count?: number;
  runner_profit_count?: number;
  volume_hold_profit_count?: number;
  clean_candle_profit_count?: number;
  profile_unknown_profit_count?: number;
  early_entry_profit_count?: number;
  avg_profit_pnl_pct?: number;
  avg_profit_holding_minutes?: number;
  stop_loss_count?: number;
  surge_stop_loss_count?: number;
  timeout_loss_count?: number;
  failed_spike_count?: number;
  volume_fade_loss_count?: number;
  high_rejected_loss_count?: number;
  profile_unknown_loss_count?: number;
  early_entry_loss_count?: number;
  chase_loss_count?: number;
  avg_loss_pnl_pct?: number;
  avg_loss_holding_minutes?: number;
  win_rate: number;
  avg_pnl_pct: number;
  avg_3m_pnl_pct?: number;
  avg_5m_pnl_pct?: number;
  fast_profit_rate?: number;
  target_tp_rate?: number;
  surge_stop_loss_rate?: number;
  timeout_loss_rate?: number;
  failed_spike_rate?: number;
  volume_fade_loss_rate?: number;
  high_rejected_loss_rate?: number;
  profile_unknown_loss_rate?: number;
  early_entry_loss_rate?: number;
  chase_loss_rate?: number;
  suggested_size_multiplier: number;
  suggested_entry_speed?: "fast" | "normal" | "slow" | "avoid";
  confidence: "low" | "medium" | "high";
  updated_at: string;
};

type EntryQualityTier = "A" | "B" | "C";
type EntryQuality = {
  tier: EntryQualityTier;
  score: number;
  earlyEligible: boolean;
};

type LiveEntryProfileFeatures = {
  signal_type: string;
  position_stage: "early_active" | "normal_active";
  btc_tier: "strong" | "neutral" | "weak";
  score_bucket: "0-69" | "70-79" | "80-89" | "90+";
  volume_ratio_bucket: "<1.2" | "1.2-1.49" | "1.5-1.99" | "2.0+";
  signal_age_bucket: "<=10s" | "11-30s" | "31-60s" | ">60s";
  chase_bucket: "<=0.2" | "0.21-0.5" | "0.51-1.0" | ">1.0";
  near_high_bucket: "<=0.1" | "0.11-0.25" | "0.26-0.5" | ">0.5";
  breakout: boolean;
  early_entry_flag: boolean;
};

type LiveEntryProfileStats = {
  total_trades: number;
  wins: number;
  losses: number;
  weak_stops: number;
  timeouts: number;
  total_net_pnl_pct: number;
  total_net_pnl_krw: number;
  avg_net_pnl_pct: number;
  win_rate: number;
  recent_net_pnl_pct: number[];
  last_updated_at: string;
};

type ExitAuthorityDecision = {
  reasonExit: string | null;
  ratio: number;
  stopTriggerKind: StopTriggerKind | null;
  authorityClass: "emergency_exit" | "hard_loss" | "partial_take_profit" | "breakeven_protect" | "runner_trail" | "weak_time_stop" | "micro_loss_guard" | "none";
  reasonDetail: string;
  runnerTrailActive: boolean;
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
  entry_profile_stats?: Record<string, LiveEntryProfileStats>;
  coarse_profile_stats?: Record<string, LiveEntryProfileStats>;
  fine_profile_stats?: Record<string, LiveEntryProfileStats>;
};

const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"] as const;
const LEADER_MARKETS = new Set<string>(MARKETS as unknown as string[]);
/** 코어 현물: original 반등형 대신 CORE_TREND_ENTRY(추세 지속·소액 probe) 경로 후보 */
const CORE_TREND_ENTRY_MARKETS = new Set<string>(MARKETS as unknown as string[]);
/** BTC/ETH/XRP/TRX 에는 composite 게이트 우회(strong_symbol_override) 적용 금지 */
const NO_STRONG_SYMBOL_OVERRIDE_MARKETS = new Set<string>(["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"]);
/** candle_fetch_timeout 반복 시 last_good cache fallback 허용 대상(주문 예외 아님; 캔들만 제한적으로 대체) */
const CORE_MAJOR_MARKETS = new Set<string>(["KRW-BTC", "KRW-ETH"]);

const LIVE_CORE_ENTRY_RESERVE_SLOTS = (() => {
  const raw = process.env.LIVE_CORE_ENTRY_RESERVE_SLOTS;
  const n = raw === undefined || raw === "" ? 2 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, Math.floor(n))) : 2;
})();

const LIVE_LAST_GOOD_CANDLE_MAX_AGE_MS = (() => {
  const raw = process.env.LIVE_LAST_GOOD_CANDLE_MAX_AGE_MS;
  const n = raw === undefined || raw === "" ? 120_000 : Number(raw);
  return Number.isFinite(n) ? Math.max(30_000, Math.min(10 * 60_000, Math.floor(n))) : 120_000;
})();

const LIVE_CANDIDATE_CANDLE_FETCH_CONCURRENCY = (() => {
  const raw = process.env.LIVE_CANDIDATE_CANDLE_FETCH_CONCURRENCY;
  const n = raw === undefined || raw === "" ? 2 : Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(3, Math.floor(n))) : 2;
})();

const LIVE_CANDIDATE_CANDLE_FETCH_TIMEOUT_MS = (() => {
  const raw = process.env.LIVE_CANDIDATE_CANDLE_FETCH_TIMEOUT_MS;
  const n = raw === undefined || raw === "" ? 9_000 : Number(raw);
  // Keep this short to avoid holding the whole tick; candidate_meta can drop per-market.
  return Number.isFinite(n) ? Math.max(3_000, Math.min(15_000, Math.floor(n))) : 9_000;
})();

type LastGoodCandleCacheRow = {
  ts_ms: number;
  rows: UpbitCandle[];
  unit: 1 | 5;
  count: number;
};
const lastGoodMinuteCandleCache = new Map<string, LastGoodCandleCacheRow>();
const EXISTING_POSITION_MIN_KRW = Math.max(
  1000,
  Number(process.env.LIVE_EXISTING_POSITION_MIN_KRW ?? 5000),
);
const SURGE_LIVE_CAPITAL_RATIO = 0.5;
const SURGE_MAX_OPEN_POSITIONS = 3;
const SURGE_MIN_ORDER_RATIO = 0.08;
const SURGE_NORMAL_ORDER_RATIO = 0.15;
const SURGE_HIGH_CONFIDENCE_ORDER_RATIO = 0.30;

async function loadPaperSurgePatternStats(companyId: string, serviceId: string): Promise<Record<string, PaperSurgePatternStats>> {
  try {
    const paperStatePath = path.join(tradingDataRoot(), "paper", companyId, serviceId, "paper_state.json");
    const raw = await fs.readFile(paperStatePath, "utf8");
    const parsed = JSON.parse(raw) as { paper_surge_pattern_stats?: PaperSurgePatternStats[] };
    const rows = Array.isArray(parsed.paper_surge_pattern_stats) ? parsed.paper_surge_pattern_stats : [];
    const map: Record<string, PaperSurgePatternStats> = {};
    for (const row of rows) {
      if (!row?.profile_key) continue;
      map[row.profile_key] = row;
    }
    return map;
  } catch (e) {
    return {};
  }
}

/** runTick 내부 `await` 구간별 상한 — 운영에서 env로 조정 가능. */
const LIVE_TICK_PHASE_MS = {
  trade_status: Number(process.env.LIVE_TICK_PHASE_MS_TRADE_STATUS ?? 25_000),
  persist: Number(process.env.LIVE_TICK_PHASE_MS_PERSIST ?? 15_000),
  read_logs: Number(process.env.LIVE_TICK_PHASE_MS_READ_LOGS ?? 25_000),
  market_state: Number(process.env.LIVE_TICK_PHASE_MS_MARKET_STATE ?? 45_000),
  partition_validity: Number(process.env.LIVE_TICK_PHASE_MS_PARTITION ?? 35_000),
  fetch_tickers: Number(process.env.LIVE_TICK_PHASE_MS_FETCH_TICKERS ?? 75_000),
  fetch_minute_candles: Number(process.env.LIVE_TICK_PHASE_MS_FETCH_CANDLES ?? 30_000),
  paper_stats: Number(process.env.LIVE_TICK_PHASE_MS_PAPER_STATS ?? 20_000),
  candidate_meta_parallel: Number(process.env.LIVE_TICK_PHASE_MS_CANDIDATE_META ?? 240_000),
} as const;

/** 단일 틱 전체 상한(개별 phase 타임아웃이 빠진 await 방지). */
const LIVE_TICK_HARD_WALL_MS = Math.max(120_000, Number(process.env.LIVE_TICK_HARD_WALL_MS ?? 600_000));

class LiveTickPhaseTimeoutError extends Error {
  readonly phase: string;
  readonly timeout_ms: number;
  constructor(phase: string, timeout_ms: number) {
    super(`LIVE_TICK_PHASE_TIMEOUT:${phase}`);
    this.name = "LiveTickPhaseTimeoutError";
    this.phase = phase;
    this.timeout_ms = timeout_ms;
  }
}

function isLiveTickPhaseTimeout(err: unknown): err is LiveTickPhaseTimeoutError {
  return err instanceof LiveTickPhaseTimeoutError;
}

async function liveTickRacePhase<T>(
  ctx: { phase: string; tick_lease: number; timeout_ms: number },
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  console.info(
    JSON.stringify({
      tag: "LIVE_TICK_PHASE_ENTER",
      ts: new Date().toISOString(),
      phase: ctx.phase,
      tick_lease: ctx.tick_lease,
      timeout_ms: ctx.timeout_ms,
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LiveTickPhaseTimeoutError(ctx.phase, ctx.timeout_ms)), ctx.timeout_ms);
  });
  try {
    const result = await Promise.race([fn(), timeoutP]);
    console.info(
      JSON.stringify({
        tag: "LIVE_TICK_PHASE_EXIT",
        ts: new Date().toISOString(),
        phase: ctx.phase,
        tick_lease: ctx.tick_lease,
        elapsed_ms: Date.now() - t0,
        outcome: "ok",
      }),
    );
    return result;
  } catch (e) {
    console.info(
      JSON.stringify({
        tag: "LIVE_TICK_PHASE_EXIT",
        ts: new Date().toISOString(),
        phase: ctx.phase,
        tick_lease: ctx.tick_lease,
        elapsed_ms: Date.now() - t0,
        outcome: isLiveTickPhaseTimeout(e) ? "timeout" : "error",
        error: e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240),
      }),
    );
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEBUG_FORCE_BASE_GATE = String(process.env.DEBUG_FORCE_BASE_GATE ?? "").toLowerCase() === "true";
/** 운영에서 `DEBUG_LIVE_ENTRY_POLICY_SNAPSHOT`으로 dist 빌드 정합성 확인. 2=동일심볼은 same_symbol_open_continue_entry_eval 만(레거시 차단 문자열 없음). */
const LIVE_PRECHECK_EMITTER_REVISION = 2;
/** 운영에서 dist 실행 코드가 최신인지 확인용(로그에 항상 포함). */
const LIVE_STRATEGY_TRACE_REVISION = 8;
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
const LIVE_ENTRY_UNIVERSE_TOP_N = (() => {
  const raw = process.env.LIVE_ENTRY_UNIVERSE_TOP_N;
  const n = raw === undefined || raw === "" ? 5 : Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(12, Math.floor(n))) : 5;
})();
/** CORE_TREND_ENTRY 전용 소액 probe 배수 (기존 relaxed_probe 0.35와 별도) */
const LIVE_CORE_TREND_PROBE_MULTIPLIER = (() => {
  const raw = process.env.LIVE_CORE_TREND_PROBE_MULTIPLIER;
  const n = raw === undefined || raw === "" ? 0.22 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.08, Math.min(0.4, n)) : 0.22;
})();
const LIVE_CORE_TREND_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.LIVE_CORE_TREND_MIN_VOLUME_RATIO;
  const n = raw === undefined || raw === "" ? 1.02 : Number(raw);
  return Number.isFinite(n) ? Math.max(1.0, Math.min(2.5, n)) : 1.02;
})();

// CORE_TREND_ENTRY major-only volume relax (keep global default unchanged).
const LIVE_CORE_TREND_MAJOR_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.LIVE_CORE_TREND_MAJOR_MIN_VOLUME_RATIO;
  const n = raw === undefined || raw === "" ? 0.78 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.65, Math.min(1.02, n)) : 0.78;
})();

/** volume relax 적용 대상은 메이저 5종으로 고정 (CORE_TREND_ENTRY_MARKETS 확장 시에도 안전) */
const CORE_TREND_VOLUME_RELAX_MARKETS = new Set<string>(["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"]);
const LIVE_CORE_TREND_RSI_CAP = (() => {
  const raw = process.env.LIVE_CORE_TREND_RSI_CAP;
  const n = raw === undefined || raw === "" ? 72 : Number(raw);
  return Number.isFinite(n) ? Math.max(60, Math.min(85, Math.floor(n))) : 72;
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
  return Number.isFinite(n) ? Math.max(0.1, Math.min(0.8, n)) : 0.25;
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
  const n = raw === undefined || raw === "" ? 0.25 : Number(raw);
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
const RISK_OFF_ENTRY_SCALE = 0.5;

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

function resolveFreshestIsoTs(candidates: Array<string | null | undefined>): string | null {
  let bestMs = -1;
  for (const c of candidates) {
    if (typeof c !== "string" || !c) continue;
    const ms = Date.parse(c);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) bestMs = ms;
  }
  return bestMs > 0 ? new Date(bestMs).toISOString() : null;
}

type SurgeCandidatesShadowFile = {
  kind?: string;
  updated_at?: string;
  items?: Array<Record<string, unknown>>;
};

function loadSurgeCandidatesShadow() {
  const p = surgeCandidatesRuntimePath();
  const j = readJsonFile<SurgeCandidatesShadowFile>(p);
  const updated_at = j && typeof j.updated_at === "string" ? j.updated_at : null;
  const raw = Array.isArray(j?.items) ? j!.items! : [];
  const items = raw
    .map((r) => {
      const market = typeof r.market === "string" ? r.market : "";
      if (!market.startsWith("KRW-")) return null;
      const scannerScoreRaw = typeof r.scanner_score === "number" ? r.scanner_score : Number(r.scanner_score ?? 0);
      const volRaw =
        typeof r.volume_multiple === "number"
          ? r.volume_multiple
          : typeof r.volume_ratio === "number"
            ? r.volume_ratio
            : Number(r.volume_multiple ?? r.volume_ratio ?? 0);
      const scanner_score = Number.isFinite(scannerScoreRaw) ? scannerScoreRaw : 0;
      const volume_multiple = Number.isFinite(volRaw) ? volRaw : 0;
      const filter_pass = Boolean(r.breakout) && Boolean(r.close_upper_hold);
      const signal_ts = typeof r.signal_ts === "string" ? r.signal_ts : null;
      const source_kind = typeof r.source_kind === "string" ? r.source_kind : "engine2_surge_scanner";
      const age_seconds =
        signal_ts && Number.isFinite(Date.parse(signal_ts))
          ? Math.max(0, Math.floor((Date.now() - Date.parse(signal_ts)) / 1000))
          : null;
      return { market, scanner_score, volume_multiple, filter_pass, signal_ts, source_kind, age_seconds };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  return { updated_at, items, path: p };
}

function scannerSignalTimestamp(sig: ScannerFeedSignal): string | null {
  const fromKey = (() => {
    const key = typeof sig.signal_key === "string" ? sig.signal_key : "";
    if (!key) return null;
    const parts = key.split("|");
    return typeof parts[1] === "string" ? parts[1] : null;
  })();
  const preferred = resolveFreshestIsoTs([
    typeof sig.updated_at === "string" ? sig.updated_at : null,
    typeof sig.signal_ts === "string" ? sig.signal_ts : null,
  ]);
  if (preferred) return preferred;
  return resolveFreshestIsoTs([
    typeof sig.captured_at === "string" ? sig.captured_at : null,
    fromKey,
  ]);
}

function signalCandidateTimestamp(sig: { ts?: string | null; p?: Record<string, unknown> } | null | undefined): string | null {
  const p = (sig?.p ?? {}) as Record<string, unknown>;
  const preferred = resolveFreshestIsoTs([
    typeof p.updated_at === "string" ? p.updated_at : null,
    typeof p.signal_ts === "string" ? p.signal_ts : null,
  ]);
  if (preferred) return preferred;
  return resolveFreshestIsoTs([
    typeof p.captured_at === "string" ? p.captured_at : null,
    typeof sig?.ts === "string" ? sig.ts : null,
  ]);
}

function clampScore(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function computeScannerBridgeScore(params: {
  scannerScore: number;
  volumeMultiple: number;
  breakout: boolean;
  closeUpperHold: boolean;
  rise3mPct: number;
  ageSeconds: number | null;
  staleThresholdSeconds: number;
}): {
  signalStrengthScore: number;
  liveEntryScore: number;
  pass: boolean;
  reason: string;
} {
  const scannerBase = clampScore(params.scannerScore, 0, 100);
  const scoreFromScanner = scannerBase * 0.58;
  const scoreFromVolume = clampScore((params.volumeMultiple - 1) * 26, 0, 18);
  const scoreFromBreakout = params.breakout ? 12 : 0;
  const scoreFromHold = params.closeUpperHold ? 8 : 0;
  const scoreFromRise = clampScore(params.rise3mPct * 5, 0, 14);
  const agePenalty = params.ageSeconds !== null && params.ageSeconds > params.staleThresholdSeconds
    ? clampScore((params.ageSeconds - params.staleThresholdSeconds) * 0.18, 0, 20)
    : 0;

  const liveEntryScore = clampScore(
    scoreFromScanner + scoreFromVolume + scoreFromBreakout + scoreFromHold + scoreFromRise - agePenalty,
    0,
    100,
  );
  const signalStrengthScore = clampScore(Math.round(liveEntryScore), 0, 100);
  const pass = signalStrengthScore >= ENTRY_PIPELINE_MID_SCORE_FLOOR;
  const reason = pass
    ? "scanner_bridge_score_ok"
    : agePenalty > 0
      ? "scanner_bridge_low_after_age_penalty"
      : "scanner_bridge_low_signal";

  return {
    signalStrengthScore,
    liveEntryScore,
    pass,
    reason,
  };
}

/**
 * 원형 매매법 1차 필터 (Original Spot Scalping Setup)
 */
function calculateRsi(closes: number[], period: number): number[] {
  if (closes.length <= period) return [];
  const rsi: number[] = [];
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-9));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-9));
  }
  return rsi;
}

function calculateStochRsi(rsi: number[], period: number, kSmoothing: number, dSmoothing: number): { k: number[]; d: number[] } {
  if (rsi.length < period + kSmoothing + dSmoothing) return { k: [], d: [] };
  const stochRsi: (number | null)[] = rsi.map((_, i) => {
    if (i < period) return null;
    const window = rsi.slice(i - period + 1, i + 1).filter(v => v !== undefined);
    const min = Math.min(...window);
    const max = Math.max(...window);
    return max === min ? 0 : (rsi[i]! - min) / (max - min);
  });

  const k: number[] = [];
  for (let i = 0; i < stochRsi.length; i++) {
    if (i < period + kSmoothing - 1) continue;
    const window = stochRsi.slice(i - kSmoothing + 1, i + 1).filter((v): v is number => v !== null);
    if (window.length === kSmoothing) {
      k[i] = (window.reduce((a, b) => a + b, 0) / kSmoothing) * 100;
    }
  }

  const d: number[] = [];
  for (let i = 0; i < k.length; i++) {
    if (i < period + kSmoothing + dSmoothing - 2 || k[i] === undefined) continue;
    const window = k.slice(i - dSmoothing + 1, i + 1).filter(v => v !== undefined);
    if (window.length === dSmoothing) {
      d[i] = window.reduce((a, b) => a + b, 0) / dSmoothing;
    }
  }
  return { k, d };
}

function evaluateOriginalSpotScalpingSetup(
  market: string,
  candles1: UpbitCandle[],
  currentPrice: number,
): OriginalSpotSetupResult {
  // 250 -> 200 대응 (Upbit 단일 fetch 최대가 200이므로 250 요구 시 모두 탈락함)
  if (candles1.length < 200) {
    return { ok: false, mode: "none", reason: `insufficient_candles:${candles1.length}<200` };
  }

  const completed = candles1.slice(0, -1);
  const closes = completed.map(c => Number(c.trade_price));
  const highs = completed.map(c => Number(c.high_price));
  const lows = completed.map(c => Number(c.low_price));
  const volumes = completed.map(c => Number(c.candle_acc_trade_volume));

  const ema50Last = emaLast(closes, 50);
  const ema200Last = emaLast(closes, 200);
  if (ema50Last === null || ema200Last === null) {
    return { ok: false, mode: "none", reason: "ema_not_ready" };
  }

  const rsiValues = calculateRsi(closes, 14);
  const stoch = calculateStochRsi(rsiValues, 14, 3, 3);
  
  const lastIdx = closes.length - 1;
  const rsi = rsiValues[lastIdx] ?? 0;
  const k = stoch.k[lastIdx] ?? 0;
  const d = stoch.d[lastIdx] ?? 0;
  const prevK = stoch.k[lastIdx - 1] ?? 0;
  const prevD = stoch.d[lastIdx - 1] ?? 0;

  const lastCandle = completed[lastIdx]!;
  const isBullish = Number(lastCandle.trade_price) > Number(lastCandle.opening_price);
  const candleLow = Number(lastCandle.low_price);
  
  const recentLows = lows.slice(-10);
  const swingLow = Math.min(...recentLows);
  
  const avgVol5 = mean(volumes.slice(-6, -1));
  const lastVol = volumes[lastIdx]!;
  const volRatio = avgVol5 > 0 ? lastVol / avgVol5 : 0;

  const prevRsi = rsiValues[lastIdx - 1] ?? 0;

  // 1. 안전형 조건 (Pullback Reversal)
  const safePriceAboveEma200 = currentPrice > ema200Last || Number(lastCandle.trade_price) > ema200Last;
  const pullbackToEma200 = lows.slice(-20).some(l => l <= ema200Last * 1.015);
  const stochOversoldBullishCross = prevK <= 25 && prevD <= 25 && k > d; // 20->25로 약간 완화, prevK<=prevD 삭제
  const safe_condition_pass = safePriceAboveEma200 && pullbackToEma200 && stochOversoldBullishCross && isBullish;

  if (safe_condition_pass) {
    const stopPrice = swingLow * 0.998;
    const risk = currentPrice - stopPrice;
    if (risk > 0) {
      const targetPrice = currentPrice + risk * 1.5;
      const rr = 1.5;
      return {
        ok: true,
        mode: "safe",
        reason: "safe_pullback_ema200_stoch_cross",
        ema50: ema50Last, ema200: ema200Last, rsi, stochK: k, stochD: d,
        volumeRatio: volRatio,
        stopPrice, targetPrice, riskReward: rr,
        candleLow, swingLow,
        safePriceAboveEma200, pullbackToEma200, stochOversoldBullishCross, isBullish, safe_condition_pass
      };
    }
  }

  // 2. 공격형 조건 (Trend / Early Surge)
  const aggressiveEmaStack = ema50Last > ema200Last;
  const aggressivePriceAbove = currentPrice > ema50Last && currentPrice > ema200Last;
  const stochReversal = (k > prevK && k > 20) || (k > d && k > 40); // 추세 추종 시에는 굳이 침체권일 필요 없음
  const rsiBullish = rsi > 45 || (prevRsi <= 50 && rsi > 50) || rsi > prevRsi; // 50->45 완화
  const volSpike = volRatio > 0.95; // 1.0->0.95 완화
  const aggressiveRiskRewardOk = true; // RR checked inside
  const aggressive_condition_pass = aggressiveEmaStack && aggressivePriceAbove && stochReversal && rsiBullish && volSpike;

  if (aggressive_condition_pass) {
    const stopPrice = Math.min(candleLow, swingLow) * 0.998;
    const risk = currentPrice - stopPrice;
    if (risk > 0) {
      const targetPrice = currentPrice + risk * 2.0;
      const rr = 2.0;
      return {
        ok: true,
        mode: "aggressive",
        reason: "aggressive_trend_volume_spike",
        ema50: ema50Last, ema200: ema200Last, rsi, stochK: k, stochD: d,
        volumeRatio: volRatio,
        stopPrice, targetPrice, riskReward: rr,
        candleLow, swingLow,
        aggressiveEmaStack, aggressivePriceAbove, aggressiveRsiOk: rsiBullish, aggressiveVolumeOk: volSpike, aggressiveRiskRewardOk, aggressive_condition_pass
      };
    }
  }

  const failed: string[] = [];
  if (!safePriceAboveEma200) failed.push("safePriceAboveEma200");
  if (!pullbackToEma200) failed.push("pullbackToEma200");
  if (!stochOversoldBullishCross) failed.push("stochOversoldBullishCross");
  if (!isBullish) failed.push("isBullish");
  if (!aggressiveEmaStack) failed.push("aggressiveEmaStack");
  if (!aggressivePriceAbove) failed.push("aggressivePriceAbove");
  if (!stochReversal) failed.push("stochReversal");
  if (!rsiBullish) failed.push("rsiBullish");
  if (volRatio <= 1.0) failed.push("volRatio<=1.0");

  return {
    ok: false,
    mode: "none",
    reason: "setup_conditions_not_met",
    ema50: ema50Last,
    ema200: ema200Last,
    rsi,
    stochK: k,
    stochD: d,
    volumeRatio: volRatio,
    safePriceAboveEma200, pullbackToEma200, stochOversoldBullishCross, isBullish, safe_condition_pass,
    aggressiveEmaStack, aggressivePriceAbove, aggressiveRsiOk: rsiBullish, aggressiveVolumeOk: volSpike, aggressiveRiskRewardOk, aggressive_condition_pass,
    failed_conditions: failed,
  };
}

/**
 * 코어 현물(BTC/ETH/SOL/XRP/TRX) 전용 추세 지속형 진입 평가.
 * 반등형 original setup과 달리 stoch 눌림목 교차는 필수가 아니며 보조 점수로만 반영한다.
 * fresh signal + 비-fallback 에서만 호출될 것(호출부에서 보장).
 */
function evaluateCoreTrendEntrySetup(
  market: string,
  candles1: UpbitCandle[],
  currentPrice: number,
  payload: { volume_ratio?: number },
  ctx?: {
    allow_major_volume_relax?: boolean;
    source_kind?: string;
    candle_source?: "live_fetch" | "last_good_cache";
    market_state?: string | null;
  },
): OriginalSpotSetupResult {
  void market;
  const originalRequiredVolumeRatio = LIVE_CORE_TREND_MIN_VOLUME_RATIO;
  const coreReject = (
    reason: string,
    partial: Partial<OriginalSpotSetupResult> & { stoch_assist_score?: number },
  ): OriginalSpotSetupResult => {
    const sas = partial.stoch_assist_score ?? 0;
    return {
      ...partial,
      ok: false,
      mode: "none",
      reason,
      core_trend_entry_pass: false,
      core_trend_reject_reason: reason,
      stoch_assist_score: sas,
      stoch_assist_pass: sas >= 1,
      effective_volume_threshold:
        partial.effective_volume_threshold !== undefined ? partial.effective_volume_threshold : originalRequiredVolumeRatio,
      volume_relaxed_applied: Boolean(partial.volume_relaxed_applied ?? false),
    };
  };

  if (candles1.length < 200) {
    const r = `core_trend_insufficient_candles:${candles1.length}<200`;
    return coreReject(r, {});
  }
  const completed = candles1.slice(0, -1);
  const closes = completed.map((c) => Number(c.trade_price));
  const highs = completed.map((c) => Number(c.high_price));
  const lows = completed.map((c) => Number(c.low_price));
  const ema50Last = emaLast(closes, 50);
  const ema200Last = emaLast(closes, 200);
  if (ema50Last === null || ema200Last === null) {
    return coreReject("core_trend_ema_not_ready", {});
  }

  const rsiValues = calculateRsi(closes, 14);
  const stoch = calculateStochRsi(rsiValues, 14, 3, 3);
  const lastIdx = closes.length - 1;
  const rsi = rsiValues[lastIdx] ?? 0;
  const k = stoch.k[lastIdx] ?? 0;
  const d = stoch.d[lastIdx] ?? 0;
  const prevK = stoch.k[lastIdx - 1] ?? 0;
  const prevD = stoch.d[lastIdx - 1] ?? 0;

  let stochAssistScore = 0;
  if (prevK <= 30 && prevD <= 30 && k > d) stochAssistScore += 1;
  if ((k > prevK && k > 20) || (k > d && k > 35)) stochAssistScore += 1;

  const volPayload = Number(payload.volume_ratio ?? 0);

  if (rsi >= LIVE_CORE_TREND_RSI_CAP) {
    return coreReject("core_trend_rsi_overheated", {
      ema50: ema50Last,
      ema200: ema200Last,
      rsi,
      stochK: k,
      stochD: d,
      volumeRatio: volPayload,
      stoch_assist_score: stochAssistScore,
      failed_conditions: [`rsi_${rsi.toFixed(1)}>=${LIVE_CORE_TREND_RSI_CAP}`],
    });
  }

  const priceAbove200 = currentPrice > ema200Last;
  const recoveryStack = ema50Last > ema200Last && currentPrice > ema50Last && currentPrice >= ema200Last * 0.998;
  if (!priceAbove200 && !recoveryStack) {
    return coreReject("core_trend_below_ema_stack", {
      ema50: ema50Last,
      ema200: ema200Last,
      rsi,
      stochK: k,
      stochD: d,
      volumeRatio: volPayload,
      stoch_assist_score: stochAssistScore,
      failed_conditions: ["not_above_ema200_and_not_recovery_stack"],
    });
  }

  const candleFail: string[] = [];
  for (let i = Math.max(0, lastIdx - 2); i <= lastIdx; i++) {
    const row = completed[i];
    if (!row) continue;
    const o = Number(row.opening_price ?? 0);
    const c = Number(row.trade_price ?? 0);
    const h = Number(row.high_price ?? 0);
    const low = Number(row.low_price ?? 0);
    if (o > 0 && c / o - 1 < -0.018) candleFail.push(`bar_${i}_drop_steep`);
    const rng = Math.max(1e-9, h - low);
    const upWick = (h - c) / rng;
    if (upWick > 0.52) candleFail.push(`bar_${i}_upper_wick_heavy`);
  }
  if (candleFail.length > 0) {
    return coreReject("core_trend_recent_candle_guard", {
      ema50: ema50Last,
      ema200: ema200Last,
      rsi,
      stochK: k,
      stochD: d,
      volumeRatio: volPayload,
      stoch_assist_score: stochAssistScore,
      failed_conditions: candleFail,
    });
  }

  const recentLows = lows.slice(-10);
  const swingLow = Math.min(...recentLows);
  const lastCandle = completed[lastIdx]!;
  const candleLow = Number(lastCandle.low_price);
  const stopPrice = Math.min(swingLow, ema200Last * 0.995, candleLow) * 0.998;
  const risk = currentPrice - stopPrice;
  if (!(risk > 0)) {
    return coreReject("core_trend_stop_invalid", {
      ema50: ema50Last,
      ema200: ema200Last,
      rsi,
      stochK: k,
      stochD: d,
      volumeRatio: volPayload,
      stoch_assist_score: stochAssistScore,
      failed_conditions: ["risk_nonpositive"],
    });
  }
  const targetPrice = currentPrice + risk * 1.35;
  const rr = (targetPrice - currentPrice) / risk;
  if (rr < 1.15) {
    return coreReject("core_trend_rr_weak", {
      ema50: ema50Last,
      ema200: ema200Last,
      rsi,
      stochK: k,
      stochD: d,
      volumeRatio: volPayload,
      stoch_assist_score: stochAssistScore,
      failed_conditions: [`rr_${rr.toFixed(3)}<1.15`],
    });
  }

  // Volume gate: keep global default; allow major-only relax when all caller preconditions are met.
  let effectiveRequiredVolumeRatio = originalRequiredVolumeRatio;
  let volumeRelaxedApplied = false;
  const allowMajorVolumeRelax =
    Boolean(ctx?.allow_major_volume_relax) && CORE_TREND_VOLUME_RELAX_MARKETS.has(market) && LIVE_CORE_TREND_MAJOR_MIN_VOLUME_RATIO < originalRequiredVolumeRatio;
  if (volPayload < originalRequiredVolumeRatio) {
    if (allowMajorVolumeRelax && volPayload >= LIVE_CORE_TREND_MAJOR_MIN_VOLUME_RATIO) {
      effectiveRequiredVolumeRatio = LIVE_CORE_TREND_MAJOR_MIN_VOLUME_RATIO;
      volumeRelaxedApplied = true;
      console.info(
        JSON.stringify({
          tag: "CORE_TREND_VOLUME_RELAX_PROOF",
          ts: new Date().toISOString(),
          market,
          payload_volume_ratio: volPayload,
          required_volume_ratio: effectiveRequiredVolumeRatio,
          original_required_volume_ratio: originalRequiredVolumeRatio,
          relaxed_applied: true,
          source_kind: ctx?.source_kind ?? null,
          candle_source: ctx?.candle_source ?? null,
          risk_reward: rr,
          rsi,
          market_state: ctx?.market_state ?? null,
          entry_mode: "CORE_TREND_ENTRY",
        }),
      );
    } else {
      return coreReject("core_trend_volume_ratio_low", {
        ema50: ema50Last,
        ema200: ema200Last,
        rsi,
        stochK: k,
        stochD: d,
        volumeRatio: volPayload,
        stoch_assist_score: stochAssistScore,
        effective_volume_threshold: originalRequiredVolumeRatio,
        volume_relaxed_applied: false,
        failed_conditions: [`payload_volume_ratio_${volPayload.toFixed(3)}<${originalRequiredVolumeRatio}`],
      });
    }
  }

  return {
    ok: true,
    mode: "relaxed_probe",
    reason: "CORE_TREND_ENTRY",
    ema50: ema50Last,
    ema200: ema200Last,
    rsi,
    stochK: k,
    stochD: d,
    volumeRatio: volPayload,
    stopPrice,
    targetPrice,
    riskReward: rr,
    candleLow,
    swingLow,
    core_trend_entry_pass: true,
    core_trend_reject_reason: null,
    stoch_assist_score: stochAssistScore,
    stoch_assist_pass: stochAssistScore >= 1,
    effective_volume_threshold: effectiveRequiredVolumeRatio,
    volume_relaxed_applied: volumeRelaxedApplied,
  };
}

/**
 * [SURGE SETUP EVALUATOR] - Shadow/Evaluation only.
 * 급등주 전용 평가기. 눌림목/정배열 기반인 Original Spot Setup과 달리 
 * 거래량 폭발, 단기 모멘텀, 직전 고점 돌파 등을 위주로 평가한다.
 */
function evaluateSurgeEntrySetup(
  market: string,
  candles1: UpbitCandle[],
  currentPx: number,
  payload: any,
): SurgeEntrySetupResult {
  if (candles1.length < 50) {
    return { ok: false, score: 0, grade: "F", reason: `insufficient_candles:${candles1.length}<50` };
  }

  const completed = candles1.slice(0, -1);
  const lastBar = completed[completed.length - 1]!;
  const closes = completed.map(c => Number(c.trade_price));
  const highs = completed.map(c => Number(c.high_price));
  const lows = completed.map(c => Number(c.low_price));
  
  // 1. Volume Expansion (payload's volume_ratio)
  const volRatio = Number(payload.volume_ratio ?? 0);
  const volOk = volRatio >= 1.4;

  // 2. Short-term Momentum (rise in last 3m)
  const momentum = Number(payload.rise_3m_pct ?? payload.momentum_3m_pct ?? payload.price_change_3m_pct ?? 0);
  const momentumOk = momentum >= 0.7;

  // 3. Price above short EMA (EMA 20) or recent high reclaim
  const e20 = emaLast(closes, 20);
  const priceAboveEma20 = e20 !== null && currentPx > e20;
  
  const recentHighs = highs.slice(-15);
  const localHigh = Math.max(...recentHighs);
  const highReclaim = currentPx >= localHigh * 0.9985;

  // 4. Not extreme late chase (overextended) - Price not more than 4.5% above EMA20
  const overextended = e20 !== null && currentPx > e20 * 1.045;

  // 5. Not upper wick rejection
  const lastHigh = Number(lastBar.high_price);
  const lastLow = Number(lastBar.low_price);
  const lastClose = Number(lastBar.trade_price);
  const range = Math.max(1e-9, lastHigh - lastLow);
  const upperWickRatio = (lastHigh - lastClose) / range;
  const wickOk = upperWickRatio < 0.45;

  // 6. Risk Reward calculable
  const stopPrice = Math.min(...lows.slice(-6)) * 0.9975;
  const risk = currentPx - stopPrice;
  const targetPrice = currentPx + risk * 1.4;
  const rrOk = risk > 0 && (targetPrice - currentPx) / risk >= 1.25;

  // Evaluation
  const failed: string[] = [];
  if (!volOk) failed.push("low_volume");
  if (!momentumOk) failed.push("low_momentum");
  if (!priceAboveEma20 && !highReclaim) failed.push("no_breakout_or_ema_support");
  if (overextended) failed.push("overextended");
  if (!wickOk) failed.push("upper_wick_rejection");
  if (!rrOk) failed.push("risk_reward_invalid");

  const pass = failed.length === 0;
  
  // Simple scoring for shadow monitoring
  let score = 0;
  if (volOk) score += 20;
  if (momentumOk) score += 20;
  if (priceAboveEma20 || highReclaim) score += 20;
  if (!overextended) score += 10;
  if (wickOk) score += 10;
  if (rrOk) score += 20;
  
  const grade = score >= 90 ? "S" : score >= 80 ? "A" : score >= 70 ? "B" : "F";

  // [SURGE PROBE DOWNGRADE] Grade A인데 low_momentum 하나만 남은 경우 probe 허용
  let probeAllowed = false;
  if (!pass && grade === "A" && failed.length === 1 && failed[0] === "low_momentum") {
    if (!failed.includes("upper_wick_rejection") && !failed.includes("no_breakout_or_ema_support")) {
      probeAllowed = true;
    }
  }

  // Indicators for logging
  const ema50 = emaLast(closes, 50) ?? 0;
  const ema200 = emaLast(closes, 200) ?? 0;
  const rsiValues = calculateRsi(closes, 14);
  const stoch = calculateStochRsi(rsiValues, 14, 3, 3);
  const lastIdx = closes.length - 1;
  const rsi = rsiValues[lastIdx] ?? 0;
  const k = stoch.k[lastIdx] ?? 0;
  const d = stoch.d[lastIdx] ?? 0;

  return {
    ok: pass || probeAllowed,
    score,
    grade,
    reason: pass ? "surge_setup_passed" : (probeAllowed ? "surge_probe_downgrade_allowed" : "surge_setup_failed"),
    failed_conditions: failed,
    ema50,
    ema200,
    rsi,
    stochK: k,
    stochD: d,
    volumeRatio: volRatio,
    stopPrice,
    targetPrice,
    riskReward: risk > 0 ? (targetPrice - currentPx) / risk : 0,
    priceAboveEma20,
    highReclaim,
    overextended,
    wickOk,
    rrOk,
    probe_allowed: probeAllowed
  };
}

function minutesSince(ts: string) {
  return Math.max(0, (Date.now() - Date.parse(ts)) / 60_000);
}

function accountTotalSpotQtyForMarket(market: string, balances: UpbitBalance[] | undefined): number {
  const cur = market.replace("KRW-", "").toUpperCase();
  const row = Array.isArray(balances)
    ? balances.find((b) => String(b?.currency ?? "").toUpperCase() === cur)
    : undefined;
  return Number(row?.balance ?? 0) + Number(row?.locked ?? 0);
}

function classifyEntryQuality(params: {
  market: string;
  score: number;
  secondsSinceSignal: number | null;
  distanceFromLocalHighPct: number | null;
  volumeRatio: number | null;
  btcTier: "strong" | "neutral" | "weak";
}): EntryQuality {
  const score = Number(params.score ?? 0);
  const tier: EntryQualityTier = score >= 90 ? "A" : score >= 82 ? "B" : "C";

  // Real-time diagnostics-backed eligibility
  const age = params.secondsSinceSignal ?? 999;
  const dist = params.distanceFromLocalHighPct ?? 0;
  const vol = params.volumeRatio ?? 0;

  const isFresh = age <= 30; // Early entry needs very fresh signals
  const isNearHighSafe = dist >= 0.35; // Don't chase too close to local high
  const isVolumeStrong = vol >= 1.45; // Strong volume confirmation

  const earlyEligible = tier === "A" && isFresh && isNearHighSafe && isVolumeStrong && params.btcTier !== "weak";
  return { tier, score, earlyEligible };
}

function computeTargetPositionBudget(params: {
  strategyUsableKrw: number;
  regime: "strong" | "neutral" | "weak";
  candidates: CandidateMeta[];
}): {
  deployableKrw: number;
  deployableAfterBufferKrw: number;
  bySymbol: Map<string, number>;
} {
  const regimeUtil = params.regime === "strong" ? 0.88 : params.regime === "neutral" ? 0.72 : 0.45;
  const deployableKrw = Math.floor(Math.max(0, params.strategyUsableKrw) * regimeUtil);
  const deployableAfterBufferKrw = Math.floor(deployableKrw * 0.95);
  const targetRatioByTier: Record<EntryQualityTier, number> = { A: 0.4, B: 0.28, C: 0.18 };
  const capRatioByTier: Record<EntryQualityTier, number> = { A: 0.45, B: 0.3, C: 0.2 };
  const sorted = [...params.candidates].sort((a, b) => b.score - a.score);
  const wanted = sorted.map((c) => {
    const baseTarget = Math.floor(deployableAfterBufferKrw * targetRatioByTier[c.tier]);
    const baseCap = Math.floor(deployableAfterBufferKrw * capRatioByTier[c.tier]);
    // 원형 셋업 퀄리티에 따른 보너스/페널티 배율
    let setupMultiplier = 1.0;
    if (c.setupMode === "safe") setupMultiplier = 1.5;
    else if (c.setupMode === "aggressive") setupMultiplier = 1.25;
    
    if (c.riskReward && c.riskReward < 1.4) setupMultiplier *= 0.7;

    return {
      market: c.market,
      tier: c.tier,
      target: Math.floor(baseTarget * setupMultiplier),
      cap: Math.floor(baseCap * setupMultiplier),
    };
  });
  const totalWanted = wanted.reduce((acc, x) => acc + x.target, 0);
  const scale = totalWanted > deployableAfterBufferKrw && totalWanted > 0 ? deployableAfterBufferKrw / totalWanted : 1;
  const bySymbol = new Map<string, number>();
  for (const w of wanted) {
    const scaled = Math.floor(w.target * scale);
    bySymbol.set(w.market, Math.max(UPBIT_MIN_ORDER_KRW, Math.min(w.cap, scaled)));
  }
  return { deployableKrw, deployableAfterBufferKrw, bySymbol };
}

function bucketScore(score: number): LiveEntryProfileFeatures["score_bucket"] {
  if (score >= 90) return "90+";
  if (score >= 80) return "80-89";
  if (score >= 70) return "70-79";
  return "0-69";
}
function bucketVol(v: number): LiveEntryProfileFeatures["volume_ratio_bucket"] {
  if (v >= 2.0) return "2.0+";
  if (v >= 1.5) return "1.5-1.99";
  if (v >= 1.2) return "1.2-1.49";
  return "<1.2";
}
function bucketAge(sec: number | null): LiveEntryProfileFeatures["signal_age_bucket"] {
  const s = Math.max(0, Number(sec ?? 9999));
  if (s <= 10) return "<=10s";
  if (s <= 30) return "11-30s";
  if (s <= 60) return "31-60s";
  return ">60s";
}
function bucketChase(v: number | null): LiveEntryProfileFeatures["chase_bucket"] {
  const n = Math.max(0, Number(v ?? 999));
  if (n <= 0.2) return "<=0.2";
  if (n <= 0.5) return "0.21-0.5";
  if (n <= 1.0) return "0.51-1.0";
  return ">1.0";
}
function bucketNear(v: number | null): LiveEntryProfileFeatures["near_high_bucket"] {
  const n = Math.max(0, Number(v ?? 999));
  if (n <= 0.1) return "<=0.1";
  if (n <= 0.25) return "0.11-0.25";
  if (n <= 0.5) return "0.26-0.5";
  return ">0.5";
}
function makeEntryProfileKey(f: LiveEntryProfileFeatures): string {
  return [
    `sig:${f.signal_type}`,
    `stage:${f.position_stage}`,
    `btc:${f.btc_tier}`,
    `score:${f.score_bucket}`,
    `vol:${f.volume_ratio_bucket}`,
    `age:${f.signal_age_bucket}`,
    `chase:${f.chase_bucket}`,
    `near:${f.near_high_bucket}`,
    `bo:${f.breakout ? "1" : "0"}`,
    `early:${f.early_entry_flag ? "1" : "0"}`,
  ].join("|");
}
function decideEntryProfile(stats?: LiveEntryProfileStats): { decision: "allow" | "block" | "unknown"; reason: string } {
  if (!stats || stats.total_trades < 3) return { decision: "unknown", reason: "profile_unknown_fallback_allow" };
  const recent2 = stats.recent_net_pnl_pct.slice(-2);
  const timeoutWeakRate = stats.total_trades > 0 ? (stats.timeouts + stats.weak_stops) / stats.total_trades : 0;
  if (stats.total_trades >= 3 && stats.avg_net_pnl_pct <= -0.2) return { decision: "block", reason: "profile_block_negative_expectancy" };
  if (stats.total_trades >= 3 && stats.win_rate < 0.35) return { decision: "block", reason: "profile_block_low_win_rate" };
  if (recent2.length === 2 && recent2.every((x) => x <= -0.2)) return { decision: "block", reason: "profile_block_recent_losses" };
  if (timeoutWeakRate >= 0.5 && stats.avg_net_pnl_pct < 0) return { decision: "block", reason: "profile_block_timeout_weak_negative" };
  if (stats.total_trades >= 3 && stats.avg_net_pnl_pct >= 0.4) return { decision: "allow", reason: "profile_allow_positive_expectancy" };
  if (stats.total_trades >= 3 && stats.win_rate >= 0.58) return { decision: "allow", reason: "profile_allow_win_rate" };
  if (stats.wins > stats.losses && stats.total_net_pnl_pct > 0) return { decision: "allow", reason: "profile_allow_net_positive" };
  return { decision: "unknown", reason: "profile_unknown_fallback_allow" };
}

function evaluateEntryProfileDecision(stats?: LiveEntryProfileStats): { decision: "allow" | "block" | "unknown"; reason: string } {
  return decideEntryProfile(stats);
}

function evaluateExitAuthority(params: {
  p: StrategyPosition;
  pnlGross: number;
  heldMs: number;
  marketTier: "strong" | "neutral" | "weak";
  weakReboundPoor: boolean;
}): ExitAuthorityDecision {
  const holdMin = params.heldMs / 60_000;
  const p = params.p;
  const emergencyStop = p.strategy_type === "stable" ? -1.45 : -1.75;
  if (params.pnlGross <= emergencyStop) {
    return { reasonExit: "emergency_stop_loss", ratio: 1, stopTriggerKind: "price_stop", authorityClass: "emergency_exit", reasonDetail: `gross<=${emergencyStop}`, runnerTrailActive: false };
  }
  const hardLoss = p.strategy_type === "stable" ? -2.0 : -3.0;
  if (params.pnlGross <= hardLoss) {
    return { reasonExit: "strict_hard_stop_loss", ratio: 1, stopTriggerKind: "price_stop", authorityClass: "hard_loss", reasonDetail: `gross<=${hardLoss}`, runnerTrailActive: false };
  }
  const partialReady = !p.partial_tp_done && params.pnlGross >= 3.0 && holdMin >= 3 && p.max_pnl_pct >= 3.2;
  if (partialReady) {
    return { reasonExit: "partial_take_profit", ratio: 0.25, stopTriggerKind: null, authorityClass: "partial_take_profit", reasonDetail: "gross>=3.0,held>=3,peak>=3.2", runnerTrailActive: false };
  }
  const breakevenArm = p.partial_tp_done || (params.pnlGross >= 2.2 && holdMin >= 4);
  const breakevenFloor = 0.35;
  const trailWidth = params.marketTier === "weak" ? 1.8 : 2.2;
  const ddFromPeak = p.highest_price_after_entry > 0 ? ((p.highest_price_after_entry - (p.entry_price * (1 + params.pnlGross / 100))) / p.highest_price_after_entry) * 100 : 0;
  if (breakevenArm && params.pnlGross <= breakevenFloor) {
    return { reasonExit: "breakeven_exit", ratio: 1, stopTriggerKind: "breakeven_protect", authorityClass: "breakeven_protect", reasonDetail: "armed && pnl<=0.35", runnerTrailActive: true };
  }
  if (p.partial_tp_done && ddFromPeak >= trailWidth) {
    return { reasonExit: "trailing_runner_exit", ratio: 1, stopTriggerKind: "time_stop", authorityClass: "runner_trail", reasonDetail: `dd>=${trailWidth}`, runnerTrailActive: true };
  }
  if (params.marketTier === "weak" && holdMin >= LIVE_STABLE_WEAK_REBOUND_TIME_STOP_MINUTES && p.max_pnl_pct < 0.6 && params.pnlGross < 0 && params.weakReboundPoor) {
    return { reasonExit: "weak_market_time_stop", ratio: 1, stopTriggerKind: "time_stop", authorityClass: "weak_time_stop", reasonDetail: "weak market low rebound", runnerTrailActive: false };
  }
  return { reasonExit: null, ratio: 1, stopTriggerKind: null, authorityClass: "none", reasonDetail: "no_exit", runnerTrailActive: p.partial_tp_done };
}

export function createLiveDataStrategy(opts: {
  companyId: string;
  serviceId: string;
  readLogs: (limit: number) => Promise<SignalLogEntry[]>;
  getScannerSignals?: () => ScannerFeedSignal[];
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
    entry_profile_stats: {},
  };

  let runTickInFlight = false;
  /** 단조 증가; 틱 시작 시점의 lease id (주문 실행 권한 판별). */
  let liveTickLeaseSeq = 0;
  let lastGoodMarketState: Awaited<ReturnType<MarketStateApi["evaluate"]>> | null = null;
  let lastGoodMarketStateAt: number = 0;
  /** 현재 유효 lease — 스테일 감지 시 증가시켜 진행 중 틱은 주문 권한 상실. */
  let liveTickValidLease = 0;
  let liveTickAbort: AbortController | null = null;
  const setupBlockLogDeduper = new LogDeduper(3000, 60_000);

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
          entry_profile_stats: state.entry_profile_stats,
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
      state.entry_profile_stats = d.entry_profile_stats ?? state.entry_profile_stats ?? {};
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
      early_positions: state.early_positions,
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

  const legacySignalAllowsDca = (sig: { p: SignalPayloadV2 }): boolean => {
    if (!sig?.p) return false;
    const p = sig.p;
    const volumeOkay = Number(p.volume_ratio ?? 0) >= 0.85;
    const filters = Array.isArray(p.filters) ? (p.filters as { id: string; passed: boolean }[]) : [];
    const passed = new Set(filters.filter((f) => f?.passed === true).map((f) => String(f.id)));
    const reboundPattern =
      passed.has("box_breakout") ||
      passed.has("pullback_reclaim") ||
      passed.has("volume_spike_close_fail");
    return volumeOkay && reboundPattern;
  };

  const legacySignalWeakening = (sig: { p: SignalPayloadV2 }): boolean => {
    if (!sig?.p) return false;
    const p = sig.p;
    const filters = Array.isArray(p.filters) ? (p.filters as { id: string; passed: boolean }[]) : [];
    const closeHold = filters.find((f) => String(f?.id) === "volume_spike_close_fail");
    const volume = Number(p.volume_ratio ?? 0);
    return (closeHold && closeHold.passed === false) || volume < 0.75;
  };

  let lastTickStartedAt = 0;
  const STALE_LIVE_TICK_MS = 120_000;

  const runTick = async () => {
    const nowMs = Date.now();
    if (runTickInFlight) {
      const elapsed = nowMs - lastTickStartedAt;
      const stale = elapsed > STALE_LIVE_TICK_MS;
      console.info(
        JSON.stringify({
          tag: "LIVE_TICK_SKIPPED_IN_FLIGHT",
          ts: new Date().toISOString(),
          elapsed_ms: elapsed,
          note: stale ? "stale_in_flight_lease_revoke_and_abort" : "in_flight",
        }),
      );
      if (stale) {
        liveTickValidLease += 1;
        console.info(
          JSON.stringify({
            tag: "LIVE_TICK_STALE_IN_FLIGHT",
            ts: new Date().toISOString(),
            elapsed_ms: elapsed,
            note: "abort_requested_no_overlap_new_tick_starts_only_after_finally",
            valid_lease: liveTickValidLease,
          }),
        );
        try {
          liveTickAbort?.abort();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const tickAbort = new AbortController();
    liveTickAbort = tickAbort;
    const tickSignal = tickAbort.signal;
    const myLease = (liveTickLeaseSeq += 1);
    liveTickValidLease = myLease;

    const leaseOk = () => myLease === liveTickValidLease && !tickSignal.aborted;

    runTickInFlight = true;
    lastTickStartedAt = Date.now();

    const ageInterval = setInterval(() => {
      if (!runTickInFlight || myLease !== liveTickValidLease) {
        clearInterval(ageInterval);
        return;
      }
      console.info(
        JSON.stringify({
          tag: "LIVE_TICK_IN_FLIGHT_AGE_PROOF",
          ts: new Date().toISOString(),
          tick_lease: myLease,
          started_at: new Date(lastTickStartedAt).toISOString(),
          elapsed_ms: Date.now() - lastTickStartedAt,
          phase: "execution_loop",
          current_market: "global",
          reason: "long_running_tick_monitored",
        }),
      );
    }, 15_000);

    try {
    const loopId = Date.now();
    const assertLiveOrderAuthority = (phase: string): boolean => {
      if (leaseOk()) return true;
      console.info(
        JSON.stringify({
          tag: "LIVE_TICK_ORDER_AUTH_BLOCKED",
          ts: new Date().toISOString(),
          phase,
          tick_lease: myLease,
          valid_lease: liveTickValidLease,
          signal_aborted: tickSignal.aborted,
        }),
      );
      return false;
    };
    const PHASE_MS = LIVE_TICK_PHASE_MS;
    const racePhase = <T>(phase: string, timeout_ms: number, fn: () => Promise<T>) =>
      liveTickRacePhase({ phase, tick_lease: myLease, timeout_ms }, fn);
    let lastGoodTradeStatus: TradeStatus | null = null;
    let lastGoodTradeStatusAtMs = 0;
    const safeDegradedTradeStatus = (): TradeStatus => ({
      auto_trade_enabled: false,
      api_connected: false,
      live_enabled: false,
      balances: [],
      ledger_reconcile: null,
      strategy_positions: {},
      legacy_positions: {},
      krw_available: 0,
      live_order_available_krw: 0,
      strategy_available_krw: 0,
    });
    const raceTradeStatusSafe = async (phase: string): Promise<TradeStatus> => {
      try {
        const st = await racePhase(`trade_status:${phase}`, PHASE_MS.trade_status, () => opts.trade.status());
        if (st && typeof st === "object") {
          lastGoodTradeStatus = st;
          lastGoodTradeStatusAtMs = Date.now();
        }
        return st;
      } catch (e) {
        const now = Date.now();
        const cacheAgeMs = lastGoodTradeStatusAtMs > 0 ? now - lastGoodTradeStatusAtMs : Infinity;
        const useCache = lastGoodTradeStatus && cacheAgeMs < 30_000;
        const fallback = useCache ? lastGoodTradeStatus! : safeDegradedTradeStatus();
        console.info(
          JSON.stringify({
            tag: "LIVE_TRADE_STATUS_FALLBACK_USED",
            ts: new Date().toISOString(),
            phase,
            reason: isLiveTickPhaseTimeout(e) ? "timeout" : "error",
            cache_used: useCache,
            cache_age_ms: useCache ? cacheAgeMs : null,
            api_connected: Boolean((fallback as any).api_connected),
            live_enabled: Boolean((fallback as any).live_enabled),
            auto_trade_enabled: Boolean((fallback as any).auto_trade_enabled),
          }),
        );
        return fallback;
      }
    };
    // Backward-compatible alias for the rest of the tick code.
    const raceTradeStatus = (phase: string) => raceTradeStatusSafe(phase);
    const racePersist = (phase: string) => racePhase(`persist:${phase}`, PHASE_MS.persist, () => persist());

    let lastGoodLogs: SignalLogEntry[] = [];
    let lastGoodLogsAtMs = 0;
    let logsRefreshInFlight: Promise<void> | null = null;
    const requestLogsRefreshNonBlocking = () => {
      const now = Date.now();
      if (logsRefreshInFlight) return;
      if (lastGoodLogsAtMs > 0 && now - lastGoodLogsAtMs < 12_000) return;
      logsRefreshInFlight = (async () => {
        try {
          const rows = await liveTickRacePhase(
            { phase: "read_logs_220_background", tick_lease: myLease, timeout_ms: Math.max(300, Math.min(1200, PHASE_MS.read_logs)) },
            () => opts.readLogs(220),
          );
          if (Array.isArray(rows)) {
            lastGoodLogs = rows;
            lastGoodLogsAtMs = Date.now();
          }
        } catch {
          // ignore
        } finally {
          logsRefreshInFlight = null;
        }
      })();
    };
    await liveTickRacePhase(
      { phase: "tick_hard_wall_clock", tick_lease: myLease, timeout_ms: LIVE_TICK_HARD_WALL_MS },
      async () => {
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

    const tstatus = await raceTradeStatusSafe("initial_after_daily_reset");
    const allowEntry =
      tstatus.auto_trade_enabled === true && tstatus.live_enabled === true && tstatus.api_connected === true;
    const liveTradingOn = allowEntry;
    const hasOpenPositions = Object.keys(state.positions).length > 0 || Object.keys(state.early_positions).length > 0;
    const tradeStatusEntryBlocked = !allowEntry;
    if (tradeStatusEntryBlocked) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_EXIT_PROOF",
          ts: new Date().toISOString(),
          stage: "before_signal_load",
          reason: "trade_status_guard_entry_blocked",
          auto_trade_enabled: Boolean(tstatus.auto_trade_enabled),
          api_connected: Boolean(tstatus.api_connected),
          live_enabled: Boolean(tstatus.live_enabled),
          has_open_positions: hasOpenPositions
        }),
      );
      if (tstatus.auto_trade_enabled === true && tstatus.live_enabled === true && tstatus.api_connected === false) {
        console.info(
          JSON.stringify({
            tag: "LIVE_TRADE_STATUS_GUARD_DEGRADED_ALLOWED",
            ts: new Date().toISOString(),
            stage: "before_signal_load",
            reason: "api_disconnected_but_keep_tick_running",
            entry_blocked: true,
            exit_management_continues: hasOpenPositions,
          }),
        );
      }
    }

    // 계좌 실물 + trade-control ledger 기준으로 persisted 전략 상태를 정리 (수동 청산·외부 매도 후 유령 슬롯 방지).
    const balArr = Array.isArray(tstatus.balances) ? tstatus.balances : [];
    const lr = tstatus.ledger_reconcile;
    const reconcileActions: string[] = [];
    const strategyPosSnap = tstatus.strategy_positions ?? {};
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
          tag: "SPOT_MANAGED_POSITION_SYNC_PROOF",
          ts: new Date().toISOString(),
          actions: reconcileActions,
          ledger_reconcile: lr ?? null,
          strategy_positions_count: Object.keys(state.positions).length,
          early_positions_count: Object.keys(state.early_positions).length,
        }),
      );
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_STATE_RECONCILE_RESULT",
          ts: new Date().toISOString(),
          actions: reconcileActions,
          ledger_reconcile: lr ?? null,
        }),
      );
      await racePersist("after_reconcile_actions");
    }

    // holdings_universe: 현재 계좌 보유 종목(관리/청산/표시용). discovery/entry_universe/precheck 경로에서는 제외한다.
    const heldSymbols = balArr
      .map((b) => {
        const currency = String(b?.currency ?? "").toUpperCase();
        const qty = Number(b?.balance ?? 0) + Number(b?.locked ?? 0);
        if (!currency || currency === "KRW" || !(qty > 0)) return null;
        return `KRW-${currency}`;
      })
      .filter((x): x is string => Boolean(x) && String(x).startsWith("KRW-"));
    const heldSymbolSet = new Set<string>([...heldSymbols, ...Object.keys(state.positions)]);

    {
      const managedSet = new Set<string>([...Object.keys(state.positions), ...Object.keys(state.early_positions)]);
      const passive = heldSymbols.filter((m) => !managedSet.has(m));
      console.info(
        JSON.stringify({
          tag: "SPOT_ACCOUNT_HOLDING_CLASSIFICATION_PROOF",
          ts: new Date().toISOString(),
          held_count: heldSymbols.length,
          managed_count: managedSet.size,
          passive_count: passive.length,
          managed_markets: [...managedSet].slice(0, 25),
          passive_markets: passive.slice(0, 25),
        }),
      );
      console.info(
        JSON.stringify({
          tag: "SPOT_SLOT_USAGE_RECONCILE_PROOF",
          ts: new Date().toISOString(),
          used_slots: Object.keys(state.positions).length + Object.keys(state.early_positions).length,
          used_slots_normal: Object.keys(state.positions).length,
          used_slots_early: Object.keys(state.early_positions).length,
          held_count: heldSymbols.length,
          note: "used_slots counts only strategy-managed positions; passive holdings excluded",
        }),
      );
    }
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
          tag: "DEBUG_LIVE_EXIT_MANAGEMENT_CONTINUES",
          ts: new Date().toISOString(),
          stage: "before_signal_load_safety_guard",
          reason: "entry_blocked_safety_guard_stopped",
          entry_blocked: true,
          exit_management_continues: hasOpenPositions,
          message: "auto_trade_off_entry_disabled_exit_still_active",
          open_positions: Object.keys(state.positions).length,
          early_positions: Object.keys(state.early_positions).length,
          watch_markets_count: null,
          signal_map_count: null,
          markets_with_filter_pass_count: null,
          base_entry_universe_count: null,
          entry_universe_count: null,
          symbol: null,
          note: "entry blocked only; continue exit/position management flow",
        }),
      );
    }
    const latestByMarket = new Map<string, any>();
    const latestAllSignals = new Map<string, any>();
    const sourceMetaByMarket = new Map<
      string,
      {
        source_kind:
          | "scanner_filter_fresh"
          | "fresh_filter_pass"
          | "legacy_filter_pass"
          | "fallback_watch_markets"
          | "scanner_then_filter_pass";
        source_ts: string | null;
        age_seconds: number | null;
        stale_filtered_before_eval: boolean;
      }
    >();
    requestLogsRefreshNonBlocking();
    const logs = lastGoodLogs.length > 0 ? lastGoodLogs : [];
    if (logs.length === 0) {
      console.info(
        JSON.stringify({
          tag: "LIVE_LOG_READ_SKIPPED_FOR_TRADE_LOOP",
          ts: new Date().toISOString(),
          reason: "no_last_good_logs_available",
          last_good_age_ms: lastGoodLogsAtMs > 0 ? Date.now() - lastGoodLogsAtMs : null,
        }),
      );
    } else {
      console.info(
        JSON.stringify({
          tag: "LIVE_LOG_READ_SKIPPED_FOR_TRADE_LOOP",
          ts: new Date().toISOString(),
          reason: "using_last_good_logs_snapshot",
          last_good_age_ms: Date.now() - lastGoodLogsAtMs,
          logs_len: logs.length,
        }),
      );
    }

    let marketState: Awaited<ReturnType<MarketStateApi["evaluate"]>>;
    try {
      marketState = await racePhase("market_state_evaluate", PHASE_MS.market_state, () => opts.marketState.evaluate());
      lastGoodMarketState = marketState;
      lastGoodMarketStateAt = Date.now();
    } catch (e) {
      const cacheAgeMs = lastGoodMarketStateAt > 0 ? Date.now() - lastGoodMarketStateAt : Infinity;
      const useCache = lastGoodMarketState && cacheAgeMs < 10 * 60 * 1000;
      const isTimeout = isLiveTickPhaseTimeout(e);

      if (useCache) {
        marketState = lastGoodMarketState!;
        console.info(
          JSON.stringify({
            tag: "LIVE_MARKET_STATE_FAST_FALLBACK_USED",
            ts: new Date().toISOString(),
            source: "last_good",
            min_entry_score: marketState.min_entry_score,
            market_state: marketState.market_state,
            reason: isTimeout ? "timeout" : "error",
            cache_age_ms: cacheAgeMs,
            tick_lease: myLease,
          }),
        );
      } else {
        // 캐시가 없거나 너무 오래됨 -> logs 기반으로 neutral_safe 시도 (완전 risk_off로 막기 전에)
        const recentSignals = (logs || []).filter((l) => l.kind === "signal" && l.payload);
        const highSignals = recentSignals.filter((l) => signalStrengthScore(l.payload) >= 70).length;
        const lowSignals = recentSignals.filter((l) => signalStrengthScore(l.payload) < 55).length;
        
        // 최근 신호가 활발하고 강한 신호가 어느 정도 있으면 neutral_safe 적용
        const useNeutralSafe = highSignals >= 3 && highSignals > lowSignals;
        
        marketState = useNeutralSafe 
          ? {
              market_state: "neutral",
              min_entry_score: 82, // 약간 보수적인 neutral
              market_bonus: 0,
              btc_5m_trend: "flat",
              btc_15m_trend: "flat",
            }
          : {
              market_state: "risk_off",
              min_entry_score: 99,
              market_bonus: -10,
              btc_5m_trend: "down",
              btc_15m_trend: "down",
            };

        console.info(
          JSON.stringify({
            tag: "LIVE_MARKET_STATE_FAST_FALLBACK_USED",
            ts: new Date().toISOString(),
            source: useNeutralSafe ? "neutral_safe" : "risk_off_safe",
            min_entry_score: marketState.min_entry_score,
            market_state: marketState.market_state,
            reason: isTimeout ? "timeout_and_no_cache" : "error_and_no_cache",
            cache_age_ms: cacheAgeMs,
            tick_lease: myLease,
            high_signals: highSignals,
            low_signals: lowSignals,
          }),
        );

        console.info(
          JSON.stringify({
            tag: "LIVE_TICK_PHASE_EXIT",
            ts: new Date().toISOString(),
            phase: "market_state_evaluate",
            tick_lease: myLease,
            outcome: "fallback_used",
            fallback_source: useNeutralSafe ? "neutral_safe" : "risk_off_safe"
          })
        );

        if (!useNeutralSafe) {
          console.info(
            JSON.stringify({
              tag: "LIVE_MARKET_STATE_UNAVAILABLE_ENTRY_BLOCKED",
              ts: new Date().toISOString(),
              tick_lease: myLease,
              reason: "no_valid_market_state_and_weak_signals",
            }),
          );
        }
      }
    }
    const conservativeMode = marketState.market_state === "risk_off";
    for (const row of logs) {
      if (row.kind !== "signal" || !row.payload) continue;
      const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
      if (!p.success) continue;
      if (!latestAllSignals.has(p.data.market)) latestAllSignals.set(p.data.market, { ts: row.ts, p: p.data });
      if (!MARKETS.includes(p.data.market as (typeof MARKETS)[number])) continue;
      if (!latestByMarket.has(p.data.market)) latestByMarket.set(p.data.market, { ts: row.ts, p: p.data });
    }

    const includeValidity = await racePhase(
      "partition_validity_include_universe",
      PHASE_MS.partition_validity,
      () => partitionKrwMarketsByUpbitValidity(DEBUG_INCLUDE_UNIVERSE_MARKETS),
    );
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

    const logMapValidity = await racePhase(
      "partition_validity_signal_map_keys",
      PHASE_MS.partition_validity,
      () => partitionKrwMarketsByUpbitValidity([...latestAllSignals.keys()]),
    );
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

    const scannerFeedRaw = typeof opts.getScannerSignals === "function" ? opts.getScannerSignals() : [];
    const scannerFeed = Array.isArray(scannerFeedRaw) ? scannerFeedRaw : [];
    // [SURGE-REPAIR] feed 전체의 최신 updated_at을 구해서 각 row의 timestamp fallback으로 활용.
    // pump-scanner tick이 정상적으로 완료됐지만 개별 row의 updated_at이 tick 실행 시각으로
    // 찍혀 있어 stale 판단이 오작동하는 경우를 방지한다.
    const scannerFeedNewestTsMs = scannerFeed.reduce((best, raw) => {
      const candidates = [
        typeof raw?.updated_at === "string" ? Date.parse(raw.updated_at) : NaN,
        typeof raw?.signal_ts === "string" ? Date.parse(raw.signal_ts) : NaN,
        typeof raw?.captured_at === "string" ? Date.parse(raw.captured_at) : NaN,
      ];
      const max = Math.max(...candidates.filter(Number.isFinite));
      return Number.isFinite(max) && max > best ? max : best;
    }, 0);
    const scannerFeedNewestTs = scannerFeedNewestTsMs > 0 ? new Date(scannerFeedNewestTsMs).toISOString() : null;
    const scannerCandidates = scannerFeed
      .map((raw) => {
        const market = String(raw?.market ?? "").toUpperCase();
        if (!market.startsWith("KRW-")) return null;
        const capturedAt = typeof raw?.captured_at === "string" ? raw.captured_at : null;
        const updatedAt = typeof raw?.updated_at === "string" ? raw.updated_at : null;
        const signalTs = typeof raw?.signal_ts === "string" ? raw.signal_ts : null;
        // [SURGE-REPAIR] 개별 row timestamp가 없거나 stale이면 feed 전체 최신 ts를 fallback으로 사용.
        const rawSourceTs = scannerSignalTimestamp(raw);
        const feedFallbackTs = scannerFeedNewestTs;
        const sourceTs = resolveFreshestIsoTs([rawSourceTs, feedFallbackTs]);
        const ageSeconds = sourceTs ? Math.max(0, Math.floor((Date.now() - Date.parse(sourceTs)) / 1000)) : null;
        return {
          market,
          score: Number(raw?.score ?? 0),
          volumeMultiple: Number(raw?.volume_multiple ?? 0),
          breakout: Boolean(raw?.breakout),
          closeUpperHold: Boolean(raw?.close_upper_hold),
          rise3mPct: Number(raw?.rise_3m_pct ?? 0),
          capturedAt,
          updatedAt,
          signalTs,
          sourceTs,
          ageSeconds,
          payload: raw,
        };
      })
      .filter((x): x is {
        market: string;
        score: number;
        volumeMultiple: number;
        breakout: boolean;
        closeUpperHold: boolean;
        rise3mPct: number;
        capturedAt: string | null;
        updatedAt: string | null;
        signalTs: string | null;
        sourceTs: string | null;
        ageSeconds: number | null;
        payload: ScannerFeedSignal;
      } => Boolean(x))
      .sort((a, b) => b.score - a.score);

    console.info(
      JSON.stringify({
        tag: "LIVE_TICK_SCANNER_FEED_SNAPSHOT",
        ts: new Date().toISOString(),
        tick_lease: myLease,
        scanner_feed_raw_rows: scannerFeed.length,
        scanner_candidates_sorted: scannerCandidates.length,
        scanner_feed_newest_ts: scannerFeedNewestTs,
      }),
    );

    // [SURGE-BRIDGE-REPAIR] If in shadow/external mode, merge candidates from surge-candidates.json
    let scannerRuntimeModeRaw = String(process.env.LIVE_SCANNER_RUNTIME_MODE ?? "legacy").toLowerCase().trim();
    if (scannerRuntimeModeRaw === "shadow" || scannerRuntimeModeRaw === "external") {
      const shadow = loadSurgeCandidatesShadow();
      if (shadow && shadow.items.length > 0) {
        console.info(JSON.stringify({
          tag: "LIVE_SURGE_SOURCE_REPAIR_PROOF",
          ts: new Date().toISOString(),
          stage: "merging_external_shadow_candidates",
          external_count: shadow.items.length,
          updated_at: shadow.updated_at
        }));
        
        for (const item of shadow.items) {
           const existingIdx = scannerCandidates.findIndex(c => c.market === item.market);
           const wrappedItem = {
              market: item.market,
              score: Number(item.scanner_score ?? 0),
              volumeMultiple: Number(item.volume_multiple ?? 0),
              breakout: Boolean(item.filter_pass), // best-effort: treat filter_pass as composite breakout+close hold
              closeUpperHold: Boolean(item.filter_pass),
              rise3mPct: 0, 
              capturedAt: shadow.updated_at,
              updatedAt: shadow.updated_at,
              signalTs: item.signal_ts,
              sourceTs: item.signal_ts || shadow.updated_at,
              ageSeconds: item.age_seconds,
              payload: {
                 v: 2,
                 market: item.market,
                 score: Number(item.scanner_score ?? 0),
                 signal_score: Number(item.scanner_score ?? 0),
                 volume_ratio: Number(item.volume_multiple ?? 0),
                 volume_multiple: Number(item.volume_multiple ?? 0),
                 breakout: Boolean(item.filter_pass),
                 close_upper_hold: Boolean(item.filter_pass),
                 filter_pass: Boolean(item.filter_pass),
                 source_kind: item.source_kind || "scanner_tradable_candidate",
                 reason: "scanner_external_bridge",
                 updated_at: shadow.updated_at,
                 signal_ts: item.signal_ts
              } as any
           };
           
           if (existingIdx >= 0) {
              const existing = scannerCandidates[existingIdx]!;
              const existingTs = existing.sourceTs ? Date.parse(existing.sourceTs) : 0;
              const newTs = wrappedItem.sourceTs ? Date.parse(wrappedItem.sourceTs) : 0;
              if (newTs >= existingTs) {
                 scannerCandidates[existingIdx] = wrappedItem;
              }
           } else {
              scannerCandidates.push(wrappedItem);
           }
        }
      }
    }

    for (const row of scannerCandidates) {
      const existing = latestAllSignals.get(row.market);
      const existingTs = signalCandidateTimestamp(existing);
      const existingMs = existingTs ? Date.parse(existingTs) : NaN;
      const scannerMs = row.sourceTs ? Date.parse(row.sourceTs) : NaN;
      const shouldBridge = !existing || (Number.isFinite(scannerMs) && (!Number.isFinite(existingMs) || scannerMs >= existingMs));
      if (!shouldBridge) continue;
      const scannerBridge = computeScannerBridgeScore({
        scannerScore: row.score,
        volumeMultiple: row.volumeMultiple,
        breakout: row.breakout,
        closeUpperHold: row.closeUpperHold,
        rise3mPct: row.rise3mPct,
        ageSeconds: row.ageSeconds,
        staleThresholdSeconds: LIVE_ENTRY_SIGNAL_STALE_SECONDS,
      });
      const bridgedFilterPass = scannerBridge.pass;
      latestAllSignals.set(row.market, {
        ts: row.sourceTs ?? new Date().toISOString(),
        p: {
          v: 2,
          market: row.market,
          signal_type: row.score >= 72 ? "HIGH" : "MID",
          signal_reason: String(row.payload.reason ?? "scanner_tradable_candidate"),
          filter_pass: bridgedFilterPass,
          filter_fail_reason: bridgedFilterPass ? null : "scanner_bridge_score_fail",
          filters: [
            { id: "volume_increase", label: "Scanner Volume Multiple", passed: row.volumeMultiple >= 1.2, detail: `vm=${row.volumeMultiple.toFixed(2)}` },
            { id: "box_breakout", label: "Scanner Breakout", passed: row.breakout },
            { id: "volume_spike_close_fail", label: "Scanner Upper Hold", passed: row.closeUpperHold },
          ],
          volume_ratio: row.volumeMultiple,
          signal_score: Number(row.payload.score ?? 0),
          scanner_score: row.score,
          breakout: row.breakout,
          close_upper_hold: row.closeUpperHold,
          rise_3m_pct: row.rise3mPct,
          scanner_tradable_candidate: true,
          signal_ts: row.signalTs ?? row.sourceTs,
          updated_at: row.updatedAt ?? row.sourceTs,
          captured_at: row.capturedAt ?? row.sourceTs,
          source_kind: bridgedFilterPass ? "scanner_tradable_candidate" : "scanner_bridge_score_fail",
        },
      });
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
    const scannerCandidatesExcludingHeld = scannerCandidates.filter((x) => !heldSymbolSet.has(x.market));
    const staleThresholdSeconds = LIVE_ENTRY_SIGNAL_STALE_SECONDS;
    for (const c of scannerCandidatesExcludingHeld.slice(0, 80)) {
      console.info(
        JSON.stringify({
          tag: "LIVE_SCANNER_STALE_DECISION",
          ts: new Date().toISOString(),
          market: c.market,
          captured_at: c.capturedAt,
          updated_at: c.updatedAt,
          signal_ts: c.signalTs,
          age_seconds: c.ageSeconds,
          stale_threshold_seconds: staleThresholdSeconds,
          dropped: c.ageSeconds === null || c.ageSeconds > staleThresholdSeconds,
        }),
      );
    }
    const freshScannerCandidates = scannerCandidatesExcludingHeld.filter((x) => x.ageSeconds !== null && x.ageSeconds <= staleThresholdSeconds);
    const staleScannerCandidates = scannerCandidatesExcludingHeld.filter((x) => x.ageSeconds === null || x.ageSeconds > staleThresholdSeconds);
    // [LIVE_SURGE_SOURCE_REPAIR_PROOF] scanner source 상태 및 repair 결과 진단 로그
    const newestScannerAgeSeconds = scannerCandidatesExcludingHeld.length > 0
      ? Math.min(...scannerCandidatesExcludingHeld.map((x) => x.ageSeconds ?? Infinity).filter(Number.isFinite))
      : null;
    console.info(
      JSON.stringify({
        tag: "LIVE_SURGE_SOURCE_REPAIR_PROOF",
        ts: new Date().toISOString(),
        scanner_candidates_count: scannerCandidatesExcludingHeld.length,
        fresh_scanner_candidates_count: freshScannerCandidates.length,
        stale_scanner_candidates_count: staleScannerCandidates.length,
        selected_surge_candidates: freshScannerCandidates.map((x) => x.market).slice(0, 10),
        selected_source: freshScannerCandidates.length > 0 ? "scanner_filter_fresh" : "fresh_filter_pass_only",
        newest_scanner_age_seconds: Number.isFinite(newestScannerAgeSeconds ?? NaN) ? newestScannerAgeSeconds : null,
        stale_threshold_seconds: staleThresholdSeconds,
        scanner_feed_newest_ts: scannerFeedNewestTs,
      }),
    );
    const freshFilterPassCandidates = Array.from(latestAllSignals.entries())
      .map(([market, sig]) => {
        if (!Boolean(sig?.p?.filter_pass) || heldSymbolSet.has(market)) return null;
        const sourceTs = signalCandidateTimestamp(sig);
        const ageSeconds = sourceTs ? Math.max(0, Math.floor((Date.now() - Date.parse(sourceTs)) / 1000)) : null;
        const gate = opts.marketState.entryGate(sig.p, marketState);
        return { market, sourceTs, ageSeconds, score: Number(gate.score ?? 0), vol: Number(sig?.p?.volume_ratio ?? 0) };
      })
      .filter(
        (x): x is { market: string; sourceTs: string | null; ageSeconds: number | null; score: number; vol: number } =>
          Boolean(x && x.ageSeconds !== null && x.ageSeconds <= staleThresholdSeconds),
      )
      .sort((a, b) => b.score - a.score || b.vol - a.vol);
    const staleFilterPassCandidates = Array.from(latestAllSignals.entries())
      .map(([market, sig]) => {
        if (!Boolean(sig?.p?.filter_pass) || heldSymbolSet.has(market)) return null;
        const sourceTs = signalCandidateTimestamp(sig);
        const ageSeconds = sourceTs ? Math.max(0, Math.floor((Date.now() - Date.parse(sourceTs)) / 1000)) : null;
        if (ageSeconds !== null && ageSeconds <= staleThresholdSeconds) return null;
        return { market, ageSeconds };
      })
      .filter((x): x is { market: string; ageSeconds: number | null } => Boolean(x));

    const selectedSourceRows: Array<{
      market: string;
      source_kind: "scanner_filter_fresh" | "fresh_filter_pass";
      source_ts: string | null;
      age_seconds: number | null;
    }> = [];
    const entrySourceKindByMarket = new Map<string, string>();
    for (const s of freshScannerCandidates) {
      if (selectedSourceRows.some((x) => x.market === s.market)) continue;
      selectedSourceRows.push({
        market: s.market,
        source_kind: "scanner_filter_fresh",
        source_ts: s.sourceTs,
        age_seconds: s.ageSeconds,
      });
      if (selectedSourceRows.length >= LIVE_ENTRY_UNIVERSE_TOP_N) break;
    }
    if (selectedSourceRows.length < LIVE_ENTRY_UNIVERSE_TOP_N) {
      for (const f of freshFilterPassCandidates) {
        if (selectedSourceRows.some((x) => x.market === f.market)) continue;
        selectedSourceRows.push({
          market: f.market,
          source_kind: "fresh_filter_pass",
          source_ts: f.sourceTs,
          age_seconds: f.ageSeconds,
        });
        if (selectedSourceRows.length >= LIVE_ENTRY_UNIVERSE_TOP_N) break;
      }
    }

    // CORE reserve slots: ensure core fresh_filter_pass candidates aren't crowded out by low-score scanner candidates.
    // Not a per-symbol exception buy: the reserve applies to MARKETS 기반 CORE_TREND_ENTRY 후보군 전체.
    if (LIVE_CORE_ENTRY_RESERVE_SLOTS > 0) {
      const selectedBefore = selectedSourceRows.map((x) => x.market);
      const replacedSymbols: string[] = [];
      const reservedSymbols: string[] = [];
      const coreReserveCandidates = freshFilterPassCandidates.filter((f) => {
        if (!CORE_TREND_ENTRY_MARKETS.has(f.market)) return false;
        const sig = latestAllSignals.get(f.market);
        if (String(sig?.p?.source_kind ?? "") === "fallback_watch_markets") return false;
        if (heldSymbolSet.has(f.market)) return false;
        if (f.ageSeconds === null || f.ageSeconds > staleThresholdSeconds) return false;
        return true;
      });
      const desired = Math.min(LIVE_ENTRY_UNIVERSE_TOP_N, LIVE_CORE_ENTRY_RESERVE_SLOTS, coreReserveCandidates.length);
      for (const f of coreReserveCandidates.slice(0, desired)) {
        if (selectedSourceRows.some((x) => x.market === f.market)) continue;

        // Prefer dropping scanner-derived rows (often includes scanner_bridge_score_fail) over fresh_filter_pass rows.
        let dropIdx = -1;
        for (let i = selectedSourceRows.length - 1; i >= 0; i--) {
          const row = selectedSourceRows[i]!;
          if (row.source_kind === "scanner_filter_fresh" && !CORE_TREND_ENTRY_MARKETS.has(row.market)) {
            dropIdx = i;
            break;
          }
        }
        if (dropIdx < 0) {
          for (let i = selectedSourceRows.length - 1; i >= 0; i--) {
            const row = selectedSourceRows[i]!;
            if (!CORE_TREND_ENTRY_MARKETS.has(row.market)) {
              dropIdx = i;
              break;
            }
          }
        }
        if (dropIdx < 0) break;

        const dropped = selectedSourceRows[dropIdx]!;
        replacedSymbols.push(dropped.market);
        reservedSymbols.push(f.market);
        selectedSourceRows.splice(dropIdx, 1, {
          market: f.market,
          source_kind: "fresh_filter_pass",
          source_ts: f.sourceTs,
          age_seconds: f.ageSeconds,
        });
      }

      const selectedAfter = selectedSourceRows.map((x) => x.market);
      console.info(
        JSON.stringify({
          tag: "CORE_ENTRY_RESERVE_SLOT_PROOF",
          ts: new Date().toISOString(),
          reserve_slots: LIVE_CORE_ENTRY_RESERVE_SLOTS,
          reserved_symbols: reservedSymbols,
          replaced_symbols: replacedSymbols,
          reason: "ensure_core_fresh_filter_pass_not_crowded_out",
          selected_before: selectedBefore,
          selected_after: selectedAfter,
        }),
      );
    }
    const selectedEntryUniverseSymbols = selectedSourceRows.map((x) => x.market);
    const filterPassVsSelectedExplain: Record<string, string> = {};
    for (const m of filterPassCandidatesExcludingHeld) {
      if (selectedEntryUniverseSymbols.includes(m)) continue;
      const sig = latestAllSignals.get(m);
      const ts = sig ? signalCandidateTimestamp(sig) : null;
      const ageSec = ts ? Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1000)) : null;
      if (ageSec === null || ageSec > staleThresholdSeconds) {
        filterPassVsSelectedExplain[m] = `stale_or_missing_age(age=${ageSec},threshold=${staleThresholdSeconds})`;
      } else if (freshScannerCandidates.some((x) => x.market === m)) {
        filterPassVsSelectedExplain[m] = `fresh_scanner_but_not_ranked_top_${LIVE_ENTRY_UNIVERSE_TOP_N}`;
      } else if (freshFilterPassCandidates.some((x) => x.market === m)) {
        filterPassVsSelectedExplain[m] = `fresh_filter_pass_but_not_ranked_top_${LIVE_ENTRY_UNIVERSE_TOP_N}`;
      } else {
        filterPassVsSelectedExplain[m] = "not_in_fresh_scanner_or_fresh_filter_pass_streams";
      }
    }
    console.info(
      JSON.stringify({
        tag: "ENTRY_PIPELINE_FILTER_PASS_VS_SELECTED_PRIMARY",
        ts: new Date().toISOString(),
        filter_pass_excluding_held_count: filterPassCandidatesExcludingHeld.length,
        selected_primary_count: selectedEntryUniverseSymbols.length,
        top_n: LIVE_ENTRY_UNIVERSE_TOP_N,
        filter_pass_not_selected_explain: filterPassVsSelectedExplain,
        selected_symbols: selectedEntryUniverseSymbols,
      }),
    );
    for (const m of selectedSourceRows) {
      entrySourceKindByMarket.set(m.market, m.source_kind);
      sourceMetaByMarket.set(m.market, { ...m, stale_filtered_before_eval: false });
    }
    const candidateSourceModeRaw = String(process.env.LIVE_SURGE_CANDIDATE_SOURCE ?? "legacy").toLowerCase().trim();
    const candidateSourceMode =
      candidateSourceModeRaw === "file" || candidateSourceModeRaw === "shadow" || candidateSourceModeRaw === "legacy"
        ? (candidateSourceModeRaw as "legacy" | "shadow" | "file")
        : "legacy";
    scannerRuntimeModeRaw = String(process.env.LIVE_SCANNER_RUNTIME_MODE ?? "legacy").toLowerCase().trim();
    const scannerRuntimeMode =
      scannerRuntimeModeRaw === "legacy" || scannerRuntimeModeRaw === "shadow" || scannerRuntimeModeRaw === "external"
        ? scannerRuntimeModeRaw
        : "legacy";
    const shadow = scannerRuntimeMode === "shadow" || scannerRuntimeMode === "external" ? loadSurgeCandidatesShadow() : null;
    console.info(
      JSON.stringify({
        tag: "LIVE_SURGE_CANDIDATE_SOURCE_STATE",
        ts: new Date().toISOString(),
        mode: scannerRuntimeMode,
        shadow_file_loaded: Boolean(shadow && (shadow.updated_at || shadow.items.length > 0)),
        shadow_items_count: shadow ? shadow.items.length : 0,
        shadow_updated_at: shadow?.updated_at ?? null,
        // controlled switch: order input stays legacy for shadow/file in this phase
        order_input_source: "legacy",
      }),
    );
    if (shadow) {
      const legacyByMarket = new Map(scannerCandidatesExcludingHeld.map((x) => [x.market, x]));
      const oldSet = new Set(Array.from(legacyByMarket.keys()));
      const selectedLegacySet = new Set(selectedEntryUniverseSymbols);
      const newSet = new Set(shadow.items.map((x) => x.market));
      const union = Array.from(new Set([...Array.from(oldSet), ...Array.from(newSet)])).slice(0, 40);
      const oldPassBy = new Map(latestAllSignals.entries());
      const newBy = new Map(shadow.items.map((x) => [x.market, x]));
      const rows = union
        .map((market) => {
          const legacy = legacyByMarket.get(market);
          const legacy_present = Boolean(legacy);
          const engine2_present = newSet.has(market);
          const legacy_score = legacy ? Number(legacy.score ?? 0) : null;
          const oldSig = oldPassBy.get(market);
          const legacy_filter_pass = Boolean(oldSig?.p?.filter_pass);
          const newItem = newBy.get(market) ?? null;
          const engine2_score = newItem ? Number(newItem.scanner_score ?? 0) : null;
          const engine2_valid = Boolean(newItem && newItem.filter_pass);
          const legacy_age_seconds = legacy?.ageSeconds ?? null;
          const engine2_age_seconds = newItem?.age_seconds ?? null;
          const selected_by_legacy = selectedLegacySet.has(market);
          const selected_by_engine2 = Boolean(engine2_present && engine2_valid);
          return {
            market,
            legacy_present,
            engine2_present,
            legacy_score,
            engine2_score,
            legacy_filter_pass,
            engine2_valid,
            legacy_age_seconds,
            engine2_age_seconds,
            selected_by_legacy,
            selected_by_engine2,
            order_input_source: "legacy",
          };
        })
        .filter((r) => r.legacy_present || r.engine2_present)
        .slice(0, 25);
      for (const r of rows) {
        console.info(
          JSON.stringify({
            tag: "ENGINE2_SCANNER_SHADOW_COMPARE",
            ts: new Date().toISOString(),
            mode: scannerRuntimeMode,
            candidate_source_mode: candidateSourceMode,
            shadow_updated_at: shadow.updated_at,
            shadow_path: shadow.path.replace(/\\/g, "/"),
            ...r,
          }),
        );
      }
    }
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
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_ENTRY_SOURCE_FRESHNESS",
        ts: new Date().toISOString(),
        source_kind: "scanner_then_filter_pass",
        candidate_symbols: selectedSourceRows.map((x) => x.market),
        candidate_source_rows: selectedSourceRows.map((x) => ({
          symbol: x.market,
          source_kind: x.source_kind,
          age_seconds: x.age_seconds,
        })),
        candidate_age_seconds: selectedSourceRows.map((x) => ({ symbol: x.market, age_seconds: x.age_seconds })),
        dropped_stale_symbols: [
          ...staleScannerCandidates.map((x) => ({ symbol: x.market, source_kind: "scanner_filter_fresh", age_seconds: x.ageSeconds })),
          ...staleFilterPassCandidates.map((x) => ({ symbol: x.market, source_kind: "legacy_filter_pass", age_seconds: x.ageSeconds })),
        ].slice(0, 30),
        stale_threshold_seconds: staleThresholdSeconds,
      }),
    );
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_FRESH_SCANNER_BRIDGE",
        ts: new Date().toISOString(),
        scanner_symbols: freshScannerCandidates.map((x) => x.market).slice(0, 20),
        filter_pass_symbols: freshFilterPassCandidates.map((x) => x.market).slice(0, 20),
        selected_source_rows: selectedSourceRows.map((x) => ({ symbol: x.market, source_kind: x.source_kind })).slice(0, 20),
        selected_entry_universe_symbols: selectedEntryUniverseSymbols,
        source_priority_used: freshScannerCandidates.length > 0 ? "scanner_then_filter_pass" : "filter_pass_only",
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
        const failed = filters.filter((f: { id: string; passed: boolean }) => f && f.passed === false).map((f: { id: string; passed: boolean }) => String(f.id));
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
    const fallbackUsedForPrimary = selectedEntryUniverseSymbols.length === 0;
    const tickerRequestSourceKind = fallbackUsedForPrimary ? "fallback_watch_markets" : "scanner_then_filter_pass";
    const watchMarketsExcludingHeld = watchMarkets.filter((m) => !heldSymbolSet.has(m)).slice(0, LIVE_ENTRY_UNIVERSE_TOP_N);
    const primaryForUniverse = fallbackUsedForPrimary ? watchMarketsExcludingHeld : selectedEntryUniverseSymbols;
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
        realtime_symbol_roles: tickerRequestedSymbols.slice(0, 40).map((m) => {
          let realtime_display_kind:
            | "fresh_signal_primary_selected"
            | "exception_slot_augment"
            | "debug_universe_extra"
            | "display_augment_held_or_btc_anchor"
            | "watch_fallback_discovery_primary"
            | "watch_list_only_no_fresh_selection"
            | "other";
          if (selectedEntryUniverseSymbols.includes(m)) realtime_display_kind = "fresh_signal_primary_selected";
          else if (exceptionSlotMarket === m) realtime_display_kind = "exception_slot_augment";
          else if (debugUniverseExtra.includes(m)) realtime_display_kind = "debug_universe_extra";
          else if (heldExtraSymbols.includes(m)) realtime_display_kind = "display_augment_held_or_btc_anchor";
          else if (fallbackUsedForPrimary && watchMarketsExcludingHeld.includes(m))
            realtime_display_kind = "watch_fallback_discovery_primary";
          else if (watchMarkets.includes(m)) realtime_display_kind = "watch_list_only_no_fresh_selection";
          else realtime_display_kind = "other";
          return { market: m, realtime_display_kind };
        }),
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
      tickerRows = await racePhase("fetch_tickers", PHASE_MS.fetch_tickers, () =>
        fetchTickers(tickerRequestedSymbols, {
          debugCaller: "live-strategy",
          signal: tickSignal,
        }),
      );
    } catch (e) {
      const aborted =
        tickSignal.aborted ||
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError");
      console.info(
        JSON.stringify({
          tag: aborted ? "DEBUG_TICKER_FETCH_ABORTED" : "DEBUG_TICKER_FETCH_ERROR",
          ts: new Date().toISOString(),
          stage: "after_scanner_before_tickers",
          reason: aborted ? "fetch_tickers_aborted" : "fetch_tickers_throw",
          error_message: e instanceof Error ? e.message : String(e),
          requested_symbols: tickerRequestedSymbols.slice(0, 30),
        }),
      );
      // [ISOLATION] Do not rethrow to prevent tick halt. tickerRows will be empty.
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

    if (!leaseOk()) {
      console.info(
        JSON.stringify({
          tag: "LIVE_TICK_LEASE_REVOKED_SHORT_CIRCUIT",
          ts: new Date().toISOString(),
          stage: "after_ticker_fetch",
          tick_lease: myLease,
          valid_lease: liveTickValidLease,
        }),
      );
      return;
    }
    const priceBy = new Map(tickerRows.map((r) => [r.market, r.trade_price]));
    const changeRateBy = new Map(tickerRows.map((r) => [r.market, Number(r.signed_change_rate ?? 0)]));
    const minute1CandleCache = new Map<string, UpbitCandle[]>();
    const minute5CandleCache = new Map<string, UpbitCandle[]>();
    const fetchMinuteCandlesCached = async (market: string, unit: 1 | 5, count: number): Promise<UpbitCandle[]> => {
      const cache = unit === 1 ? minute1CandleCache : minute5CandleCache;
      const key = `${market}:${count}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const candlePhase = `fetch_minute_candles:${market}:u${unit}:n${count}`;
      const rows = await racePhase(candlePhase, PHASE_MS.fetch_minute_candles, () =>
        fetchMinuteCandles(market, unit, count, tickSignal),
      );
      cache.set(key, rows);
      return rows;
    };

    // candidate_meta candle fetch limiter (to avoid hammering Upbit with 1m/200 in parallel)
    const candleFetchLimiter = (() => {
      const concurrency = LIVE_CANDIDATE_CANDLE_FETCH_CONCURRENCY;
      let active = 0;
      const queue: Array<() => void> = [];
      const pump = () => {
        while (active < concurrency && queue.length > 0) {
          const next = queue.shift();
          if (next) next();
        }
      };
      return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= concurrency) {
          await new Promise<void>((resolve) => queue.push(resolve));
        }
        active += 1;
        try {
          return await fn();
        } finally {
          active -= 1;
          pump();
        }
      };
    })();

    const isAbortLike = (e: unknown): boolean => {
      if (tickSignal.aborted) return true;
      if (e instanceof DOMException && e.name === "AbortError") return true;
      if (e instanceof Error && e.name === "AbortError") return true;
      const msg = e instanceof Error ? e.message : String(e);
      return typeof msg === "string" && msg.toLowerCase().includes("aborted");
    };

    const fetchCandidateMetaCandles1m200 = async (
      market: string,
    ): Promise<{ rows: UpbitCandle[]; candle_source: "live_fetch" | "last_good_cache"; cache_age_ms: number | null }> => {
      const unit = 1 as const;
      const count = 200 as const;
      const key = `${market}:u${unit}:n${count}`;
      const timeoutMs = Math.min(PHASE_MS.fetch_minute_candles, LIVE_CANDIDATE_CANDLE_FETCH_TIMEOUT_MS);
      const t0 = Date.now();

      console.info(
        JSON.stringify({
          tag: "LIVE_CANDIDATE_CANDLE_FETCH_START",
          ts: new Date().toISOString(),
          market,
          timeframe: `${unit}m`,
          timeout_ms: timeoutMs,
          source: "live_fetch",
          cache_age_ms: null,
        }),
      );

      try {
        const rows = await candleFetchLimiter(async () => {
          const phase = `candidate_meta_fetch_minute_candles:${market}:u${unit}:n${count}`;
          const fetched = await racePhase(phase, timeoutMs, () => fetchMinuteCandles(market, unit, count, tickSignal));
          minute1CandleCache.set(`${market}:${count}`, fetched);
          return fetched;
        });

        console.info(
          JSON.stringify({
            tag: "LIVE_CANDIDATE_CANDLE_FETCH_DONE",
            ts: new Date().toISOString(),
            market,
            timeframe: `${unit}m`,
            timeout_ms: timeoutMs,
            elapsed_ms: Date.now() - t0,
            source: "live_fetch",
            cache_age_ms: null,
            rows: rows.length,
          }),
        );

        lastGoodMinuteCandleCache.set(key, { ts_ms: Date.now(), rows, unit, count });
        return { rows, candle_source: "live_fetch", cache_age_ms: null };
      } catch (e) {
        // Abort is its own class of drop reason (do not mix with candle_fetch_error)
        if (isAbortLike(e)) {
          const phase = isLiveTickPhaseTimeout(e) ? e.phase : "candidate_meta_fetch_minute_candles:aborted";
          const abort_reason = tickSignal.aborted
            ? "tick_abort_signal"
            : e instanceof Error && e.name === "AbortError"
              ? "abort_error"
              : "aborted_message";
          console.info(
            JSON.stringify({
              tag: "LIVE_CANDIDATE_CANDLE_FETCH_ABORTED",
              ts: new Date().toISOString(),
              market,
              phase,
              elapsed_ms: Date.now() - t0,
              abort_reason,
            }),
          );
          throw e;
        }

        if (isLiveTickPhaseTimeout(e) && e.phase.startsWith("candidate_meta_fetch_minute_candles:")) {
          const lastGood = lastGoodMinuteCandleCache.get(key);
          const cacheAgeMs = lastGood?.ts_ms ? Date.now() - lastGood.ts_ms : Infinity;

          console.info(
            JSON.stringify({
              tag: "LIVE_CANDIDATE_CANDLE_FETCH_TIMEOUT",
              ts: new Date().toISOString(),
              market,
              timeframe: `${unit}m`,
              timeout_ms: e.timeout_ms,
              elapsed_ms: Date.now() - t0,
              source: "live_fetch",
              cache_age_ms: Number.isFinite(cacheAgeMs) ? cacheAgeMs : null,
              phase: e.phase,
            }),
          );

          // Core majors only: allow evaluation using last_good candle cache when it's fresh enough.
          if (CORE_MAJOR_MARKETS.has(market) && lastGood?.rows?.length && cacheAgeMs <= LIVE_LAST_GOOD_CANDLE_MAX_AGE_MS) {
            const rows = lastGood.rows;
            console.info(
              JSON.stringify({
                tag: "LIVE_CANDIDATE_CANDLE_FETCH_FALLBACK_USED",
                ts: new Date().toISOString(),
                market,
                cache_age_ms: cacheAgeMs,
                rows: rows.length,
                original_error: "timeout",
                original_timeout_ms: e.timeout_ms,
                candle_source: "last_good_cache",
              }),
            );
            console.info(
              JSON.stringify({
                tag: "LIVE_CANDIDATE_CANDLE_FETCH_DONE",
                ts: new Date().toISOString(),
                market,
                timeframe: `${unit}m`,
                timeout_ms: e.timeout_ms,
                elapsed_ms: 0,
                source: "last_good_cache",
                cache_age_ms: cacheAgeMs,
                rows: rows.length,
              }),
            );
            // IMPORTANT: fallback success must not fall through into candle_fetch_error drop.
            return { rows, candle_source: "last_good_cache", cache_age_ms: cacheAgeMs };
          }

          throw e;
        }

        throw e;
      }
    };
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
        // [HARDENED] budget-aware promotion calculation
        const minOrderFallback = Math.max(UPBIT_MIN_ORDER_KRW, LIVE_MIN_ENTRY_KRW);
        const targetBudget = ep.target_budget_krw ?? minOrderFallback;
        const filledSoFar = ep.filled_entry_krw ?? (ep.qty * ep.entry_price);
        const promoteFillKrw = Math.max(0, Math.floor(targetBudget - filledSoFar));
        if (promoteFillKrw >= UPBIT_MIN_ORDER_KRW) {
          try {
            if (!assertLiveOrderAuthority("early_promote_before_attempt")) {
              /* revoked — no fill; keep early position state */
            } else {
              console.info(
                JSON.stringify({
                  tag: "LIVE_PLACEBUY_ATTEMPT_FINAL_GATE",
                  ts: new Date().toISOString(),
                  market,
                  path: "early_promote_fill",
                  final_block_reason: null,
                  candidate_meta_missing_reason: null,
                  entry_mode: "EARLY_PROMOTE_FILL",
                  preclearance_snapshot: {
                    promote_fill_krw: promoteFillKrw,
                    breakout_promote: breakoutNow,
                    held_seconds: heldSec,
                    pnl_gross_pct: pnlGross,
                  },
                  tick_lease: myLease,
                }),
              );
              console.info(
                JSON.stringify({
                  tag: "LIVE_PLACEBUY_ATTEMPT",
                  ts: new Date().toISOString(),
                  market,
                  path: "early_promote_fill",
                  order_krw: promoteFillKrw,
                  strategy_type: "momentum",
                  tick_lease: myLease,
                }),
              );
              if (!assertLiveOrderAuthority("early_promote_before_placebuy")) {
                /* race: lease revoked between logs */
              } else {
                await opts.trade.placeBuy(market, true, promoteFillKrw, "momentum", "strategy", {
                  __early_promote_fill: true,
                  __early_promote_fill_krw: promoteFillKrw,
                });
              }
            }
          } catch {
            // keep running with current size if promote fill fails
          }
        }
        // 승격: normal 포지션으로 이동 (기존 exit 로직 적용)
        const stNow = await raceTradeStatus("early_promote_post_fill");
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
          entry_origin: ep.entry_origin ?? "auto_trade",
          entry_mode: ep.entry_mode ?? "CORE",
          market_state_at_entry: ep.market_state_at_entry,
          btc_tier_at_entry: ep.btc_tier_at_entry,
          volatility_pct_at_entry: Number(ep.volatility_pct_at_entry ?? 0),
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

      let reasonExit = "";
      let stopTriggerKind: StopTriggerKind | null = null;
      let ratio = 1;
      let exitAuthorityClass: ExitAuthorityDecision["authorityClass"] = "none";
      let exitReasonDetail = "legacy_flow";

      // [ORIGINAL SETUP] Primary Exit Authority Enforcement
      if (p.entry_stop_price && now <= p.entry_stop_price) {
        reasonExit = "original_setup_stop_loss";
        stopTriggerKind = "price_stop";
      } else if (p.entry_target_price && now >= p.entry_target_price) {
        reasonExit = "original_setup_target_tp";
        stopTriggerKind = "price_stop";
      }

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
      const isSurge = isSurgePosition(p);
      const surgePolicyApplies = isSurge && p.entry_origin === "auto_trade" && p.entry_mode === "SURGE_V2";

      if (isSurge && !surgePolicyApplies) {
        console.info(
          JSON.stringify({
            tag: "SURGE_POSITION_EXIT_POLICY_PROOF",
            ts: new Date().toISOString(),
            market,
            applies: false,
            reason: "surge_policy_skipped_non_auto_trade_or_missing_mode",
            entry_origin: p.entry_origin ?? null,
            entry_mode: (p as any).entry_mode ?? null,
          }),
        );
      } else if (surgePolicyApplies) {
        console.info(
          JSON.stringify({
            tag: "SURGE_POSITION_EXIT_POLICY_PROOF",
            ts: new Date().toISOString(),
            market,
            applies: true,
            entry_origin: p.entry_origin,
            entry_mode: p.entry_mode,
            market_state_at_entry: p.market_state_at_entry ?? null,
            btc_tier_at_entry: p.btc_tier_at_entry ?? null,
            volatility_pct_at_entry: Number(p.volatility_pct_at_entry ?? 0),
            stop_band_soft_floor_pct: -1.2,
            stop_band_hard_floor_pct: -1.8,
            hard_stop_pct: -2.0,
          }),
        );
      }

      let isSurgeExitDecision = false;
      // SURGE_V2 early failure triggers (post-entry) — only for auto-trade entered positions.
      if (surgePolicyApplies && !reasonExit) {
        const sig = latestAllSignals.get(market);
        const payload = sig?.p;
        const scoreNow = payload ? signalStrengthScore(payload) : 0;
        const volumeRatioNow = payload ? Number(payload.volume_ratio ?? 0) : 0;
        const filters = Array.isArray(payload?.filters) ? (payload!.filters as Array<{ id: string; passed: boolean }>) : [];
        const hasFailed = (re: RegExp) => filters.some((f) => re.test(String(f.id)) && f.passed === false);

        let earlyFailureTrigger: string | null = null;
        if (scoreNow > 0 && scoreNow < ENTRY_PIPELINE_MID_SCORE_FLOOR) earlyFailureTrigger = "score_below_threshold";
        else if (volumeRatioNow > 0 && volumeRatioNow < 0.75 && holdMin >= 3 && p.max_pnl_pct < 1.2) earlyFailureTrigger = "volume_fade_after_spike";
        else if (hasFailed(/upper_wick|high_reject|high_rejected/i)) earlyFailureTrigger = "high_rejected";
        else if (hasFailed(/retest|pullback|reclaim/i)) earlyFailureTrigger = "retest_fail";

        if (earlyFailureTrigger) {
          console.info(
            JSON.stringify({
              tag: "SURGE_EARLY_FAILURE_EXIT_PROOF",
              ts: new Date().toISOString(),
              market,
              trigger: earlyFailureTrigger,
              hold_minutes: holdMin,
              pnl_pct: pnlGross,
              max_pnl_pct: p.max_pnl_pct,
              volume_ratio: volumeRatioNow,
              score_now: scoreNow,
              filters_failed: filters.filter((f) => !f.passed).map((f) => f.id).slice(0, 8),
            }),
          );
          reasonExit = `surge_early_failure_${earlyFailureTrigger}`;
          stopTriggerKind = "price_stop";
          ratio = 1;
          exitAuthorityClass = "emergency_exit";
          exitReasonDetail = "surge_early_failure_policy";
          isSurgeExitDecision = true;
        }
      }

      if (surgePolicyApplies && !reasonExit) {
        const decision = evaluateSurgeExit(
          {
            ...p,
            market_state: marketState.market_state,
            btc_tier: state.regime?.btc_filter_state ?? "neutral",
            volatility_pct: p.volatility_pct_at_entry ?? null,
          },
          now,
        );
        if (decision.runnerTrailActive !== (p as any).runner_trail_active) {
          (p as any).runner_trail_active = decision.runnerTrailActive;
        }

        console.info(
          JSON.stringify({
            tag: "SURGE_V2_EXIT_DECISION_PROOF",
            ts: new Date().toISOString(),
            market,
            entry_price: p.entry_price,
            current_price: now,
            pnl_pct: pnlGross,
            max_pnl_pct: p.max_pnl_pct,
            hold_minutes: holdMin,
            partial_tp_done: p.partial_tp_done,
            is_surge_position: true,
            decision_action: decision.action,
            decision_reason: decision.reason,
            exit_ratio: decision.ratio,
            runner_trail_active: (p as any).runner_trail_active,
            authority_source: decision.authoritySource,
          }),
        );

        if (decision.action === "sell") {
          reasonExit = decision.reason;
          ratio = decision.ratio;
          stopTriggerKind = "price_stop";
          exitAuthorityClass = "emergency_exit";
          exitReasonDetail = "surge-v2-exit-engine";
          isSurgeExitDecision = true;
        }
      } else if (!isSurge && !reasonExit) {
        const weakModeTighterStop = (state.regime?.btc_filter_state ?? "neutral") === "weak" ? LIVE_BTC_WEAK_TIGHT_STOP_PCT : null;
        if (weakModeTighterStop !== null && pnlGross <= weakModeTighterStop) {
          reasonExit = "weak_market_price_stop";
          stopTriggerKind = "price_stop";
          exitAuthorityClass = "hard_loss";
          exitReasonDetail = "weak_tight_stop";
        }
        // Emergency stop loss — always allowed even within grace period.
        if (!reasonExit && pnlGross <= LIVE_EMERGENCY_STOP_LOSS_PCT) {
          reasonExit = "emergency_stop_loss";
          stopTriggerKind = "price_stop";
          exitAuthorityClass = "emergency_exit";
          exitReasonDetail = "emergency_stop_loss_threshold";
        }
        if (!reasonExit) {
          const auth = evaluateExitAuthority({
            p,
            pnlGross,
            heldMs,
            marketTier: state.regime?.btc_filter_state ?? "neutral",
            weakReboundPoor: p.max_pnl_pct < 0.6,
          });
          if (auth.reasonExit) {
            reasonExit = auth.reasonExit;
            ratio = auth.ratio;
            stopTriggerKind = auth.stopTriggerKind;
            exitAuthorityClass = auth.authorityClass;
            exitReasonDetail = auth.reasonDetail;
            if (auth.authorityClass === "breakeven_protect" && !p.breakeven_armed) {
              p.breakeven_armed = true;
              p.breakeven_armed_at = new Date().toISOString();
            }
            if (auth.authorityClass === "runner_trail") {
              p.trailing_stop_price = p.highest_price_after_entry * (1 - ((state.regime?.btc_filter_state ?? "neutral") === "weak" ? 1.8 : 2.2) / 100);
            }
          }
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
                const c1 = await fetchMinuteCandlesCached(market, 1, 8);
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
      }
      if (!reasonExit) continue;

      // Early micro-loss guard: avoid selling on tiny negative noise immediately after entry.
      const isStopLike =
        /stop|loss|catastrophic|time_stop_weak_rebound|momentum_time_stop|residual_full_exit_escalation/i.test(reasonExit) ||
        stopTriggerKind === "price_stop";
      const withinEarlyLossGuard = heldMs < LIVE_EXIT_EARLY_LOSS_GUARD_SECONDS * 1000;
      const blockedByMicroLoss = withinEarlyLossGuard && isStopLike && netPnlPctEst > LIVE_MIN_EXIT_LOSS_PCT && reasonExit !== "emergency_stop_loss";

      const emergencyExit =
        reasonExit.startsWith("surge_") ||
        isSurgeExitDecision ||
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
          exit_authority_class: exitAuthorityClass,
          exit_reason_detail: {
            chosen_reason: reasonExit,
            authority_class: exitAuthorityClass,
            authority_detail: exitReasonDetail,
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

      let placeSellOk = false;
      let placeSellReason = "unknown";
      console.info(
        JSON.stringify({
          tag: "LIVE_PLACESELL_ATTEMPT",
          ts: new Date().toISOString(),
          market,
          reason_exit: reasonExit,
          ratio,
          stop_trigger_kind: stopTriggerKind,
          authority_class: exitAuthorityClass,
          engine_bucket: isSurge ? "surge" : "core",
        }),
      );
      if (isSurge) {
        console.info(
          JSON.stringify({
            tag: "SURGE_V2_LIVE_EXIT_EXECUTION_PROOF",
            ts: new Date().toISOString(),
            market,
            reason_exit: reasonExit,
            ratio,
            stop_trigger_kind: stopTriggerKind,
            authority_class: exitAuthorityClass,
            execution_layer: "live-strategy",
            place_sell_called: true,
            place_sell_ok: null,
            place_sell_reason: "pending",
          }),
        );
      } else {
        console.info(
          JSON.stringify({
            tag: "CORE_EXIT_FINAL_DECISION_PROOF",
            ts: new Date().toISOString(),
            market,
            reason_exit: reasonExit,
            ratio,
            stop_trigger_kind: stopTriggerKind,
            authority_class: "core",
            execution_layer: "live-strategy",
            place_sell_called: true,
            place_sell_ok: null,
            place_sell_reason: "pending",
          }),
        );
      }
      try {
        await opts.trade.placeSell(market, true, ratio);
        placeSellOk = true;
        placeSellReason = "success";
      } catch (e) {
        placeSellOk = false;
        placeSellReason = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
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
      } finally {
        console.info(
          JSON.stringify({
            tag: "LIVE_PLACESELL_RESULT",
            ts: new Date().toISOString(),
            market,
            reason_exit: reasonExit,
            ratio,
            stop_trigger_kind: stopTriggerKind,
            authority_class: exitAuthorityClass,
            engine_bucket: isSurge ? "surge" : "core",
            place_sell_ok: placeSellOk,
            place_sell_reason: placeSellReason,
          }),
        );
        if (isSurge) {
          console.info(
            JSON.stringify({
              tag: "SURGE_V2_LIVE_EXIT_EXECUTION_PROOF",
              ts: new Date().toISOString(),
              market,
              reason_exit: reasonExit,
              ratio,
              stop_trigger_kind: stopTriggerKind,
              authority_class: exitAuthorityClass,
              execution_layer: "live-strategy",
              place_sell_called: true,
              place_sell_ok: placeSellOk,
              place_sell_reason: placeSellReason,
            }),
          );
        } else {
          console.info(
            JSON.stringify({
              tag: "CORE_EXIT_FINAL_DECISION_PROOF",
              ts: new Date().toISOString(),
              market,
              reason_exit: reasonExit,
              ratio,
              stop_trigger_kind: stopTriggerKind,
              authority_class: "core",
              execution_layer: "live-strategy",
              place_sell_called: true,
              place_sell_ok: placeSellOk,
              place_sell_reason: placeSellReason,
            }),
          );
        }
      }
      const after = await raceTradeStatus("exit_after_place_sell");
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
        position_id: p.position_id ?? `${market}|${p.entry_ts}`,
        entry_profile_key: p.entry_profile_key,
        entry_profile_decision: p.entry_profile_decision,
        target_budget_krw: p.target_budget_krw ?? p.order_krw,
        filled_entry_krw: p.filled_entry_krw ?? p.order_krw,
        exit_reason_detail: exitReasonDetail,
        exit_authority_class: exitAuthorityClass,
        partial_tp_done: p.partial_tp_done,
        breakeven_armed: p.breakeven_armed,
        runner_trail_active: p.partial_tp_done,
        realized_partial_profit: p.realized_partial_profit,
        final_net_pnl_pct: netPnlPctValue,
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
        if (p.entry_profile_key) {
          const prev = state.entry_profile_stats?.[p.entry_profile_key] ?? {
            total_trades: 0,
            wins: 0,
            losses: 0,
            weak_stops: 0,
            timeouts: 0,
            total_net_pnl_pct: 0,
            total_net_pnl_krw: 0,
            avg_net_pnl_pct: 0,
            win_rate: 0,
            recent_net_pnl_pct: [],
            last_updated_at: new Date().toISOString(),
          };
          const timeoutLike = /time_stop|timeout/i.test(reasonExit);
          const weakStopLike = /weak_market/i.test(reasonExit);
          const next: LiveEntryProfileStats = {
            ...prev,
            total_trades: prev.total_trades + 1,
            wins: prev.wins + (netPnlPctValue > 0 ? 1 : 0),
            losses: prev.losses + (netPnlPctValue <= 0 ? 1 : 0),
            weak_stops: prev.weak_stops + (weakStopLike ? 1 : 0),
            timeouts: prev.timeouts + (timeoutLike ? 1 : 0),
            total_net_pnl_pct: prev.total_net_pnl_pct + netPnlPctValue,
            total_net_pnl_krw: prev.total_net_pnl_krw + netPnlKrw,
            avg_net_pnl_pct: 0,
            win_rate: 0,
            recent_net_pnl_pct: [...prev.recent_net_pnl_pct, netPnlPctValue].slice(-8),
            last_updated_at: new Date().toISOString(),
          };
          next.avg_net_pnl_pct = next.total_trades > 0 ? next.total_net_pnl_pct / next.total_trades : 0;
          next.win_rate = next.total_trades > 0 ? next.wins / next.total_trades : 0;
          state.entry_profile_stats = state.entry_profile_stats ?? {};
          state.entry_profile_stats[p.entry_profile_key] = next;
        }
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

    const entryBlockedBySafety = state.safety_guard.state === "자동정지";
    const entryAllowed = !tradeStatusEntryBlocked && !entryBlockedBySafety;
    if (!entryAllowed) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_EXIT_PROOF",
          ts: new Date().toISOString(),
          stage: "entry_gate_check",
          reason: entryBlockedBySafety ? "safety_guard_stopped" : "trade_status_guard",
          auto_trade_enabled: Boolean(tstatus.auto_trade_enabled),
          api_connected: Boolean(tstatus.api_connected),
          live_enabled: Boolean(tstatus.live_enabled),
          safety_guard_state: state.safety_guard.state,
          has_open_positions: hasOpenPositions
        }),
      );
      await racePersist("early_exit_entry_gate");
      return;
    }

    // entries
    if (state.daily.entry_count >= 6) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_EARLY_EXIT_PROOF",
          ts: new Date().toISOString(),
          stage: "daily_count_cap",
          reason: "daily_entry_count_limit_reached",
          count: state.daily.entry_count
        }),
      );
      await racePersist("early_exit_daily_entry_cap");
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
      await racePersist("after_daily_pnl_guard_stop");
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
      await racePersist("after_consecutive_loss_guard_stop");
      return;
    }
    const exceptionSlot = state.regime?.exception_slot_market ?? null;
    const fallbackUsed = selectedEntryUniverseSymbols.length === 0;
    const inputSourceKind = fallbackUsed ? "fallback_watch_markets" : "scanner_then_filter_pass";
    const primary = fallbackUsed ? watchMarkets.filter((m) => !heldSymbolSet.has(m)).slice(0, LIVE_ENTRY_UNIVERSE_TOP_N) : selectedEntryUniverseSymbols;
    if (fallbackUsed) {
      for (const m of primary) {
        if (sourceMetaByMarket.has(m)) continue;
        entrySourceKindByMarket.set(m, "fallback_watch_markets");
        sourceMetaByMarket.set(m, {
          source_kind: "fallback_watch_markets",
          source_ts: null,
          age_seconds: null,
          stale_filtered_before_eval: false,
        });
      }
    }
    const baseEntryUniverseInput = Array.from(new Set([...primary, ...(exceptionSlot ? [exceptionSlot] : []), ...debugUniverseExtra]));
    console.info(
      JSON.stringify({
        tag: "SURGE_ENTRY_PIPELINE_PROOF",
        ts: new Date().toISOString(),
        stage: "initial_discovery",
        primary_source: fallbackUsed ? "watch_markets_fallback" : "filter_pass_fresh",
        filter_pass_count: filterPassCandidatesExcludingHeld.length,
        filter_pass_symbols: filterPassCandidatesExcludingHeld.slice(0, 20),
        watch_markets_count: watchMarkets.length,
        watch_markets_top: watchMarkets.slice(0, 15),
        fallback_used: fallbackUsed,
        base_entry_universe_count: baseEntryUniverseInput.length,
        base_entry_universe_symbols: baseEntryUniverseInput.slice(0, 30),
        note: fallbackUsed ? "USING_WATCH_MARKETS_FALLBACK_SOURCE" : "USING_FRESH_SIGNAL_SOURCE",
      }),
    );
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
          ? "fresh scanner/filter_pass empty → fallback to watchMarkets(topN)"
          : "primary=fresh_scanner_then_filter_pass + secondary(exceptionSlot, debugUniverseExtra)",
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
          tag: "DEBUG_LIVE_EARLY_EXIT_PROOF",
          ts: new Date().toISOString(),
          stage: "position_cap_check",
          reason: "max_positions_reached",
          open_count: openCount,
          max_positions: state.safety_guard.max_positions
        }),
      );
      await racePersist("early_exit_max_positions_cap");
      return;
    }
    const openStrategyMarkets = new Set(Object.keys(state.positions));
    const heldMeaningfulMarkets = new Set<string>();
    if (EXCLUDE_HELD_SYMBOLS_FROM_UNIVERSE) {
      for (const b of Array.isArray(tstatus.balances) ? tstatus.balances : []) {
        const currency = String(b.currency ?? "").toUpperCase();
        if (!currency || currency === "KRW") continue;
        const mk = `KRW-${currency}`;
        const qty = Number(b.balance ?? 0) + Number(b.locked ?? 0);
        const px = Number(priceBy.get(mk) ?? b.avg_buy_price ?? 0);
        const valueKrw = qty > 0 && px > 0 ? qty * px : 0;
        if (valueKrw >= EXISTING_POSITION_MIN_KRW) heldMeaningfulMarkets.add(mk);
      }
    }
    /** discovery_universe: 신규 급등주 탐색/진입용. 현재 보유(holdings) 종목은 제외한다. */
    const universeDroppedReasons: Record<string, string> = {};
    const entryUniverse = baseEntryUniverse.filter((m) => {
      if (heldSymbolSet.has(m)) {
        universeDroppedReasons[m] = "held_in_state_set";
        return false;
      }
      if (heldMeaningfulMarkets.has(m)) {
        universeDroppedReasons[m] = "held_meaningful_balance";
        return false;
      }
      return true;
    });
    console.info(
      JSON.stringify({
        tag: "SURGE_ENTRY_PIPELINE_PROOF",
        ts: new Date().toISOString(),
        stage: "universe_held_filtering",
        base_universe_count: baseEntryUniverse.length,
        entry_universe_count: entryUniverse.length,
        dropped_count: Object.keys(universeDroppedReasons).length,
        dropped_reasons: universeDroppedReasons,
        discrepancy_filter_pass_vs_universe: filterPassCandidatesExcludingHeld.filter(m => !entryUniverse.includes(m)).slice(0, 20),
        note: "discrepancy_usually_due_to_universe_top_n_cap_or_held_exclusion",
      }),
    );

    const filterPassVsEntryUniverseExplain: Record<string, string> = {};
    for (const m of filterPassCandidates) {
      if (entryUniverse.includes(m)) continue;
      if (universeDroppedReasons[m]) {
        filterPassVsEntryUniverseExplain[m] = `removed_at_universe_filter:${universeDroppedReasons[m]}`;
      } else if (!baseEntryUniverseInput.includes(m)) {
        filterPassVsEntryUniverseExplain[m] = filterPassCandidatesExcludingHeld.includes(m)
          ? filterPassVsSelectedExplain[m] ?? "filter_pass_not_in_base_entry_input_unknown"
          : "held_or_blocked_so_not_in_primary_discovery_streams";
      } else {
        filterPassVsEntryUniverseExplain[m] = "unexpected_filter_pass_vs_entry_universe_gap";
      }
    }
    console.info(
      JSON.stringify({
        tag: "ENTRY_PIPELINE_FILTER_PASS_VS_ENTRY_UNIVERSE",
        ts: new Date().toISOString(),
        filter_pass_total_count: filterPassCandidates.length,
        entry_universe_count: entryUniverse.length,
        filter_pass_missing_from_entry_universe_explain: filterPassVsEntryUniverseExplain,
        entry_universe_symbols: entryUniverse,
        base_entry_universe_symbols: baseEntryUniverseInput.slice(0, 30),
      }),
    );

    // [MONITOR] Loop Phase Log
    console.info(JSON.stringify({
      tag: "LIVE_TICK_IN_FLIGHT_AGE_PROOF",
      started_at: new Date(lastTickStartedAt).toISOString(),
      elapsed_ms: Date.now() - lastTickStartedAt,
      phase: "universe_filtered",
      reason: "pipeline_checkpoint"
    }));

    const strategyUsableKrwForAlloc = Math.max(
      0,
      Number(tstatus.strategy_available_krw ?? tstatus.live_order_available_krw ?? tstatus.krw_available ?? 0),
    );

    // Account-wide equity & cap policy (SURGE_V2 / spot live entry).
    // - Total equity = KRW cash(total) + all coin evaluated value (mark price; fallback avg if missing).
    // - Cap ratio is fixed at 50%.
    // - "Used" includes: evaluated value of in-scope holdings (managed + passive holdings shown/managed by the engine) + pending/reserved buy KRW.
    const reservedKrw = Math.max(0, Number((tstatus as any).reserved_krw ?? 0));
    let accountSpotHoldingsValueKrw = 0;
    for (const b of Array.isArray(tstatus.balances) ? tstatus.balances : []) {
      const currency = String(b.currency ?? "").toUpperCase();
      if (!currency || currency === "KRW") continue;
      const mk = `KRW-${currency}`;
      const qty = Number(b.balance ?? 0) + Number(b.locked ?? 0);
      const px = Number(priceBy.get(mk) ?? b.avg_buy_price ?? 0);
      if (qty > 0 && px > 0) accountSpotHoldingsValueKrw += qty * px;
    }
    const portfolioEquityKrwRaw = Number((tstatus as any)?.account_portfolio?.total_evaluated_krw ?? NaN);
    const fallbackEquityKrw = Math.max(0, Number((tstatus as any).total_krw ?? 0)) + Math.max(0, accountSpotHoldingsValueKrw);
    const totalLiveCapitalKrw = Math.floor(Number.isFinite(portfolioEquityKrwRaw) && portfolioEquityKrwRaw > 0 ? portfolioEquityKrwRaw : fallbackEquityKrw);
    const surgeCapitalLimitKrw = Math.floor(totalLiveCapitalKrw * SURGE_LIVE_CAPITAL_RATIO);
    const surgeUsedCapitalKrw = Math.max(0, accountSpotHoldingsValueKrw) + reservedKrw;
    const surgeCapitalRemainingKrw = Math.max(0, surgeCapitalLimitKrw - surgeUsedCapitalKrw);
    let surgeRemainingForTickKrw = surgeCapitalRemainingKrw;

    let liveOpenPositionValueKrw = 0;
    let earlyOpenPositionValueKrw = 0;
    let surgeManagedMarkValueKrw = 0;
    for (const p of Object.values(state.positions)) {
      const mk = p.market;
      const px = priceBy.get(mk) ?? p.entry_price;
      const val = p.qty * px;
      liveOpenPositionValueKrw += val;
      if (p.engine_bucket === "surge") surgeManagedMarkValueKrw += Math.max(0, val);
    }
    for (const p of Object.values(state.early_positions)) {
      const mk = p.market;
      const px = priceBy.get(mk) ?? p.entry_price;
      const markValue = p.qty * px;
      earlyOpenPositionValueKrw += markValue;
      if (p.engine_bucket === "surge") surgeManagedMarkValueKrw += Math.max(0, markValue);
    }

    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_SURGE_CAPITAL_POLICY",
        ts: new Date().toISOString(),
        totalLiveCapitalKrw,
        surgeCapitalLimitKrw,
        surgeUsedCapitalKrw,
        surgeCapitalRemainingKrw,
        used_holdings_value_krw: Math.floor(accountSpotHoldingsValueKrw),
        reserved_krw: Math.floor(reservedKrw),
        equity_source:
          Number.isFinite(portfolioEquityKrwRaw) && portfolioEquityKrwRaw > 0 ? "account_portfolio.total_evaluated_krw" : "fallback(total_krw+holdings)",
        strategyUsableKrwForAlloc,
        liveOpenPositionValueKrw,
        earlyOpenPositionValueKrw,
        surge_managed_mark_value_krw: Math.floor(surgeManagedMarkValueKrw),
      })
    );

    const surgeOpenCount =
      Object.values(state.positions).filter((p) => p.engine_bucket === "surge").length +
      Object.values(state.early_positions).filter((p) => p.engine_bucket === "surge").length;
    const paperStatsMap = await racePhase("paper_surge_pattern_stats_load", PHASE_MS.paper_stats, () =>
      loadPaperSurgePatternStats(opts.companyId, opts.serviceId),
    );

    const SURGE_V2_SOURCE_KINDS = new Set<string>([
      "scanner_filter_fresh",
      "scanner_tradable_candidate",
      "scanner_bridge_score_fail",
    ]);
    const candidateMetaMap = new Map<string, CandidateMeta>();
    const evaluationDroppedReasons: Record<string, string> = {};
    const candidateMetaSettled = await racePhase("candidate_meta_parallel", PHASE_MS.candidate_meta_parallel, () =>
      Promise.allSettled(
        entryUniverse.map(async (m) => {
        let s = latestAllSignals.get(m);
        const isFallbackSource = (entrySourceKindByMarket.get(m) === "fallback_watch_markets") || (sourceMetaByMarket.get(m)?.source_kind === "fallback_watch_markets");
        const realSignalPresent = !!s?.p;

        if (!realSignalPresent && !isFallbackSource) {
          evaluationDroppedReasons[m] = "missing_signal_payload";
          return null;
        }

        // [DIAGNOSTIC-REPAIR] If signal is missing but it's a fallback market, we continue with real_signal_present: false.
        // We use a safe empty payload object for downstream logic to avoid crashes, but strictly block entry.
        const effectivePayload = s?.p || {
          v: 2,
          market: m,
          signal_type: "MID",
          signal_reason: "fallback_watch_market_diagnostic",
          filter_pass: false,
          filters: [],
          volume_ratio: 0,
          signal_score: 0,
          source_kind: "fallback_watch_markets",
        };
        const currentPx = priceBy.get(m) ?? 0;
        if (!(currentPx > 0)) {
          evaluationDroppedReasons[m] = "missing_ticker_price";
          return null;
        }
        const sourceKindFromPayload = String(effectivePayload.source_kind ?? "");
        const sourceKindFromMap = String(entrySourceKindByMarket.get(m) ?? sourceMetaByMarket.get(m)?.source_kind ?? "");
        const isSurgeCandidate =
          (effectivePayload as any).isSurgeSource === true ||
          SURGE_V2_SOURCE_KINDS.has(sourceKindFromPayload) ||
          SURGE_V2_SOURCE_KINDS.has(sourceKindFromMap);

        if (isSurgeCandidate) {
          console.info(JSON.stringify({
            tag: "SURGE_ENTRY_PATH_SELECTED_PROOF",
            market: m,
            source_kind: sourceKindFromPayload || sourceKindFromMap,
            authority_source: "surge-v2",
            ts: new Date().toISOString()
          }));
        }

        console.info(JSON.stringify({
          tag: "SURGE_ENTRY_PIPELINE_PROOF",
          ts: new Date().toISOString(),
          market: m,
          stage: "candidate_meta_eval_start",
          source_kind: sourceKindFromPayload || sourceKindFromMap,
          has_signal: realSignalPresent,
          price: currentPx
        }));

        // [ORIGINAL SETUP] Primary Gate Enforcement (Upbit fetch limit is 200)
        // candidate_meta candle fetch is concurrency-limited + short-timeout; fallback success must NEVER re-drop as candle_fetch_error.
        let candles1: UpbitCandle[];
        let candle_source: "live_fetch" | "last_good_cache" = "live_fetch";
        let candle_cache_age_ms: number | null = null;
        try {
          const fetched = await fetchCandidateMetaCandles1m200(m);
          candles1 = fetched.rows;
          candle_source = fetched.candle_source;
          candle_cache_age_ms = fetched.cache_age_ms;
        } catch (e) {
          if (isAbortLike(e)) {
            evaluationDroppedReasons[m] = "candle_fetch_aborted";
            console.info(
              JSON.stringify({
                tag: "LIVE_CANDIDATE_META_MARKET_DROPPED_PROOF",
                ts: new Date().toISOString(),
                market: m,
                phase: isLiveTickPhaseTimeout(e) ? e.phase : "candidate_meta_fetch_minute_candles:aborted",
                reason: "candle_fetch_aborted",
                timeout_ms: isLiveTickPhaseTimeout(e) ? e.timeout_ms : null,
                tick_lease: myLease,
                candidate_meta_missing_reason: "candle_fetch_aborted",
                abort_reason: tickSignal.aborted
                  ? "tick_abort_signal"
                  : e instanceof Error && e.name === "AbortError"
                    ? "abort_error"
                    : "aborted_message",
              }),
            );
            return null;
          }
          if (isLiveTickPhaseTimeout(e) && e.phase.startsWith("candidate_meta_fetch_minute_candles:")) {
            evaluationDroppedReasons[m] = "candle_fetch_timeout";
            console.info(
              JSON.stringify({
                tag: "LIVE_CANDIDATE_META_MARKET_DROPPED_PROOF",
                ts: new Date().toISOString(),
                market: m,
                phase: e.phase,
                reason: "candle_fetch_timeout",
                timeout_ms: e.timeout_ms,
                tick_lease: myLease,
                candidate_meta_missing_reason: "candle_fetch_timeout",
              }),
            );
            return null;
          }
          evaluationDroppedReasons[m] = "candle_fetch_error";
          console.info(
            JSON.stringify({
              tag: "LIVE_CANDIDATE_META_MARKET_DROPPED_PROOF",
              ts: new Date().toISOString(),
              market: m,
              phase: "candidate_meta_fetch_minute_candles:inner_error",
              reason: "candle_fetch_error",
              timeout_ms: null,
              tick_lease: myLease,
              candidate_meta_missing_reason: "candle_fetch_error",
              error: e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240),
            }),
          );
          return null;
        }

        // Calculate relaxed criteria components
        const closes1 = candles1.map(x => Number(x.trade_price ?? 0)).filter(n => n > 0);
        let recent3mRet: number | null = null;
        if (closes1.length >= 4) {
          recent3mRet = ((closes1[closes1.length - 1] / closes1[closes1.length - 4]) - 1) * 100;
        }
        let vr1m5: number | null = null;
        if (candles1.length >= 7) {
          const last = candles1[candles1.length - 1];
          const prev5 = candles1.slice(-6, -1);
          const lastNotional = Number(last.candle_acc_trade_volume ?? 0) * Number(last.trade_price ?? 0);
          const prevAvg = prev5.reduce((acc, r) => acc + Number(r.candle_acc_trade_volume ?? 0) * Number(r.trade_price ?? 0), 0) / Math.max(1, prev5.length);
          if (prevAvg > 0) vr1m5 = lastNotional / prevAvg;
        }

        const gate = opts.marketState.entryGate(effectivePayload, marketState);
        const scoreForRelaxed = Number(gate.score ?? 0);
        const signalType = String(effectivePayload.signal_type ?? "MID").toUpperCase();
        const vol = Number(effectivePayload.volume_ratio ?? 0);
        const btcTier = state.regime?.btc_filter_state ?? "neutral";

        const isCoreRelaxedCandidate = false; // [HARDENED] No hardcoded symbol-based relaxation allowed

        let setup: OriginalSpotSetupResult = {
          ok: true,
          mode: "none",
          reason: "surge_v2_entry_path",
          riskReward: 1,
          stopPrice: 0,
          targetPrice: 0,
          candleLow: 0,
          swingLow: 0,
          volumeRatio: Number(effectivePayload.volume_ratio ?? 0),
        };
        const softenedReasons: string[] = [];
        if (!isSurgeCandidate) {
          setup = evaluateOriginalSpotScalpingSetup(m, candles1, currentPx);

          if (
            !setup.ok &&
            setup.reason === "setup_conditions_not_met" &&
            CORE_TREND_ENTRY_MARKETS.has(m) &&
            realSignalPresent &&
            !isFallbackSource &&
            candle_source !== "live_fetch"
          ) {
            console.info(
              JSON.stringify({
                tag: "CORE_TREND_ENTRY_SETUP_REJECT",
                ts: new Date().toISOString(),
                market: m,
                source_kind: sourceKindFromPayload || sourceKindFromMap,
                candle_source,
                candle_cache_age_ms,
                reason: "candles_fallback_blocked",
                core_trend_entry_pass: false,
                core_trend_reject_reason: "candles_fallback_blocked",
                stoch_assist_score: 0,
                stoch_assist_pass: false,
                failed_conditions: ["candles_fallback_blocked"],
              }),
            );
          } else if (
            !setup.ok &&
            setup.reason === "setup_conditions_not_met" &&
            CORE_TREND_ENTRY_MARKETS.has(m) &&
            realSignalPresent &&
            !isFallbackSource &&
            candle_source === "live_fetch"
          ) {
            const allowMajorVolumeRelax =
              CORE_TREND_ENTRY_MARKETS.has(m) &&
              CORE_TREND_VOLUME_RELAX_MARKETS.has(m) &&
              realSignalPresent &&
              !isFallbackSource &&
              candle_source === "live_fetch" &&
              !isSurgeCandidate &&
              marketState.market_state !== "risk_off";
            const trendSetup = evaluateCoreTrendEntrySetup(m, candles1, currentPx, effectivePayload, {
              allow_major_volume_relax: allowMajorVolumeRelax,
              source_kind: sourceKindFromPayload || sourceKindFromMap,
              candle_source,
              market_state: marketState.market_state,
            });
            if (trendSetup.ok) {
              setup = trendSetup;
              softenedReasons.push("CORE_TREND_ENTRY_PROBE");
              console.info(
                JSON.stringify({
                  tag: "CORE_TREND_ENTRY_SETUP_PASS",
                  ts: new Date().toISOString(),
                  market: m,
                  source_kind: sourceKindFromPayload || sourceKindFromMap,
                  candle_source,
                  candle_cache_age_ms,
                  volume_ratio: vol,
                  effective_volume_threshold: trendSetup.effective_volume_threshold ?? LIVE_CORE_TREND_MIN_VOLUME_RATIO,
                  volume_relaxed_applied: Boolean(trendSetup.volume_relaxed_applied ?? false),
                  risk_reward: trendSetup.riskReward,
                  core_trend_entry_pass: Boolean(trendSetup.core_trend_entry_pass),
                  core_trend_reject_reason: trendSetup.core_trend_reject_reason ?? null,
                  stoch_assist_score: trendSetup.stoch_assist_score ?? 0,
                  stoch_assist_pass: trendSetup.stoch_assist_pass ?? false,
                }),
              );
            } else {
              console.info(
                JSON.stringify({
                  tag: "CORE_TREND_ENTRY_SETUP_REJECT",
                  ts: new Date().toISOString(),
                  market: m,
                  source_kind: sourceKindFromPayload || sourceKindFromMap,
                  candle_source,
                  candle_cache_age_ms,
                  reason: trendSetup.reason,
                  effective_volume_threshold: trendSetup.effective_volume_threshold ?? LIVE_CORE_TREND_MIN_VOLUME_RATIO,
                  volume_relaxed_applied: Boolean(trendSetup.volume_relaxed_applied ?? false),
                  core_trend_entry_pass: trendSetup.core_trend_entry_pass ?? false,
                  core_trend_reject_reason: trendSetup.core_trend_reject_reason ?? trendSetup.reason,
                  stoch_assist_score: trendSetup.stoch_assist_score ?? 0,
                  stoch_assist_pass: trendSetup.stoch_assist_pass ?? false,
                  failed_conditions: trendSetup.failed_conditions ?? [],
                }),
              );
            }
          }

          if (!setup.ok && isCoreRelaxedCandidate && setup.reason === "setup_conditions_not_met") {
            // Soften Original Setup
            setup = { ...setup, ok: true, mode: "relaxed_probe" };
            softenedReasons.push("CORE_ORIGINAL_SETUP_SOFTENED");
            console.info(JSON.stringify({
              tag: "CORE_ORIGINAL_SETUP_SOFTENED_PROOF",
              market: m,
              score: scoreForRelaxed,
              signal_type: signalType,
              setup_reason: "setup_conditions_not_met",
              failed_conditions: setup.failed_conditions,
              volume_ratio: vol,
              volume_ratio_1m5: vr1m5,
              btc_tier: btcTier,
              reason: "core_relaxed_probe_original_setup_softened"
            }));
          }
        }

        // [SURGE SETUP SHADOW EVALUATION]
        let surgeShadowSetup: SurgeEntrySetupResult | undefined;
        const sourceKind = sourceKindFromPayload;
        if (isSurgeCandidate || sourceKind === "scanner_filter" || sourceKind === "scanner_then_filter_pass") {
          surgeShadowSetup = evaluateSurgeEntrySetup(m, candles1, currentPx, effectivePayload);
          
          console.info(JSON.stringify({
            tag: "SURGE_ENTRY_SETUP_PROOF",
            market: m,
            ok: surgeShadowSetup.ok,
            score: surgeShadowSetup.score,
            reason: surgeShadowSetup.reason,
            failed_conditions: surgeShadowSetup.failed_conditions,
            is_surge_candidate: isSurgeCandidate
          }));

          if (isSurgeCandidate) {
            const probeAllowed = !!surgeShadowSetup.probe_allowed;
            if (!surgeShadowSetup.ok && probeAllowed) {
               console.info(JSON.stringify({
                  tag: "SURGE_PROBE_CANDIDATE_PROOF",
                  market: m,
                  surge_score: surgeShadowSetup.score,
                  grade: surgeShadowSetup.grade,
                  failed_conditions: surgeShadowSetup.failed_conditions,
                  probe_allowed: true,
                  reason: "grade_A_low_momentum_only"
               }));
            } else if (!surgeShadowSetup.ok) {
               console.info(JSON.stringify({
                  tag: "SURGE_PROBE_CANDIDATE_PROOF",
                  market: m,
                  surge_score: surgeShadowSetup.score,
                  grade: surgeShadowSetup.grade,
                  failed_conditions: surgeShadowSetup.failed_conditions,
                  probe_allowed: false,
                  probe_reject_reason: surgeShadowSetup.grade !== "A" ? "grade_not_A" : "multiple_failed_conditions"
               }));
            }

            const surgeReasonCanonical =
              surgeShadowSetup.reason === "surge_setup_passed"
                ? "surge_v2_entry_path"
                : `surge_v2:${surgeShadowSetup.reason}`;
            setup = {
              ok: surgeShadowSetup.ok,
              mode: probeAllowed ? "relaxed_probe" : "none",
              reason: surgeReasonCanonical,
              riskReward: Number(surgeShadowSetup.riskReward ?? 1),
              stopPrice: Number(surgeShadowSetup.stopPrice ?? 0),
              targetPrice: Number(surgeShadowSetup.targetPrice ?? 0),
              candleLow: Number(surgeShadowSetup.stopPrice ?? 0),
              swingLow: Number(surgeShadowSetup.stopPrice ?? 0),
              ema50: surgeShadowSetup.ema50,
              ema200: surgeShadowSetup.ema200,
              rsi: surgeShadowSetup.rsi,
              stochK: surgeShadowSetup.stochK,
              stochD: surgeShadowSetup.stochD,
              volumeRatio: surgeShadowSetup.volumeRatio,
              failed_conditions: surgeShadowSetup.failed_conditions,
            };
          }
        }

        if (!setup.ok) {
          const blockReason = setup.reason ?? "setup_conditions_not_met";
          const dedupeKey = `DEBUG_ORIGINAL_SPOT_SETUP_BLOCK|live_strategy_tick|${m}|${blockReason}|live`;
          evaluationDroppedReasons[m] = `setup_blocked:${blockReason}${setup.failed_conditions?.length ? ': ' + setup.failed_conditions.join(',') : ''}`;
          if (setupBlockLogDeduper.shouldLog(dedupeKey)) {
            console.info(JSON.stringify({
              tag: "DEBUG_ORIGINAL_SPOT_SETUP_BLOCK",
              market: m,
              reason: blockReason,
              loop_id: typeof loopId !== 'undefined' ? loopId : Date.now(),
              evaluation_source: "live_strategy_tick",
              candles_count: candles1.length,
              current_price: currentPx,
              ema50: setup.ema50,
              ema200: setup.ema200,
              rsi: setup.rsi,
              stochK: setup.stochK,
              stochD: setup.stochD,
              volumeRatio: setup.volumeRatio,
              swingLow: setup.swingLow,
              stopPrice: setup.stopPrice,
              targetPrice: setup.targetPrice,
              riskReward: setup.riskReward,
              failed_conditions: setup.failed_conditions,
              setup_conditions_breakdown:
                blockReason === "setup_conditions_not_met"
                  ? {
                      failed_conditions: setup.failed_conditions ?? [],
                      safe_flags: {
                        safePriceAboveEma200: setup.safePriceAboveEma200 ?? null,
                        pullbackToEma200: setup.pullbackToEma200 ?? null,
                        stochOversoldBullishCross: setup.stochOversoldBullishCross ?? null,
                        isBullish: setup.isBullish ?? null,
                        safe_condition_pass: setup.safe_condition_pass ?? null,
                      },
                      aggressive_flags: {
                        aggressiveEmaStack: setup.aggressiveEmaStack ?? null,
                        aggressivePriceAbove: setup.aggressivePriceAbove ?? null,
                        aggressiveRsiOk: setup.aggressiveRsiOk ?? null,
                        aggressiveVolumeOk: setup.aggressiveVolumeOk ?? null,
                        aggressive_condition_pass: setup.aggressive_condition_pass ?? null,
                      },
                    }
                  : null,
              surge_v2_breakdown:
                typeof blockReason === "string" && blockReason.startsWith("surge_v2") && surgeShadowSetup
                  ? {
                      surge_shadow_reason: surgeShadowSetup.reason,
                      surge_shadow_grade: surgeShadowSetup.grade,
                      surge_shadow_score: surgeShadowSetup.score,
                      failed_conditions: surgeShadowSetup.failed_conditions ?? [],
                      probe_allowed: surgeShadowSetup.probe_allowed,
                    }
                  : null,
            }));
          }

          const isSurgeSource = isSurgeCandidate;
          if (isSurgeSource) {
            console.info(JSON.stringify({
              tag: "SURGE_LEGACY_SETUP_BYPASSED_PROOF",
              market: m,
              reason: blockReason,
              surge_shadow_reason: surgeShadowSetup?.reason ?? null,
              surge_shadow_failed_conditions: surgeShadowSetup?.failed_conditions ?? null,
              surge_shadow_grade: surgeShadowSetup?.grade ?? null,
              surge_shadow_probe_allowed: surgeShadowSetup?.probe_allowed ?? null,
              source_kind: effectivePayload.source_kind,
              authority_source: "surge-v2",
              note:
                "surge candidate continues pipeline despite primary setup block branch; downstream surge-v2 gates apply",
            }));
          } else {
            return null;
          }
        }
        console.info(
          JSON.stringify({
            tag: "DEBUG_ORIGINAL_SPOT_SETUP_PASS",
            market: m,
            setup_ok: setup.ok,
            mode: setup.mode,
            rr: setup.riskReward,
            setup_reason: setup.reason,
            surge_continue_despite_primary_setup_fail: isSurgeCandidate && !setup.ok,
          }),
        );

        let gateOk = realSignalPresent ? gate.ok : false;
        let gateReason = realSignalPresent ? gate.reason : "missing_real_signal_payload";
        const score = Number(gate.score ?? 0);

        if (gateOk && isCoreRelaxedCandidate && score >= 70 && (
          gateReason === "score_below_threshold" || 
          gateReason === "score_floor" || 
          String(gateReason || "").toLowerCase().includes("score")
        )) {
          // Soften Score Floor
          gateOk = true;
          gateReason = "score_floor_softened";
          softenedReasons.push("CORE_SCORE_FLOOR_SOFTENED");
          console.info(JSON.stringify({
            tag: "CORE_SCORE_FLOOR_SOFTENED_PROOF",
            market: m,
            score: score,
            gate_reason_original: gate.reason,
            min_entry_score: marketState.min_entry_score,
            reason: "core_relaxed_probe_score_floor_softened"
          }));
        }
        
        // Calculate diagnostics for quality classification
        const sTs = s?.ts ?? null;
        const ageSec = sTs ? Math.max(0, Math.floor((Date.now() - Date.parse(sTs)) / 1000)) : null;
        
        let lHigh: number | null = null;
        let distHighPct: number | null = null;
        try {
          const highs = candles1.slice(-12).map((x) => Number(x.high_price ?? 0)).filter((n) => n > 0);
          if (highs.length > 0) lHigh = Math.max(...highs);
          if (lHigh && currentPx > 0) distHighPct = ((lHigh - currentPx) / lHigh) * 100;
        } catch {}

        const eq = classifyEntryQuality({
          market: m,
          score,
          secondsSinceSignal: ageSec,
          distanceFromLocalHighPct: distHighPct,
          volumeRatio: Number(effectivePayload.volume_ratio ?? 0),
          btcTier,
        });

        const riskReward = Number(setup.riskReward ?? 0);
        const isSurgeSourceFinal = isSurgeCandidate;
        if (!(riskReward > 0) && !isSurgeSourceFinal) {
          evaluationDroppedReasons[m] = "risk_reward_invalid";
          return null;
        }

        // Apply probe multiplier — CORE_TREND_ENTRY 는 별도 소액 배수
        let relaxedMultiplier = 1.0;
        if (setup.reason === "CORE_TREND_ENTRY") {
          relaxedMultiplier = LIVE_CORE_TREND_PROBE_MULTIPLIER;
        } else if (setup.mode === "relaxed_probe" || softenedReasons.length > 0) {
          relaxedMultiplier = 0.35;
        }

        const isFreshSignal = realSignalPresent && !isFallbackSource;
        const isWatchCandidate = isFallbackSource;

        const meta: CandidateMeta = {
          market: m,
          score,
          tier: eq.tier,
          setupMode: setup.mode,
          riskReward,
          setupReason: setup.reason,
          stopPrice: setup.stopPrice ?? 0,
          targetPrice: setup.targetPrice ?? 0,
          candleLow: setup.candleLow ?? 0,
          swingLow: setup.swingLow ?? 0,
          candle_source,
          candle_cache_age_ms,
          ema50: setup.ema50,
          ema200: setup.ema200,
          rsi: setup.rsi,
          stochK: setup.stochK,
          stochD: setup.stochD,
          volumeRatio: setup.volumeRatio,
          setup,
          surge_shadow_setup: surgeShadowSetup,
          engine_bucket: isSurgeCandidate ? "surge" : "other",
          is_core_relaxed_candidate: isCoreRelaxedCandidate,
          is_relaxed_probe: setup.mode === "relaxed_probe" || setup.reason === "CORE_TREND_ENTRY",
          softened_reasons: softenedReasons,
          relaxed_multiplier: relaxedMultiplier,
          gate_ok: gateOk,
          gate_reason: gateReason,
          real_signal_present: realSignalPresent,
          is_fresh_signal: isFreshSignal,
          is_watch_candidate: isWatchCandidate,
        };

        console.info(JSON.stringify({
          tag: "DEBUG_CANDIDATE_META_SETTLED_PROOF",
          market: m,
          is_fresh_signal: isFreshSignal,
          is_watch_candidate: isWatchCandidate,
          gate_ok: gateOk,
          gate_reason: gateReason,
          setup_mode: setup.mode,
          source_kind: effectivePayload.source_kind
        }));

        candidateMetaMap.set(m, meta);
        return meta;
        }),
      ),
    );
    const candidateMeta = candidateMetaSettled
      .map((r, idx) => {
        const m = entryUniverse[idx]!;
        if (r.status === "rejected") {
          evaluationDroppedReasons[m] = evaluationDroppedReasons[m] ?? "candidate_meta_unhandled_rejection";
          console.info(
            JSON.stringify({
              tag: "LIVE_CANDIDATE_META_MARKET_DROPPED_PROOF",
              ts: new Date().toISOString(),
              market: m,
              phase: "candidate_meta_parallel_inner_reject",
              reason: "candidate_meta_unhandled_rejection",
              timeout_ms: null,
              tick_lease: myLease,
              error: r.reason instanceof Error ? r.reason.message.slice(0, 240) : String(r.reason).slice(0, 240),
            }),
          );
          return null;
        }
        return r.value;
      })
      .filter((x): x is CandidateMeta => x !== null);

    const realSignalMetaCount = candidateMeta.filter(m => m.real_signal_present).length;
    const fallbackMetaCount = candidateMeta.length - realSignalMetaCount;

    console.info(
      JSON.stringify({
        tag: "SURGE_ENTRY_PIPELINE_PROOF",
        ts: new Date().toISOString(),
        stage: "entry_evaluation_done",
        entry_universe_count: entryUniverse.length,
        candidate_meta_count: candidateMeta.length,
        real_signal_meta_count: realSignalMetaCount,
        fallback_meta_count: fallbackMetaCount,
        fresh_signal_meta_count: candidateMeta.filter(m => m.is_fresh_signal).length,
        watch_candidate_meta_count: candidateMeta.filter(m => m.is_watch_candidate).length,
        dropped_count: Object.keys(evaluationDroppedReasons).length,
        dropped_reasons: evaluationDroppedReasons,
        candidate_meta_dropout_detail: entryUniverse.map((sym) => ({
          market: sym,
          outcome: candidateMeta.some((c) => c.market === sym) ? "kept" : "dropped",
          drop_reason: evaluationDroppedReasons[sym] ?? null,
        })),
        market_block_summary: (() => {
          const stats: Record<string, number> = {};
          Object.values(evaluationDroppedReasons).forEach(r => {
            const base = r.split(':')[0];
            stats[base!] = (stats[base!] ?? 0) + 1;
          });
          return stats;
        })(),
      }),
    );
    const capPlan = computeTargetPositionBudget({
      strategyUsableKrw: strategyUsableKrwForAlloc,
      regime: btcTier,
      candidates: candidateMeta,
    });
    const perPositionBudgetBySymbol = capPlan.bySymbol;

    // Apply Paper Stats and Surge Limits to each candidate
    if (liveTradingOn) {
      for (const meta of candidateMeta) {
        const market = meta.market;
        const signal = latestAllSignals.get(market);
        const signalPayload = signal?.p;
        if (!signalPayload) continue;
        const profileKey = makeEntryProfileKey({
          signal_type: String(signalPayload.signal_type ?? "MID"),
          position_stage: meta.tier === "A" ? "early_active" : "normal_active",
          btc_tier: btcTier,
          score_bucket: bucketScore(meta.score),
          volume_ratio_bucket: bucketVol(Number(signalPayload.volume_ratio ?? 0)),
          signal_age_bucket: bucketAge(signal?.ts ? Math.max(0, Math.floor((Date.now() - Date.parse(signal.ts)) / 1000)) : null),
          chase_bucket: bucketChase(null),
          near_high_bucket: bucketNear(null),
          breakout: String(signalPayload.signal_reason ?? "").toLowerCase().includes("breakout"),
          early_entry_flag: meta.tier === "A",
        });
        meta.paper_profile_key = profileKey;
        const stats = paperStatsMap[profileKey];

        let paperMultiplier = 1.0;
        let experienceBonusMultiplier = 1.0;
        let experiencePenaltyMultiplier = 1.0;
        let paperConfidence: "low" | "medium" | "high" = "low";
        let experienceBlockReason: string | null = null;
        if (stats) {
          paperConfidence = stats.confidence;
          if (stats.confidence === "low") paperMultiplier = 1.0;
          else if (stats.confidence === "medium" && stats.avg_pnl_pct > 0) paperMultiplier = 1.2;
          else if (stats.confidence === "high" && stats.win_rate > 0.6) paperMultiplier = 1.5;

          if ((stats.fast_profit_rate ?? 0) >= 0.35) experienceBonusMultiplier *= 1.1;
          if ((stats.target_tp_rate ?? 0) >= 0.25) experienceBonusMultiplier *= 1.1;
          if ((stats.avg_profit_pnl_pct ?? 0) > 0) experienceBonusMultiplier *= 1.08;
          if ((stats.volume_hold_profit_count ?? 0) >= 3) experienceBonusMultiplier *= 1.08;
          if ((stats.clean_candle_profit_count ?? 0) >= 3) experienceBonusMultiplier *= 1.05;

          if ((stats.surge_stop_loss_rate ?? 0) > 0.35) experiencePenaltyMultiplier *= 0.55;
          if ((stats.profile_unknown_loss_rate ?? 0) > 0.35) experiencePenaltyMultiplier *= 0.55;
          if ((stats.early_entry_loss_rate ?? 0) > 0.3) experiencePenaltyMultiplier *= 0.7;
          if ((stats.volume_fade_loss_rate ?? 0) > 0.3) experiencePenaltyMultiplier *= 0.6;
          if ((stats.high_rejected_loss_rate ?? 0) > 0.3) experiencePenaltyMultiplier *= 0.6;
          if ((stats.chase_loss_rate ?? 0) > 0.3) experiencePenaltyMultiplier *= 0.65;
          if ((stats.avg_loss_pnl_pct ?? 0) < -1.0) experiencePenaltyMultiplier *= 0.8;

          if ((stats.sample_count ?? 0) >= 10 && (stats.avg_pnl_pct ?? 0) < 0) {
            experienceBlockReason = "negative_expectancy_with_enough_samples";
          } else if ((stats.surge_stop_loss_rate ?? 0) > 0.45) {
            experienceBlockReason = "surge_stop_loss_rate_too_high";
          } else if ((stats.profile_unknown_loss_rate ?? 0) > 0.45) {
            experienceBlockReason = "profile_unknown_loss_rate_too_high";
          } else if ((stats.volume_fade_loss_rate ?? 0) > 0.35 && (stats.high_rejected_loss_rate ?? 0) > 0.35) {
            experienceBlockReason = "volume_fade_and_high_rejected_loss_rates_high";
          } else if ((stats.early_entry_loss_rate ?? 0) > 0.35 && (stats.fast_profit_rate ?? 0) < 0.1) {
            experienceBlockReason = "early_entry_loss_high_fast_profit_low";
          }
        }
        const profileUnknown = profileKey.includes("early:0") && paperConfidence === "low";
        if (profileUnknown && !stats) experiencePenaltyMultiplier *= 0.5;
        if (profileUnknown && (stats?.profile_unknown_loss_rate ?? 0) > 0.35) {
          experienceBlockReason = "profile_unknown_with_loss_experience";
        }
        if (profileUnknown && (stats?.profile_unknown_profit_count ?? 0) > 0 && (stats?.sample_count ?? 0) >= 6) {
          experienceBonusMultiplier *= 1.02;
        }

        const finalMultiplier = paperMultiplier * experienceBonusMultiplier * experiencePenaltyMultiplier;
        meta.paper_pattern_multiplier = paperMultiplier * experienceBonusMultiplier;
        meta.risk_tag_multiplier = experiencePenaltyMultiplier;

        console.info(JSON.stringify({
          tag: "DEBUG_LIVE_EXPERIENCE_REFERENCE",
          ts: new Date().toISOString(),
          market,
          profile_key: profileKey,
          paperStatsFound: Boolean(stats),
          paperStatsSource: stats ? "entry_profile_key" : "missing",
          sample_count: stats?.sample_count ?? 0,
          win_rate: stats?.win_rate ?? 0,
          avg_pnl_pct: stats?.avg_pnl_pct ?? 0,
          fast_profit_rate: stats?.fast_profit_rate ?? 0,
          surge_stop_loss_rate: stats?.surge_stop_loss_rate ?? 0,
          profile_unknown_loss_rate: stats?.profile_unknown_loss_rate ?? 0,
          early_entry_loss_rate: stats?.early_entry_loss_rate ?? 0,
          volume_fade_loss_rate: stats?.volume_fade_loss_rate ?? 0,
          high_rejected_loss_rate: stats?.high_rejected_loss_rate ?? 0,
          experience_bonus_multiplier: experienceBonusMultiplier,
          experience_penalty_multiplier: experiencePenaltyMultiplier,
          final_multiplier: finalMultiplier,
          block_reason: experienceBlockReason,
        }));
        if (experienceBlockReason) {
          console.info(JSON.stringify({
            tag: "DEBUG_LIVE_EXPERIENCE_BLOCK",
            ts: new Date().toISOString(),
            market,
            profile_key: profileKey,
            sample_count: stats?.sample_count ?? 0,
            win_rate: stats?.win_rate ?? 0,
            avg_pnl_pct: stats?.avg_pnl_pct ?? 0,
            fast_profit_rate: stats?.fast_profit_rate ?? 0,
            surge_stop_loss_rate: stats?.surge_stop_loss_rate ?? 0,
            profile_unknown_loss_rate: stats?.profile_unknown_loss_rate ?? 0,
            early_entry_loss_rate: stats?.early_entry_loss_rate ?? 0,
            volume_fade_loss_rate: stats?.volume_fade_loss_rate ?? 0,
            high_rejected_loss_rate: stats?.high_rejected_loss_rate ?? 0,
            experience_bonus_multiplier: experienceBonusMultiplier,
            experience_penalty_multiplier: experiencePenaltyMultiplier,
            final_multiplier: finalMultiplier,
            block_reason: experienceBlockReason,
          }));
          perPositionBudgetBySymbol.set(market, 0);
          continue;
        }

        const baseBudgetKrw = perPositionBudgetBySymbol.get(market) ?? 0;
        const surgeMinOrderKrw = Math.max(UPBIT_MIN_ORDER_KRW, Math.floor(surgeCapitalLimitKrw * SURGE_MIN_ORDER_RATIO));
        const surgeNormalOrderKrw = Math.floor(surgeCapitalLimitKrw * SURGE_NORMAL_ORDER_RATIO);
        const surgeHighConfidenceOrderKrw = Math.floor(surgeCapitalLimitKrw * SURGE_HIGH_CONFIDENCE_ORDER_RATIO);

        let finalOrderKrw = Math.floor(baseBudgetKrw * finalMultiplier);
        const highConfidenceSurgeSetup = paperConfidence === "high" && (stats?.win_rate ?? 0) >= 0.55;
        if (highConfidenceSurgeSetup) {
          finalOrderKrw = Math.max(finalOrderKrw, surgeHighConfidenceOrderKrw);
        } else if (paperConfidence !== "low") {
          finalOrderKrw = Math.max(finalOrderKrw, surgeNormalOrderKrw);
        }

        if (highConfidenceSurgeSetup && finalOrderKrw < surgeMinOrderKrw && finalOrderKrw > 0) {
          finalOrderKrw = surgeMinOrderKrw;
        }
        if (surgeRemainingForTickKrw < surgeMinOrderKrw) {
          console.info(JSON.stringify({
            tag: "DEBUG_LIVE_SURGE_CAPITAL_BLOCK",
            ts: new Date().toISOString(),
            market,
            totalLiveCapitalKrw,
            surgeCapitalLimitKrw,
            surgeUsedCapitalKrw,
            surgeCapitalRemainingKrw: surgeRemainingForTickKrw,
            requestedOrderKrw: finalOrderKrw,
            reason: "surge_remaining_below_min_order",
          }));
          finalOrderKrw = 0;
        } else if (finalOrderKrw > surgeRemainingForTickKrw) {
          console.info(JSON.stringify({
            tag: "DEBUG_LIVE_SURGE_CAPITAL_BLOCK",
            ts: new Date().toISOString(),
            market,
            totalLiveCapitalKrw,
            surgeCapitalLimitKrw,
            surgeUsedCapitalKrw,
            surgeCapitalRemainingKrw: surgeRemainingForTickKrw,
            requestedOrderKrw: finalOrderKrw,
            reason: "surge_capital_limit_exceeded"
          }));
          finalOrderKrw = surgeRemainingForTickKrw;
        }

        console.info(JSON.stringify({
          tag: "DEBUG_LIVE_EXPERIENCE_SIZE_ADJUST",
          ts: new Date().toISOString(),
          market,
          profile_key: profileKey,
          sample_count: stats?.sample_count ?? 0,
          win_rate: stats?.win_rate ?? 0,
          avg_pnl_pct: stats?.avg_pnl_pct ?? 0,
          fast_profit_rate: stats?.fast_profit_rate ?? 0,
          surge_stop_loss_rate: stats?.surge_stop_loss_rate ?? 0,
          profile_unknown_loss_rate: stats?.profile_unknown_loss_rate ?? 0,
          early_entry_loss_rate: stats?.early_entry_loss_rate ?? 0,
          volume_fade_loss_rate: stats?.volume_fade_loss_rate ?? 0,
          high_rejected_loss_rate: stats?.high_rejected_loss_rate ?? 0,
          baseBudgetKrw,
          surgeMinOrderKrw,
          surgeNormalOrderKrw,
          surgeHighConfidenceOrderKrw,
          experience_bonus_multiplier: experienceBonusMultiplier,
          experience_penalty_multiplier: experiencePenaltyMultiplier,
          final_multiplier: finalMultiplier,
          finalOrderKrw,
          surgeCapitalRemainingKrw: surgeRemainingForTickKrw,
          block_reason: experienceBlockReason,
        }));

        perPositionBudgetBySymbol.set(market, finalOrderKrw);
      }
    }
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
      const currency = String(b.currency ?? "").toUpperCase();
      if (!currency || currency === "KRW") continue;
      const mk = `KRW-${currency}`;
      const qty = Number(b.balance ?? 0) + Number(b.locked ?? 0);
      const px = Number(priceBy.get(mk) ?? b.avg_buy_price ?? 0);
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

      /** trade_status 조회 전 precheck 단계 차단 — LIVE_PLACEBUY 직전 최종 차단 사유(market 단위) */
      const logPlacebuyFinalGateBlocked = (finalReason: string, extra?: Record<string, unknown>) => {
        const merged = { ...(extra ?? {}) };
        const candidate_meta_missing_reason =
          merged.candidate_meta_missing_reason !== undefined ? merged.candidate_meta_missing_reason : null;
        delete merged.candidate_meta_missing_reason;
        const entry_mode_precheck =
          typeof merged.entry_mode === "string" ? (merged.entry_mode as string) : "PRECHECK_BLOCKED";
        delete merged.entry_mode;
        console.info(
          JSON.stringify({
            tag: "LIVE_PLACEBUY_ATTEMPT_FINAL_GATE",
            ts: new Date().toISOString(),
            market,
            path: "precheck_before_trade_status",
            entry_mode: entry_mode_precheck,
            final_block_reason: finalReason,
            candidate_meta_missing_reason,
            blocked_before_placebuy: true,
            tick_lease: myLease,
            ...merged,
          }),
        );
        console.info(
          JSON.stringify({
            tag: "LIVE_ENTRY_FINAL_BLOCKED",
            ts: new Date().toISOString(),
            market,
            final_reason: finalReason,
            candidate_meta_missing_reason,
            entry_mode: entry_mode_precheck,
            order_precheck_ok: false,
            trade_status_snapshot: "not_fetched_at_precheck_stage",
            ...merged,
          }),
        );
      };

      // precheck 루프 진입 강제 로그 (이게 없으면 entryUniverse가 비었거나 루프 전에서 끊긴 것)
      const sigPre = latestAllSignals.get(market);
      const sourceMeta = sourceMetaByMarket.get(market);
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
          source_kind: sourceMeta?.source_kind ?? null,
          source_ts: sourceMeta?.source_ts ?? null,
          age_seconds: sourceMeta?.age_seconds ?? null,
          open_positions: Object.keys(state.positions).length,
          max_positions: state.safety_guard.max_positions,
        }),
      );
      const acctSnap = accountHoldSnapshot[market];
      const candidateMetaFromSetup = candidateMetaMap.get(market);
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
          is_fresh_signal: candidateMetaFromSetup?.is_fresh_signal ?? false,
          is_watch_candidate: candidateMetaFromSetup?.is_watch_candidate ?? false,
          source_kind: sourceMeta?.source_kind ?? null,
          age_seconds: sourceMeta?.age_seconds ?? null,
        }),
      );
      const candidateMetaEvalDropReason = evaluationDroppedReasons[market];
      if (!candidateMetaFromSetup) {
        if (candidateMetaEvalDropReason) {
          const skipStatKey =
            candidateMetaEvalDropReason.length <= 160
              ? candidateMetaEvalDropReason
              : `${candidateMetaEvalDropReason.slice(0, 157)}...`;
          emitEval("DEBUG_LIVE_PRECHECK", {
            return_reason: candidateMetaEvalDropReason,
            candidate_meta_missing: true,
            evaluation_phase: "candidate_meta_parallel",
            source_kind: sourceMeta?.source_kind ?? null,
          });
          logPlacebuyFinalGateBlocked(candidateMetaEvalDropReason, {
            candidate_meta_missing_reason: candidateMetaEvalDropReason,
            source_kind: sourceMeta?.source_kind ?? null,
          });
          bumpSkip(skipStatKey);
          continue;
        }
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: "candidate_meta_absent_no_drop_reason",
          candidate_meta_missing: true,
          source_kind: sourceMeta?.source_kind ?? null,
        });
        logPlacebuyFinalGateBlocked("candidate_meta_absent_no_drop_reason", {
          candidate_meta_missing_reason: null,
          source_kind: sourceMeta?.source_kind ?? null,
        });
        bumpSkip("candidate_meta_absent_no_drop_reason");
        continue;
      }

      const signalPayloadPresent = Boolean(sigPre?.p);
      const realSignalPresent = Boolean(candidateMetaFromSetup.real_signal_present);
      if (!realSignalPresent) {
        if (!signalPayloadPresent) {
          emitEval("DEBUG_LIVE_PRECHECK", {
            return_reason: "missing_real_signal",
            note: "no_signal_payload_in_latestAllSignals",
            source_kind: sourceMeta?.source_kind ?? null,
          });
          logPlacebuyFinalGateBlocked("missing_real_signal", {
            candidate_meta_missing_reason: null,
            note: "no_signal_payload_in_latestAllSignals",
            source_kind: sourceMeta?.source_kind ?? null,
          });
          bumpSkip("missing_real_signal");
          continue;
        }
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: "missing_real_signal",
          note: "watch_or_diagnostic_no_real_signal_payload",
          source_kind: sourceMeta?.source_kind ?? null,
        });
        logPlacebuyFinalGateBlocked("missing_real_signal", {
          candidate_meta_missing_reason: null,
          note: "watch_or_diagnostic_no_real_signal_payload",
          source_kind: sourceMeta?.source_kind ?? null,
        });
        bumpSkip("missing_real_signal");
        continue;
      }
      if (Object.keys(state.positions).length >= state.safety_guard.max_positions) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "max_positions_reached" });
        logPlacebuyFinalGateBlocked("max_positions_reached", { open_count: Object.keys(state.positions).length, max_positions: state.safety_guard.max_positions });
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
        logPlacebuyFinalGateBlocked("cooldown_active", { cooldown_until: cool });
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
            ? Number(sigPre.p.momentum_3m_pct ?? sigPre.p.price_change_3m_pct ?? 0)
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
        logPlacebuyFinalGateBlocked("stop_count_limit_reached", { stop_count: state.daily.stop_by_market[market] });
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
        logPlacebuyFinalGateBlocked(String(missingDetail.primary_reason ?? "signal_missing"), { ...missingDetail });
        bumpSkip(String(missingDetail.primary_reason ?? "signal_missing"));
        continue;
      }
      const exception = state.regime?.exception_candidates.find((x) => x.market === market) ?? null;
      const sourceMetaResolved = sourceMetaByMarket.get(market) ?? {
        source_kind: (sig?.p?.source_kind === "scanner" ? "scanner_then_filter_pass" : "legacy_filter_pass") as
          | "scanner_filter_fresh"
          | "fresh_filter_pass"
          | "legacy_filter_pass"
          | "fallback_watch_markets"
          | "scanner_then_filter_pass",
        source_ts: signalCandidateTimestamp(sig),
        age_seconds: null,
        stale_filtered_before_eval: false,
      };
      if (sourceMetaResolved.age_seconds === null && sourceMetaResolved.source_ts) {
        sourceMetaResolved.age_seconds = Math.max(0, Math.floor((Date.now() - Date.parse(sourceMetaResolved.source_ts)) / 1000));
      }
      const sourceKindForJudgment = sourceMetaResolved.source_kind;
      const payloadSourceKind = String(sig?.p?.source_kind ?? "");
      const isSetupTaggedSurge = candidateMetaFromSetup?.engine_bucket === "surge";
      const isSurgeSource =
        isSetupTaggedSurge ||
        sourceKindForJudgment === "scanner_then_filter_pass" ||
        payloadSourceKind === "scanner_then_filter_pass" ||
        SURGE_V2_SOURCE_KINDS.has(sourceKindForJudgment) ||
        SURGE_V2_SOURCE_KINDS.has(payloadSourceKind);

      if (isSurgeSource) {
        const surgeSourceKindLog = payloadSourceKind || sourceKindForJudgment;
        console.info(
          JSON.stringify({
            tag: "SURGE_ENTRY_PATH_SELECTED_PROOF",
            ts: new Date().toISOString(),
            market,
            source_kind: surgeSourceKindLog,
            is_setup_tagged_surge: isSetupTaggedSurge,
            payload_source_kind: payloadSourceKind,
            source_kind_for_judgment: sourceKindForJudgment,
            path: "surge-v2",
          }),
        );
        console.info(
          JSON.stringify({
            tag: "SURGE_ENTRY_SETUP_PROOF",
            ts: new Date().toISOString(),
            market,
            setup_found: !!candidateMetaFromSetup,
            setup_bucket: candidateMetaFromSetup?.engine_bucket,
            surge_shadow_setup: candidateMetaFromSetup?.surge_shadow_setup || null,
          }),
        );
      }
      const scannerBridgeScore = isSurgeSource
        ? computeScannerBridgeScore({
            scannerScore: Number(sig?.p?.scanner_score ?? sig?.p?.signal_score ?? 0),
            volumeMultiple: Number(sig?.p?.volume_ratio ?? 0),
            breakout: Boolean(sig?.p?.breakout),
            closeUpperHold: Boolean(sig?.p?.close_upper_hold),
            rise3mPct: Number(sig?.p?.rise_3m_pct ?? sig?.p?.momentum_3m_pct ?? sig?.p?.price_change_3m_pct ?? 0),
            ageSeconds: sourceMetaResolved.age_seconds,
            staleThresholdSeconds: LIVE_ENTRY_SIGNAL_STALE_SECONDS,
          })
        : null;
      const rawStrength = signalStrengthScore(sig.p);
      const bridgedStrength = scannerBridgeScore ? Math.max(rawStrength, scannerBridgeScore.signalStrengthScore) : rawStrength;
      if (scannerBridgeScore) {
        console.info(
          JSON.stringify({
            tag: "LIVE_SCANNER_SIGNAL_BRIDGE_SCORE",
            ts: new Date().toISOString(),
            market,
            scanner_score: Number(sig?.p?.scanner_score ?? sig?.p?.signal_score ?? 0),
            signal_strength_score: bridgedStrength,
            live_entry_score: Number(scannerBridgeScore.liveEntryScore.toFixed(1)),
            volume_multiple: Number(sig?.p?.volume_ratio ?? 0),
            breakout: Boolean(sig?.p?.breakout),
            close_upper_hold: Boolean(sig?.p?.close_upper_hold),
            rise_3m_pct: Number(sig?.p?.rise_3m_pct ?? sig?.p?.momentum_3m_pct ?? sig?.p?.price_change_3m_pct ?? 0),
            age_seconds: sourceMetaResolved.age_seconds,
            source_kind: sourceKindForJudgment,
            pass: scannerBridgeScore.pass,
            reason: scannerBridgeScore.reason,
            filter_pass: Boolean(sig?.p?.filter_pass),
          }),
        );
      }
      if (bridgedStrength >= ENTRY_PIPELINE_MID_SCORE_FLOOR) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "candidate_detected",
          payload: {
            symbol: market,
            signal_strength_score: bridgedStrength,
            filter_pass: Boolean(sig.p.filter_pass),
          },
        });
        emitEval("candidate_detected", {
          signal_strength_score: bridgedStrength,
          filter_pass: Boolean(sig.p.filter_pass),
        });
      }
      // Surge sources use a separate centralized evaluator (surge-v2), so we bypass the legacy bridged strength floor here.
      if (!isSurgeSource && bridgedStrength < ENTRY_PIPELINE_MID_SCORE_FLOOR) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "blocked_low_signal",
          payload: {
            symbol: market,
            signal_strength_score: bridgedStrength,
            floor: ENTRY_PIPELINE_MID_SCORE_FLOOR,
            reason: scannerBridgeScore?.reason ?? "legacy_low_signal",
          },
        });
        emitEval("blocked_low_signal", { signal_strength_score: bridgedStrength, reason: scannerBridgeScore?.reason ?? "legacy_low_signal" });
        logPlacebuyFinalGateBlocked("blocked_low_signal", { signal_strength_score: bridgedStrength, floor: ENTRY_PIPELINE_MID_SCORE_FLOOR, reason: scannerBridgeScore?.reason ?? "legacy_low_signal" });
        continue;
      }
      // Late-entry diagnostics & guard (entry timing)
      const signalTs = typeof sig.ts === "string" ? sig.ts : null;

      const btcCrashGuard = btcChange <= -0.025;
      const marketPanicGuard =
        btcChange <= -0.015 &&
        (marketState.btc_5m_trend === "down" || marketState.btc_15m_trend === "down");
      const surgeHardBlock = btcCrashGuard || marketPanicGuard;
      const surgeMarketState: "risk_on" | "neutral" | "risk_off" | "panic" = surgeHardBlock ? "panic" : marketState.market_state;
      const surgeMarketJudgmentReason = surgeHardBlock
        ? btcCrashGuard
          ? "btc_crash_guard"
          : "market_panic_guard"
        : surgeMarketState === "neutral"
          ? "neutral_allow_with_size_reduction"
          : surgeMarketState === "risk_off"
            ? "risk_off_allow_with_size_reduction"
            : "risk_on_normal";
      let surgeMarketSizeMultiplier = surgeMarketState === "risk_on" ? 1 : surgeMarketState === "neutral" ? 0.7 : surgeHardBlock ? 0 : 0.45;
      if (!isSurgeSource && marketState.market_state === "risk_off") {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "entry_skipped_risk_off",
          payload: { symbol: market, market_state: marketState.market_state, note: "non_surge_source_block" },
        });
        emitEval("entry_skipped_risk_off", { symbol: market, market_state: marketState.market_state, source_kind: sourceKindForJudgment });
        logPlacebuyFinalGateBlocked("entry_skipped_risk_off", { market_state: marketState.market_state, source_kind: sourceKindForJudgment });
        bumpSkip("entry_skipped_risk_off");
        continue;
      }
      if (isSurgeSource && surgeHardBlock) {
        // Log the market condition but do not terminate the loop here; let surge-v2/surge-entry-engine handle the rejection.
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_SURGE_MARKET_JUDGMENT",
            ts: new Date().toISOString(),
            symbol: market,
            source_kind: sourceKindForJudgment,
            global_market_state: marketState.market_state,
            surge_market_state: surgeMarketState,
            btc_crash_guard: btcCrashGuard,
            market_panic_guard: marketPanicGuard,
            candidate_volume_strength: Number(sig.p.volume_ratio ?? 0),
            candidate_momentum: Number(sig.p.momentum_3m_pct ?? sig.p.price_change_3m_pct ?? 0),
            distance_from_local_high_pct: null,
            volume_fade_triggered: null,
            setup_ok: candidateMetaMap.has(market),
            decision: "delegate_to_surge_v2",
            size_multiplier: 0,
            reason: surgeMarketJudgmentReason,
          }),
        );
      }
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
        const c1 = await fetchMinuteCandlesCached(market, 1, 12);
        const closes = c1.map((x) => Number(x.trade_price ?? 0)).filter((n: number) => Number.isFinite(n) && n > 0);
        const highs = c1.map((x) => Number(x.high_price ?? 0)).filter((n: number) => Number.isFinite(n) && n > 0);
        if (highs.length > 0) localHigh = Math.max(...highs);
        if (localHigh && currentPrice > 0) distanceFromLocalHighPct = ((localHigh - currentPrice) / localHigh) * 100;
        if (closes.length >= 2) recent1mRet = ((closes[closes.length - 1] / closes[closes.length - 2]) - 1) * 100;
        if (closes.length >= 4) recent3mRet = ((closes[closes.length - 1] / closes[closes.length - 4]) - 1) * 100;
        if (closes.length >= 6) recent5mRet = ((closes[closes.length - 1] / closes[closes.length - 6]) - 1) * 100;

        if (Number.isFinite(signalTsMs)) {
          // candle timestamp is `candle_date_time_utc` in upbit response (string ISO-ish). fall back other keys.
          let best: { t: number; px: number } | null = null;
          for (const x of c1) {
            const tRaw = String(x.candle_date_time_kst ?? "");
            const t = Date.parse(tRaw);
            const px = Number(x.trade_price ?? 0);
            if (!Number.isFinite(t) || !(px > 0)) continue;
            if (t <= signalTsMs && (!best || t > best.t)) best = { t, px };
          }
          if (best) signalPriceApprox = best.px;
          if (signalPriceApprox && currentPrice > 0) priceChangeSinceSignalPct = ((currentPrice / signalPriceApprox) - 1) * 100;
        }

        // Volume fade heuristic: latest notional vs avg previous 5 notional.
        if (c1.length >= 7) {
          const last = c1[c1.length - 1];
          const prev5 = c1.slice(-6, -1);
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
      if (isSurgeSource) {
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_SURGE_MARKET_JUDGMENT",
            ts: new Date().toISOString(),
            symbol: market,
            source_kind: sourceKindForJudgment,
            global_market_state: marketState.market_state,
            surge_market_state: surgeMarketState,
            btc_crash_guard: btcCrashGuard,
            market_panic_guard: marketPanicGuard,
            candidate_volume_strength: Number(sig.p.volume_ratio ?? 0),
            candidate_momentum: Number(sig.p.momentum_3m_pct ?? sig.p.price_change_3m_pct ?? 0),
            distance_from_local_high_pct: distanceFromLocalHighPct,
            volume_fade_triggered: volumeFadeTriggered,
            setup_ok: candidateMetaMap.has(market),
            decision: "allow_eval",
            size_multiplier: Number(surgeMarketSizeMultiplier.toFixed(4)),
            reason: surgeMarketJudgmentReason,
          }),
        );
      }

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
          momentum: Number(sig.p.momentum_3m_pct ?? sig.p.price_change_3m_pct ?? 0),
          market_state: marketState.market_state,
        }),
      );

      let lateEntryGuardTriggered = false;
      let lateEntryGuardReason: string | null = null;
      let lateTimingTier: "pass" | "hard_block" | "reduced_size_allowed" = "pass";
      const metaForGuard = candidateMeta.find((c) => c.market === market);
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
            distanceFromLocalHighPct !== null && distanceFromLocalHighPct < 0.12; // 김 사장 지시: 0.12% 미만은 하드 블락
          
          const coreRelaxedAllowNearHigh = (metaForGuard?.is_core_relaxed_candidate === true) && 
                                           (distanceFromLocalHighPct !== null && distanceFromLocalHighPct >= 0.12 && distanceFromLocalHighPct < 0.35);

          const coreTrendNearHighSoftAllowed =
            metaForGuard?.setupReason === "CORE_TREND_ENTRY" &&
            metaForGuard?.candle_source === "live_fetch" &&
            Number(metaForGuard?.riskReward ?? 0) >= 1.15 &&
            Number(metaForGuard?.volumeRatio ?? 0) >= LIVE_CORE_TREND_MIN_VOLUME_RATIO &&
            Number(metaForGuard?.stopPrice ?? 0) > 0;

          if (severeNearHigh && coreTrendNearHighSoftAllowed) {
            // CORE_TREND_ENTRY 후보는 near-high를 “소액 probe”로 낮추되, 다른 위험 신호는 기존 hard block 유지.
            lateTimingTier = "reduced_size_allowed";
            lateEntrySizingMultiplier *= 0.45;
            lateEntryGuardReason = `CORE_TREND_NEAR_HIGH_SOFT_GUARD:${distanceFromLocalHighPct!.toFixed(3)}pct<0.12pct`;
          } else if (severeNearHigh || (!softContextForMicroGuard && !coreRelaxedAllowNearHigh)) {
            lateEntryGuardTriggered = true;
            lateTimingTier = "hard_block";
            lateEntryGuardReason = `too_near_local_high:${distanceFromLocalHighPct!.toFixed(3)}pct<0.12pct`;
          } else {
            lateTimingTier = "reduced_size_allowed";
            lateEntrySizingMultiplier *= 0.45; // 김 사장 지시: 0.45 적용
            lateEntryGuardReason = `too_near_local_high_soft:${distanceFromLocalHighPct!.toFixed(3)}pct<0.35pct`;
            if (coreRelaxedAllowNearHigh) {
              metaForGuard?.softened_reasons?.push("CORE_NEAR_HIGH_SOFTENED");
              console.info(JSON.stringify({
                tag: "CORE_NEAR_HIGH_SOFTENED_PROOF",
                market,
                distance_from_local_high_pct: distanceFromLocalHighPct,
                original_block_reason: "too_near_local_high",
                size_multiplier: 0.45,
                reason: "near_high_softened_to_probe"
              }));
            }
          }
        }
        if (!lateEntryGuardTriggered && volFadeProblem) {
          const severeVol = volumeRatio1m5 !== null && volumeRatio1m5 < 0.35; // 김 사장 지시: 0.35 미만은 하드 블락
          
          // 수익률 조건: 1분/3분 동시에 음수면 완화 금지
          const negativeMomentum = (recent1mRet !== null && recent1mRet < 0) && (recent3mRet !== null && recent3mRet < 0);

          const coreRelaxedAllowVolFade = (metaForGuard?.is_core_relaxed_candidate === true) && 
                                          (volumeRatio1m5 !== null && volumeRatio1m5 >= 0.35) &&
                                          !negativeMomentum;

          if (severeVol || (!softContextForMicroGuard && !coreRelaxedAllowVolFade)) {
            lateEntryGuardTriggered = true;
            lateTimingTier = "hard_block";
            lateEntryGuardReason =
              volumeRatio1m5 !== null
                ? `volume_fade_after_spike:${volumeRatio1m5.toFixed(3)}<0.35`
                : "volume_fade_after_spike";
          } else {
            lateTimingTier = "reduced_size_allowed";
            lateEntrySizingMultiplier *= 0.45; // 김 사장 지시: 0.45 적용
            const vr = volumeRatio1m5 !== null ? volumeRatio1m5.toFixed(3) : "na";
            lateEntryGuardReason =
              lateEntryGuardReason !== null
                ? `${lateEntryGuardReason}|volume_fade_after_spike_soft:${vr}`
                : `volume_fade_after_spike_soft:${vr}`;
            if (coreRelaxedAllowVolFade) {
              metaForGuard?.softened_reasons?.push("CORE_VOLUME_FADE_SOFTENED");
              console.info(JSON.stringify({
                tag: "CORE_VOLUME_FADE_SOFTENED_PROOF",
                market,
                volume_ratio_1m5: volumeRatio1m5,
                recent_1m_return_pct: recent1mRet,
                recent_3m_return_pct: recent3mRet,
                original_block_reason: "volume_fade_after_spike",
                size_multiplier: 0.45,
                reason: "volume_fade_softened_to_probe"
              }));
            }
          }
        }
      }

      let entryAllowedByTiming = isSurgeSource || !lateEntryGuardTriggered;
      if (btcTierNow === "weak" && !isSurgeSource) {
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
      if (isSurgeSource && !lateEntryGuardTriggered && lateEntrySizingMultiplier < 1 - 1e-9) {
        surgeMarketSizeMultiplier *= lateEntrySizingMultiplier;
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
          source_kind: sourceKindForJudgment,
          source_ts: sourceMetaResolved.source_ts,
          age_seconds: sourceMetaResolved.age_seconds,
          stale_filtered_before_eval: sourceMetaResolved.stale_filtered_before_eval,
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
        const scoreOk = score >= Math.max(90, earlyMinScore);
        const notAlready = !state.positions[market] && !state.early_positions[market];
        const earlySlotOk = earlySlotsUsed < LIVE_EARLY_ENTRY_MAX_OPEN;
        const weakTier = btcTierNow === "weak";
        const weakOk = !weakTier || (score >= LIVE_WEAK_MARKET_MIN_SCORE && (volumeRatio1m5 ?? 0) >= Math.max(LIVE_EARLY_ENTRY_MIN_VOLUME_RATIO, 1.45));

        const earlyAllowed =
          realSignalPresent && notAlready && earlySlotOk && weakOk && secondsFreshOk && nearHighOk && volOk && scoreOk && currentPrice > 0 && localHigh !== null;
        const rawEarlyReason = !realSignalPresent
          ? "missing_real_signal"
          : !notAlready
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
          const surgeMinOrderKrw = Math.max(UPBIT_MIN_ORDER_KRW, Math.floor(surgeCapitalLimitKrw * SURGE_MIN_ORDER_RATIO));
          if (liveTradingOn && surgeRemainingForTickKrw < surgeMinOrderKrw) {
            console.info(
              JSON.stringify({
                tag: "DEBUG_LIVE_SURGE_CAPITAL_BLOCK",
                ts: new Date().toISOString(),
                market,
                totalLiveCapitalKrw,
                surgeCapitalLimitKrw,
                surgeUsedCapitalKrw,
                surgeCapitalRemainingKrw: surgeRemainingForTickKrw,
                requestedOrderKrw: null,
                reason: "surge_remaining_below_min_order",
              }),
            );
            logPlacebuyFinalGateBlocked("surge_remaining_below_min_order", { surge_remaining: surgeRemainingForTickKrw, min_order: surgeMinOrderKrw });
            bumpSkip("surge_remaining_below_min_order");
            continue;
          }
          const minOrderKrw = Math.max(surgeMinOrderKrw, LIVE_MIN_ENTRY_KRW);
          const baseBudget = perPositionBudgetBySymbol.get(market) ?? minOrderKrw;
          let earlyOrderKrw = Math.max(UPBIT_MIN_ORDER_KRW, Math.floor(baseBudget * LIVE_EARLY_ENTRY_SIZE_RATIO));
          if (liveTradingOn) {
            earlyOrderKrw = Math.min(earlyOrderKrw, surgeRemainingForTickKrw, LIVE_MAX_ENTRY_KRW);
          }
          console.info(
            JSON.stringify({
              tag: "LIVE_ORDER_PRECHECK_RESULT",
              ts: new Date().toISOString(),
              market,
              ok: true,
              path: "early_entry",
              order_krw: earlyOrderKrw,
              score: Math.round(score),
            }),
          );
          console.info(
            JSON.stringify({
              tag: "LIVE_PLACEBUY_ATTEMPT_FINAL_GATE",
              ts: new Date().toISOString(),
              market,
              path: "early_entry",
              final_block_reason: null,
              candidate_meta_missing_reason: null,
              entry_mode: "EARLY_ENTRY",
              preclearance_snapshot: {
                order_krw: earlyOrderKrw,
                score,
                seconds_since_signal: secondsSinceSignal,
                near_high_pct: distanceFromLocalHighPct,
                volume_ratio_1m5: volumeRatio1m5,
              },
              tick_lease: myLease,
            }),
          );
          console.info(
            JSON.stringify({
              tag: "LIVE_PLACEBUY_ATTEMPT",
              ts: new Date().toISOString(),
              market,
              path: "early_entry",
              order_krw: earlyOrderKrw,
              strategy_type: "momentum",
              tick_lease: myLease,
            }),
          );
          if (!assertLiveOrderAuthority("early_entry_before_placebuy")) {
            /* lease lost — fall through to normal path */
          } else {
            try {
              await opts.trade.placeBuy(market, true, earlyOrderKrw, "momentum", "strategy", {
                ...sig.p,
                __early_entry: true,
                __early_entry_size_ratio: LIVE_EARLY_ENTRY_SIZE_RATIO,
              });
              if (!leaseOk()) {
                console.info(
                  JSON.stringify({
                    tag: "LIVE_EARLY_ENTRY_STATE_SKIPPED_LEASE_REVOKED",
                    ts: new Date().toISOString(),
                    symbol: market,
                    order_krw: earlyOrderKrw,
                    tick_lease: myLease,
                    valid_lease: liveTickValidLease,
                    note: "exchange_call_returned_strategy_bookkeeping_skipped",
                  }),
                );
                bumpSkip("early_entry_lease_revoked_post_fill");
                continue;
              }
              const stEarly = await raceTradeStatus("early_entry_post_buy");
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
                entry_origin: "auto_trade",
                entry_mode: "SURGE_V2",
                market_state_at_entry: marketState.market_state,
                btc_tier_at_entry: btcTierNow,
                volatility_pct_at_entry: 0,
                entry_recent_high: Number(localHigh ?? currentPrice),
                entry_volume_ratio_1m5: Number(volumeRatio1m5 ?? 0),
                promoted: false,
                target_budget_krw: Math.floor(baseBudget),
                filled_entry_krw: earlyOrderKrw,
                engine_bucket: "surge",
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
              if (liveTradingOn) {
                surgeRemainingForTickKrw = Math.max(0, surgeRemainingForTickKrw - earlyOrderKrw);
              }
              bumpSkip("early_entry_filled");
              continue; // do not run normal entry in same tick for same symbol
            } catch {
              // fall through to normal path; early is best-effort scout slot
            }
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
        if (!isSurgeSource) {
          if (
            metaForGuard?.setupReason === "CORE_TREND_ENTRY" &&
            typeof lateEntryGuardReason === "string" &&
            lateEntryGuardReason.startsWith("too_near_local_high:")
          ) {
            logPlacebuyFinalGateBlocked("core_trend_late_guard:too_near_local_high", {
              entry_mode: "CORE_TREND_ENTRY",
              late_entry_guard_reason: lateEntryGuardReason,
              candle_source: metaForGuard?.candle_source ?? null,
              candle_cache_age_ms: metaForGuard?.candle_cache_age_ms ?? null,
            });
          }
          bumpSkip("late_entry_guard");
          continue;
        }
      }

      // late guard 통과 이후: 어떤 이유로든 주문 시도/차단 로그가 유실되지 않도록 "pre-order gate" 진입 로그를 남긴다.
      console.info(
        JSON.stringify({
          tag: "LIVE_PREORDER_GATE_CHECK",
          ts: new Date().toISOString(),
          market,
          entry_mode: isSurgeSource
            ? "SURGE_V2"
            : metaForGuard?.setupReason === "CORE_TREND_ENTRY"
              ? "CORE_TREND_ENTRY"
              : "CORE_SPOT_DEFAULT",
          candle_source: metaForGuard?.candle_source ?? null,
          candle_cache_age_ms: metaForGuard?.candle_cache_age_ms ?? null,
          late_entry_guard_reason: lateEntryGuardReason,
          late_entry_sizing_multiplier: Number(lateEntrySizingMultiplier.toFixed(4)),
        }),
      );
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
        if (!isSurgeSource) {
          continue;
        }
      }
      // Surge sources bypass legacy MID gate checks to delegate score/momentum judgment to the surge-v2 engine.
      if (!isSurgeSource && sigTypeUpper === "MID") {
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
      const quality = classifyEntryQuality({
        market,
        score: signalScore,
        secondsSinceSignal,
        distanceFromLocalHighPct,
        volumeRatio: volumeRatio1m5 ?? vol,
        btcTier: btcTierNow,
      });
      const entryProfileFeatures: LiveEntryProfileFeatures = {
        signal_type: String(sig.p.signal_type ?? "MID"),
        position_stage: quality.earlyEligible ? "early_active" : "normal_active",
        btc_tier: btcTierNow,
        score_bucket: bucketScore(signalScore),
        volume_ratio_bucket: bucketVol(volumeRatio1m5 ?? vol),
        signal_age_bucket: bucketAge(secondsSinceSignal),
        chase_bucket: bucketChase(priceChangeSinceSignalPct),
        near_high_bucket: bucketNear(distanceFromLocalHighPct),
        breakout,
        early_entry_flag: quality.earlyEligible,
      };
      const entry_profile_key = makeEntryProfileKey(entryProfileFeatures);
      const profileInfo = evaluateEntryProfileDecision(state.entry_profile_stats?.[entry_profile_key]);
      emitEval("DEBUG_LIVE_PROFILE_GATE", {
        entry_profile_key,
        profile_decision: profileInfo.decision,
        profile_reason: profileInfo.reason,
        profile_stats: state.entry_profile_stats?.[entry_profile_key] ?? null,
      });
      if (profileInfo.decision === "block") {
        bumpSkip("profile_block");
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: profileInfo.reason,
          payload: { symbol: market, entry_profile_key, profile_decision: "block" },
        });
        if (!isSurgeSource) {
          continue;
        }
      }
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
      const strongSymbolOverride =
        !NO_STRONG_SYMBOL_OVERRIDE_MARKETS.has(market) &&
        signalScore >= 80 &&
        rel >= 0.5 &&
        vol >= 1.05 &&
        trendOk;
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

      // SURGE_V2 hardening: scanner-derived discovery is NOT a buy-allow condition.
      // Enforce hard blocks for scanner-only scenarios and known filter failures.
      if (isSurgeSource) {
        const scannerSource = String(payloadSourceKind || sourceKindForJudgment || "");
        const isScannerDerived =
          scannerSource.includes("scanner") ||
          scannerSource.includes("scanner_filter_fresh") ||
          scannerSource.includes("scanner_tradable_candidate") ||
          scannerSource.includes("scanner_bridge_score_fail");

        if (isScannerDerived && filterPassCount === 0) {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "surge_scanner_only_filter_pass_count_zero" });
          logPlacebuyFinalGateBlocked("surge_scanner_only_filter_pass_count_zero", {
            entry_mode: "SURGE_V2",
            filter_pass_count: filterPassCount,
            scanner_source: scannerSource,
          });
          bumpSkip("surge_scanner_only_filter_pass_count_zero");
          continue;
        }

        if (!filterPass) {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "surge_filter_pass_required" });
          logPlacebuyFinalGateBlocked("surge_filter_pass_required", {
            entry_mode: "SURGE_V2",
            filter_pass: filterPass,
            scanner_source: scannerSource,
          });
          bumpSkip("surge_filter_pass_required");
          continue;
        }

        const filtersArr = Array.isArray(sig.p.filters) ? (sig.p.filters as Array<{ id?: unknown; passed?: unknown }>) : [];
        const failedFilterIds = new Set(
          filtersArr
            .filter((f) => f && f.passed === false)
            .map((f) => String(f.id ?? ""))
            .filter((x) => x.length > 0),
        );
        const volumeIncreaseFailed = failedFilterIds.has("volume_increase");
        const boxBreakoutFailed = failedFilterIds.has("box_breakout");
        const closeUpperHoldFailed = failedFilterIds.has("volume_spike_close_fail");

        if (volumeIncreaseFailed && boxBreakoutFailed) {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "surge_scanner_volume_and_breakout_failed" });
          logPlacebuyFinalGateBlocked("surge_scanner_volume_and_breakout_failed", {
            entry_mode: "SURGE_V2",
            failed_filters: [...failedFilterIds],
            scanner_source: scannerSource,
          });
          bumpSkip("surge_scanner_volume_and_breakout_failed");
          continue;
        }

        if (closeUpperHoldFailed) {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "surge_scanner_close_upper_hold_failed" });
          logPlacebuyFinalGateBlocked("surge_scanner_close_upper_hold_failed", {
            entry_mode: "SURGE_V2",
            failed_filters: [...failedFilterIds],
            scanner_source: scannerSource,
          });
          bumpSkip("surge_scanner_close_upper_hold_failed");
          continue;
        }

        const setupFailed = (candidateMetaFromSetup?.surge_shadow_setup?.failed_conditions ?? []).map((x: any) => String(x ?? ""));
        const hardSetupFails = ["volume_spike_close_fail", "high_rejected", "retest_fail", "volume_fade"];
        const hitHardSetupFail = hardSetupFails.find((k) => setupFailed.some((s) => s.includes(k)));
        if (hitHardSetupFail) {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: `surge_setup_failed:${hitHardSetupFail}` });
          logPlacebuyFinalGateBlocked(`surge_setup_failed:${hitHardSetupFail}`, {
            entry_mode: "SURGE_V2",
            failed_surge_conditions: setupFailed,
            scanner_source: scannerSource,
          });
          bumpSkip(`surge_setup_failed:${hitHardSetupFail}`);
          continue;
        }

        if (volumeState === "faded") {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "surge_volume_fade_hard_block" });
          logPlacebuyFinalGateBlocked("surge_volume_fade_hard_block", {
            entry_mode: "SURGE_V2",
            volume_state: volumeState,
            scanner_source: scannerSource,
          });
          bumpSkip("surge_volume_fade_hard_block");
          continue;
        }
      }
      if (isExceptionMarket && !exception) {
        const baseGateBlockedDetailForBypass =
          !gateOk && !strongSymbolOverride ? (detailedReason ?? "base_gate_failed") : null;
        const surgeExceptionSelectionBypass =
          isSurgeSource &&
          !!candidateMetaFromSetup &&
          !candidateMetaEvalDropReason &&
          gateOk === true &&
          filterPass === true &&
          Number(candidateMetaFromSetup?.stopPrice ?? 0) > 0 &&
          Number(candidateMetaFromSetup?.riskReward ?? 0) > 0 &&
          baseGateBlockedDetailForBypass === null;

        if (surgeExceptionSelectionBypass) {
          console.info(
            JSON.stringify({
              tag: "SURGE_EXCEPTION_SELECTION_BYPASS_PROOF",
              ts: new Date().toISOString(),
              market,
              entry_mode: "SURGE_V2",
              base_gate_ok: gateOk,
              base_gate_blocked_detail: null,
              candidate_meta_present: true,
              candidate_meta_missing_reason: null,
              reason: "surge_v2_base_gate_passed_exception_not_selected_bypassed",
            }),
          );
        } else {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "exception_not_selected" });
          logPlacebuyFinalGateBlocked("exception_not_selected", {
            entry_mode: isSurgeSource
              ? "SURGE_V2"
              : candidateMetaFromSetup?.setupReason === "CORE_TREND_ENTRY"
                ? "CORE_TREND_ENTRY"
                : "CORE_SPOT_DEFAULT",
            base_gate_ok: gateOk,
            base_gate_blocked_detail: baseGateBlockedDetailForBypass,
          });
          bumpSkip("exception_not_selected");
          continue;
        }
      }
      if (!gateOk && !strongSymbolOverride) {
        // Surge candidates must bypass the core gate unless it's a hard state block (exists/cooldown).
        const isHardBlock = detailedReason === "cooldown_active" || detailedReason === "position_exists";
        if (!isSurgeSource || isHardBlock) {
          emitEval("DEBUG_LIVE_PRECHECK", { return_reason: detailedReason ?? "base_gate_failed" });
          logPlacebuyFinalGateBlocked("base_gate_fail", {
            entry_mode: isSurgeSource
              ? "SURGE_V2"
              : candidateMetaFromSetup?.setupReason === "CORE_TREND_ENTRY"
                ? "CORE_TREND_ENTRY"
                : "CORE_SPOT_DEFAULT",
            base_gate_blocked_detail: detailedReason ?? "base_gate_failed",
          });
          bumpSkip(detailedReason ?? "base_gate_failed");
          continue;
        }
        // Surge source bypasses core gate for non-hard blocks: 반드시 최종 게이트(soft bypass) 로그를 남긴다.
        console.info(
          JSON.stringify({
            tag: "LIVE_PLACEBUY_ATTEMPT_FINAL_GATE",
            ts: new Date().toISOString(),
            market,
            path: "preorder_base_gate_soft_bypass",
            entry_mode: "SURGE_V2",
            final_block_reason: null,
            candidate_meta_missing_reason: null,
            blocked_before_placebuy: false,
            tick_lease: myLease,
            base_gate_soft_bypass: true,
            base_gate_blocked_detail: detailedReason ?? "base_gate_failed",
          }),
        );
      }

      let entryPipelineDetail: Record<string, unknown> = {};
      try {
        const candles5 = await fetchMinuteCandlesCached(market, 5, 48);
        const staleOk =
          sourceMetaResolved.age_seconds !== null && sourceMetaResolved.age_seconds <= LIVE_ENTRY_SIGNAL_STALE_SECONDS;
        const bridgePass = Boolean(scannerBridgeScore?.pass);
        const surgeSourceKindLog = payloadSourceKind || sourceKindForJudgment;
        if (isSurgeSource) {
          const surgeSetupFromCandidate = candidateMetaFromSetup?.surge_shadow_setup;
          const decision = evaluateSurgeEntryPipeline({
            market,
            payload: sig.p,
            candles5,
            marketState: {
              market_state: marketState.market_state,
              btc_5m_trend: marketState.btc_5m_trend ?? "flat",
              btc_15m_trend: marketState.btc_15m_trend ?? "flat",
              btc_change_24h: btcChange,
            },
            volumeRatio: vol,
            bridgePass,
            staleOk,
            ageSeconds: sourceMetaResolved.age_seconds,
            surgeSetupPass: surgeSetupFromCandidate?.ok,
            surgeSetupScore: surgeSetupFromCandidate?.score,
            surgeSetupGrade: surgeSetupFromCandidate?.grade,
            failedSurgeConditions: surgeSetupFromCandidate?.failed_conditions,
          });

          console.info(
            JSON.stringify({
              tag: "SURGE_V2_ENTRY_DECISION_PROOF",
              ts: new Date().toISOString(),
              market,
              source_kind: surgeSourceKindLog,
              scanner_score: Number(sig?.p?.scanner_score ?? sig?.p?.signal_score ?? 0),
              volume_multiple: vol,
              breakout: Boolean(sig?.p?.breakout),
              close_upper_hold: Boolean(sig?.p?.close_upper_hold),
              rise_3m_pct: Number(sig?.p?.rise_3m_pct ?? sig?.p?.momentum_3m_pct ?? sig?.p?.price_change_3m_pct ?? 0),
              bridge_pass: bridgePass,
              filter_pass: filterPass,
              stale_ok: staleOk,
              btc_change_24h: btcChange,
              btc_5m_trend: marketState.btc_5m_trend,
              btc_15m_trend: marketState.btc_15m_trend,
              gate_ok_before_surge: gateOk,
              gate_block_reason_before_surge: detailedReason ?? null,
              setup_tagged_surge: isSetupTaggedSurge,
              surge_setup_pass: surgeSetupFromCandidate?.ok ?? null,
              surge_setup_score: surgeSetupFromCandidate?.score ?? null,
              surge_setup_grade: surgeSetupFromCandidate?.grade ?? null,
              failed_surge_conditions: surgeSetupFromCandidate?.failed_conditions ?? [],
              decision_action: decision.action,
              decision_reason: decision.reason,
              authority_source: "surge-v2",
            }),
          );

          if (decision.action === "reject") {
            await appendLog({
              company_id: companyIdSchema.parse(opts.companyId),
              service_id: serviceIdSchema.parse(opts.serviceId),
              ts: new Date().toISOString(),
              kind: "system",
              message: decision.reason,
              payload: decision.detail,
            });
            emitEval(decision.reason, decision.detail);
            emitEval("DEBUG_LIVE_DECISION_LINE", {
              available_krw: Number((await raceTradeStatus("decision_line_surge_reject")).live_order_available_krw ?? 0),
              planned_entry_krw: null,
              entry_score: Number(signalScore.toFixed(2)),
              min_entry_score: marketState.min_entry_score,
              volume_ratio: Number(vol.toFixed(3)),
              breakout,
              breakout_relaxed: breakoutRelaxed,
              final_block_reason: decision.reason,
            });
            bumpSkip(decision.reason);
            continue;
          }
          entryPipelineDetail = { ...decision.detail, entry_pipeline: "surge" };
        } else {
          let pr = evaluateSpotLongEntryPipeline({
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

          const isCoreRelaxed = (metaForGuard?.is_core_relaxed_candidate === true);
          if (!pr.ok && isCoreRelaxed) {
             const message = pr.message || "";
             if (message === "blocked_rebreak_not_confirmed" || message === "blocked_no_pullback") {
                // Soften rebreak/pullback rejections for high-quality core candidates
                pr = { ok: true, detail: { ...pr.detail, softened_gate: true, original_message: message } };
                metaForGuard?.softened_reasons?.push(`CORE_GATE_SOFTENED:${message}`);
             }
          }

          if (!pr.ok) {
            console.info(
              JSON.stringify({
                tag: "LIVE_ENTRY_PIPELINE_RESULT",
                ts: new Date().toISOString(),
                market,
                ok: false,
                message: pr.message,
                detail: pr.detail ?? null,
              }),
            );
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
              available_krw: Number((await raceTradeStatus("decision_line_core_pipeline_reject")).live_order_available_krw ?? 0),
              planned_entry_krw: null,
              entry_score: Number(signalScore.toFixed(2)),
              min_entry_score: marketState.min_entry_score,
              volume_ratio: Number(vol.toFixed(3)),
              breakout,
              breakout_relaxed: breakoutRelaxed,
              final_block_reason: pr.message,
            });
            console.info(
              JSON.stringify({
                tag: "CORE_ENTRY_FINAL_DECISION_PROOF",
                ts: new Date().toISOString(),
                market,
                decision: "reject",
                reason: pr.message,
                detail: pr.detail,
                authority_source: "core",
              }),
            );
            bumpSkip(pr.message);
            continue;
          }
          entryPipelineDetail = pr.detail;
          console.info(
            JSON.stringify({
              tag: "CORE_ENTRY_FINAL_DECISION_PROOF",
              ts: new Date().toISOString(),
              market,
              decision: "allow",
              detail: entryPipelineDetail,
              authority_source: "core",
            }),
          );
          console.info(
            JSON.stringify({
              tag: "LIVE_ENTRY_PIPELINE_RESULT",
              ts: new Date().toISOString(),
              market,
              ok: true,
              detail: entryPipelineDetail,
            }),
          );
        }
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
          available_krw: Number((await raceTradeStatus("decision_line_candles_fetch_failed")).live_order_available_krw ?? 0),
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

      const st = await raceTradeStatus("entry_precheck_existing_holdings");
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
      const bridgePassForLog = Boolean(scannerBridgeScore?.pass);
      const scannerScoreForLog = Number(sig?.p?.scanner_score ?? sig?.p?.signal_score ?? 0);
      const rise3ForLog = Number(sig?.p?.rise_3m_pct ?? sig?.p?.momentum_3m_pct ?? sig?.p?.price_change_3m_pct ?? 0);
      const emitFinalBlocked = (finalReason: string, extra?: Record<string, unknown>) => {
        const mergedFb = { ...(extra ?? {}) };
        const candidate_meta_missing_reason =
          mergedFb.candidate_meta_missing_reason !== undefined ? mergedFb.candidate_meta_missing_reason : null;
        delete mergedFb.candidate_meta_missing_reason;
        const entry_mode_blocked =
          typeof mergedFb.entry_mode === "string"
            ? (mergedFb.entry_mode as string)
            : isSurgeSource
              ? "SURGE_V2"
              : "CORE_SPOT_DEFAULT";
        delete mergedFb.entry_mode;
        console.info(
          JSON.stringify({
            tag: "LIVE_PLACEBUY_ATTEMPT_FINAL_GATE",
            ts: new Date().toISOString(),
            market,
            path: isSurgeSource ? "surge_normal" : "normal",
            entry_mode: entry_mode_blocked,
            final_block_reason: finalReason,
            candidate_meta_missing_reason,
            blocked_before_placebuy: true,
            tick_lease: myLease,
            ...mergedFb,
          }),
        );
        console.info(
          JSON.stringify({
            tag: "LIVE_ENTRY_FINAL_BLOCKED",
            ts: new Date().toISOString(),
            market,
            source_kind: sourceKindForJudgment,
            scanner_score: Number.isFinite(scannerScoreForLog) ? scannerScoreForLog : 0,
            volume_multiple: Number.isFinite(vol) ? vol : Number(sig?.p?.volume_ratio ?? 0),
            breakout: Boolean(sig?.p?.breakout),
            close_upper_hold: Boolean(sig?.p?.close_upper_hold),
            rise_3m_pct: Number.isFinite(rise3ForLog) ? rise3ForLog : 0,
            bridge_pass: bridgePassForLog,
            filter_pass: Boolean(sig?.p?.filter_pass),
            surge_pipeline_ok: true,
            order_precheck_ok: false,
            final_reason: finalReason,
            candidate_meta_missing_reason,
            entry_mode: entry_mode_blocked,
            auto_trade_enabled: Boolean(st.auto_trade_enabled),
            live_enabled: Boolean(st.live_enabled),
            api_connected: Boolean(st.api_connected),
            recovery_ready: (st as any)?.recovery_ready === true ? true : (st as any)?.recovery_ready === false ? false : null,
            available_krw: liveOrderAvailableKrw,
            open_positions: openCountNow,
            max_positions: state.safety_guard.max_positions,
            ...mergedFb,
          }),
        );
      };
      const surgeMinOrderKrw = Math.max(UPBIT_MIN_ORDER_KRW, Math.floor(surgeCapitalLimitKrw * SURGE_MIN_ORDER_RATIO));
      if (liveTradingOn && surgeRemainingForTickKrw < surgeMinOrderKrw) {
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_SURGE_CAPITAL_BLOCK",
            ts: new Date().toISOString(),
            market,
            totalLiveCapitalKrw,
            surgeCapitalLimitKrw,
            surgeUsedCapitalKrw,
            surgeCapitalRemainingKrw: surgeRemainingForTickKrw,
            requestedOrderKrw: null,
            reason: "surge_remaining_below_min_order",
          }),
        );
        bumpSkip("surge_remaining_below_min_order");
        emitFinalBlocked("surge_remaining_below_min_order", { surge_remaining_krw: surgeRemainingForTickKrw, min_order_krw: surgeMinOrderKrw });
        continue;
      }
      const minOrderKrw = Math.max(surgeMinOrderKrw, LIVE_MIN_ENTRY_KRW);
      const baseBudget = perPositionBudgetBySymbol.get(market) ?? minOrderKrw;
      let orderKrw = Math.max(minOrderKrw, Math.min(LIVE_MAX_ENTRY_KRW, baseBudget));
      if (isExceptionMarket) orderKrw = Math.floor(orderKrw * 0.9);
      if (!isSurgeSource && lateEntrySizingMultiplier < 1 - 1e-9) {
        orderKrw = Math.max(minOrderKrw, Math.floor(orderKrw * lateEntrySizingMultiplier));
      }
      if (isSurgeSource && surgeMarketSizeMultiplier < 1 - 1e-9) {
        orderKrw = Math.max(minOrderKrw, Math.floor(orderKrw * surgeMarketSizeMultiplier));
      }

      // Core Relaxed Probe Sizing: Fixed multipliers based on softening
      if (metaForGuard?.is_relaxed_probe || metaForGuard?.softened_reasons?.length) {
        let relaxedMult = metaForGuard?.relaxed_multiplier ?? 0.35;
        if (metaForGuard?.softened_reasons?.includes("CORE_NEAR_HIGH_SOFTENED")) {
          relaxedMult = Math.min(relaxedMult, 0.25); 
        }
        if (metaForGuard?.softened_reasons?.includes("CORE_VOLUME_FADE_SOFTENED")) {
          relaxedMult = Math.min(relaxedMult, 0.25);
        }
        
        const effectiveOrderKrw = Math.floor(orderKrw * relaxedMult);
        if (effectiveOrderKrw < minOrderKrw || effectiveOrderKrw < 5000) {
           console.info(JSON.stringify({
             tag: "CORE_MIN_ORDER_UNDERFLOW",
             market,
             order_krw: effectiveOrderKrw,
             min_required: Math.max(minOrderKrw, 5000),
             is_relaxed_probe: true,
             reason: "relaxed_probe_amount_too_small"
           }));
           bumpSkip("order_krw_below_min_relaxed");
           continue; 
        }

        orderKrw = effectiveOrderKrw;
        console.info(JSON.stringify({
          tag: "CORE_ENTRY_PROBE_SIZING_PROOF",
          market,
          base_order_krw: baseBudget,
          final_order_krw: orderKrw,
          relaxed_multiplier: relaxedMult,
          softened_reasons: metaForGuard?.softened_reasons
        }));
      }

      const stPos = st.strategy_positions?.[market];
      const investedSoFar = Math.max(0, Number(stPos?.invested_krw_total ?? 0));
      const remainingPerMarket = Math.max(0, ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET - investedSoFar);
      orderKrw = Math.min(orderKrw, remainingPerMarket);
      orderKrw = Math.min(orderKrw, surgeRemainingForTickKrw, liveOrderAvailableKrw, LIVE_MAX_ENTRY_KRW);

      // Required pre-order snapshot log (must exist before any new entry attempt).
      // Note: `LIVE_PREORDER_GATE_CHECK` earlier is the pipeline entry log; this one is the final "preorder allowed?" snapshot.
      {
        const requiredCapitalKrw = Math.floor(orderKrw);
        const capRemainingKrw = Math.floor(Math.max(0, surgeCapitalLimitKrw - surgeUsedCapitalKrw));
        const projectedUsedKrw = Math.floor(surgeUsedCapitalKrw + requiredCapitalKrw);
        const finalAllowed = !(surgeCapitalLimitKrw > 0 && projectedUsedKrw > surgeCapitalLimitKrw);
        const scannerSource = String(payloadSourceKind || sourceKindForJudgment || "");
        const stopPrice = isSurgeSource ? Number(metaForGuard?.stopPrice ?? 0) : null;
        const riskReward = isSurgeSource ? Number(metaForGuard?.riskReward ?? 0) : null;
        console.info(
          JSON.stringify({
            tag: "LIVE_PREORDER_GATE_CHECK",
            ts: new Date().toISOString(),
            market,
            totalEquity: Math.floor(totalLiveCapitalKrw),
            surgeCapAmount: Math.floor(surgeCapitalLimitKrw),
            usedCapitalIncludingPassive: Math.floor(surgeUsedCapitalKrw),
            pendingBuyReserved: Math.floor(reservedKrw),
            requiredCapital: requiredCapitalKrw,
            capRemaining: capRemainingKrw,
            filter_pass: Boolean(sig?.p?.filter_pass),
            base_gate_ok: gateOk,
            scanner_source: scannerSource,
            stopPrice,
            riskReward,
            final_preorder_allowed: finalAllowed,
            block_reason: finalAllowed ? null : "capital_cap_exceeded",
          }),
        );
      }

      // Capital cap gate (account-wide equity based).
      // Block *before* placing new order if (used + requiredCapital) exceeds the fixed 50% cap.
      if (liveTradingOn && orderKrw > 0) {
        const requiredCapitalKrw = Math.floor(orderKrw);
        const projectedUsedKrw = Math.floor(surgeUsedCapitalKrw + requiredCapitalKrw);
        if (surgeCapitalLimitKrw > 0 && projectedUsedKrw > surgeCapitalLimitKrw) {
          const tag = isSurgeSource ? "SURGE_CAP_EXCEEDED_BLOCK" : "SPOT_CAP_EXCEEDED_BLOCK";
          console.info(
            JSON.stringify({
              tag,
              ts: new Date().toISOString(),
              market,
              stage: "LIVE_PREORDER_GATE_CHECK",
              entry_mode: isSurgeSource ? "SURGE_V2" : "CORE_SPOT_DEFAULT",
              required_capital_krw: requiredCapitalKrw,
              used_capital_krw: Math.floor(surgeUsedCapitalKrw),
              projected_used_capital_krw: projectedUsedKrw,
              cap_limit_krw: Math.floor(surgeCapitalLimitKrw),
              total_equity_krw: Math.floor(totalLiveCapitalKrw),
              reserved_krw: Math.floor(reservedKrw),
            }),
          );
          bumpSkip("capital_cap_exceeded");
          emitFinalBlocked("capital_cap_exceeded", {
            required_capital_krw: requiredCapitalKrw,
            used_capital_krw: Math.floor(surgeUsedCapitalKrw),
            projected_used_capital_krw: projectedUsedKrw,
            cap_limit_krw: Math.floor(surgeCapitalLimitKrw),
            total_equity_krw: Math.floor(totalLiveCapitalKrw),
            reserved_krw: Math.floor(reservedKrw),
          });
          continue;
        }
      }

      const gateScore = Number(opts.marketState.entryGate(sig.p, marketState).score ?? 0);
      emitEval("DEBUG_LIVE_ORDER_SIZING", {
        available_krw: liveOrderAvailableKrw,
        max_alloc_krw: capPlan.deployableAfterBufferKrw,
        planned_entry_krw: orderKrw,
        late_entry_sizing_multiplier: lateEntrySizingMultiplier,
        surge_market_size_multiplier: isSurgeSource ? Number(surgeMarketSizeMultiplier.toFixed(4)) : null,
        min_entry_krw: minOrderKrw,
        max_entry_krw: LIVE_MAX_ENTRY_KRW,
        allocation_mode: "weighted",
        allocation_tier: candidateMeta.find((c) => c.market === market)?.tier ?? null,
        per_position_budget_krw: baseBudget,
        max_symbol_cap_ratio: candidateMeta.find((c) => c.market === market)?.tier === "A" ? 0.45 : candidateMeta.find((c) => c.market === market)?.tier === "B" ? 0.3 : 0.2,
        per_market_cap_krw: ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET,
        per_market_remaining_krw: remainingPerMarket,
        entry_score: gateScore,
        min_entry_score: marketState.min_entry_score,
        entry_size_pct: entrySizePct,
        legacy_dca_buy_enabled: LIVE_LEGACY_DCA_BUY_ENABLED,
      });
      if (liveTradingOn) {
        const paperProfileKey = candidateMeta.find((c) => c.market === market)?.paper_profile_key;
        const paperStat = paperProfileKey ? paperStatsMap[paperProfileKey] : undefined;
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_SIZE_AFTER_PAPER_PATTERN",
            ts: new Date().toISOString(),
            market,
            totalLiveCapitalKrw,
            surgeCapitalLimitKrw,
            surgeUsedCapitalKrw,
            surgeCapitalRemainingKrw: surgeRemainingForTickKrw,
            baseOrderKrw: baseBudget,
            surgeMinOrderKrw,
            paperPatternMultiplier: candidateMeta.find((c) => c.market === market)?.paper_pattern_multiplier ?? 1,
            riskTagMultiplier: candidateMeta.find((c) => c.market === market)?.risk_tag_multiplier ?? 1,
            lateEntryMultiplier: lateEntrySizingMultiplier,
            finalOrderKrw: orderKrw,
            paperProfileKey: paperProfileKey ?? null,
            paperConfidence: paperStat?.confidence ?? "low",
            paperWinRate: paperStat?.win_rate ?? 0,
            paperAvgPnlPct: paperStat?.avg_pnl_pct ?? 0,
          }),
        );
      }
      if (surgeOpenCount >= SURGE_MAX_OPEN_POSITIONS && !stPos) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "surge_max_positions_reached", surgeOpenCount, SURGE_MAX_OPEN_POSITIONS });
        bumpSkip("surge_max_positions_reached");
        emitFinalBlocked("surge_max_positions_reached", { surge_open_positions: surgeOpenCount, surge_max_open_positions: SURGE_MAX_OPEN_POSITIONS });
        continue;
      }
      if (orderKrw < 5000) {
        if (!isSurgeSource) {
          console.info(JSON.stringify({
            tag: "CORE_MIN_ORDER_UNDERFLOW",
            market,
            order_krw: orderKrw,
            min_required: 5000,
            is_relaxed_probe: metaForGuard?.is_relaxed_probe,
            reason: "order_amount_too_small_after_sizing"
          }));
        }
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "order_krw_below_min", order_krw: orderKrw });
        bumpSkip("order_krw_below_min");
        emitFinalBlocked("order_krw_below_min", { order_krw: orderKrw });
        continue;
      }
      if (liveOrderAvailableKrw < orderKrw) {
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: "insufficient_live_order_krw",
          live_order_available_krw: liveOrderAvailableKrw,
          order_krw: orderKrw,
        });
        bumpSkip("insufficient_live_order_krw");
        emitFinalBlocked("insufficient_live_order_krw", { live_order_available_krw: liveOrderAvailableKrw, order_krw: orderKrw });
        continue;
      }
      const strategyType: StrategyType = marketState.market_state === "risk_on" ? "momentum" : "stable";
      const signalPayloadForBuy = {
        ...sig.p,
        __allow_risk_scaled_entry: true,
        __strong_symbol_override: strongSymbolOverride,
        __risk_off_exception_reason: exception?.reason,
      };

      // SURGE_V2: stopPrice must be precomputed before LIVE_PLACEBUY_ATTEMPT.
      const finalMeta = candidateMeta.find((x) => x.market === market) ?? null;
      const surgeStopPrice = isSurgeSource ? Number(finalMeta?.stopPrice ?? 0) : 0;
      const surgeStopReason = isSurgeSource ? String(finalMeta?.setupReason ?? "candidate_meta_stop") : "";
      const surgeRiskPct =
        isSurgeSource && currentPrice > 0 && surgeStopPrice > 0
          ? Number((((currentPrice - surgeStopPrice) / currentPrice) * 100).toFixed(4))
          : null;

      if (isSurgeSource) {
        console.info(
          JSON.stringify({
            tag: "SURGE_STOP_PRICE_PROOF",
            ts: new Date().toISOString(),
            market,
            entry_mode: "SURGE_V2",
            current_price: currentPrice,
            stopPrice: surgeStopPrice > 0 ? surgeStopPrice : null,
            riskPct: surgeRiskPct,
            stopReason: surgeStopReason || null,
            source_kind: sourceKindForJudgment,
            candle_source: finalMeta?.candle_source ?? null,
            candle_cache_age_ms: finalMeta?.candle_cache_age_ms ?? null,
          }),
        );
        if (!(surgeStopPrice > 0)) {
          console.info(
            JSON.stringify({
              tag: "SURGE_STOP_MISSING_BLOCK",
              ts: new Date().toISOString(),
              market,
              entry_mode: "SURGE_V2",
              final_block_reason: "surge_stop_missing",
              stopPrice: surgeStopPrice > 0 ? surgeStopPrice : null,
              stopReason: surgeStopReason || null,
              candidate_meta_present: Boolean(finalMeta),
              candidate_meta_missing_reason: finalMeta ? null : "candidate_meta_absent",
            }),
          );
          logPlacebuyFinalGateBlocked("surge_stop_missing", {
            entry_mode: "SURGE_V2",
            stopPrice: surgeStopPrice > 0 ? surgeStopPrice : null,
            stopReason: surgeStopReason || null,
          });
          continue;
        }
      }

      console.info(
        JSON.stringify({
          tag: "LIVE_ORDER_PRECHECK_RESULT",
          ts: new Date().toISOString(),
          market,
          ok: true,
          path: isSurgeSource ? "surge_normal" : "normal",
          order_krw: orderKrw,
          live_order_available_krw: liveOrderAvailableKrw,
          open_positions: openCountNow,
          remaining_slots: remainingSlots,
          strategy_type: strategyType,
          source_kind: sourceKindForJudgment,
          filter_pass: Boolean(sig.p.filter_pass),
        }),
      );
      if (!assertLiveOrderAuthority("core_entry_before_attempt")) {
        bumpSkip("tick_lease_revoked");
        emitFinalBlocked("tick_lease_revoked", { order_krw: orderKrw });
        continue;
      }
      console.info(
        JSON.stringify({
          tag: "LIVE_PLACEBUY_ATTEMPT_FINAL_GATE",
          ts: new Date().toISOString(),
          market,
          path: isSurgeSource ? "surge_normal" : "normal",
          final_block_reason: null,
          candidate_meta_missing_reason: null,
          entry_mode: isSurgeSource
            ? "SURGE_V2"
            : metaForGuard?.setupReason === "CORE_TREND_ENTRY"
              ? "CORE_TREND_ENTRY"
              : "CORE_SPOT_DEFAULT",
          preclearance_snapshot: {
            order_krw: orderKrw,
            strategy_type: strategyType,
            is_surge_source: isSurgeSource,
            surge_stopPrice: isSurgeSource ? surgeStopPrice : null,
            surge_riskPct: isSurgeSource ? surgeRiskPct : null,
            surge_stopReason: isSurgeSource ? surgeStopReason : null,
            strong_symbol_override_applied: strongSymbolOverride,
            base_gate_blocked_detail: detailedReason,
            gate_ok_effective: gateOk || strongSymbolOverride,
            late_entry_guard_reason: lateEntryGuardReason,
            meta_gate_reason: metaForGuard?.gate_reason ?? null,
            meta_setup_ok: metaForGuard?.setup?.ok ?? null,
            meta_setup_reason: metaForGuard?.setupReason ?? null,
            candle_source: metaForGuard?.candle_source ?? null,
            candle_cache_age_ms: metaForGuard?.candle_cache_age_ms ?? null,
            is_fresh_signal: metaForGuard?.is_fresh_signal ?? null,
            is_watch_candidate: metaForGuard?.is_watch_candidate ?? null,
          },
          tick_lease: myLease,
        }),
      );
      console.info(
        JSON.stringify({
          tag: "LIVE_PLACEBUY_ATTEMPT",
          ts: new Date().toISOString(),
          market,
          path: isSurgeSource ? "surge_normal" : "normal",
          order_krw: orderKrw,
          strategy_type: strategyType,
          tick_lease: myLease,
          diagnostic: {
            entry_mode: isSurgeSource
              ? "SURGE_V2"
              : metaForGuard?.setupReason === "CORE_TREND_ENTRY"
                ? "CORE_TREND_ENTRY"
                : "CORE_SPOT_DEFAULT",
            candle_source: metaForGuard?.candle_source ?? null,
            candle_cache_age_ms: metaForGuard?.candle_cache_age_ms ?? null,
            is_fresh_signal: metaForGuard?.is_fresh_signal,
            is_watch_candidate: metaForGuard?.is_watch_candidate,
            market_state: marketState.market_state,
            btc_tier: btcTierNow,
            score,
            volume_ratio: volumeRatio,
            age_seconds: secondsSinceSignal,
            timing_state: timingState,
            volume_state: volumeState,
            size_multiplier: isSurgeSource ? surgeMarketSizeMultiplier : lateEntrySizingMultiplier,
            relaxed_probe: !isSurgeSource && metaForGuard?.is_relaxed_probe,
          }
        }),
      );
      // Entry Execution Proof (Before Call)
      const preProofTag = isSurgeSource ? "SURGE_V2_LIVE_ENTRY_EXECUTION_PROOF" : "CORE_LIVE_ENTRY_EXECUTION_PROOF";
      console.info(
        JSON.stringify({
          tag: preProofTag,
          ts: new Date().toISOString(),
          market,
          decision_action: "enter",
          decision_mode: isSurgeSource ? "surge" : (metaForGuard?.is_relaxed_probe ? "relaxed_probe" : "normal"),
          decision_reason: sourceKindForJudgment,
          order_krw: orderKrw,
          size_multiplier: isSurgeSource ? surgeMarketSizeMultiplier : lateEntrySizingMultiplier,
          relaxed_probe: !isSurgeSource && metaForGuard?.is_relaxed_probe,
          softened_reasons: !isSurgeSource ? metaForGuard?.softened_reasons : [],
          authority_source: isSurgeSource ? "surge-v2" : "core",
          execution_layer: "live-strategy",
          place_buy_called: true,
          place_buy_ok: null,
          place_buy_reason: "pending",
        }),
      );
      try {
        let placeBuyOk = false;
        let placeBuyReason = "unknown";
        try {
          if (!leaseOk()) {
            throw new Error("TICK_LEASE_REVOKED");
          }
          await opts.trade.placeBuy(market, true, orderKrw, strategyType, "strategy", {
            ...signalPayloadForBuy,
            __surge_stop_price: isSurgeSource ? surgeStopPrice : undefined,
            __surge_risk_pct: isSurgeSource ? surgeRiskPct : undefined,
            __surge_stop_reason: isSurgeSource ? surgeStopReason : undefined,
          });
          placeBuyOk = true;
          placeBuyReason = "success";
        } catch (innerErr) {
          placeBuyOk = false;
          placeBuyReason = innerErr instanceof Error ? innerErr.message.slice(0, 200) : String(innerErr).slice(0, 200);
          throw innerErr;
        } finally {
          const proofTag = isSurgeSource ? "SURGE_V2_LIVE_ENTRY_EXECUTION_PROOF" : "CORE_LIVE_ENTRY_EXECUTION_PROOF";
          console.info(
            JSON.stringify({
              tag: proofTag,
              ts: new Date().toISOString(),
              market,
              decision_action: "enter",
              decision_reason: sourceKindForJudgment,
              order_krw: orderKrw,
              size_multiplier: isSurgeSource ? surgeMarketSizeMultiplier : lateEntrySizingMultiplier,
              relaxed_probe: !isSurgeSource && metaForGuard?.is_relaxed_probe,
              softened_reasons: !isSurgeSource ? metaForGuard?.softened_reasons : [],
              authority_source: isSurgeSource ? "surge-v2" : "core",
              execution_layer: "live-strategy",
              place_buy_called: true,
              place_buy_ok: placeBuyOk,
              place_buy_reason: placeBuyReason,
            }),
          );
        }

        if (!leaseOk()) {
          console.info(
            JSON.stringify({
              tag: "LIVE_PLACEBUY_RESULT",
              ts: new Date().toISOString(),
              market,
              ok: false,
              path: isSurgeSource ? "surge_normal" : "normal",
              order_krw: orderKrw,
              strategy_type: strategyType,
              error: "tick_lease_revoked_after_exchange_call",
              tick_lease: myLease,
              valid_lease: liveTickValidLease,
            }),
          );
          bumpSkip("tick_lease_revoked_post_fill");
          emitFinalBlocked("tick_lease_revoked_post_fill", { order_krw: orderKrw });
          continue;
        }

        const finalMeta = candidateMeta.find(x => x.market === market);
        if (!isSurgeSource) {
          console.info(JSON.stringify({
            tag: "CORE_ENTRY_FINAL_DECISION_PROOF",
            market,
            engine_bucket: "core",
            decision_action: "ENTER",
            decision_mode: finalMeta?.is_relaxed_probe ? "relaxed_probe" : "normal",
            reject_reason: null,
            softened_reasons: finalMeta?.softened_reasons,
            score: finalMeta?.score,
            signal_type: sig.p.signal_type,
            base_gate_ok: finalMeta?.gate_ok,
            base_gate_return_reason: finalMeta?.gate_reason,
            original_setup_ok: finalMeta?.setup?.ok,
            late_entry_guard_triggered: lateEntryGuardTriggered,
            late_entry_guard_reason: lateEntryGuardReason,
            order_krw: orderKrw,
            available_krw: liveOrderAvailableKrw,
            multiplier: finalMeta?.relaxed_multiplier
          }));
        }
        console.info(
          JSON.stringify({
            tag: "LIVE_PLACEBUY_RESULT",
            ts: new Date().toISOString(),
            market,
            ok: true,
            path: isSurgeSource ? "surge_normal" : "normal",
            order_krw: orderKrw,
            strategy_type: strategyType,
            tick_lease: myLease,
          }),
        );
        if (liveTradingOn) {
          surgeRemainingForTickKrw = Math.max(0, surgeRemainingForTickKrw - orderKrw);
        }
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
            entry_profile_key,
            profile_decision: profileInfo.decision,
            profile_reason: profileInfo.reason,
          },
        });
        emitEval("entry_opened", { symbol: market, order_krw: orderKrw });
        selectedCount += 1;
      } catch (e) {
        if (e instanceof Error && e.message === "TICK_LEASE_REVOKED") {
          console.info(
            JSON.stringify({
              tag: "LIVE_PLACEBUY_RESULT",
              ts: new Date().toISOString(),
              market,
              ok: false,
              path: isSurgeSource ? "surge_normal" : "normal",
              order_krw: orderKrw,
              strategy_type: strategyType,
              error: "tick_lease_revoked_pre_exchange",
              tick_lease: myLease,
              valid_lease: liveTickValidLease,
            }),
          );
          bumpSkip("tick_lease_revoked");
          emitFinalBlocked("tick_lease_revoked", { order_krw: orderKrw });
          continue;
        }
        console.info(
          JSON.stringify({
            tag: "LIVE_PLACEBUY_RESULT",
            ts: new Date().toISOString(),
            market,
            ok: false,
            path: isSurgeSource ? "surge_normal" : "normal",
            order_krw: orderKrw,
            strategy_type: strategyType,
            error: e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240),
          }),
        );
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
        await racePersist("after_place_buy_failure_guard");
        bumpSkip("order_failed");
        emitFinalBlocked("order_failed", { order_krw: orderKrw });
        continue;
      }
      const price = priceBy.get(market) ?? 0;
      const st2 = await raceTradeStatus("post_core_buy_balance_snap");
      const bFill = st2.balances?.find((x: any) => x.currency === currency);
      const qty = Number(bFill?.balance ?? 0) + Number(bFill?.locked ?? 0);
      const strategyPositionExistsBefore = Boolean(state.positions[market]);
      const marketMeta = candidateMeta.find(x => x.market === market);
      state.positions[market] = {
        market,
        strategy_type: strategyType,
        engine_bucket: isSurgeSource ? "surge" : "core",
        entry_origin: "auto_trade",
        entry_mode: isSurgeSource ? "SURGE_V2" : "CORE",
        market_state_at_entry: marketState.market_state,
        btc_tier_at_entry: btcTierNow,
        volatility_pct_at_entry: 0,
        is_relaxed_probe: !isSurgeSource && marketMeta?.is_relaxed_probe === true,
        entry_ts: new Date().toISOString(),
        entry_price: price,
        qty,
        order_krw: orderKrw,
        reason_enter: exception
          ? `exception_slot_entry:${exception.reason}`
          : entrySizePct < 1
            ? `${sig.p.signal_reason ?? "signal_pass"}:btc_risk_scaled_${entrySizePct}`
            : `${sig.p.signal_reason ?? "signal_pass"}|${profileInfo.reason}`,
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
        position_id: `${market}|${new Date().toISOString()}`,
        entry_profile_key,
        entry_profile_decision: profileInfo.decision,
        target_budget_krw: baseBudget,
        filled_entry_krw: orderKrw,
        original_setup_mode: marketMeta?.setupMode,
        original_setup_reason: marketMeta?.setupReason,
        entry_stop_price: marketMeta?.stopPrice,
        entry_target_price: marketMeta?.targetPrice,
        entry_risk_reward: marketMeta?.riskReward,
        ema50: marketMeta?.ema50,
        ema200: marketMeta?.ema200,
        rsi: marketMeta?.rsi,
        stochD: marketMeta?.stochD,
        softened_reasons: !isSurgeSource ? marketMeta?.softened_reasons : [],
      };
      console.info(
        JSON.stringify({
          tag: "SURGE_V2_POSITION_BUCKET_PROOF",
          ts: new Date().toISOString(),
          market,
          engine_bucket: state.positions[market].engine_bucket,
          is_surge_source: isSurgeSource,
          strategy_type: strategyType,
        }),
      );
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
        position_id: state.positions[market]?.position_id,
        entry_profile_key,
        entry_profile_decision: profileInfo.decision,
        target_budget_krw: baseBudget,
        filled_entry_krw: orderKrw,
        exit_reason_detail: "",
        exit_authority_class: "",
        partial_tp_done: false,
        breakeven_armed: false,
        runner_trail_active: false,
        realized_partial_profit: 0,
        final_net_pnl_pct: 0,
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
      const sourceKindsInUniverse = entryUniverse
        .map((symbol) => sourceMetaByMarket.get(symbol)?.source_kind ?? inputSourceKind)
        .slice(0, 20);
      const globalMarketStateBlockApplied =
        marketState.market_state === "risk_off" && entryUniverse.some((symbol) => {
          const sk = sourceMetaByMarket.get(symbol)?.source_kind ?? inputSourceKind;
          return sk !== "scanner_filter_fresh" && sk !== "scanner_then_filter_pass";
        });
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
          market_state_block: globalMarketStateBlockApplied,
          max_positions_reached: Boolean(skippedByReason["max_positions_reached"] ?? 0),
          source_kind: sourceKindsInUniverse,
          surge_market_judgment_reason:
            skippedByReason["surge_market_crash_guard"] > 0
              ? "crash_or_panic_hard_block"
              : marketState.market_state === "risk_off"
                ? "risk_off_but_surge_eval_allowed_with_reduced_size"
                : "market_not_blocking",
          global_market_state_block_applied: globalMarketStateBlockApplied,
          skipped_by_reason: skippedByReason,
        }),
      );
    }
    await racePersist("tick_tail_before_return");
      },
    );
    } catch (e: unknown) {
      if (isLiveTickPhaseTimeout(e)) {
        console.info(
          JSON.stringify({
            tag: "LIVE_TICK_PHASE_TIMEOUT_HALT",
            ts: new Date().toISOString(),
            phase: e.phase,
            timeout_ms: e.timeout_ms,
            tick_lease: myLease,
            note: "race_timer_won_underlying_await_may_still_pending_finally_runs",
          }),
        );
      } else if (
        tickSignal.aborted ||
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError")
      ) {
        console.info(
          JSON.stringify({
            tag: "LIVE_TICK_ABORTED",
            ts: new Date().toISOString(),
            tick_lease: myLease,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      } else {
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_TICK_ERROR",
            ts: new Date().toISOString(),
            tick_lease: myLease,
            error: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? String(e.stack ?? "").slice(0, 800) : null,
          }),
        );
      }
    } finally {
      clearInterval(ageInterval);
      runTickInFlight = false;
      if (liveTickAbort === tickAbort) {
        liveTickAbort = null;
      }
    }
  };

  return {
    init: restore,
    tick: runTick,
    status: summarize,
    files: { tradesFile, dailyFile },
  };
}

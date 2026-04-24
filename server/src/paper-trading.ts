import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";
import { UPBIT_FEE_RATE } from "./strategy-risk-config.js";
import { fetchMinuteCandles, fetchTickers } from "./upbit-public.js";

type PaperStateValue = "SIGNAL" | "OPEN" | "PARTIAL_EXIT" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT" | "SKIPPED";

type PaperPosition = {
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  invested_krw: number;
  buy_fee_krw: number;
  signal_strength: string;
  position_stage?: "early_active" | "normal_active";
  signal_ts?: string | null;
  signal_price?: number | null;
  entry_recent_high?: number | null;
  take_profit_partial_done?: boolean;
  take_profit_second_done?: boolean;
  peak_price?: number;
  /** 진입 이후 최고 수익률(%) — 조기 실패 판단 */
  max_up_pct?: number;
  /** +3% 이상에서 러너 트레일 활성 */
  runner_trail_armed?: boolean;
  /** pump surge 2차(70%) 배분 완료 여부 */
  surge_add_leg_done?: boolean;
  entry_profile_key?: string;
  entry_profile_features?: EntryProfileFeatures;
  realized_pnl_krw?: number;
  initial_invested_krw?: number;
  /** Original Setup fields */
  original_setup_mode?: "safe" | "aggressive" | "none";
  original_setup_reason?: string;
  entry_stop_price?: number;
  entry_target_price?: number;
  entry_risk_reward?: number;
};

type EntryProfileFeatures = {
  signal_strength: string;
  position_stage: "early_active" | "normal_active";
  btc_tier: "strong" | "neutral" | "weak";
  score_bucket: "0-69" | "70-79" | "80-89" | "90+";
  volume_ratio_bucket: "<1.2" | "1.2-1.49" | "1.5-1.99" | "2.0+";
  signal_age_bucket: "<=10s" | "11-30s" | "31-60s" | ">60s";
  chase_pct_bucket: "<=0.2" | "0.21-0.5" | "0.51-1.0" | ">1.0";
  near_high_bucket: "<=0.1" | "0.11-0.25" | "0.26-0.5" | ">0.5";
  breakout: boolean;
  early_entry_eligible: boolean;
};

type CoarseProfileFeatures = {
  signal_strength: string;
  position_stage: "early_active" | "normal_active";
  btc_tier: "strong" | "neutral" | "weak";
  score_bucket: "0-69" | "70-79" | "80-89" | "90+";
  volume_ratio_bucket: "<1.2" | "1.2-1.49" | "1.5-1.99" | "2.0+";
  breakout: boolean;
};

type EntryProfileStats = {
  total_trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  total_pnl_krw: number;
  total_pnl_pct: number;
  avg_pnl_pct: number;
  win_rate: number;
  last_updated_at: string;
  recent_pnl_pct: number[];
};

type ProfileDecision = "allow" | "block" | "unknown";
type ProfileDecisionResult = {
  decision: ProfileDecision;
  reason: string;
  stats_snapshot: { total_trades: number; avg_pnl_pct: number; win_rate: number };
};

type PaperTradeEvent = {
  ts: string;
  market: string;
  state: PaperStateValue;
  note: string;
  signal_strength: string | null;
  entry_price: number | null;
  exit_price: number | null;
  qty: number | null;
  pnl_krw: number | null;
  pnl_pct: number | null;
  entry_profile_key?: string;
  entry_profile_features?: EntryProfileFeatures;
  profile_decision?: ProfileDecision;
  profile_reason?: string;
  profile_stats?: { total_trades: number; avg_pnl_pct: number; win_rate: number };
};

type PaperStateFile = {
  cash_krw: number;
  positions: Record<string, PaperPosition>;
  history: PaperTradeEvent[];
  seen_signal_keys: string[];
  entry_profile_stats?: Record<string, EntryProfileStats>;
  coarse_profile_stats?: Record<string, EntryProfileStats>;
  fine_profile_stats?: Record<string, EntryProfileStats>;
};

type LifecycleState = "idle" | "pre_entry" | "entered" | "cooldown";
type MarketLifecycle = {
  state: LifecycleState;
  state_since_ts: string;
  cooldown_until_ts?: string;
  candidate_score?: number;
  last_reason?: string;
  first_seen_ts?: string;
  first_seen_price?: number;
  last_local_high?: number;
};

const PAPER_START_KRW = 500_000;
const PAPER_ENTRY_KRW_PER_TRADE = 45_000;
/** 일반(legacy surge 등) 포지션 전용 cap. `PAPER_MAX_OPEN`은 하위 호환 fallback */
const PAPER_NORMAL_MAX_OPEN = (() => {
  const raw = process.env.PAPER_NORMAL_MAX_OPEN ?? process.env.PAPER_MAX_OPEN;
  const n = raw === undefined || raw === "" ? 2 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.floor(n))) : 2;
})();

// --- Paper entry timing (early-first) ---
const PAPER_ENTRY_SIGNAL_STALE_SECONDS = (() => {
  const raw = process.env.PAPER_ENTRY_SIGNAL_STALE_SECONDS;
  const n = raw === undefined || raw === "" ? 90 : Number(raw);
  return Number.isFinite(n) ? Math.max(15, Math.min(600, Math.floor(n))) : 90;
})();
const PAPER_MAX_CHASE_FROM_SIGNAL_PCT = (() => {
  const raw = process.env.PAPER_MAX_CHASE_FROM_SIGNAL_PCT;
  const n = raw === undefined || raw === "" ? 0.8 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(8, n)) : 0.8;
})();
/** (high-now)/high*100 < 이 값이면 고점 추격으로 간주, 진입 차단 */
const PAPER_MAX_ENTRY_NEAR_HIGH_PCT = (() => {
  const raw = process.env.PAPER_MAX_ENTRY_NEAR_HIGH_PCT;
  const n = raw === undefined || raw === "" ? 0.25 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.05, Math.min(3, n)) : 0.25;
})();
/** 초입 직후: near_high 단독일 때 timing guard 예외 (늦은 추격과 분리) */
const PAPER_NEAR_HIGH_EARLY_BYPASS_SECONDS = (() => {
  const raw = process.env.PAPER_NEAR_HIGH_EARLY_BYPASS_SECONDS;
  const n = raw === undefined || raw === "" ? 8 : Number(raw);
  return Number.isFinite(n) ? Math.max(5, Math.min(12, Math.floor(n))) : 8;
})();
const PAPER_NEAR_HIGH_EARLY_BYPASS_MAX_CHASE_PCT = (() => {
  const raw = process.env.PAPER_NEAR_HIGH_EARLY_BYPASS_MAX_CHASE_PCT;
  const n = raw === undefined || raw === "" ? 0.25 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.05, Math.min(0.5, n)) : 0.25;
})();
const PAPER_NEAR_HIGH_EARLY_BYPASS_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.PAPER_NEAR_HIGH_EARLY_BYPASS_MIN_VOLUME_RATIO;
  /** 기본은 early 진입 min volume과 맞춰 bypass 후 곧바로 volume_not_strong에 걸리지 않게 함 */
  const n = raw === undefined || raw === "" ? 1.2 : Number(raw);
  return Number.isFinite(n) ? Math.max(1.0, Math.min(3.0, n)) : 1.2;
})();
const PAPER_EARLY_ENTRY_MAX_OPEN = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_MAX_OPEN;
  const n = raw === undefined || raw === "" ? 2 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.floor(n))) : 2;
})();
const PAPER_EARLY_ENTRY_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_MIN_VOLUME_RATIO;
  const n = raw === undefined || raw === "" ? 1.2 : Number(raw);
  return Number.isFinite(n) ? Math.max(1.0, Math.min(6, n)) : 1.2;
})();
const PAPER_EARLY_ENTRY_MAX_SIGNAL_SECONDS = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_MAX_SIGNAL_SECONDS;
  const n = raw === undefined || raw === "" ? 20 : Number(raw);
  return Number.isFinite(n) ? Math.max(5, Math.min(120, Math.floor(n))) : 20;
})();
const PAPER_EARLY_ENTRY_FAIL_SECONDS = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_FAIL_SECONDS;
  const n = raw === undefined || raw === "" ? 180 : Number(raw);
  return Number.isFinite(n) ? Math.max(10, Math.min(600, Math.floor(n))) : 180;
})();
const PAPER_EARLY_ENTRY_FAIL_LOSS_PCT = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_FAIL_LOSS_PCT;
  const n = raw === undefined || raw === "" ? -0.5 : Number(raw);
  return Number.isFinite(n) ? Math.max(-5, Math.min(-0.1, n)) : -0.5;
})();
const PAPER_EARLY_PROMOTION_PCT = (() => {
  const raw = process.env.PAPER_EARLY_PROMOTION_PCT;
  const n = raw === undefined || raw === "" ? 0.4 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(3, n)) : 0.4;
})();
const PAPER_EARLY_PROMOTION_MAX_SECONDS = (() => {
  const raw = process.env.PAPER_EARLY_PROMOTION_MAX_SECONDS;
  const n = raw === undefined || raw === "" ? 60 : Number(raw);
  return Number.isFinite(n) ? Math.max(10, Math.min(300, Math.floor(n))) : 60;
})();
/** pump 스캐너 1차 선진입 비중 · 2차 돌파 추격 비중 */
const SURGE_EARLY_ALLOC_RATIO = 0.5;
const SURGE_ADD_ALLOC_RATIO = 0.5;
/** 스캐너 피드와 동일: 1차는 거래량 배수 > 이 값 (기본 1.2) */
const SURGE_EARLY_VOLUME_RATIO_MIN = Math.max(1.0, Number(process.env.PUMP_SCANNER_EARLY_VOLUME_RATIO_MIN ?? 1.2));
/** 진입가 대비 손절(%) — -0.5 ~ -1 구간으로 clamp, 기본 -0.75 */
const SURGE_STOP_LOSS_PCT = (() => {
  const raw = process.env.PAPER_SURGE_STOP_LOSS_PCT;
  const n = raw === undefined || raw === "" ? -0.75 : Number(raw);
  if (!Number.isFinite(n)) return -0.75;
  return Math.max(-1, Math.min(-0.5, n));
})();
const SURGE_COOLDOWN_MS = 25 * 60_000;
const SURGE_COOLDOWN_AFTER_LOSS_MS = 30 * 60_000;
const PAPER_TIMEOUT_MS = 45 * 60_000;
/** surge 후보 시간청산(백업) */
const PAPER_SURGE_SCANNER_TIMEOUT_MS = (() => {
  const raw = process.env.PAPER_SURGE_SCANNER_TIMEOUT_MINUTES;
  if (raw === undefined || raw === "") return 45 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10 && n <= 180 ? n * 60_000 : 45 * 60_000;
})();
const CANDIDATE_KEEP_MS = 3 * 60_000;
const CANDIDATE_MAX_TRACKED = 8;
const PAPER_HISTORY_MAX = 1000;
const PAPER_SEEN_SIGNAL_MAX = 500;
const PAPER_BTC_NEUTRAL_ENTRY_SCALE = 0.75;
const PAPER_BTC_WEAK_ENTRY_SCALE = 0.5;

function toNum(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function scoreBucket(score: number): EntryProfileFeatures["score_bucket"] {
  if (score >= 90) return "90+";
  if (score >= 80) return "80-89";
  if (score >= 70) return "70-79";
  return "0-69";
}

function volumeRatioBucket(v: number | null): EntryProfileFeatures["volume_ratio_bucket"] {
  const n = toNum(v, 0);
  if (n >= 2.0) return "2.0+";
  if (n >= 1.5) return "1.5-1.99";
  if (n >= 1.2) return "1.2-1.49";
  return "<1.2";
}

function signalAgeBucket(sec: number | null): EntryProfileFeatures["signal_age_bucket"] {
  const n = Math.max(0, toNum(sec, 9999));
  if (n <= 10) return "<=10s";
  if (n <= 30) return "11-30s";
  if (n <= 60) return "31-60s";
  return ">60s";
}

function chaseBucket(pct: number | null): EntryProfileFeatures["chase_pct_bucket"] {
  const n = Math.max(0, toNum(pct, 999));
  if (n <= 0.2) return "<=0.2";
  if (n <= 0.5) return "0.21-0.5";
  if (n <= 1.0) return "0.51-1.0";
  return ">1.0";
}

function nearHighBucket(pct: number | null): EntryProfileFeatures["near_high_bucket"] {
  const n = Math.max(0, toNum(pct, 999));
  if (n <= 0.1) return "<=0.1";
  if (n <= 0.25) return "0.11-0.25";
  if (n <= 0.5) return "0.26-0.5";
  return ">0.5";
}

function buildEntryProfileFeatures(params: {
  signalStrength: string;
  positionStage: "early_active" | "normal_active";
  btcTier: "strong" | "neutral" | "weak";
  score: number;
  volumeRatio: number | null;
  signalAgeSec: number | null;
  chasePct: number | null;
  nearHighPct: number | null;
  breakout: boolean;
  earlyEntryEligible: boolean;
}): EntryProfileFeatures {
  return {
    signal_strength: params.signalStrength,
    position_stage: params.positionStage,
    btc_tier: params.btcTier,
    score_bucket: scoreBucket(params.score),
    volume_ratio_bucket: volumeRatioBucket(params.volumeRatio),
    signal_age_bucket: signalAgeBucket(params.signalAgeSec),
    chase_pct_bucket: chaseBucket(params.chasePct),
    near_high_bucket: nearHighBucket(params.nearHighPct),
    breakout: params.breakout,
    early_entry_eligible: params.earlyEntryEligible,
  };
}

function entryProfileKey(f: EntryProfileFeatures): string {
  return [
    `sig:${f.signal_strength}`,
    `slot:${f.position_stage}`,
    `btc:${f.btc_tier}`,
    `score:${f.score_bucket}`,
    `vr:${f.volume_ratio_bucket}`,
    `age:${f.signal_age_bucket}`,
    `chase:${f.chase_pct_bucket}`,
    `near:${f.near_high_bucket}`,
    `bo:${f.breakout ? "1" : "0"}`,
    `early:${f.early_entry_eligible ? "1" : "0"}`,
  ].join("|");
}

function buildCoarseProfileKey(f: CoarseProfileFeatures): string {
  return [
    `sig:${f.signal_strength}`,
    `slot:${f.position_stage}`,
    `btc:${f.btc_tier}`,
    `score:${f.score_bucket}`,
    `vr:${f.volume_ratio_bucket}`,
    `bo:${f.breakout ? "1" : "0"}`,
  ].join("|");
}

function buildFineProfileKey(f: EntryProfileFeatures): string {
  return entryProfileKey(f);
}

function coarseFromFine(f: EntryProfileFeatures): CoarseProfileFeatures {
  return {
    signal_strength: f.signal_strength,
    position_stage: f.position_stage,
    btc_tier: f.btc_tier,
    score_bucket: f.score_bucket,
    volume_ratio_bucket: f.volume_ratio_bucket,
    breakout: f.breakout,
  };
}

function evaluateProfileDecision(stats: EntryProfileStats | undefined): ProfileDecisionResult {
  if (!stats || stats.total_trades < 3) {
    return {
      decision: "unknown",
      reason: "profile_unknown_fallback_allow",
      stats_snapshot: {
        total_trades: stats?.total_trades ?? 0,
        avg_pnl_pct: Number((stats?.avg_pnl_pct ?? 0).toFixed(4)),
        win_rate: Number((stats?.win_rate ?? 0).toFixed(4)),
      },
    };
  }
  const timeoutRate = stats.total_trades > 0 ? stats.timeouts / stats.total_trades : 0;
  const recent2 = stats.recent_pnl_pct.slice(-2);
  if (stats.total_trades >= 3 && stats.avg_pnl_pct <= -0.25) {
    return { decision: "block", reason: "profile_block_negative_expectancy", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
  }
  if (stats.total_trades >= 3 && stats.win_rate < 0.34) {
    return { decision: "block", reason: "profile_block_low_win_rate", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
  }
  if (stats.total_trades >= 2 && recent2.length === 2 && recent2.every((x) => x <= -0.2)) {
    return { decision: "block", reason: "profile_block_consecutive_losses", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
  }
  if (stats.total_trades >= 3 && timeoutRate >= 0.5 && stats.avg_pnl_pct < 0) {
    return { decision: "block", reason: "profile_block_timeout_negative", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
  }
  if (stats.total_trades >= 3 && stats.avg_pnl_pct >= 0.25) {
    return { decision: "allow", reason: "profile_allow_positive_expectancy", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
  }
  if (stats.total_trades >= 3 && stats.win_rate >= 0.55) {
    return { decision: "allow", reason: "profile_allow_high_win_rate", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
  }
  if (stats.wins > stats.losses && stats.total_pnl_pct > 0) {
    return { decision: "allow", reason: "profile_allow_net_positive", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
  }
  return { decision: "unknown", reason: "profile_unknown_fallback_allow", stats_snapshot: { total_trades: stats.total_trades, avg_pnl_pct: Number(stats.avg_pnl_pct.toFixed(4)), win_rate: Number(stats.win_rate.toFixed(4)) } };
}

function evaluateCoarseProfileDecision(stats: EntryProfileStats | undefined): ProfileDecisionResult {
  return evaluateProfileDecision(stats);
}

function evaluateFineProfileDecision(stats: EntryProfileStats | undefined): ProfileDecisionResult {
  return evaluateProfileDecision(stats);
}

function paperTimeExitDeadlineMs(p: Pick<PaperPosition, "signal_strength">): number {
  return p.signal_strength === "SURGE_SCANNER" ? PAPER_SURGE_SCANNER_TIMEOUT_MS : PAPER_TIMEOUT_MS;
}

function paperTimeExitDeadlineMsByContext(
  p: Pick<PaperPosition, "signal_strength" | "entry_profile_features">,
  coarseStats?: EntryProfileStats,
): number {
  const base = paperTimeExitDeadlineMs(p);
  if (p.signal_strength !== "SURGE_SCANNER") return base;
  const tier = p.entry_profile_features?.btc_tier ?? "neutral";
  if (tier === "strong") return base;
  if (tier === "neutral") return Math.max(20 * 60_000, Math.floor(base * 0.75));
  const weakBase = Math.max(15 * 60_000, Math.floor(base * 0.55));
  if (coarseStats && coarseStats.total_trades >= 4) {
    const timeoutRate = coarseStats.timeouts / Math.max(1, coarseStats.total_trades);
    if (timeoutRate >= 0.5 && coarseStats.avg_pnl_pct < 0) {
      return Math.max(12 * 60_000, Math.floor(weakBase * 0.8));
    }
  }
  return weakBase;
}

function paperTimeExitNote(
  p: Pick<PaperPosition, "signal_strength" | "entry_profile_features">,
  coarseStats?: EntryProfileStats,
): string {
  const ms = paperTimeExitDeadlineMsByContext(p, coarseStats);
  const m = Math.round(ms / 60_000);
  return p.signal_strength === "SURGE_SCANNER" ? `time_exit_${m}m:surge_scanner` : `time_exit_${m}m:paper`;
}

function logPumpScannerDebug(payload: Record<string, unknown>) {
  const on =
    (process.env.DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    (process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    process.env.ORBITALPHA_TRADING_SCANNER_DEBUG === "1";
  if (!on) return;
  console.info(JSON.stringify({ tag: "DEBUG_PAPER_PUMP_SCANNER", ts: new Date().toISOString(), ...payload }));
}

function emitPaper(tag: string, payload: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ kind: "paper", tag, ts: new Date().toISOString(), ...payload }));
}

function countPaperSlots(positions: Record<string, PaperPosition>): {
  early_open_positions: number;
  normal_open_positions: number;
} {
  let early_open_positions = 0;
  let normal_open_positions = 0;
  for (const p of Object.values(positions)) {
    if (p.position_stage === "early_active") early_open_positions++;
    else normal_open_positions++;
  }
  return { early_open_positions, normal_open_positions };
}

export function createPaperTradingEngine(opts: {
  companyId: string;
  serviceId: string;
  getScannerSignals: () => Array<{
    market: string;
    score: number;
    status: string;
    signal_key: string;
    reason: string;
    breakout?: boolean;
    volume_multiple?: number;
    early_entry_eligible?: boolean;
    add_entry_eligible?: boolean;
    exclude_reasons?: string[];
  }>;
}) {
  const baseDir = path.join(tradingDataRoot(), "paper", opts.companyId, opts.serviceId);
  const stateFile = path.join(baseDir, "paper_state.json");

  const state: {
    cashKrw: number;
    positions: Record<string, PaperPosition>;
    history: PaperTradeEvent[];
    seenSignalKeys: Set<string>;
    lifecycle: Map<string, MarketLifecycle>;
    /** 스캐너 기준 진입 직전(선·추가 진입 조건 감시), 과거 candidate_pool */
    preEntryWatch: Map<string, { score: number; reason: string; status: string; detectedAt: number; signalStrength: string }>;
    metrics: {
      preEntryWatchHits: number;
      entriesOpened: number;
      entryLatencyMs: number[];
      earlyExitCount: number;
    };
    coarseProfileStats: Record<string, EntryProfileStats>;
    fineProfileStats: Record<string, EntryProfileStats>;
  } = {
    cashKrw: PAPER_START_KRW,
    positions: {},
    history: [],
    seenSignalKeys: new Set<string>(),
    lifecycle: new Map(),
    preEntryWatch: new Map(),
    metrics: {
      preEntryWatchHits: 0,
      entriesOpened: 0,
      entryLatencyMs: [],
      earlyExitCount: 0,
    },
    coarseProfileStats: {},
    fineProfileStats: {},
  };

  const trimHistoryAndSignals = () => {
    if (state.history.length > PAPER_HISTORY_MAX) state.history = state.history.slice(-PAPER_HISTORY_MAX);
    if (state.seenSignalKeys.size > PAPER_SEEN_SIGNAL_MAX) {
      const arr = Array.from(state.seenSignalKeys);
      state.seenSignalKeys = new Set(arr.slice(arr.length - PAPER_SEEN_SIGNAL_MAX));
    }
  };

  const appendHistory = (row: PaperTradeEvent) => {
    state.history.push(row);
    trimHistoryAndSignals();
  };

  const persist = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    const filePayload: PaperStateFile = {
      cash_krw: state.cashKrw,
      positions: state.positions,
      history: state.history,
      seen_signal_keys: Array.from(state.seenSignalKeys),
      entry_profile_stats: state.fineProfileStats,
      coarse_profile_stats: state.coarseProfileStats,
      fine_profile_stats: state.fineProfileStats,
    };
    await fs.writeFile(stateFile, JSON.stringify(filePayload, null, 2), "utf8");
  };

  const init = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, "utf8")) as Partial<PaperStateFile>;
      state.cashKrw = Math.max(0, toNum(raw.cash_krw, PAPER_START_KRW));
      state.positions = (raw.positions ?? {}) as Record<string, PaperPosition>;
      state.history = Array.isArray(raw.history) ? (raw.history as PaperTradeEvent[]) : [];
      state.seenSignalKeys = new Set(Array.isArray(raw.seen_signal_keys) ? raw.seen_signal_keys : []);
      const legacyFine =
        raw.entry_profile_stats && typeof raw.entry_profile_stats === "object"
          ? (raw.entry_profile_stats as Record<string, EntryProfileStats>)
          : {};
      state.coarseProfileStats =
        raw.coarse_profile_stats && typeof raw.coarse_profile_stats === "object"
          ? (raw.coarse_profile_stats as Record<string, EntryProfileStats>)
          : {};
      state.fineProfileStats =
        raw.fine_profile_stats && typeof raw.fine_profile_stats === "object"
          ? (raw.fine_profile_stats as Record<string, EntryProfileStats>)
          : legacyFine;
      trimHistoryAndSignals();
      for (const p of Object.values(state.positions)) {
        if (p.signal_strength !== "SURGE_SCANNER") continue;
        if (p.surge_add_leg_done !== undefined) continue;
        p.surge_add_leg_done = p.invested_krw >= PAPER_ENTRY_KRW_PER_TRADE * 0.42;
      }
    } catch {
      /* first boot */
    }
  };

  const setLifecycle = (market: string, next: LifecycleState, extra: Partial<MarketLifecycle> = {}) => {
    const prev = state.lifecycle.get(market);
    state.lifecycle.set(market, {
      state: next,
      state_since_ts: new Date().toISOString(),
      cooldown_until_ts: prev?.cooldown_until_ts,
      candidate_score: prev?.candidate_score,
      last_reason: prev?.last_reason,
      ...extra,
    });
  };

  const getLifecycle = (market: string): MarketLifecycle => {
    return state.lifecycle.get(market) ?? { state: "idle", state_since_ts: new Date().toISOString() };
  };

  const paperBuy = (
    market: string,
    signalStrength: string,
    entryPrice: number,
    note: string,
    amountKrw = PAPER_ENTRY_KRW_PER_TRADE,
    slot: "early" | "normal" = "normal",
    profile?: {
      key: string;
      features: EntryProfileFeatures;
      decision: ProfileDecision;
      reason: string;
      stats_snapshot: { total_trades: number; avg_pnl_pct: number; win_rate: number };
    },
  ): { ok: boolean; reason?: string } => {
    if (state.positions[market]) return { ok: false, reason: "already_open" };
    const { early_open_positions, normal_open_positions } = countPaperSlots(state.positions);
    if (slot === "early") {
      if (early_open_positions >= PAPER_EARLY_ENTRY_MAX_OPEN) return { ok: false, reason: "early_max_open_positions" };
    } else {
      if (normal_open_positions >= PAPER_NORMAL_MAX_OPEN) return { ok: false, reason: "normal_max_open_positions" };
    }
    const orderKrw = Math.max(5_000, amountKrw);
    const buyFee = orderKrw * UPBIT_FEE_RATE;
    const totalNeed = orderKrw + buyFee;
    if (state.cashKrw < totalNeed) return { ok: false, reason: "insufficient_cash" };
    if (!(entryPrice > 0)) return { ok: false, reason: "invalid_price" };

    const qty = orderKrw / entryPrice;
    state.cashKrw -= totalNeed;
    state.positions[market] = {
      market,
      entry_ts: new Date().toISOString(),
      entry_price: entryPrice,
      qty,
      invested_krw: orderKrw,
      buy_fee_krw: buyFee,
      signal_strength: signalStrength,
      take_profit_partial_done: false,
      take_profit_second_done: false,
      peak_price: entryPrice,
      max_up_pct: 0,
      runner_trail_armed: false,
      position_stage: slot === "early" ? "early_active" : "normal_active",
      entry_profile_key: profile?.key,
      entry_profile_features: profile?.features,
      realized_pnl_krw: 0,
      initial_invested_krw: orderKrw,
      original_setup_mode: profile?.features && (profile.features as any).original_setup_mode,
      original_setup_reason: profile?.features && (profile.features as any).original_setup_reason,
      entry_stop_price: profile?.features && (profile.features as any).entry_stop_price,
      entry_target_price: profile?.features && (profile.features as any).entry_target_price,
      entry_risk_reward: profile?.features && (profile.features as any).entry_risk_reward,
      ...(signalStrength === "SURGE_SCANNER" ? { surge_add_leg_done: false } : {}),
    };
    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: "OPEN",
      note,
      signal_strength: signalStrength,
      entry_price: entryPrice,
      exit_price: null,
      qty,
      pnl_krw: null,
      pnl_pct: null,
      entry_profile_key: profile?.key,
      entry_profile_features: profile?.features,
      profile_decision: profile?.decision,
      profile_reason: profile?.reason,
      profile_stats: profile?.stats_snapshot,
    });

    // --- PAPER_ENTRY_SUBMITTED Log ---
    console.info(JSON.stringify({
      tag: "PAPER_ENTRY_SUBMITTED",
      ts: new Date().toISOString(),
      market,
      side: "buy",
      price: entryPrice,
      amount_krw: orderKrw,
      note
    }));

    const c = state.preEntryWatch.get(market);
    if (c) {
      state.metrics.entryLatencyMs.push(Date.now() - c.detectedAt);
      state.preEntryWatch.delete(market);
    }
    state.metrics.entriesOpened += 1;
    setLifecycle(market, "entered", { last_reason: note, cooldown_until_ts: undefined });
    return { ok: true };
  };

  const paperSurgeAddBuy = (
    market: string,
    entryPrice: number,
    note: string,
    amountKrw: number,
  ): { ok: boolean; reason?: string } => {
    const p = state.positions[market];
    if (!p) return { ok: false, reason: "position_not_found" };
    if (p.signal_strength !== "SURGE_SCANNER") return { ok: false, reason: "not_surge" };
    if (p.surge_add_leg_done === true) return { ok: false, reason: "add_leg_done" };
    const orderKrw = Math.max(5_000, amountKrw);
    const buyFee = orderKrw * UPBIT_FEE_RATE;
    const totalNeed = orderKrw + buyFee;
    if (state.cashKrw < totalNeed) return { ok: false, reason: "insufficient_cash" };
    if (!(entryPrice > 0)) return { ok: false, reason: "invalid_price" };

    const addQty = orderKrw / entryPrice;
    const newQty = p.qty + addQty;
    const newEntryPx = (p.entry_price * p.qty + entryPrice * addQty) / newQty;

    state.cashKrw -= totalNeed;
    p.qty = newQty;
    p.entry_price = newEntryPx;
    p.invested_krw += orderKrw;
    p.buy_fee_krw += buyFee;
    p.surge_add_leg_done = true;
    p.peak_price = Math.max(Number(p.peak_price ?? p.entry_price), entryPrice);

    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: "OPEN",
      note,
      signal_strength: p.signal_strength,
      entry_price: newEntryPx,
      exit_price: null,
      qty: addQty,
      pnl_krw: null,
      pnl_pct: null,
    });

    // --- PAPER_ENTRY_SUBMITTED Log (Add-on) ---
    console.info(JSON.stringify({
      tag: "PAPER_ENTRY_SUBMITTED",
      ts: new Date().toISOString(),
      market,
      side: "buy_add",
      price: entryPrice,
      amount_krw: orderKrw,
      note
    }));

    return { ok: true };
  };

  const paperSell = (
    market: string,
    exitPrice: number,
    closeState: "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT",
    note: string,
    ratio = 1,
  ): { ok: boolean; reason?: string } => {
    const p = state.positions[market];
    if (!p) return { ok: false, reason: "position_not_found" };
    if (!(exitPrice > 0)) return { ok: false, reason: "invalid_price" };
    const ratioClamped = Math.max(0.01, Math.min(1, ratio));
    const sellQty = p.qty * ratioClamped;
    if (!(sellQty > 0)) return { ok: false, reason: "invalid_qty" };

    const gross = sellQty * exitPrice;
    const sellFee = gross * UPBIT_FEE_RATE;
    const netProceeds = gross - sellFee;
    const investedPart = p.invested_krw * ratioClamped;
    const buyFeePart = p.buy_fee_krw * ratioClamped;
    const pnlKrw = netProceeds - investedPart - buyFeePart;
    const pnlPct = investedPart > 0 ? (pnlKrw / investedPart) * 100 : 0;
    p.realized_pnl_krw = Number(p.realized_pnl_krw ?? 0) + pnlKrw;

    state.cashKrw += netProceeds;
    const remainQty = p.qty - sellQty;
    if (remainQty <= 1e-12 || ratioClamped >= 0.9999) {
      delete state.positions[market];
    } else {
      p.qty = remainQty;
      p.invested_krw = Math.max(0, p.invested_krw - investedPart);
      p.buy_fee_krw = Math.max(0, p.buy_fee_krw - buyFeePart);
    }

    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: ratioClamped < 0.9999 ? "PARTIAL_EXIT" : closeState,
      note,
      signal_strength: p.signal_strength,
      entry_price: p.entry_price,
      exit_price: exitPrice,
      qty: sellQty,
      pnl_krw: pnlKrw,
      pnl_pct: pnlPct,
      entry_profile_key: p.entry_profile_key,
      entry_profile_features: p.entry_profile_features,
    });
    if (ratioClamped >= 0.9999 || !state.positions[market]) {
      const fineKey = p.entry_profile_key;
      const coarseKey =
        p.entry_profile_features != null ? buildCoarseProfileKey(coarseFromFine(p.entry_profile_features)) : null;
      const applyStatsUpdate = (prev: EntryProfileStats): EntryProfileStats => {
        const totalPnlKrw = Number(p.realized_pnl_krw ?? pnlKrw);
        const initialInvested = Math.max(1, Number(p.initial_invested_krw ?? p.invested_krw ?? 1));
        const totalPnlPct = (totalPnlKrw / initialInvested) * 100;
        const next: EntryProfileStats = {
          ...prev,
          total_trades: prev.total_trades + 1,
          wins: prev.wins + (closeState === "CLOSED_WIN" ? 1 : 0),
          losses: prev.losses + (closeState === "CLOSED_LOSS" ? 1 : 0),
          timeouts: prev.timeouts + (closeState === "CLOSED_TIMEOUT" ? 1 : 0),
          total_pnl_krw: prev.total_pnl_krw + totalPnlKrw,
          total_pnl_pct: prev.total_pnl_pct + totalPnlPct,
          avg_pnl_pct: 0,
          win_rate: 0,
          last_updated_at: new Date().toISOString(),
          recent_pnl_pct: [...prev.recent_pnl_pct, totalPnlPct].slice(-8),
        };
        next.avg_pnl_pct = next.total_trades > 0 ? next.total_pnl_pct / next.total_trades : 0;
        next.win_rate = next.total_trades > 0 ? next.wins / next.total_trades : 0;
        return next;
      };
      if (fineKey) {
        const prev = state.fineProfileStats[fineKey] ?? {
          total_trades: 0,
          wins: 0,
          losses: 0,
          timeouts: 0,
          total_pnl_krw: 0,
          total_pnl_pct: 0,
          avg_pnl_pct: 0,
          win_rate: 0,
          last_updated_at: new Date().toISOString(),
          recent_pnl_pct: [],
        };
        state.fineProfileStats[fineKey] = applyStatsUpdate(prev);
      }
      if (coarseKey) {
        const prev = state.coarseProfileStats[coarseKey] ?? {
          total_trades: 0,
          wins: 0,
          losses: 0,
          timeouts: 0,
          total_pnl_krw: 0,
          total_pnl_pct: 0,
          avg_pnl_pct: 0,
          win_rate: 0,
          last_updated_at: new Date().toISOString(),
          recent_pnl_pct: [],
        };
        state.coarseProfileStats[coarseKey] = applyStatsUpdate(prev);
      }
    }
    if (ratioClamped >= 0.9999 || !state.positions[market]) {
      const lossExit =
        closeState === "CLOSED_LOSS" ||
        note.includes("hard_stop_loss") ||
        note.includes("early_failure_cut") ||
        note.includes("surge_stop_loss");
      const cdMs = lossExit ? SURGE_COOLDOWN_AFTER_LOSS_MS : SURGE_COOLDOWN_MS;
      setLifecycle(market, "cooldown", {
        cooldown_until_ts: new Date(Date.now() + cdMs).toISOString(),
        last_reason: note,
      });
    }
    if (note.startsWith("early_exit:") || note.includes("early_failure_cut")) state.metrics.earlyExitCount += 1;
    return { ok: true };
  };

  const buildSummary = (priceByMarket: Record<string, number>) => {
    const openPositions = Object.values(state.positions);
    const holdingsEval = openPositions.reduce((acc, p) => acc + p.qty * Math.max(0, toNum(priceByMarket[p.market], 0)), 0);
    const totalAssetKrw = state.cashKrw + holdingsEval;
    const totalPnlKrw = totalAssetKrw - PAPER_START_KRW;
    const totalReturnPct = PAPER_START_KRW > 0 ? (totalPnlKrw / PAPER_START_KRW) * 100 : 0;

    let openUnrealizedPnlKrw = 0;
    for (const p of openPositions) {
      const px = Math.max(0, toNum(priceByMarket[p.market], 0));
      if (px <= 0) continue;
      const gross = p.qty * px;
      const estSellFee = gross * UPBIT_FEE_RATE;
      openUnrealizedPnlKrw += gross - estSellFee - p.invested_krw - p.buy_fee_krw;
    }

    const closed = state.history.filter((h) => h.state === "CLOSED_WIN" || h.state === "CLOSED_LOSS" || h.state === "CLOSED_TIMEOUT");
    const wins = closed.filter((h) => h.state === "CLOSED_WIN").length;
    const losses = closed.filter((h) => h.state === "CLOSED_LOSS").length;
    const timeouts = closed.filter((h) => h.state === "CLOSED_TIMEOUT").length;

    const slots = countPaperSlots(state.positions);
    return {
      config: {
        start_krw: PAPER_START_KRW,
        entry_krw_per_trade: PAPER_ENTRY_KRW_PER_TRADE,
        /** UI/호환: 동시에 열 수 있는 총 슬롯(early+normal) */
        max_open_positions: PAPER_NORMAL_MAX_OPEN + PAPER_EARLY_ENTRY_MAX_OPEN,
        normal_max_open_positions: PAPER_NORMAL_MAX_OPEN,
        early_max_open_positions: PAPER_EARLY_ENTRY_MAX_OPEN,
        surge_early_alloc_ratio: SURGE_EARLY_ALLOC_RATIO,
        surge_add_alloc_ratio: SURGE_ADD_ALLOC_RATIO,
        surge_early_volume_ratio_min: SURGE_EARLY_VOLUME_RATIO_MIN,
        surge_stop_loss_pct: SURGE_STOP_LOSS_PCT,
        timeout_minutes: PAPER_TIMEOUT_MS / 60_000,
        fee_rate: UPBIT_FEE_RATE,
        /** surge_scanner 포지션 시간청산(분). 기본 30. `PAPER_SURGE_SCANNER_TIMEOUT_MINUTES` */
        surge_scanner_timeout_minutes: PAPER_SURGE_SCANNER_TIMEOUT_MS / 60_000,
      },
      account: {
        total_asset_krw: totalAssetKrw,
        cash_krw: state.cashKrw,
        holdings_eval_krw: holdingsEval,
        total_pnl_krw: totalPnlKrw,
        total_return_pct: totalReturnPct,
        open_unrealized_pnl_krw: openUnrealizedPnlKrw,
      },
      counters: {
        open_positions: openPositions.length,
        early_open_positions: slots.early_open_positions,
        normal_open_positions: slots.normal_open_positions,
        closed_wins: wins,
        closed_losses: losses,
        closed_timeouts: timeouts,
      },
    };
  };

  function emaLast(values: number[], period: number): number | null {
    if (values.length < period) return null;
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      ema = (values[i]! - ema) * k + ema;
    }
    return ema;
  }

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

  const tick = async () => {
    const scannerSignals = opts.getScannerSignals();
    emitPaper("DEBUG_PAPER_SIGNAL_HANDOFF", {
      scanner_signals_length: scannerSignals.length,
      markets: scannerSignals.map((s) => String((s as any)?.market ?? "")).filter((m) => m).slice(0, 50),
    });
    const latestSignalByMarket = new Map<
      string,
      {
        key: string;
        signal_strength: string;
        reason: string;
        score: number;
        status: string;
        breakout: boolean;
        volume_multiple: number;
        early_entry_eligible: boolean;
        add_entry_eligible: boolean;
        exclude_reasons?: string[];
      }
    >();
    const watchMarkets = new Set<string>(Object.keys(state.positions));
    watchMarkets.add("KRW-BTC");

    for (const sig of scannerSignals) {
      const market = String(sig.market ?? "").trim();
      if (!market) continue;
      const signalType = "SURGE_SCANNER";
      const key = String(sig.signal_key ?? `${market}|${sig.reason}`);
      const score = toNum(sig.score, 0);
      const status = String(sig.status ?? "");
      const reason = String(sig.reason ?? "surge_scanner");
      const prev = latestSignalByMarket.get(market);
      if (!prev || score >= prev.score) {
        latestSignalByMarket.set(market, {
          key,
          signal_strength: signalType,
          reason,
          score,
          status,
          breakout: sig.breakout === true,
          volume_multiple: toNum(sig.volume_multiple, 0),
          early_entry_eligible: sig.early_entry_eligible === true,
          add_entry_eligible: sig.add_entry_eligible === true,
          exclude_reasons: sig.exclude_reasons,
        });
      }
      const life = getLifecycle(market);
      if (life.state === "cooldown" && life.cooldown_until_ts && Date.now() < Date.parse(life.cooldown_until_ts)) continue;
      if (life.state === "cooldown") setLifecycle(market, "idle");
      if (!life.first_seen_ts) {
        setLifecycle(market, life.state, {
          first_seen_ts: new Date().toISOString(),
          first_seen_price: undefined,
          last_local_high: undefined,
        });
      }
      watchMarkets.add(market);
    }

    for (const [market, c] of Array.from(state.preEntryWatch.entries())) {
      if (Date.now() - c.detectedAt > CANDIDATE_KEEP_MS) {
        state.preEntryWatch.delete(market);
        if (!state.positions[market]) setLifecycle(market, "idle");
        continue;
      }
      watchMarkets.add(market);
    }

    if (watchMarkets.size === 0) {
      await persist();
      return;
    }

    const tickers = await fetchTickers([...watchMarkets]);
    const priceByMarket: Record<string, number> = {};
    let btcChange = 0;
    for (const t of tickers) {
      const p = toNum(t.trade_price, 0);
      if (p > 0) priceByMarket[t.market] = p;
      if (t.market === "KRW-BTC") btcChange = Number(t.signed_change_rate ?? 0);
    }
    const btcTier: "strong" | "neutral" | "weak" =
      btcChange <= -0.004 ? "weak" : btcChange >= 0.002 ? "strong" : "neutral";
    const entryScale = btcTier === "weak" ? PAPER_BTC_WEAK_ENTRY_SCALE : btcTier === "neutral" ? PAPER_BTC_NEUTRAL_ENTRY_SCALE : 1;

    const orderedSignals = Array.from(latestSignalByMarket.entries()).sort((a, b) => b[1].score - a[1].score);
    emitPaper("DEBUG_PAPER_ENTRY_UNIVERSE_CREATED", {
      ordered_signals_length: orderedSignals.length,
      symbols: orderedSignals.map(([m]) => m).slice(0, 50),
    });

    // 0) Manage early-active positions: promote or fast-cut before evaluating new entries
    for (const p of Object.values(state.positions)) {
      if (p.signal_strength !== "SURGE_SCANNER") continue;
      if (p.position_stage !== "early_active") continue;
      const px = priceByMarket[p.market] ?? 0;
      if (!(px > 0)) continue;
      const heldSec = Math.max(0, Math.floor((Date.now() - Date.parse(p.entry_ts)) / 1000));
      const grossPct = ((px / p.entry_price) - 1) * 100;
      const life = getLifecycle(p.market);
      const recentHigh = Number(p.entry_recent_high ?? life.last_local_high ?? 0);
      const breakoutNow = recentHigh > 0 ? px >= recentHigh : false;
      const promoteNow = breakoutNow || grossPct >= PAPER_EARLY_PROMOTION_PCT || heldSec >= PAPER_EARLY_PROMOTION_MAX_SECONDS;
      if (promoteNow) {
        const { normal_open_positions } = countPaperSlots(state.positions);
        /** 승격 대상 p는 아직 early이므로 normal 카운트에 미포함 */
        const promotionNormalCapOverride = normal_open_positions >= PAPER_NORMAL_MAX_OPEN;
        p.position_stage = "normal_active";
        const slotsAfterPromo = countPaperSlots(state.positions);
        emitPaper("DEBUG_PAPER_EARLY_ENTRY_EXIT", {
          market: p.market,
          early_entry_fail_triggered: false,
          exit_reason: "promoted_to_normal",
          held_seconds: heldSec,
          pnl_gross_pct: Number(grossPct.toFixed(4)),
          promotion_normal_cap_override: promotionNormalCapOverride,
          normal_open_positions_after: slotsAfterPromo.normal_open_positions,
          early_open_positions_after: slotsAfterPromo.early_open_positions,
        });
        continue;
      }
      const failByTime = heldSec >= PAPER_EARLY_ENTRY_FAIL_SECONDS;
      const failByLoss = grossPct <= PAPER_EARLY_ENTRY_FAIL_LOSS_PCT;
      if (failByTime || failByLoss) {
        emitPaper("DEBUG_PAPER_EARLY_ENTRY_EXIT", {
          market: p.market,
          early_entry_fail_triggered: true,
          exit_reason: failByLoss ? "early_fail_loss" : "early_breakout_failed",
          held_seconds: heldSec,
          pnl_gross_pct: Number(grossPct.toFixed(4)),
        });
        paperSell(p.market, px, "CLOSED_LOSS", failByLoss ? "paper_early_fail_loss" : "paper_early_breakout_failed");
      }
    }

    for (const [market, sig] of orderedSignals) {
      const px = priceByMarket[market] ?? 0;
      if (!(px > 0)) continue;

      // [ORIGINAL SETUP] Primary Filter for Paper Trading
      let setupOk = false;
      let setupResult: any = null;
      try {
        const c250 = await fetchMinuteCandles(market, 1, 250);
        if (c250.length >= 250) {
          const completed = c250.slice(0, -1);
          const closes = completed.map(c => Number(c.trade_price));
          const highs = completed.map(c => Number(c.high_price));
          const lows = completed.map(c => Number(c.low_price));
          const volumes = completed.map(c => Number(c.candle_acc_trade_volume));

          const ema50 = emaLast(closes, 50);
          const ema200 = emaLast(closes, 200);
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
          const recentLows = lows.slice(-10);
          const swingLow = Math.min(...recentLows);
          const avgVol5 = volumes.slice(-6, -1).reduce((a,b) => a+b, 0) / 5;
          const volRatio = avgVol5 > 0 ? volumes[lastIdx]! / avgVol5 : 0;

          // Safe Mode
          const safePriceAboveEma200 = px > (ema200 ?? 0);
          const pullbackToEma200 = lows.slice(-20).some(l => l <= (ema200 ?? 0) * 1.015);
          const stochCross = prevK <= 20 && prevD <= 20 && k > d && prevK <= prevD;
          
          if (safePriceAboveEma200 && pullbackToEma200 && stochCross && isBullish) {
            const stop = swingLow * 0.998;
            const target = px + (px - stop) * 1.5;
            setupResult = { ok: true, mode: "safe", stop, target, rr: 1.5, reason: "safe_pullback_ema200" };
            setupOk = true;
          } else {
            // Aggressive Mode
            const emaStack = (ema50 ?? 0) > (ema200 ?? 0);
            const priceAbove = px > (ema50 ?? 0) && px > (ema200 ?? 0);
            const stochRev = k > prevK && k > 20;
            const rsiBull = rsi > 50 || (rsi > prevK && prevK < 50);
            if (emaStack && priceAbove && stochRev && rsiBull && volRatio > 1.0) {
              const stop = Math.min(Number(lastCandle.low_price), swingLow) * 0.998;
              const target = px + (px - stop) * 2.0;
              setupResult = { ok: true, mode: "aggressive", stop, target, rr: 2.0, reason: "aggressive_trend" };
              setupOk = true;
            }
          }
        }
      } catch (err) {}

      if (!setupOk) {
        emitPaper("DEBUG_ORIGINAL_SPOT_SETUP_BLOCK", { market, ok: false, reason: "setup_conditions_not_met" });
        continue; 
      }
      emitPaper("DEBUG_ORIGINAL_SPOT_SETUP_PASS", { market, mode: setupResult.mode, rr: setupResult.rr });

      if (sig.status === "제외") {
        const blockReason = (sig.exclude_reasons || []).join(",") || "strict_filter_rejected_status";
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: blockReason, stage: "ordered_signals_loop" });
        continue;
      }
      const slotSnap = countPaperSlots(state.positions);
      const posHere = state.positions[market];
      emitPaper("DEBUG_PAPER_PRECHECK_ENTER", {
        market,
        early_entry_eligible: sig.early_entry_eligible,
        volume_multiple: sig.volume_multiple,
        price: px,
        open_positions: Object.keys(state.positions).length,
        normal_open_positions: slotSnap.normal_open_positions,
        early_open_positions: slotSnap.early_open_positions,
        normal_max_positions: PAPER_NORMAL_MAX_OPEN,
        early_max_positions: PAPER_EARLY_ENTRY_MAX_OPEN,
        max_positions: PAPER_NORMAL_MAX_OPEN + PAPER_EARLY_ENTRY_MAX_OPEN,
        position_stage: posHere?.position_stage ?? null,
        slot_domain: "both",
      });

      if (!state.seenSignalKeys.has(sig.key)) {
        state.seenSignalKeys.add(sig.key);
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SIGNAL",
          note: `signal_detected:surge_scanner:${sig.reason}`,
          signal_strength: sig.signal_strength,
          entry_price: null,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
      }

      const watchWorthy = sig.score >= 45 || sig.early_entry_eligible || sig.add_entry_eligible;
      const priorPool = state.preEntryWatch.get(market);
      if (!priorPool && watchWorthy) {
        state.preEntryWatch.set(market, {
          score: sig.score,
          reason: sig.reason,
          status: sig.status,
          detectedAt: Date.now(),
          signalStrength: sig.signal_strength,
        });
        state.metrics.preEntryWatchHits += 1;
        setLifecycle(market, "pre_entry", { candidate_score: sig.score, last_reason: sig.reason });
      }
      if (state.preEntryWatch.size > CANDIDATE_MAX_TRACKED) {
        const weakest = Array.from(state.preEntryWatch.entries()).sort((a, b) => a[1].score - b[1].score)[0]?.[0];
        if (weakest) state.preEntryWatch.delete(weakest);
      }

      const lifeEntry = getLifecycle(market);
      if (lifeEntry.cooldown_until_ts && Date.now() < Date.parse(lifeEntry.cooldown_until_ts)) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "cooldown_active", stage: "ordered_signals_loop" });
        continue;
      }

      if (state.positions[market]) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "already_open", stage: "ordered_signals_loop" });
        continue;
      }
      if (!(px > 0)) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "invalid_or_missing_price", stage: "ordered_signals_loop" });
        continue;
      }

      // Timing guard inputs (signal freshness + chase + near-high + volume fade)
      const signalTs = lifeEntry.first_seen_ts ?? null;
      const signalPrice = Number(lifeEntry.first_seen_price ?? px);
      const secondsSinceSignal = signalTs ? Math.max(0, Math.floor((Date.now() - Date.parse(signalTs)) / 1000)) : null;
      let localHigh = Number(lifeEntry.last_local_high ?? 0);
      let distanceFromLocalHighPct: number | null = null;
      let priceChangeSinceSignalPct: number | null = null;
      let volumeRatio1m5: number | null = null;
      try {
        const c1 = await fetchMinuteCandles(market, 1, 12);
        const highs = c1.map((x: any) => Number(x.high_price ?? 0)).filter((n: number) => Number.isFinite(n) && n > 0);
        if (highs.length > 0) localHigh = Math.max(...highs);
        if (localHigh > 0) distanceFromLocalHighPct = ((localHigh - px) / localHigh) * 100;
        if (signalPrice > 0) priceChangeSinceSignalPct = ((px / signalPrice) - 1) * 100;
        if (c1.length >= 7) {
          const last = c1[c1.length - 1] as any;
          const prev5 = c1.slice(-6, -1) as any[];
          const lastNotional = Number(last.candle_acc_trade_volume ?? 0) * Number(last.trade_price ?? 0);
          const prevAvg =
            prev5.reduce((acc, r) => acc + Number(r.candle_acc_trade_volume ?? 0) * Number(r.trade_price ?? 0), 0) /
            Math.max(1, prev5.length);
          if (Number.isFinite(lastNotional) && Number.isFinite(prevAvg) && prevAvg > 0) {
            volumeRatio1m5 = lastNotional / prevAvg;
          }
        }
      } catch {
        // ignore candle failures
      }
      setLifecycle(market, lifeEntry.state, {
        first_seen_ts: signalTs ?? undefined,
        first_seen_price: signalPrice,
        last_local_high: localHigh > 0 ? localHigh : undefined,
      });

      // Early min score (needed for near-high bypass + early entry gate)
      const earlyMinScoreDefault = Math.max(0, sig.score - 10);
      const earlyMinScore = (() => {
        const raw = process.env.PAPER_EARLY_ENTRY_MIN_SCORE;
        const n = raw === undefined || raw === "" ? earlyMinScoreDefault : Number(raw);
        return Number.isFinite(n) ? n : earlyMinScoreDefault;
      })();

      const stale = secondsSinceSignal !== null && secondsSinceSignal > PAPER_ENTRY_SIGNAL_STALE_SECONDS;
      const chase = priceChangeSinceSignalPct !== null && priceChangeSinceSignalPct > PAPER_MAX_CHASE_FROM_SIGNAL_PCT;
      const faded = volumeRatio1m5 !== null && volumeRatio1m5 < 0.65;
      const nearHighRisk =
        distanceFromLocalHighPct !== null && distanceFromLocalHighPct < PAPER_MAX_ENTRY_NEAR_HIGH_PCT;

      /** stale/chase/faded 없이 near_high만 걸린 초입 구간이면 timing 차단 면제 */
      const nearHighBypassApplied =
        nearHighRisk &&
        !stale &&
        !chase &&
        !faded &&
        secondsSinceSignal !== null &&
        secondsSinceSignal <= PAPER_NEAR_HIGH_EARLY_BYPASS_SECONDS &&
        (priceChangeSinceSignalPct === null || priceChangeSinceSignalPct <= PAPER_NEAR_HIGH_EARLY_BYPASS_MAX_CHASE_PCT) &&
        volumeRatio1m5 !== null &&
        volumeRatio1m5 >= PAPER_NEAR_HIGH_EARLY_BYPASS_MIN_VOLUME_RATIO &&
        sig.score >= earlyMinScore;

      if (nearHighRisk) {
        let bypassDetail: string;
        if (nearHighBypassApplied) {
          bypassDetail = "applied_fresh_low_chase_volume_alive_score_ok";
        } else if (stale) {
          bypassDetail = "blocked_pair_stale_signal";
        } else if (chase) {
          bypassDetail = "blocked_pair_chase_too_high";
        } else if (faded) {
          bypassDetail = "blocked_pair_volume_faded";
        } else if (secondsSinceSignal === null || secondsSinceSignal > PAPER_NEAR_HIGH_EARLY_BYPASS_SECONDS) {
          bypassDetail = "signal_not_fresh_enough_for_bypass";
        } else if (priceChangeSinceSignalPct !== null && priceChangeSinceSignalPct > PAPER_NEAR_HIGH_EARLY_BYPASS_MAX_CHASE_PCT) {
          bypassDetail = "chase_above_bypass_max";
        } else if (volumeRatio1m5 === null || volumeRatio1m5 < PAPER_NEAR_HIGH_EARLY_BYPASS_MIN_VOLUME_RATIO) {
          bypassDetail = "volume_below_bypass_min";
        } else if (sig.score < earlyMinScore) {
          bypassDetail = "score_below_min_for_bypass";
        } else {
          bypassDetail = "unknown";
        }
        emitPaper("DEBUG_PAPER_NEAR_HIGH_BYPASS", {
          market,
          seconds_since_signal: secondsSinceSignal,
          price_change_since_signal_pct: priceChangeSinceSignalPct,
          distance_from_local_high_pct: distanceFromLocalHighPct,
          volume_ratio: volumeRatio1m5,
          near_high_bypass_applied: nearHighBypassApplied,
          near_high_bypass_reason: bypassDetail,
        });
      }

      let timingBlockReason: string | null = null;
      if (stale) timingBlockReason = "signal_stale";
      else if (chase) timingBlockReason = "chase_too_high";
      else if (faded) timingBlockReason = "volume_faded";
      else if (nearHighRisk && !nearHighBypassApplied) timingBlockReason = "near_high_entry";

      if (timingBlockReason) {
        emitPaper("DEBUG_PAPER_ENTRY_TIMING_GUARD", {
          market,
          reason: timingBlockReason,
          near_high_bypass_applied: nearHighBypassApplied,
          seconds_since_signal: secondsSinceSignal,
          price_change_since_signal_pct: priceChangeSinceSignalPct,
          distance_from_local_high_pct: distanceFromLocalHighPct,
          volume_ratio: volumeRatio1m5,
        });
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: `timing_guard:${timingBlockReason}`, stage: "ordered_signals_loop" });
        continue;
      }

      const baseProfile = buildEntryProfileFeatures({
        signalStrength: sig.signal_strength,
        positionStage: "normal_active",
        btcTier,
        score: sig.score,
        volumeRatio: volumeRatio1m5,
        signalAgeSec: secondsSinceSignal,
        chasePct: priceChangeSinceSignalPct,
        nearHighPct: distanceFromLocalHighPct,
        breakout: sig.breakout,
        earlyEntryEligible: sig.early_entry_eligible,
      });

      // Attach Original Setup fields to profile for handoff
      (baseProfile as any).original_setup_mode = setupResult.mode;
      (baseProfile as any).original_setup_reason = setupResult.reason;
      (baseProfile as any).entry_stop_price = setupResult.stop;
      (baseProfile as any).entry_target_price = setupResult.target;
      (baseProfile as any).entry_risk_reward = setupResult.rr;


      const coarseKey = buildCoarseProfileKey(coarseFromFine(baseProfile));
      const fineKey = buildFineProfileKey(baseProfile);
      const coarseDecision = evaluateCoarseProfileDecision(state.coarseProfileStats[coarseKey]);
      const fineDecision = evaluateFineProfileDecision(state.fineProfileStats[fineKey]);

      let profileDecision: ProfileDecisionResult = coarseDecision;
      // [HARDENED] Dual-stage gating: Coarse block always takes priority
      if (coarseDecision.decision === "block") {
        profileDecision = coarseDecision;
      } else if (fineDecision.decision === "block") {
        profileDecision = fineDecision;
      } else if (fineDecision.decision === "allow") {
        profileDecision = fineDecision;
      } else if (coarseDecision.decision === "allow") {
        profileDecision = coarseDecision;
      } else {
        // Unknown case handling
        if (btcTier === "weak") {
          profileDecision = {
            decision: "block",
            reason: "coarse_profile_unknown_block_in_weak",
            stats_snapshot: coarseDecision.stats_snapshot,
          };
        } else if (btcTier === "neutral" && (sig.score < 82 || (volumeRatio1m5 ?? 0) < 1.35)) {
          profileDecision = {
            decision: "block",
            reason: "coarse_profile_unknown_block_neutral_quality",
            stats_snapshot: coarseDecision.stats_snapshot,
          };
        }
      }
      emitPaper("DEBUG_PAPER_PROFILE_DECISION", {
        market,
        coarse_profile_key: coarseKey,
        fine_profile_key: fineKey,
        profile_decision: profileDecision.decision,
        profile_reason: profileDecision.reason,
        coarse_profile_decision: coarseDecision.decision,
        fine_profile_decision: fineDecision.decision,
        profile_stats: profileDecision.stats_snapshot,
      });
      if (profileDecision.decision === "block") {
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: profileDecision.reason,
          signal_strength: sig.signal_strength,
          entry_price: px,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
          entry_profile_key: fineKey,
          entry_profile_features: baseProfile,
          profile_decision: "block",
          profile_reason: profileDecision.reason,
          profile_stats: profileDecision.stats_snapshot,
        });
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: profileDecision.reason, stage: "profile_gate", coarse_profile_key: coarseKey, fine_profile_key: fineKey });
        continue;
      }

      // 1) Early entry first (aggressive)
      const earlySlotsUsed = Object.values(state.positions).filter((p) => p.position_stage === "early_active").length;
      const earlySlotOk = earlySlotsUsed < PAPER_EARLY_ENTRY_MAX_OPEN;
      const earlyFreshOk = secondsSinceSignal !== null && secondsSinceSignal <= PAPER_EARLY_ENTRY_MAX_SIGNAL_SECONDS;
      const earlyNearHighOkRaw =
        distanceFromLocalHighPct !== null && distanceFromLocalHighPct <= PAPER_MAX_ENTRY_NEAR_HIGH_PCT;
      /** timing에서 near_high 단독 bypass 통과 시에도 early의 “고점 근접” 조건은 동일 밴드로 충족된 것으로 본다 */
      const earlyNearHighOk = earlyNearHighOkRaw || nearHighBypassApplied;
      const earlyVolOk = volumeRatio1m5 !== null && volumeRatio1m5 >= PAPER_EARLY_ENTRY_MIN_VOLUME_RATIO;
      const earlyScoreOk = sig.score >= earlyMinScore;
      const earlyAllowed = earlySlotOk && earlyFreshOk && earlyNearHighOk && earlyVolOk && earlyScoreOk;

      const slotAtEarlyDecision = countPaperSlots(state.positions);
      emitPaper("DEBUG_PAPER_EARLY_ENTRY_DECISION", {
        market,
        slot_domain: "early",
        normal_open_positions: slotAtEarlyDecision.normal_open_positions,
        early_open_positions: slotAtEarlyDecision.early_open_positions,
        normal_max_positions: PAPER_NORMAL_MAX_OPEN,
        early_max_positions: PAPER_EARLY_ENTRY_MAX_OPEN,
        /** 신규 진입 평가 구간: 이미 보유면 상단에서 continue */
        position_stage: null,
        seconds_since_signal: secondsSinceSignal,
        price_change_since_signal_pct: priceChangeSinceSignalPct,
        distance_from_local_high_pct: distanceFromLocalHighPct,
        volume_ratio: volumeRatio1m5,
        near_high_bypass_applied: nearHighBypassApplied,
        early_entry_allowed: earlyAllowed,
        early_entry_block_reason: earlyAllowed
          ? null
          : !earlySlotOk
            ? "early_max_open_positions"
            : !earlyFreshOk
              ? "signal_not_fresh"
              : !earlyNearHighOk
                ? "near_high_requirement_failed"
                : !earlyVolOk
                  ? "volume_not_strong"
                  : !earlyScoreOk
                    ? "score_too_low"
                    : "unknown",
      });

      if (earlyAllowed) {
        const earlyAmount = Math.max(5_000, Math.floor(PAPER_ENTRY_KRW_PER_TRADE * 0.4 * entryScale));
        const earlyFeatures: EntryProfileFeatures = { ...baseProfile, position_stage: "early_active" };
        const earlyCoarseKey = buildCoarseProfileKey(coarseFromFine(earlyFeatures));
        const earlyKey = buildFineProfileKey(earlyFeatures);
        const earlyCoarseDecision = evaluateCoarseProfileDecision(state.coarseProfileStats[earlyCoarseKey]);
        const earlyFineDecision = evaluateFineProfileDecision(state.fineProfileStats[earlyKey]);
        let earlyDecision: ProfileDecisionResult = earlyCoarseDecision;
        if (earlyCoarseDecision.decision !== "block" && earlyFineDecision.decision === "allow") {
          earlyDecision = earlyFineDecision;
        }
        if (earlyCoarseDecision.decision === "unknown" && btcTier === "weak") {
          earlyDecision = {
            decision: "block",
            reason: "coarse_profile_unknown_block_in_weak",
            stats_snapshot: earlyCoarseDecision.stats_snapshot,
          };
        }
        if (earlyDecision.decision === "block") {
          appendHistory({
            ts: new Date().toISOString(),
            market,
            state: "SKIPPED",
            note: earlyDecision.reason,
            signal_strength: sig.signal_strength,
            entry_price: px,
            exit_price: null,
            qty: null,
            pnl_krw: null,
            pnl_pct: null,
            entry_profile_key: earlyKey,
            entry_profile_features: earlyFeatures,
            profile_decision: "block",
            profile_reason: earlyDecision.reason,
            profile_stats: earlyDecision.stats_snapshot,
          });
          emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: earlyDecision.reason, stage: "profile_gate_early", coarse_profile_key: earlyCoarseKey, fine_profile_key: earlyKey });
          continue;
        }
        emitPaper("DEBUG_PAPER_ORDER_ATTEMPT", {
          market,
          order_krw: earlyAmount,
          stage: "paper_early_entry",
          coarse_profile_key: earlyCoarseKey,
          fine_profile_key: earlyKey,
          profile_decision: earlyDecision.decision,
          profile_reason: earlyDecision.reason,
          profile_stats: earlyDecision.stats_snapshot,
        });
        const b = paperBuy(
          market,
          "SURGE_SCANNER",
          px,
          `paper_early_entry|${earlyDecision.reason}`,
          earlyAmount,
          "early",
          {
            key: earlyKey,
            features: earlyFeatures,
            decision: earlyDecision.decision,
            reason: earlyDecision.reason,
            stats_snapshot: earlyDecision.stats_snapshot,
          },
        );
        if (b.ok) {
          const filled = (state.positions as any)[market] as any;
          if (filled) {
            filled.signal_ts = signalTs;
            filled.signal_price = signalPrice;
            filled.entry_recent_high = localHigh > 0 ? localHigh : null;
          }
          emitPaper("DEBUG_PAPER_EARLY_ENTRY_FILLED", {
            market,
            order_krw: earlyAmount,
            qty: Number(filled?.qty ?? 0),
            price: px,
            seconds_since_signal: secondsSinceSignal,
            volume_ratio: volumeRatio1m5,
          });
          continue;
        }
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: `paperBuy:${b.reason ?? "unknown"}`, stage: "paper_early_entry" });
      }

      // 2) normal entry fallback (only if early not allowed)
      const normalSlotsSnap = countPaperSlots(state.positions);
      if (normalSlotsSnap.normal_open_positions >= PAPER_NORMAL_MAX_OPEN) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", {
          market,
          reason: "normal_max_open_positions",
          stage: "ordered_signals_loop",
          slot_domain: "normal",
          normal_open_positions: normalSlotsSnap.normal_open_positions,
          normal_max_positions: PAPER_NORMAL_MAX_OPEN,
        });
        continue;
      }
      const volOkLegacy = sig.volume_multiple > SURGE_EARLY_VOLUME_RATIO_MIN;
      if (!sig.early_entry_eligible || !volOkLegacy) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "early_not_ok_and_no_normal_path", stage: "ordered_signals_loop" });
        continue;
      }

      const earlyAmount = Math.max(5_000, Math.floor(PAPER_ENTRY_KRW_PER_TRADE * SURGE_EARLY_ALLOC_RATIO * entryScale));
      const earlyNote = `early_entry:surge_50pct|vr=${sig.volume_multiple.toFixed(3)}|score=${sig.score}|btc_scale=${entryScale}|${profileDecision.reason}`;
      emitPaper("DEBUG_PAPER_ORDER_ATTEMPT", {
        market,
        order_krw: earlyAmount,
        stage: "legacy_early_entry",
        coarse_profile_key: coarseKey,
        fine_profile_key: fineKey,
        profile_decision: profileDecision.decision,
        profile_reason: profileDecision.reason,
        profile_stats: profileDecision.stats_snapshot,
      });
      const b = paperBuy(market, sig.signal_strength, px, earlyNote, earlyAmount, "normal", {
        key: fineKey,
        features: baseProfile,
        decision: profileDecision.decision,
        reason: profileDecision.reason,
        stats_snapshot: profileDecision.stats_snapshot,
      });
      if (b.ok) {
        const filled = (state.positions as any)[market] as any;
        emitPaper("DEBUG_PAPER_ORDER_FILLED", {
          market,
          qty: Number(filled?.qty ?? 0),
          price: Number(filled?.entry_price ?? px),
          stage: "early_entry",
        });
        logPumpScannerDebug({
          early_entry_triggered: true,
          market,
          price: px,
          volume_multiple: sig.volume_multiple,
          score: sig.score,
          early_krw: earlyAmount,
        });
      } else {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: b.reason ?? "unknown", stage: "paperBuy" });
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: `early_entry_blocked:${b.reason ?? "unknown"}`,
          signal_strength: sig.signal_strength,
          entry_price: px,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
      }
    }

    const trySurgeAddLegs = () => {
      for (const p of Object.values(state.positions)) {
        if (p.signal_strength !== "SURGE_SCANNER") continue;
        if (p.surge_add_leg_done === true) continue;
        const sig = latestSignalByMarket.get(p.market);
        if (!sig?.add_entry_eligible) continue;
        const px = priceByMarket[p.market] ?? 0;
        if (!(px > 0)) continue;
        const grossPct = ((px / p.entry_price) - 1) * 100;
        const hasEdge = grossPct > 0;
        const breakoutHeld = sig.breakout === true;
        const volumeHeld = Number(sig.volume_multiple ?? 0) >= 1.2;
        const qualityHeld = (() => {
          const chase = p.signal_price && p.signal_price > 0 ? ((px / p.signal_price) - 1) * 100 : 0;
          const near = p.entry_recent_high && p.entry_recent_high > 0 ? ((p.entry_recent_high - px) / p.entry_recent_high) * 100 : 0;
          return chase <= 1.0 && near >= 0.05;
        })();
        if (!hasEdge || !breakoutHeld || !volumeHeld || !qualityHeld) continue;
        const addAmount = Math.max(5_000, Math.floor(PAPER_ENTRY_KRW_PER_TRADE * SURGE_ADD_ALLOC_RATIO * entryScale));
        const addNote = `add_entry:surge_50pct|score=${sig.score}|btc_scale=${entryScale}|winner_only_add`;
        const r = paperSurgeAddBuy(p.market, px, addNote, addAmount);
        if (r.ok) {
          logPumpScannerDebug({
            add_entry_triggered: true,
            market: p.market,
            price: px,
            score: sig.score,
            add_krw: addAmount,
            entry_vwap: state.positions[p.market]?.entry_price,
          });
        }
      }
    };
    trySurgeAddLegs();

    for (const p of Object.values(state.positions)) {
      const px = priceByMarket[p.market] ?? 0;
      if (!(px > 0)) continue;
      const grossPct = ((px / p.entry_price) - 1) * 100;
      const heldMs = Date.now() - Date.parse(p.entry_ts);
      p.peak_price = Math.max(Number(p.peak_price ?? p.entry_price), px);
      p.max_up_pct = Math.max(p.max_up_pct ?? grossPct, grossPct);

      // [ORIGINAL SETUP] Priority Exit Guard for Paper
      if (p.entry_stop_price && px <= p.entry_stop_price) {
        paperSell(p.market, px, "CLOSED_LOSS", "original_setup_stop_loss");
        continue;
      } else if (p.entry_target_price && px >= p.entry_target_price) {
        paperSell(p.market, px, "CLOSED_WIN", "original_setup_target_tp");
        continue;
      }

      if (p.signal_strength === "SURGE_SCANNER") {
        if (grossPct <= SURGE_STOP_LOSS_PCT) {
          logPumpScannerDebug({
            stop_loss_triggered: true,
            market: p.market,
            price: px,
            entry_price: p.entry_price,
            gross_pct: Number(grossPct.toFixed(4)),
            stop_loss_pct: SURGE_STOP_LOSS_PCT,
          });
          paperSell(p.market, px, "CLOSED_LOSS", `surge_stop_loss:${SURGE_STOP_LOSS_PCT}`);
          continue;
        }
        const coarseKey =
          p.entry_profile_features != null ? buildCoarseProfileKey(coarseFromFine(p.entry_profile_features)) : null;
        const coarseStats = coarseKey ? state.coarseProfileStats[coarseKey] : undefined;
        const deadline = paperTimeExitDeadlineMsByContext(p, coarseStats);
        if (heldMs >= deadline) {
          paperSell(p.market, px, "CLOSED_TIMEOUT", paperTimeExitNote(p, coarseStats));
        }
        continue;
      }

      if (grossPct <= -2.5) {
        paperSell(p.market, px, "CLOSED_LOSS", "hard_stop_loss");
        continue;
      }
      if (heldMs >= 6 * 60_000 && (p.max_up_pct ?? 0) < 0.25 && grossPct <= -1.2) {
        paperSell(p.market, px, "CLOSED_LOSS", "early_failure_cut");
        continue;
      }
      if (!p.take_profit_partial_done && grossPct >= 3.0) {
        const r = paperSell(p.market, px, "CLOSED_WIN", "partial_take_profit", 0.25);
        if (r.ok && state.positions[p.market]) {
          state.positions[p.market]!.take_profit_partial_done = true;
          state.positions[p.market]!.runner_trail_armed = false;
        }
        continue;
      }
      if (p.take_profit_partial_done) {
        if (grossPct >= 3.2) {
          p.runner_trail_armed = true;
        }
        const peak = Number(p.peak_price ?? 0);
        if (p.runner_trail_armed && peak > 0) {
          const ddFromPeak = ((peak - px) / peak) * 100;
          const trailNeed = (p.entry_profile_features?.btc_tier ?? "neutral") === "weak" ? 1.8 : 2.2;
          if (ddFromPeak >= trailNeed) {
            paperSell(p.market, px, "CLOSED_WIN", "runner_trailing_exit");
            continue;
          }
        }
      }
      const cKey = p.entry_profile_features != null ? buildCoarseProfileKey(coarseFromFine(p.entry_profile_features)) : null;
      const cStats = cKey ? state.coarseProfileStats[cKey] : undefined;
      const dline = paperTimeExitDeadlineMsByContext(p, cStats);
      if (heldMs >= dline) {
        paperSell(p.market, px, "CLOSED_TIMEOUT", paperTimeExitNote(p, cStats));
      }
    }

    await persist();
  };

  const status = async () => {
    const watchMarkets = Object.keys(state.positions);
    const tickerRows = watchMarkets.length > 0 ? await fetchTickers(watchMarkets) : [];
    const priceByMarket: Record<string, number> = {};
    for (const t of tickerRows) {
      const p = toNum(t.trade_price, 0);
      if (p > 0) priceByMarket[t.market] = p;
    }
    const summary = buildSummary(priceByMarket);
    const avgEntryLatencyMs =
      state.metrics.entryLatencyMs.length > 0
        ? state.metrics.entryLatencyMs.reduce((a, b) => a + b, 0) / state.metrics.entryLatencyMs.length
        : 0;
    const closed = state.history.filter((h) => h.state === "CLOSED_WIN" || h.state === "CLOSED_LOSS" || h.state === "CLOSED_TIMEOUT");
    const wins = closed.filter((h) => (h.pnl_krw ?? 0) > 0).map((h) => Number(h.pnl_krw ?? 0));
    const losses = closed.filter((h) => (h.pnl_krw ?? 0) < 0).map((h) => Math.abs(Number(h.pnl_krw ?? 0)));
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

    return {
      mode: "paper_trading",
      updated_at: new Date().toISOString(),
      ...summary,
      execution_metrics: {
        pre_entry_watch_hits: state.metrics.preEntryWatchHits,
        entry_count: state.metrics.entriesOpened,
        entries_opened: state.metrics.entriesOpened,
        avg_entry_latency_sec: Number((avgEntryLatencyMs / 1000).toFixed(2)),
        early_exit_ratio:
          closed.length > 0 ? Number((state.metrics.earlyExitCount / closed.length).toFixed(4)) : 0,
        avg_win_loss_ratio: Number(avgWinLossRatio.toFixed(3)),
        active_pre_entry_watch_count: state.preEntryWatch.size,
        tracked_pre_entry_watch: state.preEntryWatch.size,
      },
      holdings: Object.values(state.positions).map((p) => {
        const px = priceByMarket[p.market] ?? 0;
        const evalKrw = p.qty * px;
        const estSellFee = evalKrw * UPBIT_FEE_RATE;
        const pnlKrw = evalKrw - estSellFee - p.invested_krw - p.buy_fee_krw;
        const pnlPct = p.invested_krw > 0 ? (pnlKrw / p.invested_krw) * 100 : 0;
        return {
          market: p.market,
          entry_ts: p.entry_ts,
          entry_price: p.entry_price,
          current_price: px,
          qty: p.qty,
          invested_krw: p.invested_krw,
          unrealized_pnl_krw: pnlKrw,
          unrealized_pnl_pct: pnlPct,
          signal_strength: p.signal_strength,
          position_stage: p.position_stage ?? null,
        };
      }),
      recent_history: state.history.slice(-40).reverse(),
      files: { state: stateFile },
    };
  };

  return {
    init,
    tick,
    status,
    paperBuy,
    paperSell,
  };
}


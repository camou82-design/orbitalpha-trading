import { mvpSignalPayloadV2Schema } from "./schemas.js";

export type MarketState = "risk_on" | "neutral" | "risk_off";

/** 서버 `market-state-filter`와 동일한 신호 강도 점수(0~100). */
export function signalStrengthScore(payload: unknown): number {
  if (typeof payload === "object" && payload !== null) {
    const raw = payload as any;
    if (raw.source_kind === "MAJOR_IMPULSE_V1" || raw.strategyType === "major_impulse") {
      if (raw.major_impulse_score !== undefined && Number.isFinite(Number(raw.major_impulse_score))) {
        return Math.min(100, Math.max(0, Number(raw.major_impulse_score)));
      }
      if (raw.setup_ok === true || raw.setup?.ok === true || raw.is_major_impulse === true) {
        return Math.min(100, Math.max(0, Number(raw.score ?? 85)));
      }
      return 0;
    }
    if (
      raw.source_kind === "CORE_TRADE" ||
      raw.engine_bucket === "core" ||
      raw.strategyType === "core" ||
      raw.strategyType === "stable" ||
      raw.strategyType === "core_trend" ||
      raw.strategyType === "core_pullback"
    ) {
      if (raw.core_score !== undefined && raw.core_score !== null && Number.isFinite(Number(raw.core_score))) {
        return Math.min(100, Math.max(0, Number(raw.core_score)));
      }
      if (raw.setup_ok === true || raw.setup?.ok === true) {
        return Math.min(100, Math.max(0, Number(raw.score ?? 85)));
      }
      return 0;
    }
  }

  const p = mvpSignalPayloadV2Schema.safeParse(payload);
  if (!p.success) return 0;
  let score = 0;
  if (p.data.filter_pass) score += 45;
  const vol = p.data.filters.find((f) => f.id === "volume_increase");
  const box = p.data.filters.find((f) => f.id === "box_breakout");
  const close = p.data.filters.find((f) => f.id === "volume_spike_close_fail");
  if (vol?.passed) score += 20;
  if (box?.passed) score += 15;
  if (close?.passed) score += 10;
  const sigType = (p.data.signal_type ?? "").toUpperCase();
  if (sigType === "HIGH") score += 10;
  if (sigType === "MID") score += 6;
  const vr = Number(p.data.volume_ratio ?? 0);
  if (vr >= 1.2) score += 10;
  if (vr >= 1.35) score += 6;
  if (vr >= 1.5) score += 6;

  // 급등 초입 포착: 완전 통과 전이라도 "완화 통과" 신호가 있으면 score를 과도하게 낮추지 않음.
  if (p.data.would_pass_with_pullback_relaxed) score += 6;
  if (p.data.would_pass_with_vol_close_relaxed_a) score += 5;
  if (p.data.would_pass_with_vol_close_relaxed_b) score += 3;
  if (p.data.would_pass_with_breakout_relaxed_a) score += 5;
  if (p.data.would_pass_with_breakout_relaxed_b) score += 3;
  if (p.data.pair_pass_breakout_b_and_pullback_relaxed) score += 4;
  if (p.data.pair_pass_breakout_b_and_vol_close_a) score += 4;
  return Math.min(100, score);
}

/** 신규·추가매수 공통 — `assertOrderBuyAllowed` / 대시보드 표시와 동일. */
export function runEntryScoreGate(
  market_state: MarketState,
  min_entry_score: number,
  market_bonus: number,
  payload: unknown | undefined,
  opts?: {
    sourceKind?: string;
    strategyType?: string;
    coreScore?: number;
    majorImpulseScore?: number;
    setupOk?: boolean;
  },
): { ok: true; score: number } | { ok: false; reason: string; score: number } {
  let baseScore = signalStrengthScore(payload);
  if (opts?.sourceKind === "MAJOR_IMPULSE_V1" || opts?.strategyType === "major_impulse") {
    if (opts.majorImpulseScore !== undefined && Number.isFinite(opts.majorImpulseScore)) {
      baseScore = Number(opts.majorImpulseScore);
    } else if (opts.setupOk === true) {
      baseScore = 85;
    }
  } else if (
    opts?.sourceKind === "CORE_TRADE" ||
    opts?.strategyType === "core" ||
    opts?.strategyType === "stable" ||
    opts?.strategyType === "core_trend"
  ) {
    if (opts.coreScore !== undefined && Number.isFinite(opts.coreScore)) {
      baseScore = Number(opts.coreScore);
    } else if (opts.setupOk === true) {
      baseScore = 85;
    } else {
      baseScore = 0;
    }
  }

  const score = baseScore + market_bonus;
  if (market_state === "risk_off") return { ok: false, reason: "market_state risk_off: 신규·추가 진입 차단", score };
  if (score < min_entry_score) return { ok: false, reason: `entry score ${score} < ${min_entry_score}`, score };
  return { ok: true, score };
}

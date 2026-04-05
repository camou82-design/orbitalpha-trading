export type StrategyType = "stable" | "momentum";
export type StopTriggerKind = "price_stop" | "pattern_break" | "time_stop" | "breakeven_protect";

export const UPBIT_FEE_RATE = 0.0005;

/** 업비트 KRW 마켓 최소 주문 금액(시장가 매도 시 체결 예상 KRW 기준). */
export const UPBIT_MIN_ORDER_KRW = 5000;

/**
 * 업비트 보유 화면과 동일하게 평단 대비 가격 변동률(%) — 익절/표시 기준 통일용.
 */
export function grossPnlPct(entryPrice: number, nowPrice: number): number {
  if (entryPrice <= 0 || nowPrice <= 0) return 0;
  return ((nowPrice / entryPrice) - 1) * 100;
}

/** 단위 가격 기준 매수·매도 수수료 반영 순수익률(%) — 체결 후 손익 추정·로그용. */
export function netPnlPctPerUnit(entryPrice: number, nowPrice: number): number {
  if (entryPrice <= 0 || nowPrice <= 0) return 0;
  const grossSell = nowPrice;
  const principal = entryPrice;
  const buyFee = principal * UPBIT_FEE_RATE;
  const sellFee = grossSell * UPBIT_FEE_RATE;
  const net = grossSell - principal - buyFee - sellFee;
  return (net / principal) * 100;
}

/**
 * 즉시 % 손절 대신 회복 탈출 우선. 아래 조건을 모두 만족할 때만 긴급 청산.
 */
export const RECOVERY_EXIT_CONFIG = {
  stable: {
    /** 이 시간 이상 보유 후에도 의미 있는 반등이 없으면 긴급 청산 검토 */
    giveup_minutes: 480,
    /** 반등 시도로 볼 최소 최고 수익률(미달 시 장기 미회복으로 간주) */
    min_peak_pct_to_skip_catastrophic: 0.4,
    catastrophic_exit_pct: -11,
  },
  momentum: {
    giveup_minutes: 240,
    min_peak_pct_to_skip_catastrophic: 0.5,
    catastrophic_exit_pct: -12,
  },
} as const;

export const STRATEGY_RISK_CONFIG = {
  stable: {
    /** 레거시 필드 — 즉시 손절에는 사용하지 않음(회복·긴급 청산만). */
    stop_loss_pct: -2.0,
    breakeven_arm_pct: 1.8,
    breakeven_floor_pct: 0.05,
    partial_take_profit_pct: 3.0,
    partial_take_profit_ratio: 0.5,
    trailing_from_peak_pct: 1.5,
    reentry_cooldown_minutes_after_stop: 20,
    weak_hold_stop_minutes: 12,
  },
  momentum: {
    stop_loss_pct: -3.0,
    breakeven_arm_pct: 2.0,
    breakeven_floor_pct: 0.1,
    partial_take_profit_pct: 3.5,
    partial_take_profit_ratio: 0.5,
    trailing_from_peak_pct: 1.2,
    time_stop_min_minutes: 3,
    time_stop_max_minutes: 5,
  },
} as const;

/** 신규 진입·파이프라인용 (로그에 사유 노출). */
export const LIVE_ENTRY_PIPELINE = {
  min_signal_strength_score: 62,
  /** risk_on 구간 최소 거래량 비율 */
  min_volume_ratio_risk_on: 1.06,
  /** neutral(횡보에 가까운 장) 최소 거래량 비율 */
  min_volume_ratio_neutral: 1.12,
  sideways_strict_min_volume_ratio: 1.24,
  rebreak_min_volume_ratio: 1.02,
  overheated_volume_max: 2.95,
} as const;

/** MID 신호는 합성 점수·raw 동시 만족 시에만 진입 후보 유지 */
export const LIVE_ENTRY_SIGNAL_GATES = {
  mid_min_raw_strength_score: 66,
  mid_min_entry_gate_score: 87,
} as const;

/**
 * 신규로 연 `strict_exit` 포지션만 적용 — 기존 보유(복원 시 필드 없음)는 기존 익절/손절 곡선 유지.
 * 짧은 손절, 일부 익절 후 넓은 트레일링(러너).
 */
export const STRICT_NEW_POSITION_EXIT = {
  stable: {
    hard_stop_pct: -1.45,
    hard_stop_min_hold_min: 2,
    early_cut_minutes: 22,
    early_cut_max_peak_pct: 0.32,
    early_cut_pnl_pct: -0.95,
    breakeven_arm_pct: 1.55,
    breakeven_floor_pct: 0.06,
    partial_tp_pct: 2.15,
    partial_tp_ratio: 0.38,
    trailing_peak_pct: 2.05,
    weak_hold_stop_minutes: 7,
    catastrophic_exit_pct: -5.8,
    giveup_minutes: 150,
    min_peak_pct_skip_catastrophic: 0.34,
  },
  momentum: {
    hard_stop_pct: -1.75,
    hard_stop_min_hold_min: 2,
    early_cut_minutes: 12,
    early_cut_max_peak_pct: 0.38,
    early_cut_pnl_pct: -1.1,
    breakeven_arm_pct: 1.85,
    breakeven_floor_pct: 0.08,
    partial_tp_pct: 2.65,
    partial_tp_ratio: 0.38,
    trailing_peak_pct: 1.75,
    catastrophic_exit_pct: -6.4,
    giveup_minutes: 95,
    min_peak_pct_skip_catastrophic: 0.42,
  },
  /** 전량 청산 후 동일 심볼 재진입 쿨다운(분) */
  reentry_cooldown_minutes_after_close: 42,
} as const;


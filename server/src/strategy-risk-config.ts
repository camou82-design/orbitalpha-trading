export type StrategyType = "stable" | "momentum";
export type StopTriggerKind = "price_stop" | "pattern_break" | "time_stop" | "breakeven_protect";

export const UPBIT_FEE_RATE = 0.0005;

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


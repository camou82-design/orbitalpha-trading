export type StrategyType = "stable" | "momentum";
export type StopTriggerKind = "price_stop" | "pattern_break" | "time_stop" | "breakeven_protect";

export const UPBIT_FEE_RATE = 0.0005;

export const STRATEGY_RISK_CONFIG = {
  stable: {
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


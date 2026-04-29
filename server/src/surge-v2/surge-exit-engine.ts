export type SurgeExitDecision =
  | {
      action: "hold";
      reason: "surge_hold";
      ratio: 0;
      runnerTrailActive: boolean;
    }
  | {
      action: "sell";
      reason:
        | "surge_hard_stop"
        | "surge_emergency_stop_first_minute"
        | "surge_early_fail_no_follow_through"
        | "surge_breakout_failed"
        | "surge_partial_take_profit"
        | "surge_breakeven_protect"
        | "surge_runner_trailing_exit"
        | "surge_timeout_no_profit"
        | "surge_residual_timeout_exit"
        | "surge_force_take_profit";
      ratio: number;
      runnerTrailActive: boolean;
    };

/**
 * Evaluates the exit conditions for a surge position.
 * 
 * Priorities:
 * 1. Emergency Stop
 * 2. Hard Stop
 * 3. Force Take Profit
 * 4. Runner Trailing Exit
 * 5. Breakeven Protect
 * 6. Early Fail
 * 7. Breakout Failed
 * 8. Timeout (No profit)
 * 9. Residual Timeout Exit
 * 10. Partial Take Profit
 * 11. Hold
 */
export function evaluateSurgeExit(pos: any, currentPx: number): SurgeExitDecision {
  const entryPrice = pos.entry_price;
  const pnlPct = ((currentPx - entryPrice) / entryPrice) * 100;
  const maxPnlPct = pos.max_pnl_pct || 0;
  const entryTs = new Date(pos.entry_ts).getTime();
  const holdMinutes = (Date.now() - entryTs) / 60000;
  const partialTpDone = pos.partial_tp_done || false;
  let runnerTrailActive = pos.runner_trail_active || false;

  // B. Runner Conversion Status Check (State update, not an exit)
  if (maxPnlPct >= 3.0) {
    runnerTrailActive = true;
  }

  // 1. Emergency Stop (First minute, <= -1.2%)
  if (holdMinutes < 1 && pnlPct <= -1.2) {
    return { action: "sell", reason: "surge_emergency_stop_first_minute", ratio: 1, runnerTrailActive };
  }

  // 2. Hard Stop (>= 1 minute, <= -0.9%)
  if (holdMinutes >= 1 && pnlPct <= -0.9) {
    return { action: "sell", reason: "surge_hard_stop", ratio: 1, runnerTrailActive };
  }

  // 3. Force Take Profit (>= +10%)
  if (pnlPct >= 10.0) {
    return { action: "sell", reason: "surge_force_take_profit", ratio: 1, runnerTrailActive };
  }

  // 4. Runner Trailing Exit
  if (runnerTrailActive && pnlPct <= maxPnlPct - 1.2) {
    return { action: "sell", reason: "surge_runner_trailing_exit", ratio: 1, runnerTrailActive };
  }

  // 5. Breakeven Protect
  if (maxPnlPct >= 1.2 && pnlPct <= 0.15) {
    return { action: "sell", reason: "surge_breakeven_protect", ratio: 1, runnerTrailActive };
  }

  // 6. Early Fail (No follow through)
  if (holdMinutes >= 3 && maxPnlPct < 0.3 && pnlPct <= -0.3) {
    return { action: "sell", reason: "surge_early_fail_no_follow_through", ratio: 1, runnerTrailActive };
  }

  // 7. Breakout Failed (conservative implementation)
  if (holdMinutes >= 3 && holdMinutes <= 7 && maxPnlPct < 0.5 && pnlPct <= 0) {
    return { action: "sell", reason: "surge_breakout_failed", ratio: 1, runnerTrailActive };
  }

  // 8. Timeout (No profit)
  if (holdMinutes >= 15 && pnlPct < 0.8 && !partialTpDone) {
    return { action: "sell", reason: "surge_timeout_no_profit", ratio: 1, runnerTrailActive };
  }

  // 9. Residual Timeout Exit
  if (holdMinutes >= 45 && partialTpDone && pnlPct < 1.0) {
    return { action: "sell", reason: "surge_residual_timeout_exit", ratio: 1, runnerTrailActive };
  }

  // 10. Partial Take Profit
  if (pnlPct >= 1.5 && !partialTpDone) {
    return { action: "sell", reason: "surge_partial_take_profit", ratio: 0.4, runnerTrailActive };
  }

  // 11. Hold
  return { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive };
}

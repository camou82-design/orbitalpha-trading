import { SurgeExitDecision } from "./surge-types.js";

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
  // Enforce zero-interference for legacy positions
  if (pos.strict_exit !== true) {
    return { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive: pos.runner_trail_active || false, authoritySource: "surge-v2" };
  }

  const entryPrice = pos.entry_price;
  const pnlPct = ((currentPx - entryPrice) / entryPrice) * 100;
  const maxPnlPct = pos.max_pnl_pct || 0;
  const entryTs = new Date(pos.entry_ts).getTime();
  const holdMinutes = (Date.now() - entryTs) / 60000;
  const partialTpDone = pos.partial_tp_done || false;
  let runnerTrailActive = pos.runner_trail_active || false;

  // Extract dynamic policies
  const stopPrice = pos.surge_stop_price;
  const takeProfitPrice = pos.surge_take_profit_price;
  const trailingStartPct = pos.surge_trailing_start_pct ?? 3.0;
  const trailingGapPct = pos.surge_trailing_gap_pct ?? 1.2;

  // Update Trailing State
  if (maxPnlPct >= trailingStartPct) {
    runnerTrailActive = true;
  }

  // 1. Strict Stop Loss
  if (stopPrice && currentPx <= stopPrice) {
    return { action: "sell", reason: "surge_strict_stop_loss", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 2. Strict Take Profit
  if (takeProfitPrice && currentPx >= takeProfitPrice) {
    return { action: "sell", reason: "surge_strict_take_profit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 3. Strict Trailing Stop
  if (runnerTrailActive && pnlPct <= maxPnlPct - trailingGapPct) {
    return { action: "sell", reason: "surge_strict_trailing_exit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 4. Breakeven Protect
  if (maxPnlPct >= 1.2 && pnlPct <= 0.15) {
    return { action: "sell", reason: "surge_breakeven_protect", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 5. Early Fail (No follow through)
  if (holdMinutes >= 3 && maxPnlPct < 0.3 && pnlPct <= -0.3) {
    return { action: "sell", reason: "surge_early_fail_no_follow_through", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 6. Breakout Failed
  if (holdMinutes >= 3 && holdMinutes <= 7 && maxPnlPct < 0.5 && pnlPct <= 0) {
    return { action: "sell", reason: "surge_breakout_failed", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 7. Timeout (No profit)
  if (holdMinutes >= 15 && pnlPct < 0.8 && !partialTpDone) {
    return { action: "sell", reason: "surge_timeout_no_profit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 8. Residual Timeout Exit
  if (holdMinutes >= 45 && partialTpDone && pnlPct < 1.0) {
    return { action: "sell", reason: "surge_residual_timeout_exit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 9. Partial Take Profit
  if (pnlPct >= 1.5 && !partialTpDone) {
    return { action: "sell", reason: "surge_partial_take_profit", ratio: 0.4, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // Hold
  return { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive, authoritySource: "surge-v2" };
}

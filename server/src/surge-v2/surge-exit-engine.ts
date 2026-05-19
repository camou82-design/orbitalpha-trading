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
export function evaluateSurgeExit(pos: any, currentPx: number, rise3mPct?: number): SurgeExitDecision {
  // Enforce zero-interference for legacy positions
  if (pos.strict_exit !== true) {
    return { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive: pos.surge_runner_active || false, authoritySource: "surge-v2" };
  }

  const entryPrice = pos.entry_price || 0;
  const pnlPct = entryPrice > 0 ? ((currentPx - entryPrice) / entryPrice) * 100 : 0;
  const maxPnlPct = pos.max_pnl_pct || 0;
  const highestPriceAfterEntry = pos.highest_price_after_entry || entryPrice;
  const entryTs = new Date(pos.entry_ts).getTime();
  const holdMinutes = (Date.now() - entryTs) / 60000;
  
  const tp1Done = pos.surge_tp1_done || false;
  const tp2Done = pos.surge_tp2_done || false;
  let runnerTrailActive = pos.surge_runner_active || false;
  
  const entryMode = pos.surge_entry_mode || "CONFIRMED_SURGE_ENTRY";

  // Dynamic policies
  const stopPrice = pos.surge_stop_price;
  // takeProfitPrice is now TP2 target price!
  const tp2Price = pos.surge_take_profit_price;

  let tp1Target = 1.5;
  let tp1Ratio = entryMode === "FAST_SURGE_PROBE" ? 0.4 : 0.3;
  let tp2Ratio = 0.5;
  let trailingStartPct = entryMode === "FAST_SURGE_PROBE" ? 2.0 : 3.0;
  let trailingGapPct = pos.surge_trailing_gap_pct || (entryMode === "FAST_SURGE_PROBE" ? 1.5 : 2.0);
  let breakevenProtectTrigger = entryMode === "FAST_SURGE_PROBE" ? 0.2 : 0.5;

  if (
    entryPrice <= 0 || !Number.isFinite(entryPrice) ||
    currentPx <= 0 || !Number.isFinite(currentPx) ||
    stopPrice <= 0 || !Number.isFinite(stopPrice) ||
    tp2Price <= 0 || !Number.isFinite(tp2Price) ||
    trailingGapPct <= 0 || !Number.isFinite(trailingGapPct)
  ) {
    console.info(JSON.stringify({
      tag: "SURGE_EXIT_POLICY_INVALID_PROOF",
      ts: new Date().toISOString(),
      entryPrice,
      currentPx,
      stopPrice,
      tp2Price,
      trailingGapPct,
      reason: "invalid_prices_or_gap_detected"
    }));
    return { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive: false, authoritySource: "surge-v2" };
  }

  // Update Trailing State
  if (maxPnlPct >= trailingStartPct && (tp1Done || tp2Done)) {
    runnerTrailActive = true;
  }

  // 1. Hard Stop Loss
  if (stopPrice > 0 && currentPx <= stopPrice) {
    return { action: "sell", reason: "SURGE_STOP_LOSS", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 2. Catastrophic Reversal
  // Example: pnlPct <= -2% and momentum broken (rise3mPct <= 0)
  if (pnlPct <= -2.0 && (rise3mPct !== undefined ? rise3mPct <= 0 : true)) {
    return { action: "sell", reason: "SURGE_REVERSAL_CUT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 3. TP1 Partial
  if (!tp1Done && pnlPct >= tp1Target) {
    return { action: "sell", reason: "SURGE_TP1_PARTIAL", ratio: tp1Ratio, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 4. TP2 Partial
  if (tp1Done && !tp2Done && currentPx >= tp2Price) {
    return { action: "sell", reason: "SURGE_TP2_PARTIAL", ratio: tp2Ratio, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 5. Runner Trailing Exit
  if (runnerTrailActive) {
    const drawdownFromHighPct = ((highestPriceAfterEntry - currentPx) / highestPriceAfterEntry) * 100;
    if (drawdownFromHighPct >= trailingGapPct) {
      return { action: "sell", reason: "SURGE_RUNNER_TRAILING_EXIT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
    }
  }

  // 6. Breakeven Protect
  if (maxPnlPct >= trailingStartPct && pnlPct <= breakevenProtectTrigger) {
    return { action: "sell", reason: "SURGE_BREAKEVEN_PROTECT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 7. Timeout Exit
  if (holdMinutes >= 30 && pnlPct < 1.0 && !tp1Done) {
    return { action: "sell", reason: "SURGE_TIMEOUT_EXIT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  return { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive, authoritySource: "surge-v2" };
}

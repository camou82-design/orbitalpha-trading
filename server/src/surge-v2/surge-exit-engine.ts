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
  const entryPrice = pos.entry_price;
  const pnlPct = ((currentPx - entryPrice) / entryPrice) * 100;
  const maxPnlPct = pos.max_pnl_pct || 0;
  const entryTs = new Date(pos.entry_ts).getTime();
  const holdMinutes = (Date.now() - entryTs) / 60000;
  const partialTpDone = pos.partial_tp_done || false;
  let runnerTrailActive = pos.runner_trail_active || false;
  const marketState = String(pos.market_state ?? pos.market_state_at_entry ?? pos.market_state_at_exit ?? "");
  const btcTier = String(pos.btc_tier ?? pos.btc_tier_at_entry ?? pos.btc_tier_at_exit ?? "");
  const volatilityPct = Number(pos.volatility_pct ?? pos.volatility_pct_at_entry ?? pos.volatility_pct_at_exit ?? 0);

  // B. Runner Conversion Status Check (State update, not an exit)
  if (maxPnlPct >= 3.0) {
    runnerTrailActive = true;
  }

  // 1. Stop-loss policy (banded soft/hard)
  // - pnl <= -2.0%: hard stop
  // - -1.2%~-1.8%: soft/hard depending on market state & volatility
  const hardStopPct = -2.0;
  const bandSoftFloorPct = -1.2;
  const bandHardFloorPct = -1.8;
  const highVol = Number.isFinite(volatilityPct) && volatilityPct >= 3.2;
  const weakMarket = marketState === "risk_off" || btcTier === "weak";

  if (pnlPct <= hardStopPct) {
    return { action: "sell", reason: "stop_loss_reached_hard", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }
  if (pnlPct <= bandHardFloorPct) {
    return { action: "sell", reason: "stop_loss_reached_band_hard", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }
  if (pnlPct <= bandSoftFloorPct) {
    const hardInBand = weakMarket || highVol || holdMinutes < 1.0;
    return {
      action: "sell",
      reason: hardInBand ? "stop_loss_reached_band_hard_ctx" : "stop_loss_reached_band_soft",
      ratio: 1,
      runnerTrailActive,
      authoritySource: "surge-v2",
    };
  }

  // 3. Force Take Profit (>= +10%)
  if (pnlPct >= 10.0) {
    return { action: "sell", reason: "surge_force_take_profit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 4. Runner Trailing Exit
  if (runnerTrailActive && pnlPct <= maxPnlPct - 1.2) {
    return { action: "sell", reason: "surge_runner_trailing_exit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 5. Breakeven Protect
  if (maxPnlPct >= 1.2 && pnlPct <= 0.15) {
    return { action: "sell", reason: "surge_breakeven_protect", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 6. Early Fail (No follow through)
  if (holdMinutes >= 3 && maxPnlPct < 0.3 && pnlPct <= -0.3) {
    return { action: "sell", reason: "surge_early_fail_no_follow_through", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 7. Breakout Failed (conservative implementation)
  if (holdMinutes >= 3 && holdMinutes <= 7 && maxPnlPct < 0.5 && pnlPct <= 0) {
    return { action: "sell", reason: "surge_breakout_failed", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 8. Timeout (No profit)
  if (holdMinutes >= 15 && pnlPct < 0.8 && !partialTpDone) {
    return { action: "sell", reason: "surge_timeout_no_profit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 9. Residual Timeout Exit
  if (holdMinutes >= 45 && partialTpDone && pnlPct < 1.0) {
    return { action: "sell", reason: "surge_residual_timeout_exit", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 10. Partial Take Profit
  if (pnlPct >= 1.5 && !partialTpDone) {
    return { action: "sell", reason: "surge_partial_take_profit", ratio: 0.4, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 11. Hold
  return { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive, authoritySource: "surge-v2" };
}

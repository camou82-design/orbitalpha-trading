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
  
  // 1. 정책 식별 우선순위 수정
  const surgeEntryMode =
    pos.surge_entry_mode ??
    pos.entry_mode ??
    "";
  
  // 2. 복구 Surge 정책 판별 명시적 분리
  const isRecoveredSurgePolicy =
    pos.surge_entry_mode === "RECOVERED_SURGE_POLICY" ||
    (
      (pos.entry_origin === "auto_trade_recovered" ||
       pos.entry_origin === "auto_trade_recovered_all_holdings") &&
      pos.engine_bucket === "surge"
    );

  const stopPrice = (pos.surge_stop_price > 0 && Number.isFinite(pos.surge_stop_price))
    ? pos.surge_stop_price
    : (pos.entry_stop_price > 0 && Number.isFinite(pos.entry_stop_price) ? pos.entry_stop_price : 0);
  let tp2Price = pos.surge_take_profit_price;

  let tp1Target = 1.5;
  let tp1Ratio = surgeEntryMode === "FAST_SURGE_PROBE" ? 0.4 : 0.3;
  let tp2Ratio = 0.5;
  let trailingStartPct = pos.surge_trailing_start_pct || (surgeEntryMode === "FAST_SURGE_PROBE" ? 2.0 : 3.0);
  let trailingGapPct = pos.surge_trailing_gap_pct || (surgeEntryMode === "FAST_SURGE_PROBE" ? 1.5 : 2.0);
  let breakevenProtectTrigger = surgeEntryMode === "FAST_SURGE_PROBE" ? 0.2 : 0.5;

  // 3/4. 복구 Surge 정책 강제 적용 및 stale 상태값 덮어쓰기
  if (isRecoveredSurgePolicy) {
    tp1Target = 3.0;
    tp1Ratio = 0.25;
    trailingStartPct = 3.0;
    trailingGapPct = 2.2;
    tp2Price = entryPrice * 1.05;
  }

  if (
    entryPrice <= 0 || !Number.isFinite(entryPrice) ||
    currentPx <= 0 || !Number.isFinite(currentPx) ||
    stopPrice <= 0 || !Number.isFinite(stopPrice) ||
    tp2Price <= 0 || !Number.isFinite(tp2Price) ||
    trailingGapPct <= 0 || !Number.isFinite(trailingGapPct)
  ) {
    console.info(JSON.stringify({
      tag: "SURGE_EXIT_POLICY_INVALID_FORCE_EXIT_PROOF",
      ts: new Date().toISOString(),
      entryPrice,
      currentPx,
      stopPrice: stopPrice ?? null,
      tp2Price,
      trailingGapPct,
      reason: "invalid_prices_or_gap_detected"
    }));
    return { action: "sell", reason: "SURGE_EXIT_POLICY_INVALID_FORCE_EXIT", ratio: 1, runnerTrailActive: false, authoritySource: "surge-v2" };
  }

  // Update Trailing State
  if (maxPnlPct >= trailingStartPct && (tp1Done || tp2Done)) {
    runnerTrailActive = true;
  }

  let decision: SurgeExitDecision | null = null;

  // 1. Hard Stop Loss
  if (stopPrice > 0 && currentPx <= stopPrice) {
    decision = { action: "sell", reason: "SURGE_STOP_LOSS", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }
  // 2. Catastrophic Reversal
  else if (pnlPct <= -2.0 && (rise3mPct !== undefined ? rise3mPct <= 0 : true)) {
    decision = { action: "sell", reason: "SURGE_REVERSAL_CUT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }
  // 3. TP1 Partial
  else if (isRecoveredSurgePolicy && !pos.surge_tp1_done && pnlPct >= 3.0) {
    decision = { action: "sell", reason: "SURGE_TP1_PARTIAL", ratio: 0.25, runnerTrailActive, authoritySource: "surge-v2" };
  }
  else if (!isRecoveredSurgePolicy && !tp1Done && pnlPct >= tp1Target) {
    decision = { action: "sell", reason: "SURGE_TP1_PARTIAL", ratio: tp1Ratio, runnerTrailActive, authoritySource: "surge-v2" };
  }
  // 4. TP2 Partial
  else if (tp1Done && !tp2Done && currentPx >= tp2Price) {
    decision = { action: "sell", reason: "SURGE_TP2_PARTIAL", ratio: tp2Ratio, runnerTrailActive, authoritySource: "surge-v2" };
  }
  // 5. Runner Trailing Exit
  else if (runnerTrailActive) {
    const drawdownFromHighPct = ((highestPriceAfterEntry - currentPx) / highestPriceAfterEntry) * 100;
    if (drawdownFromHighPct >= trailingGapPct) {
      decision = { action: "sell", reason: "SURGE_RUNNER_TRAILING_EXIT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
    }
  }
  // 6. Breakeven Protect
  if (!decision && maxPnlPct >= trailingStartPct && pnlPct <= breakevenProtectTrigger) {
    decision = { action: "sell", reason: "SURGE_BREAKEVEN_PROTECT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }
  // 7. Timeout Exit
  if (!decision && holdMinutes >= 30 && pnlPct < 1.0 && !tp1Done) {
    decision = { action: "sell", reason: "SURGE_TIMEOUT_EXIT", ratio: 1, runnerTrailActive, authoritySource: "surge-v2" };
  }

  if (!decision) {
    decision = { action: "hold", reason: "surge_hold", ratio: 0, runnerTrailActive, authoritySource: "surge-v2" };
  }

  // 8. 진단 로그 추가 (SURGE_RECOVERED_POLICY_PROOF)
  if (isRecoveredSurgePolicy) {
    console.info(JSON.stringify({
      tag: "SURGE_RECOVERED_POLICY_PROOF",
      ts: new Date().toISOString(),
      market: pos.market ?? null,
      entry_mode: pos.entry_mode ?? null,
      surge_entry_mode: pos.surge_entry_mode ?? null,
      entry_origin: pos.entry_origin ?? null,
      engine_bucket: pos.engine_bucket ?? null,
      is_recovered_surge_policy: true,
      pnl_pct: Number(pnlPct.toFixed(4)),
      tp1_target: tp1Target,
      tp1_ratio: tp1Ratio,
      surge_tp1_done: tp1Done,
      decision: {
        action: decision.action,
        reason: decision.reason,
        ratio: decision.ratio
      }
    }));
  }

  return decision;
}

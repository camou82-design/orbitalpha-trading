import assert from "node:assert/strict";
import { evaluateSurgeExit } from "./surge-v2/surge-exit-engine.js";

function makeSurgePosition(overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    market: "KRW-TEST",
    entry_price: 1000,
    entry_ts: new Date(now - 10 * 60_000).toISOString(),
    strict_exit: true,
    surge_entry_mode: "FAST_SURGE_PROBE",
    surge_stop_price: 970, // 3% hard stop
    surge_take_profit_price: 1050, // 5% TP2
    surge_trailing_start_pct: 2.0,
    surge_trailing_gap_pct: 1.5,
    surge_tp1_done: false,
    surge_tp2_done: false,
    surge_runner_active: false,
    max_pnl_pct: 0,
    highest_price_after_entry: 1000,
    ...overrides,
  };
}

async function runTests() {
  console.log("=== [START] Surge Timeout Exit Fee-Churn Regression Tests ===");

  // 1. PLUME Real Case Reproduction (entry 18, decision 17.9, hold 35m, pnl -0.5556%, rise3m 0)
  console.log("1. Testing PLUME Reproduction (pnl -0.556%, 35m hold, rise3m <= 0)...");
  const plumePos = makeSurgePosition({
    market: "KRW-PLUME",
    entry_price: 18,
    entry_ts: new Date(Date.now() - 35 * 60_000).toISOString(), // 35m hold
    surge_stop_price: 17.1, // ~5% hard stop
    surge_take_profit_price: 19.0,
  });
  const plumeDecision = evaluateSurgeExit(plumePos, 17.9, 0);
  assert.equal(plumeDecision.action, "hold", "PLUME at -0.556% must HOLD at 35m");
  assert.equal(plumeDecision.reason, "surge_hold");
  console.log("  ✓ PLUME HOLD verified (NOT SURGE_TIMEOUT_EXIT).");

  // 2. 0G Real Case Reproduction (entry 270, decision 269, hold 38m, pnl -0.3704%, rise3m -0.1)
  console.log("2. Testing 0G Reproduction (pnl -0.370%, 38m hold, rise3m -0.1)...");
  const zeroGPos = makeSurgePosition({
    market: "KRW-0G",
    entry_price: 270,
    entry_ts: new Date(Date.now() - 38 * 60_000).toISOString(), // 38m hold
    surge_stop_price: 260,
    surge_take_profit_price: 285,
  });
  const zeroGDecision = evaluateSurgeExit(zeroGPos, 269, -0.1);
  assert.equal(zeroGDecision.action, "hold", "0G at -0.370% must HOLD at 38m");
  assert.equal(zeroGDecision.reason, "surge_hold");
  console.log("  ✓ 0G HOLD verified (NOT SURGE_TIMEOUT_EXIT).");

  // 3. 30m Weak Loss (pnl <= -0.8% AND rise3m <= 0)
  console.log("3. Testing 30m Weak Loss (pnl -0.9%, rise3m -0.2)...");
  const weakLossPos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 35 * 60_000).toISOString(),
  });
  const weakLossDecision = evaluateSurgeExit(weakLossPos, 991, -0.2); // pnl = -0.9%
  assert.equal(weakLossDecision.action, "sell");
  assert.equal(weakLossDecision.reason, "SURGE_TIMEOUT_WEAK_EXIT");
  assert.equal(weakLossDecision.ratio, 1);
  console.log("  ✓ 30m Weak Loss EXIT verified.");

  // 4. 30m -0.9% but rise3m > 0 (Rebounding momentum)
  console.log("4. Testing 30m -0.9% with positive rise3m (+0.5)...");
  const reboundPos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 35 * 60_000).toISOString(),
  });
  const reboundDecision = evaluateSurgeExit(reboundPos, 991, 0.5); // pnl = -0.9%, rise3m = +0.5%
  assert.equal(reboundDecision.action, "hold");
  assert.equal(reboundDecision.reason, "surge_hold");
  console.log("  ✓ 30m with positive momentum HOLD verified.");

  // 5. 30m rise3m undefined (pnl -0.9%)
  console.log("5. Testing 30m with undefined rise3m...");
  const undefRisePos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 35 * 60_000).toISOString(),
  });
  const undefRiseDecision = evaluateSurgeExit(undefRisePos, 991, undefined);
  assert.equal(undefRiseDecision.action, "hold", "Undefined rise3m must NOT trigger 30m timeout exit");
  assert.equal(undefRiseDecision.reason, "surge_hold");
  console.log("  ✓ 30m undefined rise3m HOLD verified.");

  // 6. 60m Extended Timeout: pnl -0.3% (< 0.35%)
  console.log("6. Testing 60m Extended Timeout (pnl -0.3%)...");
  const extNegPos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 65 * 60_000).toISOString(),
  });
  const extNegDecision = evaluateSurgeExit(extNegPos, 997, 0.1); // pnl = -0.3%
  assert.equal(extNegDecision.action, "sell");
  assert.equal(extNegDecision.reason, "SURGE_EXTENDED_TIMEOUT_EXIT");
  assert.equal(extNegDecision.ratio, 1);
  console.log("  ✓ 60m pnl -0.3% EXTENDED_TIMEOUT_EXIT verified.");

  // 7. 60m Extended Timeout: pnl +0.2% (< 0.35% fee-aware break-even)
  console.log("7. Testing 60m Extended Timeout (pnl +0.2%)...");
  const extFeePos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 65 * 60_000).toISOString(),
  });
  const extFeeDecision = evaluateSurgeExit(extFeePos, 1002, 0.2); // pnl = +0.2% < 0.35%
  assert.equal(extFeeDecision.action, "sell");
  assert.equal(extFeeDecision.reason, "SURGE_EXTENDED_TIMEOUT_EXIT");
  assert.equal(extFeeDecision.ratio, 1);
  console.log("  ✓ 60m pnl +0.2% EXTENDED_TIMEOUT_EXIT verified.");

  // 8. 60m Extended Timeout: pnl +0.5%, rise3m negative (-0.2)
  console.log("8. Testing 60m Extended Timeout (pnl +0.5%, rise3m <= 0)...");
  const extWeakPos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 65 * 60_000).toISOString(),
  });
  const extWeakDecision = evaluateSurgeExit(extWeakPos, 1005, -0.2); // pnl = +0.5% < 1.0% AND rise3m <= 0
  assert.equal(extWeakDecision.action, "sell");
  assert.equal(extWeakDecision.reason, "SURGE_EXTENDED_TIMEOUT_EXIT");
  assert.equal(extWeakDecision.ratio, 1);
  console.log("  ✓ 60m pnl +0.5% with negative momentum EXTENDED_TIMEOUT_EXIT verified.");

  // 9. 60m Extended Timeout: pnl +0.5%, rise3m positive (+0.4)
  console.log("9. Testing 60m Extended Timeout (pnl +0.5%, rise3m > 0)...");
  const extHoldPos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 65 * 60_000).toISOString(),
  });
  const extHoldDecision = evaluateSurgeExit(extHoldPos, 1005, 0.4); // pnl = +0.5% >= 0.35% AND rise3m > 0
  assert.equal(extHoldDecision.action, "hold");
  assert.equal(extHoldDecision.reason, "surge_hold");
  console.log("  ✓ 60m pnl +0.5% with positive momentum HOLD verified.");

  // 10. 60m Extended Timeout: pnl +1.1% (>= 1.0%)
  console.log("10. Testing 60m Extended Timeout (pnl +1.1%, rise3m 0)...");
  const extProfPos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 65 * 60_000).toISOString(),
  });
  const extProfDecision = evaluateSurgeExit(extProfPos, 1011, 0); // pnl = +1.1% >= 1.0%
  assert.equal(extProfDecision.action, "hold");
  assert.equal(extProfDecision.reason, "surge_hold");
  console.log("  ✓ 60m pnl +1.1% HOLD verified.");

  // 11. Hard Stop Loss Priority Check
  console.log("11. Testing Hard Stop Loss Priority...");
  const hardStopPos = makeSurgePosition({
    entry_price: 1000,
    surge_stop_price: 970,
    entry_ts: new Date(Date.now() - 35 * 60_000).toISOString(),
  });
  const hardStopDecision = evaluateSurgeExit(hardStopPos, 965, 0.5); // at 965 <= 970
  assert.equal(hardStopDecision.action, "sell");
  assert.equal(hardStopDecision.reason, "SURGE_STOP_LOSS");
  console.log("  ✓ Hard Stop priority over timeout verified.");

  // 12. Catastrophic Reversal Cut Priority Check
  console.log("12. Testing Catastrophic Reversal Cut Priority...");
  const reversalPos = makeSurgePosition({
    entry_price: 1000,
    surge_stop_price: 950,
    entry_ts: new Date(Date.now() - 35 * 60_000).toISOString(),
  });
  const reversalDecision = evaluateSurgeExit(reversalPos, 978, -0.1); // pnl = -2.2% <= -2.0%
  assert.equal(reversalDecision.action, "sell");
  assert.equal(reversalDecision.reason, "SURGE_REVERSAL_CUT");
  console.log("  ✓ Reversal Cut priority over timeout verified.");

  // 13. TP1 Partial Priority Check
  console.log("13. Testing TP1 Partial Priority...");
  const tp1Pos = makeSurgePosition({
    entry_price: 1000,
    entry_ts: new Date(Date.now() - 35 * 60_000).toISOString(),
  });
  const tp1Decision = evaluateSurgeExit(tp1Pos, 1016, 0.5); // pnl = +1.6% >= 1.5% TP1
  assert.equal(tp1Decision.action, "sell");
  assert.equal(tp1Decision.reason, "SURGE_TP1_PARTIAL");
  assert.equal(tp1Decision.ratio, 0.4); // FAST_SURGE_PROBE ratio 0.4
  console.log("  ✓ TP1 priority verified.");

  console.log("=== [PASS] All Surge Timeout Exit Fee-Churn Tests PASSED ===");
}

runTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});

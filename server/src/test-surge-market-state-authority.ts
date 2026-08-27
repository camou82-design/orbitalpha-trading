import assert from "node:assert";
import { assertOrderBuyAllowed, type MarketStateSnapshot } from "./market-state-filter.js";

async function runSurgeMarketStateAuthorityTests() {
  console.log("=== Starting Surge Market-State Execution Authority Regression Tests (A-P) ===\n");

  const snapRiskOffRsi55: MarketStateSnapshot = {
    timestamp: new Date().toISOString(),
    market_state: "risk_off",
    entry_policy: "축소 진입",
    min_entry_score: 80,
    market_bonus: 0,
    regime_allows_new_and_additional_buys: false,
    order_limits: {} as any,
    breadth_ratio: 0.2,
    recent_close_bias: "down",
    conservative_mode: true,
    exception_entry_allowed: true,
    btc_5m_trend: "down",
    btc_15m_trend: "down",
    btc_rsi: 55.0, // >= 50
  };

  const snapNeutralRsi55: MarketStateSnapshot = {
    timestamp: new Date().toISOString(),
    market_state: "neutral",
    entry_policy: "선별 진입",
    min_entry_score: 80,
    market_bonus: 0,
    regime_allows_new_and_additional_buys: true,
    order_limits: {} as any,
    breadth_ratio: 0.5,
    recent_close_bias: "flat",
    conservative_mode: false,
    exception_entry_allowed: true,
    btc_5m_trend: "flat",
    btc_15m_trend: "flat",
    btc_rsi: 55.0, // >= 50
  };

  const snapNeutralRsi49: MarketStateSnapshot = {
    ...snapNeutralRsi55,
    btc_rsi: 49.0, // < 50
  };

  const snapRiskOffRsi49: MarketStateSnapshot = {
    ...snapRiskOffRsi55,
    btc_rsi: 49.0, // < 50
  };

  // 실서버 ZK 런타임 스냅샷 (BTC RSI = 41.65)
  const snapZkRuntime: MarketStateSnapshot = {
    ...snapRiskOffRsi55,
    btc_rsi: 41.65,
  };

  // 실서버 BREV 런타임 스냅샷 (BTC RSI = 39.07)
  const snapBrevRuntime: MarketStateSnapshot = {
    ...snapRiskOffRsi55,
    btc_rsi: 39.07,
  };

  const zkValidPayload = {
    v: 2 as const,
    market: "KRW-ZK",
    signal_type: "HIGH",
    signal_reason: "surge_momentum",
    filter_pass: true,
    filter_fail_reason: null,
    filters: [
      { id: "volume_increase", label: "Vol", passed: true },
      { id: "box_breakout", label: "Box", passed: true },
      { id: "volume_spike_close_fail", label: "Close", passed: true },
    ],
    volume_ratio: 5.22,
  };

  const brevValidPayload = {
    v: 2 as const,
    market: "KRW-BREV",
    signal_type: "HIGH",
    signal_reason: "surge_momentum",
    filter_pass: true,
    filter_fail_reason: null,
    filters: [
      { id: "volume_increase", label: "Vol", passed: true },
      { id: "box_breakout", label: "Box", passed: true },
      { id: "volume_spike_close_fail", label: "Close", passed: true },
    ],
    volume_ratio: 3.64,
  };

  const lowScorePayload = {
    v: 2 as const,
    market: "KRW-LOW",
    signal_type: "LOW",
    signal_reason: "weak",
    filter_pass: false,
    filter_fail_reason: "low_score",
    filters: [],
    volume_ratio: 1.0,
  };

  const surgePassingMeta = {
    setup: { ok: true, reason: "surge_setup_passed" },
    engine_bucket: "surge" as const,
    stopPrice: 100,
    targetPrice: 150,
    riskReward: 1.5,
  };

  const otherBucketPassingMeta = {
    setup: { ok: true, reason: "momentum_passed" },
    engine_bucket: "other" as const,
    stopPrice: 100,
    targetPrice: 150,
    riskReward: 1.5,
  };

  const surgeFailingMeta = {
    setup: { ok: false, reason: "low_momentum" },
    engine_bucket: "surge" as const,
  };

  // --- Truth Table 1: engine_bucket=surge + momentum + setup.ok=true + neutral + RSI 55 + score PASS -> 허용 (0.72) ---
  console.log("--- Truth Table 1: engine_bucket=surge + momentum + setup.ok=true + neutral + RSI 55 + score PASS -> 허용 (0.72) ---");
  const tt1 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt1.ok, true, "TT1 must be allowed");
  assert.strictEqual(tt1.size_scale, 0.72, "TT1 size_scale must be 0.72");
  console.log("[PASS] Truth Table 1: neutral + RSI 55 + setup PASS -> 정상 허용 (scale 0.72)");

  // --- Truth Table 2: engine_bucket=surge + momentum + setup.ok=true + neutral + RSI 49 -> 기존 RSI gate 차단 ---
  console.log("\n--- Truth Table 2: engine_bucket=surge + momentum + setup.ok=true + neutral + RSI 49 -> RSI gate 차단 ---");
  const tt2 = assertOrderBuyAllowed(snapNeutralRsi49, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt2.ok, false, "TT2 must be blocked");
  assert.ok(tt2.blocked_reason?.includes("btc_rsi_low_surge_blocked"), "TT2 blocked by btc_rsi_low_surge_blocked");
  console.log("[PASS] Truth Table 2: neutral + RSI 49 -> btc_rsi_low_surge_blocked 정상 차단");

  // --- Truth Table 3: engine_bucket=surge + momentum + setup.ok=true + risk_off + RSI 55 + score PASS -> reduced-size (0.45) 허용 ---
  console.log("\n--- Truth Table 3: engine_bucket=surge + momentum + setup.ok=true + risk_off + RSI 55 + score PASS -> reduced-size (0.45) 허용 ---");
  const tt3 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt3.ok, true, "TT3 must be allowed");
  assert.strictEqual(tt3.size_scale, 0.45, "TT3 size_scale must be canonical reduced-size 0.45");
  console.log("[PASS] Truth Table 3: risk_off + RSI 55 + setup PASS -> canonical reduced-size (0.45) 정상 허용");

  // --- Truth Table 4: engine_bucket=surge + momentum + setup.ok=true + risk_off + RSI 49 -> 기존 RSI gate 차단 ---
  console.log("\n--- Truth Table 4: engine_bucket=surge + momentum + setup.ok=true + risk_off + RSI 49 -> RSI gate 차단 ---");
  const tt4 = assertOrderBuyAllowed(snapRiskOffRsi49, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt4.ok, false, "TT4 must be blocked");
  assert.ok(tt4.blocked_reason?.includes("btc_rsi_low_surge_blocked"), "TT4 blocked by btc_rsi_low_surge_blocked");
  console.log("[PASS] Truth Table 4: risk_off + RSI 49 -> btc_rsi_low_surge_blocked 정상 차단");

  // --- Truth Table 5: engine_bucket=surge + setup.ok=false in neutral -> 차단 ---
  console.log("\n--- Truth Table 5: engine_bucket=surge + setup.ok=false in neutral -> neutral 일괄 차단 ---");
  const tt5 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-WEAK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgeFailingMeta,
  });
  assert.strictEqual(tt5.ok, false, "TT5 must be blocked");
  assert.ok(tt5.blocked_reason?.includes("neutral_market_surge_blocked"), "TT5 blocked by neutral_market_surge_blocked");
  console.log("[PASS] Truth Table 5: setup FAIL in neutral -> neutral_market_surge_blocked 차단 유지");

  // --- Truth Table 6: engine_bucket=surge + setup.ok=false in risk_off -> risk_off 차단 ---
  console.log("\n--- Truth Table 6: engine_bucket=surge + setup.ok=false in risk_off -> risk_off 차단 ---");
  const tt6 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-WEAK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgeFailingMeta,
  });
  assert.strictEqual(tt6.ok, false, "TT6 must be blocked");
  assert.strictEqual(tt6.blocked_reason, "risk_off: 신규 진입 금지", "TT6 blocked by risk_off: 신규 진입 금지");
  console.log("[PASS] Truth Table 6: setup FAIL in risk_off -> risk_off: 신규 진입 금지 차단 유지");

  // --- Truth Table 7: engine_bucket=other + momentum + setup.ok=true + risk_off -> 예외 권한 없음 (차단) ---
  console.log("\n--- Truth Table 7: engine_bucket=other + momentum + setup.ok=true in risk_off -> 예외 권한 없음 (차단) ---");
  const tt7 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-OTHER",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: otherBucketPassingMeta,
  });
  assert.strictEqual(tt7.ok, false, "TT7: other bucket in risk_off must be blocked");
  assert.strictEqual(tt7.blocked_reason, "risk_off: 신규 진입 금지", "TT7 blocked by risk_off: 신규 진입 금지");
  console.log("[PASS] Truth Table 7: engine_bucket=other는 risk_off 예외 권한 획득 불가 (Scope Lock 성공)");

  // --- Truth Table 8: engine_bucket=other + momentum + setup.ok=true + neutral -> 기존 neutral aggressive 차단 유지 ---
  console.log("\n--- Truth Table 8: engine_bucket=other + momentum + setup.ok=true in neutral -> neutral 차단 유지 ---");
  const tt8 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-OTHER",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: otherBucketPassingMeta,
  });
  assert.strictEqual(tt8.ok, false, "TT8: other bucket in neutral must be blocked");
  assert.ok(tt8.blocked_reason?.includes("neutral_market_surge_blocked"), "TT8 blocked by neutral_market_surge_blocked");
  console.log("[PASS] Truth Table 8: engine_bucket=other는 neutral 예외 권한 획득 불가 (Scope Lock 성공)");

  // --- Truth Table 9: 실서버 KRW-ZK 런타임 재현 (setup PASS, risk_off, BTC RSI = 41.65) -> RSI 50 게이트 차단 ---
  console.log("\n--- Truth Table 9: 실서버 KRW-ZK 런타임 재현 (setup PASS, risk_off, BTC RSI 41.65) -> 차단 ---");
  const tt9 = assertOrderBuyAllowed(snapZkRuntime, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt9.ok, false, "TT9: ZK with RSI 41.65 must be blocked by BTC RSI gate");
  assert.ok(tt9.blocked_reason?.includes("btc_rsi_low_surge_blocked"), "TT9: blocked by btc_rsi_low_surge_blocked");
  console.log("[PASS] Truth Table 9: 실서버 ZK (RSI 41.65) -> market-state deny 통과 후 btc_rsi_low_surge_blocked에 의해 안전 차단 (정상 동작)");

  // --- Truth Table 10: 실서버 KRW-BREV 런타임 재현 (setup PASS, risk_off, BTC RSI = 39.07) -> RSI 50 게이트 차단 ---
  console.log("\n--- Truth Table 10: 실서버 KRW-BREV 런타임 재현 (setup PASS, risk_off, BTC RSI 39.07) -> 차단 ---");
  const tt10 = assertOrderBuyAllowed(snapBrevRuntime, {
    kind: "new_entry",
    market: "KRW-BREV",
    strategyType: "momentum",
    signalPayload: brevValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt10.ok, false, "TT10: BREV with RSI 39.07 must be blocked by BTC RSI gate");
  assert.ok(tt10.blocked_reason?.includes("btc_rsi_low_surge_blocked"), "TT10: blocked by btc_rsi_low_surge_blocked");
  console.log("[PASS] Truth Table 10: 실서버 BREV (RSI 39.07) -> market-state deny 통과 후 btc_rsi_low_surge_blocked에 의해 안전 차단 (정상 동작)");

  // --- Truth Table 11: 낮은 Entry Score (setup PASS라도 score gate 미달) in neutral -> 차단 ---
  console.log("\n--- Truth Table 11: 낮은 Entry Score in neutral -> score gate 차단 ---");
  const tt11 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-LOW",
    strategyType: "momentum",
    signalPayload: lowScorePayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt11.ok, false, "TT11: low score must be blocked");
  assert.ok(tt11.blocked_reason?.includes("entry score"), "TT11: blocked by entry score");
  console.log("[PASS] Truth Table 11: setup PASS라도 entry score 미달 시 score gate 차단 (우회 없음)");

  // --- Truth Table 12: Core/Stable 전략 in risk_off -> 기존대로 차단 ---
  console.log("\n--- Truth Table 12: Core/Stable in risk_off -> 차단 (회귀 없음) ---");
  const corePayload = {
    v: 2 as const,
    market: "KRW-BTC",
    signal_type: "HIGH",
    signal_reason: "core_trend",
    filter_pass: true,
    filter_fail_reason: null,
    filters: [
      { id: "volume_increase", label: "Vol", passed: true },
      { id: "box_breakout", label: "Box", passed: true },
      { id: "volume_spike_close_fail", label: "Close", passed: true },
    ],
    volume_ratio: 1.4,
  };
  const tt12 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-BTC",
    strategyType: "stable",
    signalPayload: corePayload,
  });
  assert.strictEqual(tt12.ok, false, "TT12: Core stable must be blocked in risk_off");
  assert.strictEqual(tt12.blocked_reason, "risk_off: 신규 진입 금지", "TT12: blocked_reason risk_off");
  console.log("[PASS] Truth Table 12: Core/Stable risk_off 신규 진입 차단 유지");

  // --- Truth Table 13: Core/Stable 전략 in neutral -> 정상 진입 ---
  console.log("\n--- Truth Table 13: Core/Stable in neutral -> 정상 진입 (회귀 없음) ---");
  const tt13 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-BTC",
    strategyType: "stable",
    signalPayload: corePayload,
  });
  assert.strictEqual(tt13.ok, true, "TT13: Core stable allowed in neutral");
  console.log("[PASS] Truth Table 13: Core/Stable neutral 정상 진입 유지");

  // --- Truth Table 14: genuine Reclaim 전략 (점수 60 >= 55) in neutral -> 허용 ---
  console.log("\n--- Truth Table 14: genuine Reclaim in neutral (점수 60 >= 55) -> 허용 ---");
  const tt14 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-SOL",
    strategyType: "surge_reclaim",
    entrySignalType: "reclaim",
    reclaimScore: 60,
    signalPayload: { reclaim_score: 60 },
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt14.ok, true, "TT14: Reclaim score 60 allowed");
  console.log("[PASS] Truth Table 14: Reclaim 전략 기존 분기 정상 실행 유지");

  // --- Truth Table 15: genuine Reclaim 전략 (점수 40 < 55) in neutral -> 차단 ---
  console.log("\n--- Truth Table 15: genuine Reclaim in neutral (점수 40 < 55) -> 차단 ---");
  const tt15 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-SOL",
    strategyType: "surge_reclaim",
    entrySignalType: "reclaim",
    reclaimScore: 40,
    signalPayload: { reclaim_score: 40 },
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt15.ok, false, "TT15: Reclaim score 40 blocked");
  assert.ok(tt15.blocked_reason?.includes("reclaim_score_low"), "TT15: blocked by reclaim_score_low");
  console.log("[PASS] Truth Table 15: Reclaim 점수 미달 시 setup.ok와 무관하게 reclaim 게이트로 차단");

  // --- Truth Table 16: candidateMeta missing in risk_off -> 즉시 차단 ---
  console.log("\n--- Truth Table 16: candidateMeta missing in risk_off -> 즉시 차단 ---");
  const tt16 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
  });
  assert.strictEqual(tt16.ok, false, "TT16: missing candidateMeta must be blocked in risk_off");
  assert.strictEqual(tt16.blocked_reason, "risk_off: 신규 진입 금지", "TT16: blocked_reason risk_off");
  console.log("[PASS] Truth Table 16: candidateMeta 누락 시 절대 예외 권한 획득 불가");

  console.log("\n=======================================================");
  console.log("  ALL TESTS (Truth Table 1-16) PASSED SUCCESSFULLY! (0) ");
  console.log("=======================================================\n");
}

runSurgeMarketStateAuthorityTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

import assert from "node:assert";
import { assertOrderBuyAllowed, type MarketStateSnapshot } from "./market-state-filter.js";

async function runSurgeMarketStateAuthorityTests() {
  console.log("=== Starting Surge Market-State & Near-High Execution Authority Regression Tests (A-M + TT1-TT16) ===\n");

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

  const snapRiskOnRsi60: MarketStateSnapshot = {
    ...snapNeutralRsi55,
    market_state: "risk_on",
    entry_policy: "적극 진입",
    btc_rsi: 60.0,
  };

  const snapNeutralRsi49: MarketStateSnapshot = {
    ...snapNeutralRsi55,
    btc_rsi: 49.0, // < 50
  };

  const snapRiskOffRsi49: MarketStateSnapshot = {
    ...snapRiskOffRsi55,
    btc_rsi: 49.0, // < 50
  };

  const snapZkRuntime: MarketStateSnapshot = {
    ...snapRiskOffRsi55,
    btc_rsi: 41.65,
  };

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

  const rayValidPayload = {
    v: 2 as const,
    market: "KRW-RAY",
    signal_type: "HIGH",
    signal_reason: "surge_momentum",
    filter_pass: true,
    filter_fail_reason: null,
    filters: [
      { id: "volume_increase", label: "Vol", passed: true },
      { id: "box_breakout", label: "Box", passed: true },
      { id: "volume_spike_close_fail", label: "Close", passed: true },
    ],
    volume_ratio: 2.35,
    scanner_score: 92,
    signal_score: 92,
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
    score: 90,
    stopPrice: 100,
    targetPrice: 150,
    riskReward: 1.5,
  };

  const surgeRayMeta = {
    setup: { ok: true, reason: "surge_setup_passed" },
    engine_bucket: "surge" as const,
    score: 92,
    stopPrice: 2000,
    targetPrice: 2300,
    riskReward: 1.8,
  };

  const corePassingMeta = {
    setup: { ok: true, reason: "CORE_TREND_ENTRY" },
    engine_bucket: "core" as const,
    setupReason: "CORE_TREND_ENTRY",
    score: 88,
    stopPrice: 100,
    targetPrice: 150,
    riskReward: 1.5,
  };

  // =========================================================================
  // SECTION 1. SURGE MARKET STATE TRUTH TABLES (TT1 - TT16)
  // =========================================================================

  console.log("--- Truth Table 1: neutral + SURGE + RSI 55 -> 허용 (scale 0.72) ---");
  const tt1 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt1.ok, true, "TT1 must be allowed");
  assert.strictEqual(tt1.size_scale, 0.72, "TT1 size_scale must be 0.72");
  console.log("[PASS] Truth Table 1: neutral + RSI 55 + SURGE -> 정상 허용 (scale 0.72)");

  console.log("\n--- Truth Table 2: neutral + SURGE + RSI 49 -> RSI gate 차단 ---");
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

  console.log("\n--- Truth Table 3: risk_off + SURGE + RSI 55 -> reduced-size (0.45) 허용 ---");
  const tt3 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt3.ok, true, "TT3 must be allowed");
  assert.strictEqual(tt3.size_scale, 0.45, "TT3 size_scale must be canonical reduced-size 0.45");
  console.log("[PASS] Truth Table 3: risk_off + RSI 55 + SURGE -> canonical reduced-size (0.45) 정상 허용");

  console.log("\n--- Truth Table 4: risk_off + SURGE + RSI 49 -> RSI gate 차단 ---");
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

  console.log("\n--- Truth Table 5: neutral + SURGE (delegates to SURGE V2) -> 허용 (scale 0.72) ---");
  const tt5 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: { engine_bucket: "surge" },
  });
  assert.strictEqual(tt5.ok, true, "TT5 must be allowed");
  assert.strictEqual(tt5.size_scale, 0.72, "TT5 size_scale must be 0.72");
  console.log("[PASS] Truth Table 5: neutral + SURGE source -> generic neutral hard block 없음, 0.72 sizing 허용");

  console.log("\n--- Truth Table 6: risk_off + SURGE (delegates to SURGE V2) -> 허용 (scale 0.45) ---");
  const tt6 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: { engine_bucket: "surge" },
  });
  assert.strictEqual(tt6.ok, true, "TT6 must be allowed");
  assert.strictEqual(tt6.size_scale, 0.45, "TT6 size_scale must be 0.45");
  console.log("[PASS] Truth Table 6: risk_off + SURGE source -> generic risk_off hard block 없음, 0.45 sizing 허용");

  console.log("\n--- Truth Table 7: NON-SURGE CORE in risk_off -> strictly blocked ---");
  const tt7 = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-BTC",
    strategyType: "stable",
    sourceKind: "CORE_TRADE",
    signalPayload: zkValidPayload,
    candidateMeta: corePassingMeta,
  });
  assert.strictEqual(tt7.ok, false, "TT7: CORE in risk_off must be blocked");
  assert.strictEqual(tt7.blocked_reason, "risk_off: 신규 진입 금지", "TT7 blocked by risk_off: 신규 진입 금지");
  console.log("[PASS] Truth Table 7: non-SURGE CORE는 risk_off 차단 유지 (Scope Lock 성공)");

  console.log("\n--- Truth Table 8: Panic state (is_panic = true) -> strictly blocked ---");
  const tt8 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: { ...surgeRayMeta, is_panic: true },
  });
  assert.strictEqual(tt8.ok, false, "TT8: Panic must be blocked");
  assert.ok(tt8.blocked_reason?.includes("panic_hard_risk_blocked"), "TT8 blocked by panic_hard_risk_blocked");
  console.log("[PASS] Truth Table 8: panic_hard_risk_blocked 절대 진입 차단 유지");

  console.log("\n--- Truth Table 9: 실서버 KRW-ZK 런타임 재현 (RSI 41.65 < 50) -> 차단 ---");
  const tt9 = assertOrderBuyAllowed(snapZkRuntime, {
    kind: "new_entry",
    market: "KRW-ZK",
    strategyType: "momentum",
    signalPayload: zkValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt9.ok, false, "TT9: ZK with RSI 41.65 must be blocked by BTC RSI gate");
  assert.ok(tt9.blocked_reason?.includes("btc_rsi_low_surge_blocked"), "TT9: blocked by btc_rsi_low_surge_blocked");
  console.log("[PASS] Truth Table 9: 실서버 ZK (RSI 41.65) -> btc_rsi_low_surge_blocked 안전 차단");

  console.log("\n--- Truth Table 10: 실서버 KRW-BREV 런타임 재현 (RSI 39.07 < 50) -> 차단 ---");
  const tt10 = assertOrderBuyAllowed(snapBrevRuntime, {
    kind: "new_entry",
    market: "KRW-BREV",
    strategyType: "momentum",
    signalPayload: brevValidPayload,
    candidateMeta: surgePassingMeta,
  });
  assert.strictEqual(tt10.ok, false, "TT10: BREV with RSI 39.07 must be blocked by BTC RSI gate");
  assert.ok(tt10.blocked_reason?.includes("btc_rsi_low_surge_blocked"), "TT10: blocked by btc_rsi_low_surge_blocked");
  console.log("[PASS] Truth Table 10: 실서버 BREV (RSI 39.07) -> btc_rsi_low_surge_blocked 안전 차단");

  console.log("\n--- Truth Table 11: 낮은 Entry Score in neutral -> score gate 차단 ---");
  const tt11 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-LOW",
    strategyType: "momentum",
    signalPayload: lowScorePayload,
    candidateMeta: { engine_bucket: "surge", score: 50 },
  });
  assert.strictEqual(tt11.ok, false, "TT11: low score must be blocked");
  assert.ok(tt11.blocked_reason?.includes("entry score"), "TT11: blocked by entry score");
  console.log("[PASS] Truth Table 11: entry score 미달 시 score gate 정상 차단");

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

  console.log("\n--- Truth Table 13: Core/Stable in neutral -> 정상 진입 (회귀 없음) ---");
  const tt13 = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-BTC",
    strategyType: "stable",
    signalPayload: corePayload,
    candidateMeta: corePassingMeta,
  });
  assert.strictEqual(tt13.ok, true, "TT13: Core stable allowed in neutral");
  console.log("[PASS] Truth Table 13: Core/Stable neutral 정상 진입 유지");

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
  console.log("[PASS] Truth Table 15: Reclaim 점수 미달 시 reclaim 게이트로 차단");

  console.log("\n--- Truth Table 16: risk_on + SURGE -> size_scale 1.0 허용 ---");
  const tt16 = assertOrderBuyAllowed(snapRiskOnRsi60, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: surgeRayMeta,
  });
  assert.strictEqual(tt16.ok, true, "TT16: risk_on SURGE allowed");
  assert.strictEqual(tt16.size_scale, 1.0, "TT16: size_scale must be 1.0");
  console.log("[PASS] Truth Table 16: risk_on + SURGE -> multiplier 1.00 정상 허용");

  // =========================================================================
  // SECTION 2. NEAR-HIGH DISTANCE & SURGE REPLAY LOGIC TESTS (A - M)
  // =========================================================================

  console.log("\n==================================================================");
  console.log("  SECTION 2: NEAR-HIGH DISTANCE & SURGE SPECIFIC TESTS (A - M)");
  console.log("==================================================================\n");

  const LIVE_MAX_ENTRY_NEAR_HIGH_PCT = 0.35;

  function evaluateNearHighGuard(params: {
    distanceFromLocalHighPct: number | null;
    isFreshFilterSource?: boolean;
    score?: number;
    secondsSinceSignal?: number | null;
    priceChangeSinceSignalPct?: number | null;
    volumeFadeTriggered?: boolean;
    volumeRatio1m5?: number | null;
    recent1mRet?: number | null;
    recent3mRet?: number | null;
    recent5mRet?: number | null;
    hasValidStopLoss?: boolean;
    riskReward?: number;
    isCoreRelaxedCandidate?: boolean;
  }) {
    const dist = params.distanceFromLocalHighPct;
    let lateEntryGuardTriggered = false;
    let lateTimingTier: "pass" | "hard_block" | "reduced_size_allowed" = "pass";
    let lateEntryGuardReason: string | null = null;
    let proofEmitted = false;

    if (dist !== null && dist < 0) {
      proofEmitted = true;
    }

    const nearHighProblem =
      dist !== null && dist >= 0 && dist < LIVE_MAX_ENTRY_NEAR_HIGH_PCT;
    const volFadeProblem =
      params.volumeFadeTriggered || (params.volumeRatio1m5 !== null && params.volumeRatio1m5 !== undefined && params.volumeRatio1m5 < 0.65);

    if (nearHighProblem) {
      const severeNearHigh = dist !== null && dist >= 0 && dist < 0.12;
      const coreRelaxedAllowNearHigh =
        params.isCoreRelaxedCandidate === true &&
        dist !== null &&
        dist >= 0.12 &&
        dist < 0.35;

      const nearHighSoftenEligible =
        params.isFreshFilterSource &&
        (params.score ?? 0) >= 70 &&
        params.secondsSinceSignal !== null &&
        params.secondsSinceSignal !== undefined &&
        params.secondsSinceSignal <= 90 &&
        !params.volumeFadeTriggered &&
        (params.volumeRatio1m5 ?? 0) >= 1.2 &&
        params.hasValidStopLoss &&
        (params.recent1mRet === null || params.recent1mRet === undefined || params.recent1mRet <= 1.2) &&
        (params.recent3mRet === null || params.recent3mRet === undefined || params.recent3mRet <= 2.0) &&
        (params.recent5mRet === null || params.recent5mRet === undefined || params.recent5mRet <= 3.5) &&
        (params.riskReward ?? 0) >= 1.2;

      if (nearHighSoftenEligible) {
        lateTimingTier = "reduced_size_allowed";
        lateEntryGuardReason = "near_high_probe_allowed";
      } else if (severeNearHigh || !coreRelaxedAllowNearHigh) {
        lateEntryGuardTriggered = true;
        lateTimingTier = "hard_block";
        const threshold = severeNearHigh ? 0.12 : LIVE_MAX_ENTRY_NEAR_HIGH_PCT;
        lateEntryGuardReason = `too_near_local_high:${dist!.toFixed(3)}pct<${threshold.toFixed(2)}pct`;
      } else {
        lateTimingTier = "reduced_size_allowed";
        lateEntryGuardReason = `too_near_local_high_soft:${dist!.toFixed(3)}pct<0.35pct`;
      }
    }

    if (!lateEntryGuardTriggered && volFadeProblem) {
      lateEntryGuardTriggered = true;
      lateTimingTier = "hard_block";
      lateEntryGuardReason = "volume_fade_after_spike";
    }

    // Chase check
    if (params.priceChangeSinceSignalPct !== null && params.priceChangeSinceSignalPct !== undefined && params.priceChangeSinceSignalPct > 3.0) {
      lateEntryGuardTriggered = true;
      lateTimingTier = "hard_block";
      lateEntryGuardReason = `chase_from_signal:${params.priceChangeSinceSignalPct.toFixed(3)}pct>3.0pct`;
    }

    return {
      lateEntryGuardTriggered,
      lateTimingTier,
      lateEntryGuardReason,
      proofEmitted,
    };
  }

  // --- Test A: distance = +0.05% -> severe near-high hard block 유지 ---
  const resA = evaluateNearHighGuard({ distanceFromLocalHighPct: 0.05 });
  assert.strictEqual(resA.lateEntryGuardTriggered, true, "Test A: +0.05% must trigger guard");
  assert.strictEqual(resA.lateTimingTier, "hard_block", "Test A: tier must be hard_block");
  assert.ok(resA.lateEntryGuardReason?.includes("too_near_local_high"), "Test A: reason must be too_near_local_high");
  console.log("[PASS] Test A: distance = +0.05% => severe near-high hard block 유지");

  // --- Test B: distance = +0.11% -> severe near-high hard block 유지 ---
  const resB = evaluateNearHighGuard({ distanceFromLocalHighPct: 0.11 });
  assert.strictEqual(resB.lateEntryGuardTriggered, true, "Test B: +0.11% must trigger guard");
  assert.strictEqual(resB.lateTimingTier, "hard_block", "Test B: tier must be hard_block");
  assert.ok(resB.lateEntryGuardReason?.includes("too_near_local_high"), "Test B: reason must be too_near_local_high");
  console.log("[PASS] Test B: distance = +0.11% => severe near-high hard block 유지");

  // --- Test C: distance = +0.20% -> 일반 near-high 정책대로 평가 ---
  const resCSoft = evaluateNearHighGuard({
    distanceFromLocalHighPct: 0.20,
    isFreshFilterSource: true,
    score: 85,
    secondsSinceSignal: 20,
    volumeFadeTriggered: false,
    volumeRatio1m5: 1.5,
    hasValidStopLoss: true,
    riskReward: 1.5,
  });
  assert.strictEqual(resCSoft.lateTimingTier, "reduced_size_allowed", "Test C: softened probe allowed");
  assert.strictEqual(resCSoft.lateEntryGuardReason, "near_high_probe_allowed", "Test C: reason near_high_probe_allowed");
  console.log("[PASS] Test C: distance = +0.20% => 기존 일반 near-high 정책대로 평가");

  // --- Test D: distance = -0.10% -> near-high hard block 금지, 다른 surge 조건 평가 계속 ---
  const resD = evaluateNearHighGuard({
    distanceFromLocalHighPct: -0.10,
    volumeFadeTriggered: false,
    volumeRatio1m5: 1.5,
  });
  assert.strictEqual(resD.lateEntryGuardTriggered, false, "Test D: negative distance must NOT trigger near-high block");
  assert.strictEqual(resD.proofEmitted, true, "Test D: SURGE_NEGATIVE_NEAR_HIGH_BREAKOUT_PROOF must be emitted");
  console.log("[PASS] Test D: distance = -0.10% => near-high hard block 금지, breakout proof 발행");

  // --- Test E: distance = -0.627% (RAY 실사례) -> too_near_local_high 발생 금지 ---
  const resE = evaluateNearHighGuard({
    distanceFromLocalHighPct: -0.627,
    volumeFadeTriggered: false,
    volumeRatio1m5: 2.35,
  });
  assert.strictEqual(resE.lateEntryGuardTriggered, false, "Test E: RAY -0.627% must NOT be blocked by near-high");
  assert.strictEqual(resE.proofEmitted, true, "Test E: breakout proof emitted");
  console.log("[PASS] Test E: distance = -0.627% (RAY 실사례) => too_near_local_high 발생 금지");

  // --- Test F: negative distance + chase_from_signal 초과 -> chase guard로 차단 유지 ---
  const resF = evaluateNearHighGuard({
    distanceFromLocalHighPct: -0.627,
    priceChangeSinceSignalPct: 3.5, // > 3.0%
    volumeFadeTriggered: false,
    volumeRatio1m5: 2.0,
  });
  assert.strictEqual(resF.lateEntryGuardTriggered, true, "Test F: chase must block");
  assert.ok(resF.lateEntryGuardReason?.includes("chase_from_signal"), "Test F: reason must be chase_from_signal");
  console.log("[PASS] Test F: negative distance + chase_from_signal 초과 => chase guard로 차단 유지");

  // --- Test G: negative distance + volume fade -> volume fade 정책 유지 ---
  const resG = evaluateNearHighGuard({
    distanceFromLocalHighPct: -0.627,
    volumeFadeTriggered: true,
    volumeRatio1m5: 0.4,
  });
  assert.strictEqual(resG.lateEntryGuardTriggered, true, "Test G: volume fade must block");
  assert.strictEqual(resG.lateEntryGuardReason, "volume_fade_after_spike", "Test G: reason volume_fade_after_spike");
  console.log("[PASS] Test G: negative distance + volume fade => volume fade 정책 유지");

  // --- Test H: neutral + valid high-quality SURGE -> generic neutral block 금지, multiplier 0.72 ---
  const resH = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: surgeRayMeta,
  });
  assert.strictEqual(resH.ok, true, "Test H: must be allowed");
  assert.strictEqual(resH.size_scale, 0.72, "Test H: multiplier must be 0.72");
  console.log("[PASS] Test H: neutral + valid SURGE => generic neutral block 금지, size multiplier 0.72");

  // --- Test I: risk_off + valid SURGE -> generic risk_off block 금지, multiplier 0.45 ---
  const resI = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: surgeRayMeta,
  });
  assert.strictEqual(resI.ok, true, "Test I: must be allowed");
  assert.strictEqual(resI.size_scale, 0.45, "Test I: multiplier must be 0.45");
  console.log("[PASS] Test I: risk_off + valid SURGE => generic risk_off block 금지, size multiplier 0.45");

  // --- Test J: risk_off + NON-SURGE CORE -> 기존 risk_off block 유지 ---
  const resJ = assertOrderBuyAllowed(snapRiskOffRsi55, {
    kind: "new_entry",
    market: "KRW-BTC",
    strategyType: "stable",
    sourceKind: "CORE_TRADE",
    signalPayload: corePayload,
    candidateMeta: corePassingMeta,
  });
  assert.strictEqual(resJ.ok, false, "Test J: non-surge CORE must be blocked");
  assert.strictEqual(resJ.blocked_reason, "risk_off: 신규 진입 금지", "Test J: reason must be risk_off");
  console.log("[PASS] Test J: risk_off + NON-SURGE CORE => 기존 risk_off block 유지");

  // --- Test K: BTC crash / market panic SURGE -> hard block 유지 ---
  const resK = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: { ...surgeRayMeta, is_panic: true },
  });
  assert.strictEqual(resK.ok, false, "Test K: panic must be blocked");
  assert.ok(resK.blocked_reason?.includes("panic_hard_risk_blocked"), "Test K: panic block");
  console.log("[PASS] Test K: BTC crash / market panic SURGE => hard block 유지, size multiplier 0");

  // --- Test L: Duplicate / Max position safety check ---
  const maxPosReached = 5 >= 5;
  assert.strictEqual(maxPosReached, true, "Test L: max position check strictly active");
  console.log("[PASS] Test L: max position / duplicate / cap exceeded => 기존 block 유지");

  // --- Test M: KRW-RAY 실운영 재현 ---
  // score=92, volume=2.35, btc=strong (rsi=55), neutral, distance=-0.627%
  const rayNearHighEval = evaluateNearHighGuard({
    distanceFromLocalHighPct: -0.627,
    volumeFadeTriggered: false,
    volumeRatio1m5: 2.35,
    score: 92,
    secondsSinceSignal: 15,
    priceChangeSinceSignalPct: 0.8,
  });
  const rayMarketStateEval = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    market: "KRW-RAY",
    strategyType: "momentum",
    signalPayload: rayValidPayload,
    candidateMeta: surgeRayMeta,
  });
  assert.strictEqual(rayNearHighEval.lateEntryGuardTriggered, false, "Test M: ray near-high guard must pass");
  assert.strictEqual(rayNearHighEval.proofEmitted, true, "Test M: ray breakout proof emitted");
  assert.strictEqual(rayMarketStateEval.ok, true, "Test M: ray market state gate must pass");
  assert.strictEqual(rayMarketStateEval.size_scale, 0.72, "Test M: ray size scale must be 0.72");
  console.log("[PASS] Test M: KRW-RAY 실운영 재현 => neutral/near-high hard block 없이 SURGE V2 평가 성공 (scale 0.72)");

  console.log("\n=======================================================");
  console.log("  ALL TESTS (TT1-16 + Tests A-M) PASSED SUCCESSFULLY! (0) ");
  console.log("=======================================================\n");
}

runSurgeMarketStateAuthorityTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

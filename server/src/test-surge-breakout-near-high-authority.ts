/**
 * test-surge-breakout-near-high-authority.ts
 *
 * 회귀 테스트: 확정된 Breakout Surge 신호와 near-high / late-chase 가드의 권위 분리 검증
 *
 * 실전 장애 사례:
 *  - KRW-WIF: Scanner 100점 + Breakout + Setup OK 상태에서 dist=0.000%, 3m=2.02% 라는 이유로 near_high_and_rising에 차단됨.
 *  - KRW-KERNEL: Scanner 100점 + Breakout + Setup OK 상태에서 dist=0.112% < 0.12% 라는 이유로 too_near_local_high에 차단됨.
 *
 * 수정 정책:
 *  - scanner_tradable_candidate 기반 + breakout 확정 + setup ok + 첫 진입(미보유) + stale/fade 없음:
 *    -> 돌파 직후 고점 일치(dist=0%) 및 근접(dist<0.12%)으로 인한 hard block 면제 (정상 돌파 진입 보장)
 *  - 일반 비돌파 신호, 이미 급등 후 뒤늦은 추격(3m>=3.0%, 5m>=5.0%), stale 신호, volume fade 등은 기존 차단 100% 유지.
 *
 * 실행: npx tsx server/src/test-surge-breakout-near-high-authority.ts
 */

import assert from "node:assert";

interface TimingGuardParams {
  market: string;
  isSurgeSource: boolean;
  sourceKindForJudgment: "scanner_filter_fresh" | "fresh_filter_pass" | "legacy_signal";
  breakout: boolean;
  setupOk: boolean;
  hasPosition: boolean;
  score: number;
  distanceFromLocalHighPct: number | null;
  recent1mRet: number | null;
  recent3mRet: number | null;
  recent5mRet: number | null;
  volumeRatio1m5: number | null;
  volumeFadeTriggered: boolean;
  secondsSinceSignal: number | null;
  priceChangeSinceSignalPct: number | null;
  chaseLimit: number;
  staleLimit: number;
}

interface TimingGuardResult {
  lateEntryGuardTriggered: boolean;
  lateTimingTier: "pass" | "hard_block" | "reduced_size_allowed";
  lateEntryGuardReason: string | null;
  surgeBreakoutAuthorityApplied: boolean;
}

function evaluateSurgeBreakoutTimingGuard(params: TimingGuardParams): TimingGuardResult {
  let lateEntryGuardTriggered = false;
  let lateEntryGuardReason: string | null = null;
  let lateTimingTier: "pass" | "hard_block" | "reduced_size_allowed" = "pass";
  let lateEntrySizingMultiplier = 1.0;
  let surgeBreakoutAuthorityApplied = false;

  const LIVE_ENTRY_SIGNAL_STALE_SECONDS = params.staleLimit ?? 240;
  const LIVE_MAX_ENTRY_NEAR_HIGH_PCT = 0.35;

  if (params.secondsSinceSignal !== null && params.secondsSinceSignal > params.staleLimit) {
    lateEntryGuardTriggered = true;
    lateTimingTier = "hard_block";
    lateEntryGuardReason = `signal_stale:${params.secondsSinceSignal}s>${params.staleLimit}s`;
  } else if (params.priceChangeSinceSignalPct !== null && params.priceChangeSinceSignalPct > params.chaseLimit) {
    lateEntryGuardTriggered = true;
    lateTimingTier = "hard_block";
    lateEntryGuardReason = `chase_from_signal:${params.priceChangeSinceSignalPct.toFixed(3)}pct>${params.chaseLimit}pct`;
  } else {
    // 확정 Breakout 첫 진입 권위 판정 (missing evidence는 authority 미인정)
    const hasValidVolumeEvidence = typeof params.volumeRatio1m5 === "number" && Number.isFinite(params.volumeRatio1m5) && params.volumeRatio1m5 >= 0.35;
    const hasValidSignalAgeEvidence = typeof params.secondsSinceSignal === "number" && Number.isFinite(params.secondsSinceSignal) && params.secondsSinceSignal <= LIVE_ENTRY_SIGNAL_STALE_SECONDS;
    const hasValidChaseEvidence = typeof params.priceChangeSinceSignalPct === "number" && Number.isFinite(params.priceChangeSinceSignalPct) && params.priceChangeSinceSignalPct <= params.chaseLimit;

    const isAuthoritativeSurgeBreakoutFirstEntry =
      Boolean(params.isSurgeSource) &&
      Boolean(params.breakout) &&
      Boolean(params.setupOk) &&
      !params.hasPosition &&
      !params.volumeFadeTriggered &&
      hasValidVolumeEvidence &&
      hasValidSignalAgeEvidence &&
      hasValidChaseEvidence;

    const nearHighProblem =
      params.distanceFromLocalHighPct !== null &&
      params.distanceFromLocalHighPct >= 0 &&
      params.distanceFromLocalHighPct < LIVE_MAX_ENTRY_NEAR_HIGH_PCT;
    const volFadeProblem =
      params.volumeFadeTriggered || (params.volumeRatio1m5 !== null && params.volumeRatio1m5 < 0.65);

    if (nearHighProblem) {
      const severeNearHigh =
        params.distanceFromLocalHighPct !== null &&
        params.distanceFromLocalHighPct >= 0 &&
        params.distanceFromLocalHighPct < 0.12;

      if (isAuthoritativeSurgeBreakoutFirstEntry) {
        lateTimingTier = "pass";
        lateEntryGuardReason = null;
        surgeBreakoutAuthorityApplied = true;
      } else if (severeNearHigh) {
        lateEntryGuardTriggered = true;
        lateTimingTier = "hard_block";
        lateEntryGuardReason = `too_near_local_high:${params.distanceFromLocalHighPct!.toFixed(3)}pct<0.12pct`;
      } else {
        lateTimingTier = "reduced_size_allowed";
        lateEntrySizingMultiplier *= 0.45;
        lateEntryGuardReason = `too_near_local_high_soft:${params.distanceFromLocalHighPct!.toFixed(3)}pct<0.35pct`;
      }
    }

    if (!lateEntryGuardTriggered && volFadeProblem) {
      const severeVol = params.volumeRatio1m5 !== null && params.volumeRatio1m5 < 0.35;
      if (severeVol) {
        lateEntryGuardTriggered = true;
        lateTimingTier = "hard_block";
        lateEntryGuardReason = `volume_fade_after_spike:${params.volumeRatio1m5!.toFixed(3)}<0.35`;
      }
    }

    // Late Chase Check
    const lateChaseBy3m = params.recent3mRet !== null && params.recent3mRet >= 3.0;
    const lateChaseBy5m = params.recent5mRet !== null && params.recent5mRet >= 5.0;
    const lateChaseBy15m = params.recent5mRet !== null && params.recent5mRet >= 8.0;
    const lateChaseNearHighAndRising =
      !isAuthoritativeSurgeBreakoutFirstEntry &&
      params.distanceFromLocalHighPct !== null &&
      params.distanceFromLocalHighPct >= 0 &&
      params.distanceFromLocalHighPct < 0.15 &&
      params.recent3mRet !== null && params.recent3mRet >= 2.0;

    const isLateChase = lateChaseBy3m || lateChaseBy5m || lateChaseBy15m || lateChaseNearHighAndRising;

    if (isLateChase) {
      const lateChaseReason = lateChaseBy3m
        ? `recent3m_surge:${(params.recent3mRet ?? 0).toFixed(2)}pct>=3.0`
        : lateChaseBy5m
        ? `recent5m_surge:${(params.recent5mRet ?? 0).toFixed(2)}pct>=5.0`
        : lateChaseBy15m
        ? `recent5m_as_15m_proxy:${(params.recent5mRet ?? 0).toFixed(2)}pct>=8.0`
        : `near_high_and_rising:dist=${(params.distanceFromLocalHighPct ?? 0).toFixed(3)}pct,3m=${(params.recent3mRet ?? 0).toFixed(2)}pct`;
      lateEntryGuardTriggered = true;
      lateTimingTier = "hard_block";
      lateEntryGuardReason = `late_chase_block:${lateChaseReason}`;
    }
  }

  return {
    lateEntryGuardTriggered,
    lateTimingTier,
    lateEntryGuardReason,
    surgeBreakoutAuthorityApplied,
  };
}

let passed = 0;
let failed = 0;

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  FAIL ${name} | ${err.message}`);
    failed++;
  }
}

console.log("=== Surge Breakout & Near-High Authority Regression Test Suite ===\n");

// TC1: KRW-WIF 실전 재현 (Scanner 100점 + Breakout + Setup OK + dist=0.00% + 3m=2.02%)
runTest("TC1: KRW-WIF 실전 재현 -> dist=0.00% 및 3m=2.02% 에서 차단 없이 정상 통과", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-WIF",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 100,
    distanceFromLocalHighPct: 0.000,
    recent1mRet: -0.28,
    recent3mRet: 2.02,
    recent5mRet: 1.44,
    volumeRatio1m5: 5.32,
    volumeFadeTriggered: false,
    secondsSinceSignal: 25,
    priceChangeSinceSignalPct: 0.5,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, false, "WIF must not trigger guard");
  assert.strictEqual(res.lateTimingTier, "pass", "WIF tier must be pass");
  assert.strictEqual(res.surgeBreakoutAuthorityApplied, true, "Breakout authority must apply");
});

// TC2: KRW-KERNEL 실전 재현 (Scanner 100점 + Breakout + Setup OK + dist=0.112% < 0.12%)
runTest("TC2: KRW-KERNEL 실전 재현 -> dist=0.112% 에서 severe near-high 차단 없이 정상 통과", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-KERNEL",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 100,
    distanceFromLocalHighPct: 0.112,
    recent1mRet: 0.5,
    recent3mRet: 2.16,
    recent5mRet: 2.5,
    volumeRatio1m5: 2.5,
    volumeFadeTriggered: false,
    secondsSinceSignal: 30,
    priceChangeSinceSignalPct: 0.4,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, false, "KERNEL must not trigger guard");
  assert.strictEqual(res.lateTimingTier, "pass", "KERNEL tier must be pass");
  assert.strictEqual(res.surgeBreakoutAuthorityApplied, true, "Breakout authority must apply");
});

// TC3: 일반 비돌파 종목이 dist=0.05% < 0.12% 일 때 (breakout=false) -> 기존대로 hard block
runTest("TC3: 일반 비돌파 종목(breakout=false) dist=0.05% -> severe near-high hard_block 유지", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-NORMAL",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: false,
    setupOk: true,
    hasPosition: false,
    score: 75,
    distanceFromLocalHighPct: 0.05,
    recent1mRet: 0.2,
    recent3mRet: 1.0,
    recent5mRet: 1.5,
    volumeRatio1m5: 1.5,
    volumeFadeTriggered: false,
    secondsSinceSignal: 30,
    priceChangeSinceSignalPct: 0.2,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, true, "Non-breakout must trigger guard");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
  assert.ok(res.lateEntryGuardReason?.includes("too_near_local_high:0.050pct<0.12pct"), "Reason must match");
});

// TC4: Breakout 확정이어도 이미 과도하게 폭등한 경우 (3m=4.5% >= 3.0%) -> late_chase 차단
runTest("TC4: Breakout 확정이어도 과도한 급등(3m=4.5% >= 3.0%) -> recent3m_surge hard_block 유지", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-OVERHEAT",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 95,
    distanceFromLocalHighPct: 0.05,
    recent1mRet: 2.0,
    recent3mRet: 4.5,
    recent5mRet: 6.0,
    volumeRatio1m5: 3.0,
    volumeFadeTriggered: false,
    secondsSinceSignal: 20,
    priceChangeSinceSignalPct: 1.0,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, true, "Overextended surge must trigger guard");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
  assert.ok(res.lateEntryGuardReason?.includes("recent3m_surge:4.50pct>=3.0"), "Reason must match recent3m_surge");
});

// TC5: Breakout 확정이어도 이미 포지션 보유 중인 경우 (hasPosition=true, 반복 추격 방지)
runTest("TC5: Breakout 확정이어도 이미 포지션 보유 중 -> 예외 미적용 및 severe near-high 차단 유지", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-HELD",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: true, // 이미 보유
    score: 90,
    distanceFromLocalHighPct: 0.08,
    recent1mRet: 0.5,
    recent3mRet: 1.5,
    recent5mRet: 2.0,
    volumeRatio1m5: 2.0,
    volumeFadeTriggered: false,
    secondsSinceSignal: 20,
    priceChangeSinceSignalPct: 0.3,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, true, "Held position must trigger guard");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
  assert.strictEqual(res.surgeBreakoutAuthorityApplied, false, "Breakout authority must not apply to held");
});

// TC6: Stale Signal (secondsSinceSignal = 300s > 240s) -> signal_stale 차단
runTest("TC6: Breakout 확정이어도 신호가 오래된 경우(300s > 240s) -> signal_stale hard_block 유지", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-STALE",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 90,
    distanceFromLocalHighPct: 0.05,
    recent1mRet: 0.2,
    recent3mRet: 1.0,
    recent5mRet: 1.5,
    volumeRatio1m5: 2.0,
    volumeFadeTriggered: false,
    secondsSinceSignal: 300,
    priceChangeSinceSignalPct: 0.2,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, true, "Stale signal must trigger guard");
  assert.ok(res.lateEntryGuardReason?.includes("signal_stale"), "Reason must be signal_stale");
});

// TC7: Breakout 신호여도 Volume Fade 발생 시 (volumeRatio1m5=0.25 < 0.35) -> volume_fade hard_block
runTest("TC7: Breakout 신호여도 Volume Fade 발생(0.25<0.35) -> volume_fade hard_block 유지", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-VOLFADE",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 85,
    distanceFromLocalHighPct: 0.50, // 정상 거리이지만 볼륨 페이드
    recent1mRet: -0.5,
    recent3mRet: 0.5,
    recent5mRet: 1.0,
    volumeRatio1m5: 0.25,
    volumeFadeTriggered: true,
    secondsSinceSignal: 30,
    priceChangeSinceSignalPct: 0.2,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, true, "Vol fade must trigger guard");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
  assert.strictEqual(res.surgeBreakoutAuthorityApplied, false, "Authority must not apply when volume faded");
  assert.ok(res.lateEntryGuardReason?.includes("volume_fade_after_spike:0.250<0.35"), "Reason must be volume_fade");
});

// TC8: Volume Fade 상태에서는 near-high 돌파 권위 예외가 비활성화되어 severe near-high에서도 hard_block
runTest("TC8: Volume Fade 상태(volumeRatio=0.25) + dist=0.05% -> 권위 예외 미적용 및 hard_block", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-VOLFADE-NEARHIGH",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 85,
    distanceFromLocalHighPct: 0.05,
    recent1mRet: -0.5,
    recent3mRet: 0.5,
    recent5mRet: 1.0,
    volumeRatio1m5: 0.25,
    volumeFadeTriggered: true,
    secondsSinceSignal: 30,
    priceChangeSinceSignalPct: 0.2,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.lateEntryGuardTriggered, true, "Must trigger guard");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
  assert.strictEqual(res.surgeBreakoutAuthorityApplied, false, "Authority must NOT apply");
});

// TC9: Missing Evidence - volumeRatio1m5 = null -> authority false -> severe near-high hard_block
runTest("TC9: Missing Evidence (volumeRatio1m5=null) -> authority false 및 severe near-high 차단", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-NO-VOL-EVIDENCE",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 100,
    distanceFromLocalHighPct: 0.05,
    recent1mRet: 0.1,
    recent3mRet: 1.0,
    recent5mRet: 1.5,
    volumeRatio1m5: null, // missing evidence
    volumeFadeTriggered: false,
    secondsSinceSignal: 25,
    priceChangeSinceSignalPct: 0.5,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.surgeBreakoutAuthorityApplied, false, "Authority must be false when volume evidence is missing");
  assert.strictEqual(res.lateEntryGuardTriggered, true, "Must trigger severe near-high block");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
});

// TC10: Missing Evidence - secondsSinceSignal = null -> authority false -> severe near-high hard_block
runTest("TC10: Missing Evidence (secondsSinceSignal=null) -> authority false 및 severe near-high 차단", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-NO-TIME-EVIDENCE",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 100,
    distanceFromLocalHighPct: 0.05,
    recent1mRet: 0.1,
    recent3mRet: 1.0,
    recent5mRet: 1.5,
    volumeRatio1m5: 3.0,
    volumeFadeTriggered: false,
    secondsSinceSignal: null, // missing evidence
    priceChangeSinceSignalPct: 0.5,
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.surgeBreakoutAuthorityApplied, false, "Authority must be false when time evidence is missing");
  assert.strictEqual(res.lateEntryGuardTriggered, true, "Must trigger severe near-high block");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
});

// TC11: Missing Evidence - priceChangeSinceSignalPct = null -> authority false -> severe near-high hard_block
runTest("TC11: Missing Evidence (priceChangeSinceSignalPct=null) -> authority false 및 severe near-high 차단", () => {
  const res = evaluateSurgeBreakoutTimingGuard({
    market: "KRW-NO-CHASE-EVIDENCE",
    isSurgeSource: true,
    sourceKindForJudgment: "scanner_filter_fresh",
    breakout: true,
    setupOk: true,
    hasPosition: false,
    score: 100,
    distanceFromLocalHighPct: 0.05,
    recent1mRet: 0.1,
    recent3mRet: 1.0,
    recent5mRet: 1.5,
    volumeRatio1m5: 3.0,
    volumeFadeTriggered: false,
    secondsSinceSignal: 25,
    priceChangeSinceSignalPct: null, // missing evidence
    chaseLimit: 3.0,
    staleLimit: 240,
  });

  assert.strictEqual(res.surgeBreakoutAuthorityApplied, false, "Authority must be false when chase evidence is missing");
  assert.strictEqual(res.lateEntryGuardTriggered, true, "Must trigger severe near-high block");
  assert.strictEqual(res.lateTimingTier, "hard_block", "Tier must be hard_block");
});

console.log(`\n============================`);
console.log(`결과: ${passed} 통과 / ${passed + failed} 전체`);
if (failed === 0) {
  console.log("PASS: 모든 Breakout 권위 분리 회귀 테스트 성공");
} else {
  console.error("FAIL: 테스트 실패 발생");
  process.exit(1);
}

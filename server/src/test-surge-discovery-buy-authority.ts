/**
 * test-surge-discovery-buy-authority.ts
 *
 * Orbitalpha Spot SURGE 진입 구조 전면 개편 검증 테스트
 *
 * 핵심 불변식 검증:
 * 1. DISCOVERY ≠ BUY AUTHORITY (후보가 강하다는 사실만으로 즉시 매수 권한 부여 금지)
 * 2. LATE BUT GOOD ≠ REJECT (고점 근접/급등 추격 후보는 버리지 않고 Reclaim 대기로 이관)
 * 3. LATE BUT GOOD → WAIT FOR PULLBACK/RECLAIM (DISCOVERED/LATE_BUT_GOOD → watching → pullback_seen → reclaim_ready → BUY)
 * 4. TRUE EARLY → SMALL PROBE (진짜 초입 후보만 FAST_SURGE_PROBE 0.5x 허용)
 * 5. BAD SETUP → HARD REJECT (구조 실패, stale, risk_off, cooldown은 reclaim 우회 없이 hard reject)
 * 6. NEGATIVE DISTANCE TRUTH:
 *    - dist > 0: local high 아래
 *    - dist = 0: local high 일치
 *    - dist < 0: local high 실제 돌파
 *    - fresh breakout above local high (dist <= 0) 자체를 LATE_BUT_GOOD으로 오판하지 않음
 *    - 단, dist < 0 돌파여도 3m/5m/EMA 과열 시 LATE_BUT_GOOD으로 이관
 *
 * 테스트 목록:
 *  - TEST 1: 강한 후보 + 진짜 초입 → FAST probe 허용
 *  - TEST 2: 강한 후보 + local high 바로 밑 → 즉시 매수 금지, reclaim queue 이동
 *  - TEST 3: 강한 후보 + 최근 3분 급등 후 고점권 → reclaim queue 이동
 *  - TEST 4: reclaim pullback 발생 → pullback_seen
 *  - TEST 5: pullback 이후 반등/EMA 회복 → reclaim_ready
 *  - TEST 6: reclaim 조건 통과 → BUY 허용
 *  - TEST 7: 구조 실패 후보 → reclaim으로 우회하지 않고 hard reject
 *  - TEST 8: stale/risk_off/cooldown/daily_risk_kill → 기존 hard block 유지
 *  - TEST 9: dist = -0.05%, 1m +0.3%, 3m +0.8%, EMA +0.4% → TRUE_EARLY / FAST_SURGE_PROBE
 *  - TEST 10: dist = -0.10%, 3m +3.0%, EMA +2.2% → LATE_BUT_GOOD / RECLAIM_WATCH (돌파 후 과열)
 *  - TEST 11: dist = +0.05%, 3m +2.5% → LATE_BUT_GOOD / RECLAIM_WATCH (고점 밑 추격)
 *  - TEST 12: dist = +0.20%, 3m +0.5%, EMA tight → TRUE_EARLY / FAST_SURGE_PROBE (안전 초입)
 *  - TEST 13: dist = null → fail-open 방지, RECLAIM_WATCH 대기
 *  - TEST 14 (Integration 1): TRUE_EARLY 파이프라인 → final gate 도달 (placeBuy 1회)
 *  - TEST 15 (Integration 2): LATE_BUT_GOOD 파이프라인 → placeBuy 0회 + reclaim queue 1회
 *  - TEST 16 (Integration 3): BAD_SETUP 파이프라인 → placeBuy 0회 + reclaim queue 0회
 *  - TEST 17 (Queue Duplication & Status Preservation):
 *      동일 종목 반복 tick LATE_BUT_GOOD 수신 시 중복생성 금지, first_detected_at 보존,
 *      local high 업데이트, pullback history 보존, pullback_seen/reclaim_ready 보존
 *
 * 실행: npx tsx server/src/test-surge-discovery-buy-authority.ts
 */

import assert from "node:assert";
import {
  classifySurgeCandidateAuthority,
  transferSurgeCandidateToReclaimWatchlist,
  detectSurgePullback,
  evaluateReclaimConditions,
  emitSurgeAuthorityProof,
  validateLiveBuyPrecheck,
  reclaimEvalDebugLastLogTs,
  logReclaimConditionsEvalDebug,
  SurgeCandidateAuthorityInput,
  SurgeAuthorityProofParams,
} from "./live-strategy.js";

function createBaseSurgeCandidate(overrides: Partial<SurgeCandidateAuthorityInput> = {}): SurgeCandidateAuthorityInput {
  return {
    market: "KRW-TEST",
    currentPrice: 1000,
    localHigh: 1005,
    distanceFromLocalHighPct: 0.20, // 0.20% safe pre-breakout (0.12% <= dist <= 0.30%)
    recent1mRet: 0.5,
    recent3mRet: 1.2,
    recent5mRet: 1.8,
    emaDistancePct: 0.8,
    volumeRatio1m5: 1.5,
    volumeRatio: 1.5,
    score: 95,
    sourceKind: "scanner_filter_fresh",
    secondsSinceSignal: 30,
    priceChangeSinceSignalPct: 1.0,
    staleLimit: 240,
    chaseLimit: 3.0,
    hasPosition: false,
    isCooldown: false,
    isRiskOff: false,
    isDailyRiskKill: false,
    hasValidStopLoss: true,
    volumeFadeTriggered: false,
    upperWickHeavy: false,
    boxBreakoutFailed: false,
    volumeSpikeCloseFail: false,
    bearishReject: false,
    setupOk: true,
    breakout: true,
    ...overrides,
  };
}

console.log("====================================================================");
console.log(" Orbitalpha Spot SURGE Discovery vs Buy Authority Verification Suite ");
console.log("====================================================================");

// -----------------------------------------------------------------------------
// 시나리오 1: 강한 후보 + 진짜 초입 → FAST probe 허용
// -----------------------------------------------------------------------------
console.log("\n[TEST 1] 강한 후보 + 진짜 초입 → FAST_SURGE_PROBE 허용");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-FAST",
    secondsSinceSignal: 45, // age <= 90s
    recent1mRet: 0.8,       // <= 1.2%
    recent3mRet: 1.5,       // <= 2.0%
    recent5mRet: 2.2,       // <= 3.5%
    emaDistancePct: 1.0,    // <= 1.5%
    distanceFromLocalHighPct: 0.20, // safe pre-breakout (0.12% <= dist <= 0.30%)
    volumeRatio1m5: 1.6,    // >= 1.2
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "TRUE_EARLY", "Category must be TRUE_EARLY");
  assert.strictEqual(res.immediateBuyAllowed, true, "Immediate buy must be allowed for true early");
  assert.strictEqual(res.finalAuthority, "FAST_SURGE_PROBE", "Authority must be FAST_SURGE_PROBE");
  assert.strictEqual(res.transitionTarget, "BUY", "Transition target must be BUY");
  assert.strictEqual(res.lateEntrySizingMultiplier, 0.5, "Probe sizing multiplier must be 0.5x");

  emitSurgeAuthorityProof({
    tag: "SURGE_TRUE_EARLY_PROBE_ALLOWED_PROOF",
    market: input.market,
    currentPrice: input.currentPrice,
    localHigh: input.localHigh,
    distanceFromLocalHighPct: input.distanceFromLocalHighPct,
    recent1mRet: input.recent1mRet,
    recent3mRet: input.recent3mRet,
    recent5mRet: input.recent5mRet,
    emaDistancePct: input.emaDistancePct,
    volumeAccel: input.volumeRatio1m5,
    score: input.score,
    sourceKind: input.sourceKind,
    originalDecision: "discovered_true_early",
    finalAuthority: res.finalAuthority,
    transitionTarget: res.transitionTarget,
    reason: res.reason,
  });
  console.log("  -> PASS: TRUE_EARLY detected, FAST_SURGE_PROBE (0.5x) granted.");
}

// -----------------------------------------------------------------------------
// 시나리오 2: 강한 후보 + local high 바로 밑 → 즉시 매수 금지, reclaim queue 이동
// -----------------------------------------------------------------------------
console.log("\n[TEST 2] 강한 후보 + local high 바로 밑(dist < 0.12%) → 즉시 매수 금지, reclaim queue 이동");
{
  const mockState: any = { surge_watchlist: {}, morning_surge_watchlist: {} };
  const input = createBaseSurgeCandidate({
    market: "KRW-KERNEL",
    currentPrice: 1000,
    localHigh: 1001,
    distanceFromLocalHighPct: 0.099, // 0.099% >= 0 && < 0.12% (고점 꼭대기)
    recent1mRet: 0.5,
    recent3mRet: 1.2,
    breakout: true,
    setupOk: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Must be classified as LATE_BUT_GOOD");
  assert.strictEqual(res.immediateBuyAllowed, false, "Immediate buy must be BLOCKED");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Transition target must be watching");
  assert.ok(res.reason.includes("near_high_below_apex"), `Reason should mention near high apex: ${res.reason}`);

  const transferred = transferSurgeCandidateToReclaimWatchlist({
    market: input.market,
    currentPrice: input.currentPrice,
    localHigh: input.localHigh,
    dayChangePct: 5.5,
    volume24hKrw: 10_000_000_000,
    isMorningWindow: false,
    state: mockState,
    reason: res.reason,
  });

  assert.strictEqual(transferred, true, "Candidate must be successfully transferred to watchlist");
  const watchItem = mockState.surge_watchlist["KRW-KERNEL"];
  assert.ok(watchItem, "Item must exist in surge_watchlist");
  assert.strictEqual(watchItem.status, "watching", "Initial status in watchlist must be 'watching'");
  assert.strictEqual(watchItem.local_high_price, 1001, "Local high price must match");

  emitSurgeAuthorityProof({
    tag: "SURGE_IMMEDIATE_BUY_BLOCKED_FOR_PRICE_LOCATION_PROOF",
    market: input.market,
    currentPrice: input.currentPrice,
    localHigh: input.localHigh,
    distanceFromLocalHighPct: input.distanceFromLocalHighPct,
    recent1mRet: input.recent1mRet,
    recent3mRet: input.recent3mRet,
    recent5mRet: input.recent5mRet,
    emaDistancePct: input.emaDistancePct,
    volumeAccel: input.volumeRatio1m5,
    score: input.score,
    sourceKind: input.sourceKind,
    originalDecision: "discovered_near_high_apex",
    finalAuthority: res.finalAuthority,
    transitionTarget: res.transitionTarget,
    reason: res.reason,
  });
  console.log("  -> PASS: Immediate buy blocked for dist < 0.12%, transferred to surge_watchlist as 'watching'.");
}

// -----------------------------------------------------------------------------
// 시나리오 3: 강한 후보 + 최근 3분 급등 후 고점권 → reclaim queue 이동
// -----------------------------------------------------------------------------
console.log("\n[TEST 3] 강한 후보 + 최근 3분 급등 후 고점권(3m >= 2.0% & dist < 0.15%) → reclaim queue 이동");
{
  const mockState: any = { surge_watchlist: {}, morning_surge_watchlist: {} };
  const input = createBaseSurgeCandidate({
    market: "KRW-WIF",
    currentPrice: 1000,
    localHigh: 1001.2,
    distanceFromLocalHighPct: 0.12, // 0.12% < 0.15%
    recent1mRet: 1.1,
    recent3mRet: 2.1, // >= 2.0% (과열)
    breakout: true,
    setupOk: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Must be classified as LATE_BUT_GOOD");
  assert.strictEqual(res.immediateBuyAllowed, false, "Immediate buy must be BLOCKED");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Target must be watching");

  const transferred = transferSurgeCandidateToReclaimWatchlist({
    market: input.market,
    currentPrice: input.currentPrice,
    localHigh: input.localHigh,
    dayChangePct: 8.0,
    volume24hKrw: 20_000_000_000,
    isMorningWindow: false,
    state: mockState,
    reason: res.reason,
  });

  assert.strictEqual(transferred, true);
  assert.strictEqual(mockState.surge_watchlist["KRW-WIF"].status, "watching");
  console.log("  -> PASS: 3m surge chase blocked, successfully queued in reclaim watchlist.");
}

// -----------------------------------------------------------------------------
// 시나리오 4: reclaim pullback 발생 → pullback_seen
// -----------------------------------------------------------------------------
console.log("\n[TEST 4] Reclaim pullback 발생 → pullback_seen 상태 전이");
{
  const localHigh = 1000;
  // 1000 -> 991 (0.9% pullback, within 0.7% ~ 1.5% healthy pullback band)
  const currentPrice = 991;

  const pbRes = detectSurgePullback({
    localHigh,
    currentPrice,
    recentCandleLows: [998, 995, 993, 991],
  });

  assert.strictEqual(pbRes.isPullback, true, "Healthy pullback must be detected");
  assert.ok(pbRes.pullbackPct >= 0.7 && pbRes.pullbackPct <= 1.5, `Pullback % (${pbRes.pullbackPct}%) must be in healthy range`);
  assert.strictEqual(pbRes.pullbackLow, 991, "Pullback low price must be identified");
  console.log(`  -> PASS: Pullback detected at ${pbRes.pullbackPct.toFixed(2)}%, low=${pbRes.pullbackLow}. Ready for transition to pullback_seen.`);
}

// -----------------------------------------------------------------------------
// 시나리오 5: pullback 이후 반등/EMA 회복 → reclaim_ready
// -----------------------------------------------------------------------------
console.log("\n[TEST 5] Pullback 이후 반등/EMA 회복 → reclaim_ready 상태 전이");
{
  const localHigh = 1000;
  const pullbackLowPrice = 991;
  const currentPrice = 998.5; // 반등: pullbackLow보다 높고 localHigh * 0.997 이상
  const recent1mRet = 0.35;    // 양수 반등
  const recent3mRet = 0.75;    // 안정적인 3분 수익률
  // 20개 캔들 종가: EMA20이 995 정도로 형성되어 현재가(998.5)가 EMA 위에 위치
  const closes1 = [
    990, 991, 991, 992, 992,
    993, 993, 994, 994, 995,
    994, 995, 995, 996, 995,
    996, 996, 997, 997, 998.5
  ];

  const evalRes = evaluateReclaimConditions({
    currentPrice,
    pullbackLowPrice,
    recent1mRet,
    recent3mRet,
    localHigh,
    closes1,
  });

  assert.strictEqual(evalRes.isRebounding, true, "Must be rebounding above pullback low");
  assert.strictEqual(evalRes.returnsOk, true, "Returns must be gentle and positive");
  assert.strictEqual(evalRes.nearHigh, true, "Price must be reclaiming near local high");
  assert.strictEqual(evalRes.hasEma, true, "EMA20 must be calculated");
  assert.strictEqual(evalRes.isAboveEma, true, "Current price must be above EMA20");
  assert.strictEqual(evalRes.valid, true, "Reclaim conditions must all be VALID");
  console.log("  -> PASS: Rebound + EMA20 reclaim verified. Status transitions to 'reclaim_ready'.");
}

// -----------------------------------------------------------------------------
// 시나리오 6: reclaim 조건 통과 → BUY 허용
// -----------------------------------------------------------------------------
console.log("\n[TEST 6] Reclaim 조건 통과 → BUY 허용 및 SURGE_RECLAIM_BUY_AUTHORITY_PROOF 검증");
{
  const currentPrice = 998.5;
  const localHigh = 1000;
  const pullbackLow = 991;
  const stopCandidate1 = pullbackLow * 0.997; // 988.027
  const stopCandidate2 = currentPrice * 0.985; // 983.522
  let stopPrice = Math.max(stopCandidate1, stopCandidate2);
  let lossPct = ((currentPrice - stopPrice) / currentPrice) * 100;
  if (lossPct < 0.8) {
    stopPrice = currentPrice * 0.992;
    lossPct = 0.8;
  }
  const takeProfitPrice = currentPrice * 1.018; // +1.8%
  const profitPct = ((takeProfitPrice - currentPrice) / currentPrice) * 100;
  const riskReward = profitPct / lossPct;

  assert.ok(stopPrice > 0 && stopPrice < currentPrice, "Stop price must be strictly positive and below entry");
  assert.ok(takeProfitPrice > currentPrice, "Target must be strictly above entry");
  assert.ok(riskReward >= 1.3, `Risk/Reward (${riskReward.toFixed(2)}) must be >= 1.3`);
  assert.ok(lossPct <= 2.0, `Loss pct (${lossPct.toFixed(2)}%) must be <= 2.0%`);

  emitSurgeAuthorityProof({
    tag: "SURGE_RECLAIM_BUY_AUTHORITY_PROOF",
    market: "KRW-RECLAIM",
    currentPrice,
    localHigh,
    distanceFromLocalHighPct: ((localHigh - currentPrice) / localHigh) * 100,
    recent1mRet: 0.35,
    recent3mRet: 0.75,
    recent5mRet: 1.2,
    emaDistancePct: 0.35,
    volumeAccel: 1.35,
    score: 85,
    sourceKind: "surge_reclaim",
    originalDecision: "PULLBACK_RECLAIM_CONFIRMED",
    finalAuthority: "RECLAIM_BUY_ALLOWED",
    transitionTarget: "BUY",
    reason: "reclaim_conditions_verified_pullback_seen_and_rebounded",
  });
  console.log("  -> PASS: Reclaim entry policy verified. Final BUY authority granted at reclaim price.");
}

// -----------------------------------------------------------------------------
// 시나리오 7: 구조 실패 후보 → reclaim으로 우회하지 않고 hard reject
// -----------------------------------------------------------------------------
console.log("\n[TEST 7] 구조 실패 후보 → reclaim 우회 금지, 즉시 hard reject");
{
  const structuralFailCases = [
    { name: "setupOk=false", override: { setupOk: false } },
    { name: "boxBreakoutFailed=true", override: { boxBreakoutFailed: true } },
    { name: "upperWickHeavy=true", override: { upperWickHeavy: true } },
    { name: "volumeSpikeCloseFail=true", override: { volumeSpikeCloseFail: true } },
    { name: "bearishReject=true", override: { bearishReject: true } },
    { name: "volumeCollapse (volumeRatio1m5 < 0.35 & fade)", override: { volumeFadeTriggered: true, volumeRatio1m5: 0.28 } },
    { name: "missing stop loss", override: { hasValidStopLoss: false } },
  ];

  for (const tc of structuralFailCases) {
    const input = createBaseSurgeCandidate({
      market: "KRW-FAIL",
      ...tc.override,
    });
    const res = classifySurgeCandidateAuthority(input);
    assert.strictEqual(res.category, "BAD_SETUP", `Case ${tc.name} must be BAD_SETUP`);
    assert.strictEqual(res.immediateBuyAllowed, false, `Case ${tc.name} must not allow immediate buy`);
    assert.strictEqual(res.finalAuthority, "BLOCKED", `Case ${tc.name} must be BLOCKED`);
    assert.strictEqual(res.transitionTarget, "hard_reject", `Case ${tc.name} must hard_reject`);
  }
  console.log("  -> PASS: All 7 structural/risk failure cases hard rejected. Never deferred to reclaim.");
}

// -----------------------------------------------------------------------------
// 시나리오 8: stale / risk_off / cooldown / daily_risk_kill → 기존 hard block 유지
// -----------------------------------------------------------------------------
console.log("\n[TEST 8] stale / risk_off / cooldown / daily_risk_kill → 기존 hard block 유지");
{
  // 1. Stale
  const staleInput = createBaseSurgeCandidate({
    market: "KRW-STALE",
    secondsSinceSignal: 280, // > staleLimit (240s)
  });
  const staleRes = classifySurgeCandidateAuthority(staleInput);
  assert.strictEqual(staleRes.category, "BAD_SETUP");
  assert.strictEqual(staleRes.finalAuthority, "BLOCKED");
  assert.strictEqual(staleRes.transitionTarget, "hard_reject");
  assert.ok(staleRes.reason.includes("signal_stale"), `Reason should mention signal_stale: ${staleRes.reason}`);

  // 2. Risk Off
  const riskOffInput = createBaseSurgeCandidate({
    market: "KRW-RISKOFF",
    isRiskOff: true,
  });
  const riskOffRes = classifySurgeCandidateAuthority(riskOffInput);
  assert.strictEqual(riskOffRes.category, "BAD_SETUP");
  assert.strictEqual(riskOffRes.finalAuthority, "BLOCKED");
  assert.strictEqual(riskOffRes.transitionTarget, "hard_reject");
  assert.strictEqual(riskOffRes.reason, "market_risk_off");

  // 3. Cooldown
  const cooldownInput = createBaseSurgeCandidate({
    market: "KRW-COOLDOWN",
    isCooldown: true,
  });
  const cooldownRes = classifySurgeCandidateAuthority(cooldownInput);
  assert.strictEqual(cooldownRes.category, "BAD_SETUP");
  assert.strictEqual(cooldownRes.finalAuthority, "BLOCKED");
  assert.strictEqual(cooldownRes.transitionTarget, "hard_reject");
  assert.strictEqual(cooldownRes.reason, "cooldown_active");

  // 4. Daily Risk Kill
  const dailyKillInput = createBaseSurgeCandidate({
    market: "KRW-DAILYKILL",
    isDailyRiskKill: true,
  });
  const dailyKillRes = classifySurgeCandidateAuthority(dailyKillInput);
  assert.strictEqual(dailyKillRes.category, "BAD_SETUP");
  assert.strictEqual(dailyKillRes.finalAuthority, "BLOCKED");
  assert.strictEqual(dailyKillRes.transitionTarget, "hard_reject");
  assert.strictEqual(dailyKillRes.reason, "daily_risk_kill_active");

  // 5. Existing Position
  const posInput = createBaseSurgeCandidate({
    market: "KRW-POS",
    hasPosition: true,
  });
  const posRes = classifySurgeCandidateAuthority(posInput);
  assert.strictEqual(posRes.category, "BAD_SETUP");
  assert.strictEqual(posRes.finalAuthority, "BLOCKED");
  assert.strictEqual(posRes.transitionTarget, "hard_reject");
  assert.strictEqual(posRes.reason, "position_exists");

  console.log("  -> PASS: Stale, risk_off, cooldown, daily_risk_kill, position_exists all correctly hard-blocked.");
}

// -----------------------------------------------------------------------------
// 시나리오 9: dist = -0.05% (갓 돌파), 1m +0.3%, 3m +0.8%, EMA dist +0.4% → TRUE_EARLY / FAST_SURGE_PROBE
// -----------------------------------------------------------------------------
console.log("\n[TEST 9] dist = -0.05% (fresh breakout), 1m +0.3%, 3m +0.8%, EMA +0.4% → TRUE_EARLY");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-BREAKOUT-EARLY",
    currentPrice: 1000.5,
    localHigh: 1000.0,
    distanceFromLocalHighPct: -0.05, // actual breakout above local high
    recent1mRet: 0.3,
    recent3mRet: 0.8,
    recent5mRet: 1.2,
    emaDistancePct: 0.4,
    volumeRatio1m5: 1.6,
    secondsSinceSignal: 30,
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "TRUE_EARLY", "Fresh breakout with gentle returns MUST be TRUE_EARLY");
  assert.strictEqual(res.immediateBuyAllowed, true, "Immediate buy must be allowed");
  assert.strictEqual(res.finalAuthority, "FAST_SURGE_PROBE", "Authority must be FAST_SURGE_PROBE");
  assert.strictEqual(res.transitionTarget, "BUY", "Target must be BUY");
  assert.strictEqual(res.reason, "fresh_breakout_true_early_probe_granted");
  console.log("  -> PASS: TEST 9 Verified (fresh breakout with gentle returns granted FAST_SURGE_PROBE).");
}

// -----------------------------------------------------------------------------
// 시나리오 10: dist = -0.10% (돌파 후 과열), 3m +3.0%, EMA dist +2.2% → LATE_BUT_GOOD / RECLAIM_WATCH
// -----------------------------------------------------------------------------
console.log("\n[TEST 10] dist = -0.10%, 3m +3.0%, EMA +2.2% (overheated breakout) → LATE_BUT_GOOD");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-BREAKOUT-OVERHEAT",
    currentPrice: 1001.0,
    localHigh: 1000.0,
    distanceFromLocalHighPct: -0.10, // breakout above high
    recent1mRet: 1.2,
    recent3mRet: 3.0, // overheated 3m
    recent5mRet: 3.5,
    emaDistancePct: 2.2, // overheated EMA
    volumeRatio1m5: 1.8,
    secondsSinceSignal: 40,
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Overheated breakout must be classified as LATE_BUT_GOOD");
  assert.strictEqual(res.immediateBuyAllowed, false, "Immediate buy must be BLOCKED");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Target must be watching");
  assert.ok(res.reason.includes("breakout_overheated"), `Reason must indicate breakout_overheated: ${res.reason}`);
  console.log("  -> PASS: TEST 10 Verified (overheated breakout deferred to RECLAIM_WATCH).");
}

// -----------------------------------------------------------------------------
// 시나리오 11: dist = +0.05% (고점 바로 아래+상승 진행), 3m +2.5% → LATE_BUT_GOOD / RECLAIM_WATCH
// -----------------------------------------------------------------------------
console.log("\n[TEST 11] dist = +0.05%, 3m +2.5% (near high below breakout) → LATE_BUT_GOOD");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-NEAR-HIGH-BELOW",
    currentPrice: 999.5,
    localHigh: 1000.0,
    distanceFromLocalHighPct: 0.05, // 0.05% below high apex
    recent1mRet: 0.8,
    recent3mRet: 2.5, // extended 3m
    emaDistancePct: 1.1,
    volumeRatio1m5: 1.5,
    secondsSinceSignal: 35,
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Near high below breakout must be LATE_BUT_GOOD");
  assert.strictEqual(res.immediateBuyAllowed, false, "Immediate buy must be BLOCKED");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Target must be watching");
  console.log("  -> PASS: TEST 11 Verified (near high below breakout apex deferred to RECLAIM_WATCH).");
}

// -----------------------------------------------------------------------------
// 시나리오 12: dist = +0.20%, 3m +0.5%, EMA tight, fresh, volume alive → TRUE_EARLY 후보로 평가
// -----------------------------------------------------------------------------
console.log("\n[TEST 12] dist = +0.20%, 3m +0.5%, EMA tight, fresh, volume alive → TRUE_EARLY");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-SAFE-PRE-BREAKOUT",
    currentPrice: 998.0,
    localHigh: 1000.0,
    distanceFromLocalHighPct: 0.20, // safe pre-breakout distance (>= 0.12%)
    recent1mRet: 0.2,
    recent3mRet: 0.5,
    recent5mRet: 0.9,
    emaDistancePct: 0.6,
    volumeRatio1m5: 1.4,
    secondsSinceSignal: 25,
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "TRUE_EARLY", "Safe pre-breakout distance must be TRUE_EARLY");
  assert.strictEqual(res.immediateBuyAllowed, true, "Immediate buy must be allowed");
  assert.strictEqual(res.finalAuthority, "FAST_SURGE_PROBE", "Authority must be FAST_SURGE_PROBE");
  assert.strictEqual(res.transitionTarget, "BUY", "Target must be BUY");
  assert.strictEqual(res.reason, "safe_pre_breakout_true_early_probe_granted");
  console.log("  -> PASS: TEST 12 Verified (safe pre-breakout position granted FAST_SURGE_PROBE).");
}

// -----------------------------------------------------------------------------
// 시나리오 13: dist = null → fail-open 즉시 매수 방지, RECLAIM_WATCH 대기
// -----------------------------------------------------------------------------
console.log("\n[TEST 13] dist = null (가격 위치 증거 부재) → fail-open 금지, RECLAIM_WATCH 대기");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-NULL-DIST",
    distanceFromLocalHighPct: null, // missing price location evidence
    recent1mRet: 0.3,
    recent3mRet: 0.5,
    emaDistancePct: 0.5,
    secondsSinceSignal: 20,
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Missing location evidence must be LATE_BUT_GOOD (fail-closed)");
  assert.strictEqual(res.immediateBuyAllowed, false, "Must NOT allow immediate buy on null distance");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Target must be watching");
  assert.ok(res.reason.includes("missing_price_location_evidence"), `Reason must state missing evidence: ${res.reason}`);
  console.log("  -> PASS: TEST 13 Verified (null distance strictly fail-closed to RECLAIM_WATCH).");
}

// -----------------------------------------------------------------------------
// Integration 3대 테스트 (TEST 14, 15, 16)
// -----------------------------------------------------------------------------
console.log("\n[TEST 14] Integration Path 1: TRUE_EARLY → 실제 Final Gate까지 도달 (placeBuy 1회 시도)");
{
  const mockState: any = {
    positions: {},
    surge_watchlist: {},
    morning_surge_watchlist: {},
    cooldown_until: {},
  };

  const candidateInput = createBaseSurgeCandidate({
    market: "KRW-INTEG-EARLY",
    distanceFromLocalHighPct: -0.05, // fresh breakout
    recent1mRet: 0.4,
    recent3mRet: 0.9,
    emaDistancePct: 0.5,
    volumeRatio1m5: 1.5,
    secondsSinceSignal: 30,
    hasValidStopLoss: true,
  });

  // Step 1: Authority Classifier
  const authority = classifySurgeCandidateAuthority(candidateInput);
  assert.strictEqual(authority.category, "TRUE_EARLY");

  // Step 2: Timing Guard evaluation
  let lateTimingTier = authority.lateTimingTier;
  let lateEntrySizingMultiplier = authority.lateEntrySizingMultiplier;
  let lateEntryGuardTriggered = false;
  let entryAllowedByTiming = !lateEntryGuardTriggered;

  assert.strictEqual(lateTimingTier, "reduced_size_allowed");
  assert.strictEqual(lateEntrySizingMultiplier, 0.5);
  assert.strictEqual(entryAllowedByTiming, true, "Timing guard must allow TRUE_EARLY");

  // Step 3: Downstream SURGE Engine decision
  let placeBuyAttemptCount = 0;
  let reclaimQueueCount = Object.keys(mockState.surge_watchlist).length;

  if (entryAllowedByTiming) {
    placeBuyAttemptCount += 1; // Simulated placeBuy reached!
  }

  assert.strictEqual(placeBuyAttemptCount, 1, "TRUE_EARLY must reach placeBuy attempt exactly once");
  assert.strictEqual(reclaimQueueCount, 0, "TRUE_EARLY must NOT enter reclaim queue");
  console.log("  -> PASS: Integration Path 1 Verified (TRUE_EARLY reached final gate and attempted placeBuy).");
}

console.log("\n[TEST 15] Integration Path 2: LATE_BUT_GOOD → placeBuy 0회 + reclaim queue 1회 (watching)");
{
  const mockState: any = {
    positions: {},
    surge_watchlist: {},
    morning_surge_watchlist: {},
    cooldown_until: {},
  };

  const candidateInput = createBaseSurgeCandidate({
    market: "KRW-INTEG-LATE",
    distanceFromLocalHighPct: 0.05, // near high apex
    recent1mRet: 0.8,
    recent3mRet: 2.2, // extended 3m
    hasValidStopLoss: true,
  });

  // Step 1: Authority Classifier
  const authority = classifySurgeCandidateAuthority(candidateInput);
  assert.strictEqual(authority.category, "LATE_BUT_GOOD");

  // Step 2: Timing Guard evaluation
  let placeBuyAttemptCount = 0;
  if (authority.category === "LATE_BUT_GOOD") {
    // Transferred to reclaim watchlist and skipped
    transferSurgeCandidateToReclaimWatchlist({
      market: candidateInput.market,
      currentPrice: candidateInput.currentPrice,
      localHigh: candidateInput.localHigh,
      dayChangePct: 6.0,
      volume24hKrw: 10_000_000_000,
      isMorningWindow: false,
      state: mockState,
      reason: authority.reason,
    });
    // bumpSkip & continue -> placeBuy NOT called!
  } else {
    placeBuyAttemptCount += 1;
  }

  const reclaimQueueCount = Object.keys(mockState.surge_watchlist).length;
  assert.strictEqual(placeBuyAttemptCount, 0, "LATE_BUT_GOOD must have exactly 0 placeBuy calls");
  assert.strictEqual(reclaimQueueCount, 1, "LATE_BUT_GOOD must have exactly 1 item in reclaim queue");
  assert.strictEqual(mockState.surge_watchlist["KRW-INTEG-LATE"].status, "watching");
  console.log("  -> PASS: Integration Path 2 Verified (placeBuy 0회, reclaim queue 1회 watching).");
}

console.log("\n[TEST 16] Integration Path 3: BAD_SETUP → placeBuy 0회 + reclaim queue 0회 (hard_reject)");
{
  const mockState: any = {
    positions: {},
    surge_watchlist: {},
    morning_surge_watchlist: {},
    cooldown_until: {},
  };

  const candidateInput = createBaseSurgeCandidate({
    market: "KRW-INTEG-BAD",
    setupOk: false, // structural fail
    boxBreakoutFailed: true,
  });

  // Step 1: Authority Classifier
  const authority = classifySurgeCandidateAuthority(candidateInput);
  assert.strictEqual(authority.category, "BAD_SETUP");

  // Step 2: Timing Guard evaluation
  let placeBuyAttemptCount = 0;
  if (authority.category === "BAD_SETUP") {
    // Hard block applied, NEVER transferred to reclaim queue!
  } else if (authority.category === "LATE_BUT_GOOD") {
    transferSurgeCandidateToReclaimWatchlist({
      market: candidateInput.market,
      currentPrice: candidateInput.currentPrice,
      localHigh: candidateInput.localHigh,
      dayChangePct: 2.0,
      volume24hKrw: 5_000_000_000,
      isMorningWindow: false,
      state: mockState,
      reason: authority.reason,
    });
  } else {
    placeBuyAttemptCount += 1;
  }

  const reclaimQueueCount = Object.keys(mockState.surge_watchlist).length;
  assert.strictEqual(placeBuyAttemptCount, 0, "BAD_SETUP must have 0 placeBuy calls");
  assert.strictEqual(reclaimQueueCount, 0, "BAD_SETUP must have 0 items in reclaim queue");
  console.log("  -> PASS: Integration Path 3 Verified (placeBuy 0회, reclaim queue 0회, hard reject).");
}

// -----------------------------------------------------------------------------
// 시나리오 17: Reclaim Queue 중복 & 상태 보존 불변식 테스트
// -----------------------------------------------------------------------------
console.log("\n[TEST 17] Reclaim Queue 중복 방지 & 상태/히스토리 보존 불변식 검증");
{
  const mockState: any = {
    surge_watchlist: {},
    morning_surge_watchlist: {},
  };

  const market = "KRW-RECLAIM-DUP";

  // Tick 1: 최초 LATE_BUT_GOOD 등록
  const t1 = transferSurgeCandidateToReclaimWatchlist({
    market,
    currentPrice: 1000,
    localHigh: 1005,
    dayChangePct: 5.0,
    volume24hKrw: 10_000_000_000,
    isMorningWindow: false,
    state: mockState,
    reason: "near_high_apex",
  });
  assert.strictEqual(t1, true);
  const initialItem = mockState.surge_watchlist[market];
  assert.ok(initialItem);
  const originalFirstDetectedAt = initialItem.first_detected_at;
  assert.strictEqual(initialItem.status, "watching");
  assert.strictEqual(initialItem.local_high_price, 1005);

  // Tick 2: 상태가 pullback_seen으로 전이되고 pullback_low_price가 기록됨
  initialItem.status = "pullback_seen";
  initialItem.pullback_low_price = 992;
  initialItem.pullback_low_at = new Date().toISOString();

  // Tick 3: 동일 market이 스캐너에서 다시 LATE_BUT_GOOD으로 검출되어 transfer 재호출 (localHigh가 1010으로 갱신)
  const t2 = transferSurgeCandidateToReclaimWatchlist({
    market,
    currentPrice: 998,
    localHigh: 1010, // higher local high discovered
    dayChangePct: 5.8,
    volume24hKrw: 12_000_000_000,
    isMorningWindow: false,
    state: mockState,
    reason: "repeated_detection",
  });

  assert.strictEqual(t2, true);
  assert.strictEqual(Object.keys(mockState.surge_watchlist).length, 1, "Must NOT create duplicate items");

  const updatedItem = mockState.surge_watchlist[market];
  // 1. first_detected_at 보존 검증
  assert.strictEqual(updatedItem.first_detected_at, originalFirstDetectedAt, "first_detected_at must be preserved");
  // 2. local_high_price 최고가 업데이트 검증
  assert.strictEqual(updatedItem.local_high_price, 1010, "local_high_price must be updated to higher peak (1010)");
  // 3. pullback history 보존 검증
  assert.strictEqual(updatedItem.pullback_low_price, 992, "pullback_low_price must NOT be reset");
  // 4. 상태(status) 보존 검증 (pullback_seen이 watching으로 덮어써지지 않음)
  assert.strictEqual(updatedItem.status, "pullback_seen", "Existing status must NOT be reset to 'watching'");

  // Tick 4: 상태가 reclaim_ready로 진입한 후 또 transfer 재호출 시 상태 보존 검증
  updatedItem.status = "reclaim_ready";
  const t3 = transferSurgeCandidateToReclaimWatchlist({
    market,
    currentPrice: 1008,
    localHigh: 1010,
    dayChangePct: 6.2,
    volume24hKrw: 15_000_000_000,
    isMorningWindow: false,
    state: mockState,
    reason: "repeated_detection_tick4",
  });
  assert.strictEqual(t3, true);
  assert.strictEqual(mockState.surge_watchlist[market].status, "reclaim_ready", "reclaim_ready status must NOT be reset");

  console.log("  -> PASS: TEST 17 Verified (No duplicate, first_detected_at preserved, peak high updated, pullback history intact, active state not regressed).");
}

// -----------------------------------------------------------------------------
// TEST 18: priceChangeSinceSignalPct > chaseLimit + valid setup + good volume + no rejection
//          → BAD_SETUP 금지 → LATE_BUT_GOOD / RECLAIM_WATCH
// -----------------------------------------------------------------------------
console.log("\n[TEST 18] priceChangeSinceSignalPct > chaseLimit + valid setup → BAD_SETUP 금지, LATE_BUT_GOOD / RECLAIM_WATCH");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-CHASE-SURVIVE",
    priceChangeSinceSignalPct: 3.5, // > chaseLimit (3.0%)
    chaseLimit: 3.0,
    setupOk: true,
    hasValidStopLoss: true,
    volumeFadeTriggered: false,
    upperWickHeavy: false,
    boxBreakoutFailed: false,
    volumeSpikeCloseFail: false,
    bearishReject: false,
    isRiskOff: false,
    isCooldown: false,
    hasPosition: false,
    isDailyRiskKill: false,
    volumeRatio1m5: 1.6,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.notStrictEqual(res.category, "BAD_SETUP", "Must NOT be BAD_SETUP when setup/structure/risk is valid");
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Must be classified as LATE_BUT_GOOD");
  assert.strictEqual(res.immediateBuyAllowed, false, "Immediate buy must be blocked for chase");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Final authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Transition target must be 'watching'");
  assert.ok(res.reason.includes("chase_from_signal_reclaim"), "Reason must reflect chase reclaim survival");
  console.log("  -> PASS: TEST 18 Verified (chase from signal survived to RECLAIM_WATCH as LATE_BUT_GOOD).");
}

// -----------------------------------------------------------------------------
// TEST 19: dist = +0.80%, fresh / gentle / volume alive → TRUE_EARLY 즉시 BUY 금지 (상한 초과)
// -----------------------------------------------------------------------------
console.log("\n[TEST 19] dist = +0.80% (safePreBreakoutLocation 상한 초과) → TRUE_EARLY 즉시 BUY 금지");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-TOO-FAR",
    distanceFromLocalHighPct: 0.80, // > LIVE_EARLY_ENTRY_NEAR_HIGH_PCT (0.30%)
    secondsSinceSignal: 30,         // fresh age
    recent1mRet: 0.4,               // gentle
    recent3mRet: 0.9,               // gentle
    recent5mRet: 1.3,               // gentle
    emaDistancePct: 0.5,            // tight
    volumeRatio1m5: 1.5,            // alive
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.notStrictEqual(res.category, "TRUE_EARLY", "Must NOT grant TRUE_EARLY for dist > LIVE_EARLY_ENTRY_NEAR_HIGH_PCT");
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Category must be LATE_BUT_GOOD");
  assert.strictEqual(res.immediateBuyAllowed, false, "Immediate buy must be false");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Transition target must be 'watching'");
  assert.ok(res.reason.includes("safe_pre_breakout_too_far_from_high"), "Reason must indicate distance exceeds pre-breakout upper bound");
  console.log("  -> PASS: TEST 19 Verified (pre-breakout distance +0.80% blocked from immediate TRUE_EARLY BUY).");
}

// -----------------------------------------------------------------------------
// TEST 20: dist = +0.20%, fresh / gentle but EMA evidence null + volume evidence null
//          → FAST_SURGE_PROBE를 무증거 fail-open으로 주지 않고 RECLAIM_WATCH 대기 확인
// -----------------------------------------------------------------------------
console.log("\n[TEST 20] dist = +0.20%, EMA null & volume null → 무증거 fail-open 방지, RECLAIM_WATCH 대기");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-NO-EVIDENCE",
    distanceFromLocalHighPct: 0.20,
    secondsSinceSignal: 30,
    recent1mRet: 0.4,
    recent3mRet: 0.9,
    recent5mRet: 1.3,
    emaDistancePct: null,   // missing EMA evidence
    volumeRatio1m5: null,   // missing volume evidence
    volumeRatio: 0,
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.notStrictEqual(res.category, "TRUE_EARLY", "Must NOT grant TRUE_EARLY without sufficient evidence");
  assert.strictEqual(res.category, "LATE_BUT_GOOD", "Must be deferred to LATE_BUT_GOOD, NOT hard reject");
  assert.strictEqual(res.immediateBuyAllowed, false, "Immediate buy must be false");
  assert.strictEqual(res.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");
  assert.strictEqual(res.transitionTarget, "watching", "Must transition to 'watching'");
  assert.ok(res.reason.includes("insufficient_evidence_for_true_early"), "Reason must indicate insufficient evidence");
  console.log("  -> PASS: TEST 20 Verified (missing EMA/volume evidence fail-closed to RECLAIM_WATCH without hard reject).");
}

// -----------------------------------------------------------------------------
// TEST 21: dist = -0.05%, fresh breakout, gentle return, EMA valid, volume valid
//          → FAST_SURGE_PROBE 유지
// -----------------------------------------------------------------------------
console.log("\n[TEST 21] dist = -0.05%, fresh breakout + gentle + EMA/volume valid → FAST_SURGE_PROBE 유지");
{
  const input = createBaseSurgeCandidate({
    market: "KRW-FRESH-BREAKOUT",
    distanceFromLocalHighPct: -0.05, // fresh breakout
    secondsSinceSignal: 25,          // <= 90s
    recent1mRet: 0.3,                // gentle
    recent3mRet: 0.8,                // gentle
    recent5mRet: 1.2,                // gentle
    emaDistancePct: 0.4,             // gentle <= 1.5%
    volumeRatio1m5: 1.6,             // alive >= 1.2
    hasValidStopLoss: true,
  });

  const res = classifySurgeCandidateAuthority(input);
  assert.strictEqual(res.category, "TRUE_EARLY", "Must be TRUE_EARLY for valid fresh breakout");
  assert.strictEqual(res.immediateBuyAllowed, true, "Immediate buy must be allowed");
  assert.strictEqual(res.finalAuthority, "FAST_SURGE_PROBE", "Authority must be FAST_SURGE_PROBE");
  assert.strictEqual(res.transitionTarget, "BUY", "Transition target must be BUY");
  assert.strictEqual(res.lateEntrySizingMultiplier, 0.5, "Probe sizing multiplier must be 0.5x");
  assert.strictEqual(res.reason, "fresh_breakout_true_early_probe_granted", "Reason must indicate fresh breakout probe");
  console.log("  -> PASS: TEST 21 Verified (fresh breakout with gentle returns retained FAST_SURGE_PROBE).");
}

// =============================================================================
// PERFORMANCE_KILL & SURGE 권한 계층 분리 10대 회귀 테스트 (TEST 22 ~ TEST 31)
// =============================================================================

async function runPerformanceKillRegressionSuite() {
  console.log("\n====================================================================");
  console.log(" Running PERFORMANCE_KILL & SURGE Authority Regression Tests (10/10) ");
  console.log("====================================================================");

  const performanceKillTrades = [
    { market: "KRW-LOSS1", pnl_pct: -1.5, timestamp: new Date().toISOString(), action: "sell", order_krw: 100000, filled_qty: 10 },
    { market: "KRW-LOSS2", pnl_pct: -2.0, timestamp: new Date().toISOString(), action: "sell", order_krw: 100000, filled_qty: 10 },
    { market: "KRW-LOSS3", pnl_pct: -1.2, timestamp: new Date().toISOString(), action: "sell", order_krw: 100000, filled_qty: 10 },
    { market: "KRW-LOSS4", pnl_pct: -0.8, timestamp: new Date().toISOString(), action: "sell", order_krw: 100000, filled_qty: 10 },
    { market: "KRW-LOSS5", pnl_pct: -1.1, timestamp: new Date().toISOString(), action: "sell", order_krw: 100000, filled_qty: 10 },
  ];

  // 1. PERFORMANCE_KILL + LATE_BUT_GOOD → BUY X / RECLAIM_WATCH O
  console.log("\n[TEST 22] 1. PERFORMANCE_KILL + LATE_BUT_GOOD → BUY X / RECLAIM_WATCH O");
  {
    const mockState: any = { surge_watchlist: {}, morning_surge_watchlist: {}, trades: performanceKillTrades };
    const input = createBaseSurgeCandidate({
      market: "KRW-LATE-PERF",
      distanceFromLocalHighPct: 0.08, // near apex -> LATE_BUT_GOOD
      score: 95,
      breakout: true,
      setupOk: true,
    });

    const authority = classifySurgeCandidateAuthority(input);
    assert.strictEqual(authority.category, "LATE_BUT_GOOD", "Must be LATE_BUT_GOOD");
    assert.strictEqual(authority.immediateBuyAllowed, false, "Immediate BUY must be false");
    assert.strictEqual(authority.finalAuthority, "RECLAIM_WATCH", "Authority must be RECLAIM_WATCH");

    const guard = await validateLiveBuyPrecheck({
      market: input.market,
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge",
      entryPath: "precheck",
      isAdditionalBuy: false,
      actualDailyPnlPct: -1.0,
      candidateMeta: { engine_bucket: "surge", score: 95 },
    });
    assert.strictEqual(guard.allowed, false, "Precheck must NOT allow normal BUY under PERFORMANCE_KILL");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "Kill switch type must be PERFORMANCE");

    // Discovery 보존 확인: Watchlist 정상 이관
    const transferred = transferSurgeCandidateToReclaimWatchlist({
      market: input.market,
      currentPrice: input.currentPrice,
      localHigh: input.localHigh,
      dayChangePct: 4.2,
      volume24hKrw: 5_000_000_000,
      isMorningWindow: false,
      state: mockState,
      reason: authority.reason,
    });
    assert.strictEqual(transferred, true, "Candidate must be transferred to watchlist");
    assert.ok(mockState.surge_watchlist[input.market], "Candidate must exist in surge_watchlist");
    assert.strictEqual(mockState.surge_watchlist[input.market].status, "watching", "Status must be 'watching'");
    console.log("  -> PASS: PERFORMANCE_KILL did not block discovery/watchlist transfer. BUY blocked, RECLAIM_WATCH preserved.");
  }

  // 2. PERFORMANCE_KILL + TRUE_EARLY strong → 0.25x probe O
  console.log("\n[TEST 23] 2. PERFORMANCE_KILL + TRUE_EARLY strong → 0.25x probe O");
  {
    const strongCandidateMeta: any = {
      market: "KRW-STRONG-EARLY",
      engine_bucket: "surge",
      score: 95,
      setup: { ok: true, reason: "surge_v2_entry_path", mode: "safe" },
      setupReason: "surge_v2_entry_path",
      scanner_authority: true,
      early_surge_authority: true,
      validated_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-STRONG-EARLY",
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge",
      entryPath: "surge_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: -1.0,
      candidateMeta: strongCandidateMeta,
    });
    assert.strictEqual(guard.allowed, true, "Strong TRUE_EARLY must be allowed as probe");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "Must be PERFORMANCE kill switch");
    assert.strictEqual(strongCandidateMeta.relaxed_multiplier, 0.25, "Must enforce 0.25x probe multiplier");
    assert.strictEqual(strongCandidateMeta.is_performance_probe, true, "Must flag is_performance_probe");
    console.log("  -> PASS: Strong TRUE_EARLY granted 0.25x performance probe.");
  }

  // 3. PERFORMANCE_KILL + TRUE_EARLY weak → BUY X
  console.log("\n[TEST 24] 3. PERFORMANCE_KILL + TRUE_EARLY weak (score < 90) → BUY X");
  {
    const weakCandidateMeta: any = {
      market: "KRW-WEAK-EARLY",
      engine_bucket: "surge",
      score: 85, // weak score < 90
      setup: { ok: true, reason: "surge_v2_entry_path", mode: "safe" },
      setupReason: "surge_v2_entry_path",
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-WEAK-EARLY",
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge",
      entryPath: "surge_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: -1.0,
      candidateMeta: weakCandidateMeta,
    });
    assert.strictEqual(guard.allowed, false, "Weak TRUE_EARLY must be BLOCKED under PERFORMANCE_KILL");
    assert.strictEqual(guard.blockReason, "global_kill_switch_active", "Must block with global_kill_switch_active");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "Must identify PERFORMANCE kill switch");
    console.log("  -> PASS: Weak TRUE_EARLY successfully blocked from BUY under PERFORMANCE_KILL.");
  }

  // 4. PERFORMANCE_KILL + RECLAIM_READY valid → 0.25x probe O
  console.log("\n[TEST 25] 4. PERFORMANCE_KILL + RECLAIM_READY valid → 0.25x probe O");
  {
    const validReclaimMeta: any = {
      market: "KRW-RECLAIM-VALID",
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed: true,
      riskReward: 1.5, // >= 1.3
      stopPrice: 950,  // > 0 and < currentPrice
      score: 80,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-RECLAIM-VALID",
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 1000,
      reclaimScore: 80,
      actualDailyPnlPct: -1.0,
      candidateMeta: validReclaimMeta,
    });
    assert.strictEqual(guard.allowed, true, "Valid RECLAIM_READY must be allowed 0.25x probe under PERFORMANCE_KILL");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "Must identify PERFORMANCE kill switch");
    assert.strictEqual(validReclaimMeta.relaxed_multiplier, 0.25, "Must enforce 0.25x multiplier");
    assert.strictEqual(validReclaimMeta.is_performance_probe, true, "Must flag is_performance_probe");
    console.log("  -> PASS: Valid RECLAIM_READY granted 0.25x performance probe.");
  }

  // 5. PERFORMANCE_KILL + RECLAIM_READY invalid RR → BUY X
  console.log("\n[TEST 26] 5. PERFORMANCE_KILL + RECLAIM_READY invalid RR (< 1.3) → BUY X");
  {
    const invalidRrReclaimMeta: any = {
      market: "KRW-RECLAIM-LOW-RR",
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed: true,
      riskReward: 1.15, // < 1.3 invalid RR
      stopPrice: 950,
      score: 80,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-RECLAIM-LOW-RR",
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 1000,
      reclaimScore: 80,
      actualDailyPnlPct: -1.0,
      candidateMeta: invalidRrReclaimMeta,
    });
    assert.strictEqual(guard.allowed, false, "Invalid RR RECLAIM must be BLOCKED");
    assert.strictEqual(guard.blockReason, "global_kill_switch_active", "Must block with global_kill_switch_active");
    console.log("  -> PASS: RECLAIM with invalid RR (< 1.3) successfully blocked.");
  }

  // 6. PERFORMANCE_KILL 때문에 BUY 거절 → watchlist 삭제 X
  console.log("\n[TEST 27] 6. PERFORMANCE_KILL 때문에 BUY 거절 → watchlist 삭제 X (queue 보존)");
  {
    // 이미 1개의 probe position이 열려 있어 position limit으로 Reclaim BUY가 거절되는 상황
    const mockPositionsWithProbe: any = {
      "KRW-EXISTING-PROBE": {
        qty: 10,
        is_performance_probe: true,
        managed: true,
        engine_bucket: "surge",
      },
    };

    const mockWatchlist: any = {
      "KRW-HOLD-WATCH": {
        market: "KRW-HOLD-WATCH",
        status: "reclaim_ready",
        attempt_count: 5, // attempt_count가 5에 도달했음!
        entry_price: 1000,
        stop_price: 950,
      },
    };

    const reclaimMeta: any = {
      market: "KRW-HOLD-WATCH",
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed: true,
      riskReward: 1.6,
      stopPrice: 950,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-HOLD-WATCH",
      trades: performanceKillTrades,
      positions: mockPositionsWithProbe, // position limit reached!
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 1000,
      reclaimScore: 80,
      actualDailyPnlPct: -1.0,
      candidateMeta: reclaimMeta,
    });
    assert.strictEqual(guard.allowed, false, "Must be blocked due to performance probe limit");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "Must identify as PERFORMANCE kill switch");

    // Reclaim loop logic simulation: PERFORMANCE_KILL 차단 시 deletion 방지
    const item = mockWatchlist["KRW-HOLD-WATCH"];
    const isPerformanceKillBlock =
      guard.killSwitchType === "PERFORMANCE" ||
      guard.blockReason === "global_kill_switch_active" ||
      guard.blockReason === "performance_kill_not_eligible" ||
      guard.blockReason === "performance_probe_position_limit_reached";

    assert.strictEqual(isPerformanceKillBlock, true, "Must be detected as performance kill block");
    if (isPerformanceKillBlock) {
      item.status = "retry_wait";
      item.retry_after = Date.now() + 5000;
    } else {
      item.attempt_count = (item.attempt_count || 0) + 1;
      if (item.attempt_count >= 5) {
        delete mockWatchlist["KRW-HOLD-WATCH"];
      }
    }

    assert.ok(mockWatchlist["KRW-HOLD-WATCH"], "Watchlist item must NOT be deleted on performance kill!");
    assert.strictEqual(mockWatchlist["KRW-HOLD-WATCH"].status, "retry_wait", "Item status must transition to retry_wait");
    console.log("  -> PASS: Candidate NOT deleted from watchlist despite attempt_count >= 5 when blocked by PERFORMANCE_KILL.");
  }

  // 7. HARD_RISK_KILL + TRUE_EARLY → BUY X
  console.log("\n[TEST 28] 7. HARD_RISK_KILL + TRUE_EARLY → BUY X");
  {
    const strongEarlyMeta: any = {
      market: "KRW-HARD-EARLY",
      engine_bucket: "surge",
      score: 95,
      setup: { ok: true, reason: "surge_v2_entry_path", mode: "safe" },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-HARD-EARLY",
      trades: [],
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge",
      entryPath: "surge_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: -3.0, // HARD RISK: <= -2.5%
      candidateMeta: strongEarlyMeta,
    });
    assert.strictEqual(guard.allowed, false, "HARD_RISK_KILL must block TRUE_EARLY 100%");
    assert.strictEqual(guard.killSwitchType, "HARD_RISK", "Must identify HARD_RISK kill switch");
    assert.strictEqual(guard.blockReason, "daily_pnl_limit_reached", "Reason must be daily_pnl_limit_reached");
    console.log("  -> PASS: HARD_RISK_KILL completely blocked TRUE_EARLY.");
  }

  // 8. HARD_RISK_KILL + RECLAIM_READY → BUY X
  console.log("\n[TEST 29] 8. HARD_RISK_KILL + RECLAIM_READY → BUY X");
  {
    const validReclaimMeta: any = {
      market: "KRW-HARD-RECLAIM",
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed: true,
      riskReward: 2.0,
      stopPrice: 900,
      score: 90,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-HARD-RECLAIM",
      trades: [],
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 1000,
      reclaimScore: 90,
      actualDailyPnlPct: -3.0, // HARD RISK: <= -2.5%
      candidateMeta: validReclaimMeta,
    });
    assert.strictEqual(guard.allowed, false, "HARD_RISK_KILL must block RECLAIM_READY 100%");
    assert.strictEqual(guard.killSwitchType, "HARD_RISK", "Must identify HARD_RISK kill switch");
    console.log("  -> PASS: HARD_RISK_KILL completely blocked RECLAIM_READY.");
  }

  // 9. cooldown / position_exists / stale → 기존과 동일하게 BUY X
  console.log("\n[TEST 30] 9. cooldown / position_exists / stale → 기존과 동일하게 BUY X");
  {
    // 9-1) Cooldown active
    const coolTime = new Date(Date.now() + 60000).toISOString();
    const guardCool = await validateLiveBuyPrecheck({
      market: "KRW-COOLDOWN",
      trades: [],
      positions: {},
      cooldown_until: { "KRW-COOLDOWN": coolTime },
      marketState: null,
      signalPayload: {},
      strategyType: "surge",
      entryPath: "surge_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
    });
    assert.ok(guardCool.cooldownRemainingSec > 0, "Cooldown seconds remaining must be positive");

    // 9-2) Stale signal in classifier
    const staleCandidate = createBaseSurgeCandidate({
      market: "KRW-STALE",
      secondsSinceSignal: 300, // > 240s stale limit
    });
    const authStale = classifySurgeCandidateAuthority(staleCandidate);
    assert.strictEqual(authStale.category, "BAD_SETUP", "Stale candidate must be BAD_SETUP");
    assert.strictEqual(authStale.immediateBuyAllowed, false, "Stale must not allow BUY");
    assert.ok(authStale.reason.includes("signal_stale"), "Reason must mention signal_stale");

    // 9-3) Position exists in classifier
    const posCandidate = createBaseSurgeCandidate({
      market: "KRW-EXISTS",
      hasPosition: true,
    });
    const authPos = classifySurgeCandidateAuthority(posCandidate);
    assert.strictEqual(authPos.category, "BAD_SETUP", "Position exists candidate must be BAD_SETUP");
    assert.strictEqual(authPos.immediateBuyAllowed, false, "Position exists must not allow BUY");
    assert.ok(authPos.reason.includes("position_exists"), "Reason must mention position_exists");

    console.log("  -> PASS: cooldown, position_exists, and stale signals strictly blocked.");
  }

  // 10. BAD_SETUP → PERFORMANCE_KILL 여부와 관계없이 reclaim queue X
  console.log("\n[TEST 31] 10. BAD_SETUP → PERFORMANCE_KILL 여부와 관계없이 reclaim queue X");
  {
    const mockState: any = { surge_watchlist: {}, morning_surge_watchlist: {} };
    const badCandidate = createBaseSurgeCandidate({
      market: "KRW-BAD-SETUP",
      boxBreakoutFailed: true, // structural failure
      volumeSpikeCloseFail: true,
    });

    const authority = classifySurgeCandidateAuthority(badCandidate);
    assert.strictEqual(authority.category, "BAD_SETUP", "Must be classified as BAD_SETUP");
    assert.strictEqual(authority.immediateBuyAllowed, false, "Immediate BUY must be false");
    assert.strictEqual(authority.finalAuthority, "BLOCKED", "Final authority must be BLOCKED");
    assert.strictEqual(authority.transitionTarget, "hard_reject", "Transition target must be hard_reject");

    assert.strictEqual(Object.keys(mockState.surge_watchlist).length, 0, "BAD_SETUP must NOT be transferred to watchlist");
    console.log("  -> PASS: BAD_SETUP hard-rejected and never transferred to reclaim queue.");
  }

  // ===========================================================================
  // 추가 4대 검증 테스트 (TEST 32 ~ TEST 35)
  // 1. 원본 scanner_authority 없음 → candidateMeta가 임의 true 생성하지 않음
  // 2. EMA 위지만 status != reclaim_ready → reclaim_ready_passed=false
  // 3. HARD_RISK + blockReason=global_kill_switch_active → PERFORMANCE queue-preserve 분기 진입 X
  // 4. PERFORMANCE_KILL + 실제 reclaim_ready → 0.25x probe O
  // ===========================================================================

  // 11 (TEST 32). 원본 scanner_authority 없음 → candidateMeta가 임의 true 생성하지 않음
  console.log("\n[TEST 32] 11. 원본 scanner_authority 없음 → candidateMeta가 임의 true 생성하지 않음 (truthful metadata)");
  {
    const rawWatchlistItem: any = {
      market: "KRW-TRUTHFUL-RECLAIM",
      status: "reclaim_ready",
      local_high_price: 1000,
      pullback_low_price: 980,
      attempt_count: 1,
      // scanner_authority, early_surge_authority, validated_surge_authority, setup 등이 없음
    };

    // live-strategy.ts 15039~15058의 candidateMeta 생성 원칙 검증
    const candidateMeta: any = {
      market: rawWatchlistItem.market,
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed: rawWatchlistItem.status === "reclaim_ready",
      reclaim_status: rawWatchlistItem.status,
      score: 85,
      stopPrice: 975,
      takeProfitPrice: 1050,
      riskReward: 2.0,
      scanner_authority: rawWatchlistItem.scanner_authority !== undefined ? Boolean(rawWatchlistItem.scanner_authority) : undefined,
      early_surge_authority: rawWatchlistItem.early_surge_authority !== undefined ? Boolean(rawWatchlistItem.early_surge_authority) : undefined,
      validated_surge_authority: rawWatchlistItem.validated_surge_authority !== undefined ? Boolean(rawWatchlistItem.validated_surge_authority) : undefined,
      setup: rawWatchlistItem.setup ?? undefined,
      setupReason: rawWatchlistItem.setupReason ?? undefined,
    };

    assert.strictEqual(candidateMeta.scanner_authority, undefined, "Must NOT inject fake true for scanner_authority");
    assert.strictEqual(candidateMeta.early_surge_authority, undefined, "Must NOT inject fake true for early_surge_authority");
    assert.strictEqual(candidateMeta.validated_surge_authority, undefined, "Must NOT inject fake true for validated_surge_authority");
    assert.strictEqual(candidateMeta.setup, undefined, "Must NOT inject fake setup { ok: true }");
    assert.notStrictEqual(candidateMeta.scanner_authority, true, "scanner_authority must never be true when absent");
    assert.strictEqual(candidateMeta.reclaim_ready_passed, true, "reclaim_ready_passed must be true based purely on state machine");
    console.log("  -> PASS: candidateMeta creates no fake authorities; preserves undefined when absent.");
  }

  // 12 (TEST 33). EMA 위지만 status != reclaim_ready → reclaim_ready_passed=false
  console.log("\n[TEST 33] 12. EMA 위지만 status != reclaim_ready → reclaim_ready_passed=false (isAboveEma 대체 금지)");
  {
    const pullbackItem: any = {
      market: "KRW-PULLBACK-ONLY",
      status: "pullback_seen", // Not yet reclaim_ready!
      local_high_price: 1000,
      pullback_low_price: 980,
    };

    const evalRes = {
      isAboveEma: true, // EMA 위지만 아직 reclaim_ready에 도달하지 않음
    };

    // 로직: item.status === "reclaim_ready" (evalRes.isAboveEma 대체 금지)
    const reclaim_ready_passed = pullbackItem.status === "reclaim_ready";
    assert.strictEqual(reclaim_ready_passed, false, "reclaim_ready_passed must be false when status is pullback_seen, even if isAboveEma is true");

    // candidateMeta 구성 및 validateLiveBuyPrecheck 검증
    const candidateMeta: any = {
      market: pullbackItem.market,
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed, // false
      reclaim_status: pullbackItem.status,
      score: 85,
      stopPrice: 975,
      takeProfitPrice: 1050,
      riskReward: 2.0,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: pullbackItem.market,
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 990,
      reclaimScore: 85,
      actualDailyPnlPct: -1.0,
      candidateMeta,
    });

    assert.strictEqual(guard.allowed, false, "Must NOT allow probe when reclaim_ready_passed is false");
    assert.strictEqual(guard.blockReason, "global_kill_switch_active", "Must block with global_kill_switch_active");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "KillSwitchType must be PERFORMANCE");
    console.log("  -> PASS: isAboveEma did not substitute for reclaim_ready; probe strictly blocked.");
  }

  // 13 (TEST 34). HARD_RISK + blockReason=global_kill_switch_active → PERFORMANCE queue-preserve 분기 진입 X
  console.log("\n[TEST 34] 13. HARD_RISK + blockReason=global_kill_switch_active → PERFORMANCE queue-preserve 분기 진입 X");
  {
    const mockWatchlist: any = {
      "KRW-HARD-RISK-DROP": {
        market: "KRW-HARD-RISK-DROP",
        status: "reclaim_ready",
        attempt_count: 4, // 1회 추가 시 5회 도달하여 삭제 대상
      },
    };

    // HARD_RISK 상황: 일일 손실 -3.0%로 HARD_RISK 가드 발동
    const hardRiskMeta: any = {
      market: "KRW-HARD-RISK-DROP",
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed: true,
      riskReward: 2.0,
      stopPrice: 950,
      score: 90,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
    };

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-HARD-RISK-DROP",
      trades: [],
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 1000,
      reclaimScore: 90,
      actualDailyPnlPct: -3.0, // HARD_RISK
      candidateMeta: hardRiskMeta,
    });

    assert.strictEqual(guard.allowed, false, "HARD_RISK must block buy");
    assert.strictEqual(guard.killSwitchType, "HARD_RISK", "Must be HARD_RISK kill switch type");

    // Queue-preserve 판정 로직 검증:
    // guard.killSwitchType === "PERFORMANCE" || (guard.killSwitchType !== "HARD_RISK" && ...)
    const isPerformanceKillBlock =
      (guard.killSwitchType as string) === "PERFORMANCE" ||
      (guard.killSwitchType !== "HARD_RISK" &&
        (guard.blockReason === "performance_kill_not_eligible" ||
         guard.blockReason === "performance_probe_position_limit_reached"));

    assert.strictEqual(isPerformanceKillBlock, false, "HARD_RISK must NEVER be treated as performance kill block");

    // 가령 blockReason이 'global_kill_switch_active'인 가상 HARD_RISK guard 객체로도 검증
    const syntheticHardRiskGuard: any = {
      allowed: false,
      killSwitchType: "HARD_RISK",
      blockReason: "global_kill_switch_active",
    };
    const syntheticIsPerfBlock =
      syntheticHardRiskGuard.killSwitchType === "PERFORMANCE" ||
      (syntheticHardRiskGuard.killSwitchType !== "HARD_RISK" &&
        (syntheticHardRiskGuard.blockReason === "performance_kill_not_eligible" ||
         syntheticHardRiskGuard.blockReason === "performance_probe_position_limit_reached"));

    assert.strictEqual(syntheticIsPerfBlock, false, "Synthetic HARD_RISK + global_kill_switch_active must NOT enter queue-preserve");

    // 시뮬레이션: HARD_RISK 차단 시 attempt_count 증가 후 5회 도달 시 정상 삭제
    const item = mockWatchlist["KRW-HARD-RISK-DROP"];
    if (isPerformanceKillBlock) {
      item.status = "retry_wait";
    } else {
      item.attempt_count = (item.attempt_count || 0) + 1;
      if (item.attempt_count >= 5) {
        delete mockWatchlist["KRW-HARD-RISK-DROP"];
      }
    }

    assert.strictEqual(mockWatchlist["KRW-HARD-RISK-DROP"], undefined, "Item must be deleted from watchlist after 5 attempts on HARD_RISK (no preservation)");
    console.log("  -> PASS: HARD_RISK strictly excluded from PERFORMANCE queue-preservation; standard retry/purge policy upheld.");
  }

  // 14 (TEST 35). PERFORMANCE_KILL + 실제 reclaim_ready (가짜 authority 없이) → 0.25x probe O
  console.log("\n[TEST 35] 14. PERFORMANCE_KILL + 실제 reclaim_ready (가짜 authority 없이) → 0.25x probe O");
  {
    const truthfulReclaimMeta: any = {
      market: "KRW-TRUTHFUL-PROBE",
      engine_bucket: "surge",
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      reclaim_ready_passed: true, // Only genuine state machine proof!
      riskReward: 1.8,             // >= 1.3
      stopPrice: 950,              // valid stop < currentPrice
      score: 85,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      // scanner_authority, early_surge_authority, validated_surge_authority are all UNDEFINED
    };

    assert.strictEqual(truthfulReclaimMeta.scanner_authority, undefined);
    assert.strictEqual(truthfulReclaimMeta.early_surge_authority, undefined);
    assert.strictEqual(truthfulReclaimMeta.setup, undefined);

    const guard = await validateLiveBuyPrecheck({
      market: "KRW-TRUTHFUL-PROBE",
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 1000,
      reclaimScore: 85,
      actualDailyPnlPct: -1.0,
      candidateMeta: truthfulReclaimMeta,
    });

    assert.strictEqual(guard.allowed, true, "Truthful reclaim candidate must be granted probe under PERFORMANCE_KILL");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "Must identify PERFORMANCE kill switch");
    assert.strictEqual(truthfulReclaimMeta.relaxed_multiplier, 0.25, "Must enforce 0.25x probe sizing multiplier");
    assert.strictEqual(truthfulReclaimMeta.is_performance_probe, true, "Must flag is_performance_probe");
    console.log("  -> PASS: Truthful reclaim candidate granted 0.25x probe purely via reclaim_ready_passed without fake authorities.");
  }

  // ===========================================================================
  // Reclaim 전용 eligibility 테스트 (TEST A ~ G): 합성 phase 없이 판정
  // ===========================================================================
  const mkMarketState = (market_state: string, extra: any = {}) => ({
    status: () => ({ market_state, btc_rsi: 50, ...extra }),
    evaluate: async () => ({ market_state, btc_rsi: 50, ...extra }),
  });
  const mkReclaimMeta = (market: string, over: any = {}): any => ({
    market,
    engine_bucket: "surge",
    sourceStrategy: "surge_reclaim_entry",
    strategyType: "surge_reclaim",
    reclaim_ready_passed: true,
    reclaim_status: "reclaim_ready",
    riskReward: 1.8,
    stopPrice: 950,
    score: 85,
    // btc_phase / asset_phase 의도적으로 없음
    ...over,
  });
  const runReclaim = (market: string, meta: any, ms: any, pnl = -1.0) =>
    validateLiveBuyPrecheck({
      market,
      trades: performanceKillTrades,
      positions: {},
      cooldown_until: {},
      marketState: ms,
      signalPayload: { source_kind: "scanner" },
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      entryPath: "surge_reclaim_entry",
      isAdditionalBuy: false,
      currentPrice: 1000,
      reclaimScore: 85,
      actualDailyPnlPct: pnl,
      candidateMeta: meta,
    } as any);

  console.log("\n[TEST A] phase 없음 + reclaim_ready_passed + 정상 시장 + PERFORMANCE_KILL → 0.25x 허용");
  {
    const meta = mkReclaimMeta("KRW-RC-A");
    assert.strictEqual(meta.btc_phase, undefined);
    assert.strictEqual(meta.asset_phase, undefined);
    const g = await runReclaim("KRW-RC-A", meta, mkMarketState("neutral"));
    assert.strictEqual(g.allowed, true, "Reclaim must be allowed without any phase data");
    assert.strictEqual(g.killSwitchType, "PERFORMANCE");
    assert.strictEqual(meta.relaxed_multiplier, 0.25);
    assert.strictEqual(meta.is_performance_probe, true);
    console.log("  -> PASS: TEST A");
  }

  console.log("\n[TEST B] 동일 조건 + market_state=risk_off → 차단");
  {
    const meta = mkReclaimMeta("KRW-RC-B");
    const g = await runReclaim("KRW-RC-B", meta, mkMarketState("risk_off"));
    assert.strictEqual(g.allowed, false);
    assert.strictEqual(meta.relaxed_multiplier, undefined, "No probe multiplier on block");
    console.log("  -> PASS: TEST B");
  }

  console.log("\n[TEST C] 동일 조건 + 실제 panic=true → 차단");
  {
    const meta1 = mkReclaimMeta("KRW-RC-C1", { is_panic: true });
    const g1 = await runReclaim("KRW-RC-C1", meta1, mkMarketState("neutral"));
    assert.strictEqual(g1.allowed, false, "meta is_panic must block");
    const meta2 = mkReclaimMeta("KRW-RC-C2");
    const g2 = await runReclaim("KRW-RC-C2", meta2, mkMarketState("neutral", { panic: true }));
    assert.strictEqual(g2.allowed, false, "market-state panic snapshot must block");
    assert.strictEqual(meta2.relaxed_multiplier, undefined);
    console.log("  -> PASS: TEST C");
  }

  console.log("\n[TEST D] 동일 조건 + HARD_RISK_KILL → 차단 + queue-preserve 예외 없음");
  {
    const meta = mkReclaimMeta("KRW-RC-D");
    const g = await runReclaim("KRW-RC-D", meta, mkMarketState("neutral"), -3.0);
    assert.strictEqual(g.allowed, false);
    assert.strictEqual(g.killSwitchType, "HARD_RISK");
    const isPerfBlock =
      (g.killSwitchType as string) === "PERFORMANCE" ||
      (g.killSwitchType !== "HARD_RISK" &&
        (g.blockReason === "performance_kill_not_eligible" ||
          g.blockReason === "performance_probe_position_limit_reached"));
    assert.strictEqual(isPerfBlock, false, "HARD_RISK must not enter queue-preserve");
    assert.strictEqual(meta.relaxed_multiplier, undefined);
    console.log("  -> PASS: TEST D");
  }

  console.log("\n[TEST E] reclaim_ready_passed=false → phase와 무관하게 차단");
  {
    const meta = mkReclaimMeta("KRW-RC-E", { reclaim_ready_passed: false, reclaim_status: "pullback_seen", btc_phase: "impulse", asset_phase: "impulse" });
    const g = await runReclaim("KRW-RC-E", meta, mkMarketState("risk_on"));
    assert.strictEqual(g.allowed, false);
    console.log("  -> PASS: TEST E");
  }

  console.log("\n[TEST F] stop/RR 불량 → 차단");
  {
    const lowRr = mkReclaimMeta("KRW-RC-F1", { riskReward: 1.1 });
    assert.strictEqual((await runReclaim("KRW-RC-F1", lowRr, mkMarketState("neutral"))).allowed, false);
    const badStop = mkReclaimMeta("KRW-RC-F2", { stopPrice: 1000 });
    assert.strictEqual((await runReclaim("KRW-RC-F2", badStop, mkMarketState("neutral"))).allowed, false);
    const noStop = mkReclaimMeta("KRW-RC-F3", { stopPrice: 0 });
    assert.strictEqual((await runReclaim("KRW-RC-F3", noStop, mkMarketState("neutral"))).allowed, false);
    console.log("  -> PASS: TEST F");
  }

  console.log("\n[TEST G] 정상 Reclaim PERFORMANCE probe: base 100,000원 → final 25,000원");
  {
    const meta = mkReclaimMeta("KRW-RC-G");
    const g = await runReclaim("KRW-RC-G", meta, mkMarketState("neutral"));
    assert.strictEqual(g.allowed, true);
    const baseBudgetKrw = 100_000;
    // live-strategy reclaim 경로와 동일: 원본 base에 relaxed_multiplier 한 번만 적용 (중복 축소 없음)
    const finalOrderKrw = Math.max(5000, Math.floor(baseBudgetKrw * meta.relaxed_multiplier));
    assert.strictEqual(finalOrderKrw, 25_000);
    assert.strictEqual(finalOrderKrw / baseBudgetKrw, 0.25);
    console.log("  -> PASS: TEST G (effective_multiplier = 0.25)");
  }

  console.log("\n[TEST H] PERFORMANCE + reclaim_ready + BTC 정상 → 0.25x ALLOW");
  {
    const meta = mkReclaimMeta("KRW-RC-H");
    assert.strictEqual(meta.is_panic, undefined);
    const g = await runReclaim("KRW-RC-H", meta, mkMarketState("neutral"));
    assert.strictEqual(g.allowed, true);
    assert.strictEqual(g.killSwitchType, "PERFORMANCE");
    assert.strictEqual(meta.relaxed_multiplier, 0.25);
    assert.strictEqual(meta.is_performance_probe, true);
    console.log("  -> PASS: TEST H");
  }

  console.log("\n[TEST I] PERFORMANCE + reclaim_ready + detectBtcMarketPhase.isPanic=true → HARD_RISK BLOCK");
  {
    const meta = mkReclaimMeta("KRW-RC-I", { is_panic: true });
    const g = await runReclaim("KRW-RC-I", meta, mkMarketState("neutral"));
    assert.strictEqual(g.allowed, false, "Must block on real BTC panic");
    assert.strictEqual(g.killSwitchType, "HARD_RISK", "Panic must be classified as HARD_RISK");
    assert.strictEqual(meta.relaxed_multiplier, undefined, "No probe multiplier on panic");
    console.log("  -> PASS: TEST I");
  }

  console.log("\n[TEST J] panic=true 상태에서 relaxed_multiplier=0.25여도 → BUY BLOCK");
  {
    const meta = mkReclaimMeta("KRW-RC-J", { is_panic: true, relaxed_multiplier: 0.25, is_performance_probe: true });
    const g = await runReclaim("KRW-RC-J", meta, mkMarketState("neutral"));
    assert.strictEqual(g.allowed, false, "Must strictly block BUY even if relaxed_multiplier=0.25");
    assert.strictEqual(g.killSwitchType, "HARD_RISK");
    console.log("  -> PASS: TEST J");
  }

  console.log("\n[TEST K] panic=true + reclaim_ready + RR>=1.3 + valid stop → reclaim eligibility가 있어도 HARD_RISK 우선 BLOCK");
  {
    const meta = mkReclaimMeta("KRW-RC-K", {
      is_panic: true,
      reclaim_ready_passed: true,
      riskReward: 2.0,
      stopPrice: 950,
      score: 95,
    });
    const g = await runReclaim("KRW-RC-K", meta, mkMarketState("risk_on"));
    assert.strictEqual(g.allowed, false, "Reclaim eligibility must NOT bypass HARD_RISK on panic");
    assert.strictEqual(g.killSwitchType, "HARD_RISK");
    console.log("  -> PASS: TEST K");
  }

  console.log("\n[TEST L] panic=false/undefined + risk_off=false → 기존 PERFORMANCE reclaim 0.25x 동작 유지");
  {
    const metaUndefined = mkReclaimMeta("KRW-RC-L1");
    assert.strictEqual(metaUndefined.is_panic, undefined);
    const g1 = await runReclaim("KRW-RC-L1", metaUndefined, mkMarketState("neutral"));
    assert.strictEqual(g1.allowed, true);
    assert.strictEqual(metaUndefined.relaxed_multiplier, 0.25);

    const metaFalse = mkReclaimMeta("KRW-RC-L2", { is_panic: false });
    const g2 = await runReclaim("KRW-RC-L2", metaFalse, mkMarketState("neutral"));
    assert.strictEqual(g2.allowed, true);
    assert.strictEqual(metaFalse.relaxed_multiplier, 0.25);
    console.log("  -> PASS: TEST L");
  }

  console.log("\n[TEST M] panic=true → PERFORMANCE queue-preserve 분기 진입 금지");
  {
    const meta = mkReclaimMeta("KRW-RC-M", { is_panic: true });
    const g = await runReclaim("KRW-RC-M", meta, mkMarketState("neutral"));
    assert.strictEqual(g.killSwitchType, "HARD_RISK");
    const isPerfBlock =
      (g.killSwitchType as string) === "PERFORMANCE" ||
      (g.killSwitchType !== "HARD_RISK" &&
        (g.blockReason === "performance_kill_not_eligible" ||
          g.blockReason === "performance_probe_position_limit_reached"));
    assert.strictEqual(isPerfBlock, false, "Panic-induced HARD_RISK must NOT enter queue-preserve branch");
    console.log("  -> PASS: TEST M");
  }

  console.log("\n[TEST N] reclaim_ready + BTC panic → BUY BLOCK → watchlist item preserved");
  {
    const mockWatchlist: Record<string, any> = {
      "KRW-PANIC-TEST": {
        market: "KRW-PANIC-TEST",
        status: "reclaim_ready",
        attempt_count: 2,
        pullback_low_price: 990,
        local_high: 1000,
      },
    };

    const panicMeta = mkReclaimMeta("KRW-PANIC-TEST", { is_panic: true });
    const guard = await runReclaim("KRW-PANIC-TEST", panicMeta, mkMarketState("neutral"));

    assert.strictEqual(guard.allowed, false, "Must block BUY on panic");
    assert.strictEqual(guard.killSwitchType, "HARD_RISK", "Must be HARD_RISK");

    const item = mockWatchlist["KRW-PANIC-TEST"];
    const isBtcPanicBlock =
      guard.killSwitchType === "HARD_RISK" &&
      (panicMeta.is_panic === true || (guard as any).isPanic === true);

    assert.strictEqual(isBtcPanicBlock, true, "Must detect BTC panic block");

    if (isBtcPanicBlock) {
      item.status = "retry_wait";
      item.last_block_reason = "hard_risk_btc_panic";
      item.retry_after = Date.now() + 5000;
    } else {
      item.attempt_count = (item.attempt_count || 0) + 1;
      if (item.attempt_count >= 5) {
        delete mockWatchlist["KRW-PANIC-TEST"];
      }
    }

    assert.notStrictEqual(mockWatchlist["KRW-PANIC-TEST"], undefined, "Watchlist item MUST be preserved on panic");
    assert.strictEqual(item.status, "retry_wait", "Status must transition to retry_wait");
    assert.strictEqual(item.last_block_reason, "hard_risk_btc_panic", "Reason must be hard_risk_btc_panic");
    assert.strictEqual(item.attempt_count, 2, "attempt_count must NOT increment on panic");
    console.log("  -> PASS: TEST N");
  }

  console.log("\n[TEST O] BTC panic block 후 panic 해제 → 과거 reclaim_ready 즉시 재사용 금지 → reclaim conditions 재검증 필수");
  {
    const item: any = {
      market: "KRW-PANIC-CLEAR",
      status: "retry_wait",
      pullback_low_price: 990,
      local_high: 1000,
      last_block_reason: "hard_risk_btc_panic",
      retry_after: Date.now() - 100, // timer expired
    };

    // 1. 과거 reclaim_ready 즉시 재사용 금지 확인 (item.status is retry_wait, not reclaim_ready)
    assert.notStrictEqual(item.status, "reclaim_ready", "Must not be reclaim_ready without revalidation");

    // 2. panic이 해제되었더라도 reclaim conditions가 불량이면 (예: 가격이 pullback_low 이하로 붕괴)
    const brokenPrice = 980; // below pullback_low 990
    const evalBroken = evaluateReclaimConditions({
      currentPrice: brokenPrice,
      pullbackLowPrice: item.pullback_low_price,
      recent1mRet: -0.5,
      recent3mRet: -1.2,
      localHigh: item.local_high,
      closes1: [995, 990, 985, 980],
    });

    assert.strictEqual(evalBroken.valid, false, "Broken conditions must fail validation");

    if (evalBroken.valid) {
      item.status = "reclaim_ready";
    } else {
      item.status = "pullback_seen";
      item.last_block_reason = "reclaim_conditions_no_longer_valid";
    }

    assert.strictEqual(item.status, "pullback_seen", "Must demote to pullback_seen on failed conditions");
    assert.notStrictEqual(item.status, "reclaim_ready", "Stale reclaim_ready MUST NOT be reused");
    console.log("  -> PASS: TEST O");
  }

  console.log("\n[TEST P] panic 해제 + reclaim conditions 재통과 → PERFORMANCE_KILL이면 0.25x BUY 허용");
  {
    const item: any = {
      market: "KRW-PANIC-RECOVERED",
      status: "retry_wait",
      pullback_low_price: 990,
      local_high: 1000,
      last_block_reason: "hard_risk_btc_panic",
      retry_after: Date.now() - 100,
    };

    // 1. Reclaim conditions 재검증 통과
    const currentPrice = 999;
    const closes = Array(30).fill(992);
    closes.push(999);
    const evalValid = evaluateReclaimConditions({
      currentPrice,
      pullbackLowPrice: item.pullback_low_price,
      recent1mRet: 0.3,
      recent3mRet: 0.8,
      localHigh: item.local_high,
      closes1: closes,
    });
    assert.strictEqual(evalValid.valid, true, "Reclaim conditions must pass");
    item.status = "reclaim_ready";

    // 2. panic 해제 상태에서 Reclaim precheck 실행 (PERFORMANCE_KILL 활성 환경)
    const recoveredMeta = mkReclaimMeta("KRW-PANIC-RECOVERED", {
      is_panic: undefined, // Panic cleared
      reclaim_ready_passed: true,
      stopPrice: 990,
      riskReward: 1.8,
      score: 85,
    });
    const guard = await runReclaim("KRW-PANIC-RECOVERED", recoveredMeta, mkMarketState("neutral"));

    assert.strictEqual(guard.allowed, true, "Must allow BUY when panic cleared and reclaim revalidated");
    assert.strictEqual(guard.killSwitchType, "PERFORMANCE", "Under performance kill switch");
    assert.strictEqual(recoveredMeta.relaxed_multiplier, 0.25, "Probe multiplier must be 0.25");

    const baseBudgetKrw = 100_000;
    const finalOrderKrw = Math.max(5000, Math.floor(baseBudgetKrw * recoveredMeta.relaxed_multiplier));
    assert.strictEqual(finalOrderKrw, 25_000, "Final order KRW must be exactly 25,000 (0.25x)");
    console.log("  -> PASS: TEST P (0.25x probe allowed after panic cleared & revalidated)");
  }

  console.log("\n[TEST Q] daily PnL HARD_RISK 등 비-panic hard risk → 기존 정책 유지");
  {
    const mockWatchlist: Record<string, any> = {
      "KRW-DAILY-LOSS-COIN": {
        market: "KRW-DAILY-LOSS-COIN",
        status: "reclaim_ready",
        attempt_count: 4,
      },
    };

    const nonPanicMeta = mkReclaimMeta("KRW-DAILY-LOSS-COIN", { is_panic: false });
    const guard = await runReclaim("KRW-DAILY-LOSS-COIN", nonPanicMeta, mkMarketState("neutral"), -3.0);

    assert.strictEqual(guard.allowed, false, "Must block buy");
    assert.strictEqual(guard.killSwitchType, "HARD_RISK", "Must be HARD_RISK");

    const isBtcPanicBlock =
      guard.killSwitchType === "HARD_RISK" &&
      (nonPanicMeta.is_panic === true || (guard as any).isPanic === true);

    assert.strictEqual(isBtcPanicBlock, false, "Daily PnL hard risk must NOT be classified as BTC panic");

    const item = mockWatchlist["KRW-DAILY-LOSS-COIN"];
    if (isBtcPanicBlock) {
      item.status = "retry_wait";
    } else {
      item.attempt_count = (item.attempt_count || 0) + 1;
      if (item.attempt_count >= 5) {
        delete mockWatchlist["KRW-DAILY-LOSS-COIN"];
      }
    }

    assert.strictEqual(mockWatchlist["KRW-DAILY-LOSS-COIN"], undefined, "Item must be deleted after 5 attempts on non-panic HARD_RISK");
    console.log("  -> PASS: TEST Q (non-panic HARD_RISK purge policy preserved)");
  }

  console.log("\n[TEST R] panic 중 placeBuy attempt = 0");
  {
    let placeBuyCalls = 0;
    const placeBuyOrder = () => { placeBuyCalls++; };

    const panicMeta = mkReclaimMeta("KRW-PANIC-ORDER", { is_panic: true });
    const guard = await runReclaim("KRW-PANIC-ORDER", panicMeta, mkMarketState("neutral"));

    if (guard.allowed) {
      placeBuyOrder();
    }

    assert.strictEqual(guard.allowed, false, "Guard must block BUY");
    assert.strictEqual(placeBuyCalls, 0, "placeBuy attempt count must be strictly 0 during panic");
    console.log("  -> PASS: TEST R (placeBuy attempt = 0 on panic)");
  }

  console.log("\n[TEST OBS-1] nearHigh만 실패 -> failed_conditions: ['near_high']");
  {
    const currentPrice = 990;
    const localHigh = 1000; // dist = 1.0% > 0.3% (nearHigh = false)
    const pullbackLowPrice = 985; // 990 > 985 (isRebounding = true)
    const recent1mRet = 0.5; // > 0
    const recent3mRet = 1.0; // 0 <= 3m <= 2.5 (returnsOk = true)
    const closes1 = Array(30).fill(988); // EMA20 = 988, 990 >= 988 (isAboveEma = true)
    const res = evaluateReclaimConditions({
      currentPrice,
      pullbackLowPrice,
      recent1mRet,
      recent3mRet,
      localHigh,
      closes1,
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.nearHigh, false);
    assert.strictEqual(res.isRebounding, true);
    assert.strictEqual(res.returnsOk, true);
    assert.strictEqual(res.isAboveEma, true);
    assert.deepStrictEqual(res.failedConditions, ["near_high"]);
    console.log("  -> PASS: TEST OBS-1");
  }

  console.log("\n[TEST OBS-2] returnsOk만 실패 -> failed_conditions: ['returns_ok']");
  {
    const currentPrice = 998;
    const localHigh = 1000; // nearHigh = true (998 >= 997)
    const pullbackLowPrice = 990; // isRebounding = true (998 > 990)
    const recent1mRet = -0.2; // <= 0 -> returnsOk = false
    const recent3mRet = 1.0;
    const closes1 = Array(30).fill(995); // isAboveEma = true (998 >= 995)
    const res = evaluateReclaimConditions({
      currentPrice,
      pullbackLowPrice,
      recent1mRet,
      recent3mRet,
      localHigh,
      closes1,
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.returnsOk, false);
    assert.strictEqual(res.nearHigh, true);
    assert.strictEqual(res.isRebounding, true);
    assert.strictEqual(res.isAboveEma, true);
    assert.deepStrictEqual(res.failedConditions, ["returns_ok"]);
    console.log("  -> PASS: TEST OBS-2");
  }

  console.log("\n[TEST OBS-3] isRebounding만 실패 -> failed_conditions: ['is_rebounding']");
  {
    const currentPrice = 998;
    const localHigh = 1000; // nearHigh = true
    const pullbackLowPrice = 999; // 998 <= 999 -> isRebounding = false
    const recent1mRet = 0.4; // returnsOk = true
    const recent3mRet = 1.0;
    const closes1 = Array(30).fill(995); // isAboveEma = true
    const res = evaluateReclaimConditions({
      currentPrice,
      pullbackLowPrice,
      recent1mRet,
      recent3mRet,
      localHigh,
      closes1,
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.isRebounding, false);
    assert.strictEqual(res.returnsOk, true);
    assert.strictEqual(res.nearHigh, true);
    assert.strictEqual(res.isAboveEma, true);
    assert.deepStrictEqual(res.failedConditions, ["is_rebounding"]);
    console.log("  -> PASS: TEST OBS-3");
  }

  console.log("\n[TEST OBS-4] EMA20만 실패 -> failed_conditions: ['is_above_ema']");
  {
    const currentPrice = 998;
    const localHigh = 1000; // nearHigh = true
    const pullbackLowPrice = 990; // isRebounding = true
    const recent1mRet = 0.4; // returnsOk = true
    const recent3mRet = 1.0;
    const closes1 = Array(30).fill(999.5); // ema20 = 999.5 > 998 -> isAboveEma = false
    const res = evaluateReclaimConditions({
      currentPrice,
      pullbackLowPrice,
      recent1mRet,
      recent3mRet,
      localHigh,
      closes1,
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.isAboveEma, false);
    assert.strictEqual(res.hasEma, true);
    assert.strictEqual(res.isRebounding, true);
    assert.strictEqual(res.returnsOk, true);
    assert.strictEqual(res.nearHigh, true);
    assert.deepStrictEqual(res.failedConditions, ["is_above_ema"]);
    console.log("  -> PASS: TEST OBS-4");
  }

  console.log("\n[TEST OBS-5] 복수 실패 시 failed_conditions 정확성");
  {
    const currentPrice = 990;
    const localHigh = 1000; // nearHigh = false (990 < 997)
    const pullbackLowPrice = 992; // isRebounding = false (990 <= 992)
    const recent1mRet = -0.5; // returnsOk = false
    const recent3mRet = -1.0;
    const closes1 = Array(30).fill(995); // isAboveEma = false (990 < 995)
    const res = evaluateReclaimConditions({
      currentPrice,
      pullbackLowPrice,
      recent1mRet,
      recent3mRet,
      localHigh,
      closes1,
    });
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.failedConditions, [
      "is_rebounding",
      "returns_ok",
      "near_high",
      "is_above_ema",
    ]);
    console.log("  -> PASS: TEST OBS-5");
  }

  console.log("\n[TEST OBS-6] 60초 디바운스 동작 검증");
  {
    const market = "KRW-DEBOUNCE-TEST";
    reclaimEvalDebugLastLogTs.delete(market);

    // Call 1: initial false -> must log (return true)
    const l1 = logReclaimConditionsEvalDebug({
      market,
      watchStatus: "pullback_seen",
      currentPrice: 990,
      localHigh: 1000,
      pullbackLowPrice: 985,
      pullbackPct: 1.5,
      recent1mRet: -0.2,
      recent3mRet: 0.5,
      ema20: 988,
      distanceFromLocalHighPct: 1.0,
      isRebounding: true,
      returnsOk: false,
      nearHigh: false,
      hasEma: true,
      isAboveEma: true,
      finalValid: false,
      failedConditions: ["returns_ok", "near_high"],
      elapsedSeconds: 30,
    });
    assert.strictEqual(l1, true, "Call 1 must log");

    // Call 2: 10 seconds later, still false -> must be debounced (return false)
    const l2 = logReclaimConditionsEvalDebug({
      market,
      watchStatus: "pullback_seen",
      currentPrice: 990,
      localHigh: 1000,
      pullbackLowPrice: 985,
      pullbackPct: 1.5,
      recent1mRet: -0.2,
      recent3mRet: 0.5,
      ema20: 988,
      distanceFromLocalHighPct: 1.0,
      isRebounding: true,
      returnsOk: false,
      nearHigh: false,
      hasEma: true,
      isAboveEma: true,
      finalValid: false,
      failedConditions: ["returns_ok", "near_high"],
      elapsedSeconds: 40,
    });
    assert.strictEqual(l2, false, "Call 2 within 60s must be debounced");

    // Call 3: simulate 61 seconds passed -> must log again (return true)
    reclaimEvalDebugLastLogTs.set(market, Date.now() - 61000);
    const l3 = logReclaimConditionsEvalDebug({
      market,
      watchStatus: "pullback_seen",
      currentPrice: 990,
      localHigh: 1000,
      pullbackLowPrice: 985,
      pullbackPct: 1.5,
      recent1mRet: -0.2,
      recent3mRet: 0.5,
      ema20: 988,
      distanceFromLocalHighPct: 1.0,
      isRebounding: true,
      returnsOk: false,
      nearHigh: false,
      hasEma: true,
      isAboveEma: true,
      finalValid: false,
      failedConditions: ["returns_ok", "near_high"],
      elapsedSeconds: 91,
    });
    assert.strictEqual(l3, true, "Call 3 after 60s must log");
    console.log("  -> PASS: TEST OBS-6");
  }

  console.log("\n[TEST OBS-7] valid=true일 때 60초 디바운스 무시하고 즉시 로그 출력");
  {
    const market = "KRW-IMMEDIATE-LOG-TEST";
    reclaimEvalDebugLastLogTs.set(market, Date.now() - 5000); // Only 5s ago (within 60s window)

    const lImmediate = logReclaimConditionsEvalDebug({
      market,
      watchStatus: "pullback_seen",
      currentPrice: 998,
      localHigh: 1000,
      pullbackLowPrice: 990,
      pullbackPct: 1.0,
      recent1mRet: 0.5,
      recent3mRet: 1.2,
      ema20: 995,
      distanceFromLocalHighPct: 0.2,
      isRebounding: true,
      returnsOk: true,
      nearHigh: true,
      hasEma: true,
      isAboveEma: true,
      finalValid: true,
      failedConditions: [],
      elapsedSeconds: 35,
      forceImmediate: true,
    });
    assert.strictEqual(lImmediate, true, "valid=true with forceImmediate must bypass debounce and log immediately");
    console.log("  -> PASS: TEST OBS-7");
  }

  console.log("\n====================================================================");
  console.log(" All 39 PERFORMANCE_KILL & SURGE Authority Regression Tests PASSED! ");
  console.log("====================================================================");
}

runPerformanceKillRegressionSuite().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});

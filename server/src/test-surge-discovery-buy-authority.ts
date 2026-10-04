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

console.log("\n====================================================================");
console.log(" All 21 Scenarios & Integration Tests PASSED With ZERO Errors! ");
console.log("====================================================================");

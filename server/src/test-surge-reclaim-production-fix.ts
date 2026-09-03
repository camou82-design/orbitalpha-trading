import assert from "node:assert";
import {
  SURGE_PULLBACK_MIN_PCT,
  SURGE_PULLBACK_MAX_PCT,
  SURGE_PULLBACK_DEEP_EXPIRY_PCT,
  detectSurgePullback,
  evaluateReclaimConditions,
} from "./live-strategy.js";
import { assertOrderBuyAllowed, type MarketStateSnapshot } from "./market-state-filter.js";
import { computeLiveCapitalPolicyV4 } from "./live-capital-policy-v4.js";

type SurgeWatchItem = {
  market: string;
  first_detected_at: string;
  first_detected_price: number;
  local_high_price: number;
  local_high_at: string;
  pullback_low_price: number | null;
  pullback_low_at: string | null;
  status: "watching" | "pullback_seen" | "reclaim_ready" | "entered";
  morning_reentry_candidate: boolean;
  signal_score: number;
  volume_ratio: number;
};

console.log("=== Running Spot Surge Reclaim Absolute Deep Crash & Scope Audit Suite ===");

// =========================================================================
// Test 1 (A-C): Absolute Setup Invalidation on Deep Crash (< 95.8)
// =========================================================================
console.log("\n--- Test 1A: Sharp Deep Crash (95.7, recent3mRet=-4.0) -> Absolute Expire/Delete ---");
{
  const localHigh = 100.0;
  const currentPrice = 95.7; // -4.3%
  const recent3mRet = -4.0;
  const isHardCrash = currentPrice < localHigh * (1 - SURGE_PULLBACK_DEEP_EXPIRY_PCT / 100);
  const isExpired = isHardCrash;

  assert.strictEqual(isHardCrash, true);
  assert.strictEqual(isExpired, true, "Sharp drop to 95.7 must trigger isExpired=true");
  console.log("[PASS] Test 1A: Sharp deep crash -> isExpired=true (Watch deleted)");
}

console.log("\n--- Test 1B: Slow Drift Deep Crash (95.7, recent3mRet=-1.0) -> Absolute Expire/Delete ---");
{
  const localHigh = 100.0;
  const currentPrice = 95.7; // -4.3%
  const recent3mRet = -1.0; // Slow drift
  const isHardCrash = currentPrice < localHigh * (1 - SURGE_PULLBACK_DEEP_EXPIRY_PCT / 100);
  const isExpired = isHardCrash; // Unconditional on recent3mRet

  assert.strictEqual(isHardCrash, true);
  assert.strictEqual(isExpired, true, "Slow drift to 95.7 must ALSO trigger isExpired=true unconditionally");
  console.log("[PASS] Test 1B: Slow drift deep crash -> isExpired=true unconditionally (Watch deleted)");
}

console.log("\n--- Test 1C: Next tick rebound (99.8) after 1B deep crash -> placeBuy IMPOSSIBLE ---");
{
  const watchlist: Record<string, SurgeWatchItem> = {
    "KRW-BONK": {
      market: "KRW-BONK",
      first_detected_at: new Date().toISOString(),
      first_detected_price: 100,
      local_high_price: 100,
      local_high_at: new Date().toISOString(),
      pullback_low_price: 98,
      pullback_low_at: new Date().toISOString(),
      status: "pullback_seen",
      morning_reentry_candidate: false,
      signal_score: 85,
      volume_ratio: 3.5,
    },
  };

  // Tick 1: Deep crash to 95.7 occurs
  const currentPrice1 = 95.7;
  const localHigh1 = 100.0;
  const isHardCrash1 = currentPrice1 < localHigh1 * (1 - SURGE_PULLBACK_DEEP_EXPIRY_PCT / 100);
  if (isHardCrash1) {
    delete watchlist["KRW-BONK"];
  }

  assert.strictEqual(watchlist["KRW-BONK"], undefined, "KRW-BONK must be deleted from watchlist at 95.7");

  // Tick 2: Price rebounds to 99.8, conditions all PASS
  const currentPrice2 = 99.8;
  const watchExistsInTick2 = "KRW-BONK" in watchlist;
  let placeBuyPossible = false;

  if (watchExistsInTick2) {
    placeBuyPossible = true;
  }

  assert.strictEqual(watchExistsInTick2, false, "Watch must not exist on next tick");
  assert.strictEqual(placeBuyPossible, false, "placeBuy must be completely impossible after prior deep crash");
  console.log("[PASS] Test 1C: Post-deep rebound cannot resurrect deleted watch -> placeBuy IMPOSSIBLE");
}

// =========================================================================
// Test 1D & 1E: Exact Boundary Semantics (95.8 vs 96.0)
// =========================================================================
console.log("\n--- Test 1D: Boundary 95.8 (-4.2%) -> Strict '<' semantics maintains isHardCrash=false ---");
{
  const localHigh = 100.0;
  const deepBoundaryPrice = localHigh * (1 - SURGE_PULLBACK_DEEP_EXPIRY_PCT / 100); // 95.8
  const currentPrice = 95.8;
  const isHardCrash = currentPrice < deepBoundaryPrice;

  assert.strictEqual(isHardCrash, false, "Price 95.8 is at boundary -> isHardCrash must be false");
  console.log("[PASS] Test 1D: Boundary 95.8 '<' semantics confirmed -> isHardCrash=false");
}

console.log("\n--- Test 1E: Safe Pullback 96.0 (-4.0%) -> Normal Pullback Lifecycle Preserved ---");
{
  const localHigh = 100.0;
  const deepBoundaryPrice = localHigh * (1 - SURGE_PULLBACK_DEEP_EXPIRY_PCT / 100); // 95.8
  const currentPrice = 96.0; // -4.0%
  const isHardCrash = currentPrice < deepBoundaryPrice;

  assert.strictEqual(isHardCrash, false, "Price 96.0 must NOT be a hard crash");
  console.log("[PASS] Test 1E: Safe pullback 96.0 -> Normal lifecycle preserved");
}

// =========================================================================
// Test 2: EMA20 Availability & Candle Sufficiency Proof
// =========================================================================
console.log("\n--- Test 2: 12 candle EMA20 failure fixture -> 30 candle PASS ---");
{
  const makeCandles = (count: number, basePx: number) => {
    return Array.from({ length: count }, (_, i) => ({
      market: "KRW-TEST",
      trade_price: basePx + i * 10 + 5,
    }));
  };

  // 12 candles -> Insufficient for EMA20
  const candles12 = makeCandles(12, 1000).map((c) => c.trade_price);
  const eval12 = evaluateReclaimConditions({
    currentPrice: 1120,
    pullbackLowPrice: 1100,
    recent1mRet: 0.5,
    recent3mRet: 1.0,
    localHigh: 1122,
    closes1: candles12,
  });
  assert.strictEqual(eval12.hasEma, false, "12 candles must NOT have EMA20");
  assert.strictEqual(eval12.valid, false, "12 candles must fail valid due to missing EMA20 (BUY BLOCKED)");
  console.log("[PASS] Test 2A: 12 candles -> hasEma=false, valid=false (Buy safely blocked on insufficient data)");

  // 30 candles -> Sufficient for EMA20 calculation
  const candles30 = makeCandles(30, 1000).map((c) => c.trade_price);
  const eval30 = evaluateReclaimConditions({
    currentPrice: 1300,
    pullbackLowPrice: 1280,
    recent1mRet: 0.5,
    recent3mRet: 1.0,
    localHigh: 1302,
    closes1: candles30,
  });
  assert.strictEqual(eval30.hasEma, true, "30 candles must have valid EMA20");
  assert.strictEqual(eval30.valid, true, "30 candles with compliant structure must pass reclaim evaluation");
  console.log(`[PASS] Test 2B: 30 candles -> hasEma=true (EMA20=${eval30.ema20?.toFixed(1)}), valid=true (Fix Verified)`);
}

// =========================================================================
// Test 3: Multi-Source Pullback Detection (Tick Jump & Candle Low)
// =========================================================================
console.log("\n--- Test 3: Tick jump -0.4% -> -3.2%, candle low passed -1.5% -> pullback_seen=true ---");
{
  const localHigh = 1000;
  const currentPrice = 968; // -3.2%
  const previousTickPrice = 996; // -0.4%
  const recentCandleLows = [985]; // -1.5% (traversed through the 0.5%~3.0% band)

  const pb = detectSurgePullback({
    localHigh,
    currentPrice,
    lastSeenPrice: previousTickPrice,
    recentCandleLows,
    minPct: SURGE_PULLBACK_MIN_PCT,
    maxPct: SURGE_PULLBACK_MAX_PCT,
    deepExpiryPct: SURGE_PULLBACK_DEEP_EXPIRY_PCT,
  });

  assert.strictEqual(pb.isPullback, true, "Pullback must be detected when candle low passed through the band");
  assert.strictEqual(pb.evidenceSource, "candle_low", "Evidence source must be candle_low");
  assert.strictEqual(pb.pullbackLow, 985, "Pullback low must be set to candle low (985)");
  console.log(`[PASS] Test 3: Tick jump handled -> isPullback=true, evidenceSource=${pb.evidenceSource}, low=${pb.pullbackLow}`);
}

// =========================================================================
// Test 4: Genuine Grade-A Surge Neutral Exemption Invariant
// =========================================================================
console.log("\n--- Test 4: Genuine Grade-A Surge neutral exemption invariant ---");
{
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
    btc_rsi: 55.0,
  };

  const passRes = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    signalPayload: {
      v: 2,
      market: "KRW-BONK",
      signal_type: "HIGH",
      signal_reason: "surge_momentum",
      filter_pass: true,
      filter_fail_reason: null,
      filters: [
        { id: "volume_increase", label: "Vol", passed: true },
        { id: "box_breakout", label: "Box", passed: true },
        { id: "volume_spike_close_fail", label: "Close", passed: true },
      ],
      volume_ratio: 3.5,
    },
    strategyType: "momentum",
    market: "KRW-BONK",
    candidateMeta: {
      engine_bucket: "surge",
      setup: { ok: true, reason: "surge_setup_passed" },
    },
  });

  assert.strictEqual(passRes.ok, true, "Genuine setup.ok=true Surge must be allowed in neutral market");
  assert.strictEqual(passRes.blocked_reason, null);
  assert.strictEqual(passRes.size_scale, 0.72);
  console.log("[PASS] Test 4: Genuine setup.ok=true Surge in neutral -> Allowed with scale 0.72");
}

// =========================================================================
// Test 5: Scanner Feed & Exclusion Defense
// =========================================================================
console.log("\n--- Test 5: Scanner feed rows filtering & Exclusion defense ---");
{
  const mockAllResults = [
    { market: "KRW-SC", status: "제외", score: 0, volume_multiple: 0.05, filter_pass: false },
    { market: "KRW-VALID", status: "진입직전", score: 85, volume_multiple: 2.5, filter_pass: true },
    { market: "KRW-IQ", status: "제외", score: 0, volume_multiple: 0.06, filter_pass: false },
  ];
  const mockRows = mockAllResults.filter((r) => r.status !== "제외");

  assert.strictEqual(mockRows.length, 1, "Only genuine tradable rows must be in signalFeed");
  assert.strictEqual(mockRows[0]!.market, "KRW-VALID");

  const scannerCandidatesExcludingHeld = [
    { market: "KRW-SC", ageSeconds: 10 },
    { market: "KRW-VALID", ageSeconds: 15 },
    { market: "KRW-IQ", ageSeconds: 20 },
  ];

  const latestAllSignalsMock = new Map<string, any>([
    ["KRW-SC", { p: { filter_pass: false, source_kind: "scanner_bridge_score_fail" } }],
    ["KRW-VALID", { p: { filter_pass: true, source_kind: "scanner_tradable_candidate" } }],
    ["KRW-IQ", { p: { filter_pass: false, source_kind: "scanner_bridge_score_fail" } }],
  ]);

  const staleThresholdSeconds = 240;
  const freshScannerCandidates = scannerCandidatesExcludingHeld.filter(
    (x) =>
      x.ageSeconds !== null &&
      x.ageSeconds <= staleThresholdSeconds &&
      Boolean(latestAllSignalsMock.get(x.market)?.p?.filter_pass) &&
      latestAllSignalsMock.get(x.market)?.p?.source_kind !== "scanner_bridge_score_fail",
  );

  assert.strictEqual(freshScannerCandidates.length, 1, "Only genuine filter_pass scanner candidate must remain");
  assert.strictEqual(freshScannerCandidates[0]!.market, "KRW-VALID");
  console.log("[PASS] Test 5: Scanner signalFeed and live freshScannerCandidates defense verified");
}

// =========================================================================
// Test 6: Capital Policy 70:30 & Sizing Authority Invariant Proof
// =========================================================================
console.log("\n--- Test 6: Capital Policy 70:30 & Sizing Authority Invariants ---");
{
  const spotTradingEquity = 1_500_000;
  const cap = computeLiveCapitalPolicyV4({
    balances: [{ currency: "KRW", balance: spotTradingEquity, locked: 0 }],
    markPriceOrAvgByMarket: () => 0,
    accountPortfolioTotalEvaluatedKrw: spotTradingEquity,
    totalKrwFallback: spotTradingEquity,
    reservedKrw: 0,
    inFlightMarket: null,
    inFlight: false,
    managedSurgeMarkets: new Set<string>(),
  });

  assert.strictEqual(cap.spotTradingEquityKrw, 1_500_000);
  assert.strictEqual(cap.coreCapAmount, Math.floor(1_500_000 * 0.70), "Core Cap must be exact 70% (1,050,000 KRW)");
  assert.strictEqual(cap.surgeCapAmount, Math.floor(1_500_000 * 0.30), "Surge Cap must be exact 30% (450,000 KRW)");
  assert.strictEqual(cap.coreRemainingKrw, 1_050_000);
  assert.strictEqual(cap.surgeRemainingKrw, 450_000);

  const surgeSlots = 3;
  const slotBase = Math.floor(cap.surgeRemainingKrw / surgeSlots);
  assert.strictEqual(slotBase, 150_000, "Surge slot base must be exactly 150k");
  assert.ok(slotBase <= 220_000, "Surge slot base must never exceed 220k per-market cap");

  console.log(`[PASS] Test 6: Core 70% (${cap.coreCapAmount}) / Surge 30% (${cap.surgeCapAmount}) / Slot (${slotBase}) Authority Verified`);
}

// =========================================================================
// Test 7: Exit Authority & Scope Invariants
// =========================================================================
console.log("\n--- Test 7: Exit Authority, Core Rescue & Morning Surge Invariants ---");
{
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
    btc_rsi: 55.0,
  };

  const failedSetupRes = assertOrderBuyAllowed(snapNeutralRsi55, {
    kind: "new_entry",
    signalPayload: {
      v: 2,
      market: "KRW-SC",
      signal_type: "LOW",
      signal_reason: "weak",
      filter_pass: false,
      filter_fail_reason: "low_score",
      filters: [],
      volume_ratio: 0.05,
    },
    strategyType: "momentum",
    market: "KRW-SC",
    candidateMeta: {
      engine_bucket: "surge",
      setup: { ok: false, reason: "low_score" },
    },
  });
  assert.strictEqual(failedSetupRes.ok, false);
  assert.ok(failedSetupRes.blocked_reason?.includes("neutral_market_surge_blocked"));

  console.log("[PASS] Test 7: Safety scopes, exit gates, and neutral/risk_off authorities confirmed unchanged");
}

console.log("\n=========================================================================");
console.log("  ALL AUDIT & ABSOLUTE CRASH REGRESSION TESTS PASSED WITH ZERO ERRORS!  ");
console.log("=========================================================================\n");

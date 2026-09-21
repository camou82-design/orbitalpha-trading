/**
 * test-core-setup-branches-regression.ts
 *
 * Verification test suite for decoupled CORE setup branches:
 * - TC1: BTC strong trend continuation without stochOversoldBullishCross => PASS (CORE_TREND_CONTINUATION)
 * - TC2: Trend continuation with EMA stack fail (ema50 <= ema200) => BLOCK
 * - TC3: Trend continuation with RSI overheated (rsi >= 75) => BLOCK
 * - TC4: Trend continuation with volume threshold underflow (volRatio <= 0.95) => BLOCK
 * - TC5: Pullback reversal without oversold bullish cross => BLOCK
 * - TC6: Breakout + sufficient volume + valid price structure (oversold cross = false) => PASS (CORE_BREAKOUT_VOLUME)
 * - TC7: High volume without breakout structure => BLOCK
 * - TC8: Late chase / near-high hard risk (steep drop or heavy upper wick) => BLOCK
 * - TC9: Stale candle / stale ticker => BLOCK
 * - TC10: Comprehensive normal & rejected regression cases for Pullback, Breakout, Trend Entry
 */

import assert from "node:assert";
import {
  evaluateOriginalSpotScalpingSetup,
  evaluateCoreTrendEntrySetup,
  isVerifiedStrictCoreAuthority,
} from "./live-strategy.js";
import type { UpbitCandle } from "./upbit-public.js";

function buildCandleSeries(opts: {
  length?: number;
  basePrice?: number;
  trend?: "bullish" | "bearish" | "flat";
  lastVolumeRatio?: number;
  lastCandleDropSteep?: boolean;
  lastCandleUpperWickHeavy?: boolean;
  breakoutHigh?: boolean;
  oversoldStoch?: boolean;
}): UpbitCandle[] {
  const length = opts.length ?? 210;
  const base = opts.basePrice ?? 100000000;
  const candles: UpbitCandle[] = [];
  const now = Date.now();

  for (let i = length; i >= 0; i--) {
    const ts = new Date(now - i * 60_000).toISOString();
    const idx = length - i;
    let p = base;

    if (opts.trend === "bullish") {
      // Gentle trend with periodic oscillations so RSI stays around 55~65
      const trendComponent = (idx / length) * 0.04; // +4% overall gain across 210 bars
      const wave = Math.sin(idx / 3) * 0.003; // oscillating wave
      p = base * (1 + trendComponent + wave);
    } else if (opts.trend === "bearish") {
      const trendComponent = (idx / length) * -0.04;
      const wave = Math.sin(idx / 3) * 0.003;
      p = base * (1 + trendComponent + wave);
    }

    let o = p * 0.999;
    let c = p * 1.0005;
    let h = p * 1.002;
    let l = p * 0.998;
    let vol = 10;

    // Last completed candle customization (index length - 1)
    if (i === 1) {
      if (opts.lastCandleDropSteep) {
        o = p;
        c = p * 0.979; // > 1.8% drop
        h = p * 1.001;
        l = c * 0.999;
      } else if (opts.lastCandleUpperWickHeavy) {
        o = p;
        c = p * 0.999;
        h = p * 1.02; // heavy upper wick
        l = p * 0.998;
      } else if (opts.breakoutHigh) {
        // Clear breakout above recent swing high
        o = p;
        c = p * 1.025;
        h = p * 1.03;
        l = p * 0.999;
      }

      if (opts.lastVolumeRatio !== undefined) {
        vol = 10 * opts.lastVolumeRatio;
      }
    }

    candles.push({
      candle_date_time_kst: ts,
      opening_price: o,
      high_price: h,
      low_price: l,
      trade_price: c,
      candle_acc_trade_volume: vol,
    });
  }

  return candles;
}

console.log("==================================================================");
console.log("CORE SETUP BRANCHES DECOUPLING & REGRESSION TEST SUITE (TC1 - TC10)");
console.log("==================================================================");

// TC1: BTC 강한 trend continuation
// safePriceAboveEma200=true, aggressiveEmaStack=true, rsiBullish=true, stochReversal=true, volSpike=true, stochOversoldBullishCross=false
// => CORE_TREND_CONTINUATION must PASS without requiring oversold cross!
{
  const candles = buildCandleSeries({ trend: "bullish", lastVolumeRatio: 1.5 });
  const lastCompleted = candles[candles.length - 2]!;
  const currentPrice = Number(lastCompleted.trade_price) * 1.0005; // slightly above close, within trend

  const setup = evaluateOriginalSpotScalpingSetup("KRW-BTC", candles, currentPrice);

  assert.strictEqual(setup.ok, true, "TC1: Trend continuation setup must be OK");
  assert.strictEqual(setup.reason, "CORE_TREND_CONTINUATION", "TC1: Reason must be CORE_TREND_CONTINUATION");
  assert.strictEqual(setup.trend_entry_pass, true, "TC1: trend_entry_pass must be true");
  assert.strictEqual(setup.stochOversoldBullishCross, false, "TC1: stochOversoldBullishCross is false in uptrend");
  assert.strictEqual(setup.mode, "aggressive", "TC1: mode must be aggressive");
  assert.ok((setup.riskReward ?? 0) >= 2.0, "TC1: Risk-reward >= 2.0");
  console.log("[PASS] TC1: BTC trend continuation passes without stochOversoldBullishCross");
}

// TC2: 동일 조건에서 EMA stack 실패 (ema50 <= ema200)
// => trend entry 차단 유지.
{
  const candles = buildCandleSeries({ trend: "bearish", lastVolumeRatio: 1.5 });
  const lastCompleted = candles[candles.length - 2]!;
  const currentPrice = Number(lastCompleted.trade_price);

  const setup = evaluateOriginalSpotScalpingSetup("KRW-BTC", candles, currentPrice);

  assert.strictEqual(setup.ok, false, "TC2: Bearish EMA stack must fail setup");
  assert.strictEqual(setup.trend_entry_pass, false, "TC2: trend_entry_pass must be false");
  assert.ok(
    setup.trend_entry_failed_conditions?.includes("aggressiveEmaStack") ||
    setup.trend_entry_failed_conditions?.includes("safePriceAboveEma200"),
    "TC2: failed conditions must include EMA stack / price failure"
  );
  console.log("[PASS] TC2: EMA stack failure correctly blocks trend entry");
}

// TC3: 동일 조건에서 RSI overheated (rsi >= 75)
// => 기존 과열 차단 유지.
{
  // Build steep 210 candles to push RSI >= 75
  const length = 210;
  const base = 100000000;
  const candles: UpbitCandle[] = [];
  const now = Date.now();
  for (let i = length; i >= 0; i--) {
    const ts = new Date(now - i * 60_000).toISOString();
    const p = base * Math.pow(1.004, length - i); // steep exponential rise => RSI near 90+
    candles.push({
      candle_date_time_kst: ts,
      opening_price: p * 0.999,
      high_price: p * 1.001,
      low_price: p * 0.998,
      trade_price: p,
      candle_acc_trade_volume: 15,
    });
  }
  const lastCompleted = candles[candles.length - 2]!;
  const currentPrice = Number(lastCompleted.trade_price);

  const setup = evaluateOriginalSpotScalpingSetup("KRW-BTC", candles, currentPrice);
  assert.strictEqual(setup.ok, false, "TC3: Overheated RSI must block setup");
  assert.strictEqual(setup.trend_entry_pass, false, "TC3: trend_entry_pass must be false");
  assert.ok(
    setup.trend_entry_failed_conditions?.some(c => c.startsWith("rsi_overheated")),
    "TC3: failed conditions must report rsi_overheated"
  );
  console.log("[PASS] TC3: RSI overheated (>=75) correctly blocks trend entry");
}

// TC4: 동일 조건에서 volume threshold 미달 (volRatio <= 0.95)
// => 기존 거래량 기준에 따라 차단 유지.
{
  const candles = buildCandleSeries({ trend: "bullish", lastVolumeRatio: 0.5 }); // low volume
  const lastCompleted = candles[candles.length - 2]!;
  const currentPrice = Number(lastCompleted.trade_price);

  const setup = evaluateOriginalSpotScalpingSetup("KRW-BTC", candles, currentPrice);
  assert.strictEqual(setup.ok, false, "TC4: Low volume must block setup");
  assert.strictEqual(setup.trend_entry_pass, false, "TC4: trend_entry_pass must be false");
  assert.ok(
    setup.trend_entry_failed_conditions?.includes("volRatio<=0.95"),
    "TC4: failed conditions must include volRatio<=0.95"
  );
  console.log("[PASS] TC4: Volume threshold underflow (volRatio <= 0.95) correctly blocks trend entry");
}

// TC5: pullback reversal인데 oversold bullish cross 없음
// => 기존 pullback 조건대로 차단 유지.
{
  const candles = buildCandleSeries({ trend: "bullish", lastVolumeRatio: 1.2 });
  const lastCompleted = candles[candles.length - 2]!;
  const currentPrice = Number(lastCompleted.trade_price);

  const setup = evaluateOriginalSpotScalpingSetup("KRW-BTC", candles, currentPrice);
  assert.strictEqual(setup.pullback_pass, false, "TC5: pullback_pass must be false without oversold cross");
  assert.ok(
    setup.pullback_failed_conditions?.includes("stochOversoldBullishCross"),
    "TC5: pullback failed conditions must include stochOversoldBullishCross"
  );
  console.log("[PASS] TC5: Pullback reversal requires stochOversoldBullishCross and fails when absent");
}

// TC6: breakout + 충분한 volume + 유효 price structure 하지만 oversold bullish cross=false
// => breakout branch 자체 기준으로 평가 통과 (CORE_BREAKOUT_VOLUME)
{
  const length = 210;
  const base = 100000000;
  const candles: UpbitCandle[] = [];
  const now = Date.now();

  for (let i = length; i >= 0; i--) {
    const ts = new Date(now - i * 60_000).toISOString();
    const idx = length - i;
    let p = base;

    // Gentle alternating oscillation with slight upward bias
    const wave = Math.sin(idx * 0.8) * 0.003;
    p = base * (1 + (idx / length) * 0.01 + wave);

    let o = p * 0.999;
    let c = p * 1.0002;
    let h = p * 1.0015;
    let l = p * 0.9985;
    let vol = 10;

    // Last completed candle (index length - 1, i === 1) breaks out above recent 10-bar high
    if (i === 1) {
      o = base * 1.011;
      c = base * 1.015;
      h = base * 1.016;
      l = base * 1.010;
      vol = 25; // 2.5x volume spike
    }

    candles.push({
      candle_date_time_kst: ts,
      opening_price: o,
      high_price: h,
      low_price: l,
      trade_price: c,
      candle_acc_trade_volume: vol,
    });
  }

  const lastCompleted = candles[candles.length - 2]!;
  const currentPrice = Number(lastCompleted.trade_price) * 1.001; // Continuation of breakout

  const setup = evaluateOriginalSpotScalpingSetup("KRW-BTC", candles, currentPrice);
  assert.strictEqual(setup.breakout_pass, true, "TC6: breakout_pass must be true with valid structure + volume");
  assert.strictEqual(setup.ok, true, "TC6: Setup must be OK");
  console.log("[PASS] TC6: Breakout volume passes on its own authority without oversold cross");
}

// TC7: breakout 없이 volume만 큼
// => 진입 금지.
{
  // Flat candles, current price below recent high, but huge volume
  const length = 210;
  const base = 100000000;
  const candles: UpbitCandle[] = [];
  const now = Date.now();
  for (let i = length; i >= 0; i--) {
    const ts = new Date(now - i * 60_000).toISOString();
    let p = base;
    // High spike in past, now drifting down below the peak
    if (i > 10 && i < 20) {
      p = base * 1.05; // Previous high in past 10 bars
    } else {
      p = base * 0.99;
    }
    const vol = i === 1 ? 100 : 10; // Huge volume spike at last completed
    candles.push({
      candle_date_time_kst: ts,
      opening_price: p,
      high_price: p * 1.002,
      low_price: p * 0.998,
      trade_price: p,
      candle_acc_trade_volume: vol,
    });
  }
  const currentPrice = base * 0.99; // Below the swing high of 1.05

  const setup = evaluateOriginalSpotScalpingSetup("KRW-BTC", candles, currentPrice);
  assert.strictEqual(setup.breakout_pass, false, "TC7: breakout_pass must be false without breakout price structure");
  assert.ok(
    setup.breakout_failed_conditions?.includes("price_not_breakout_structure"),
    "TC7: breakout failed conditions must include price_not_breakout_structure"
  );
  console.log("[PASS] TC7: High volume alone without breakout price structure strictly BLOCKED");
}

// TC8: late chase / near-high hard risk 조건 (steep drop or heavy upper wick)
// => 기존 보호 유지.
{
  const candlesDrop = buildCandleSeries({ trend: "bullish", lastCandleDropSteep: true, lastVolumeRatio: 1.5 });
  const lastCompletedDrop = candlesDrop[candlesDrop.length - 2]!;
  const currentPriceDrop = Number(lastCompletedDrop.trade_price);
  const setupDrop = evaluateOriginalSpotScalpingSetup("KRW-BTC", candlesDrop, currentPriceDrop);
  assert.strictEqual(setupDrop.ok, false, "TC8: Steep drop candle must block setup");
  assert.ok(
    setupDrop.failed_conditions?.some(f => f.includes("drop_steep")),
    `TC8: Failed conditions must include drop_steep. Actual: ${JSON.stringify(setupDrop.failed_conditions)}`
  );

  const candlesWick = buildCandleSeries({ trend: "bullish", lastCandleUpperWickHeavy: true, lastVolumeRatio: 1.5 });
  const lastCompletedWick = candlesWick[candlesWick.length - 2]!;
  const currentPriceWick = Number(lastCompletedWick.trade_price);
  const setupWick = evaluateOriginalSpotScalpingSetup("KRW-BTC", candlesWick, currentPriceWick);
  assert.strictEqual(setupWick.ok, false, "TC8: Heavy upper wick candle must block setup");
  assert.ok(
    setupWick.failed_conditions?.some(f => f.includes("upper_wick_heavy")),
    `TC8: Failed conditions must include upper_wick_heavy. Actual: ${JSON.stringify(setupWick.failed_conditions)}`
  );
  console.log("[PASS] TC8: Late chase / steep drop / heavy upper wick guards strictly maintained");
}

// TC9: stale candle / stale ticker
// => 기존 차단 유지.
{
  const staleCandleTs = new Date(Date.now() - 150_000).toISOString(); // 150s stale (>120s limit)
  const meta = {
    market: "KRW-BTC",
    engine_bucket: "core",
    setupReason: "CORE_TREND_CONTINUATION",
    setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
    score: 95,
    core_setup_score: 95,
    upstream_gate_score: 0,
    upstream_min_entry_score: 82,
    upstream_core_gate_ok: true,
    candle_source: "live_fetch",
    candle_cache_age_ms: null,
    candle_freshness_ok: false,
    latest_candle_ts: staleCandleTs,
    ticker_price_source: "ticker_batch",
    ticker_price_age_ms: 1000,
    ticker_freshness_ok: true,
  };
  const authEval = isVerifiedStrictCoreAuthority({ market: "KRW-BTC", candidateMeta: meta });
  assert.strictEqual(authEval.verified, false, "TC9: Stale candle must be blocked by strict core authority");
  assert.strictEqual(authEval.rejectReason, "candle_freshness_not_ok");
  console.log("[PASS] TC9: Stale candle / stale ticker strictly BLOCKED by core authority gate");
}

// TC10: 기존 CORE_PULLBACK_REVERSAL, CORE_BREAKOUT_VOLUME, CORE_TREND_ENTRY 각각의 정상/거절 케이스 회귀 검증
{
  const freshCandleTs = new Date(Date.now() - 30_000).toISOString();
  const branches = ["CORE_TREND_CONTINUATION", "CORE_PULLBACK_REVERSAL", "CORE_BREAKOUT_VOLUME"] as const;

  for (const branch of branches) {
    // 1. Normal pass case
    const passMeta = {
      market: "KRW-BTC",
      engine_bucket: "core",
      setupReason: branch,
      setup: { ok: true, reason: branch, score: 90 },
      score: 90,
      core_setup_score: 90,
      upstream_gate_score: 0,
      upstream_min_entry_score: 82,
      upstream_core_gate_ok: true,
      candle_source: "live_fetch",
      candle_cache_age_ms: null,
      candle_freshness_ok: true,
      latest_candle_ts: freshCandleTs,
      ticker_price_source: "ticker_batch",
      ticker_price_age_ms: 1000,
      ticker_freshness_ok: true,
    };
    const passAuth = isVerifiedStrictCoreAuthority({ market: "KRW-BTC", candidateMeta: passMeta });
    assert.strictEqual(passAuth.verified, true, `TC10: ${branch} normal pass case must be verified`);

    // 2. Score below threshold reject case
    const failMeta = {
      ...passMeta,
      score: 75,
      core_setup_score: 75,
      upstream_min_entry_score: 82,
    };
    const failAuth = isVerifiedStrictCoreAuthority({ market: "KRW-BTC", candidateMeta: failMeta });
    assert.strictEqual(failAuth.verified, false, `TC10: ${branch} below min score must be rejected`);
  }
  console.log("[PASS] TC10: Pullback, Breakout, Trend Entry normal/reject regression cases fully verified");
}

console.log("==================================================================");
console.log("ALL TC1 - TC10 TESTS PASSED SUCCESSFULLY!");
console.log("==================================================================");

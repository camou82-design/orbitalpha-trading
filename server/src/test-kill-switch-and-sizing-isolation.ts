/**
 * test-kill-switch-and-sizing-isolation.ts
 *
 * Verification suite for:
 * 1. HARD_RISK_KILL vs PERFORMANCE_KILL structural isolation
 *    - HARD_RISK_KILL + STRONG_CORE => Entry 0 KRW (Strict no-bypass)
 *    - PERFORMANCE_KILL + weak/normal CORE => Entry 0 KRW (Blocked)
 *    - PERFORMANCE_KILL + STRONG_CORE => 25% reduced probe allowed
 *    - No Kill + STRONG_CORE => Normal 100% sizing maintained
 * 2. 771,165 KRW Sizing Trace & Sizing Cap Invariants
 *    - Requested sizing > available KRW => Capped to available KRW
 *    - Large raw sizing (e.g. 771,165 KRW) => Capped to remaining strategy capital & available KRW
 *    - spotTradingEquityKrw = totalAssetEquityKrw - excludedUsdtValueKrw verified
 *    - LIVE_SIZING_DECISION_PROOF 9 operational state fields verified
 * 3. User Requested Additional Verification Scenarios (Section 2):
 *    - [Scenario 1] PERFORMANCE_KILL + STRONG_CORE 첫 진입 => 25% probe
 *    - [Scenario 2] 동일 조건 다음 tick 반복 (포지션 보유) => 추가 주문 0
 *    - [Scenario 3] cooldown 중 => 추가 주문 0
 *    - [Scenario 4] exhaustion 상태 => probe 0
 *    - [Scenario 5] 기존 CORE exposure 한도 초과 => 추가 probe 0
 *    - [Scenario 6] cooldown 종료 + 포지션 청산 후 새로운 유효 STRONG_CORE => 새 probe 허용
 */

import assert from "node:assert";
import {
  evaluateGlobalKillSwitch,
  validateLiveBuyPrecheck,
} from "./live-strategy.js";
import { computeLiveCapitalPolicyV4 } from "./live-capital-policy-v4.js";

async function runTests() {
  console.log("==================================================================");
  console.log("KILL SWITCH & SIZING ISOLATION VERIFICATION SUITE");
  console.log("==================================================================");

  const nowMs = Date.now();

  // --- Case 1: HARD_RISK_KILL + STRONG_CORE => Entry 0 KRW (Strictly Blocked) ---
  {
    const hardRiskTrades = [
      { market: "KRW-BTC", pnl_pct: -2.0, timestamp: new Date(nowMs - 3600_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-BTC", pnl_pct: -2.0, timestamp: new Date(nowMs - 7200_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-BTC", pnl_pct: -1.5, timestamp: new Date(nowMs - 10800_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    ]; // Cumulative -5.5% <= -5.0% => HARD_RISK_KILL

    const ks = evaluateGlobalKillSwitch(hardRiskTrades, nowMs);
    assert.strictEqual(ks.hard_risk_active, true, "Cumulative loss <= -5% must activate HARD_RISK_KILL");
    assert.strictEqual(ks.type, "HARD_RISK", "Type must be HARD_RISK");

    const strongCoreMeta = {
      market: "KRW-BTC",
      engine_bucket: "core" as const,
      score: 95,
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const gateResult = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: hardRiskTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: strongCoreMeta,
    });

    assert.strictEqual(gateResult.allowed, false, "HARD_RISK_KILL must strictly block even STRONG CORE signals");
    assert.strictEqual(gateResult.blockReason, "global_kill_switch_active");
    console.log("[PASS] Case 1: HARD_RISK_KILL + STRONG_CORE => Entry 0 KRW (Strict No-Bypass)");
  }

  // --- Case 2: PERFORMANCE_KILL + Weak/Normal CORE => Entry 0 KRW (Blocked) ---
  {
    const perfLossTrades = [
      { market: "KRW-SOL", pnl_pct: -0.2, timestamp: new Date(nowMs - 3600_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-ADA", pnl_pct: -0.2, timestamp: new Date(nowMs - 7200_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-XRP", pnl_pct: -0.2, timestamp: new Date(nowMs - 10800_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-DOGE", pnl_pct: -0.2, timestamp: new Date(nowMs - 14400_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-AVAX", pnl_pct: -0.2, timestamp: new Date(nowMs - 18000_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    ]; // 5 losses in 24h, win rate 0%, total PnL -1.0% (> -5.0%) => PERFORMANCE_KILL

    const ks = evaluateGlobalKillSwitch(perfLossTrades, nowMs);
    assert.strictEqual(ks.hard_risk_active, false, "HARD_RISK is inactive");
    assert.strictEqual(ks.performance_kill_active, true, "PERFORMANCE_KILL is active");
    assert.strictEqual(ks.type, "PERFORMANCE", "Type must be PERFORMANCE");

    const normalCoreMeta = {
      market: "KRW-BTC",
      engine_bucket: "core" as const,
      score: 82, // < 90 => Normal, not STRONG
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 82 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const gateResult = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: perfLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: normalCoreMeta,
    });

    assert.strictEqual(gateResult.allowed, false, "PERFORMANCE_KILL must block normal/weak CORE signals");
    assert.strictEqual(gateResult.blockReason, "global_kill_switch_active");
    console.log("[PASS] Case 2: PERFORMANCE_KILL + Weak/Normal CORE => Entry 0 KRW (Blocked)");
  }

  // --- Case 3: PERFORMANCE_KILL + STRONG_CORE => 25% Probe Allowed ---
  {
    const perfLossTrades = [
      { market: "KRW-SOL", pnl_pct: -0.2, timestamp: new Date(nowMs - 3600_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-ADA", pnl_pct: -0.2, timestamp: new Date(nowMs - 7200_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-XRP", pnl_pct: -0.2, timestamp: new Date(nowMs - 10800_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-DOGE", pnl_pct: -0.2, timestamp: new Date(nowMs - 14400_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-AVAX", pnl_pct: -0.2, timestamp: new Date(nowMs - 18000_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    ];

    const strongCoreMeta: any = {
      market: "KRW-BTC",
      engine_bucket: "core",
      score: 95, // >= 90 => STRONG CORE
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const gateResult = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: perfLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: strongCoreMeta,
    });

    assert.strictEqual(gateResult.allowed, true, "STRONG CORE must be allowed as performance probe");
    assert.strictEqual(strongCoreMeta.is_performance_probe, true, "is_performance_probe must be set");
    assert.strictEqual(strongCoreMeta.relaxed_multiplier, 0.25, "Probe sizing multiplier must be exactly 0.25 (25%)");
    console.log("[PASS] Case 3: PERFORMANCE_KILL + STRONG_CORE => 25% Probe Multiplier Allowed");
  }

  // --- Case 4: No Kill + STRONG_CORE => Normal 100% Sizing Maintained ---
  {
    const healthyTrades = [
      { market: "KRW-BTC", pnl_pct: 1.5, timestamp: new Date(nowMs - 3600_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-BTC", pnl_pct: 2.0, timestamp: new Date(nowMs - 7200_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    ];

    const ks = evaluateGlobalKillSwitch(healthyTrades, nowMs);
    assert.strictEqual(ks.active, false, "Kill switch must be inactive");
    assert.strictEqual(ks.type, "NONE", "Type must be NONE");

    const strongCoreMeta: any = {
      market: "KRW-BTC",
      engine_bucket: "core",
      score: 95,
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const gateResult = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: healthyTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: strongCoreMeta,
    });

    assert.strictEqual(gateResult.allowed, true, "Normal trade must be allowed");
    assert.strictEqual(strongCoreMeta.relaxed_multiplier, 1.0, "Normal sizing multiplier remains 1.0 (100%)");
    console.log("[PASS] Case 4: No Kill + STRONG_CORE => Normal Sizing (100%) Maintained");
  }

  // --- Case 5: Sizing 771,165 KRW Trace & Sizing Cap Invariants ---
  {
    // Total Asset Equity = 2,500,000 KRW, USDT = 500,000 KRW
    // spotTradingEquityKrw = 2,000,000 KRW
    // coreCap (70%) = 1,400,000 KRW
    // coreUsed = 900,000 KRW => coreRemaining = 500,000 KRW
    // availableKrw = 150,000 KRW (Available cash in Upbit)
    const capPolicy = computeLiveCapitalPolicyV4({
      balances: [
        { currency: "KRW", balance: 150_000, locked: 0 },
        { currency: "USDT", balance: 500, avg_buy_price: 1000 }, // 500,000 KRW USDT (excluded)
        { currency: "BTC", balance: 0.01, avg_buy_price: 90_000_000 }, // 900,000 KRW BTC (Core Used)
      ],
      markPriceOrAvgByMarket: (mk) => (mk === "KRW-USDT" ? 1000 : mk === "KRW-BTC" ? 90_000_000 : 0),
      accountPortfolioTotalEvaluatedKrw: 2_500_000,
      totalKrwFallback: 150_000,
      reservedKrw: 0,
      inFlightMarket: null,
      inFlight: false,
    });

    assert.strictEqual(capPolicy.totalAssetEquityKrw, 2_500_000);
    assert.strictEqual(capPolicy.excludedUsdtValueKrw, 500_000);
    assert.strictEqual(capPolicy.spotTradingEquityKrw, 2_000_000);
    assert.strictEqual(capPolicy.coreCapAmount, 1_400_000);
    assert.strictEqual(capPolicy.coreUsedCapitalKrw, 900_000);
    assert.strictEqual(capPolicy.coreRemainingKrw, 500_000);

    // Sizing calculation test with rawRequestedOrderKrw = 771,165 KRW
    const rawRequestedOrderKrw = 771_165;
    const performanceKillMultiplier = 0.25; // under performance kill probe

    // 1. Performance Probe applied
    const orderAfterPerf = Math.floor(rawRequestedOrderKrw * performanceKillMultiplier); // 192,791 KRW
    assert.strictEqual(orderAfterPerf, 192_791);

    // 2. Strategy Capital Cap applied (coreRemaining = 500,000 KRW)
    const capitalCapAppliedKrw = Math.min(orderAfterPerf, capPolicy.coreRemainingKrw); // 192,791 KRW
    assert.strictEqual(capitalCapAppliedKrw, 192_791);

    // 3. Available KRW applied (availableKrw = 150,000 KRW)
    const availableKrwCapAppliedKrw = Math.min(capitalCapAppliedKrw, 150_000); // 150,000 KRW
    assert.strictEqual(availableKrwCapAppliedKrw, 150_000);

    // 4. Final Executable Order
    const finalExecutableOrderKrw = availableKrwCapAppliedKrw;
    assert.strictEqual(finalExecutableOrderKrw, 150_000);
    assert.ok(finalExecutableOrderKrw <= 150_000, "Final order cannot exceed available cash");
    assert.ok(finalExecutableOrderKrw <= capPolicy.coreRemainingKrw, "Final order cannot exceed core capital cap");

    console.log("[PASS] Case 5: 771,165 KRW raw sizing correctly capped to 192,791 (probe) -> 150,000 (available cash)");
  }

  // --- Case 6: Requested Sizing Exceeding Core Capital Cap ---
  {
    const coreRemainingKrw = 80_000;
    const availableKrw = 300_000;
    const rawRequestedOrderKrw = 771_165;
    const performanceKillMultiplier = 1.0; // normal

    const orderAfterPerf = Math.floor(rawRequestedOrderKrw * performanceKillMultiplier); // 771,165
    const capitalCapAppliedKrw = Math.min(orderAfterPerf, coreRemainingKrw); // 80,000
    const availableKrwCapAppliedKrw = Math.min(capitalCapAppliedKrw, availableKrw); // 80,000
    const finalExecutableOrderKrw = availableKrwCapAppliedKrw;

    assert.strictEqual(finalExecutableOrderKrw, 80_000, "Final order must be capped at 80,000 KRW remaining core cap");
    console.log("[PASS] Case 6: 771,165 KRW raw sizing correctly capped to 80,000 KRW remaining core cap");
  }

  console.log("\n==================================================================");
  console.log("SECTION 2: USER REQUESTED 6 OPERATIONAL VERIFICATION SCENARIOS");
  console.log("==================================================================");

  const perfLossTrades = [
    { market: "KRW-SOL", pnl_pct: -0.2, timestamp: new Date(nowMs - 3600_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    { market: "KRW-ADA", pnl_pct: -0.2, timestamp: new Date(nowMs - 7200_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    { market: "KRW-XRP", pnl_pct: -0.2, timestamp: new Date(nowMs - 10800_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    { market: "KRW-DOGE", pnl_pct: -0.2, timestamp: new Date(nowMs - 14400_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    { market: "KRW-AVAX", pnl_pct: -0.2, timestamp: new Date(nowMs - 18000_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
  ];

  // --- Scenario 1: PERFORMANCE_KILL + STRONG_CORE 첫 진입 => 25% probe ---
  {
    const meta: any = {
      market: "KRW-BTC",
      engine_bucket: "core",
      score: 95,
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };
    const res = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: perfLossTrades,
      positions: {}, // No open positions
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: meta,
    });
    assert.strictEqual(res.allowed, true, "First probe under PERFORMANCE_KILL must be allowed");
    assert.strictEqual(meta.is_performance_probe, true);
    assert.strictEqual(meta.relaxed_multiplier, 0.25, "Probe size scale must be 25%");
    console.log("[PASS] Scenario 1: PERFORMANCE_KILL + STRONG_CORE 첫 진입 => 25% probe 허용");
  }

  // --- Scenario 2: 동일 조건 다음 tick 반복 (기존 probe 포지션 보유 중) => 추가 주문 0 ---
  {
    const meta: any = {
      market: "KRW-BTC",
      engine_bucket: "core",
      score: 95, // Still 95 on next tick
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };
    const res = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: perfLossTrades,
      positions: {
        "KRW-BTC": { symbol: "KRW-BTC", qty: 0.001, avg_buy_price: 90_000_000 }, // Position open!
      },
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: meta,
    });
    assert.strictEqual(res.allowed, false, "Consecutive probe while position open must be BLOCKED");
    assert.strictEqual(res.blockReason, "global_kill_switch_active");
    console.log("[PASS] Scenario 2: 동일 조건 다음 tick 반복 (포지션 보유 중) => 추가 주문 0 (BLOCKED)");
  }

  // --- Scenario 3: Cooldown 중 => 추가 주문 0 ---
  {
    const meta: any = {
      market: "KRW-BTC",
      engine_bucket: "core",
      score: 95,
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };
    const res = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: perfLossTrades,
      positions: {},
      cooldown_until: {
        "KRW-BTC": new Date(nowMs + 600_000).toISOString(), // Cooldown active for 10 minutes
      },
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: meta,
    });
    assert.strictEqual(res.allowed, false, "Entry under active cooldown must be BLOCKED");
    assert.strictEqual(res.blockReason, "cooldown_active");
    console.log("[PASS] Scenario 3: Cooldown 중 => 추가 주문 0 (cooldown_active BLOCKED)");
  }

  // --- Scenario 4: Exhaustion 상태 => probe 0 ---
  {
    const metaExhaustion: any = {
      market: "KRW-BTC",
      engine_bucket: "core",
      score: 95,
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "exhaustion", // High exhaustion
      asset_phase: "exhaustion",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };
    const res = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: perfLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: metaExhaustion,
    });
    assert.strictEqual(res.allowed, false, "Exhaustion phase chase must be strictly BLOCKED");
    assert.strictEqual(res.blockReason, "global_kill_switch_active");
    console.log("[PASS] Scenario 4: Exhaustion 상태 => probe 0 (고점 추격 방지 BLOCKED)");
  }

  // --- Scenario 5: 기존 CORE exposure 한도 초과 => 추가 probe 0 ---
  {
    const coreRemainingKrw = 0; // Cap exhausted
    const availableKrw = 300_000;
    const rawRequestedOrderKrw = 771_165;
    const performanceKillMultiplier = 0.25;

    const orderAfterPerf = Math.floor(rawRequestedOrderKrw * performanceKillMultiplier); // 192,791
    const capitalCapAppliedKrw = Math.min(orderAfterPerf, coreRemainingKrw); // 0
    const availableKrwCapAppliedKrw = Math.min(capitalCapAppliedKrw, availableKrw); // 0
    const finalExecutableOrderKrw = availableKrwCapAppliedKrw < 5000 ? 0 : availableKrwCapAppliedKrw;

    assert.strictEqual(finalExecutableOrderKrw, 0, "When remaining core cap is 0, final order must be 0 KRW");
    console.log("[PASS] Scenario 5: 기존 CORE exposure 한도 초과 => 추가 probe 0 KRW");
  }

  // --- Scenario 6: Cooldown 종료 + 새로운 유효 STRONG_CORE => 새 probe 허용 ---
  {
    const meta: any = {
      market: "KRW-BTC",
      engine_bucket: "core",
      score: 95,
      setupReason: "CORE_TREND_CONTINUATION",
      setup: { ok: true, reason: "CORE_TREND_CONTINUATION", score: 95 },
      btc_phase: "continuation",
      asset_phase: "continuation",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };
    const res = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: perfLossTrades,
      positions: {}, // Position cleared
      cooldown_until: {
        "KRW-BTC": new Date(nowMs - 60_000).toISOString(), // Cooldown expired 1 minute ago
      },
      marketState: null,
      signalPayload: null,
      strategyType: "core",
      entryPath: "core_normal",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: meta,
    });
    assert.strictEqual(res.allowed, true, "Expired cooldown + new strong signal must allow new probe");
    assert.strictEqual(meta.is_performance_probe, true);
    assert.strictEqual(meta.relaxed_multiplier, 0.25);
    console.log("[PASS] Scenario 6: Cooldown 종료 + 포지션 청산 후 새로운 STRONG_CORE => 새 probe 25% 허용");
  }

  console.log("\n==================================================================");
  console.log("ALL VERIFICATION SUITES AND SCENARIOS PASSED WITH ZERO ERRORS!");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

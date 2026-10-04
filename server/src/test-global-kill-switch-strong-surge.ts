/**
 * test-global-kill-switch-strong-surge.ts
 *
 * Dedicated verification suite for Orbitalpha Spot Global Kill Switch Policy:
 *
 * Tests:
 * A. cumulative <= -5%, 3 trades => hard_risk_active: false, performance_kill_active: true
 * B. Existing Strong CORE + PERFORMANCE_KILL => allowed: true, relaxed_multiplier: 0.25
 * C. Strong SURGE reproduction (KRW-AXS: score=100, surge_v2_entry_path, scanner=true, early=true, btc=neutral, asset=impulse, panic=false)
 *    => allowed: true, relaxed_multiplier: 0.25, is_performance_probe: true
 * D. SURGE score < 90 => blocked
 * E. SURGE authority missing / false (scanner or surge authority) => blocked
 * F. SURGE exhaustion/retrace or unsafe phase => blocked
 * G. Strong SURGE with panic=true => HARD_RISK blocked
 * H. Strong SURGE with daily PnL hard limit reached => HARD_RISK blocked
 * I. Invalid sizing / relaxed_multiplier authority => HARD_RISK blocked
 * J. Concurrent performance probe limit (1 active probe position already open) => 2nd probe blocked
 */

import assert from "node:assert";
import {
  evaluateGlobalKillSwitch,
  validateLiveBuyPrecheck,
} from "./live-strategy.js";

async function runTests() {
  console.log("==================================================================");
  console.log("GLOBAL KILL SWITCH & STRONG SURGE VERIFICATION SUITE");
  console.log("==================================================================");

  const nowMs = Date.now();

  // Common cumulative loss trade history: 4 trades over recent 48h, cumulative PnL = -5.80%
  const cumulativeLossTrades = [
    { market: "KRW-AXS", pnl_pct: -1.5, timestamp: new Date(nowMs - 3600_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 10 },
    { market: "KRW-SAND", pnl_pct: -1.8, timestamp: new Date(nowMs - 7200_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 10 },
    { market: "KRW-BTC", pnl_pct: -1.2, timestamp: new Date(nowMs - 14400_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.001 },
    { market: "KRW-ETH", pnl_pct: -1.3, timestamp: new Date(nowMs - 28800_000).toISOString(), action: "sell", order_krw: 100000, filled_qty: 0.01 },
  ]; // Total -5.80% <= -5.0%, count = 4 >= 3

  // --------------------------------------------------------------------------
  // Test A: Cumulative <= -5%, 3 trades => hard_risk_active: false, performance_kill_active: true
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test A: Cumulative PnL <= -5.0% Classification ---");
    const ks = evaluateGlobalKillSwitch(cumulativeLossTrades, nowMs);
    assert.strictEqual(ks.hard_risk_active, false, "Cumulative loss <= -5% must NOT activate HARD_RISK");
    assert.strictEqual(ks.performance_kill_active, true, "Cumulative loss <= -5% must activate PERFORMANCE_KILL");
    assert.strictEqual(ks.type, "PERFORMANCE", "Kill switch type must be PERFORMANCE");
    assert.strictEqual(ks.active, true, "Kill switch active must be true");
    console.log("[PASS] Test A: Classified as PERFORMANCE_KILL, not HARD_RISK");
  }

  // --------------------------------------------------------------------------
  // Test B: Existing Strong CORE + PERFORMANCE_KILL => probe allowed, size 0.25
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test B: Existing Strong CORE + PERFORMANCE_KILL ---");
    const strongCoreMeta: any = {
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

    const res = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: cumulativeLossTrades,
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

    assert.strictEqual(res.allowed, true, "Strong CORE must be allowed under PERFORMANCE_KILL");
    assert.strictEqual(strongCoreMeta.relaxed_multiplier, 0.25, "Probe size must be 0.25");
    assert.strictEqual(strongCoreMeta.is_recovery_probe, true, "is_recovery_probe must be true");
    assert.strictEqual(strongCoreMeta.is_performance_probe, true, "is_performance_probe must be true");
    console.log("[PASS] Test B: Strong CORE recovery probe preserved with 25% sizing");
  }

  // --------------------------------------------------------------------------
  // Test C: Strong SURGE Reproduction (KRW-AXS Case) => probe allowed, size 0.25
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test C: Strong SURGE Reproduction (KRW-AXS: btc=neutral, asset=impulse) ---");
    const strongSurgeMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: true,
      early_surge_authority: true,
      validated_surge_authority: false,
      btc_phase: "neutral", // Neutral BTC must NOT block Strong SURGE!
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const res = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: strongSurgeMeta,
    });

    assert.strictEqual(res.allowed, true, "Strong SURGE must be allowed under PERFORMANCE_KILL");
    assert.strictEqual(strongSurgeMeta.relaxed_multiplier, 0.25, "Probe size must be scaled to 0.25");
    assert.strictEqual(strongSurgeMeta.is_recovery_probe, true, "is_recovery_probe must be true");
    assert.strictEqual(strongSurgeMeta.is_performance_probe, true, "is_performance_probe must be true");
    console.log("[PASS] Test C: Strong SURGE (KRW-AXS) recovery probe successfully ALLOWED with 25% sizing");
  }

  // --------------------------------------------------------------------------
  // Test D: SURGE score < 90 => blocked
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test D: SURGE score < 90 => Blocked ---");
    const lowScoreSurgeMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 85, // < 90
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 85 },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const res = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: lowScoreSurgeMeta,
    });

    assert.strictEqual(res.allowed, false, "SURGE score < 90 must be blocked");
    assert.strictEqual(res.blockReason, "global_kill_switch_active", "Reason must indicate kill switch block");
    console.log("[PASS] Test D: Weak score SURGE blocked under PERFORMANCE_KILL");
  }

  // --------------------------------------------------------------------------
  // Test E: SURGE authority missing / false => blocked
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test E: SURGE authority missing / false => Blocked ---");
    // E1: scanner_authority = false
    const noScannerMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: false,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const resE1 = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: noScannerMeta,
    });
    assert.strictEqual(resE1.allowed, false, "SURGE without scanner authority must be blocked");
    assert.strictEqual(resE1.blockReason, "global_kill_switch_active", "Reason must be kill switch block");

    // E2: surge authority (early / validated) missing
    const noSurgeAuthMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: true,
      early_surge_authority: false,
      validated_surge_authority: false,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const resE2 = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: noSurgeAuthMeta,
    });
    assert.strictEqual(resE2.allowed, false, "SURGE without surge authority must be blocked");
    assert.strictEqual(resE2.blockReason, "global_kill_switch_active", "Reason must be kill switch block");
    console.log("[PASS] Test E: Missing scanner/surge authority correctly blocked");
  }

  // --------------------------------------------------------------------------
  // Test F: SURGE exhaustion/retrace or unsafe phase => blocked
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test F: SURGE exhaustion/retrace unsafe phase => Blocked ---");
    // F1: exhaustion
    const exhaustionMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "exhaustion",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const resF1 = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: exhaustionMeta,
    });
    assert.strictEqual(resF1.allowed, false, "SURGE in exhaustion phase must be blocked");
    assert.strictEqual(resF1.blockReason, "global_kill_switch_active", "Reason must be kill switch block");

    // F2: retrace
    const retraceMeta: any = {
      ...exhaustionMeta,
      asset_phase: "retrace",
    };
    const resF2 = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: retraceMeta,
    });
    assert.strictEqual(resF2.allowed, false, "SURGE in retrace phase must be blocked");
    assert.strictEqual(resF2.blockReason, "global_kill_switch_active", "Reason must be kill switch block");
    console.log("[PASS] Test F: Exhaustion and Retrace phases correctly blocked");
  }

  // --------------------------------------------------------------------------
  // Test G: Strong SURGE with panic=true => HARD_RISK blocked
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test G: Strong SURGE with panic=true => HARD_RISK Blocked ---");
    const panicSurgeMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: true, // Panic active!
      relaxed_multiplier: 1.0,
    };

    const res = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: panicSurgeMeta,
    });

    assert.strictEqual(res.allowed, false, "Panic state must strictly block entry");
    assert.strictEqual(res.blockReason, "global_kill_switch_active", "Reason must be kill switch block");
    console.log("[PASS] Test G: Strong SURGE under panic blocked by HARD_RISK");
  }

  // --------------------------------------------------------------------------
  // Test H: Strong SURGE with daily PnL hard limit reached => HARD_RISK blocked
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test H: Strong SURGE with daily PnL limit reached => HARD_RISK Blocked ---");
    const strongSurgeMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const res = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: -5.5, // Exceeds default -3.0% / -2.5% daily limit
      candidateMeta: strongSurgeMeta,
    });

    assert.strictEqual(res.allowed, false, "Daily PnL hard limit must strictly block entry");
    assert.strictEqual(res.blockReason, "daily_pnl_limit_reached", "Reason must be daily_pnl_limit_reached");
    console.log("[PASS] Test H: Daily PnL hard limit triggers HARD_RISK block");
  }

  // --------------------------------------------------------------------------
  // Test I: Invalid sizing / relaxed_multiplier authority => HARD_RISK blocked
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test I: Invalid relaxed_multiplier authority => HARD_RISK Blocked ---");
    const invalidMultiplierMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: -0.5, // Invalid negative multiplier!
    };

    const res = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: invalidMultiplierMeta,
    });

    assert.strictEqual(res.allowed, false, "Invalid relaxed multiplier must block entry");
    assert.strictEqual(res.blockReason, "global_kill_switch_active", "Reason must be kill switch block");
    console.log("[PASS] Test I: Invalid sizing multiplier triggers HARD_RISK block");
  }

  // --------------------------------------------------------------------------
  // Test J: Concurrent performance probe limit (1 active probe position already open) => 2nd probe blocked
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test J: Concurrent probe limit (1 probe already open => 2nd probe blocked) ---");
    // Existing active position marked as performance probe
    const existingProbePositions: any = {
      "KRW-BTC": {
        market: "KRW-BTC",
        amount_krw: 25000,
        current_price: 90000000,
        qty: 0.00027,
        avg_price: 90000000,
        is_performance_probe: true,
        is_recovery_probe: true,
      },
    };

    const strongSurgeMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const res = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: existingProbePositions,
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: strongSurgeMeta,
    });

    assert.strictEqual(res.allowed, false, "Second probe must be blocked when 1 probe already open");
    assert.strictEqual(res.blockReason, "global_kill_switch_active", "Reason must indicate kill switch block");
    console.log("[PASS] Test J: Concurrent performance probe limit (max 1) successfully enforced");
  }

  // --------------------------------------------------------------------------
  // Test K: Negative Regression - source_kind === "scanner_tradable_candidate" only
  // (explicit scanner authority missing/false) => strictly BLOCKED
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test K: Negative Regression (source_kind only, no explicit scanner authority => BLOCKED) ---");
    const sourceKindOnlyMeta: any = {
      market: "KRW-AXS",
      engine_bucket: "surge" as const,
      score: 100,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 100 },
      scanner_authority: false, // Explicit scanner authority is false
      source_kind: "scanner_tradable_candidate", // Only source_kind fallback present
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0,
    };

    const res = await validateLiveBuyPrecheck({
      market: "KRW-AXS",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: sourceKindOnlyMeta,
    });

    assert.strictEqual(res.allowed, false, "SURGE with only source_kind and no explicit scanner authority must be BLOCKED");
    assert.strictEqual(res.blockReason, "global_kill_switch_active", "Reason must be kill switch block");
    console.log("[PASS] Test K: source_kind-only fallback strictly BLOCKED without explicit scanner authority");
  }

  console.log("\n==================================================================");
  console.log("ALL 11 TESTS (A through K) PASSED WITH ZERO ERRORS!");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

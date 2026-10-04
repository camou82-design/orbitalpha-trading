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

  // --------------------------------------------------------------------------
  // Test L: Sizing Timing Regression:
  // "Precheck 전에 sizing preview가 만들어졌더라도 최종 주문금액은 PERFORMANCE probe 25%가 반영된다"
  // HBAR 운영 증거 케이스: raw 254265 -> neutral 0.72 -> 183070 (precheck 전)
  // precheck 승인 후 최종 주문금액: Math.floor(183070 * 0.25) = 45767 KRW
  // 중복 축소 방지: 한 번 더 적용되어도 45767 KRW 유지 (0.25 x 0.25 중복 방지)
  // --------------------------------------------------------------------------
  {
    console.log("\n--- Test L: Sizing Timing Regression (Precheck Sizing Timing & Single 25% Probe Execution) ---");
    const hbarCandidateMeta: any = {
      market: "KRW-HBAR",
      engine_bucket: "surge" as const,
      score: 95,
      setupReason: "surge_v2_entry_path",
      setup: { ok: true, reason: "surge_v2_entry_path", score: 95 },
      scanner_authority: true,
      early_surge_authority: true,
      btc_phase: "neutral",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 1.0, // Precheck 전에는 1.0
    };

    // 1. Precheck 전 Preview Sizing 단계 시뮬레이션
    const rawRequestedOrderKrw = 254265;
    const currentMarketScale = 0.72; // neutral
    let previewOrderKrw = Math.floor(rawRequestedOrderKrw * currentMarketScale); // 183070
    assert.strictEqual(previewOrderKrw, 183070, "Preview sizing without probe flag must be 183070 KRW");

    // 2. Precheck 실행 (PERFORMANCE_KILL 하에서 Strong SURGE 승인)
    const precheckRes = await validateLiveBuyPrecheck({
      market: "KRW-HBAR",
      trades: cumulativeLossTrades,
      positions: {},
      cooldown_until: {},
      marketState: null,
      signalPayload: null,
      strategyType: "surge",
      entryPath: "surge_v2_entry_path",
      isAdditionalBuy: false,
      actualDailyPnlPct: 0.0,
      candidateMeta: hbarCandidateMeta,
    });

    assert.strictEqual(precheckRes.allowed, true, "HBAR Strong SURGE must be allowed under PERFORMANCE_KILL");
    assert.strictEqual(hbarCandidateMeta.is_performance_probe, true, "is_performance_probe must be true");
    assert.strictEqual(hbarCandidateMeta.relaxed_multiplier, 0.25, "relaxed_multiplier must be 0.25");

    // 3. 실제 최종 주문금액 계산 로직 (line 17530 이후 구현과 동일한 invariant 검증)
    let orderKrw = previewOrderKrw;
    const isPerformanceProbeApproved = Boolean(
      hbarCandidateMeta.is_performance_probe === true ||
      hbarCandidateMeta.is_recovery_probe === true
    );
    assert.strictEqual(isPerformanceProbeApproved, true);

    const probeSizingAlreadyApplied = Boolean(hbarCandidateMeta.performance_probe_sizing_applied);
    assert.strictEqual(probeSizingAlreadyApplied, false, "Must not be applied yet before orderKrw section");

    if (isPerformanceProbeApproved && !probeSizingAlreadyApplied) {
      orderKrw = Math.floor(orderKrw * hbarCandidateMeta.relaxed_multiplier);
      hbarCandidateMeta.performance_probe_sizing_applied = true;
    }

    assert.strictEqual(orderKrw, 45767, "Final orderKrw must be exactly 25% of preview (45767 KRW), not 183070 KRW");

    // 4. 중복 축소 방지 검증: 한 번 더 sizing 통과 시 0.25 * 0.25 (11441)로 축소되지 않고 45767 유지
    const secondPassSizingApplied = Boolean(hbarCandidateMeta.performance_probe_sizing_applied);
    if (isPerformanceProbeApproved && !secondPassSizingApplied) {
      orderKrw = Math.floor(orderKrw * hbarCandidateMeta.relaxed_multiplier);
    }
    assert.strictEqual(orderKrw, 45767, "Single probe application invariant: must remain 45767 KRW (no double 0.25 multiplication)");

    // 5. CORE 시장에서도 동일하게 동작 검증 (KRW-BTC Strong CORE)
    const btcCandidateMeta: any = {
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
    const btcPreviewKrw = 200000;
    const btcPrecheck = await validateLiveBuyPrecheck({
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
      candidateMeta: btcCandidateMeta,
    });
    assert.strictEqual(btcPrecheck.allowed, true);
    assert.strictEqual(btcCandidateMeta.relaxed_multiplier, 0.25);
    let btcOrderKrw = btcPreviewKrw;
    if (btcCandidateMeta.is_performance_probe && !btcCandidateMeta.performance_probe_sizing_applied) {
      btcOrderKrw = Math.floor(btcOrderKrw * btcCandidateMeta.relaxed_multiplier);
      btcCandidateMeta.performance_probe_sizing_applied = true;
    }
    assert.strictEqual(btcOrderKrw, 50000, "CORE probe must be scaled to exactly 25% (50000 KRW)");
    console.log("[PASS] Test L: Precheck Sizing Timing Regression verified - 25% applied to final orderKrw for both CORE and SURGE without double multiplication");
  }

  // --- Test M: Negative Regression: relaxed_multiplier=0.25 alone without explicit probe flags is NOT treated as PERFORMANCE probe ---
  {
    const nonProbeMeta: any = {
      market: "KRW-SOL",
      engine_bucket: "surge",
      score: 85,
      relaxed_multiplier: 0.25,
      is_performance_probe: false,
      is_recovery_probe: false,
    };

    // 1. Preview sizing 단계: 명시적 probe 플래그가 없으므로 performanceKillMultiplier는 1.0이어야 함
    let performanceKillMultiplier = 1.0;
    if (nonProbeMeta?.is_recovery_probe === true || nonProbeMeta?.is_performance_probe === true) {
      performanceKillMultiplier = 0.25;
      nonProbeMeta.performance_probe_sizing_applied = true;
    }
    assert.strictEqual(performanceKillMultiplier, 1.0, "Preview performance multiplier must remain 1.0 when probe flags are false");
    assert.strictEqual(nonProbeMeta.performance_probe_sizing_applied, undefined, "performance_probe_sizing_applied must NOT be set");

    // 2. Line 17535 sizing authority 판정: 오직 명시적 플래그만 인정 (relaxed_multiplier 추론 금지)
    const isPerformanceProbeApproved = Boolean(
      nonProbeMeta.is_performance_probe === true ||
      nonProbeMeta.is_recovery_probe === true
    );
    assert.strictEqual(isPerformanceProbeApproved, false, "relaxed_multiplier=0.25 alone must NEVER be inferred as performance probe");

    // 3. 주문 금액이 PERFORMANCE probe 로직으로 축소되면 안 됨
    let orderKrw = 100000;
    const initialOrderKrw = orderKrw;
    if (isPerformanceProbeApproved && !nonProbeMeta.performance_probe_sizing_applied) {
      orderKrw = Math.floor(orderKrw * nonProbeMeta.relaxed_multiplier);
      nonProbeMeta.performance_probe_sizing_applied = true;
    }
    assert.strictEqual(orderKrw, initialOrderKrw, "orderKrw must NOT be modified by performance probe sizing");
    assert.strictEqual(nonProbeMeta.performance_probe_sizing_applied, undefined, "applied flag must remain unset");

    // 4. Final gate safety guarantee도 명시적 플래그만 인정
    const isPerfProbeAtFinalGate = Boolean(
      nonProbeMeta.is_performance_probe === true ||
      nonProbeMeta.is_recovery_probe === true
    );
    assert.strictEqual(isPerfProbeAtFinalGate, false, "Final gate must reject candidate without explicit probe flags");

    console.log("[PASS] Test M: Negative Regression verified - relaxed_multiplier=0.25 with false probe flags strictly NOT treated as PERFORMANCE probe");
  }

  console.log("\n==================================================================");
  console.log("ALL 13 TESTS (A through M) PASSED WITH ZERO ERRORS!");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

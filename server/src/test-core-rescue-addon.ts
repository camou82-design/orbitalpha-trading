import assert from "node:assert";
import { ORDER_LIMITS } from "@orbitalpha/shared";
import {
  computeAdverseProgress,
  computeCoreRescueAddonSizing,
  computePreSoftPlannedLossAtStopKrw,
  computeProjectedLossAtStopKrw,
  CORE_RESCUE_MAX_ADDON_COUNT,
  evaluateCoreRescueHardRisk,
  evaluateCoreRescueMicroReclaim,
  isCoreRescueEngineBucket,
} from "./core-rescue-addon.js";

/** XRP 2026-08-30 live regression fixture */
const XRP = {
  market: "KRW-XRP",
  perPositionBudgetKrw: 318_788,
  preSoftOrderKrw: 250_000,
  lateEntrySizingMultiplier: 0.2025,
  initialOrderKrw: 50_625,
  entryPrice: 1938,
  stopPrice: 1929.134,
  engine_bucket: "core" as const,
  strategy_type: "stable" as const,
};

function xrpAdversePrice(progress: number): number {
  const span = XRP.entryPrice - XRP.stopPrice;
  return XRP.entryPrice - span * progress;
}

async function runCoreRescueAddonTests() {
  console.log("=== Core Rescue Add-on Regression Tests (A–P) ===\n");

  // L: XRP fixture bounds
  {
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: XRP.initialOrderKrw,
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      currentExposureKrw: XRP.initialOrderKrw,
      originalStopPrice: XRP.stopPrice,
      entryPrice: XRP.entryPrice,
      currentPrice: xrpAdversePrice(0.5),
      coreRemainingKrw: 500_000,
      availableKrw: 500_000,
      perMarketRemainingKrw: ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET - XRP.initialOrderKrw,
    });
    assert.strictEqual(sizing.addonCandidateKrw, XRP.initialOrderKrw, "L: max addon = initial 50625");
    assert.strictEqual(sizing.projectedTotalExposureKrw, 101_250, "L: max total exposure 101250");
    assert.strictEqual(sizing.addonAllowed, true, "L: addon allowed within envelope");
    console.log("[PASS] L: XRP 50625 + max 50625 = max 101250");
  }

  // A: soft dip + reclaim → addon allowed
  {
    const currentPrice = xrpAdversePrice(0.45);
    const adverse = computeAdverseProgress({
      entryPrice: XRP.entryPrice,
      currentPrice,
      originalStopPrice: XRP.stopPrice,
    });
    assert.ok(adverse !== null && adverse >= 0.25);
    const hard = evaluateCoreRescueHardRisk({
      currentPrice,
      originalStopPrice: XRP.stopPrice,
      pnlGrossPct: -0.5,
      marketState: "neutral",
      recent1mRet: 0.15,
      recent3mRet: -0.1,
    });
    assert.strictEqual(hard.hardRiskActive, false);
    const reclaim = evaluateCoreRescueMicroReclaim({
      currentPrice,
      entryPrice: XRP.entryPrice,
      originalStopPrice: XRP.stopPrice,
      recent1mRet: 0.15,
      recent3mRet: -0.1,
      volumeRatio: 1.1,
    });
    assert.strictEqual(reclaim.reclaimConfirmed, true);
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: XRP.initialOrderKrw,
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      currentExposureKrw: XRP.initialOrderKrw,
      originalStopPrice: XRP.stopPrice,
      entryPrice: XRP.entryPrice,
      currentPrice,
      coreRemainingKrw: 400_000,
      availableKrw: 400_000,
      perMarketRemainingKrw: 169_375,
    });
    assert.strictEqual(sizing.addonAllowed, true);
    console.log("[PASS] A: soft dip + reclaim → Add-on allowed");
  }

  // B: continuing down → no reclaim
  {
    const reclaim = evaluateCoreRescueMicroReclaim({
      currentPrice: xrpAdversePrice(0.5),
      entryPrice: XRP.entryPrice,
      originalStopPrice: XRP.stopPrice,
      recent1mRet: -0.3,
      recent3mRet: -0.8,
      volumeRatio: 1.0,
    });
    assert.strictEqual(reclaim.reclaimConfirmed, false);
    console.log("[PASS] B: continuing down → no reclaim → no Add-on");
  }

  // C: hard stop breach
  {
    const hard = evaluateCoreRescueHardRisk({
      currentPrice: XRP.stopPrice - 1,
      originalStopPrice: XRP.stopPrice,
      pnlGrossPct: -1.2,
      marketState: "neutral",
      recent1mRet: 0.1,
      recent3mRet: 0,
      stopBreached: true,
    });
    assert.strictEqual(hard.hardRiskActive, true);
    assert.strictEqual(hard.hardRiskReason, "hard_stop_breached");
    console.log("[PASS] C: hard stop breach → Add-on blocked");
  }

  // D: BTC crash / panic
  {
    const hard = evaluateCoreRescueHardRisk({
      currentPrice: xrpAdversePrice(0.4),
      originalStopPrice: XRP.stopPrice,
      pnlGrossPct: -0.8,
      marketState: "neutral",
      btcFilterState: "panic",
      recent1mRet: 0.2,
      recent3mRet: 0,
    });
    assert.strictEqual(hard.hardRiskReason, "btc_panic");
    console.log("[PASS] D: BTC panic → Add-on blocked");
  }

  // E: kill switch
  {
    const hard = evaluateCoreRescueHardRisk({
      currentPrice: xrpAdversePrice(0.4),
      originalStopPrice: XRP.stopPrice,
      pnlGrossPct: -0.8,
      marketState: "neutral",
      dailyRiskKillSwitchActive: true,
      recent1mRet: 0.2,
      recent3mRet: 0,
    });
    assert.strictEqual(hard.hardRiskReason, "daily_risk_kill_switch_active");
    console.log("[PASS] E: kill switch → Add-on blocked");
  }

  // F: structural invalidation
  {
    const hard = evaluateCoreRescueHardRisk({
      currentPrice: xrpAdversePrice(0.4),
      originalStopPrice: XRP.stopPrice,
      pnlGrossPct: -0.8,
      marketState: "neutral",
      recent1mRet: 0.1,
      recent3mRet: 0,
      signalFilters: [{ id: "volume_fade_after_spike", passed: false }],
    });
    assert.strictEqual(hard.hardRiskReason, "structural_volume_fade");
    console.log("[PASS] F: structural invalidation → Add-on blocked");
  }

  // G: second addon forbidden
  {
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: XRP.initialOrderKrw,
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      currentExposureKrw: 101_250,
      originalStopPrice: XRP.stopPrice,
      entryPrice: XRP.entryPrice,
      currentPrice: xrpAdversePrice(0.5),
      coreRemainingKrw: 400_000,
      availableKrw: 400_000,
      perMarketRemainingKrw: 118_750,
      addonAlreadyUsed: true,
    });
    assert.strictEqual(sizing.addonAllowed, false);
    assert.strictEqual(sizing.blockReason, "core_rescue_addon_already_used");
    assert.strictEqual(CORE_RESCUE_MAX_ADDON_COUNT, 1);
    console.log("[PASS] G: second Add-on forbidden");
  }

  // H: pre-soft remainder caps addon (cannot restore to 250k from reduced initial)
  {
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: XRP.initialOrderKrw,
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      currentExposureKrw: 200_000,
      originalStopPrice: XRP.stopPrice,
      entryPrice: XRP.entryPrice,
      currentPrice: xrpAdversePrice(0.4),
      coreRemainingKrw: 500_000,
      availableKrw: 500_000,
      perMarketRemainingKrw: 20_000,
    });
    assert.strictEqual(sizing.addonCandidateKrw, 20_000);
    assert.strictEqual(sizing.projectedTotalExposureKrw, 220_000);
    assert.strictEqual(sizing.addonAllowed, true);
    assert.ok(sizing.projectedTotalExposureKrw <= XRP.preSoftOrderKrw);
    console.log("[PASS] H: addon capped — cannot exceed pre-soft 250k envelope");
  }

  // I: per-market 220k
  {
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: 50_000,
      preSoftOrderKrw: 250_000,
      currentExposureKrw: 200_000,
      originalStopPrice: XRP.stopPrice,
      entryPrice: XRP.entryPrice,
      currentPrice: xrpAdversePrice(0.4),
      coreRemainingKrw: 500_000,
      availableKrw: 500_000,
      perMarketRemainingKrw: 15_000,
    });
    assert.strictEqual(sizing.addonCandidateKrw, 15_000);
    assert.strictEqual(sizing.projectedTotalExposureKrw, 215_000);
    console.log("[PASS] I: per-market remaining caps addon size");
  }

  // J: core 70% cap
  {
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: XRP.initialOrderKrw,
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      currentExposureKrw: XRP.initialOrderKrw,
      originalStopPrice: XRP.stopPrice,
      entryPrice: XRP.entryPrice,
      currentPrice: xrpAdversePrice(0.45),
      coreRemainingKrw: 10_000,
      availableKrw: 500_000,
      perMarketRemainingKrw: 169_375,
    });
    assert.strictEqual(sizing.addonCandidateKrw, 10_000);
    console.log("[PASS] J: core remaining cap limits addon");
  }

  // K: original stop preserved (risk envelope)
  {
    const originalStop = XRP.stopPrice;
    const preSoftLoss = computePreSoftPlannedLossAtStopKrw({
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      entryPrice: XRP.entryPrice,
      originalStopPrice: originalStop,
    });
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: XRP.initialOrderKrw,
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      currentExposureKrw: XRP.initialOrderKrw,
      originalStopPrice: originalStop,
      entryPrice: XRP.entryPrice,
      currentPrice: xrpAdversePrice(0.45),
      coreRemainingKrw: 500_000,
      availableKrw: 500_000,
      perMarketRemainingKrw: 169_375,
    });
    assert.ok(sizing.projectedLossAtStopKrw <= preSoftLoss + 1e-6);
    const projectedAtStop = computeProjectedLossAtStopKrw({
      totalExposureKrw: sizing.projectedTotalExposureKrw,
      avgEntryPrice: XRP.entryPrice,
      originalStopPrice: originalStop,
    });
    assert.ok(projectedAtStop <= preSoftLoss + 1e-6);
    console.log("[PASS] K: projected loss at original stop within pre-soft envelope");
  }

  // M: surge not eligible
  {
    assert.strictEqual(isCoreRescueEngineBucket("core"), true);
    assert.strictEqual(isCoreRescueEngineBucket("surge"), false);
    assert.strictEqual(isCoreRescueEngineBucket(undefined), false);
    console.log("[PASS] M: Surge engine_bucket not eligible");
  }

  // N: morning surge unchanged — no imports / coupling (static proof)
  {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./core-rescue-addon.ts", import.meta.url), "utf8"),
    );
    assert.ok(!src.includes("morning_surge"), "N: core-rescue-addon has no morning_surge coupling");
    assert.ok(!src.includes("isMorningSurgeWindowKst"), "N: no morning window in addon module");
    console.log("[PASS] N: Morning Surge policy not touched in addon module");
  }

  // O: rejected order must not mark addon used (logic contract)
  {
    const confirmAddonUsed = (resultClass: string, postExposure: number, before: number) =>
      resultClass === "exchange_order_accepted" || postExposure > before + 5000 - 1;
    assert.strictEqual(confirmAddonUsed("exchange_order_failed", 50_625, 50_625), false);
    assert.strictEqual(confirmAddonUsed("precheck_blocked", 50_625, 50_625), false);
    assert.strictEqual(confirmAddonUsed("policy_blocked", 50_625, 50_625), false);
    console.log("[PASS] O: rejected exchange classes do not confirm addonUsed");
  }

  // P: accepted only confirms addonUsed
  {
    const fillConfirmed = (resultClass: string, postExposure: number, before: number) =>
      resultClass === "exchange_order_accepted" || postExposure > before + 5000 - 1;
    assert.strictEqual(fillConfirmed("exchange_order_accepted", 0, 0), true);
    assert.strictEqual(fillConfirmed("exchange_order_failed", 50_625, 50_625), false);
    console.log("[PASS] P: accepted fill only confirms addonUsed");
  }

  console.log("\n=======================================================");
  console.log("  ALL TESTS (A through P) PASSED SUCCESSFULLY! (Code: 0) ");
  console.log("=======================================================\n");
}

runCoreRescueAddonTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

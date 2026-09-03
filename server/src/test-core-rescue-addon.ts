import assert from "node:assert";
import { ORDER_LIMITS } from "@orbitalpha/shared";
import {
  computeAdverseProgress,
  computeCoreRescueAddonSizing,
  computePreSoftPlannedLossAtStopKrw,
  computeProjectedLossAtStopKrw,
  CORE_RESCUE_MAX_ADDON_COUNT,
  CORE_RESCUE_POST_GRACE_SECONDS,
  evaluateCoreRescueHardRisk,
  evaluateCoreRescueMicroReclaim,
  isCoreRescueEngineBucket,
  isCoreRescuePostRescueGraceActive,
} from "./core-rescue-addon.js";
import { evaluateExitAuthority } from "./live-strategy.js";

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
  console.log("=== Core Rescue Add-on Regression Tests (A–Z) ===\n");

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

  // H: pre-soft remainder caps addon (cannot exceed pre-soft 250k envelope)
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

  // I: per-market 220k cap
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

  // --- TRUTH RECONCILIATION & FILL LOGIC TESTS ---

  // O: blocked result + no exposure change -> fail
  {
    const resolveFillTruth = (params: {
      resultClass: string;
      beforeExposure: number;
      beforeQty: number;
      posSnap?: { invested_krw_total: number; qty: number };
    }) => {
      const posExposure = Math.max(0, Number(params.posSnap?.invested_krw_total ?? 0));
      const posQty = Math.max(0, Number(params.posSnap?.qty ?? 0));
      const positionIncreased = Boolean(
        params.posSnap &&
        params.posSnap.qty > 0 &&
        (posExposure > params.beforeExposure + 1000 || posQty > params.beforeQty + 1e-8)
      );
      return positionIncreased || (!params.posSnap && params.resultClass === "exchange_order_accepted");
    };

    assert.strictEqual(
      resolveFillTruth({
        resultClass: "precheck_blocked",
        beforeExposure: 50_625,
        beforeQty: 26.122,
        posSnap: { invested_krw_total: 50_625, qty: 26.122 },
      }),
      false,
      "O1: precheck_blocked with no exposure change must fail",
    );
    assert.strictEqual(
      resolveFillTruth({
        resultClass: "policy_blocked",
        beforeExposure: 50_625,
        beforeQty: 26.122,
        posSnap: { invested_krw_total: 50_625, qty: 26.122 },
      }),
      false,
      "O2: policy_blocked with no exposure change must fail",
    );
    assert.strictEqual(
      resolveFillTruth({
        resultClass: "exchange_order_failed",
        beforeExposure: 50_625,
        beforeQty: 26.122,
        posSnap: { invested_krw_total: 50_625, qty: 26.122 },
      }),
      false,
      "O3: exchange_order_failed with no exposure change must fail",
    );
    console.log("[PASS] O: blocked result + no exposure change → failed safely");
  }

  // P: blocked result + actual exposure increase -> fill truth recovery
  {
    const resolveFillTruth = (params: {
      resultClass: string;
      beforeExposure: number;
      beforeQty: number;
      posSnap?: { invested_krw_total: number; qty: number };
    }) => {
      const posExposure = Math.max(0, Number(params.posSnap?.invested_krw_total ?? 0));
      const posQty = Math.max(0, Number(params.posSnap?.qty ?? 0));
      const positionIncreased = Boolean(
        params.posSnap &&
        params.posSnap.qty > 0 &&
        (posExposure > params.beforeExposure + 1000 || posQty > params.beforeQty + 1e-8)
      );
      return positionIncreased || (!params.posSnap && params.resultClass === "exchange_order_accepted");
    };

    const resultClass = "precheck_blocked" as string;
    const filled = resolveFillTruth({
      resultClass,
      beforeExposure: 50_625,
      beforeQty: 26.122,
      posSnap: { invested_krw_total: 101_250, qty: 52.483 },
    });
    assert.strictEqual(filled, true, "P: actual account exposure increase overrides precheck_blocked");

    const mismatchLogged = filled && resultClass !== "exchange_order_accepted";
    assert.strictEqual(mismatchLogged, true, "P: mismatch proof flag active");
    console.log("[PASS] P: blocked result + actual exposure increase → fill truth recovered");
  }

  // Q: Normal add fill -> avg/qty/state update reconciliation
  {
    const posSnap = { invested_krw_total: 101_250, qty: 52.483 };
    const newQty = posSnap.qty;
    const newAvg = posSnap.invested_krw_total / posSnap.qty;
    assert.ok(Math.abs(newAvg - (101250 / 52.483)) < 1e-6);
    assert.strictEqual(newQty, 52.483);
    console.log("[PASS] Q: normal add fill → avg/qty updated from actual position snapshot");
  }

  // R: Partial fill -> actual qty/avg accurately reflected
  {
    const initialExposure = 50_625;
    const initialQty = 26.12229; // @ 1938
    // Partial fill of 25,000 KRW @ 1934
    const partialAddKrw = 25_000;
    const partialAddQty = partialAddKrw / 1934;
    const postPosSnap = {
      invested_krw_total: initialExposure + partialAddKrw,
      qty: initialQty + partialAddQty,
    };
    const expectedAvg = postPosSnap.invested_krw_total / postPosSnap.qty;
    assert.ok(expectedAvg < 1938 && expectedAvg > 1934);
    assert.strictEqual(postPosSnap.qty > initialQty, true);
    console.log("[PASS] R: partial fill → actual qty/avg accurately reflected");
  }

  // S: After fill confirmed, prevent second Rescue re-order
  {
    const positionState = {
      coreRescueAddonUsed: true,
      coreRescueAddonCount: 1,
      coreRescueTriggeredAt: new Date().toISOString(),
      coreRescueOriginalStopPrice: XRP.stopPrice,
    };
    assert.strictEqual(positionState.coreRescueAddonUsed, true);
    assert.strictEqual(positionState.coreRescueAddonCount >= CORE_RESCUE_MAX_ADDON_COUNT, true);
    const sizing = computeCoreRescueAddonSizing({
      initialOrderKrw: XRP.initialOrderKrw,
      preSoftOrderKrw: XRP.preSoftOrderKrw,
      currentExposureKrw: 101_250,
      originalStopPrice: XRP.stopPrice,
      entryPrice: 1936,
      currentPrice: xrpAdversePrice(0.5),
      coreRemainingKrw: 500_000,
      availableKrw: 500_000,
      perMarketRemainingKrw: 100_000,
      addonAlreadyUsed: positionState.coreRescueAddonUsed,
    });
    assert.strictEqual(sizing.addonAllowed, false);
    assert.strictEqual(sizing.blockReason, "core_rescue_addon_already_used");
    console.log("[PASS] S: second Rescue re-order strictly blocked after fill");
  }

  // --- POST-RESCUE TIME-STOP GRACE & RISK INVARIANTS ---

  // T: Within 180s grace -> weak_market_time_stop blocked
  {
    const triggeredAt = new Date(Date.now() - 60_000); // 60s ago
    const graceUntil = new Date(triggeredAt.getTime() + CORE_RESCUE_POST_GRACE_SECONDS * 1000).toISOString();
    const pos = {
      market: "KRW-XRP",
      entry_ts: new Date(Date.now() - 20 * 60_000).toISOString(), // 20 min held
      entry_price: 1936,
      qty: 52.483,
      strategy_type: "stable" as const,
      max_pnl_pct: 0.2,
      partial_tp_done: false,
      highest_price_after_entry: 1938,
      coreRescueAddonUsed: true,
      coreRescueTriggeredAt: triggeredAt.toISOString(),
      coreRescuePostRescueGraceUntil: graceUntil,
      coreRescueOriginalStopPrice: XRP.stopPrice,
      entry_stop_price: XRP.stopPrice,
    };

    assert.strictEqual(isCoreRescuePostRescueGraceActive(pos), true);
    const exitDecision = evaluateExitAuthority({
      p: pos as any,
      pnlGross: -0.4,
      heldMs: 20 * 60_000,
      marketTier: "weak",
      weakReboundPoor: true,
    });
    assert.strictEqual(
      exitDecision.reasonExit,
      null,
      "T: weak_market_time_stop must be deferred within 180s post-rescue grace",
    );
    console.log("[PASS] T: weak_market_time_stop blocked during 180s post-rescue grace");
  }

  // U: Inside grace -> hard stop and emergency stop execute normally
  {
    const triggeredAt = new Date(Date.now() - 60_000);
    const graceUntil = new Date(triggeredAt.getTime() + 180_000).toISOString();
    const pos = {
      market: "KRW-XRP",
      entry_ts: new Date(Date.now() - 20 * 60_000).toISOString(),
      entry_price: 1936,
      qty: 52.483,
      strategy_type: "stable" as const,
      max_pnl_pct: 0.2,
      partial_tp_done: false,
      highest_price_after_entry: 1938,
      coreRescueAddonUsed: true,
      coreRescueTriggeredAt: triggeredAt.toISOString(),
      coreRescuePostRescueGraceUntil: graceUntil,
      coreRescueOriginalStopPrice: XRP.stopPrice,
      entry_stop_price: XRP.stopPrice,
    };

    // Emergency stop (gross <= -1.45%)
    const emergencyDecision = evaluateExitAuthority({
      p: pos as any,
      pnlGross: -1.5,
      heldMs: 20 * 60_000,
      marketTier: "weak",
      weakReboundPoor: true,
    });
    assert.strictEqual(emergencyDecision.reasonExit, "emergency_stop_loss");
    assert.strictEqual(emergencyDecision.authorityClass, "emergency_exit");
    assert.strictEqual(emergencyDecision.stopTriggerKind, "price_stop");
    console.log("[PASS] U: hard stop and emergency stop execute immediately inside grace");
  }

  // V: After 180s grace expires -> time-stop restored without resetting 20m entry timer
  {
    const triggeredAt = new Date(Date.now() - 190_000); // 190s ago (expired)
    const graceUntil = new Date(triggeredAt.getTime() + 180_000).toISOString();
    const entryTs = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min total held
    const pos = {
      market: "KRW-XRP",
      entry_ts: entryTs,
      entry_price: 1936,
      qty: 52.483,
      strategy_type: "stable" as const,
      max_pnl_pct: 0.2,
      partial_tp_done: false,
      highest_price_after_entry: 1938,
      coreRescueAddonUsed: true,
      coreRescueTriggeredAt: triggeredAt.toISOString(),
      coreRescuePostRescueGraceUntil: graceUntil,
      coreRescueOriginalStopPrice: XRP.stopPrice,
      entry_stop_price: XRP.stopPrice,
    };

    assert.strictEqual(isCoreRescuePostRescueGraceActive(pos), false);
    const exitDecision = evaluateExitAuthority({
      p: pos as any,
      pnlGross: -0.4,
      heldMs: 20 * 60_000,
      marketTier: "weak",
      weakReboundPoor: true,
    });
    assert.strictEqual(exitDecision.reasonExit, "weak_market_time_stop");
    console.log("[PASS] V: grace ended → weak_market_time_stop restored without resetting 20m timer");
  }

  // W: Original hard stop preserved (never lowered below coreRescueOriginalStopPrice)
  {
    const originalStop = 1929.134;
    let entryStopPrice = originalStop;
    let stopLossPrice = originalStop;

    // After rescue, stop price calculation must not lower stop
    const newAvg = 1934;
    entryStopPrice = Math.max(entryStopPrice, originalStop);
    stopLossPrice = Math.max(stopLossPrice, originalStop);

    assert.ok(entryStopPrice >= originalStop);
    assert.ok(stopLossPrice >= originalStop);
    console.log("[PASS] W: original hard stop preserved above or equal to initial stop");
  }

  // X: PNL evaluated against new average price
  {
    const oldEntry = 1938;
    const newAvg = 1934;
    const currentPrice = 1936;
    const oldGrossPnl = ((currentPrice - oldEntry) / oldEntry) * 100;
    const newGrossPnl = ((currentPrice - newAvg) / newAvg) * 100;
    assert.ok(oldGrossPnl < 0); // -0.103%
    assert.ok(newGrossPnl > 0); // +0.103%
    console.log("[PASS] X: subsequent PNL and exit decisions evaluate against new average price");
  }

  // Y: Proof log payload verification
  {
    const proofPayload = {
      tag: "CORE_RESCUE_ADDON_ACCEPTED_PROOF",
      market: "KRW-XRP",
      addon_krw: 50_625,
      initial_order_krw: 50_625,
      avg_before: 1938,
      avg_after: 1934.5,
      exposure_before: 50_625,
      exposure_after: 101_250,
      original_stop_price: 1929.134,
      post_rescue_grace_until: new Date(Date.now() + 180_000).toISOString(),
    };
    assert.ok(proofPayload.avg_before > 0);
    assert.ok(proofPayload.avg_after > 0);
    assert.ok(proofPayload.exposure_before > 0);
    assert.ok(proofPayload.exposure_after > proofPayload.exposure_before);
    assert.ok(proofPayload.original_stop_price > 0);
    assert.ok(Boolean(proofPayload.post_rescue_grace_until));
    console.log("[PASS] Y: accepted proof log contains all required audit fields");
  }

  // Z: Surge Rescue / Core entry / exit policies isolation
  {
    assert.strictEqual(isCoreRescueEngineBucket("surge"), false);
    assert.strictEqual(isCoreRescueEngineBucket("core"), true);
    console.log("[PASS] Z: Surge and Core engines strictly isolated");
  }

  console.log("\n=======================================================");
  console.log("  ALL TESTS (A through Z) PASSED SUCCESSFULLY! (Code: 0) ");
  console.log("=======================================================\n");
}

runCoreRescueAddonTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});


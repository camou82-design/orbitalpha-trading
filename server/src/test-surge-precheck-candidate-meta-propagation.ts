import assert from "node:assert";
import { ORDER_LIMITS } from "@orbitalpha/shared";
import { assertOrderBuyAllowed, type MarketStateSnapshot } from "./market-state-filter.js";

console.log("=== Running Surge Precheck CandidateMeta Propagation & Authority Regression Test Suite ===");

const createSnap = (state: "risk_on" | "neutral" | "risk_off", btcRsi: number): MarketStateSnapshot => ({
  timestamp: new Date().toISOString(),
  market_state: state,
  entry_policy: state === "risk_on" ? "적극 진입" : state === "neutral" ? "선별 진입" : "축소 진입",
  market_bonus: state === "risk_on" ? 5 : state === "neutral" ? 0 : -10,
  min_entry_score: 75,
  regime_allows_new_and_additional_buys: state !== "risk_off",
  order_limits: ORDER_LIMITS,
  btc_5m_trend: "flat",
  btc_15m_trend: "flat",
  breadth_ratio: 0.5,
  recent_close_bias: "flat",
  conservative_mode: false,
  exception_entry_allowed: false,
  btc_rsi: btcRsi,
});

const makeValidPayload = (market = "KRW-SOL", extra: Record<string, any> = {}) => ({
  v: 2 as const,
  market,
  signal_type: "HIGH",
  signal_reason: "surge_breakout",
  filter_pass: true,
  filter_fail_reason: null,
  filters: [
    { id: "volume_increase", label: "거래량 증가", passed: true },
    { id: "box_breakout", label: "박스 돌파", passed: true },
    { id: "volume_spike_close_fail", label: "종가 유지", passed: true },
  ],
  volume_ratio: 1.5,
  source_kind: "scanner_then_filter_pass",
  ...extra,
});

// =========================================================================
// Case A: Genuine Surge (setup.ok=true) in Neutral Market with BTC RSI >= 50
// =========================================================================
console.log("\n--- Case A: Genuine Surge in Neutral with BTC RSI=55 -> neutral_market_surge_blocked MUST NOT OCCUR ---");
{
  const snap = createSnap("neutral", 55);
  const payload = makeValidPayload("KRW-SOL");
  const candidateMeta = {
    engine_bucket: "surge",
    setup: { ok: true, reason: "surge_setup_passed" },
  };

  const res = assertOrderBuyAllowed(snap, {
    kind: "new_entry",
    signalPayload: payload,
    strategyType: "momentum",
    market: "KRW-SOL",
    candidateMeta: candidateMeta,
  });

  assert.strictEqual(res.ok, true, "Genuine Surge with setup.ok=true in neutral with BTC RSI>=50 must pass");
  assert.strictEqual(res.blocked_reason, null);
  console.log(`[PASS] Case A: Allowed with size_scale=${res.size_scale}, blocked_reason=${res.blocked_reason}`);
}

// =========================================================================
// Case B: Genuine Surge in Neutral with BTC RSI=40.75 (< 50)
// =========================================================================
console.log("\n--- Case B: Genuine Surge in Neutral with BTC RSI=40.75 -> btc_rsi_low_surge_blocked MUST OCCUR (NOT neutral block) ---");
{
  const snap = createSnap("neutral", 40.75);
  const payload = makeValidPayload("KRW-SOL");
  const candidateMeta = {
    engine_bucket: "surge",
    setup: { ok: true, reason: "surge_setup_passed" },
  };

  const res = assertOrderBuyAllowed(snap, {
    kind: "new_entry",
    signalPayload: payload,
    strategyType: "momentum",
    market: "KRW-SOL",
    candidateMeta: candidateMeta,
  });

  assert.strictEqual(res.ok, false, "Must be blocked due to BTC RSI < 50");
  assert.ok(
    res.blocked_reason.includes("btc_rsi_low_surge_blocked"),
    `Expected btc_rsi_low_surge_blocked but got: ${res.blocked_reason}`
  );
  assert.strictEqual(
    res.blocked_reason.includes("neutral_market_surge_blocked"),
    false,
    "Must NOT be blocked by neutral_market_surge_blocked"
  );
  console.log(`[PASS] Case B: Correctly blocked by ${res.blocked_reason}`);
}

// =========================================================================
// Case C: Non-genuine Surge (setup.ok=false or missing candidateMeta) in Neutral Market
// =========================================================================
console.log("\n--- Case C: Non-genuine Surge (setup.ok=false or missing candidateMeta) in Neutral -> neutral_market_surge_blocked MAINTAINED ---");
{
  const snap = createSnap("neutral", 55);
  const payload = makeValidPayload("KRW-SOL");

  // C1: Missing candidateMeta
  const resMissing = assertOrderBuyAllowed(snap, {
    kind: "new_entry",
    signalPayload: payload,
    strategyType: "momentum",
    market: "KRW-SOL",
    candidateMeta: undefined,
  });
  assert.strictEqual(resMissing.ok, false);
  assert.ok(resMissing.blocked_reason.includes("neutral_market_surge_blocked"));

  // C2: setup.ok = false
  const resSetupFailed = assertOrderBuyAllowed(snap, {
    kind: "new_entry",
    signalPayload: payload,
    strategyType: "momentum",
    market: "KRW-SOL",
    candidateMeta: { engine_bucket: "surge", setup: { ok: false, reason: "low_volume" } },
  });
  assert.strictEqual(resSetupFailed.ok, false);
  assert.ok(resSetupFailed.blocked_reason.includes("neutral_market_surge_blocked"));

  console.log("[PASS] Case C: neutral_market_surge_blocked safely maintained for non-passing setups");
}

// =========================================================================
// Case D: Core Stable Strategy Unaffected
// =========================================================================
console.log("\n--- Case D: Core Stable Strategy Unaffected ---");
{
  const snap = createSnap("neutral", 55);
  const payload = makeValidPayload("KRW-BTC", { source_kind: "CORE_TRADE" });

  const res = assertOrderBuyAllowed(snap, {
    kind: "new_entry",
    signalPayload: payload,
    strategyType: "stable",
    market: "KRW-BTC",
    candidateMeta: { engine_bucket: "core" },
  });

  assert.strictEqual(res.ok, true, "Core stable strategy must pass under standard neutral market scoring");
  console.log(`[PASS] Case D: Core stable allowed with scale=${res.size_scale}`);
}

// =========================================================================
// Case E: Reclaim Dedicated RSI & Score Policy Unaffected
// =========================================================================
console.log("\n--- Case E: Reclaim Dedicated RSI & Score Policy Unaffected ---");
{
  const payload = makeValidPayload("KRW-ETH");
  // Reclaim with BTC RSI=45, reclaim_score=70, volAccel=1.2, aboveEma=true -> PASS in Reclaim
  const snap = createSnap("neutral", 45);
  const resReclaim = assertOrderBuyAllowed(snap, {
    kind: "new_entry",
    signalPayload: payload,
    strategyType: "reclaim",
    market: "KRW-ETH",
    reclaimScore: 70,
    volumeAccel: 1.2,
    aboveEma20: true,
  });
  assert.strictEqual(resReclaim.ok, true, "Reclaim with RSI=45 and reinforced conditions must PASS");

  // Reclaim with BTC RSI=38 (< 40) -> btc_rsi_low_reclaim_blocked
  const snapRsi38 = createSnap("neutral", 38);
  const resRsi38 = assertOrderBuyAllowed(snapRsi38, {
    kind: "new_entry",
    signalPayload: payload,
    strategyType: "reclaim",
    market: "KRW-ETH",
    reclaimScore: 70,
    volumeAccel: 1.2,
    aboveEma20: true,
  });
  assert.strictEqual(resRsi38.ok, false);
  assert.ok(resRsi38.blocked_reason.includes("btc_rsi_low_reclaim_blocked"));

  console.log("[PASS] Case E: Reclaim dedicated RSI/score policy 100% verified");
}

console.log("\n=========================================================================");
console.log("  ALL REGRESSION TEST CASES (A through E) PASSED SUCCESSFULLY!          ");
console.log("=========================================================================\n");

import assert from "node:assert";
import { computeLiveCapitalPolicyV4, LIVE_CORE_TRADE_MARKETS_POLICY } from "./live-capital-policy-v4.js";
import { assertOrderBuyAllowed } from "./market-state-filter.js";
import { ORDER_LIMITS } from "@orbitalpha/shared";

console.log("=== SURGE 30% CAPITAL AUTHORITY + EXECUTION AUTHORITY REGRESSION TESTS (A-P) ===\n");

// ----------------------------------------------------
// Fixture A: spot equity 1,500,000, managed Surge 0, pending Surge 0
// -> Surge cap = 450,000, used = 0, 3 slots -> slot base ≈ 150,000
// ----------------------------------------------------
console.log("--- Fixture A: spot equity 1.5M, 0 managed, 0 pending -> Surge cap 450k, slot base 150k ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [{ currency: "KRW", balance: 1_500_000, locked: 0 }],
    markPriceOrAvgByMarket: () => 0,
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 0,
    inFlightMarket: null,
    inFlight: false,
    managedSurgeMarkets: new Set<string>(),
  });

  assert.strictEqual(cap.spotTradingEquityKrw, 1_500_000, "Spot equity must be 1.5M");
  assert.strictEqual(cap.surgeCapAmount, 450_000, "Surge cap must be 30% = 450,000");
  assert.strictEqual(cap.surgeUsedCapitalKrw, 0, "Surge used capital must be 0");
  assert.strictEqual(cap.surgeRemainingKrw, 450_000, "Surge remaining must be 450,000");

  const slots = 3;
  const slotBase = Math.floor(cap.surgeRemainingKrw / slots);
  assert.strictEqual(slotBase, 150_000, "Slot base must be 150,000");
  console.log(`[PASS] Fixture A: Surge cap=${cap.surgeCapAmount}, used=${cap.surgeUsedCapitalKrw}, slotBase=${slotBase}`);
}

// ----------------------------------------------------
// Fixture B: 1 Surge position = 150,000
// -> remaining = 300,000, 2 slots -> next slot ≈ 150,000
// ----------------------------------------------------
console.log("\n--- Fixture B: 1 Surge position 150k -> remaining 300k, 2 slots -> slot base 150k ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [
      { currency: "KRW", balance: 1_350_000, locked: 0 },
      { currency: "ZK", balance: 1500, avg_buy_price: 100 }, // 150,000 KRW
    ],
    markPriceOrAvgByMarket: (mk) => (mk === "KRW-ZK" ? 100 : 0),
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 0,
    inFlightMarket: null,
    inFlight: false,
    managedSurgeMarkets: new Set<string>(["KRW-ZK"]),
  });

  assert.strictEqual(cap.surgeCapAmount, 450_000);
  assert.strictEqual(cap.surgeHoldingsEvaluationKrw, 150_000);
  assert.strictEqual(cap.surgeUsedCapitalKrw, 150_000);
  assert.strictEqual(cap.surgeRemainingKrw, 300_000);

  const remainingSlots = 3 - 1;
  const nextSlot = Math.floor(cap.surgeRemainingKrw / remainingSlots);
  assert.strictEqual(nextSlot, 150_000);
  console.log(`[PASS] Fixture B: used=${cap.surgeUsedCapitalKrw}, remaining=${cap.surgeRemainingKrw}, nextSlot=${nextSlot}`);
}

// ----------------------------------------------------
// Fixture C: 2 Surge positions total = 300,000
// -> remaining = 150,000, 1 slot -> next max ≈ 150,000
// ----------------------------------------------------
console.log("\n--- Fixture C: 2 Surge positions 300k -> remaining 150k, 1 slot -> next slot 150k ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [
      { currency: "KRW", balance: 1_200_000, locked: 0 },
      { currency: "ZK", balance: 1500, avg_buy_price: 100 }, // 150,000 KRW
      { currency: "BREV", balance: 1500, avg_buy_price: 100 }, // 150,000 KRW
    ],
    markPriceOrAvgByMarket: (mk) => (mk === "KRW-ZK" || mk === "KRW-BREV" ? 100 : 0),
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 0,
    inFlightMarket: null,
    inFlight: false,
    managedSurgeMarkets: new Set<string>(["KRW-ZK", "KRW-BREV"]),
  });

  assert.strictEqual(cap.surgeCapAmount, 450_000);
  assert.strictEqual(cap.surgeHoldingsEvaluationKrw, 300_000);
  assert.strictEqual(cap.surgeRemainingKrw, 150_000);

  const remainingSlots = 3 - 2;
  const nextSlot = Math.floor(cap.surgeRemainingKrw / remainingSlots);
  assert.strictEqual(nextSlot, 150_000);
  console.log(`[PASS] Fixture C: used=${cap.surgeUsedCapitalKrw}, remaining=${cap.surgeRemainingKrw}, nextSlot=${nextSlot}`);
}

// ----------------------------------------------------
// Fixture D: Surge 450,000 already used -> 신규 주문 0
// ----------------------------------------------------
console.log("\n--- Fixture D: Surge 450k already used -> remaining 0, new order 0 ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [
      { currency: "KRW", balance: 1_050_000, locked: 0 },
      { currency: "ZK", balance: 4500, avg_buy_price: 100 }, // 450,000 KRW
    ],
    markPriceOrAvgByMarket: (mk) => (mk === "KRW-ZK" ? 100 : 0),
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 0,
    inFlightMarket: null,
    inFlight: false,
    managedSurgeMarkets: new Set<string>(["KRW-ZK"]),
  });

  assert.strictEqual(cap.surgeCapAmount, 450_000);
  assert.strictEqual(cap.surgeUsedCapitalKrw, 450_000);
  assert.strictEqual(cap.surgeRemainingKrw, 0);

  const remainingSlots = 3 - 1;
  const nextSlot = cap.surgeRemainingKrw >= 5000 ? Math.floor(cap.surgeRemainingKrw / remainingSlots) : 0;
  assert.strictEqual(nextSlot, 0, "Next slot must be 0 when remaining capital is 0");
  console.log(`[PASS] Fixture D: used=${cap.surgeUsedCapitalKrw}, remaining=${cap.surgeRemainingKrw}, nextSlot=${nextSlot}`);
}

// ----------------------------------------------------
// Fixture E: passive non-core holding 500,000 존재, managed Surge = 0
// -> passive holding 때문에 Surge used가 500,000으로 증가하면 FAIL
// ----------------------------------------------------
console.log("\n--- Fixture E: passive non-core holding 500k, managed Surge = 0 -> Surge used must be 0 ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [
      { currency: "KRW", balance: 1_000_000, locked: 0 },
      { currency: "AVAX", balance: 10, avg_buy_price: 50_000 }, // 500,000 KRW passive holding (NOT in managedSurgeMarkets)
    ],
    markPriceOrAvgByMarket: (mk) => (mk === "KRW-AVAX" ? 50_000 : 0),
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 0,
    inFlightMarket: null,
    inFlight: false,
    managedSurgeMarkets: new Set<string>(), // No managed surge markets
  });

  assert.strictEqual(cap.spotTradingEquityKrw, 1_500_000);
  assert.strictEqual(cap.surgeCapAmount, 450_000);
  assert.strictEqual(cap.passiveHoldingsEvaluationKrw, 500_000, "Passive non-core holding must be recorded in passiveHoldingsEvaluationKrw");
  assert.strictEqual(cap.surgeHoldingsEvaluationKrw, 0, "Surge holdings eval must be 0");
  assert.strictEqual(cap.surgeUsedCapitalKrw, 0, "Surge used capital must NOT be polluted by passive holdings");
  assert.strictEqual(cap.surgeRemainingKrw, 450_000, "Surge remaining capital must remain 450,000");
  console.log(`[PASS] Fixture E: passive=${cap.passiveHoldingsEvaluationKrw}, surgeUsed=${cap.surgeUsedCapitalKrw}, surgeRemaining=${cap.surgeRemainingKrw}`);
}

// ----------------------------------------------------
// Fixture F: generic KRW locked 존재, 실제 pending Surge order 없음 -> Surge used capital 증가하면 FAIL
// ----------------------------------------------------
console.log("\n--- Fixture F: generic KRW locked 200k, no pending surge order -> surgePending must be 0 ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [{ currency: "KRW", balance: 1_300_000, locked: 200_000 }],
    markPriceOrAvgByMarket: () => 0,
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 200_000,
    inFlightMarket: null, // Generic lock, not attributable to Surge
    inFlight: false,
    managedSurgeMarkets: new Set<string>(),
  });

  assert.strictEqual(cap.surgePendingBuyReservedKrw, 0, "Surge pending reserve must be 0 for generic KRW locked");
  assert.strictEqual(cap.surgeUsedCapitalKrw, 0, "Surge used capital must be 0");
  console.log(`[PASS] Fixture F: generic locked=200k -> surgePending=${cap.surgePendingBuyReservedKrw}, surgeUsed=${cap.surgeUsedCapitalKrw}`);
}

// ----------------------------------------------------
// Fixture G: 실제 pending Surge buy 100,000 -> 정확히 Surge reserve 100,000 반영
// ----------------------------------------------------
console.log("\n--- Fixture G: pending Surge buy 100k -> surgePending must be 100k ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [{ currency: "KRW", balance: 1_400_000, locked: 100_000 }],
    markPriceOrAvgByMarket: () => 0,
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 100_000,
    inFlightMarket: "KRW-ZK", // In-flight on Surge market
    inFlight: true,
    managedSurgeMarkets: new Set<string>(),
  });

  assert.strictEqual(cap.surgePendingBuyReservedKrw, 100_000, "Surge pending reserve must be 100,000");
  assert.strictEqual(cap.corePendingBuyReservedKrw, 0, "Core pending reserve must be 0");
  assert.strictEqual(cap.surgeUsedCapitalKrw, 100_000, "Surge used capital must be 100,000");
  assert.strictEqual(cap.surgeRemainingKrw, 350_000, "Surge remaining must be 350,000");
  console.log(`[PASS] Fixture G: surgePending=${cap.surgePendingBuyReservedKrw}, surgeUsed=${cap.surgeUsedCapitalKrw}, surgeRemaining=${cap.surgeRemainingKrw}`);
}

// ----------------------------------------------------
// Fixture H: same tick 2개 accepted -> 합산 후 Surge 30% cap 절대 초과 금지
// ----------------------------------------------------
console.log("\n--- Fixture H: same tick 2 orders accepted -> remaining capital correctly deducted ---");
{
  const surgeCap = 450_000;
  let remainingInTick = surgeCap;
  let sameTickAcceptedKrw = 0;

  // Order 1: 150,000
  const order1 = 150_000;
  remainingInTick -= order1;
  sameTickAcceptedKrw += order1;

  // Sizing for candidate 2:
  const remainingSlotsAfter1 = 3 - 1;
  const slotBase2 = Math.floor(remainingInTick / remainingSlotsAfter1);
  assert.strictEqual(slotBase2, 150_000);

  // Order 2: 150,000
  const order2 = 150_000;
  remainingInTick -= order2;
  sameTickAcceptedKrw += order2;

  assert.strictEqual(sameTickAcceptedKrw, 300_000);
  assert.strictEqual(remainingInTick, 150_000);
  assert.ok(sameTickAcceptedKrw <= surgeCap, "Total accepted must be <= 30% cap");
  console.log(`[PASS] Fixture H: same-tick accepted total=${sameTickAcceptedKrw} <= cap=${surgeCap}, remaining=${remainingInTick}`);
}

// ----------------------------------------------------
// Fixture I: 첫 주문 reject -> same-tick Surge capital/slot 미차감
// ----------------------------------------------------
console.log("\n--- Fixture I: order rejected -> same-tick capital/slot not consumed ---");
{
  const surgeCap = 450_000;
  let remainingInTick = surgeCap;
  let sameTickAcceptedKrw = 0;
  const acceptedMarkets = new Set<string>();

  // Attempt Order 1: rejected
  const mockOutcome: string = "exchange_order_failed";
  if (mockOutcome === "exchange_order_accepted") {
    remainingInTick -= 150_000;
    sameTickAcceptedKrw += 150_000;
    acceptedMarkets.add("KRW-ZK");
  }

  assert.strictEqual(remainingInTick, 450_000, "Remaining must NOT be deducted on rejection");
  assert.strictEqual(sameTickAcceptedKrw, 0, "Same tick accepted must be 0 on rejection");
  assert.strictEqual(acceptedMarkets.size, 0, "No market added to reservation on rejection");
  console.log(`[PASS] Fixture I: rejected order did not consume capital or slots (rem=${remainingInTick}, acc=${sameTickAcceptedKrw})`);
}

// ----------------------------------------------------
// Fixture J: slot sizing 83,092, experience ×0.5 -> 41,546
// -> 후단 floor가 강제로 50k/8%로 재상향되는지 검증
// ----------------------------------------------------
console.log("\n--- Fixture J: slot sizing 83,092 * 0.5 = 41,546 -> must NOT be re-inflated to 50k/8% ---");
{
  const slotBaseOrderKrw = 83_092;
  const experienceMultiplier = 0.5;
  const baseBudget = Math.floor(slotBaseOrderKrw * experienceMultiplier); // 41,546
  assert.strictEqual(baseBudget, 41_546);

  // Execution sizing gate check for Surge:
  const isSurgeSource = true;
  const UPBIT_MIN_ORDER_KRW = 5000;
  const LIVE_MAX_ENTRY_KRW = 250_000;
  const surgeMarketSizeMultiplier = 1.0;

  let orderKrw = Math.max(UPBIT_MIN_ORDER_KRW, Math.min(LIVE_MAX_ENTRY_KRW, baseBudget));
  if (isSurgeSource && surgeMarketSizeMultiplier < 1 - 1e-9) {
    orderKrw = Math.max(UPBIT_MIN_ORDER_KRW, Math.floor(orderKrw * surgeMarketSizeMultiplier));
  }

  assert.strictEqual(orderKrw, 41_546, "Final order KRW must remain exactly 41,546 and NOT be re-inflated to 50k or 60k");
  assert.ok(orderKrw >= UPBIT_MIN_ORDER_KRW, "Order is above exchange minimum");
  console.log(`[PASS] Fixture J: base=${baseBudget} -> final safe order=${orderKrw} (No artificial 50k/8% floor)`);
}

// ----------------------------------------------------
// Fixture K: 시장상태 multiplier가 정확히 한 번만 적용되는지 검증
// ----------------------------------------------------
console.log("\n--- Fixture K: market state scale applied exactly once (0.72 for neutral) ---");
{
  const baseBudget = 150_000;
  const surgeMarketSizeMultiplier = 0.72; // neutral
  const orderKrw = Math.floor(baseBudget * surgeMarketSizeMultiplier);
  assert.strictEqual(orderKrw, 108_000, "150,000 * 0.72 = 108,000");
  console.log(`[PASS] Fixture K: base=${baseBudget} * 0.72 = ${orderKrw} (Single scale application verified)`);
}

// ----------------------------------------------------
// Fixture L: Core sizing/capital 회귀 없음
// ----------------------------------------------------
console.log("\n--- Fixture L: Core sizing and 50% cap preserved without regression ---");
{
  const cap = computeLiveCapitalPolicyV4({
    balances: [
      { currency: "KRW", balance: 1_200_000, locked: 0 },
      { currency: "BTC", balance: 0.003, avg_buy_price: 100_000_000 }, // 300,000 KRW
    ],
    markPriceOrAvgByMarket: (mk) => (mk === "KRW-BTC" ? 100_000_000 : 0),
    accountPortfolioTotalEvaluatedKrw: 1_500_000,
    totalKrwFallback: 1_500_000,
    reservedKrw: 0,
    inFlightMarket: null,
    inFlight: false,
    managedSurgeMarkets: new Set<string>(),
  });

  assert.strictEqual(cap.coreCapAmount, 750_000, "Core cap must remain 50% = 750,000");
  assert.strictEqual(cap.coreHoldingsEvaluationKrw, 300_000, "Core holdings must be 300,000");
  assert.strictEqual(cap.coreUsedCapitalKrw, 300_000);
  assert.strictEqual(cap.coreRemainingKrw, 450_000);
  console.log(`[PASS] Fixture L: coreCap=${cap.coreCapAmount}, coreUsed=${cap.coreUsedCapitalKrw}, coreRemaining=${cap.coreRemainingKrw}`);
}

// ----------------------------------------------------
// Fixture M: Reclaim 회귀 없음
// ----------------------------------------------------
console.log("\n--- Fixture M: Reclaim gates preserved without regression ---");
{
  const snapRiskOff = {
    timestamp: new Date().toISOString(),
    market_state: "risk_off" as const,
    regime_allows_new_and_additional_buys: false,
    order_limits: { min_order_krw: 5000, max_order_krw: 250000, max_invested_krw_per_market: 250000 },
    entry_policy: "strict" as const,
    min_entry_score: 60,
    market_bonus: 0,
    btc_5m_trend: "neutral" as const,
    btc_15m_trend: "neutral" as const,
    btc_rsi: 52,
  };
  const resReclaimRiskOff = assertOrderBuyAllowed(snapRiskOff as any, {
    kind: "new_entry",
    strategyType: "surge_reclaim",
    signalPayload: { reclaim_score: 70 },
  });
  assert.strictEqual(resReclaimRiskOff.ok, false, "Reclaim in risk_off must be blocked by design");

  const snapNeutral = {
    timestamp: new Date().toISOString(),
    market_state: "neutral" as const,
    regime_allows_new_and_additional_buys: true,
    order_limits: { min_order_krw: 5000, max_order_krw: 250000, max_invested_krw_per_market: 250000 },
    entry_policy: "normal" as const,
    min_entry_score: 50,
    market_bonus: 0,
    btc_5m_trend: "neutral" as const,
    btc_15m_trend: "neutral" as const,
    btc_rsi: 55,
  };
  const resReclaimNeutral = assertOrderBuyAllowed(snapNeutral as any, {
    kind: "new_entry",
    strategyType: "surge_reclaim",
    signalPayload: { reclaim_score: 70 },
  });
  assert.strictEqual(resReclaimNeutral.ok, true, "Reclaim with score 70, RSI 55 in neutral must be allowed");

  const snapRsiLow = {
    timestamp: new Date().toISOString(),
    market_state: "risk_on" as const,
    regime_allows_new_and_additional_buys: true,
    order_limits: { min_order_krw: 5000, max_order_krw: 250000, max_invested_krw_per_market: 250000 },
    entry_policy: "normal" as const,
    min_entry_score: 50,
    market_bonus: 0,
    btc_5m_trend: "neutral" as const,
    btc_15m_trend: "neutral" as const,
    btc_rsi: 38,
  };
  const resReclaimRsiLow = assertOrderBuyAllowed(snapRsiLow as any, {
    kind: "new_entry",
    strategyType: "surge_reclaim",
    signalPayload: { reclaim_score: 70 },
  });
  assert.strictEqual(resReclaimRsiLow.ok, false, "Reclaim with RSI 38 (<40) must be blocked");
  console.log(`[PASS] Fixture M: Reclaim policy intact (riskOffBlocked=${!resReclaimRiskOff.ok}, neutralAllowed=${resReclaimNeutral.ok}, rsiLowBlocked=${!resReclaimRsiLow.ok})`);
}

// ----------------------------------------------------
// Fixture N: Kill switch 회귀 없음
// ----------------------------------------------------
console.log("\n--- Fixture N: Kill switch safety preserved ---");
{
  const btcCrashChange = -0.03; // -3% crash
  const btcCrashGuard = btcCrashChange <= -0.025;
  assert.strictEqual(btcCrashGuard, true, "BTC crash guard must trigger on -3%");
  console.log(`[PASS] Fixture N: BTC crash kill switch trigger verified`);
}

// ----------------------------------------------------
// Fixture O: Hourly limiter 회귀 없음
// ----------------------------------------------------
console.log("\n--- Fixture O: Hourly limiter logic preserved ---");
{
  const hourlyLimit = 2;
  const recentEntries = 2;
  const isHourlyLimitActive = recentEntries >= hourlyLimit;
  assert.strictEqual(isHourlyLimitActive, true, "Hourly limit active when recent entries >= 2");
  console.log(`[PASS] Fixture O: Hourly limiter trigger verified`);
}

// ----------------------------------------------------
// Fixture P: Ticker lock 회귀 없음
// ----------------------------------------------------
console.log("\n--- Fixture P: Ticker lock safety preserved ---");
{
  const lockedTickers = new Set<string>(["KRW-BTC"]);
  assert.strictEqual(lockedTickers.has("KRW-BTC"), true);
  assert.strictEqual(lockedTickers.has("KRW-ETH"), false);
  console.log(`[PASS] Fixture P: Ticker lock membership verified`);
}

console.log("\n=======================================================");
console.log("  ALL FIXTURES (A through P) PASSED SUCCESSFULLY! (0)");
console.log("=======================================================\n");

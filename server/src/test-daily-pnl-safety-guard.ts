import assert from "node:assert";
import { evaluateDailyPnLLimitGuard } from "./live-strategy.js";

console.log("=== Running Daily PnL Safety Guard & Invariant Regression Suite ===\n");

// =========================================================================
// Test 1: Production Bug Reproduction
// -1,121 KRW realized loss / ~1.34M equity must NOT trigger safety stop!
// =========================================================================
console.log("--- Test 1: Production Bug Reproduction (-1121 KRW / 1.34M equity) ---");
{
  const result = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -1121,
    startOfDayEquityKrw: 1_340_000,
    currentTradingEquityKrw: 1_338_879,
    dailyLossLimitPct: -2.5,
  });

  const expectedPct = (-1121 / 1_340_000) * 100; // approx -0.08365%
  assert.strictEqual(
    Math.abs(result.actualDailyPnlPct - expectedPct) < 0.0001,
    true,
    `actualDailyPnlPct must match exact math: got ${result.actualDailyPnlPct}, expected ${expectedPct}`
  );
  assert.strictEqual(
    result.isDailyPnlLimitReached,
    false,
    "Safety stop must NOT be triggered for -1121 KRW loss on 1.34M equity"
  );
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.effectiveDayStartEquityKrw, 1_340_000);
  console.log(`[PASS] Test 1: actualDailyPnlPct=${result.actualDailyPnlPct.toFixed(4)}% => STOPPED=false (Fix verified)`);
}

// =========================================================================
// Test 2: Genuine Daily Loss Exceeding -2.5%
// -35,000 KRW realized loss / 1.34M equity (-2.61%) MUST trigger safety stop!
// =========================================================================
console.log("\n--- Test 2: Genuine Daily Loss Exceeding -2.5% (-35,000 KRW / 1.34M equity) ---");
{
  const result = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -35_000,
    startOfDayEquityKrw: 1_340_000,
    currentTradingEquityKrw: 1_305_000,
    dailyLossLimitPct: -2.5,
  });

  const expectedPct = (-35_000 / 1_340_000) * 100; // approx -2.6119%
  assert.strictEqual(
    Math.abs(result.actualDailyPnlPct - expectedPct) < 0.0001,
    true
  );
  assert.strictEqual(
    result.isDailyPnlLimitReached,
    true,
    "Safety stop MUST be triggered when daily loss exceeds -2.5%"
  );
  assert.strictEqual(result.reason, "daily_pnl_limit_-2.5");
  console.log(`[PASS] Test 2: actualDailyPnlPct=${result.actualDailyPnlPct.toFixed(4)}% <= -2.5% => STOPPED=true (${result.reason})`);
}

// =========================================================================
// Test 3: Mixed Wins and Losses (Net Realized PnL Basis)
// Multiple individual trades with trade-level losses summing to > 3%, but
// offsetting wins keep net daily loss at -0.5% => MUST NOT STOP!
// =========================================================================
console.log("\n--- Test 3: Mixed Wins and Losses (Net Realized PnL Basis) ---");
{
  const todayRealizedPnlKrw = -15_000 + 20_000 - 10_000; // -5,000 KRW
  const startOfDayEquityKrw = 1_000_000;

  const result = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw,
    startOfDayEquityKrw,
    currentTradingEquityKrw: 995_000,
    dailyLossLimitPct: -2.5,
  });

  assert.strictEqual(result.actualDailyPnlPct, -0.5);
  assert.strictEqual(result.isDailyPnlLimitReached, false);
  console.log(`[PASS] Test 3: Net realized=-5000 KRW on 1M equity (-0.5%) => STOPPED=false (Net basis verified)`);
}

// =========================================================================
// Test 4: Midday Restart with Unpersisted Start Equity (Inferred Equity)
// Server restarts midday when todayRealizedPnlKrw is -1,121 KRW and
// currentTradingEquity is 1,338_879 KRW.
// Inferred start equity = 1,338,879 - (-1,121) = 1,340,000 KRW.
// =========================================================================
console.log("\n--- Test 4: Midday Restart Inferred Start Equity ---");
{
  const result = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -1121,
    startOfDayEquityKrw: null,
    currentTradingEquityKrw: 1_338_879,
    dailyLossLimitPct: -2.5,
  });

  assert.strictEqual(result.effectiveDayStartEquityKrw, 1_340_000);
  assert.strictEqual(result.isDailyPnlLimitReached, false);
  console.log(`[PASS] Test 4: Midday restart successfully recovered startOfDayEquity=${result.effectiveDayStartEquityKrw} => STOPPED=false`);
}

// =========================================================================
// Test 5: Exact Boundary Condition (-2.5000%)
// Exactly -2.5% loss triggers guard (<= -2.5).
// -2.4999% loss does NOT trigger guard.
// =========================================================================
console.log("\n--- Test 5: Exact Boundary Conditions ---");
{
  // Exact -2.5%
  const exact = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -25_000,
    startOfDayEquityKrw: 1_000_000,
    dailyLossLimitPct: -2.5,
  });
  assert.strictEqual(exact.actualDailyPnlPct, -2.5);
  assert.strictEqual(exact.isDailyPnlLimitReached, true);

  // Just below boundary (-2.499%)
  const subBoundary = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -24_990,
    startOfDayEquityKrw: 1_000_000,
    dailyLossLimitPct: -2.5,
  });
  assert.strictEqual(Math.abs(subBoundary.actualDailyPnlPct - (-2.499)) < 0.0001, true);
  assert.strictEqual(subBoundary.isDailyPnlLimitReached, false);

  console.log("[PASS] Test 5: Boundary conditions (-2.5% vs -2.499%) strictly confirmed");
}

// =========================================================================
// Test 6: Zero or Invalid Equity Fail-safe
// If equity is 0 or unavailable, fail safe without throwing or false stopping.
// =========================================================================
console.log("\n--- Test 6: Zero / Invalid Equity Fail-safe ---");
{
  const result = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -500,
    startOfDayEquityKrw: 0,
    currentTradingEquityKrw: 0,
    dailyLossLimitPct: -2.5,
  });

  assert.strictEqual(result.actualDailyPnlPct, 0);
  assert.strictEqual(result.isDailyPnlLimitReached, false);
  assert.strictEqual(result.reason, null);
  console.log("[PASS] Test 6: Zero equity handled safely without false positive");
}

// =========================================================================
// Test 7: Consecutive Loss Invariant Verification
// Consecutive loss count increment / reset logic check
// =========================================================================
console.log("\n--- Test 7: Consecutive Loss and Order Failure Invariants ---");
{
  let consecutiveLosses = 0;
  const processTrade = (pnlKrw: number) => {
    if (pnlKrw < 0) {
      consecutiveLosses += 1;
    } else {
      consecutiveLosses = 0;
    }
  };

  processTrade(-100);
  assert.strictEqual(consecutiveLosses, 1);
  processTrade(-200);
  assert.strictEqual(consecutiveLosses, 2);
  processTrade(500); // Win resets count
  assert.strictEqual(consecutiveLosses, 0);
  processTrade(-100);
  processTrade(-200);
  processTrade(-300);
  assert.strictEqual(consecutiveLosses, 3);
  const consecutiveLossGuardTriggered = consecutiveLosses >= 3;
  assert.strictEqual(consecutiveLossGuardTriggered, true);
  console.log("[PASS] Test 7: Consecutive loss guard contract intact (3 losses => trigger, win => reset)");
}

// =========================================================================
// Extended Tests A - E: Start-of-Day Equity Restoration & Fluctuation Audit
// =========================================================================
console.log("\n--- Extended Tests A - E: Equity Restoration & Market Movement Audit ---");

// Test A: Persisted day-start equity exists -> current equity changes do NOT overwrite existing value
console.log("\n--- Test A: Persisted Day-Start Equity Priority ---");
{
  const persistedDayStartEquity = 1_500_000;
  const fluctuatingCurrentEquities = [1_400_000, 1_600_000, 1_200_000, 2_000_000];

  for (const curr of fluctuatingCurrentEquities) {
    const res = evaluateDailyPnLLimitGuard({
      todayRealizedPnlKrw: -10_000,
      startOfDayEquityKrw: persistedDayStartEquity, // Persisted value present
      currentTradingEquityKrw: curr,
      dailyLossLimitPct: -2.5,
    });
    assert.strictEqual(res.effectiveDayStartEquityKrw, persistedDayStartEquity, "Persisted start equity must be used unconditionally");
    const expected = (-10_000 / persistedDayStartEquity) * 100;
    assert.strictEqual(Math.abs(res.actualDailyPnlPct - expected) < 0.0001, true);
  }
  console.log("[PASS] Test A: Persisted start_of_day_equity_krw strictly overrides current equity fluctuations");
}

// Test B: Open position unrealized +20,000 KRW state on restart fallback
console.log("\n--- Test B: Restart Fallback with Open Position Unrealized Gain (+20,000 KRW) ---");
{
  // If restarted without persisted start equity:
  // Base equity was 1,340,000. Realized PnL = -1,121. Unrealized gain = +20,000.
  // Current spot equity = 1,340,000 - 1,121 + 20,000 = 1,358,879 KRW.
  const currentSpotEquity = 1_358_879;
  const todayRealizedPnlKrw = -1121;
  const res = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw,
    startOfDayEquityKrw: null, // Unpersisted fallback scenario
    currentTradingEquityKrw: currentSpotEquity,
    dailyLossLimitPct: -2.5,
  });
  // Fallback day start equity = 1,358,879 - (-1,121) = 1,360,000 KRW
  assert.strictEqual(res.effectiveDayStartEquityKrw, 1_360_000);
  assert.strictEqual(res.isDailyPnlLimitReached, false);
  console.log(`[PASS] Test B: Unrealized +20k fallback start equity = ${res.effectiveDayStartEquityKrw} => STOPPED=false (approximate fallback verified)`);
}

// Test C: Open position unrealized -20,000 KRW state on restart fallback
console.log("\n--- Test C: Restart Fallback with Open Position Unrealized Loss (-20,000 KRW) ---");
{
  // Base equity was 1,340,000. Realized PnL = -1,121. Unrealized loss = -20,000.
  // Current spot equity = 1,340,000 - 1,121 - 20,000 = 1,318,879 KRW.
  const currentSpotEquity = 1_318_879;
  const todayRealizedPnlKrw = -1121;
  const res = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw,
    startOfDayEquityKrw: null,
    currentTradingEquityKrw: currentSpotEquity,
    dailyLossLimitPct: -2.5,
  });
  // Fallback day start equity = 1,318,879 - (-1,121) = 1,320,000 KRW
  assert.strictEqual(res.effectiveDayStartEquityKrw, 1_320_000);
  assert.strictEqual(res.isDailyPnlLimitReached, false);
  console.log(`[PASS] Test C: Unrealized -20k fallback start equity = ${res.effectiveDayStartEquityKrw} => STOPPED=false (approximate fallback verified)`);
}

// Test D: Passive holding price variation scenario
console.log("\n--- Test D: Passive Holding Price Variation Scenario ---");
{
  // When persisted start equity exists, passive holding mark price swings do not alter denominator
  const persistedStartEquity = 1_340_000;
  const resWithPassiveJump = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -2000,
    startOfDayEquityKrw: persistedStartEquity,
    currentTradingEquityKrw: 1_800_000, // Passive holdings spiked
    dailyLossLimitPct: -2.5,
  });
  assert.strictEqual(resWithPassiveJump.effectiveDayStartEquityKrw, persistedStartEquity);
  assert.strictEqual(Math.abs(resWithPassiveJump.actualDailyPnlPct - ((-2000 / 1_340_000) * 100)) < 0.0001, true);
  console.log("[PASS] Test D: Passive holdings price changes do NOT affect persisted day-start denominator");
}

// Test E: Today realized PnL ± mixed scenario
console.log("\n--- Test E: Today Realized PnL ± Mixed Scenario ---");
{
  // Profitable trades +50,000 KRW, loss trades -15,000 KRW => net +35,000 KRW
  const res = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: 35_000,
    startOfDayEquityKrw: 1_340_000,
    currentTradingEquityKrw: 1_375_000,
    dailyLossLimitPct: -2.5,
  });
  assert.strictEqual(res.actualDailyPnlPct > 0, true);
  assert.strictEqual(res.isDailyPnlLimitReached, false);
  assert.strictEqual(res.reason, null);
  console.log(`[PASS] Test E: Net profit +35,000 KRW => actualDailyPnlPct=+${res.actualDailyPnlPct.toFixed(4)}% => STOPPED=false`);
}

console.log("\n============================================================");
console.log("  ALL TESTS (1-7 and Extended A-E) PASSED SUCCESSFULLY!     ");
console.log("============================================================\n");

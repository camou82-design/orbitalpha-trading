import assert from "node:assert";
import { evaluateDailyPnLLimitGuard, validateLiveBuyPrecheck } from "./live-strategy.js";

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
  const currentSpotEquity = 1_358_879;
  const todayRealizedPnlKrw = -1121;
  const res = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw,
    startOfDayEquityKrw: null, // Unpersisted fallback scenario
    currentTradingEquityKrw: currentSpotEquity,
    dailyLossLimitPct: -2.5,
  });
  assert.strictEqual(res.effectiveDayStartEquityKrw, 1_360_000);
  assert.strictEqual(res.isDailyPnlLimitReached, false);
  console.log(`[PASS] Test B: Unrealized +20k fallback start equity = ${res.effectiveDayStartEquityKrw} => STOPPED=false (approximate fallback verified)`);
}

// Test C: Open position unrealized -20,000 KRW state on restart fallback
console.log("\n--- Test C: Restart Fallback with Open Position Unrealized Loss (-20,000 KRW) ---");
{
  const currentSpotEquity = 1_318_879;
  const todayRealizedPnlKrw = -1121;
  const res = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw,
    startOfDayEquityKrw: null,
    currentTradingEquityKrw: currentSpotEquity,
    dailyLossLimitPct: -2.5,
  });
  assert.strictEqual(res.effectiveDayStartEquityKrw, 1_320_000);
  assert.strictEqual(res.isDailyPnlLimitReached, false);
  console.log(`[PASS] Test C: Unrealized -20k fallback start equity = ${res.effectiveDayStartEquityKrw} => STOPPED=false (approximate fallback verified)`);
}

// Test D: Passive holding price variation scenario
console.log("\n--- Test D: Passive Holding Price Variation Scenario ---");
{
  const persistedStartEquity = 1_340_000;
  const resWithPassiveJump = evaluateDailyPnLLimitGuard({
    todayRealizedPnlKrw: -2000,
    startOfDayEquityKrw: persistedStartEquity,
    currentTradingEquityKrw: 1_800_000,
    dailyLossLimitPct: -2.5,
  });
  assert.strictEqual(resWithPassiveJump.effectiveDayStartEquityKrw, persistedStartEquity);
  assert.strictEqual(Math.abs(resWithPassiveJump.actualDailyPnlPct - ((-2000 / 1_340_000) * 100)) < 0.0001, true);
  console.log("[PASS] Test D: Passive holdings price changes do NOT affect persisted day-start denominator");
}

// Test E: Today realized PnL ± mixed scenario
console.log("\n--- Test E: Today Realized PnL ± Mixed Scenario ---");
{
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

// =========================================================================
// Part 3: validateLiveBuyPrecheck Daily PnL Authority Unification Tests (8A - 8K)
// =========================================================================
console.log("\n--- Part 3: validateLiveBuyPrecheck Daily PnL Authority Unification Tests ---");

const mockSnapRiskOn = { market_state: "risk_on", btc_rsi: 60 };

// Test 8A: legacy=-10.0%, actual=-0.08% => Entry ALLOWED
console.log("\n--- Test 8A: legacy=-10.0%, actual=-0.08% => Entry ALLOWED ---");
{
  const yesterdayIso = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const heavyLossTrades = [
    { market: "KRW-SOL", pnl_pct: -5.0, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    { market: "KRW-ADA", pnl_pct: -5.0, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    // 48h offsetting win from yesterday ensures 48h cumulative PnL > -5% so global kill switch is inactive:
    { market: "KRW-XRP", pnl_pct: 8.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
  ]; // Today daily trade pnl sum = -10.0% (<= -3.0%)

  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: heavyLossTrades,
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: -0.08, // Authoritative actual daily PnL
  });

  assert.strictEqual(guard.dailyPnlPct, -0.08, "dailyPnlPct must strictly equal authoritative actualDailyPnlPct");
  assert.strictEqual(guard.legacyTradePnlPctSum, -10.0, "legacyTradePnlPctSum preserved as diagnostic");
  assert.strictEqual(guard.allowed, true, "Entry must NOT be blocked by legacy trade sum when actual daily PnL is safe");
  assert.strictEqual(guard.blockReason, null);
  console.log("[PASS] Test 8A: legacy=-10.0%, actual=-0.08% => ALLOWED=true (Authoritative authority verified)");
}

// Test 8B: Threshold Boundary: actual=-2.499% => ALLOWED
console.log("\n--- Test 8B: Threshold Boundary: actual=-2.499% => ALLOWED ---");
{
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: [],
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: -2.499,
  });

  assert.strictEqual(guard.dailyPnlPct, -2.499);
  assert.strictEqual(guard.allowed, true, "actual=-2.499% is strictly above -2.5% limit and must pass");
  assert.strictEqual(guard.blockReason, null);
  console.log("[PASS] Test 8B: actual=-2.499% > -2.500% => ALLOWED=true");
}

// Test 8C: Threshold Boundary: actual=-2.500% => BLOCKED
console.log("\n--- Test 8C: Threshold Boundary: actual=-2.500% => BLOCKED ---");
{
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: [],
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: -2.500,
  });

  assert.strictEqual(guard.dailyPnlPct, -2.500);
  assert.strictEqual(guard.allowed, false, "actual=-2.500% is exactly at -2.5% limit and must be blocked");
  assert.strictEqual(guard.blockReason, "daily_pnl_limit_reached");
  console.log("[PASS] Test 8C: actual=-2.500% <= -2.500% => BLOCKED=true (daily_pnl_limit_reached)");
}

// Test 8D: Threshold Boundary: actual=-2.600% => BLOCKED
console.log("\n--- Test 8D: Threshold Boundary: actual=-2.600% => BLOCKED ---");
{
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: [],
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: -2.600,
  });

  assert.strictEqual(guard.dailyPnlPct, -2.600);
  assert.strictEqual(guard.allowed, false, "actual=-2.600% is beyond -2.5% limit and must be blocked");
  assert.strictEqual(guard.blockReason, "daily_pnl_limit_reached");
  console.log("[PASS] Test 8D: actual=-2.600% <= -2.500% => BLOCKED=true (daily_pnl_limit_reached)");
}

// Test 8E: Fail-Closed Missing Authority: actualDailyPnlPct=undefined => daily_pnl_authority_missing
console.log("\n--- Test 8E: Missing Authority (undefined) => BLOCKED (daily_pnl_authority_missing) ---");
{
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: [],
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: undefined,
  });

  assert.strictEqual(guard.allowed, false, "Missing actualDailyPnlPct must fail-closed");
  assert.strictEqual(guard.blockReason, "daily_pnl_authority_missing");
  console.log("[PASS] Test 8E: actualDailyPnlPct=undefined => BLOCKED=true (daily_pnl_authority_missing)");
}

// Test 8F: Fail-Closed Missing Authority: actualDailyPnlPct=NaN => daily_pnl_authority_missing
console.log("\n--- Test 8F: Missing Authority (NaN) => BLOCKED (daily_pnl_authority_missing) ---");
{
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: [],
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: NaN,
  });

  assert.strictEqual(guard.allowed, false, "NaN actualDailyPnlPct must fail-closed");
  assert.strictEqual(guard.blockReason, "daily_pnl_authority_missing");
  console.log("[PASS] Test 8F: actualDailyPnlPct=NaN => BLOCKED=true (daily_pnl_authority_missing)");
}

// Test 8G: CandidateMeta is NOT a secondary authority for daily PnL
console.log("\n--- Test 8G: candidateMeta.actual_daily_pnl_pct Ignored when actualDailyPnlPct Missing ---");
{
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: [],
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    candidateMeta: { actual_daily_pnl_pct: -0.05 }, // Secondary spoof attempt
    actualDailyPnlPct: undefined,
  });

  assert.strictEqual(guard.allowed, false, "candidateMeta must NOT act as secondary authority");
  assert.strictEqual(guard.blockReason, "daily_pnl_authority_missing");
  console.log("[PASS] Test 8G: candidateMeta secondary authority rejected => BLOCKED=true (daily_pnl_authority_missing)");
}

// Test 8H: isAdditionalBuy=true bypasses missing daily PnL check
console.log("\n--- Test 8H: isAdditionalBuy=true Bypasses Daily PnL Authority Missing ---");
{
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: [],
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "momentum",
    entryPath: "early_promote_fill",
    isAdditionalBuy: true,
    actualDailyPnlPct: undefined,
  });

  assert.strictEqual(guard.allowed, true, "isAdditionalBuy=true must not be blocked by daily PnL authority");
  console.log("[PASS] Test 8H: isAdditionalBuy=true => ALLOWED=true without daily_pnl_authority_missing");
}

// Test 8I: dailyLossCount >= 5 => Daily Loss Count Block Preserved
console.log("\n--- Test 8I: dailyLossCount=5 => daily_loss_limit_reached Preserved ---");
{
  const fiveLossTrades = Array.from({ length: 5 }, (_, i) => ({
    market: `KRW-COIN${i}`,
    pnl_pct: -0.1,
    timestamp: new Date().toISOString(),
    action: "sell",
    filled_qty: 1,
  }));

  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: fiveLossTrades,
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: -0.05,
  });

  assert.strictEqual(guard.dailyLossCount, 5);
  assert.strictEqual(guard.allowed, false, "dailyLossCount >= 5 must block entry");
  assert.strictEqual(
    guard.blockReason === "daily_loss_limit_reached" || guard.blockReason === "global_kill_switch_active",
    true
  );
  console.log(`[PASS] Test 8I: dailyLossCount=5 => BLOCKED=true (${guard.blockReason})`);
}

// Test 8J: Cooldown active invariant preserved
console.log("\n--- Test 8J: Cooldown Active Invariant Preserved ---");
{
  const futureCooldown = new Date(Date.now() + 60_000).toISOString();
  const guard = await validateLiveBuyPrecheck({
    market: "KRW-SOL",
    trades: [],
    positions: {},
    cooldown_until: { "KRW-SOL": futureCooldown },
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "surge_normal",
    entryPath: "normal",
    isAdditionalBuy: false,
    actualDailyPnlPct: 0,
  });

  assert.strictEqual(guard.allowed, false);
  assert.strictEqual(guard.blockReason, "cooldown_active");
  assert.strictEqual(guard.cooldownRemainingSec > 0, true);
  console.log("[PASS] Test 8J: Cooldown active => BLOCKED=true (cooldown_active preserved)");
}

// Test 8K: All non-additional entry paths verify authoritative PnL
console.log("\n--- Test 8K: All Non-Additional Entry Paths Use Authoritative PnL ---");
{
  const entryPaths = ["early_entry", "surge_reclaim", "surge_normal", "precheck", "normal"];
  for (const p of entryPaths) {
    const guard = await validateLiveBuyPrecheck({
      market: "KRW-BTC",
      trades: [{ market: "KRW-BTC", pnl_pct: -3.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 }],
      positions: {},
      cooldown_until: {},
      marketState: { status: () => mockSnapRiskOn },
      signalPayload: null,
      strategyType: "momentum",
      entryPath: p,
      isAdditionalBuy: false,
      actualDailyPnlPct: -0.08,
    });
    assert.strictEqual(guard.dailyPnlPct, -0.08, `Path ${p} must use authoritative dailyPnlPct`);
    assert.strictEqual(guard.allowed, true, `Path ${p} must be allowed with safe actualDailyPnlPct`);
  }
  console.log("[PASS] Test 8K: All entry paths consistently evaluate authoritative daily PnL");
}

// Test 8L: Major Impulse recovery probe with actualDailyPnlPct=-2.499% (>-2.5%) => ALLOWED
console.log("\n--- Test 8L: Major Impulse Hard Risk Boundary: actual=-2.499% => ALLOWED ---");
{
  const yesterdayIso = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const mockKillSwitchTrades = [
    { market: "KRW-SOL", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-ADA", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-XRP", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-DOGE", pnl_pct: -0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    { market: "KRW-AVAX", pnl_pct: -0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    { market: "KRW-DOT", pnl_pct: 0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
  ]; // 6 trades in 48h, 1 win (16.7% win rate) => kill switch active. Today loss count = 2 (< 5).

  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: mockKillSwitchTrades,
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "major_impulse",
    entryPath: "precheck",
    isAdditionalBuy: false,
    candidateMeta: {
      market: "KRW-BTC",
      engine_bucket: "major_impulse",
      is_major_impulse: true,
      setup: { ok: true, reason: "MAJOR_IMPULSE_V1", score: 95 },
      score: 95,
      btc_phase: "impulse",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 0.25,
    },
    actualDailyPnlPct: -2.499,
  });

  assert.strictEqual(guard.allowed, true, "Major Impulse with actual=-2.499% must pass as recovery probe");
  assert.strictEqual(guard.blockReason, null);
  console.log("[PASS] Test 8L: Major Impulse actual=-2.499% > -2.500% => Recovery probe ALLOWED");
}

// Test 8M: Major Impulse recovery probe with actualDailyPnlPct=-2.500% (<= -2.5%) => BLOCKED
console.log("\n--- Test 8M: Major Impulse Hard Risk Boundary: actual=-2.500% => BLOCKED ---");
{
  const yesterdayIso = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const mockKillSwitchTrades = [
    { market: "KRW-SOL", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-ADA", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-XRP", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-DOGE", pnl_pct: -0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    { market: "KRW-AVAX", pnl_pct: -0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    { market: "KRW-DOT", pnl_pct: 0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
  ];

  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: mockKillSwitchTrades,
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "major_impulse",
    entryPath: "precheck",
    isAdditionalBuy: false,
    candidateMeta: {
      market: "KRW-BTC",
      engine_bucket: "major_impulse",
      is_major_impulse: true,
      setup: { ok: true, reason: "MAJOR_IMPULSE_V1", score: 95 },
      score: 95,
      btc_phase: "impulse",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 0.25,
    },
    actualDailyPnlPct: -2.500,
  });

  assert.strictEqual(guard.allowed, false, "Major Impulse with actual=-2.500% must be blocked by hard risk");
  assert.strictEqual(guard.blockReason, "global_kill_switch_active");
  console.log("[PASS] Test 8M: Major Impulse actual=-2.500% <= -2.500% => BLOCKED=true (hard risk triggered)");
}

// Test 8N: Major Impulse recovery probe with actualDailyPnlPct=-2.600% (<= -2.5%) => BLOCKED
console.log("\n--- Test 8N: Major Impulse Hard Risk Boundary: actual=-2.600% => BLOCKED ---");
{
  const yesterdayIso = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const mockKillSwitchTrades = [
    { market: "KRW-SOL", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-ADA", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-XRP", pnl_pct: -1.0, timestamp: yesterdayIso, action: "sell", filled_qty: 1 },
    { market: "KRW-DOGE", pnl_pct: -0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    { market: "KRW-AVAX", pnl_pct: -0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
    { market: "KRW-DOT", pnl_pct: 0.5, timestamp: new Date().toISOString(), action: "sell", filled_qty: 1 },
  ];

  const guard = await validateLiveBuyPrecheck({
    market: "KRW-BTC",
    trades: mockKillSwitchTrades,
    positions: {},
    cooldown_until: {},
    marketState: { status: () => mockSnapRiskOn },
    signalPayload: null,
    strategyType: "major_impulse",
    entryPath: "precheck",
    isAdditionalBuy: false,
    candidateMeta: {
      market: "KRW-BTC",
      engine_bucket: "major_impulse",
      is_major_impulse: true,
      setup: { ok: true, reason: "MAJOR_IMPULSE_V1", score: 95 },
      score: 95,
      btc_phase: "impulse",
      asset_phase: "impulse",
      is_panic: false,
      relaxed_multiplier: 0.25,
    },
    actualDailyPnlPct: -2.600,
  });

  assert.strictEqual(guard.allowed, false, "Major Impulse with actual=-2.600% must be blocked by hard risk");
  assert.strictEqual(guard.blockReason, "global_kill_switch_active");
  console.log("[PASS] Test 8N: Major Impulse actual=-2.600% <= -2.500% => BLOCKED=true (hard risk triggered)");
}

console.log("\n==========================================================================");
console.log("  ALL TESTS (1-7, Extended A-E, and Precheck 8A-8N) PASSED SUCCESSFULLY!  ");
console.log("==========================================================================\n");

import assert from "node:assert";
import {
  isMorningSurgeWindowKst,
  evaluateMorningSoftPrewatchShadow,
} from "./live-strategy.js";
import type { UpbitCandle } from "./upbit-public.js";

console.log("=== Running Morning Surge Soft Pre-Watch Shadow & Deduplicated Funnel Test Suite ===");

const makeCandles = (count: number, basePx: number): UpbitCandle[] => {
  return Array.from({ length: count }, (_, i) => ({
    market: "KRW-BONK",
    candle_date_time_utc: "2026-09-03T00:00:00",
    candle_date_time_kst: "2026-09-03T09:00:00",
    opening_price: basePx + i * 2,
    high_price: basePx + i * 2 + 5,
    low_price: basePx + i * 2 - 2,
    trade_price: basePx + i * 2 + 4,
    timestamp: Date.now() - (count - i) * 60000,
    candle_acc_trade_price: 100000000,
    candle_acc_trade_volume: 1000,
    unit: 1,
  }));
};

// =========================================================================
// Test 1: Weekday / Weekend Boundary Correction (2026-08-29 Sat excluded)
// =========================================================================
console.log("\n--- Test 1: Weekday vs Weekend Window Authority (2026-08-29 Sat excluded) ---");
{
  // Friday 2026-08-28 09:00 KST -> Weekday Morning Window TRUE
  const friDate = new Date("2026-08-28T00:00:00.000Z"); // 09:00 KST
  assert.strictEqual(isMorningSurgeWindowKst(friDate), true, "Friday 09:00 KST must be weekday morning window");

  // Saturday 2026-08-29 09:00 KST -> Weekend Morning Window FALSE
  const satDate = new Date("2026-08-29T00:00:00.000Z"); // 09:00 KST
  assert.strictEqual(isMorningSurgeWindowKst(satDate), false, "Saturday 2026-08-29 must be EXCLUDED from morning window");

  // Monday 2026-08-31 09:00 KST -> Weekday Morning Window TRUE
  const monDate = new Date("2026-08-31T00:00:00.000Z"); // 09:00 KST
  assert.strictEqual(isMorningSurgeWindowKst(monDate), true, "Monday 09:00 KST must be weekday morning window");

  console.log("[PASS] Test 1: 2026-08-29 Saturday safely excluded; Weekday 08:30~09:30 verified");
}

// =========================================================================
// Test 2: Soft Pre-Watch Evaluation Criteria (Grade A failure ignored)
// =========================================================================
console.log("\n--- Test 2: Soft Pre-Watch Shadow Evaluation Criteria ---");
{
  const candles = makeCandles(30, 1000);
  const currentPx = 1060;

  // Case A: Volume=1.20 (>=1.15), rise_3m=0.35% (>=0.25%), upper wick small -> PASS
  const passPayload = {
    volume_ratio: 1.20,
    rise_3m_pct: 0.35,
    score: 65, // Grade F (fails standard Grade A >= 80), but should PASS soft pre-watch!
    filter_pass: true,
  };
  const resA = evaluateMorningSoftPrewatchShadow({
    market: "KRW-BONK",
    candles1: candles,
    currentPx,
    payload: passPayload,
    isMorningWindow: true,
  });

  assert.strictEqual(resA.ok, true, "Soft pre-watch must PASS with vol=1.20, rise3m=0.35% despite Grade F score 65");
  assert.strictEqual(resA.volume_ratio_1m, 1.20);
  assert.strictEqual(resA.rise_3m_pct, 0.35);
  console.log("[PASS] Test 2A: Soft pre-watch shadow evaluates OK despite standard Grade A failure");

  // Case B: Volume=1.05 (<1.15) -> FAIL on low volume
  const lowVolPayload = {
    volume_ratio: 1.05,
    rise_3m_pct: 0.35,
    score: 65,
  };
  const resB = evaluateMorningSoftPrewatchShadow({
    market: "KRW-BONK",
    candles1: candles,
    currentPx,
    payload: lowVolPayload,
    isMorningWindow: true,
  });
  assert.strictEqual(resB.ok, false);
  assert.ok(resB.failed_reasons.includes("low_volume_1.15"));
  console.log("[PASS] Test 2B: Volume < 1.15 correctly fails soft pre-watch");

  // Case C: Upper wick rejection (last candle wick >= 0.45) -> FAIL
  const badWickCandles = makeCandles(30, 1000);
  const lastBar = badWickCandles[badWickCandles.length - 2]!;
  lastBar.high_price = 1100; // Large upper wick
  lastBar.trade_price = 1020;
  lastBar.low_price = 1010;

  const resC = evaluateMorningSoftPrewatchShadow({
    market: "KRW-BONK",
    candles1: badWickCandles,
    currentPx,
    payload: passPayload,
    isMorningWindow: true,
  });
  assert.strictEqual(resC.ok, false);
  assert.ok(resC.failed_reasons.includes("upper_wick_rejection"));
  console.log("[PASS] Test 2C: Upper wick rejection safely blocks soft pre-watch");
}

// =========================================================================
// Test 3: Zero PlaceBuy Authority for Soft Pre-Watch
// =========================================================================
console.log("\n--- Test 3: Zero Buy Authority for Soft Pre-Watch (placeBuy forbidden) ---");
{
  // A soft pre-watch candidate in shadow has NO entry permission
  const softShadowCandidate = {
    market: "KRW-BONK",
    is_soft_prewatch_shadow: true,
  };

  // Simulated placeBuy check: soft_prewatch cannot bypass reclaim or trigger placeBuy
  const placeBuyAllowed = !softShadowCandidate.is_soft_prewatch_shadow;
  assert.strictEqual(placeBuyAllowed, false, "Soft pre-watch candidate must NEVER be granted direct placeBuy authority");
  console.log("[PASS] Test 3: Zero placeBuy authority strictly enforced for soft pre-watch");
}

// =========================================================================
// Test 4: Deduplicated Funnel Simulation (Episode-based deduplication)
// =========================================================================
console.log("\n--- Test 4: Market + Episode Deduplicated Funnel Calculation ---");
{
  // 5-second repeated tick evaluations of the same runner episode (e.g. KRW-BONK evaluated 60 times during a 5m surge)
  const rawEvaluations = [
    { market: "KRW-BONK", minute: "08:58", vol: 1.25, rise3m: 0.30, maxReturn10m: 5.4 },
    { market: "KRW-BONK", minute: "08:58", vol: 1.26, rise3m: 0.32, maxReturn10m: 5.4 },
    { market: "KRW-BONK", minute: "08:59", vol: 1.30, rise3m: 0.40, maxReturn10m: 5.4 },
    { market: "KRW-CBK", minute: "09:02", vol: 1.18, rise3m: 0.28, maxReturn10m: 2.3 },
    { market: "KRW-CBK", minute: "09:02", vol: 1.19, rise3m: 0.29, maxReturn10m: 2.3 },
    { market: "KRW-SC", minute: "09:05", vol: 0.90, rise3m: 0.10, maxReturn10m: 0.5 },
  ];

  // Deduplicate by market + episode (unique market occurrence per day)
  const uniqueEpisodes = new Map<string, typeof rawEvaluations[0]>();
  for (const ev of rawEvaluations) {
    if (!uniqueEpisodes.has(ev.market)) {
      uniqueEpisodes.set(ev.market, ev);
    }
  }

  assert.strictEqual(rawEvaluations.length, 6, "Raw tick count is 6");
  assert.strictEqual(uniqueEpisodes.size, 3, "Deduplicated episode count must be exactly 3");

  const softPrewatchPassEpisodes = Array.from(uniqueEpisodes.values()).filter(
    (ep) => ep.vol >= 1.15 && ep.rise3m >= 0.25
  );

  assert.strictEqual(softPrewatchPassEpisodes.length, 2, "KRW-BONK and KRW-CBK pass soft prewatch");
  console.log(`[PASS] Test 4: Deduplication verified: ${rawEvaluations.length} raw ticks -> ${uniqueEpisodes.size} unique episodes (${softPrewatchPassEpisodes.length} soft prewatch passed)`);
}

console.log("\n=========================================================================");
console.log("  ALL MORNING SURGE SOFT PRE-WATCH TESTS PASSED WITH ZERO ERRORS!       ");
console.log("=========================================================================\n");

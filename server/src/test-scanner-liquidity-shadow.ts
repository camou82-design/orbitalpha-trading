import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  calculateLiquidityRankBonus,
  computeShadowLiquidityScore,
  LiquidityShadowTracker,
  type ShadowCandidateMeta,
} from "./scanner-liquidity-shadow.js";
import { createPumpScanner } from "./pump-scanner.js";

function formatSpotDisplayPrice(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val) || val <= 0) return "—";
  if (val >= 1000) {
    return `${Math.round(val).toLocaleString()}원`;
  }
  if (val >= 100) {
    return `${val.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}원`;
  }
  if (val >= 10) {
    return `${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원`;
  }
  if (val >= 1) {
    return `${val.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}원`;
  }
  return `${val.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}원`;
}

async function runTests() {
  console.log("=== [START] Scanner Liquidity Shadow Tests ===");

  // 1. Liquidity Rank Bonus Boundaries
  console.log("1. Testing Liquidity Rank Bonus Boundaries...");
  assert.equal(calculateLiquidityRankBonus(1), 15, "Rank 1 must get +15");
  assert.equal(calculateLiquidityRankBonus(5), 15, "Rank 5 must get +15");
  assert.equal(calculateLiquidityRankBonus(6), 12, "Rank 6 must get +12");
  assert.equal(calculateLiquidityRankBonus(10), 12, "Rank 10 must get +12");
  assert.equal(calculateLiquidityRankBonus(11), 9, "Rank 11 must get +9");
  assert.equal(calculateLiquidityRankBonus(20), 9, "Rank 20 must get +9");
  assert.equal(calculateLiquidityRankBonus(21), 6, "Rank 21 must get +6");
  assert.equal(calculateLiquidityRankBonus(30), 6, "Rank 30 must get +6");
  assert.equal(calculateLiquidityRankBonus(31), 3, "Rank 31 must get +3");
  assert.equal(calculateLiquidityRankBonus(50), 3, "Rank 50 must get +3");
  assert.equal(calculateLiquidityRankBonus(51), 0, "Rank 51 must get +0");
  assert.equal(calculateLiquidityRankBonus(100), 0, "Rank 100 must get +0");
  assert.equal(calculateLiquidityRankBonus(0), 0, "Rank 0 must get +0");
  assert.equal(calculateLiquidityRankBonus(-1), 0, "Negative rank must get +0");
  assert.equal(calculateLiquidityRankBonus(NaN), 0, "NaN rank must get +0");
  console.log("  ✓ Bonus boundaries verified.");

  // 2. Score clamping & non-overwriting
  console.log("2. Testing Score Clamping & Non-Overwriting...");
  const baseLiveScore = 92.5;
  const resTop5 = computeShadowLiquidityScore(baseLiveScore, 3);
  assert.equal(resTop5.shadow_liquidity_bonus, 15);
  assert.equal(resTop5.shadow_liquidity_score, 100, "92.5 + 15 = 107.5 clamped to 100");
  assert.equal(baseLiveScore, 92.5, "Original live score must remain unchanged");

  const resLow = computeShadowLiquidityScore(45.0, 15);
  assert.equal(resLow.shadow_liquidity_bonus, 9);
  assert.equal(resLow.shadow_liquidity_score, 54.0);
  console.log("  ✓ Score clamping and non-overwriting verified.");

  // 3. Shadow Tracker Tick Comparison (A vs B Top 3, Overlap, A-only, B-only)
  console.log("3. Testing Shadow Tracker Tick Ranking & Separation...");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-test-"));
  const tempFile = path.join(tempDir, "shadow_report.json");
  const tracker = new LiquidityShadowTracker(tempFile);

  const mockCandidates: ShadowCandidateMeta[] = [
    {
      market: "KRW-MOM1", // High momentum, low liquidity rank
      score_a: 85,
      score_b: 85 + 0, // rank 60 => +0
      acc_trade_price_24h: 2_000_000_000,
      liquidity_rank: 60,
      liquidity_bonus: 0,
      volume_multiple: 4.2,
      rise_3m_pct: 2.1,
      breakout: true,
      close_upper_hold: true,
      early_entry_eligible: true,
      add_entry_eligible: false,
      entry_price: 1000,
    },
    {
      market: "KRW-MOM2", // Med momentum, high liquidity rank (Top 5 => +15)
      score_a: 75,
      score_b: 75 + 15, // 90
      acc_trade_price_24h: 150_000_000_000,
      liquidity_rank: 2,
      liquidity_bonus: 15,
      volume_multiple: 3.5,
      rise_3m_pct: 1.5,
      breakout: true,
      close_upper_hold: true,
      early_entry_eligible: false,
      add_entry_eligible: true,
      entry_price: 50000,
    },
    {
      market: "KRW-MOM3", // Med momentum, top 10 => +12
      score_a: 72,
      score_b: 72 + 12, // 84
      acc_trade_price_24h: 80_000_000_000,
      liquidity_rank: 8,
      liquidity_bonus: 12,
      volume_multiple: 2.8,
      rise_3m_pct: 1.2,
      breakout: false,
      close_upper_hold: true,
      early_entry_eligible: false,
      add_entry_eligible: false,
      entry_price: 250,
    },
    {
      market: "KRW-MOM4", // High momentum, rank 45 => +3
      score_a: 80,
      score_b: 80 + 3, // 83
      acc_trade_price_24h: 5_000_000_000,
      liquidity_rank: 45,
      liquidity_bonus: 3,
      volume_multiple: 3.1,
      rise_3m_pct: 1.8,
      breakout: true,
      close_upper_hold: false,
      early_entry_eligible: true,
      add_entry_eligible: false,
      entry_price: 15.5,
    },
  ];

  const priceBy = new Map([
    ["KRW-MOM1", 1000],
    ["KRW-MOM2", 50000],
    ["KRW-MOM3", 250],
    ["KRW-MOM4", 15.5],
  ]);

  const tickResult = tracker.onTick({
    ts: new Date().toISOString(),
    tradableCandidates: mockCandidates,
    priceBy,
  });

  // A list sorted by score_a: MOM1 (85), MOM4 (80), MOM2 (75), MOM3 (72)
  // A Top 3: [KRW-MOM1, KRW-MOM4, KRW-MOM2]
  assert.deepEqual(tickResult.a_top3, ["KRW-MOM1", "KRW-MOM4", "KRW-MOM2"]);

  // B list sorted by score_b: MOM2 (90), MOM1 (85), MOM3 (84), MOM4 (83)
  // B Top 3: [KRW-MOM2, KRW-MOM1, KRW-MOM3]
  assert.deepEqual(tickResult.b_top3, ["KRW-MOM2", "KRW-MOM1", "KRW-MOM3"]);

  // Overlap: MOM1, MOM2
  assert.deepEqual(tickResult.overlap.sort(), ["KRW-MOM1", "KRW-MOM2"].sort());
  // A only: MOM4
  assert.deepEqual(tickResult.a_only, ["KRW-MOM4"]);
  // B only: MOM3
  assert.deepEqual(tickResult.b_only, ["KRW-MOM3"]);

  console.log("  ✓ Tick ranking and candidate separation verified.");

  // 4. Performance evaluation (3m, 5m, 10m, MFE, MAE)
  console.log("4. Testing 3m/5m/10m Returns, MFE, MAE Tracking...");
  const rows = tracker.getRows();
  const pending = tracker.getPending();
  assert.equal(rows.length, 4, "4 unique markets should be captured across A/B top 3");
  assert.equal(pending.length, 4);

  // Fast forward pending due times for 3m
  for (const p of pending) {
    p.due3 = Date.now() - 1000;
  }

  // Simulate price changes at 3m:
  // MOM1: +2.5% (1000 -> 1025)
  // MOM2: +4.0% (50000 -> 52000)
  // MOM3: -1.2% (250 -> 247)
  // MOM4: +0.5% (15.5 -> 15.5775)
  const priceBy3m = new Map([
    ["KRW-MOM1", 1025],
    ["KRW-MOM2", 52000],
    ["KRW-MOM3", 247],
    ["KRW-MOM4", 15.5775],
  ]);
  tracker.updatePending(priceBy3m);

  const rowMom1 = rows.find((r) => r.market === "KRW-MOM1")!;
  const rowMom2 = rows.find((r) => r.market === "KRW-MOM2")!;
  const rowMom3 = rows.find((r) => r.market === "KRW-MOM3")!;
  const rowMom4 = rows.find((r) => r.market === "KRW-MOM4")!;

  assert.equal(rowMom1.saved_3m, true);
  assert.equal(rowMom1.return_3m_pct, 2.5);
  assert.equal(rowMom2.return_3m_pct, 4.0);
  assert.equal(rowMom3.return_3m_pct, -1.2);
  assert.equal(rowMom4.return_3m_pct, 0.5);

  // Fast forward to 5m
  for (const p of tracker.getPending()) {
    p.due5 = Date.now() - 1000;
  }
  const priceBy5m = new Map([
    ["KRW-MOM1", 1040], // +4%
    ["KRW-MOM2", 53000], // +6%
    ["KRW-MOM3", 252],   // +0.8%
    ["KRW-MOM4", 15.4],  // -0.645%
  ]);
  tracker.updatePending(priceBy5m);
  assert.equal(rowMom1.saved_5m, true);
  assert.equal(rowMom1.return_5m_pct, 4.0);

  // Intermediate excursion (due10 still in future)
  const pricePeak = new Map([
    ["KRW-MOM1", 1060], // +6% peak
    ["KRW-MOM2", 54000], // +8% peak
    ["KRW-MOM3", 260],  // +4% peak
    ["KRW-MOM4", 15.0], // -3.226% trough
  ]);
  tracker.updatePending(pricePeak);

  // Fast forward to 10m
  for (const p of tracker.getPending()) {
    p.due10 = Date.now() - 1000;
  }

  // Final 10m price
  const priceBy10m = new Map([
    ["KRW-MOM1", 1030], // +3%
    ["KRW-MOM2", 53500], // +7%
    ["KRW-MOM3", 255],  // +2%
    ["KRW-MOM4", 15.2], // -1.935%
  ]);
  tracker.updatePending(priceBy10m);

  assert.equal(rowMom1.saved_10m, true);
  assert.equal(rowMom1.return_10m_pct, 3.0);
  assert.equal(rowMom1.max_favorable_excursion_10m_pct, 6.0);

  assert.equal(rowMom2.saved_10m, true);
  assert.equal(rowMom2.return_10m_pct, 7.0);
  assert.equal(rowMom2.max_favorable_excursion_10m_pct, 8.0);

  assert.equal(rowMom3.saved_10m, true);
  assert.equal(rowMom3.return_10m_pct, 2.0);

  assert.equal(rowMom4.saved_10m, true);
  assert.equal(rowMom4.return_10m_pct, -1.935);
  assert.equal(rowMom4.max_adverse_excursion_10m_pct, -3.226);

  console.log("  ✓ 3m/5m/10m and MFE/MAE tracking verified.");

  // 5. Comparison Summary & Persist
  console.log("5. Testing Summary Aggregates & Persist...");
  const report = tracker.getSummaryReport();
  assert.equal(report.mode, "shadow_only");
  assert.equal(report.live_authority, "momentum_A");
  assert.equal(report.shadow_order_authority, "NONE");
  assert.equal(report.sample_count, 4);

  assert.ok(report.summary.A.avg_return_10m !== null);
  assert.equal(report.summary.A.avg_return_10m, 2.688);
  assert.equal(report.summary.A.win_rate_10m, 66.7);

  assert.ok(report.summary.B.avg_return_10m !== null);
  assert.equal(report.summary.B.avg_return_10m, 4.0);
  assert.equal(report.summary.B.win_rate_10m, 100);

  assert.equal(report.summary.A_only.sample_count, 1);
  assert.equal(report.summary.A_only.avg_return_10m, -1.935);

  assert.equal(report.summary.B_only.sample_count, 1);
  assert.equal(report.summary.B_only.avg_return_10m, 2.0);

  await tracker.persist();
  const fileRaw = await fs.readFile(tempFile, "utf8");
  const parsedFile = JSON.parse(fileRaw);
  assert.equal(parsedFile.live_authority, "momentum_A");
  assert.equal(parsedFile.shadow_order_authority, "NONE");
  assert.equal(parsedFile.summary.overlap_count, 2);

  await fs.rm(tempDir, { recursive: true, force: true });
  console.log("  ✓ Summary aggregates and persistence verified.");

  // 6. Live Scanner Authority & Signal Feed Verification
  console.log("6. Testing Live Scanner Authority & Signal Feed Isolation...");
  const scanner = createPumpScanner();
  const status = scanner.status();
  assert.ok(status.liquidity_shadow !== undefined, "Status must include liquidity_shadow summary");
  assert.equal(status.liquidity_shadow.live_authority, "momentum_A");
  assert.equal(status.liquidity_shadow.shadow_order_authority, "NONE");

  const feed = scanner.signalFeed();
  for (const item of feed) {
    assert.equal(typeof item.score, "number");
    assert.equal(typeof item.scanner_score, "number");
    assert.equal(item.score, item.scanner_score, "Live score and scanner_score must be identical");
  }
  console.log("  ✓ Live authority & Signal feed isolation verified.");

  // 7. Spot Price Display Formatter
  console.log("7. Testing Spot Price Display Formatter...");
  assert.equal(formatSpotDisplayPrice(152000000), "152,000,000원");
  assert.equal(formatSpotDisplayPrice(1540.2), "1,540원");
  assert.equal(formatSpotDisplayPrice(123.456), "123.5원");
  assert.equal(formatSpotDisplayPrice(45.678), "45.68원");
  assert.equal(formatSpotDisplayPrice(4.5678), "4.568원");
  assert.equal(formatSpotDisplayPrice(0.123456), "0.123456원");
  assert.equal(formatSpotDisplayPrice(0), "—");
  assert.equal(formatSpotDisplayPrice(null), "—");
  console.log("  ✓ Spot price formatter verified.");

  console.log("=== [PASS] All Scanner Liquidity Shadow Tests PASSED ===");
}

runTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});

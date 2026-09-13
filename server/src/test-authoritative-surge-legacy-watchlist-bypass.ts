import assert from "node:assert";
import {
  isAuthoritativeFreshScannerSurgeCandidate,
  isDownstreamLateTimingHardBlocked,
} from "./live-strategy.js";

console.log("=== Running Authoritative Scanner Surge & Timing Precedence Regression Tests ===");

// =========================================================================
// 1. Authoritative Bypass Unit Tests (A1 - A5)
// =========================================================================
console.log("\n--- Part 1: Authoritative Scanner Surge Bypass Helper Tests ---");
{
  // A1: Authoritative Candidate -> true
  const resA1 = isAuthoritativeFreshScannerSurgeCandidate({
    payloadSourceKind: "scanner_tradable_candidate",
    sourceKindForJudgment: "scanner_filter_fresh",
    engineBucket: "surge",
    setupOk: true,
  });
  assert.strictEqual(resA1, true);
  console.log("[PASS] A1: Authoritative fresh scanner surge candidate => true");

  // A2: setupOk=false -> false
  const resA2 = isAuthoritativeFreshScannerSurgeCandidate({
    payloadSourceKind: "scanner_tradable_candidate",
    sourceKindForJudgment: "scanner_filter_fresh",
    engineBucket: "surge",
    setupOk: false,
  });
  assert.strictEqual(resA2, false);
  console.log("[PASS] A2: setupOk=false => false");

  // A3: payloadSourceKind differs -> false
  const testSources = ["scanner", "scanner_then_filter_pass", "CORE_TRADE", "fallback_watch_markets", "", null, undefined];
  for (const src of testSources) {
    const res = isAuthoritativeFreshScannerSurgeCandidate({
      payloadSourceKind: src,
      sourceKindForJudgment: "scanner_filter_fresh",
      engineBucket: "surge",
      setupOk: true,
    });
    assert.strictEqual(res, false);
  }
  console.log("[PASS] A3: non-scanner_tradable_candidate payload sources => false");

  // A4: sourceKindForJudgment stale / fallback / watch -> false
  const testJudgments = ["legacy_filter_pass", "fallback_watch_markets", "fresh_filter_pass", "CORE_TRADE", "scanner_then_filter_pass", "", null, undefined];
  for (const jdg of testJudgments) {
    const res = isAuthoritativeFreshScannerSurgeCandidate({
      payloadSourceKind: "scanner_tradable_candidate",
      sourceKindForJudgment: jdg,
      engineBucket: "surge",
      setupOk: true,
    });
    assert.strictEqual(res, false);
  }
  console.log("[PASS] A4: non-scanner_filter_fresh judgment sources => false");

  // A5: engineBucket != surge -> false
  const testBuckets = ["core", "major_impulse", "other", "", null, undefined];
  for (const bkt of testBuckets) {
    const res = isAuthoritativeFreshScannerSurgeCandidate({
      payloadSourceKind: "scanner_tradable_candidate",
      sourceKindForJudgment: "scanner_filter_fresh",
      engineBucket: bkt,
      setupOk: true,
    });
    assert.strictEqual(res, false);
  }
  console.log("[PASS] A5: non-surge engine buckets => false");
}

// =========================================================================
// 2. Timing Precedence & Probe Exemption Required Regression Tests (A - E)
// =========================================================================
console.log("\n--- Part 2: Hard Block vs Probe Precedence Contract Tests ---");

// Test A: BLAST Reproduction (probe=false + late_chase hard block => BLOCK)
console.log("\n--- Test A: BLAST Reproduction (probe=false + late_chase hard block => BLOCK) ---");
{
  const isBlocked = isDownstreamLateTimingHardBlocked({
    lateTimingTier: "hard_block",
    entryAllowedByTiming: false,
    lateEntryGuardTriggered: true,
    isNearHighProbeAllowed: false,
    surgeHardBlockTriggered: false,
  });
  assert.strictEqual(isBlocked, true, "BLAST late chase must be hard blocked");
  console.log("[PASS] Test A: BLAST late chase correctly hard blocked");
}

// Test B: Probe=true but subsequent late_chase occurred => MUST BE BLOCKED
console.log("\n--- Test B: Probe=true but late_chase occurred => MUST BE BLOCKED ---");
{
  const isBlocked = isDownstreamLateTimingHardBlocked({
    lateTimingTier: "hard_block",
    entryAllowedByTiming: false,
    lateEntryGuardTriggered: true,
    isNearHighProbeAllowed: true, // Even if probe flag was claimed
    surgeHardBlockTriggered: false,
  });
  assert.strictEqual(isBlocked, true, "Hard block MUST take precedence over probe exemption");
  console.log("[PASS] Test B: Hard block strictly overrides probe claim");
}

// Test C: Probe=true but volume-fade / market panic hard block occurred => MUST BE BLOCKED
console.log("\n--- Test C: Probe=true but volume-fade hard block occurred => MUST BE BLOCKED ---");
{
  const isBlocked = isDownstreamLateTimingHardBlocked({
    lateTimingTier: "hard_block",
    entryAllowedByTiming: false,
    lateEntryGuardTriggered: true,
    isNearHighProbeAllowed: true,
    surgeHardBlockTriggered: true,
  });
  assert.strictEqual(isBlocked, true, "Volume-fade / panic hard block MUST take precedence over probe");
  console.log("[PASS] Test C: Volume fade hard block strictly overrides probe claim");
}

// Test D: Pure near-high legal probe (No independent hard block) => PASS (Not hard blocked)
console.log("\n--- Test D: Pure near-high legal probe (No hard blocks) => PASS ---");
{
  const isBlocked = isDownstreamLateTimingHardBlocked({
    lateTimingTier: "reduced_size_allowed",
    entryAllowedByTiming: true,
    lateEntryGuardTriggered: false,
    surgeHardBlockTriggered: false,
    isNearHighProbeAllowed: true,
  });
  assert.strictEqual(isBlocked, false, "Legal near-high probe without hard block must pass");
  console.log("[PASS] Test D: Legal near-high scout probe safely allowed");
}

// Test E: Clean authoritative scanner surge (No hard blocks) => PASS
console.log("\n--- Test E: Clean authoritative scanner surge => PASS ---");
{
  const isBlocked = isDownstreamLateTimingHardBlocked({
    lateTimingTier: "normal",
    entryAllowedByTiming: true,
    lateEntryGuardTriggered: false,
    surgeHardBlockTriggered: false,
    isNearHighProbeAllowed: false,
  });
  assert.strictEqual(isBlocked, false, "Clean authoritative candidate must proceed to placeBuy");
  console.log("[PASS] Test E: Clean authoritative candidate safely allowed through");
}

console.log("\n=== ALL PRE-COMMIT REGRESSION TESTS PASSED (A-E) ===");

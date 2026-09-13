import assert from "node:assert";
import { isAuthoritativeFreshScannerSurgeCandidate } from "./live-strategy.js";

console.log("=== Running Authoritative Scanner Surge Production Helper Regression Tests ===");

// =========================================================================
// Test A: scanner_tradable_candidate + scanner_filter_fresh + surge + setupOk=true => true
// =========================================================================
console.log("\n--- Test A: Authoritative fresh scanner surge candidate => true ---");
{
  const result = isAuthoritativeFreshScannerSurgeCandidate({
    payloadSourceKind: "scanner_tradable_candidate",
    sourceKindForJudgment: "scanner_filter_fresh",
    engineBucket: "surge",
    setupOk: true,
  });
  assert.strictEqual(result, true, "Authoritative fresh scanner surge candidate must evaluate to true");
  console.log("[PASS] Test A: isAuthoritativeFreshScannerSurgeCandidate returned true");
}

// =========================================================================
// Test B: setupOk=false => false
// =========================================================================
console.log("\n--- Test B: setupOk=false => false ---");
{
  const result = isAuthoritativeFreshScannerSurgeCandidate({
    payloadSourceKind: "scanner_tradable_candidate",
    sourceKindForJudgment: "scanner_filter_fresh",
    engineBucket: "surge",
    setupOk: false,
  });
  assert.strictEqual(result, false, "setupOk=false must evaluate to false");
  console.log("[PASS] Test B: setupOk=false correctly returned false");
}

// =========================================================================
// Test C: payloadSourceKind differs => false
// =========================================================================
console.log("\n--- Test C: payloadSourceKind differs => false ---");
{
  const testSources = ["scanner", "scanner_then_filter_pass", "CORE_TRADE", "fallback_watch_markets", "", null, undefined];
  for (const src of testSources) {
    const result = isAuthoritativeFreshScannerSurgeCandidate({
      payloadSourceKind: src,
      sourceKindForJudgment: "scanner_filter_fresh",
      engineBucket: "surge",
      setupOk: true,
    });
    assert.strictEqual(result, false, `payloadSourceKind=${src} must evaluate to false`);
  }
  console.log("[PASS] Test C: non-scanner_tradable_candidate payload sources correctly returned false");
}

// =========================================================================
// Test D: sourceKindForJudgment stale / fallback / watch => false
// =========================================================================
console.log("\n--- Test D: sourceKindForJudgment stale / fallback / watch => false ---");
{
  const testJudgments = ["legacy_filter_pass", "fallback_watch_markets", "fresh_filter_pass", "CORE_TRADE", "scanner_then_filter_pass", "", null, undefined];
  for (const jdg of testJudgments) {
    const result = isAuthoritativeFreshScannerSurgeCandidate({
      payloadSourceKind: "scanner_tradable_candidate",
      sourceKindForJudgment: jdg,
      engineBucket: "surge",
      setupOk: true,
    });
    assert.strictEqual(result, false, `sourceKindForJudgment=${jdg} must evaluate to false`);
  }
  console.log("[PASS] Test D: non-scanner_filter_fresh judgment sources correctly returned false");
}

// =========================================================================
// Test E: engineBucket != surge => false
// =========================================================================
console.log("\n--- Test E: engineBucket != surge => false ---");
{
  const testBuckets = ["core", "major_impulse", "other", "", null, undefined];
  for (const bkt of testBuckets) {
    const result = isAuthoritativeFreshScannerSurgeCandidate({
      payloadSourceKind: "scanner_tradable_candidate",
      sourceKindForJudgment: "scanner_filter_fresh",
      engineBucket: bkt,
      setupOk: true,
    });
    assert.strictEqual(result, false, `engineBucket=${bkt} must evaluate to false`);
  }
  console.log("[PASS] Test E: non-surge engine buckets correctly returned false");
}

console.log("\n=== ALL PRODUCTION HELPER REGRESSION TESTS PASSED (A-E) ===");

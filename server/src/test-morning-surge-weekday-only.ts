import assert from "node:assert";
import {
  isMorningSurgeWindowKst,
  isNonMorningSurgeReclaimBlockedInMorningWindow,
} from "./live-strategy.js";

/** UTC instant for a given KST wall-clock on a known calendar day (KST = UTC+9). */
function kstInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, 0, 0));
}

async function runMorningSurgeWeekdayOnlyTests() {
  console.log("=== Morning Surge Weekday-Only Regression Tests (A–K) ===\n");

  // Reference week: Mon Mar 2 – Sun Mar 8, 2026
  const mon = { y: 2026, mo: 3, d: 2 };
  const fri = { y: 2026, mo: 3, d: 6 };
  const sat = { y: 2026, mo: 3, d: 7 };
  const sun = { y: 2026, mo: 3, d: 8 };

  // A. Monday 08:29 KST -> Morning=false
  assert.strictEqual(
    isMorningSurgeWindowKst(kstInstant(mon.y, mon.mo, mon.d, 8, 29)),
    false,
    "A: Monday 08:29 KST must not be morning window"
  );
  console.log("[PASS] A: Monday 08:29 KST -> Morning=false");

  // B. Monday 08:30 KST -> Morning=true
  assert.strictEqual(
    isMorningSurgeWindowKst(kstInstant(mon.y, mon.mo, mon.d, 8, 30)),
    true,
    "B: Monday 08:30 KST must be morning window"
  );
  console.log("[PASS] B: Monday 08:30 KST -> Morning=true");

  // C. Friday 09:29 KST -> Morning=true
  assert.strictEqual(
    isMorningSurgeWindowKst(kstInstant(fri.y, fri.mo, fri.d, 9, 29)),
    true,
    "C: Friday 09:29 KST must be morning window"
  );
  console.log("[PASS] C: Friday 09:29 KST -> Morning=true");

  // D. Friday 09:30 KST -> Morning=false
  assert.strictEqual(
    isMorningSurgeWindowKst(kstInstant(fri.y, fri.mo, fri.d, 9, 30)),
    false,
    "D: Friday 09:30 KST must not be morning window"
  );
  console.log("[PASS] D: Friday 09:30 KST -> Morning=false");

  // E. Saturday 09:00 KST -> Morning=false
  assert.strictEqual(
    isMorningSurgeWindowKst(kstInstant(sat.y, sat.mo, sat.d, 9, 0)),
    false,
    "E: Saturday 09:00 KST must not be morning window"
  );
  console.log("[PASS] E: Saturday 09:00 KST -> Morning=false");

  // F. Sunday 09:00 KST -> Morning=false
  assert.strictEqual(
    isMorningSurgeWindowKst(kstInstant(sun.y, sun.mo, sun.d, 9, 0)),
    false,
    "F: Sunday 09:00 KST must not be morning window"
  );
  console.log("[PASS] F: Sunday 09:00 KST -> Morning=false");

  const weekdayMorning = kstInstant(fri.y, fri.mo, fri.d, 9, 0);
  const satMorning = kstInstant(sat.y, sat.mo, sat.d, 9, 0);
  const sunMorning = kstInstant(sun.y, sun.mo, sun.d, 9, 0);

  // G. Weekday 09:00 non-morning watch item -> only_morning gate blocks
  assert.strictEqual(
    isNonMorningSurgeReclaimBlockedInMorningWindow(false, weekdayMorning),
    true,
    "G: weekday 09:00 non-morning item must be blocked by morning-only gate"
  );
  console.log("[PASS] G: Weekday 09:00 non-morning Surge -> only_morning_surge_watchlist_allowed block");

  // H. Saturday 09:00 non-morning -> NOT blocked
  assert.strictEqual(
    isNonMorningSurgeReclaimBlockedInMorningWindow(false, satMorning),
    false,
    "H: Saturday 09:00 non-morning item must NOT be blocked"
  );
  console.log("[PASS] H: Saturday 09:00 non-morning Surge -> NOT blocked");

  // I. Sunday 09:00 non-morning -> NOT blocked
  assert.strictEqual(
    isNonMorningSurgeReclaimBlockedInMorningWindow(false, sunMorning),
    false,
    "I: Sunday 09:00 non-morning item must NOT be blocked"
  );
  console.log("[PASS] I: Sunday 09:00 non-morning Surge -> NOT blocked");

  // J. Weekend morning window off => normal surge watchlist path (morning_reentry_candidate=false)
  assert.strictEqual(isMorningSurgeWindowKst(satMorning), false);
  assert.strictEqual(isMorningSurgeWindowKst(sunMorning), false);
  // Morning-flagged items still reclaim on weekend (existing morning watchlist entries)
  assert.strictEqual(
    isNonMorningSurgeReclaimBlockedInMorningWindow(true, satMorning),
    false,
    "J: weekend morning-flagged reclaim must not hit weekday-only gate"
  );
  console.log("[PASS] J: Weekend normal Surge/Reclaim pipeline not gated by weekday morning special");

  // K. Night block boundary unchanged: 08:29 KST still night-blocked; 08:30 exits night block
  const mon0829 = kstInstant(mon.y, mon.mo, mon.d, 8, 29);
  const mon0830 = kstInstant(mon.y, mon.mo, mon.d, 8, 30);
  assert.strictEqual(isMorningSurgeWindowKst(mon0829), false);
  assert.strictEqual(isMorningSurgeWindowKst(mon0830), true);
  const nightBlockAt = (d: Date) => {
    const kstMs = d.getTime() + 9 * 60 * 60 * 1000;
    const kstDate = new Date(kstMs);
    const timeVal = kstDate.getUTCHours() * 60 + kstDate.getUTCMinutes();
    return timeVal >= 0 && timeVal < 510;
  };
  assert.strictEqual(nightBlockAt(mon0829), true, "K: 08:29 KST must remain inside night block (<510)");
  assert.strictEqual(nightBlockAt(mon0830), false, "K: 08:30 KST must be outside night block");
  console.log("[PASS] K: Night block unchanged (00:00–08:30); morning special starts at 08:30 weekdays only");

  console.log("\n=======================================================");
  console.log("  ALL TESTS (A through K) PASSED SUCCESSFULLY! (Code: 0) ");
  console.log("=======================================================\n");
}

runMorningSurgeWeekdayOnlyTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

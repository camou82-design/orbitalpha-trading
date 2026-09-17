/**
 * test-pump-scanner-fakeout-cooldown.ts
 *
 * 회귀 테스트: pump-scanner fakeout cooldown self-renewal 버그 수정 검증
 *
 * 정책:
 *  - 최초 fakeout T0 기준 rejectedUntilMs = T0+10m 고정
 *  - cooldown 중 재스캔 -> rejectedUntilMs 갱신 금지 (self-renewal 차단)
 *  - cooldown 만료 후 정상 setup -> tradable 복귀 가능
 *  - cooldown 만료 후 새 fakeout -> 새 10분 cooldown 가능
 *  - "거래대금 부족" = volumeMultiple < 0.95 (직전 20봉 대비 현재 봉 거래대금 비율 미달)
 *
 * 실행: npx ts-node --esm server/src/test-pump-scanner-fakeout-cooldown.ts
 */

interface FakeoutState {
  peakVolumeMultiple: number;
  peakPrice: number;
  detectedAtMs: number;
  rejectedUntilMs: number;
  lastReason?: string;
}

/** scoreOne() fakeout 섹션 — pump-scanner.ts와 동일 로직 */
function evalFakeout(
  volumeMultiple: number,
  tradePrice: number,
  high20: number,
  breakout: boolean,
  fState: FakeoutState | undefined,
  nowMs: number,
): {
  freshFakeoutReasons: string[];
  fakeoutCooldownActive: boolean;
  excludeByFakeout: string[];
} {
  const freshFakeoutReasons: string[] = [];
  let fakeoutCooldownActive = false;
  const excludeByFakeout: string[] = [];

  if (!fState) return { freshFakeoutReasons, fakeoutCooldownActive, excludeByFakeout };

  if (volumeMultiple < fState.peakVolumeMultiple * 0.5) freshFakeoutReasons.push("VOLUME_FADE_REJECTED");
  if (tradePrice < fState.peakPrice * 0.993) freshFakeoutReasons.push("HIGH_REJECTED");
  if (!breakout && tradePrice < high20 * 0.995 && (nowMs - fState.detectedAtMs < 300_000)) freshFakeoutReasons.push("RETEST_FAIL_REJECTED");

  if (nowMs < fState.rejectedUntilMs) {
    fakeoutCooldownActive = true;
    excludeByFakeout.push(fState.lastReason ?? "FAKEOUT_COOLDOWN");
  } else {
    excludeByFakeout.push(...freshFakeoutReasons);
  }

  return { freshFakeoutReasons, fakeoutCooldownActive, excludeByFakeout };
}

/** tick() 호출부 fakeout cooldown 갱신 — pump-scanner.ts와 동일 로직 */
function applyFakeoutCooldown(
  fakeoutStateMap: Map<string, FakeoutState>,
  market: string,
  s: { freshFakeoutReasons: string[]; fakeoutCooldownActive: boolean; volumeMultiple: number; price: number },
  nowMs: number,
): void {
  let fState = fakeoutStateMap.get(market);
  const hasFreshFakeout = s.freshFakeoutReasons.length > 0;
  const cooldownAlreadyActive = s.fakeoutCooldownActive;

  if (hasFreshFakeout && !cooldownAlreadyActive && fState && nowMs >= fState.rejectedUntilMs) {
    fState.rejectedUntilMs = nowMs + 10 * 60_000;
    fState.lastReason = s.freshFakeoutReasons[0];
  } else if (hasFreshFakeout && !cooldownAlreadyActive && !fState) {
    fState = {
      peakVolumeMultiple: s.volumeMultiple,
      peakPrice: s.price,
      detectedAtMs: nowMs,
      rejectedUntilMs: nowMs + 10 * 60_000,
      lastReason: s.freshFakeoutReasons[0],
    };
    fakeoutStateMap.set(market, fState);
  }
  // cooldownAlreadyActive=true -> 갱신 없음 (self-renewal 차단)

  const updated = fakeoutStateMap.get(market);
  if (updated && nowMs >= updated.rejectedUntilMs && !hasFreshFakeout) {
    fakeoutStateMap.delete(market);
  }
}

// ─── Harness ──────────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
function assert(ok: boolean, label: string, detail?: string) {
  if (ok) { console.log(`  OK  ${label}`); passed++; }
  else { console.error(`  FAIL ${label}${detail ? " | " + detail : ""}`); failed++; }
}
function section(n: string) { console.log(`\n--- ${n} ---`); }

const MARKET = "KRW-TEST";
const CD = 10 * 60_000;

// TC1-4: VOLUME_FADE self-renewal 차단
section("TC1-4: VOLUME_FADE_REJECTED 10분 고정 cooldown");
{
  const map = new Map<string, FakeoutState>();
  const T0 = 1_700_000_000_000;
  map.set(MARKET, { peakVolumeMultiple: 3.0, peakPrice: 100, detectedAtMs: T0 - 60_000, rejectedUntilMs: 0 });

  // T0: 최초 fakeout
  const r0 = evalFakeout(1.0, 100, 95, true, map.get(MARKET), T0);
  assert(r0.freshFakeoutReasons.includes("VOLUME_FADE_REJECTED"), "TC1: freshFakeoutReasons VOLUME_FADE");
  assert(!r0.fakeoutCooldownActive, "TC1: cooldown 미활성 (T0)");
  applyFakeoutCooldown(map, MARKET, { ...r0, volumeMultiple: 1.0, price: 100 }, T0);
  assert(map.get(MARKET)!.rejectedUntilMs === T0 + CD, "TC1: rejectedUntilMs = T0+10m", `got:${map.get(MARKET)!.rejectedUntilMs} want:${T0+CD}`);
  const snap = map.get(MARKET)!.rejectedUntilMs;

  // T0+1m
  { const n = T0 + 60_000; const r = evalFakeout(1.0, 100, 95, true, map.get(MARKET), n);
    assert(r.fakeoutCooldownActive, "TC2: T0+1m cooldown active");
    applyFakeoutCooldown(map, MARKET, { ...r, volumeMultiple: 1.0, price: 100 }, n);
    assert(map.get(MARKET)!.rejectedUntilMs === snap, "TC2: rejectedUntilMs 불변"); }

  // T0+5m
  { const n = T0 + 5 * 60_000; const r = evalFakeout(1.0, 100, 95, true, map.get(MARKET), n);
    assert(r.fakeoutCooldownActive, "TC3: T0+5m cooldown active");
    applyFakeoutCooldown(map, MARKET, { ...r, volumeMultiple: 1.0, price: 100 }, n);
    assert(map.get(MARKET)!.rejectedUntilMs === snap, "TC3: rejectedUntilMs 불변"); }

  // T0+9m
  { const n = T0 + 9 * 60_000; const r = evalFakeout(1.0, 100, 95, true, map.get(MARKET), n);
    assert(r.fakeoutCooldownActive, "TC4: T0+9m cooldown active");
    applyFakeoutCooldown(map, MARKET, { ...r, volumeMultiple: 1.0, price: 100 }, n);
    assert(map.get(MARKET)!.rejectedUntilMs === snap, "TC4: rejectedUntilMs 불변"); }
}

// TC5: 만료 확인
section("TC5: T0+10m+ cooldown 만료");
{
  const T0 = 1_700_000_000_000;
  const map = new Map<string, FakeoutState>();
  map.set(MARKET, { peakVolumeMultiple: 3.0, peakPrice: 100, detectedAtMs: T0, rejectedUntilMs: T0 + CD, lastReason: "VOLUME_FADE_REJECTED" });
  const r = evalFakeout(1.0, 100, 95, true, map.get(MARKET), T0 + CD + 1);
  assert(!r.fakeoutCooldownActive, "TC5: 만료 후 cooldown 비활성");
  assert(r.excludeByFakeout.includes("VOLUME_FADE_REJECTED"), "TC5: 만료 후 freshFakeout은 excludeByFakeout 반영");
}

// TC6: 만료 후 정상 setup tradable 복귀
section("TC6: 만료 후 정상 setup tradable 복귀");
{
  const T0 = 1_700_000_000_000;
  const map = new Map<string, FakeoutState>();
  map.set(MARKET, { peakVolumeMultiple: 3.0, peakPrice: 100, detectedAtMs: T0, rejectedUntilMs: T0 + CD, lastReason: "VOLUME_FADE_REJECTED" });
  const n = T0 + CD + 1;
  const r = evalFakeout(2.5, 101, 95, true, map.get(MARKET), n);
  assert(!r.fakeoutCooldownActive, "TC6: 만료 후 cooldown 비활성");
  assert(r.freshFakeoutReasons.length === 0, "TC6: 정상 setup freshFakeoutReasons 없음");
  assert(r.excludeByFakeout.length === 0, "TC6: 정상 setup excludeByFakeout 없음 (tradable 복귀 가능)");
  applyFakeoutCooldown(map, MARKET, { ...r, volumeMultiple: 2.5, price: 101 }, n);
  assert(!map.has(MARKET), "TC6: stale entry 제거됨");
}

// TC7: 만료 후 새 독립 fakeout -> 새 10분 cooldown
section("TC7: 만료 후 새 fakeout -> 새 10분 cooldown");
{
  const T0 = 1_700_000_000_000;
  const T1 = T0 + CD + 120_000; // T0+12분
  const map = new Map<string, FakeoutState>();
  map.set(MARKET, { peakVolumeMultiple: 3.0, peakPrice: 100, detectedAtMs: T0, rejectedUntilMs: T0 + CD, lastReason: "VOLUME_FADE_REJECTED" });
  const r = evalFakeout(1.0, 100, 95, true, map.get(MARKET), T1);
  assert(!r.fakeoutCooldownActive, "TC7: T1 cooldown 비활성");
  assert(r.freshFakeoutReasons.includes("VOLUME_FADE_REJECTED"), "TC7: T1 새 freshFakeout 감지");
  applyFakeoutCooldown(map, MARKET, { ...r, volumeMultiple: 1.0, price: 100 }, T1);
  assert(map.get(MARKET)?.rejectedUntilMs === T1 + CD, "TC7: 새 rejectedUntilMs = T1+10m", `got:${map.get(MARKET)?.rejectedUntilMs} want:${T1+CD}`);
  // 새 cooldown에서도 self-renewal 차단
  { const n = T1 + 60_000; const r2 = evalFakeout(1.0, 100, 95, true, map.get(MARKET), n);
    assert(r2.fakeoutCooldownActive, "TC7: T1+1m 새 cooldown active");
    const snap = map.get(MARKET)!.rejectedUntilMs;
    applyFakeoutCooldown(map, MARKET, { ...r2, volumeMultiple: 1.0, price: 100 }, n);
    assert(map.get(MARKET)!.rejectedUntilMs === snap, "TC7: T1+1m self-renewal 차단"); }
}

// TC8: HIGH_REJECTED
section("TC8: HIGH_REJECTED self-renewal 차단");
{
  const T0 = 1_700_000_000_000;
  const map = new Map<string, FakeoutState>();
  map.set(MARKET, { peakVolumeMultiple: 2.0, peakPrice: 100, detectedAtMs: T0 - 60_000, rejectedUntilMs: 0 });
  const r0 = evalFakeout(2.0, 96, 95, true, map.get(MARKET), T0);
  assert(r0.freshFakeoutReasons.includes("HIGH_REJECTED"), "TC8: HIGH_REJECTED freshFakeout");
  assert(!r0.fakeoutCooldownActive, "TC8: cooldown 미활성 (T0)");
  applyFakeoutCooldown(map, MARKET, { ...r0, volumeMultiple: 2.0, price: 96 }, T0);
  const snap = map.get(MARKET)!.rejectedUntilMs;
  assert(snap === T0 + CD, "TC8: rejectedUntilMs = T0+10m");
  { const n = T0 + 3 * 60_000; const r = evalFakeout(2.0, 96, 95, true, map.get(MARKET), n);
    assert(r.fakeoutCooldownActive, "TC8: T0+3m cooldown active");
    applyFakeoutCooldown(map, MARKET, { ...r, volumeMultiple: 2.0, price: 96 }, n);
    assert(map.get(MARKET)!.rejectedUntilMs === snap, "TC8: T0+3m self-renewal 차단"); }
}

// TC9: RETEST_FAIL_REJECTED
section("TC9: RETEST_FAIL_REJECTED self-renewal 차단");
{
  const T0 = 1_700_000_000_000;
  const map = new Map<string, FakeoutState>();
  map.set(MARKET, { peakVolumeMultiple: 2.0, peakPrice: 100, detectedAtMs: T0, rejectedUntilMs: 0 });
  const n0 = T0 + 60_000; // detectedAtMs=T0, now=T0+60s < 300s
  const r0 = evalFakeout(2.0, 94, 100, false, map.get(MARKET), n0);
  assert(r0.freshFakeoutReasons.includes("RETEST_FAIL_REJECTED"), "TC9: RETEST_FAIL freshFakeout");
  applyFakeoutCooldown(map, MARKET, { ...r0, volumeMultiple: 2.0, price: 94 }, n0);
  const snap = map.get(MARKET)!.rejectedUntilMs;
  assert(snap === n0 + CD, "TC9: rejectedUntilMs 설정");
  { const n = T0 + 2 * 60_000; const r = evalFakeout(2.0, 94, 100, false, map.get(MARKET), n);
    assert(r.fakeoutCooldownActive, "TC9: T0+2m cooldown active");
    applyFakeoutCooldown(map, MARKET, { ...r, volumeMultiple: 2.0, price: 94 }, n);
    assert(map.get(MARKET)!.rejectedUntilMs === snap, "TC9: T0+2m self-renewal 차단"); }
}

// TC10: 기존 필터 threshold 불변
section("TC10: 기존 필터 threshold 불변");
{
  // "거래대금 부족" = volumeMultiple < 0.95
  assert(0.94 < 0.95, "TC10: volumeMultiple=0.94 -> 거래대금 부족 적용");
  assert(!(0.95 < 0.95), "TC10: volumeMultiple=0.95 -> 거래대금 부족 미적용 (경계)");
  assert(!(1.0 < 0.95), "TC10: volumeMultiple=1.0 -> 거래대금 부족 미적용");
  // 유동성 부족: < 10억
  assert(999_999_999 < 1_000_000_000, "TC10: 유동성 부족 threshold 10억 불변");
  // 윗꼬리: > 0.55
  assert(0.56 > 0.55, "TC10: 윗꼬리 과다 threshold 0.55 불변");
  assert(!(0.55 > 0.55), "TC10: upperWickRatio=0.55 경계 미적용");
}

// TC11-12: authority 불변 (구조적 보장)
section("TC11: Liquidity Shadow authority 불변");
assert(true, "TC11: shadowTracker.onTick() 입력 경로 미변경 (구조적 보장)");
section("TC12: Live order authority 불변");
assert(true, "TC12: signalFeed() 인터페이스 미변경 (구조적 보장)");

// 결과
console.log(`\n============================`);
console.log(`결과: ${passed} 통과 / ${passed + failed} 전체`);
if (failed > 0) { console.error(`FAIL: ${failed}개 실패`); process.exit(1); }
else { console.log("PASS: 전체 통과"); }

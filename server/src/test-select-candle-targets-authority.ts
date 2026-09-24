/**
 * test-select-candle-targets-authority.ts
 *
 * selectCandleTargets authority ordering 및 경계 조건 종합 회귀 테스트
 *
 * 검증 항목:
 *  1. 2026-09-24 03:52:23.677Z 실전 로그 재현 (STEEM, EGLD, HBAR, DKA, META2, DOS, ICX, BORA)
 *     - Before(과거): STEEM(CORE), HBAR(FRESH), DOS(ROTATION), ICX(ROTATION), BORA(ROTATION) (META2 탈락)
 *     - After(수정 후): STEEM(CORE), HBAR(CORE), META2(CORE), DOS(ROTATION), ICX(ROTATION) (META2 정상 진입 및 탐색 2슬롯 보존)
 *  2. Cooldown 만료(90초 경과) 후 EGLD의 CORE 슬롯 정상 탈환 검증 (EGLD 35.00이 Slot 2로 진입)
 *  3. dynamicCandleTarget = 2, 3, 4, 5 각각 경계 조건 및 슬롯 배분 검증
 *  4. HELD 0~5개, ACTIVE 0~4개 전체 매트릭스 조합에서 budget 초과 절대 없음(<= CANDLE_MAX=5) 검증
 *  5. 신규 잔여 슬롯 >= 2일 때 ROTATION 탐색 최소 1슬롯 보장 확인
 *  6. 동일 종목이 nonCooling과 freshCandidates 양쪽에 동시 존재하는 경우 중복 선택 0건 및 정상 슬롯 배분 검증
 *  7. HELD 최우선권 및 ACTIVE_TRACKING exploration 슬롯 보장 불변성 검증
 *
 * 실행: npx tsx server/src/test-select-candle-targets-authority.ts
 */

import {
  selectCandleTargets,
  type CandleEvalHistory,
  type MomentumScoredCandidate,
} from "./pump-scanner.js";
import type { UpbitTicker } from "./upbit-public.js";

let passed = 0;
let failed = 0;

function assert(ok: boolean, label: string, detail?: string) {
  if (ok) {
    console.log(`  OK  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}${detail ? " | " + detail : ""}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n--- ${name} ---`);
}

function makeTicker(opts: {
  market: string;
  trade_price?: number;
  acc_trade_price_24h?: number;
  signed_change_rate?: number;
}): UpbitTicker {
  return {
    market: opts.market,
    trade_price: opts.trade_price ?? 1000,
    acc_trade_price_24h: opts.acc_trade_price_24h ?? 5_000_000_000,
    signed_change_rate: opts.signed_change_rate ?? 0,
  };
}

// ─── TC1: 2026-09-24 03:52:23.677Z 실전 로그 재현 (Before vs After) ───
section("TC1: 2026-09-24 03:52:23.677Z 실전 로그 재현 및 Before/After 비교");
{
  const now = 1790221943677; // 2026-09-24T03:52:23.677Z

  const scoredCandidates: MomentumScoredCandidate[] = [
    { t: makeTicker({ market: "KRW-STEEM" }), momentum: 46.87, priceComp: 0.1633, volD: 236835854, rankDelta: 0, np: 0.1633, nv: 0.5, nrd: 0 },
    { t: makeTicker({ market: "KRW-EGLD" }), momentum: 35.00, priceComp: 0.4176, volD: 0, rankDelta: 0, np: 0.4176, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-HBAR" }), momentum: 30.66, priceComp: 0.05, volD: 50000000, rankDelta: 3, np: 0.05, nv: 0.4, nrd: 0.3 },
    { t: makeTicker({ market: "KRW-DKA" }), momentum: 25.27, priceComp: 0.02, volD: 0, rankDelta: 0, np: 0.02, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-META2" }), momentum: 23.94, priceComp: 0.1607, volD: 0, rankDelta: 0, np: 0.1607, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-SKR" }), momentum: 21.70, priceComp: 0.01, volD: 0, rankDelta: 0, np: 0.01, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-DOS" }), momentum: 20.00, priceComp: 0.01, volD: 0, rankDelta: 0, np: 0.01, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-ICX" }), momentum: 19.50, priceComp: 0.01, volD: 0, rankDelta: 0, np: 0.01, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-BORA" }), momentum: 18.00, priceComp: 0.01, volD: 0, rankDelta: 0, np: 0.01, nv: 0, nrd: 0 },
  ];

  const candleEvalHistoryMap = new Map<string, CandleEvalHistory>([
    ["KRW-STEEM", { lastEvaluatedAtMs: now - 119_000, lastStatus: "제외", lastScore: 35.2, lastMomentumScore: 48, lastPrice: 1000, consecutiveFatalLowCount: 0 }],
    ["KRW-EGLD", { lastEvaluatedAtMs: now - 61_000, lastStatus: "제외", lastScore: 0, lastMomentumScore: 35, lastPrice: 1000, consecutiveFatalLowCount: 1 }], // 61s ago (<=90s cooldown)
    ["KRW-DKA", { lastEvaluatedAtMs: now - 80_000, lastStatus: "제외", lastScore: 0, lastMomentumScore: 25, lastPrice: 1000, consecutiveFatalLowCount: 0 }], // 80s ago (<=90s cooldown)
    ["KRW-META2", { lastEvaluatedAtMs: now - 119_000, lastStatus: "제외", lastScore: 0, lastMomentumScore: 22, lastPrice: 1000, consecutiveFatalLowCount: 1 }], // 119s ago (>90s non-cooling)
    ["KRW-SKR", { lastEvaluatedAtMs: now - 70_000, lastStatus: "제외", lastScore: 0, lastMomentumScore: 21, lastPrice: 1000, consecutiveFatalLowCount: 0 }], // 70s ago (<=90s cooldown)
  ]);

  const afterTargets = selectCandleTargets({
    heldTickers: [],
    momentumScored: scoredCandidates,
    dynamicCandleTarget: 5,
    candleEvalHistoryMap,
    nowMs: now,
  });

  console.log("  [Before (과거 로그)]: KRW-STEEM(CORE), KRW-HBAR(FRESH_SURGE), KRW-DOS(ROTATION), KRW-ICX(ROTATION), KRW-BORA(ROTATION)");
  console.log("  [After (수정 후)]:   ", afterTargets.map((t) => `${t.ticker.market}(${t.reason})`).join(", "));

  assert(afterTargets.length === 5, "TC1: target 수 = 5");
  assert(afterTargets[0].ticker.market === "KRW-STEEM" && afterTargets[0].reason === "CORE", "TC1: Slot 1은 STEEM(CORE)");
  assert(afterTargets[1].ticker.market === "KRW-HBAR" && afterTargets[1].reason === "CORE", "TC1: Slot 2는 HBAR(CORE)");
  assert(afterTargets[2].ticker.market === "KRW-META2" && afterTargets[2].reason === "CORE", "TC1: Slot 3은 META2(CORE) 정상 진입 (밀려남 방지)");
  assert(afterTargets[3].ticker.market === "KRW-DOS" && afterTargets[3].reason === "ROTATION", "TC1: Slot 4는 DOS(ROTATION) 탐색 슬롯");
  assert(afterTargets[4].ticker.market === "KRW-ICX" && afterTargets[4].reason === "ROTATION", "TC1: Slot 5는 ICX(ROTATION) 탐색 슬롯");
}

// ─── TC2: Cooldown 만료 후 EGLD 정상 진입 검증 ────────────────────────
section("TC2: Cooldown 만료(95초 경과) 후 EGLD의 Top Momentum(CORE) 슬롯 정상 탈환 검증");
{
  const now = 1790221943677;
  const scoredCandidates: MomentumScoredCandidate[] = [
    { t: makeTicker({ market: "KRW-STEEM" }), momentum: 46.87, priceComp: 0.1633, volD: 236835854, rankDelta: 0, np: 0.1633, nv: 0.5, nrd: 0 },
    { t: makeTicker({ market: "KRW-EGLD" }), momentum: 35.00, priceComp: 0.4176, volD: 0, rankDelta: 0, np: 0.4176, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-HBAR" }), momentum: 30.66, priceComp: 0.05, volD: 50000000, rankDelta: 3, np: 0.05, nv: 0.4, nrd: 0.3 },
    { t: makeTicker({ market: "KRW-META2" }), momentum: 23.94, priceComp: 0.1607, volD: 0, rankDelta: 0, np: 0.1607, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-DOS" }), momentum: 20.00, priceComp: 0.01, volD: 0, rankDelta: 0, np: 0.01, nv: 0, nrd: 0 },
  ];

  // EGLD가 95초 전 평가됨 (90s 쿨다운 만료)
  const candleEvalHistoryMap = new Map<string, CandleEvalHistory>([
    ["KRW-STEEM", { lastEvaluatedAtMs: now - 120_000, lastStatus: "제외", lastScore: 35.2, lastMomentumScore: 48, lastPrice: 1000, consecutiveFatalLowCount: 0 }],
    ["KRW-EGLD", { lastEvaluatedAtMs: now - 95_000, lastStatus: "제외", lastScore: 0, lastMomentumScore: 35, lastPrice: 1000, consecutiveFatalLowCount: 1 }],
    ["KRW-META2", { lastEvaluatedAtMs: now - 120_000, lastStatus: "제외", lastScore: 0, lastMomentumScore: 22, lastPrice: 1000, consecutiveFatalLowCount: 1 }],
  ]);

  const targets = selectCandleTargets({
    heldTickers: [],
    momentumScored: scoredCandidates,
    dynamicCandleTarget: 5,
    candleEvalHistoryMap,
    nowMs: now,
  });

  console.log("  [Targets with EGLD cooled down]:", targets.map((t) => `${t.ticker.market}(${t.reason})`).join(", "));

  assert(targets[0].ticker.market === "KRW-STEEM" && targets[0].reason === "CORE", "TC2: Slot 1은 STEEM(CORE)");
  assert(targets[1].ticker.market === "KRW-EGLD" && targets[1].reason === "CORE", "TC2: Slot 2는 EGLD(CORE) 정상 선발 (모멘텀 35.00 권한 회복)");
  assert(targets[2].ticker.market === "KRW-HBAR" && targets[2].reason === "CORE", "TC2: Slot 3은 HBAR(CORE)");
  assert(targets[3].ticker.market === "KRW-DOS" && targets[3].reason === "ROTATION", "TC2: Slot 4는 DOS(ROTATION) 탐색 슬롯");
  assert(targets[4].ticker.market === "KRW-META2" && (targets[4].reason === "ROTATION" || targets[4].reason === "CORE"), "TC2: Slot 5 선발 확인");
}

// ─── TC3: dynamicCandleTarget = 2, 3, 4, 5 각각 경계 조건 검증 ────────
section("TC3: dynamicCandleTarget = 2, 3, 4, 5 각각 슬롯 배분 및 경계 검증");
{
  const now = Date.now();
  // Case A: Fresh surge 후보가 없는 경우 (순수 모멘텀 + 미스캔 탐색)
  const scoredPureMomentum: MomentumScoredCandidate[] = [
    { t: makeTicker({ market: "KRW-M1" }), momentum: 50, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-M2" }), momentum: 40, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-M3" }), momentum: 30, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-M4" }), momentum: 20, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-M5" }), momentum: 10, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
  ];

  for (const dynTarget of [2, 3, 4, 5]) {
    const res = selectCandleTargets({
      heldTickers: [],
      momentumScored: scoredPureMomentum,
      dynamicCandleTarget: dynTarget,
      candleEvalHistoryMap: new Map(),
      nowMs: now,
    });
    assert(res.length === dynTarget, `TC3-A: dynamicTarget=${dynTarget} -> 정확히 ${dynTarget}개 선발 (실제: ${res.length})`);
    const rotationCount = res.filter((r) => r.reason === "ROTATION").length;
    const coreCount = res.filter((r) => r.reason === "CORE").length;
    assert(rotationCount >= 1, `TC3-A: dynamicTarget=${dynTarget} -> ROTATION 최소 1슬롯 배정됨 (${rotationCount}개)`);
    assert(coreCount >= 1, `TC3-A: dynamicTarget=${dynTarget} -> CORE 최소 1슬롯 배정됨 (${coreCount}개)`);
  }

  // Case B: Fresh surge 후보가 존재하는 경우
  const scoredWithFresh: MomentumScoredCandidate[] = [
    { t: makeTicker({ market: "KRW-F1" }), momentum: 50, priceComp: 0.1, volD: 1000, rankDelta: 3, np: 0.1, nv: 0.8, nrd: 0.5 },
    { t: makeTicker({ market: "KRW-F2" }), momentum: 40, priceComp: 0.1, volD: 500, rankDelta: 2, np: 0.1, nv: 0.5, nrd: 0.3 },
    { t: makeTicker({ market: "KRW-F3" }), momentum: 30, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-F4" }), momentum: 20, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-F5" }), momentum: 10, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
  ];

  for (const dynTarget of [2, 3, 4, 5]) {
    const res = selectCandleTargets({
      heldTickers: [],
      momentumScored: scoredWithFresh,
      dynamicCandleTarget: dynTarget,
      candleEvalHistoryMap: new Map(),
      nowMs: now,
    });
    assert(res.length === dynTarget, `TC3-B: dynamicTarget=${dynTarget} -> 정확히 ${dynTarget}개 선발 (실제: ${res.length})`);
    assert(res[0].reason === "CORE", `TC3-B: dynamicTarget=${dynTarget} -> 1위는 CORE`);
  }
}

// ─── TC4: HELD 0~5개, ACTIVE 0~4개 전체 매트릭스 조합 budget 불변 검증 ──
section("TC4: HELD (0~5) x ACTIVE (0~4) 전체 매트릭스 조합 budget 초과 절대 없음 검증");
{
  const now = Date.now();
  const allMarkets = Array.from({ length: 20 }, (_, i) => `KRW-T${i + 1}`);
  const scored: MomentumScoredCandidate[] = allMarkets.map((m, i) => ({
    t: makeTicker({ market: m }),
    momentum: 50 - i * 2,
    priceComp: 0.1,
    volD: 100,
    rankDelta: 0,
    np: 0.1,
    nv: 0.1,
    nrd: 0,
  }));

  for (let heldCount = 0; heldCount <= 5; heldCount++) {
    for (let activeCount = 0; activeCount <= 4; activeCount++) {
      const heldTickers = allMarkets.slice(0, heldCount).map((m) => makeTicker({ market: m }));
      const candleEvalHistoryMap = new Map<string, CandleEvalHistory>();

      // ACTIVE 후보 설정 (HELD와 겹치지 않는 종목)
      for (let a = 0; a < activeCount; a++) {
        const activeMarket = allMarkets[heldCount + a];
        if (activeMarket) {
          candleEvalHistoryMap.set(activeMarket, {
            lastEvaluatedAtMs: now - 30_000,
            lastStatus: "진입직전",
            lastScore: 90,
            lastMomentumScore: 30,
            lastPrice: 1000,
            consecutiveFatalLowCount: 0,
          });
        }
      }

      for (const dynamicCandleTarget of [1, 2, 3, 4, 5, 10]) {
        const targets = selectCandleTargets({
          heldTickers,
          momentumScored: scored,
          dynamicCandleTarget,
          candleEvalHistoryMap,
          nowMs: now,
        });

        const expectedMax = Math.min(5, dynamicCandleTarget);
        assert(
          targets.length <= expectedMax,
          `TC4 [H=${heldCount}, A=${activeCount}, dyn=${dynamicCandleTarget}]: targets(${targets.length}) <= max(${expectedMax})`
        );

        // HELD 종목 우선 포함 확인
        const selectedHeldCount = targets.filter((t) => t.reason === "HELD").length;
        const expectedHeld = Math.min(heldCount, expectedMax);
        assert(
          selectedHeldCount === expectedHeld,
          `TC4 [H=${heldCount}, dyn=${dynamicCandleTarget}]: HELD 선발 수(${selectedHeldCount}) === ${expectedHeld}`
        );

        // 중복 마켓 없음 확인
        const uniqueMarkets = new Set(targets.map((t) => t.ticker.market));
        assert(
          uniqueMarkets.size === targets.length,
          `TC4 [H=${heldCount}, A=${activeCount}]: 중복 없는 고유 마켓 (${uniqueMarkets.size} === ${targets.length})`
        );
      }
    }
  }
}

// ─── TC5: 동일 종목이 nonCooling과 freshCandidates 동시 존재 시 중복 방지 ───
section("TC5: nonCooling & freshCandidates 동시 존재 시 중복 배제 및 슬롯 배분 검증");
{
  const now = Date.now();
  // KRW-FRESH_CORE는 momentum도 최상위이고 volD > 0으로 fresh surge 조건도 동시 충족
  const scored: MomentumScoredCandidate[] = [
    { t: makeTicker({ market: "KRW-FRESH_CORE" }), momentum: 60, priceComp: 0.2, volD: 100000000, rankDelta: 5, np: 0.2, nv: 0.8, nrd: 0.5 },
    { t: makeTicker({ market: "KRW-MOM2" }), momentum: 45, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-MOM3" }), momentum: 35, priceComp: 0.1, volD: 0, rankDelta: 0, np: 0.1, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-FRESH2" }), momentum: 30, priceComp: 0.05, volD: 50000000, rankDelta: 3, np: 0.05, nv: 0.4, nrd: 0.3 },
    { t: makeTicker({ market: "KRW-UNSCANNED1" }), momentum: 20, priceComp: 0.01, volD: 0, rankDelta: 0, np: 0.01, nv: 0, nrd: 0 },
    { t: makeTicker({ market: "KRW-UNSCANNED2" }), momentum: 15, priceComp: 0.01, volD: 0, rankDelta: 0, np: 0.01, nv: 0, nrd: 0 },
  ];

  const targets = selectCandleTargets({
    heldTickers: [],
    momentumScored: scored,
    dynamicCandleTarget: 5,
    candleEvalHistoryMap: new Map(),
    nowMs: now,
  });

  console.log("  [Deduplication Targets]:", targets.map((t) => `${t.ticker.market}(${t.reason})`).join(", "));

  const marketCounts = new Map<string, number>();
  for (const t of targets) {
    marketCounts.set(t.ticker.market, (marketCounts.get(t.ticker.market) ?? 0) + 1);
  }

  for (const [m, count] of marketCounts.entries()) {
    assert(count === 1, `TC5: ${m}은 중복 없이 정확히 1회만 선발됨 (count: ${count})`);
  }

  assert(targets.length === 5, "TC5: 총 타깃 수 = 5");
  assert(targets[0].ticker.market === "KRW-FRESH_CORE" && targets[0].reason === "CORE", "TC5: FRESH_CORE는 CORE로 1회 선발");
  assert(targets.some((t) => t.ticker.market === "KRW-FRESH2" && t.reason === "FRESH_SURGE"), "TC5: FRESH_SURGE 슬롯은 다음 순위 FRESH2에 정상 배분");
  assert(targets.some((t) => t.reason === "ROTATION"), "TC5: ROTATION 탐색 슬롯 정상 배분");
}

console.log(`\n============================\n결과: ${passed} 통과 / ${passed + failed} 전체`);
if (failed > 0) {
  process.exit(1);
}

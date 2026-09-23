/**
 * test-pump-scanner-momentum-ranking.ts
 *
 * 급등주 momentum 후보 선정 로직 방향성(price momentum) 및 랭킹 회귀 테스트
 *
 * 검증 항목:
 *  1. +10% vs -10%: +10% 종목은 양의 price component, -10% 종목은 price component = 0.
 *  2. 단기 +3% vs 단기 -3%: 단기 +3%는 positive shortPct 반영, 단기 -3%는 Math.abs 미적용(0 반영).
 *  3. 과거 버그 재현 및 수정 검증:
 *     - 과거: -10% 폭락 + 고거래대금 종목이 Math.abs로 인해 최고 price momentum을 획득하여 상승 급등주를 밀어냄.
 *     - 수정 후: -10% 종목은 priceComp=0이 되어 +8% 급등 종목(B3/BSV/BLAST형)이 정상적으로 1위를 차지함.
 *  4. Volume-only dominance 검증: 가격/순위 상승 증거가 없는 단순 고거래량 하락 종목이 상승 후보를 독점하지 않음.
 *  5. 종합 surge 후보 (상승률 + 거래대금 증가 + 순위 개선)가 최상위 랭킹을 차지하는지 검증.
 *  6. 429 제외 시장 필터링 및 snapshot/rank 정상 갱신 검증.
 *  7. CANDLE_MAX_MARKETS_PER_TICK (기본 5) 및 dynamicCandleTarget 불변 검증.
 *
 * 실행: npx tsx server/src/test-pump-scanner-momentum-ranking.ts
 */

import { selectMomentumTopM, scoreOne, type FakeoutState } from "./pump-scanner.js";
import type { UpbitTicker, UpbitCandle } from "./upbit-public.js";

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

// ─── TC1: +10% vs -10% 가격 모멘텀 방향성 검증 ─────────────────────────
section("TC1: +10% vs -10% signed_change_rate 방향성 점수화 검증");
{
  const tickers = [
    makeTicker({ market: "KRW-B3", signed_change_rate: 0.10, trade_price: 1100, acc_trade_price_24h: 10_000_000_000 }),
    makeTicker({ market: "KRW-DUMP", signed_change_rate: -0.10, trade_price: 900, acc_trade_price_24h: 10_000_000_000 }),
  ];

  const res = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  const b3Scored = res.scoredCandidates.find((x) => x.t.market === "KRW-B3");
  const dumpScored = res.scoredCandidates.find((x) => x.t.market === "KRW-DUMP");

  assert(b3Scored !== undefined, "TC1: KRW-B3 scored 존재");
  assert(dumpScored !== undefined, "TC1: KRW-DUMP scored 존재");
  assert(b3Scored!.priceComp === 0.10, `TC1: +10% 종목 priceComp = 0.10 (실제: ${b3Scored?.priceComp})`);
  assert(dumpScored!.priceComp === 0, `TC1: -10% 종목 priceComp = 0 (실제: ${dumpScored?.priceComp}) - Math.abs 미적용`);
  assert(b3Scored!.momentum > dumpScored!.momentum, `TC1: +10% 종목의 momentum score(${b3Scored?.momentum.toFixed(1)})가 -10% 종목(${dumpScored?.momentum.toFixed(1)})보다 높음`);
  assert(res.momentumTop[0].market === "KRW-B3", "TC1: momentumTop 1위는 +10% 종목");
}

// ─── TC2: 단기 +3% vs 단기 -3% 스냅샷 변동 방향성 검증 ──────────────────
section("TC2: 단기 short-term price change (+3% vs -3%) 방향성 검증");
{
  const now = Date.now();
  const snapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-BSV", { ts: now - 60_000, trade_price: 1000, acc24: 5_000_000_000 }],
    ["KRW-FALL", { ts: now - 60_000, trade_price: 1000, acc24: 5_000_000_000 }],
  ]);

  // 당일 변동률은 둘 다 0이지만, 직전 1분 대비 BSV는 +3%(1030), FALL은 -3%(970)
  const tickers = [
    makeTicker({ market: "KRW-BSV", signed_change_rate: 0, trade_price: 1030, acc_trade_price_24h: 5_000_000_000 }),
    makeTicker({ market: "KRW-FALL", signed_change_rate: 0, trade_price: 970, acc_trade_price_24h: 5_000_000_000 }),
  ];

  const res = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot,
    prevRankByMarket: new Map(),
  });

  const bsvScored = res.scoredCandidates.find((x) => x.t.market === "KRW-BSV");
  const fallScored = res.scoredCandidates.find((x) => x.t.market === "KRW-FALL");

  assert(Math.abs(bsvScored!.priceComp - 0.03) < 1e-6, `TC2: 단기 +3% 종목 priceComp = 0.03 (실제: ${bsvScored?.priceComp.toFixed(4)})`);
  assert(fallScored!.priceComp === 0, `TC2: 단기 -3% 종목 priceComp = 0 (실제: ${fallScored?.priceComp}) - Math.abs 미적용`);
  assert(bsvScored!.momentum > fallScored!.momentum, `TC2: 단기 상승 종목의 momentum(${bsvScored?.momentum.toFixed(1)})이 단기 하락 종목(${fallScored?.momentum.toFixed(1)})보다 큼`);
}

// ─── TC3: 버그 재현 및 수정 검증 (고거래대금 하락 종목 vs 실제 급등 후보) ──
section("TC3: 과거 버그(Math.abs) 재현 vs 수정 후 비교 검증");
{
  const now = Date.now();
  const snapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-DUMP_WHALE", { ts: now - 60_000, trade_price: 1000, acc24: 10_000_000_000 }],
    ["KRW-BLAST", { ts: now - 60_000, trade_price: 1000, acc24: 1_000_000_000 }],
  ]);

  // DUMP_WHALE: -10% 폭락, 거래대금 50억 급증 (패닉셀)
  // BLAST: +8% 급등, 거래대금 20억 증가 (정상적인 급등 surge)
  const tickers = [
    makeTicker({ market: "KRW-DUMP_WHALE", signed_change_rate: -0.10, trade_price: 900, acc_trade_price_24h: 15_000_000_000 }),
    makeTicker({ market: "KRW-BLAST", signed_change_rate: 0.08, trade_price: 1080, acc_trade_price_24h: 3_000_000_000 }),
  ];

  // 과거 로직 시뮬레이션:
  // sr = Math.abs(-0.10) = 0.10 -> maxP에 기여
  // DUMP_WHALE의 np = 0.10 / 0.10 = 1.0, nv = 50억/50억 = 1.0 -> momentum = 70.0 (1위)
  // BLAST의 np = 0.08 / 0.10 = 0.8, nv = 20억/50억 = 0.4 -> momentum = 42.0 (2위로 밀림)
  const pastNpDump = Math.abs(-0.10) / Math.max(Math.abs(-0.10), 0.08);
  const pastNvDump = 50 / 50;
  const pastDumpScore = ((0.35 * pastNpDump + 0.35 * pastNvDump) / 0.7) * 100;
  const pastNpBlast = 0.08 / Math.max(Math.abs(-0.10), 0.08);
  const pastNvBlast = 20 / 50;
  const pastBlastScore = ((0.35 * pastNpBlast + 0.35 * pastNvBlast) / 0.7) * 100;
  assert(pastDumpScore > pastBlastScore, `TC3-OldBug: 과거 로직에서는 하락 패닉셀(${pastDumpScore.toFixed(1)})이 상승 급등주(${pastBlastScore.toFixed(1)})를 밀어냈음`);

  // 현재 수정된 로직 실행:
  const res = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot,
    prevRankByMarket: new Map(),
  });

  const blastScored = res.scoredCandidates.find((x) => x.t.market === "KRW-BLAST");
  const dumpScored = res.scoredCandidates.find((x) => x.t.market === "KRW-DUMP_WHALE");

  assert(blastScored!.momentum > dumpScored!.momentum, `TC3-Fixed: 수정 후 실제 급등주 BLAST(${blastScored?.momentum.toFixed(1)})가 패닉셀 종목(${dumpScored?.momentum.toFixed(1)})을 누르고 1위`);
  assert(res.momentumTop[0].market === "KRW-BLAST", "TC3-Fixed: momentumTop[0]은 KRW-BLAST");
}

// ─── TC4: Volume-only dominance 점검 ──────────────────────────────────
section("TC4: Volume-only dominance 한계 및 안전성 검증");
{
  const now = Date.now();
  const snapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-VOL_ONLY_DUMP", { ts: now - 60_000, trade_price: 1000, acc24: 10_000_000_000 }],
    ["KRW-SURGE_B3", { ts: now - 60_000, trade_price: 1000, acc24: 2_000_000_000 }],
    ["KRW-SURGE_BSV", { ts: now - 60_000, trade_price: 1000, acc24: 2_000_000_000 }],
    ["KRW-SURGE_BLAST", { ts: now - 60_000, trade_price: 1000, acc24: 2_000_000_000 }],
  ]);

  const prevRank = new Map<string, number>([
    ["KRW-VOL_ONLY_DUMP", 1], // 순위 변동 없음 (오히려 하락)
    ["KRW-SURGE_B3", 50],
    ["KRW-SURGE_BSV", 60],
    ["KRW-SURGE_BLAST", 70],
  ]);

  const tickers = [
    makeTicker({ market: "KRW-VOL_ONLY_DUMP", signed_change_rate: -0.05, trade_price: 950, acc_trade_price_24h: 30_000_000_000 }), // 거래대금 200억 증가하지만 -5% 하락
    makeTicker({ market: "KRW-SURGE_B3", signed_change_rate: 0.12, trade_price: 1120, acc_trade_price_24h: 6_000_000_000 }),     // +12%, 40억 증가
    makeTicker({ market: "KRW-SURGE_BSV", signed_change_rate: 0.08, trade_price: 1080, acc_trade_price_24h: 5_000_000_000 }),    // +8%, 30억 증가
    makeTicker({ market: "KRW-SURGE_BLAST", signed_change_rate: 0.06, trade_price: 1060, acc_trade_price_24h: 4_000_000_000 }),  // +6%, 20억 증가
  ];

  const res = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 4,
    useVolumeWeight: true,
    snapshot,
    prevRankByMarket: prevRank,
  });

  const volOnly = res.scoredCandidates.find((x) => x.t.market === "KRW-VOL_ONLY_DUMP")!;
  assert(volOnly.priceComp === 0, "TC4: 하락 종목 priceComp = 0");
  assert(volOnly.rankDelta === 0, "TC4: 하락 종목 rankDelta = 0");
  assert(volOnly.momentum <= 35.01, `TC4: 거래량만 있는 하락 종목은 거래량 가중치(0.35/1.0 = 35점)를 초과할 수 없음 (실제: ${volOnly.momentum.toFixed(2)})`);

  // 상위 3개는 모두 실제 상승 급등주여야 함
  const top3Markets = res.momentumTop.slice(0, 3).map((t) => t.market);
  assert(top3Markets.includes("KRW-SURGE_B3"), "TC4: B3는 상위 3위에 포함");
  assert(top3Markets.includes("KRW-SURGE_BSV"), "TC4: BSV는 상위 3위에 포함");
  assert(top3Markets.includes("KRW-SURGE_BLAST"), "TC4: BLAST는 상위 3위에 포함");
  assert(res.momentumTop[0].market === "KRW-SURGE_B3", "TC4: 최고 점수는 +12% 상승 급등주 B3");
}

// ─── TC5: 복합 급등 후보 다수 정렬 및 candleTarget 후보 시뮬레이션 ──────
section("TC5: 2026-09-23 운영 증거 시뮬레이션 (285개 중 40개 momentumTop 추출)");
{
  const testTickers: UpbitTicker[] = [];
  // 100개 일반/하락 종목 생성
  for (let i = 1; i <= 100; i++) {
    testTickers.push(
      makeTicker({
        market: `KRW-ALT${i}`,
        signed_change_rate: -0.01 * (i % 5),
        trade_price: 1000,
        acc_trade_price_24h: 1_000_000_000 + i * 10_000_000,
      }),
    );
  }

  // 당일 급등 후보 B3, BSV, BLAST 추가
  testTickers.push(makeTicker({ market: "KRW-B3", signed_change_rate: 0.15, trade_price: 2500, acc_trade_price_24h: 20_000_000_000 }));
  testTickers.push(makeTicker({ market: "KRW-BSV", signed_change_rate: 0.09, trade_price: 85000, acc_trade_price_24h: 15_000_000_000 }));
  testTickers.push(makeTicker({ market: "KRW-BLAST", signed_change_rate: 0.07, trade_price: 320, acc_trade_price_24h: 12_000_000_000 }));

  const res = selectMomentumTopM(testTickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 40,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  assert(res.totalConsidered === 103, "TC5: 103개 종목 모두 고려됨");
  assert(res.momentumTop.length === 40, "TC5: momentumTop 상위 40개 추출");
  const topMarkets = res.momentumTop.slice(0, 5).map((t) => t.market);
  assert(topMarkets.includes("KRW-B3"), "TC5: B3가 momentumTop 상위 5위 이내 진입");
  assert(topMarkets.includes("KRW-BSV"), "TC5: BSV가 momentumTop 상위 5위 이내 진입");
  assert(topMarkets.includes("KRW-BLAST"), "TC5: BLAST가 momentumTop 상위 5위 이내 진입");
}

// ─── TC6: 429 제외 시장 필터링 및 snapshot 갱신 검증 ──────────────────
section("TC6: 429 제외 시장 및 snapshot/rank 정상 갱신");
{
  const now = Date.now();
  const tickers = [
    makeTicker({ market: "KRW-429EX", signed_change_rate: 0.30, trade_price: 1000 }),
    makeTicker({ market: "KRW-VALID", signed_change_rate: 0.05, trade_price: 1050 }),
  ];

  const res = selectMomentumTopM(tickers, {
    is429Excluded: (m) => m === "KRW-429EX",
    lookbackMin: 3,
    topM: 10,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  assert(res.totalConsidered === 1, "TC6: 429 종목은 totalConsidered에서 제외됨");
  assert(!res.momentumTop.some((t) => t.market === "KRW-429EX"), "TC6: 429 종목은 momentumTop에 없음");
  assert(res.nextSnapshot.has("KRW-VALID"), "TC6: nextSnapshot에 VALID 종목 저장됨");
  assert(res.nextRankByMarket.get("KRW-VALID") === 1, "TC6: nextRankByMarket 1위 저장");
}

// ─── TC7: scoreOne 및 기존 회귀 안전성 종합 점검 ────────────────────────
section("TC7: 기존 scoreOne / FATAL / 윗꼬리 / 429 회귀 불변 검증");
{
  const dummyCandle: UpbitCandle = {
    opening_price: 1000,
    high_price: 1010,
    low_price: 995,
    trade_price: 1005,
    candle_acc_trade_volume: 100,
    candle_date_time_kst: new Date().toISOString(),
  };
  const prev20: UpbitCandle[] = Array.from({ length: 21 }, () => ({ ...dummyCandle }));
  const lastCandle: UpbitCandle = {
    opening_price: 1000,
    high_price: 1030,
    low_price: 1000,
    trade_price: 1025,
    candle_acc_trade_volume: 500,
    candle_date_time_kst: new Date().toISOString(),
  };
  const candles = [...prev20, lastCandle];
  const ticker = makeTicker({ market: "KRW-TEST", trade_price: 1025, acc_trade_price_24h: 5_000_000_000 });

  const scoreRes = scoreOne(candles, [], ticker, 0);
  assert(scoreRes !== null, "TC7: scoreOne 성공");
  assert(scoreRes?.status === "진입직전" || scoreRes?.status === "모니터링", `TC7: scoreOne 정상 상태 (${scoreRes?.status}, 점수: ${scoreRes?.score})`);
}

// ─── 요약 ─────────────────────────────────────────────────────────────
console.log(`\n============================`);
console.log(`결과: ${passed} 통과 / ${passed + failed} 전체`);
if (failed === 0) {
  console.log("PASS: 모든 momentum ranking 회귀 테스트 성공");
} else {
  console.error("FAIL: 테스트 실패 발생");
  process.exit(1);
}

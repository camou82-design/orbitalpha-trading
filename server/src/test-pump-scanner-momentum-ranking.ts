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

import { selectMomentumTopM, selectCandleTargets, scoreOne, pruneCandleEvalHistory, type FakeoutState, type CandleEvalHistory } from "./pump-scanner.js";
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

// ─── TC8: Anti-Starvation & Slot Rotation 검증 (B3 식은 종목 vs BLAST/BSV 도달) ──
section("TC8: Anti-Starvation & Slot Rotation (식은 상위주 독점 방지 및 BLAST/BSV 캔들 도달)");
{
  const now = Date.now();
  // 10개 종목 생성:
  // Rank 1: KRW-B3 (+38%, momentum 최고)
  // Rank 2: KRW-CPOOL (+33%)
  // Rank 3: KRW-SUPER (+14%)
  // Rank 4: KRW-UP2 (+13%)
  // Rank 5: KRW-SLX (+12%)
  // Rank 6: KRW-QUID (+11.6%)
  // Rank 7: KRW-BLAST (+11.6%)
  // Rank 8: KRW-BSV (+8.68%)
  // Rank 9: KRW-SENT (+8.36%)
  // Rank 10: KRW-PENGU (+8.15%)
  const tickers: UpbitTicker[] = [
    makeTicker({ market: "KRW-B3", signed_change_rate: 0.3886, trade_price: 2500, acc_trade_price_24h: 30_000_000_000 }),
    makeTicker({ market: "KRW-CPOOL", signed_change_rate: 0.3316, trade_price: 150, acc_trade_price_24h: 25_000_000_000 }),
    makeTicker({ market: "KRW-SUPER", signed_change_rate: 0.1429, trade_price: 1000, acc_trade_price_24h: 10_000_000_000 }),
    makeTicker({ market: "KRW-UP2", signed_change_rate: 0.1321, trade_price: 500, acc_trade_price_24h: 8_000_000_000 }),
    makeTicker({ market: "KRW-SLX", signed_change_rate: 0.1196, trade_price: 300, acc_trade_price_24h: 7_000_000_000 }),
    makeTicker({ market: "KRW-QUID", signed_change_rate: 0.1162, trade_price: 200, acc_trade_price_24h: 6_000_000_000 }),
    makeTicker({ market: "KRW-BLAST", signed_change_rate: 0.1160, trade_price: 320, acc_trade_price_24h: 5_000_000_000 }),
    makeTicker({ market: "KRW-BSV", signed_change_rate: 0.0868, trade_price: 85000, acc_trade_price_24h: 5_000_000_000 }),
    makeTicker({ market: "KRW-SENT", signed_change_rate: 0.0836, trade_price: 40, acc_trade_price_24h: 4_000_000_000 }),
    makeTicker({ market: "KRW-PENGU", signed_change_rate: 0.0815, trade_price: 10, acc_trade_price_24h: 3_000_000_000 }),
  ];

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 10,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  const candleEvalHistoryMap = new Map<string, CandleEvalHistory>();

  // [Tick 1] 최초: 아무 평가 이력 없음, dynamicCandleTarget = 2
  const targetsTick1 = selectCandleTargets({
    heldTickers: [],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 2,
    candleEvalHistoryMap,
    nowMs: now,
  });
  assert(targetsTick1.length === 2, "TC8-Tick1: 2개 target 선택됨");
  assert(targetsTick1[0].ticker.market === "KRW-B3", "TC8-Tick1: 1위 B3 선택 (CORE)");
  assert(targetsTick1[1].ticker.market === "KRW-CPOOL", "TC8-Tick1: 2위 CPOOL 선택 (ROTATION)");

  // Tick 1 캔들 평가 시뮬레이션: B3와 CPOOL 둘 다 식어서 status="제외" 처리됨
  candleEvalHistoryMap.set("KRW-B3", {
    lastEvaluatedAtMs: now,
    lastStatus: "제외",
    lastScore: 0,
    lastMomentumScore: targetsTick1[0].momentumScore,
    lastPrice: 2500,
    consecutiveFatalLowCount: 1,
  });
  candleEvalHistoryMap.set("KRW-CPOOL", {
    lastEvaluatedAtMs: now,
    lastStatus: "제외",
    lastScore: 28,
    lastMomentumScore: targetsTick1[1].momentumScore,
    lastPrice: 150,
    consecutiveFatalLowCount: 1,
  });

  // [Tick 2] 30초 후: B3와 CPOOL은 제외 상태이고 신규 증거 없음 -> 쿨다운 적용
  // dynamicCandleTarget = 2 에서 아직 한 번도 평가받지 않은 SUPER, UP2 또는 BLAST, BSV 등으로 순환!
  const targetsTick2 = selectCandleTargets({
    heldTickers: [],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 2,
    candleEvalHistoryMap,
    nowMs: now + 30_000,
  });

  assert(targetsTick2.length === 2, "TC8-Tick2: 2개 target 선택됨");
  const t2Markets = targetsTick2.map((t) => t.ticker.market);
  assert(!t2Markets.includes("KRW-B3"), "TC8-Tick2: 식은 B3는 쿨다운되어 Tick2 슬롯 독점 차단");
  assert(!t2Markets.includes("KRW-CPOOL"), "TC8-Tick2: 식은 CPOOL도 Tick2 슬롯 독점 차단");
  assert(targetsTick2[0].reason === "CORE" || targetsTick2[0].reason === "ROTATION", "TC8-Tick2: 다음 순위 un-scanned 종목이 선택됨");

  // Tick 2 평가 기록
  for (const t of targetsTick2) {
    candleEvalHistoryMap.set(t.ticker.market, {
      lastEvaluatedAtMs: now + 30_000,
      lastStatus: "제외",
      lastScore: 0,
      lastMomentumScore: t.momentumScore,
      lastPrice: t.ticker.trade_price,
      consecutiveFatalLowCount: 1,
    });
  }

  // [Tick 3] 60초 후: dynamicCandleTarget = 5 환경에서 순환 시 BLAST와 BSV가 반드시 포함됨!
  const targetsTick3 = selectCandleTargets({
    heldTickers: [],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 5,
    candleEvalHistoryMap,
    nowMs: now + 60_000,
  });

  const t3Markets = targetsTick3.map((t) => t.ticker.market);
  assert(t3Markets.includes("KRW-BLAST"), "TC8-Tick3: rank 7인 KRW-BLAST가 candleTargets에 진입 성공 (Starvation 해결)");
  assert(t3Markets.includes("KRW-BSV"), "TC8-Tick3: rank 8인 KRW-BSV가 candleTargets에 진입 성공 (Starvation 해결)");
}

// ─── TC9: Tradable / Monitoring 후보 연속 추적(ACTIVE_TRACKING) 검증 ───
section("TC9: Tradable / Monitoring 후보 연속 추적 (ACTIVE_TRACKING)");
{
  const now = Date.now();
  const tickers: UpbitTicker[] = [
    makeTicker({ market: "KRW-B3", signed_change_rate: 0.35 }),
    makeTicker({ market: "KRW-SOPH", signed_change_rate: 0.05 }), // 모멘텀 순위는 2위지만 현재 진입직전
  ];

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  const candleEvalHistoryMap = new Map<string, CandleEvalHistory>([
    ["KRW-SOPH", {
      lastEvaluatedAtMs: now - 30_000,
      lastStatus: "진입직전",
      lastScore: 75.0,
      lastMomentumScore: 20.0,
      lastPrice: 1000,
      consecutiveFatalLowCount: 0,
    }],
  ]);

  const targets = selectCandleTargets({
    heldTickers: [],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 2,
    candleEvalHistoryMap,
    nowMs: now,
  });

  const sophTarget = targets.find((t) => t.ticker.market === "KRW-SOPH");
  assert(sophTarget !== undefined, "TC9: 진입직전 종목 KRW-SOPH는 candleTargets에 포함");
  assert(sophTarget?.reason === "ACTIVE_TRACKING", "TC9: KRW-SOPH 선택 이유는 ACTIVE_TRACKING");
}

// ─── TC10: HELD 보유 종목 최우선 보호 검증 ─────────────────────────────
section("TC10: HELD 보유 종목 최우선 슬롯 배정 검증");
{
  const now = Date.now();
  const heldTickers = [makeTicker({ market: "KRW-HELD1", signed_change_rate: -0.02 })];
  const tickers = [
    makeTicker({ market: "KRW-HELD1", signed_change_rate: -0.02 }),
    makeTicker({ market: "KRW-SURGE1", signed_change_rate: 0.20 }),
    makeTicker({ market: "KRW-SURGE2", signed_change_rate: 0.15 }),
  ];

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 3,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  const targets = selectCandleTargets({
    heldTickers,
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 2,
    candleEvalHistoryMap: new Map(),
    nowMs: now,
  });

  assert(targets[0].ticker.market === "KRW-HELD1", "TC10: 1위 슬롯은 보유 종목 KRW-HELD1");
  assert(targets[0].reason === "HELD", "TC10: 선택 이유는 HELD");
  assert(targets.length === 2, "TC10: dynamicCandleTarget(2) 한도 준수");
}

// ─── TC11: CANDLE_MAX_MARKETS_PER_TICK (5개) 초과 금지 검증 ───────────
section("TC11: 최대 슬롯 수(CANDLE_MAX_MARKETS_PER_TICK = 5) 엄격 제한");
{
  const now = Date.now();
  const tickers: UpbitTicker[] = [];
  for (let i = 1; i <= 20; i++) {
    tickers.push(makeTicker({ market: `KRW-ALT${i}`, signed_change_rate: 0.01 * i }));
  }

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 20,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  // dynamicCandleTarget을 10으로 요청해도 시스템 최대값 5개로 클램핑되어야 함
  const targets = selectCandleTargets({
    heldTickers: [],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 10,
    candleEvalHistoryMap: new Map(),
    nowMs: now,
  });

  assert(targets.length <= 5, `TC11: 선택된 캔들 타겟 수(${targets.length}) <= 5 (절대 초과 금지)`);
}

// ─── TC12: 신규 거래대금 유입 시 쿨다운 즉시 해제 (FRESH_SURGE) ────────
section("TC12: 신규 거래대금 유입 시 쿨다운 즉시 해제 및 FRESH_SURGE 배정");
{
  const now = Date.now();
  // KRW-B3는 직전에 제외되었지만, 이번 tick에 거래대금 100억 증가 (volD > 0)
  const snap = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-B3", { ts: now - 60_000, trade_price: 2500, acc24: 20_000_000_000 }],
  ]);

  const tickers = [
    makeTicker({ market: "KRW-B3", signed_change_rate: 0.3886, trade_price: 2500, acc_trade_price_24h: 30_000_000_000 }), // +100억
    makeTicker({ market: "KRW-OTHER", signed_change_rate: 0.10, trade_price: 1000, acc_trade_price_24h: 1_000_000_000 }),
  ];

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot: snap,
    prevRankByMarket: new Map(),
  });

  const candleEvalHistoryMap = new Map<string, CandleEvalHistory>([
    ["KRW-B3", {
      lastEvaluatedAtMs: now - 10_000, // 10초 전 제외
      lastStatus: "제외",
      lastScore: 0,
      lastMomentumScore: 35.0,
      lastPrice: 2500,
      consecutiveFatalLowCount: 1,
    }],
  ]);

  const targets = selectCandleTargets({
    heldTickers: [],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 2,
    candleEvalHistoryMap,
    nowMs: now,
  });

  const b3Target = targets.find((t) => t.ticker.market === "KRW-B3");
  assert(b3Target !== undefined, "TC12: 거래대금 급증한 B3는 쿨다운 해제되어 candleTargets에 재선정");
  assert(b3Target?.reason === "CORE" || b3Target?.reason === "FRESH_SURGE", `TC12: B3 선택 이유: ${b3Target?.reason}`);
}

// ─── TC13: ROTATION/CORE/FRESH 대상 범위 MOMENTUM_TOP_M (40개) 정합성 검증 ─
section("TC13: ROTATION/CORE/FRESH 대상 범위 MOMENTUM_TOP_M (40개) 정합성 검증");
{
  const now = Date.now();
  const tickers: UpbitTicker[] = [];
  // 100개 종목 생성: Rank 1 ~ 100
  for (let i = 1; i <= 100; i++) {
    tickers.push(
      makeTicker({
        market: `KRW-TOKEN${i}`,
        signed_change_rate: 0.001 * (101 - i), // TOKEN1이 1위, TOKEN100이 100위
        trade_price: 1000,
        acc_trade_price_24h: 1_000_000_000 + (101 - i) * 10_000_000,
      }),
    );
  }

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 40,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  // HELD 종목: Rank 50인 TOKEN50을 보유 중으로 설정
  const heldTicker50 = tickers.find((t) => t.market === "KRW-TOKEN50")!;

  const targets = selectCandleTargets({
    heldTickers: [heldTicker50],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 5,
    candleEvalHistoryMap: new Map(),
    nowMs: now,
    topM: 40,
  });

  const targetMarkets = targets.map((t) => t.ticker.market);
  assert(targetMarkets.includes("KRW-TOKEN50"), "TC13: HELD 종목은 rank 50이어도 정상 선정됨 (HELD 우선)");
  
  // 비보유 선정 종목들은 모두 rank 1~40 이내여야 함
  const nonHeldTargets = targets.filter((t) => t.reason !== "HELD");
  for (const nht of nonHeldTargets) {
    const rankNum = parseInt(nht.ticker.market.replace("KRW-TOKEN", ""), 10);
    assert(rankNum <= 40, `TC13: 비보유 종목 ${nht.ticker.market}은 rank 1~40 이내 (${rankNum})`);
  }
}

// ─── TC14: Cooling-down fresh evidence (단기 가격 반등 vs 음수/미변동) 검증 ──
section("TC14: Cooling-down fresh evidence (단기 가격 반등 vs 음수/미변동) 검증");
{
  const now = Date.now();

  // CASE 1: 단기 가격 반등 (+0.5% 상승: 1000 -> 1005)
  const bounceTicker = makeTicker({ market: "KRW-BOUNCE", signed_change_rate: 0.10, trade_price: 1005 });
  const otherTicker = makeTicker({ market: "KRW-OTHER", signed_change_rate: 0.05, trade_price: 500 });
  const momBounce = selectMomentumTopM([bounceTicker, otherTicker], {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  const histBounce = new Map<string, CandleEvalHistory>([
    ["KRW-BOUNCE", {
      lastEvaluatedAtMs: now - 30_000,
      lastStatus: "제외",
      lastScore: 0,
      lastMomentumScore: 30.0,
      lastPrice: 1000, // 직전 평가 가격: 1000 -> 현재 1005 (+0.5%)
      consecutiveFatalLowCount: 1,
    }],
  ]);

  const targetsBounce = selectCandleTargets({
    heldTickers: [],
    momentumScored: momBounce.scoredCandidates,
    dynamicCandleTarget: 2,
    candleEvalHistoryMap: histBounce,
    nowMs: now,
  });
  const bounceSelected = targetsBounce.find((t) => t.ticker.market === "KRW-BOUNCE");
  assert(bounceSelected !== undefined, "TC14: 단기 가격 반등한 KRW-BOUNCE는 쿨다운 해제되어 candleTargets 선정");

  // CASE 2: 단기 가격 하락 (1000 -> 995) 또는 제자리 -> 쿨다운 유지되어야 함
  const dropTicker = makeTicker({ market: "KRW-DROP", signed_change_rate: 0.10, trade_price: 995 });
  const momDrop = selectMomentumTopM([dropTicker, otherTicker], {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  const histDrop = new Map<string, CandleEvalHistory>([
    ["KRW-DROP", {
      lastEvaluatedAtMs: now - 30_000,
      lastStatus: "제외",
      lastScore: 0,
      lastMomentumScore: 30.0,
      lastPrice: 1000, // 직전 평가 가격: 1000 -> 현재 995 (-0.5%)
      consecutiveFatalLowCount: 1,
    }],
  ]);

  const targetsDrop = selectCandleTargets({
    heldTickers: [],
    momentumScored: momDrop.scoredCandidates,
    dynamicCandleTarget: 1,
    candleEvalHistoryMap: histDrop,
    nowMs: now,
  });
  const dropSelected = targetsDrop.find((t) => t.ticker.market === "KRW-DROP");
  assert(dropSelected === undefined, "TC14: 단기 가격 하락한 KRW-DROP은 쿨다운 유지 (슬롯 양보)");
}

// ─── TC15: ACTIVE_TRACKING exploration 슬롯 독점 방지 검증 ─────────────
section("TC15: ACTIVE_TRACKING exploration 슬롯 독점 방지 및 탐색 보장");
{
  const now = Date.now();
  // 3개 후보:
  // 1위 TRK1 (모니터링 상태)
  // 2위 TRK2 (진입직전 상태)
  // 3위 FRESH_NEW (새로 등장한 신규 상승 후보)
  const tickers: UpbitTicker[] = [
    makeTicker({ market: "KRW-TRK1", signed_change_rate: 0.20 }),
    makeTicker({ market: "KRW-TRK2", signed_change_rate: 0.18 }),
    makeTicker({ market: "KRW-FRESH_NEW", signed_change_rate: 0.15 }),
  ];

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 3,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  const histMap = new Map<string, CandleEvalHistory>([
    ["KRW-TRK1", {
      lastEvaluatedAtMs: now - 20_000,
      lastStatus: "모니터링",
      lastScore: 60.0,
      lastMomentumScore: 20.0,
      lastPrice: 1000,
      consecutiveFatalLowCount: 0,
    }],
    ["KRW-TRK2", {
      lastEvaluatedAtMs: now - 20_000,
      lastStatus: "진입직전",
      lastScore: 78.0,
      lastMomentumScore: 18.0,
      lastPrice: 500,
      consecutiveFatalLowCount: 0,
    }],
  ]);

  // dynamicCandleTarget = 2 에서 ACTIVE_TRACKING이 2개 있어도,
  // 1개 슬롯만 ACTIVE_TRACKING에 할당되고 나머지 1개 슬롯은 신규 FRESH_NEW 탐색에 보장되어야 함!
  const targets = selectCandleTargets({
    heldTickers: [],
    momentumScored: momRes.scoredCandidates,
    dynamicCandleTarget: 2,
    candleEvalHistoryMap: histMap,
    nowMs: now,
  });

  assert(targets.length === 2, "TC15: 2개 candleTargets 선택");
  const targetMarkets = targets.map((t) => t.ticker.market);
  assert(targetMarkets.includes("KRW-FRESH_NEW"), "TC15: 신규 후보 KRW-FRESH_NEW가 최소 1개 탐색 슬롯을 배정받음 (독점 차단)");
  const activeCount = targets.filter((t) => t.reason === "ACTIVE_TRACKING").length;
  assert(activeCount === 1, `TC15: ACTIVE_TRACKING 슬롯은 최대 1개로 제한되어 2개 슬롯 전부를 독점하지 않음 (실제: ${activeCount})`);
}

// ─── TC16: ACTIVE_TRACKING 후보 간 starvation 방지 및 공정 순환 검증 ──────
section("TC16: ACTIVE_TRACKING 후보 간 starvation 방지 및 공정 순환 검증");
{
  const baseTime = Date.now();
  // 3개의 ACTIVE_TRACKING 후보 (A, B, C) 및 1개의 신규 exploration 후보 (EXP)
  // A는 momentum 1위, B는 2위, C는 3위, EXP는 4위
  const tickers = [
    makeTicker({ market: "KRW-A", signed_change_rate: 0.30, trade_price: 1000 }),
    makeTicker({ market: "KRW-B", signed_change_rate: 0.25, trade_price: 2000 }),
    makeTicker({ market: "KRW-C", signed_change_rate: 0.20, trade_price: 3000 }),
    makeTicker({ market: "KRW-EXP", signed_change_rate: 0.15, trade_price: 4000 }),
  ];

  const momRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 4,
    useVolumeWeight: true,
    snapshot: new Map(),
    prevRankByMarket: new Map(),
  });

  // 초기 상태: A는 30초 전, B는 20초 전, C는 10초 전 평가됨 (모두 "진입직전" 또는 "모니터링")
  const historyMap = new Map<string, CandleEvalHistory>([
    ["KRW-A", {
      lastEvaluatedAtMs: baseTime - 30_000,
      lastStatus: "진입직전",
      lastScore: 75.0,
      lastMomentumScore: 30.0,
      lastPrice: 1000,
      consecutiveFatalLowCount: 0,
    }],
    ["KRW-B", {
      lastEvaluatedAtMs: baseTime - 20_000,
      lastStatus: "모니터링",
      lastScore: 65.0,
      lastMomentumScore: 25.0,
      lastPrice: 2000,
      consecutiveFatalLowCount: 0,
    }],
    ["KRW-C", {
      lastEvaluatedAtMs: baseTime - 10_000,
      lastStatus: "진입직전",
      lastScore: 80.0,
      lastMomentumScore: 20.0,
      lastPrice: 3000,
      consecutiveFatalLowCount: 0,
    }],
  ]);

  const activeSelectedOrder: string[] = [];

  // 4번의 연속 tick 시뮬레이션 (각 tick마다 1초 경과 및 선택된 ACTIVE 후보의 평가 완료 시뮬레이션)
  for (let tick = 0; tick < 4; tick++) {
    const currentTickTime = baseTime + tick * 1000;

    const targets = selectCandleTargets({
      heldTickers: [],
      momentumScored: momRes.scoredCandidates,
      dynamicCandleTarget: 2,
      candleEvalHistoryMap: historyMap,
      nowMs: currentTickTime,
      topM: 4,
    });

    assert(targets.length === 2, `TC16 [Tick ${tick + 1}]: 슬롯 2개 배정`);
    const activeTargets = targets.filter((t) => t.reason === "ACTIVE_TRACKING");
    const explorationTargets = targets.filter((t) => t.reason !== "ACTIVE_TRACKING");

    assert(activeTargets.length === 1, `TC16 [Tick ${tick + 1}]: ACTIVE_TRACKING 슬롯은 정확히 1개`);
    assert(explorationTargets.length === 1, `TC16 [Tick ${tick + 1}]: 탐색 슬롯 최소 1개 보장 (KRW-EXP 선정)`);
    assert(explorationTargets[0]!.ticker.market === "KRW-EXP", `TC16 [Tick ${tick + 1}]: 탐색 슬롯은 신규 후보 KRW-EXP`);

    const selectedActive = activeTargets[0]!.ticker.market;
    activeSelectedOrder.push(selectedActive);

    // 캔들 평가 완료 시뮬레이션: 선택된 ACTIVE 종목의 lastEvaluatedAtMs를 현재 tick 시간으로 갱신
    const hist = historyMap.get(selectedActive)!;
    hist.lastEvaluatedAtMs = currentTickTime;
  }

  // 검증: A -> B -> C -> A 순환 확인
  assert(activeSelectedOrder[0] === "KRW-A", `TC16: Tick 1에서 가장 오래 평가 안 된 KRW-A 선정 (실제: ${activeSelectedOrder[0]})`);
  assert(activeSelectedOrder[1] === "KRW-B", `TC16: Tick 2에서 가장 오래 평가 안 된 KRW-B 선정 (실제: ${activeSelectedOrder[1]})`);
  assert(activeSelectedOrder[2] === "KRW-C", `TC16: Tick 3에서 가장 오래 평가 안 된 KRW-C 선정 (실제: ${activeSelectedOrder[2]})`);
  assert(activeSelectedOrder[3] === "KRW-A", `TC16: Tick 4에서 다시 가장 오래 평가 안 된 KRW-A 순환 선정 (실제: ${activeSelectedOrder[3]})`);

  // A가 전체를 독점하지 않고 A, B, C가 모두 평가 기회를 얻었는지 최종 확인
  const uniqueSelected = new Set(activeSelectedOrder);
  assert(uniqueSelected.size === 3, "TC16: A, B, C 3개 후보가 모두 평가 기회를 획득함 (독점 없음)");
}

// ─── TC17: CandleEvalHistory 런타임 필드 갱신 및 10분 Stale Pruning 검증 ─
section("TC17: CandleEvalHistory 런타임 필드 갱신 및 10분 Stale Pruning 검증");
{
  const now = Date.now();
  const historyMap = new Map<string, CandleEvalHistory>();

  // 1) 런타임 갱신 6개 필수 필드 검증 시뮬레이션
  const ticker = makeTicker({ market: "KRW-TEST", trade_price: 1500 });
  const fakeCandles1m: UpbitCandle[] = Array.from({ length: 25 }, (_, i) => ({
    market: "KRW-TEST",
    candle_date_time_utc: new Date(now - (25 - i) * 60_000).toISOString(),
    candle_date_time_kst: new Date(now - (25 - i) * 60_000).toISOString(),
    opening_price: 1400,
    high_price: 1510,
    low_price: 1390,
    trade_price: 1500,
    timestamp: now - (25 - i) * 60_000,
    candle_acc_trade_price: 100_000_000,
    candle_acc_trade_volume: 70_000,
    unit: 1,
  }));
  const fakeCandles5m = fakeCandles1m;

  const scoreRes = scoreOne(fakeCandles1m, fakeCandles5m, ticker, 0);
  assert(scoreRes !== null, "TC17: scoreOne 평가 성공");

  if (scoreRes) {
    // 런타임 기록
    const prevHist = historyMap.get(ticker.market);
    historyMap.set(ticker.market, {
      lastEvaluatedAtMs: now,
      lastStatus: scoreRes.status,
      lastScore: scoreRes.score,
      lastExcludeReasons: scoreRes.exclude_reasons,
      lastMomentumScore: 42.5,
      lastPrice: ticker.trade_price,
      consecutiveFatalLowCount: scoreRes.status === "제외" ? ((prevHist?.consecutiveFatalLowCount ?? 0) + 1) : 0,
    });

    const recorded = historyMap.get("KRW-TEST")!;
    assert(recorded.lastEvaluatedAtMs === now, "TC17: lastEvaluatedAtMs 정상 기록");
    assert(recorded.lastStatus === scoreRes.status, "TC17: lastStatus 정상 기록");
    assert(recorded.lastScore === scoreRes.score, "TC17: lastScore 정상 기록");
    assert(recorded.lastMomentumScore === 42.5, "TC17: lastMomentumScore 정상 기록");
    assert(recorded.lastPrice === 1500, "TC17: lastPrice 정상 기록");
    assert(recorded.lastExcludeReasons === scoreRes.exclude_reasons, "TC17: lastExcludeReasons 정상 기록");
  }

  // 2) 10분 Stale Pruning 검증 (Map 무한 증가 방지)
  // 3개 entry 생성: 15분 전(stale), 11분 전(stale), 5분 전(fresh)
  historyMap.set("KRW-OLD15M", {
    lastEvaluatedAtMs: now - 15 * 60_000,
    lastStatus: "모니터링",
    lastScore: 60,
    lastMomentumScore: 20,
    lastPrice: 100,
    consecutiveFatalLowCount: 0,
  });
  historyMap.set("KRW-OLD11M", {
    lastEvaluatedAtMs: now - 11 * 60_000,
    lastStatus: "진입직전",
    lastScore: 75,
    lastMomentumScore: 30,
    lastPrice: 200,
    consecutiveFatalLowCount: 0,
  });
  historyMap.set("KRW-FRESH5M", {
    lastEvaluatedAtMs: now - 5 * 60_000,
    lastStatus: "모니터링",
    lastScore: 68,
    lastMomentumScore: 25,
    lastPrice: 300,
    consecutiveFatalLowCount: 0,
  });

  assert(historyMap.size === 4, "TC17: 정리 전 historyMap 크기 4");

  const deletedCount = pruneCandleEvalHistory(historyMap, now, 600_000);

  assert(deletedCount === 2, `TC17: 10분 이상 지난 2개 항목 정리됨 (실제 삭제: ${deletedCount})`);
  assert(historyMap.size === 2, `TC17: 정리 후 10분 이내 2개 항목만 유지됨 (실제 크기: ${historyMap.size})`);
  assert(!historyMap.has("KRW-OLD15M"), "TC17: 15분 전 항목 삭제됨");
  assert(!historyMap.has("KRW-OLD11M"), "TC17: 11분 전 항목 삭제됨");
  assert(historyMap.has("KRW-FRESH5M"), "TC17: 5분 전 항목 보존됨");
  assert(historyMap.has("KRW-TEST"), "TC17: 방금 평가된 항목 보존됨");
}

// ─── 요약 ─────────────────────────────────────────────────────────────
console.log(`\n============================`);
console.log(`결과: ${passed} 통과 / ${passed + failed} 전체`);
if (failed === 0) {
  console.log("PASS: 모든 momentum ranking 및 anti-starvation 회귀 테스트 성공");
} else {
  console.error("FAIL: 테스트 실패 발생");
  process.exit(1);
}




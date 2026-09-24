/**
 * test-momentum-stale-daily-authority.ts
 *
 * selectMomentumTopM()의 stale daily-rise authority 제거 (priceComp = shortPct)
 * 실전 데이터 재현 및 회귀 테스트.
 *
 * 검증 케이스:
 *  1. EGLD 04:08:00Z: sr=+43.36%, shortPct=0% -> old=35.0(Rank 3) vs new=0.0(Rank 70+)
 *  2. 04:10:00Z (dynamicCandleTarget=4, HELD=1):
 *     - Old: EGLD(Rank 2, 35.0) -> Selected, GRT(Rank 5, 27.53) -> CUT
 *     - New: EGLD -> Score 0.0 (CUT), GRT -> Rank 3 (Selected & TRADABLE)
 *  3. NEAR/A/TAO 04:08:00Z: 1~3분 거래량 폭발 종목들이 상위 랭킹(Top 3)으로 정상 승격
 *  4. META2 03:52:00Z: 단기 모멘텀 반영 검증
 *
 * 실행: npx tsx server/src/test-momentum-stale-daily-authority.ts
 */

import { selectMomentumTopM, selectCandleTargets } from "./pump-scanner.js";
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
  trade_price: number;
  acc_trade_price_24h?: number;
  signed_change_rate?: number;
}): UpbitTicker {
  return {
    market: opts.market,
    trade_price: opts.trade_price,
    acc_trade_price_24h: opts.acc_trade_price_24h ?? 5_000_000_000,
    signed_change_rate: opts.signed_change_rate ?? 0,
  };
}

// ─── Case 1: EGLD 04:08:00Z 재현 ─────────────────────────────────────────
section("Case 1: EGLD 04:08:00Z Stale Daily Rise Authority 재현");
{
  const now = Date.now();
  // 스냅샷: 8530원, 24시간 거래대금 500억
  // 현재가: 8515원 (-0.18% 하락), signed_change_rate: +0.4336 (+43.36%)
  const snapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-EGLD", { ts: now - 2000, trade_price: 8530, acc24: 50_000_000_000 }],
    ["KRW-NEAR", { ts: now - 2000, trade_price: 6000, acc24: 10_000_000_000 }],
  ]);

  const tickers = [
    makeTicker({ market: "KRW-EGLD", trade_price: 8515, acc_trade_price_24h: 50_000_000_000, signed_change_rate: 0.4336 }),
    makeTicker({ market: "KRW-NEAR", trade_price: 6060, acc_trade_price_24h: 10_026_026_861, signed_change_rate: 0.0135 }),
  ];

  const prevRank = new Map<string, number>([
    ["KRW-EGLD", 1],
    ["KRW-NEAR", 80],
  ]);

  const res = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 2,
    useVolumeWeight: true,
    snapshot,
    prevRankByMarket: prevRank,
  });

  const egldScored = res.scoredCandidates.find((x) => x.t.market === "KRW-EGLD");
  const nearScored = res.scoredCandidates.find((x) => x.t.market === "KRW-NEAR");

  assert(egldScored !== undefined, "EGLD scored 존재");
  assert(nearScored !== undefined, "NEAR scored 존재");
  
  // New logic: EGLD priceComp must be 0 (since shortPct is 0), not 0.4336
  assert(egldScored!.priceComp === 0, `EGLD new priceComp = 0 (실제: ${egldScored?.priceComp})`);
  assert(nearScored!.priceComp === 0.01, `NEAR new priceComp = 0.01 (+1%) (실제: ${nearScored?.priceComp.toFixed(4)})`);
  
  // EGLD score should be 0 since volD=0, rankDelta=0, priceComp=0
  assert(egldScored!.momentum === 0, `EGLD new momentum = 0.0 (실제: ${egldScored?.momentum.toFixed(2)})`);
  assert(nearScored!.momentum > egldScored!.momentum, `NEAR(${nearScored?.momentum.toFixed(2)})가 정체된 EGLD(${egldScored?.momentum.toFixed(2)})를 역전`);
}

// ─── Case 2: 04:10:00Z EGLD / GRT / ONG / HBAR 슬롯 밀어내기 해소 검증 ──
section("Case 2: 04:10:00Z dynamicCandleTarget=4, HELD=1 슬롯 해소 검증");
{
  const now = Date.now();
  // 04:10Z 상황:
  // HELD: KRW-HELD1 (1슬롯 차지) -> 잔여 슬롯 3개
  // EGLD: sr=+43.53%, shortPct=0, volD=0, rankDelta=0
  // ONG: sr=+0.82%, shortPct=+0.82%, volD=6.2M, rankDelta=79 -> TRADABLE
  // HBAR: sr=+0.81%, shortPct=+0.81%, volD=0, rankDelta=77 -> TRADABLE
  // GRT: sr=+1.17%, shortPct=+0.35%, volD=3.1M, rankDelta=70 -> TRADABLE
  const snapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-HELD1", { ts: now - 2000, trade_price: 1000, acc24: 10_000_000_000 }],
    ["KRW-EGLD", { ts: now - 2000, trade_price: 8550, acc24: 50_000_000_000 }],
    ["KRW-ONG", { ts: now - 2000, trade_price: 500, acc24: 5_000_000_000 }],
    ["KRW-HBAR", { ts: now - 2000, trade_price: 100, acc24: 10_000_000_000 }],
    ["KRW-GRT", { ts: now - 2000, trade_price: 300, acc24: 4_000_000_000 }],
  ]);

  const heldTicker = makeTicker({ market: "KRW-HELD1", trade_price: 1000, acc_trade_price_24h: 10_000_000_000, signed_change_rate: 0.05 });
  const tickers = [
    heldTicker,
    makeTicker({ market: "KRW-EGLD", trade_price: 8550, acc_trade_price_24h: 50_000_000_000, signed_change_rate: 0.4353 }),
    makeTicker({ market: "KRW-ONG", trade_price: 504.1, acc_trade_price_24h: 5_006_239_256, signed_change_rate: 0.0082 }),
    makeTicker({ market: "KRW-HBAR", trade_price: 100.81, acc_trade_price_24h: 10_000_000_000, signed_change_rate: 0.0081 }),
    makeTicker({ market: "KRW-GRT", trade_price: 301.05, acc_trade_price_24h: 4_003_120_400, signed_change_rate: 0.0117 }),
  ];

  const prevRank = new Map<string, number>([
    ["KRW-HELD1", 20],
    ["KRW-EGLD", 1],
    ["KRW-ONG", 82],
    ["KRW-HBAR", 80],
    ["KRW-GRT", 74],
  ]);

  const mRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 5,
    useVolumeWeight: true,
    snapshot,
    prevRankByMarket: prevRank,
  });

  const targets = selectCandleTargets({
    heldTickers: [heldTicker],
    momentumScored: mRes.scoredCandidates,
    dynamicCandleTarget: 4,
    candleEvalHistoryMap: new Map(),
    nowMs: now,
  });

  const targetMarkets = targets.map((t) => t.ticker.market);
  console.log(`  New Candle Targets (총 ${targetMarkets.length}개): ${targetMarkets.join(", ")}`);
  
  assert(targetMarkets.includes("KRW-HELD1"), "HELD1은 최우선 슬롯 포함 (HELD)");
  assert(targetMarkets.includes("KRW-ONG"), "ONG은 캔들 타겟 포함 (TRADABLE 후보)");
  assert(targetMarkets.includes("KRW-HBAR"), "HBAR는 캔들 타겟 포함 (TRADABLE 후보)");
  assert(targetMarkets.includes("KRW-GRT"), "GRT는 신규 로직에서 캔들 타겟 정상 진입! (과거 CUT 탈출)");
  assert(!targetMarkets.includes("KRW-EGLD"), "정체된 EGLD는 캔들 타겟에서 정상 제외(CUT)됨!");
}

// ─── Case 3: 04:08:00Z NEAR / A / TAO 순위 상승 검증 ───────────────────
section("Case 3: 04:08:00Z NEAR / A / TAO 신선한 모멘텀 승격 검증");
{
  const now = Date.now();
  const snapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-EGLD", { ts: now - 2000, trade_price: 8530, acc24: 50_000_000_000 }],
    ["KRW-NEAR", { ts: now - 2000, trade_price: 6000, acc24: 10_000_000_000 }],
    ["KRW-A", { ts: now - 2000, trade_price: 2000, acc24: 5_000_000_000 }],
    ["KRW-TAO", { ts: now - 2000, trade_price: 400_000, acc24: 8_000_000_000 }],
  ]);

  const tickers = [
    makeTicker({ market: "KRW-EGLD", trade_price: 8515, acc_trade_price_24h: 50_000_000_000, signed_change_rate: 0.4336 }),
    makeTicker({ market: "KRW-NEAR", trade_price: 6024, acc_trade_price_24h: 10_026_026_861, signed_change_rate: 0.0135 }),
    makeTicker({ market: "KRW-A", trade_price: 2005, acc_trade_price_24h: 5_005_534_069, signed_change_rate: 0.0079 }),
    makeTicker({ market: "KRW-TAO", trade_price: 401240, acc_trade_price_24h: 8_004_882_100, signed_change_rate: 0.0211 }),
  ];

  const prevRank = new Map<string, number>([
    ["KRW-EGLD", 1],
    ["KRW-NEAR", 64],
    ["KRW-A", 74],
    ["KRW-TAO", 68],
  ]);

  const mRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 4,
    useVolumeWeight: true,
    snapshot,
    prevRankByMarket: prevRank,
  });

  const top1 = mRes.momentumTop[0].market;
  const top2 = mRes.momentumTop[1].market;
  const top3 = mRes.momentumTop[2].market;
  const last = mRes.momentumTop[3].market;

  assert(["KRW-NEAR", "KRW-A", "KRW-TAO"].includes(top1), `Top 1은 실시간 급등주 (${top1})`);
  assert(["KRW-NEAR", "KRW-A", "KRW-TAO"].includes(top2), `Top 2는 실시간 급등주 (${top2})`);
  assert(["KRW-NEAR", "KRW-A", "KRW-TAO"].includes(top3), `Top 3는 실시간 급등주 (${top3})`);
  assert(last === "KRW-EGLD", `정체된 EGLD는 최하위로 밀려남 (실제: ${last})`);
}

// ─── Case 4: 03:52:00Z META2 단기 모멘텀 검증 ─────────────────────────
section("Case 4: 03:52:00Z META2 단기 모멘텀 검증");
{
  const now = Date.now();
  const snapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>([
    ["KRW-META2", { ts: now - 2000, trade_price: 100, acc24: 1_000_000_000 }],
  ]);

  const tickers = [
    makeTicker({ market: "KRW-META2", trade_price: 100.4, acc_trade_price_24h: 1_009_800_000, signed_change_rate: 0.028 }),
  ];

  const prevRank = new Map<string, number>([
    ["KRW-META2", 55],
  ]);

  const mRes = selectMomentumTopM(tickers, {
    is429Excluded: () => false,
    lookbackMin: 3,
    topM: 1,
    useVolumeWeight: true,
    snapshot,
    prevRankByMarket: prevRank,
  });

  const metaScored = mRes.scoredCandidates.find((x) => x.t.market === "KRW-META2");
  assert(metaScored !== undefined, "META2 scored 존재");
  assert(Math.abs(metaScored!.priceComp - 0.004) < 1e-6, `META2 shortPct = 0.004 (+0.4%) (실제: ${metaScored?.priceComp.toFixed(4)})`);
  assert(metaScored!.momentum > 0, `META2 momentum = ${metaScored?.momentum.toFixed(2)} > 0`);
}

console.log("\n============================");
console.log(`결과: ${passed} 통과 / ${passed + failed} 전체`);
if (failed > 0) {
  console.error("FAIL: 일부 테스트 실패!");
  process.exit(1);
} else {
  console.log("PASS: 모든 stale daily authority 제거 및 실전 케이스 검증 성공");
}

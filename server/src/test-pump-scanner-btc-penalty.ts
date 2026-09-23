/**
 * test-pump-scanner-btc-penalty.ts
 *
 * 회귀 테스트: pump-scanner BTC 약세(btcDropPenalty) 처리 버그 수정 검증
 *
 * 요구사항 및 정책:
 *  1. "BTC 역풍"은 exclude_reasons(FATAL 사유)에서 제거됨.
 *  2. btcDropPenalty는 실제 점수 계산에서 정확히 감점값(-8점)으로만 적용됨.
 *  3. 유동성 부족, 윗꼬리 과다, 과열, 거래대금 부족, fakeout/cooldown 등 기존 FATAL 로직은 불변.
 *  4. BTC -1% 미만이어도 강한 후보 자체는 정상 평가되며 최종 score에서 정확히 8점만 차감.
 *  5. BTC -1% 이상이면 감점 0 (기존 점수와 100% 동일).
 *
 * 실행: npx tsx server/src/test-pump-scanner-btc-penalty.ts
 */

import { scoreOne, type FakeoutState } from "./pump-scanner.js";
import type { UpbitCandle, UpbitTicker } from "./upbit-public.js";

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

/** 캔들 생성 헬퍼 */
function makeCandles(opts: {
  prevPrice?: number;
  prevVolume?: number;
  lastOpen?: number;
  lastHigh?: number;
  lastLow?: number;
  lastClose?: number;
  lastVolume?: number;
  stepUp?: boolean;
}): UpbitCandle[] {
  const prevPrice = opts.prevPrice ?? 1000;
  const prevVolume = opts.prevVolume ?? 100;
  const lastClose = opts.lastClose ?? 1030;
  const lastOpen = opts.lastOpen ?? 1015;
  const lastHigh = opts.lastHigh ?? 1032;
  const lastLow = opts.lastLow ?? 1012;
  const lastVolume = opts.lastVolume ?? 500;

  const candles: UpbitCandle[] = [];
  const now = Date.now();

  // 직전 20개 기준 완성봉 (i=0~19)
  for (let i = 0; i < 20; i++) {
    const isRecent3 = i >= 17;
    const p = opts.stepUp && isRecent3 ? prevPrice + (i - 16) * 7 : prevPrice;
    candles.push({
      opening_price: p,
      high_price: p * 1.005,
      low_price: p * 0.995,
      trade_price: p,
      candle_acc_trade_volume: prevVolume,
      candle_date_time_kst: new Date(now - (22 - i) * 60_000).toISOString(),
    });
  }

  // 직전 완성봉 (c1[c1.length - 2]): 급등 거래량 완주
  candles.push({
    opening_price: lastOpen,
    high_price: lastHigh,
    low_price: lastLow,
    trade_price: lastClose,
    candle_acc_trade_volume: lastVolume,
    candle_date_time_kst: new Date(now - 60_000).toISOString(),
  });

  // 현재 진행봉 (c1[c1.length - 1]): 15초 동안 비례 누적된 거래량 (lastVolume * 15 / 60)
  candles.push({
    opening_price: lastOpen,
    high_price: lastHigh,
    low_price: lastLow,
    trade_price: lastClose,
    candle_acc_trade_volume: lastVolume * (15 / 60),
    candle_date_time_kst: new Date(now - 15_000).toISOString(), // 15초 경과 (projected 활성화)
  });

  return candles;
}

function makeTicker(opts?: { acc_trade_price_24h?: number; trade_price?: number; signed_change_rate?: number }): UpbitTicker {
  return {
    market: "KRW-TEST",
    trade_price: opts?.trade_price ?? 1030,
    acc_trade_price_24h: opts?.acc_trade_price_24h ?? 5_000_000_000, // 기본 50억 (유동성 충분)
    signed_change_rate: opts?.signed_change_rate ?? 0.03,
  };
}

// ─── TC1 & TC2: 강한 후보에서 BTC penalty 0 vs 8 비교 ──────────────────
section("TC1 & TC2: 강한 후보에서 BTC penalty 감점 및 비FATAL 검증");

// 강한 후보: 거래량 5배, 고점 돌파, 윗꼬리 안정(closeTopRatio 0.9), 1분 펌프 1.5% (과열 아님), 점진 상승
const strongCandles = makeCandles({
  prevPrice: 1000,
  prevVolume: 100,
  lastOpen: 1022,
  lastHigh: 1032,
  lastLow: 1020,
  lastClose: 1030, // closeTopRatio = 10/12 = 0.833, upperWickRatio = 2/12 = 0.167 (안정)
  lastVolume: 500, // volumeMultiple = 5.0
  stepUp: true,
});
const strongTicker = makeTicker({ acc_trade_price_24h: 10_000_000_000, trade_price: 1030 });

// BTC Penalty = 0
const resBtc0 = scoreOne(strongCandles, [], strongTicker, 0);
assert(resBtc0 !== null, "TC1: scoreOne 결과 존재 (btc=0)");
assert(resBtc0?.status === "진입직전", `TC1: btc=0 시 정상 진입직전 상태 (${resBtc0?.status}, 점수: ${resBtc0?.score})`);
assert(resBtc0?.exclude_reasons === undefined, "TC1: exclude_reasons 없음");

// BTC Penalty = 8
const resBtc8 = scoreOne(strongCandles, [], strongTicker, 8);
assert(resBtc8 !== null, "TC2: scoreOne 결과 존재 (btc=8)");
assert(resBtc8?.status !== "제외", `TC2: btc=8이어도 강한 후보는 제외되지 않음 (${resBtc8?.status})`);
assert(resBtc8?.exclude_reasons === undefined, "TC2: exclude_reasons에 'BTC 역풍' 없음 (FATAL 제외 제거됨)");
assert(
  resBtc0 !== null && resBtc8 !== null && Math.abs((resBtc0.score - 8) - resBtc8.score) < 0.01,
  `TC2: score가 정확히 8점 차감됨 (btc0: ${resBtc0?.score} -> btc8: ${resBtc8?.score}, 차이: ${resBtc0 && resBtc8 ? (resBtc0.score - resBtc8.score).toFixed(1) : "N/A"})`
);

// ─── TC3 ~ TC7: 실제 FATAL 요인은 기존처럼 정상 제외 ────────────────────
section("TC3 ~ TC7: 실제 FATAL 조건 유지 검증 (BTC penalty와 무관하게 차단)");

// TC3: 유동성 부족 (24h 거래대금 < 10억)
const lowLiqTicker = makeTicker({ acc_trade_price_24h: 500_000_000, trade_price: 1030 }); // 5억
const resLowLiq = scoreOne(strongCandles, [], lowLiqTicker, 8);
assert(resLowLiq?.status === "제외", "TC3: 유동성 부족 시 status='제외'");
assert(resLowLiq?.exclude_reasons?.includes("유동성 부족") === true, "TC3: exclude_reasons에 '유동성 부족' 포함");
assert(resLowLiq?.exclude_reasons?.includes("BTC 역풍") === false, "TC3: exclude_reasons에 'BTC 역풍' 없음");

// TC4: 윗꼬리 과다 (upperWickRatio > 0.55)
const wickCandles = makeCandles({
  prevPrice: 1000,
  prevVolume: 100,
  lastOpen: 1010,
  lastHigh: 1100,
  lastLow: 1010,
  lastClose: 1030, // upperWickRatio = (1100-1030)/(1100-1010) = 70/90 = 0.778 > 0.55
  lastVolume: 500,
  stepUp: true,
});
const resWick = scoreOne(wickCandles, [], strongTicker, 8);
assert(resWick?.status === "제외", "TC4: 윗꼬리 과다 시 status='제외'");
assert(resWick?.exclude_reasons?.includes("윗꼬리 과다") === true, "TC4: exclude_reasons에 '윗꼬리 과다' 포함");

// TC5: 거래대금 부족 (volumeMultiple < 0.95)
const lowVolCandles = makeCandles({
  prevPrice: 1000,
  prevVolume: 100,
  lastOpen: 1010,
  lastHigh: 1020,
  lastLow: 1005,
  lastClose: 1015,
  lastVolume: 50, // volumeMultiple = 0.5 < 0.95
  stepUp: true,
});
const resLowVol = scoreOne(lowVolCandles, [], strongTicker, 8);
assert(resLowVol?.status === "제외", "TC5: 거래대금 부족 시 status='제외'");
assert(resLowVol?.exclude_reasons?.includes("거래대금 부족") === true, "TC5: exclude_reasons에 '거래대금 부족' 포함");

// TC6: 과열 (oneMinPump > 4.5%)
const overheatCandles = makeCandles({
  prevPrice: 1000,
  prevVolume: 100,
  lastOpen: 1000,
  lastHigh: 1060,
  lastLow: 1000,
  lastClose: 1050, // 5% 상승 > 4.5%
  lastVolume: 500,
  stepUp: false,
});
const resOverheat = scoreOne(overheatCandles, [], strongTicker, 8);
assert(resOverheat?.status === "제외", "TC6: 과열 시 status='제외'");
assert(resOverheat?.exclude_reasons?.includes("과열 (추격주의)") === true, "TC6: exclude_reasons에 '과열 (추격주의)' 포함");

// TC7: Fakeout Cooldown 활성 상태
const fakeoutState: FakeoutState = {
  peakVolumeMultiple: 5.0,
  peakPrice: 1100,
  detectedAtMs: Date.now() - 60_000,
  rejectedUntilMs: Date.now() + 9 * 60_000, // cooldown 9분 남음
  lastReason: "VOLUME_FADE_REJECTED",
};
const resFakeout = scoreOne(strongCandles, [], strongTicker, 8, fakeoutState);
assert(resFakeout?.status === "제외", "TC7: fakeout cooldown active 시 status='제외'");
assert(resFakeout?.exclude_reasons?.includes("VOLUME_FADE_REJECTED") === true, "TC7: exclude_reasons에 fakeout reason 포함");

// ─── TC8: Early / Add Entry Eligible 점수 보정 대비 -8 감점 검증 ────────
section("TC8: Early / Add Entry Eligible 점수 보정 대비 정확한 감점 검증");

// 선진입 earlyEntryEligible 후보 (볼륨배수 1.5, 3분 상승 신호)
const earlyCandles = makeCandles({
  prevPrice: 1000,
  prevVolume: 100,
  lastOpen: 1002,
  lastHigh: 1010,
  lastLow: 1000,
  lastClose: 1008,
  lastVolume: 150, // volumeMultiple = 1.5 > 1.2
  stepUp: true,
});
const resEarlyBtc0 = scoreOne(earlyCandles, [], strongTicker, 0);
const resEarlyBtc8 = scoreOne(earlyCandles, [], strongTicker, 8);
assert(resEarlyBtc0 !== null && resEarlyBtc8 !== null, "TC8: earlyEntry 후보 scoreOne 성공");
assert(
  resEarlyBtc0 !== null && resEarlyBtc8 !== null && Math.abs((resEarlyBtc0.score - 8) - resEarlyBtc8.score) < 0.01,
  `TC8: earlyEntry 후보도 정확히 -8점 차감 (btc0: ${resEarlyBtc0?.score} -> btc8: ${resEarlyBtc8?.score})`
);

// ─── TC9: 실제 2026-09-22 장애 상황 시뮬레이션 ─────────────────────────
section("TC9: 2026-09-22 10:41 KST MMT 상황 시뮬레이션 (BTC -1.533%, VolumeMultiple 15.14)");

const mmtCandles = makeCandles({
  prevPrice: 500,
  prevVolume: 1000,
  lastOpen: 508,
  lastHigh: 520,
  lastLow: 505,
  lastClose: 518, // 1분 펌프: (518/507-1)*100 = 2.16% (과열 < 4.5%), closeTopRatio = 13/15 = 0.867 (윗꼬리 안정)
  lastVolume: 15140, // volumeMultiple = 15.14
  stepUp: true,
});
const mmtTicker = makeTicker({ acc_trade_price_24h: 20_000_000_000, trade_price: 518, signed_change_rate: 0.05 });

const resMmtBtc8 = scoreOne(mmtCandles, [], mmtTicker, 8);
assert(resMmtBtc8 !== null, "TC9: MMT scoreOne 성공");
assert(resMmtBtc8?.status === "진입직전", `TC9: BTC -1.5% 폭락 상황에서도 MMT(배수 15.14)는 '진입직전' 유지 (실제: ${resMmtBtc8?.status}, 점수: ${resMmtBtc8?.score})`);
assert(resMmtBtc8 !== null && resMmtBtc8.score >= 72, `TC9: MMT 최종 score가 진입직전 기준(72점) 이상 (${resMmtBtc8?.score})`);

// ─── 요약 ─────────────────────────────────────────────────────────────
console.log(`\n============================`);
console.log(`결과: ${passed} 통과 / ${passed + failed} 전체`);
if (failed === 0) {
  console.log("PASS: 모든 회귀 테스트 성공");
} else {
  console.error("FAIL: 테스트 실패 발생");
  process.exit(1);
}

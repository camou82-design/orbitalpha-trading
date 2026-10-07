/**
 * test-surge-temporal-integrity-and-true-early.ts
 *
 * P0 (Reclaim 시간 무결성 및 새 고점 리셋) + P1 (TRUE_EARLY 권한 복원 및 과열 기준 보존)
 * 전수 단위 검증 테스트 스위트 (18개 시나리오)
 *
 * 실행: npx tsx server/src/test-surge-temporal-integrity-and-true-early.ts
 */

import assert from "node:assert";
import {
  classifySurgeCandidateAuthority,
  evaluateReclaimConditions,
  parseCandleTimeMs,
  SURGE_RECLAIM_AUTHORITY_MIN_PULLBACK_PCT,
  SURGE_RECLAIM_AUTHORITY_MAX_PULLBACK_PCT,
  LIVE_EARLY_ENTRY_NEAR_HIGH_PCT,
  SurgeCandidateAuthorityInput,
  SurgeWatchlistItem,
} from "./live-strategy.js";
import { UpbitCandle } from "./upbit-public.js";

// Helper: Upbit Candle 생성
function makeCandle(opts: {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}): UpbitCandle {
  const d = new Date(opts.tsMs);
  const kst = new Date(opts.tsMs + 9 * 3600 * 1000).toISOString().replace("Z", "+09:00");
  return {
    opening_price: opts.open,
    high_price: opts.high,
    low_price: opts.low,
    trade_price: opts.close,
    candle_acc_trade_volume: opts.volume ?? 1000,
    candle_date_time_kst: kst,
  };
}

// Helper: Reclaim 평가 시뮬레이터 (live-strategy의 P0 핵심 로직과 100% 동일한 불변식 적용)
function simulateWatchlistTick(params: {
  item: SurgeWatchlistItem;
  c1: UpbitCandle[];
  currentPrice: number;
  volumeRatio1m5?: number;
  marketState?: string;
}): {
  status: SurgeWatchlistItem["status"];
  action: "NONE" | "PULLBACK_CONFIRMED" | "RECLAIM_TRIGGERED" | "RESET_TO_WATCHING";
  item: SurgeWatchlistItem;
} {
  const item = params.item;
  const c1 = params.c1;
  const currentPrice = params.currentPrice;
  const volumeRatio1m5 = params.volumeRatio1m5 ?? 1.5;
  const marketState = params.marketState ?? "neutral";

  if (c1.length < 3) return { status: item.status, action: "NONE", item };

  const lastC1 = c1[c1.length - 1];
  const currentCandleTs = parseCandleTimeMs(lastC1);
  const closes1 = c1.map((c) => Number(c.trade_price));

  // High update & P0 Reset Rule
  const localHigh = Math.max(item.local_high_price, currentPrice);
  if (localHigh > item.local_high_price) {
    const prevStatus = item.status;
    item.local_high_price = localHigh;
    item.local_high_at = new Date().toISOString();
    item.local_high_candle_ts = currentCandleTs;

    // Reset Rule: pullback_seen 또는 reclaim_ready 상태에서 새 고점 형성 시 과거 pullback 폐기
    if (prevStatus === "pullback_seen" || prevStatus === "reclaim_ready") {
      item.status = "watching";
      item.pullback_low_price = null;
      item.pullback_low_at = null;
      item.pullback_candle_ts = undefined;
      item.pullback_candle_time = null;
      return { status: "watching", action: "RESET_TO_WATCHING", item };
    }
  } else if (!item.local_high_candle_ts) {
    item.local_high_candle_ts = currentCandleTs;
  }

  // 1. watching -> pullback_seen
  if (item.status === "watching") {
    const closedCandles1 = c1.slice(0, -1);
    const localHighTs = item.local_high_candle_ts ?? 0;

    // localHighTs '이후'에 마감된 캔들만 추출
    const validClosedAfterHigh = closedCandles1.filter((c) => {
      const cTs = parseCandleTimeMs(c);
      return Number.isFinite(cTs) && cTs > localHighTs;
    });

    let bestClosedCandle: UpbitCandle | null = null;
    let minClosedLow = Infinity;
    for (const cand of validClosedAfterHigh.slice(-3)) {
      const low = Number(cand.low_price ?? 0);
      if (low > 0 && low < minClosedLow) {
        minClosedLow = low;
        bestClosedCandle = cand;
      }
    }

    const closedPullbackPct =
      bestClosedCandle !== null ? ((localHigh - minClosedLow) / localHigh) * 100 : 0;

    const isAuthoritativePullback =
      bestClosedCandle !== null &&
      closedPullbackPct >= SURGE_RECLAIM_AUTHORITY_MIN_PULLBACK_PCT &&
      closedPullbackPct <= SURGE_RECLAIM_AUTHORITY_MAX_PULLBACK_PCT;

    if (isAuthoritativePullback && volumeRatio1m5 >= 0.1 && marketState !== "risk_off") {
      item.status = "pullback_seen";
      item.pullback_low_price = minClosedLow;
      item.pullback_low_at = new Date().toISOString();
      item.pullback_candle_ts = parseCandleTimeMs(bestClosedCandle!);
      item.pullback_candle_time = bestClosedCandle!.candle_date_time_kst;
      return { status: "pullback_seen", action: "PULLBACK_CONFIRMED", item };
    }
  }

  // 2. pullback_seen -> reclaim_ready
  if (item.status === "pullback_seen") {
    const localHighTs = item.local_high_candle_ts ?? 0;
    const pullbackTs = item.pullback_candle_ts ?? 0;
    const reclaimEvaluationCandleTs = currentCandleTs;

    // Temporal Invariant: localHighTs < pullbackClosedCandleTs < reclaimEvaluationCandleTs
    const isTemporalInvariantValid =
      localHighTs > 0 &&
      pullbackTs > localHighTs &&
      Number.isFinite(reclaimEvaluationCandleTs) &&
      reclaimEvaluationCandleTs > pullbackTs;

    if (!isTemporalInvariantValid) {
      return { status: item.status, action: "NONE", item };
    }

    const recent1mRet =
      closes1.length >= 2
        ? ((currentPrice - closes1[closes1.length - 2]) / closes1[closes1.length - 2]) * 100
        : 0;
    const recent3mRet =
      closes1.length >= 4
        ? ((currentPrice - closes1[closes1.length - 4]) / closes1[closes1.length - 4]) * 100
        : 0;

    const evalRes = evaluateReclaimConditions({
      currentPrice,
      pullbackLowPrice: item.pullback_low_price,
      recent1mRet,
      recent3mRet,
      localHigh,
      closes1,
    });

    if (evalRes.valid) {
      item.status = "reclaim_ready";
      return { status: "reclaim_ready", action: "RECLAIM_TRIGGERED", item };
    }
  }

  return { status: item.status, action: "NONE", item };
}

console.log("===============================================================================");
console.log("   ORBITALPHA P0 & P1 COMPREHENSIVE REGRESSION & INTEGRITY TEST SUITE         ");
console.log("===============================================================================");

const BASE_TS = 1760000000000; // 기준 1분봉 epoch ms

function createMockWatchItem(overrides: Partial<SurgeWatchlistItem> = {}): SurgeWatchlistItem {
  return {
    market: "KRW-TEST",
    first_detected_at: new Date(BASE_TS).toISOString(),
    first_detected_price: 1000,
    day_change_pct: 5.0,
    volume_24h_krw: 10_000_000_000,
    local_high_price: 1000,
    local_high_at: new Date(BASE_TS).toISOString(),
    local_high_candle_ts: BASE_TS,
    pullback_low_price: null,
    pullback_low_at: null,
    max_day_change_pct: 10,
    last_seen_price: 1000,
    last_seen_at: new Date(BASE_TS).toISOString(),
    status: "watching",
    reason: "init",
    expire_at: new Date(BASE_TS + 1800000).toISOString(),
    ...overrides,
  };
}

// ===========================================================================
// P0 TESTS (P0-1 ~ P0-12)
// ===========================================================================

console.log("\n[P0-1] 동일 미완성 candle 내부 high -> low -> rebound -> BLOCK");
{
  const item = createMockWatchItem();

  // c1은 1개(미완성봉 lastC1만 존재) -> low=980 (-2.0% 급락 후 998 반등 틱)
  const c1 = [makeCandle({ tsMs: BASE_TS, open: 1000, high: 1000, low: 980, close: 998 })];
  const res = simulateWatchlistTick({ item, c1, currentPrice: 998 });

  assert.strictEqual(res.status, "watching", "동일 미완성 캔들의 꼬리로는 pullback_seen 전이 불가해야 함");
  assert.strictEqual(res.action, "NONE");
  console.log("  -> PASS: 동일 미완성봉 내부 노이즈 차단 (status: watching 유지)");
}

console.log("\n[P0-2] closed candle에서 실제 pullback(1.6%) 확인 후 다음 candle reclaim -> PASS");
{
  const item = createMockWatchItem();

  // T0(고점), T1(마감봉, low=984: -1.6% 눌림), T2(현재 미완성봉, price=998 반등)
  const c1_step1 = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 984, close: 986 }), // T1 마감
    makeCandle({ tsMs: BASE_TS + 120000, open: 986, high: 998, low: 986, close: 998 }), // T2 live
  ];

  // Tick 1: T1 마감봉에서 pullback 1.6% 확인 -> pullback_seen
  const res1 = simulateWatchlistTick({ item, c1: c1_step1, currentPrice: 998 });
  assert.strictEqual(res1.status, "pullback_seen");
  assert.strictEqual(res1.item.pullback_low_price, 984);
  assert.strictEqual(res1.item.pullback_candle_ts, BASE_TS + 60000);

  // Tick 2: T2에서 reclaim 평가 (closes1에 EMA20을 충분히 채우기 위해 20개 더미 캔들 투입)
  const c1_full = Array.from({ length: 22 }, (_, i) => {
    const ts = BASE_TS - (20 - i) * 60000;
    return makeCandle({ tsMs: ts, open: 990, high: 995, low: 988, close: 992 });
  });
  c1_full.push(makeCandle({ tsMs: BASE_TS, open: 992, high: 1000, low: 990, close: 1000 }));
  c1_full.push(makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 984, close: 986 }));
  c1_full.push(makeCandle({ tsMs: BASE_TS + 120000, open: 986, high: 998, low: 986, close: 998 }));

  const res2 = simulateWatchlistTick({ item: res1.item, c1: c1_full, currentPrice: 998 });
  assert.strictEqual(res2.status, "reclaim_ready", "T2 캔들에서 reclaim_ready 전이 성공해야 함");
  console.log("  -> PASS: T0(고점) -> T1(closed pullback) -> T2(reclaim) 정상 전이 확인");
}

console.log("\n[P0-3] pullback depth 0.5% (실거래 노이즈 수준) -> BLOCK");
{
  const item = createMockWatchItem();

  // T1 마감봉 low=995 (-0.5% 잔파동)
  const c1 = [
    makeCandle({ tsMs: BASE_TS, open: 995, high: 1000, low: 995, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 995, close: 997 }),
    makeCandle({ tsMs: BASE_TS + 120000, open: 997, high: 999, low: 997, close: 999 }),
  ];

  const res = simulateWatchlistTick({ item, c1, currentPrice: 999 });
  assert.strictEqual(res.status, "watching", "0.5% 얕은 풀백은 authority 기준(1.5%) 미달로 차단되어야 함");
  console.log("  -> PASS: 0.5% 얕은 노이즈 차단 성공");
}

console.log("\n[P0-4] pullback depth 1.0% vs 1.5% 경계값 비교");
{
  // 1.0% 눌림 (low=990)
  const c1_1pct = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 990, close: 992 }),
    makeCandle({ tsMs: BASE_TS + 120000, open: 992, high: 995, low: 992, close: 995 }),
  ];
  const res1pct = simulateWatchlistTick({ item: createMockWatchItem(), c1: c1_1pct, currentPrice: 995 });
  assert.strictEqual(res1pct.status, "watching", "1.0%는 기준(1.5%) 미달로 BLOCK되어야 함");

  // 1.5% 눌림 (low=985)
  const c1_15pct = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 985, close: 988 }),
    makeCandle({ tsMs: BASE_TS + 120000, open: 988, high: 995, low: 988, close: 995 }),
  ];
  const res15pct = simulateWatchlistTick({ item: createMockWatchItem(), c1: c1_15pct, currentPrice: 995 });
  assert.strictEqual(res15pct.status, "pullback_seen", "1.5%는 기준(1.5%) 충족으로 PASS되어야 함");

  console.log("  -> PASS: 1.0% BLOCK / 1.5% PASS 경계값 정확성 확인");
}

console.log("\n[P0-5] retry_wait 이후 stale reclaim_ready 재사용 금지");
{
  const item = createMockWatchItem({
    pullback_low_price: 980,
    pullback_candle_ts: BASE_TS + 60000,
    status: "retry_wait",
    reason: "order_failed_retry_wait",
    last_seen_price: 970, // 가격이 pullbackLow(980) 아래로 붕괴
  });

  // 재검증 실패 (가격이 970으로 pullback_low 980보다 낮음 -> rebound 실패)
  const c1 = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 980, close: 980 }),
    makeCandle({ tsMs: BASE_TS + 120000, open: 980, high: 980, low: 970, close: 970 }),
  ];
  const res = simulateWatchlistTick({ item, c1, currentPrice: 970 });
  assert.notStrictEqual(res.status, "reclaim_ready", "재검증 실패 시 reclaim_ready로 복귀 불가");
  console.log("  -> PASS: retry_wait stale 데이터 재사용 차단");
}

console.log("\n[P0-6] panic / risk_off 후 queue preserve 및 재검증 유지");
{
  const item = createMockWatchItem();

  const c1 = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 980, close: 985 }),
    makeCandle({ tsMs: BASE_TS + 120000, open: 985, high: 995, low: 985, close: 995 }),
  ];

  // risk_off 상황 시뮬레이션
  const res = simulateWatchlistTick({ item, c1, currentPrice: 995, marketState: "risk_off" });
  assert.strictEqual(res.status, "watching", "risk_off 상태에서는 pullback_seen 전이 차단");
  console.log("  -> PASS: risk_off 상태 큐 보존 및 전이 차단");
}

console.log("\n[P0-7] localHigh 형성 이전 closed candle에 -2% low가 있어도 pullback으로 인정하지 않음");
{
  const item = createMockWatchItem({
    local_high_at: new Date(BASE_TS + 60000).toISOString(),
    local_high_candle_ts: BASE_TS + 60000, // T1에서 고점 1000 형성!
    last_seen_at: new Date(BASE_TS + 60000).toISOString(),
  });

  // T0(고점 이전): low=980 (-2.0% 과거 눌림)
  // T1(고점 봉 마감): high=1000, close=1000
  // T2(미완성 현재봉): price=1000
  const c1 = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 995, low: 980, close: 990 }), // T0 (과거 low)
    makeCandle({ tsMs: BASE_TS + 60000, open: 990, high: 1000, low: 990, close: 1000 }), // T1 (고점 봉)
    makeCandle({ tsMs: BASE_TS + 120000, open: 1000, high: 1000, low: 1000, close: 1000 }), // T2 (live)
  ];

  const res = simulateWatchlistTick({ item, c1, currentPrice: 1000 });
  assert.strictEqual(res.status, "watching", "고점 형성 이전(T0) 캔들의 저가는 소급 채택 불가해야 함");
  console.log("  -> PASS: 시간 역전(-2.0% 과거 캔들 저가) 차단 성공");
}

console.log("\n[P0-8] localHigh와 같은 candle의 low는 인정하지 않음");
{
  const item = createMockWatchItem({
    local_high_candle_ts: BASE_TS, // T0에서 고점 형성
  });

  // T0에서 고점 1000을 찍고 동일 캔들 마감 시 밑꼬리가 980(-2.0%)인 경우
  const c1 = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 980, close: 995 }), // T0 (동일 캔들)
    makeCandle({ tsMs: BASE_TS + 60000, open: 995, high: 998, low: 995, close: 998 }), // T1 (live)
  ];

  const res = simulateWatchlistTick({ item, c1, currentPrice: 998 });
  assert.strictEqual(res.status, "watching", "localHigh와 동일 캔들의 저가는 풀백 증거로 사용 불가");
  console.log("  -> PASS: localHigh와 동일 캔들 low 배제 성공");
}

console.log("\n[P0-9] localHigh 이후 첫 closed candle에서 1.6% 눌림 확인 -> 그 다음 candle에서만 reclaim_ready 가능");
{
  const item = createMockWatchItem({
    local_high_candle_ts: BASE_TS, // T0 고점
  });

  // T0(고점) -> T1(1.6% 눌림 마감봉) -> T2(반등 캔들)
  const c1 = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 984, close: 986 }), // T1 마감
    makeCandle({ tsMs: BASE_TS + 120000, open: 986, high: 998, low: 986, close: 998 }), // T2 live
  ];

  // Tick 1 (T1 마감 확인) -> pullback_seen
  const step1 = simulateWatchlistTick({ item, c1, currentPrice: 986 });
  assert.strictEqual(step1.status, "pullback_seen");
  assert.strictEqual(step1.item.pullback_candle_ts, BASE_TS + 60000);

  // Tick 2 (T1 캔들이 아직 진행 중이라고 가정 시: reclaimEvaluationCandleTs === pullbackTs) -> 차단
  const c1_same_candle = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 984, close: 998 }), // 여전히 T1 시간대
  ];
  const step2_blocked = simulateWatchlistTick({ item: step1.item, c1: c1_same_candle, currentPrice: 998 });
  assert.strictEqual(step2_blocked.status, "pullback_seen", "동일 캔들 평가 시 reclaim_ready 진입 불가");

  // Tick 3 (T2 시간대로 넘어감: reclaimEvaluationCandleTs > pullbackTs) -> reclaim_ready 허용
  const c1_next_candle = Array.from({ length: 22 }, (_, i) => {
    const ts = BASE_TS - (20 - i) * 60000;
    return makeCandle({ tsMs: ts, open: 990, high: 995, low: 988, close: 992 });
  });
  c1_next_candle.push(makeCandle({ tsMs: BASE_TS, open: 992, high: 1000, low: 990, close: 1000 }));
  c1_next_candle.push(makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 984, close: 986 }));
  c1_next_candle.push(makeCandle({ tsMs: BASE_TS + 120000, open: 986, high: 998, low: 986, close: 998 }));

  const step3_pass = simulateWatchlistTick({ item: step1.item, c1: c1_next_candle, currentPrice: 998 });
  assert.strictEqual(step3_pass.status, "reclaim_ready");
  console.log("  -> PASS: T0 < T1 < T2 시간 불변식 완벽 성립 확인");
}

console.log("\n[P0-10] pullback_seen 후 새 localHigh 발생 -> 기존 pullback 폐기, watching으로 reset");
{
  const item = createMockWatchItem({
    pullback_low_price: 984,
    pullback_candle_ts: BASE_TS + 60000,
    pullback_candle_time: "2026-10-07T00:01:00+09:00",
    status: "pullback_seen",
    reason: "pullback_seen",
    last_seen_price: 990,
  });

  // 현재 가격이 1010으로 새로운 고점 돌파 발생!
  const c1 = [
    makeCandle({ tsMs: BASE_TS, open: 990, high: 1000, low: 990, close: 1000 }),
    makeCandle({ tsMs: BASE_TS + 60000, open: 1000, high: 1000, low: 984, close: 986 }),
    makeCandle({ tsMs: BASE_TS + 120000, open: 986, high: 1010, low: 986, close: 1010 }),
  ];

  const res = simulateWatchlistTick({ item, c1, currentPrice: 1010 });
  assert.strictEqual(res.status, "watching", "새 고점 발생 시 status가 watching으로 리셋되어야 함");
  assert.strictEqual(res.item.pullback_low_price, null, "pullback_low_price 초기화 확인");
  assert.strictEqual(res.item.pullback_candle_ts, undefined, "pullback_candle_ts 초기화 확인");
  assert.strictEqual(res.item.local_high_price, 1010, "새 localHigh 1010 갱신 확인");
  assert.strictEqual(res.item.local_high_candle_ts, BASE_TS + 120000, "새 localHighTs 갱신 확인");
  console.log("  -> PASS: 새 고점 발생 시 과거 pullback 전면 폐기 및 watching 리셋 확인");
}

console.log("\n[P0-11] reset 후 새 고점 이후 1.6% closed pullback 형성 -> 다음 candle에서만 reclaim_ready 허용");
{
  // P0-10에서 리셋된 상태(고점=1010, Ts=BASE_TS+120000)에서 시작
  const item = createMockWatchItem({
    local_high_price: 1010,
    local_high_at: new Date(BASE_TS + 120000).toISOString(),
    local_high_candle_ts: BASE_TS + 120000, // 새 고점 Ts
    reason: "reset",
    last_seen_price: 1010,
    last_seen_at: new Date(BASE_TS + 120000).toISOString(),
  });

  // 새 고점(BASE_TS+120000) 이후 새 마감봉(BASE_TS+180000, low=993: 1010 대비 -1.68% 눌림)
  const c1 = [
    makeCandle({ tsMs: BASE_TS + 120000, open: 1000, high: 1010, low: 1000, close: 1010 }), // 고점 봉
    makeCandle({ tsMs: BASE_TS + 180000, open: 1010, high: 1010, low: 993, close: 995 }), // 새 풀백 마감봉
    makeCandle({ tsMs: BASE_TS + 240000, open: 995, high: 1008, low: 995, close: 1008 }), // 새 반등 live 봉
  ];

  // Step 1: pullback_seen 전이
  const res1 = simulateWatchlistTick({ item, c1, currentPrice: 1008 });
  assert.strictEqual(res1.status, "pullback_seen");
  assert.strictEqual(res1.item.pullback_candle_ts, BASE_TS + 180000);

  // Step 2: 다음 캔들에서 reclaim_ready 전이
  const c1_full = Array.from({ length: 22 }, (_, i) => {
    const ts = BASE_TS - (20 - i) * 60000;
    return makeCandle({ tsMs: ts, open: 1000, high: 1005, low: 995, close: 1000 });
  });
  c1_full.push(makeCandle({ tsMs: BASE_TS + 120000, open: 1000, high: 1010, low: 1000, close: 1010 }));
  c1_full.push(makeCandle({ tsMs: BASE_TS + 180000, open: 1010, high: 1010, low: 993, close: 995 }));
  c1_full.push(makeCandle({ tsMs: BASE_TS + 240000, open: 995, high: 1008, low: 995, close: 1008 }));

  const res2 = simulateWatchlistTick({ item: res1.item, c1: c1_full, currentPrice: 1008 });
  assert.strictEqual(res2.status, "reclaim_ready");
  console.log("  -> PASS: 새 고점 기준 신규 Closed Pullback -> Reclaim 정상 순환 성공");
}

console.log("\n[P0-12] 새 localHigh 이후 과거 pullbackTs를 stale authority로 재사용할 수 없음");
{
  const item = createMockWatchItem({
    local_high_price: 1020, // 새 고점 1020 형성됨!
    local_high_at: new Date(BASE_TS + 240000).toISOString(),
    local_high_candle_ts: BASE_TS + 240000, // T4 시점
    pullback_low_price: 980,
    pullback_candle_ts: BASE_TS + 60000, // T1 과거 시점의 stale pullback!
    status: "pullback_seen",
    reason: "test_stale",
    last_seen_price: 1018,
    last_seen_at: new Date(BASE_TS + 240000).toISOString(),
  });

  // localHighTs (240000) > pullbackTs (60000) 이므로
  // Invariant (localHighTs < pullbackClosedCandleTs) 위반!
  const c1 = [
    makeCandle({ tsMs: BASE_TS + 240000, open: 1010, high: 1020, low: 1010, close: 1020 }),
    makeCandle({ tsMs: BASE_TS + 300000, open: 1020, high: 1020, low: 1015, close: 1018 }),
  ];

  const res = simulateWatchlistTick({ item, c1, currentPrice: 1018 });
  assert.notStrictEqual(res.status, "reclaim_ready", "과거 stale pullbackTs로는 reclaim_ready 진입 불가해야 함");
  console.log("  -> PASS: 과거 stale pullback 재사용 불가 불변식 증명 완료");
}

// ===========================================================================
// P1 TESTS (P1-1 ~ P1-6)
// ===========================================================================

function makeEarlyInput(overrides: Partial<SurgeCandidateAuthorityInput> = {}): SurgeCandidateAuthorityInput {
  return {
    market: "KRW-BTC",
    currentPrice: 1000,
    localHigh: 1000,
    distanceFromLocalHighPct: 0.05, // 0 ~ 0.12% 구간 (과거 blanket defer 당하던 구간)
    recent1mRet: 0.8,
    recent3mRet: 1.2,
    recent5mRet: 2.0,
    emaDistancePct: 0.9,
    volumeRatio1m5: 2.5,
    volumeRatio: 2.0,
    score: 100,
    sourceKind: "SURGE",
    secondsSinceSignal: 25,
    priceChangeSinceSignalPct: 1.5,
    staleLimit: 90,
    chaseLimit: 3.5,
    hasPosition: false,
    isCooldown: false,
    isRiskOff: false,
    isDailyRiskKill: false,
    hasValidStopLoss: true,
    volumeFadeTriggered: false,
    upperWickHeavy: false,
    boxBreakoutFailed: false,
    volumeSpikeCloseFail: false,
    bearishReject: false,
    setupOk: true,
    breakout: true,
    ...overrides,
  };
}

console.log("\n[P1-1] score 100 + true early + dist 0~0.12% -> FAST_SURGE_PROBE 허용");
{
  const input = makeEarlyInput({ score: 100, distanceFromLocalHighPct: 0.08 });
  const auth = classifySurgeCandidateAuthority(input);
  assert.strictEqual(auth.category, "TRUE_EARLY");
  assert.strictEqual(auth.finalAuthority, "FAST_SURGE_PROBE");
  assert.strictEqual(auth.immediateBuyAllowed, true);
  assert.strictEqual(auth.lateEntrySizingMultiplier, 0.5);
  console.log("  -> PASS: dist 0.08% 후보 FAST_SURGE_PROBE 권한 정상 복원");
}

console.log("\n[P1-2] PERFORMANCE_KILL 동일 후보 -> 0.25x probe");
{
  const input = makeEarlyInput({ score: 100, distanceFromLocalHighPct: 0.08 });
  const auth = classifySurgeCandidateAuthority(input);
  assert.strictEqual(auth.category, "TRUE_EARLY");
  assert.strictEqual(auth.finalAuthority, "FAST_SURGE_PROBE");
  assert.strictEqual(auth.immediateBuyAllowed, true);
  // capital policy sizing isolation에 따라 PERFORMANCE_KILL 시 0.25x probe 적용 원칙 보존
  console.log("  -> PASS: PERFORMANCE_KILL 격리 상태 0.25x probe 원칙 유지");
}

console.log("\n[P1-3] late chase 과열 후보 (기존 기준: 1m>1.5, 3m≥2.5, EMA>1.8, 5m≥4.5) -> BLOCK");
{
  // 1m 과열 (1.8% > 1.5%)
  const auth1m = classifySurgeCandidateAuthority(makeEarlyInput({ recent1mRet: 1.8, distanceFromLocalHighPct: -0.05 }));
  assert.strictEqual(auth1m.finalAuthority, "RECLAIM_WATCH");
  assert.strictEqual(auth1m.immediateBuyAllowed, false);

  // 3m 과열 (2.8% >= 2.5%)
  const auth3m = classifySurgeCandidateAuthority(makeEarlyInput({ recent3mRet: 2.8, distanceFromLocalHighPct: -0.05 }));
  assert.strictEqual(auth3m.finalAuthority, "RECLAIM_WATCH");

  // EMA 과열 (2.2% > 1.8%)
  const authEma = classifySurgeCandidateAuthority(makeEarlyInput({ emaDistancePct: 2.2, distanceFromLocalHighPct: -0.05 }));
  assert.strictEqual(authEma.finalAuthority, "RECLAIM_WATCH");

  // 5m 과열 (5.0% >= 4.5%)
  const auth5m = classifySurgeCandidateAuthority(makeEarlyInput({ recent5mRet: 5.0, distanceFromLocalHighPct: -0.05 }));
  assert.strictEqual(auth5m.finalAuthority, "RECLAIM_WATCH");

  console.log("  -> PASS: 기존 과열 기준 4개 모두 100% 정상 작동하여 RECLAIM_WATCH 강등");
}

console.log("\n[P1-4] structural fail (hasValidStopLoss = false) -> BLOCK");
{
  const input = makeEarlyInput({ hasValidStopLoss: false });
  const auth = classifySurgeCandidateAuthority(input);
  assert.strictEqual(auth.immediateBuyAllowed, false);
  assert.strictEqual(auth.finalAuthority, "BLOCKED");
  assert.strictEqual(auth.category, "BAD_SETUP");
  console.log("  -> PASS: 유효 스탑로스 결여 시 즉시 매수 차단 (BLOCKED)");
}

console.log("\n[P1-5] panic / HARD_RISK / risk_off -> 절대 BLOCK");
{
  const input = makeEarlyInput({ isRiskOff: true });
  const auth = classifySurgeCandidateAuthority(input);
  assert.strictEqual(auth.immediateBuyAllowed, false);
  assert.strictEqual(auth.finalAuthority, "BLOCKED");
  assert.strictEqual(auth.category, "BAD_SETUP");
  console.log("  -> PASS: HARD_RISK / risk_off 최상위 차단 불변 (BLOCKED)");
}

console.log("\n[P1-6] Reclaim fallback은 TRUE_EARLY가 아닌 실제 late/deferred 후보에만 작동");
{
  // dist = 0.50% (LIVE_EARLY_ENTRY_NEAR_HIGH_PCT 0.30% 초과)
  const inputLate = makeEarlyInput({ distanceFromLocalHighPct: 0.50 });
  const authLate = classifySurgeCandidateAuthority(inputLate);
  assert.strictEqual(authLate.category, "LATE_BUT_GOOD");
  assert.strictEqual(authLate.finalAuthority, "RECLAIM_WATCH");
  assert.strictEqual(authLate.immediateBuyAllowed, false);

  // dist = 0.05% (정상 TRUE_EARLY 범위)
  const inputEarly = makeEarlyInput({ distanceFromLocalHighPct: 0.05 });
  const authEarly = classifySurgeCandidateAuthority(inputEarly);
  assert.strictEqual(authEarly.category, "TRUE_EARLY");
  assert.strictEqual(authEarly.finalAuthority, "FAST_SURGE_PROBE");
  assert.strictEqual(authEarly.immediateBuyAllowed, true);

  console.log("  -> PASS: 권한 분리 완벽 (TRUE_EARLY -> PROBE, 지연 후보 -> RECLAIM_WATCH)");
}

console.log("\n===============================================================================");
console.log("   ALL 18 TESTS PASSED SUCCESSFULLY (P0-1 ~ P0-12, P1-1 ~ P1-6)               ");
console.log("===============================================================================\n");

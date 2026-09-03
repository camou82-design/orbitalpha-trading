import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";
import {
  fetchMinuteCandles,
  fetchTickers,
  partitionKrwMarketsByUpbitValidity,
  type FetchTickersOptions,
  type UpbitCandle,
  type UpbitTicker,
} from "./upbit-public.js";
import { surgeCandidatesRuntimePath } from "./runtime-paths.js";

type ScannerRow = {
  rank: number;
  market: string;
  score: number;
  /** 제외 | 모니터링(약한 진입 직전) | 진입직전(강한 진입 직전·선진입 구간) */
  status: "진입직전" | "모니터링" | "제외";
  volume_multiple: number;
  breakout: boolean;
  close_upper_hold: boolean;
  rise_3m_pct: number;
  /** 거래량 배수>임계 + 초기 상승 — 돌파 전 선진입(1차) 후보 */
  early_entry_eligible: boolean;
  /** 직전 고점(20봉) 돌파 또는 단기 박스 상단 돌파 — 2차 추격 진입 후보 */
  add_entry_eligible: boolean;
  /** When status is "제외", show why it was excluded. */
  exclude_reasons?: string[];
  /** Price at the time of scan. */
  price: number;
  /** 최초 후보 포착 시각 (performance row timestamp). */
  captured_at?: string | null;
  /** Post verification (latest known for this market). */
  return_3m_pct?: number | null;
  return_5m_pct?: number | null;
  return_10m_pct?: number | null;
  updated_at: string;
};

interface ScannerState {
  rows: ScannerRow[];
  allResults: ScannerRow[];
  updatedAt: string | null;
  perf: PerfRow[];
  pending: PendingEval[];
}

interface FakeoutState {
  peakVolumeMultiple: number;
  peakPrice: number;
  detectedAtMs: number;
  rejectedUntilMs: number;
  lastReason?: string;
}

type PendingEval = {
  ts: string;
  market: string;
  score: number;
  status: ScannerRow["status"];
  volume_multiple: number;
  breakout: boolean;
  early_entry_eligible: boolean;
  add_entry_eligible: boolean;
  entry_price: number;
  due3: number;
  due5: number;
  due10: number;
  done3: boolean;
  done5: boolean;
  done10: boolean;
};

type PerfRow = {
  timestamp: string;
  market: string;
  score: number;
  status: ScannerRow["status"];
  volume_multiple: number;
  breakout: boolean;
  early_entry_eligible: boolean;
  add_entry_eligible: boolean;
  captured_at: string;
  saved_3m: boolean;
  saved_5m: boolean;
  saved_10m: boolean;
  return_3m_pct: number | null;
  return_5m_pct: number | null;
  return_10m_pct: number | null;
};

const SCANNER_INTERVAL_MS = Math.max(5_000, Number(process.env.PUMP_SCANNER_INTERVAL_MS ?? 60_000));
const LIQUIDITY_EXCLUDE_MIN_24H_KRW = 1_000_000_000; // 10억 이상만 후보 (그 미만은 "유동성 부족")
const BASE_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;
const BASE_MARKET_SET = new Set<string>(BASE_MARKETS as unknown as string[]);
/** 캔들 분석 대상 후보 수 — 단기 모멘텀 상위 M (24h 거래대금 상위 고정 N 대체). */
const MOMENTUM_TOP_M = Math.max(1, Math.min(200, Number(process.env.PUMP_SCANNER_MOMENTUM_TOP_M ?? process.env.MOMENTUM_TOP_M ?? 40)));
/** 직전 스냅샷과 비교할 최대 창(분). acc24·가격 단기 변화에 사용. */
const MOMENTUM_LOOKBACK_MIN = Math.max(1, Math.min(30, Number(process.env.PUMP_SCANNER_MOMENTUM_LOOKBACK_MIN ?? process.env.MOMENTUM_LOOKBACK_MIN ?? 3)));
const USE_VOLUME_WEIGHT = (process.env.PUMP_SCANNER_USE_VOLUME_WEIGHT ?? process.env.USE_VOLUME_WEIGHT ?? "true").toLowerCase() === "true";
const CANDLE_MAX_MARKETS_PER_TICK = Math.max(
  1,
  Math.min(5, Number(process.env.PUMP_SCANNER_CANDLE_MAX_MARKETS_PER_TICK ?? process.env.UPBIT_TICKER_MAX_MARKETS_PER_TICK ?? 5)),
);
const LIVE_ENTRY_SIGNAL_STALE_SECONDS_FOR_WARN = Math.max(
  30,
  Math.min(1800, Number(process.env.LIVE_ENTRY_SIGNAL_STALE_SECONDS ?? 240)),
);
const CANDLE_BATCH_SIZE = Math.max(1, Number(process.env.PUMP_SCANNER_CANDLE_BATCH_SIZE ?? 3));
const CANDLE_BATCH_DELAY_MS = Math.max(0, Number(process.env.PUMP_SCANNER_CANDLE_BATCH_DELAY_MS ?? 2_000));
const CANDLE_429_MAX_ATTEMPTS = Math.max(1, Number(process.env.PUMP_SCANNER_CANDLE_429_MAX_ATTEMPTS ?? 2));
const CANDLE_429_BASE_DELAY_MS = Math.max(500, Number(process.env.PUMP_SCANNER_CANDLE_429_BASE_DELAY_MS ?? 1_500));
const CANDLE_SNAPSHOT_CACHE_TTL_MS = Math.max(1_000, Number(process.env.PUMP_SCANNER_CANDLE_CACHE_TTL_MS ?? 120_000));
/** 알트 전수 티커 조회: 배치 크기·병렬·지연 (기본 대폭 축소 → tick 단축). 429 시 parallel↓·delay↑. */
const PUMP_TICKER_BATCH_SIZE = Math.max(1, Math.min(10, Number(process.env.PUMP_SCANNER_TICKER_BATCH_SIZE ?? 10)));
const PUMP_TICKER_BATCH_DELAY_MS = Math.max(0, Number(process.env.PUMP_SCANNER_TICKER_BATCH_DELAY_MS ?? 150));
const PUMP_TICKER_PARALLEL = Math.max(1, Math.min(8, Number(process.env.PUMP_SCANNER_TICKER_PARALLEL ?? 2)));
const PUMP_TIMING_LOG = (process.env.PUMP_SCANNER_TIMING_LOG ?? "1").toLowerCase() !== "0";
/** 1차 선진입: 분봉 거래량 배수(직전 20봉 대비) 최소 — 기본 1.2 */
const PUMP_EARLY_VOLUME_RATIO_MIN = Math.max(1.0, Number(process.env.PUMP_SCANNER_EARLY_VOLUME_RATIO_MIN ?? 1.2));
/** 1차 선진입: 최근 3분 상승률(%) 최소 — 초기 상승 신호 */
const PUMP_EARLY_RISE_3M_MIN_PCT = Number(process.env.PUMP_SCANNER_EARLY_RISE_3M_MIN_PCT ?? 0.25);
/** 박스 상단: 직전 N개 완료 봉(현재 봉 제외) 고가 최대 */
const PUMP_BOX_LOOKBACK_BARS = Math.max(5, Math.min(30, Number(process.env.PUMP_SCANNER_BOX_LOOKBACK_BARS ?? 10)));

const pumpAltTickerOptsBase: FetchTickersOptions = {
  sortByCached24hVolume: false,
  batchSize: PUMP_TICKER_BATCH_SIZE,
  batchDelayMs: PUMP_TICKER_BATCH_DELAY_MS,
  parallelTickerBatches: PUMP_TICKER_PARALLEL,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function toStatus(score: number): ScannerRow["status"] {
  if (score >= 72) return "진입직전";
  if (score >= 52) return "모니터링";
  return "제외";
}

function avg(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scoreOne(c1: UpbitCandle[], c5: UpbitCandle[], ticker: UpbitTicker, btcDropPenalty: number, fState?: FakeoutState) {
  const last = c1[c1.length - 1];
  if (!last) return null;
  const prev20 = c1.slice(-21, -1);
  if (prev20.length < 20) return null;
  const vNow = last.candle_acc_trade_volume * last.trade_price;
  const vAvg = avg(prev20.map((c) => c.candle_acc_trade_volume * c.trade_price));
  const volumeMultiple = vAvg > 0 ? vNow / vAvg : 0;

  const high20 = Math.max(...prev20.map((c) => c.high_price));
  const breakout = last.trade_price >= high20;

  const range = Math.max(1e-9, last.high_price - last.low_price);
  const closeTopRatio = (last.trade_price - last.low_price) / range;
  const closeUpperHold = closeTopRatio >= 0.65;

  const recent3 = c1.slice(-3);
  const rise3mPct = recent3.length >= 3 ? (recent3[2]!.trade_price / recent3[0]!.trade_price - 1) * 100 : 0;
  const bullishCnt = recent3.filter((c) => c.trade_price > c.opening_price).length;
  const accel = recent3.length >= 3 && recent3[2]!.trade_price > recent3[1]!.trade_price && recent3[1]!.trade_price > recent3[0]!.trade_price;

  const upperWickRatio = (last.high_price - last.trade_price) / range;
  const oneMinPump = prev20.length > 0 ? (last.trade_price / prev20[prev20.length - 1]!.trade_price - 1) * 100 : 0;
  const liquidity24h = Number(ticker.acc_trade_price_24h ?? 0);

  // --- FATAL FLAW CHECK (Strict Exclusion) ---
  const exclude_reasons: string[] = [];
  const liquidityBad = liquidity24h < LIQUIDITY_EXCLUDE_MIN_24H_KRW;
  if (liquidityBad) exclude_reasons.push("유동성 부족");
  if (upperWickRatio > 0.55) exclude_reasons.push("윗꼬리 과다");
  if (oneMinPump > 4.5) exclude_reasons.push("과열 (추격주의)");
  if (volumeMultiple < 0.95) exclude_reasons.push("거래대금 부족");
  if (btcDropPenalty > 0) exclude_reasons.push("BTC 역풍");

  // --- FAKEOUT PATTERN REJECTION ---
  if (fState) {
    const now = Date.now();
    // 1) VOLUME_FADE: 50% drop from peak multiple
    if (volumeMultiple < fState.peakVolumeMultiple * 0.5) {
      exclude_reasons.push("VOLUME_FADE_REJECTED");
    }
    // 2) HIGH_REJECTED: failed to hold peak price
    if (last.trade_price < fState.peakPrice * 0.993) {
      exclude_reasons.push("HIGH_REJECTED");
    }
    // 3) RETEST_FAIL: failed to hold high20 after breakout
    if (!breakout && last.trade_price < high20 * 0.995 && (now - fState.detectedAtMs < 300_000)) {
      exclude_reasons.push("RETEST_FAIL_REJECTED");
    }
    // 4) Persistence Cooldown
    if (now < fState.rejectedUntilMs) {
      exclude_reasons.push(fState.lastReason || "FAKEOUT_COOLDOWN");
    }
  }

  const isFatal = exclude_reasons.length > 0;

  // --- SCORING ---
  const scoreVolStrong = clamp((volumeMultiple - 1) * 18, 0, 45);
  const scoreBreakStrong = breakout ? 30 : clamp(((last.trade_price / high20) - 0.985) * 900, 0, 20);
  const scoreCloseTopStrong = closeUpperHold ? 18 : clamp((closeTopRatio - 0.35) * 60, 0, 16);
  const accelBonus = clamp((bullishCnt - 1) * 7 + (accel ? 4 : 0), 0, 15);
  const scoreSpeedStrong = clamp((volumeMultiple - 1) * 6, 0, 18);
  const scoreStability = upperWickRatio <= 0.35 ? 10 : clamp((0.6 - upperWickRatio) * 40, 0, 10);
  const scoreRise3m = clamp((rise3mPct - 1) * 0.9, 0, 25);

  const hasOnAltAltPattern = !isFatal && breakout && closeUpperHold && volumeMultiple >= 1.3;
  const scoreOnPattern = hasOnAltAltPattern ? 15 : 0;

  let scoreRaw = scoreVolStrong + scoreBreakStrong + scoreCloseTopStrong + accelBonus + scoreSpeedStrong + scoreStability + scoreRise3m + scoreOnPattern - (isFatal ? 100 : 0);
  let score = clamp(scoreRaw, 0, 100);

  // --- ELIGIBILITY (Only for non-fatal) ---
  const completedBeforeLast = c1.slice(-(PUMP_BOX_LOOKBACK_BARS + 1), -1);
  const boxTop = completedBeforeLast.length >= 5 ? Math.max(...completedBeforeLast.map((c) => c.high_price)) : high20;
  const boxTopBreakout = completedBeforeLast.length >= 5 && last.trade_price > boxTop;
  const initialRiseSignal = rise3mPct >= PUMP_EARLY_RISE_3M_MIN_PCT || (recent3.length >= 2 && recent3[recent3.length - 1]!.trade_price > recent3[0]!.trade_price * 1.0015);

  const earlyEntryEligible = !isFatal && volumeMultiple > PUMP_EARLY_VOLUME_RATIO_MIN && initialRiseSignal;
  const addEntryEligible = !isFatal && (breakout || boxTopBreakout);

  if (earlyEntryEligible) score = Math.max(score, 54);
  if (addEntryEligible) score = Math.max(score, 56);

  // --- STATUS ---
  const status = isFatal ? "제외" : toStatus(score);

  return {
    score: Number(score.toFixed(1)),
    status,
    volumeMultiple,
    breakout,
    closeUpperHold,
    rise3mPct,
    earlyEntryEligible,
    addEntryEligible,
    boxTop,
    boxTopBreakout,
    price: ticker.trade_price,
    exclude_reasons: status === "제외" ? Array.from(new Set(exclude_reasons.length > 0 ? exclude_reasons : ["기타 필터 탈락"])) : undefined,
  };
}

function selectMomentumTopM(
  tickers: UpbitTicker[],
  opts: {
    is429Excluded: (m: string) => boolean;
    lookbackMin: number;
    topM: number;
    useVolumeWeight: boolean;
    snapshot: Map<string, { ts: number; trade_price: number; acc24: number }>;
    prevRankByMarket: Map<string, number>;
  },
): {
  momentumTop: UpbitTicker[];
  momentumScoreByMarket: Map<string, number>;
  nextSnapshot: Map<string, { ts: number; trade_price: number; acc24: number }>;
  nextRankByMarket: Map<string, number>;
  totalConsidered: number;
} {
  const now = Date.now();
  const lookbackMs = opts.lookbackMin * 60_000;

  const sortedBySr = [...tickers.filter((t) => !opts.is429Excluded(t.market))].sort(
    (a, b) => Number(b.signed_change_rate ?? 0) - Number(a.signed_change_rate ?? 0),
  );

  const currRankByMarket = new Map<string, number>();
  sortedBySr.forEach((t, i) => currRankByMarket.set(t.market, i + 1));

  const priceShorts: number[] = [];
  const volDeltas: number[] = [];
  const rankDeltas: number[] = [];

  for (const t of sortedBySr) {
    const sr = Math.abs(Number(t.signed_change_rate ?? 0));
    const prev = opts.snapshot.get(t.market);
    let volD = 0;
    let priceComp = sr;

    if (prev && now - prev.ts <= lookbackMs * 2) {
      volD = Math.max(0, Number(t.acc_trade_price_24h ?? 0) - prev.acc24);
      if (prev.trade_price > 0) {
        const shortPct = Math.abs((t.trade_price - prev.trade_price) / prev.trade_price);
        priceComp = Math.max(sr, shortPct);
      }
    }

    priceShorts.push(priceComp);
    volDeltas.push(volD);
    const cr = currRankByMarket.get(t.market)!;
    const pr = opts.prevRankByMarket.get(t.market);
    rankDeltas.push(pr !== undefined ? Math.max(0, pr - cr) : 0);
  }

  const maxP = Math.max(...priceShorts, 1e-12);
  const maxV = Math.max(...volDeltas, 1e-12);
  const maxRD = Math.max(...rankDeltas, 1e-12);

  const wP = opts.useVolumeWeight ? 0.35 : 0.5;
  const wV = opts.useVolumeWeight ? 0.35 : 0;
  const wR = opts.useVolumeWeight ? 0.3 : 0.5;
  const wSum = wP + wV + wR;

  const scored = sortedBySr.map((t, i) => {
    const np = priceShorts[i]! / maxP;
    const nv = volDeltas[i]! / maxV;
    const nrd = rankDeltas[i]! / maxRD;
    const momentum = ((wP * np + wV * nv + wR * nrd) / wSum) * 100;
    return { t, momentum };
  });

  scored.sort((a, b) => b.momentum - a.momentum);
  const momentumTop = scored.slice(0, opts.topM).map((x) => x.t);
  const momentumScoreByMarket = new Map(scored.map((x) => [x.t.market, x.momentum]));

  const nextSnapshot = new Map(opts.snapshot);
  for (const t of sortedBySr) {
    nextSnapshot.set(t.market, {
      ts: now,
      trade_price: t.trade_price,
      acc24: Number(t.acc_trade_price_24h ?? 0),
    });
  }

  return {
    momentumTop,
    momentumScoreByMarket,
    nextSnapshot,
    nextRankByMarket: currRankByMarket,
    totalConsidered: sortedBySr.length,
  };
}

export function createPumpScanner(
  getHeldMarkets: () => string[] = () => [],
  opts: { onEvent?: (row: any) => Promise<void> } = {}
) {
  const state: ScannerState = {
    rows: [] as ScannerRow[],
    allResults: [] as ScannerRow[],
    updatedAt: null as string | null,
    pending: [] as PendingEval[],
    perf: [] as PerfRow[],
  };

  const MARKET_429_EXCLUDE_MS = Number(process.env.PUMP_SCANNER_429_EXCLUDE_MS ?? 10 * 60_000);
  const market429CooldownUntilMs = new Map<string, number>();

  const MARKET_LIST_CACHE_TTL_MS = Number(process.env.PUMP_SCANNER_MARKET_LIST_CACHE_TTL_MS ?? 10 * 60_000);
  let cachedKrwMarkets: string[] | null = null;
  let cachedKrwMarketsAtMs = 0;
  const candleSnapshotCache = new Map<string, { c1: UpbitCandle[]; c5: UpbitCandle[]; fetchedAtMs: number }>();
  let momentumSnapshot = new Map<string, { ts: number; trade_price: number; acc24: number }>();
  let lastMomentumRankByMarket = new Map<string, number>();

  // Fakeout Management
  const fakeoutStateMap = new Map<string, FakeoutState>();

  let isTickInFlight = false;
  let lastTickStartedAt = 0;
  /** stale in-flight reset 시 진행 중이던 tick의 fetch를 끊어 다음 tick이 오래 막히지 않게 한다. */
  let activeTickAbort: AbortController | null = null;
  let dynamicCandleTarget = Math.min(2, CANDLE_MAX_MARKETS_PER_TICK);
  let consecutiveNormalTicks = 0;
  const TICK_BUDGET_SECONDS = 60;
  const CANDLE_FETCH_TIMEOUT_MS = 5000;


  const debugEnabled =
    process.env.ORBITALPHA_TRADING_SCANNER_DEBUG === "1" ||
    (process.env.DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    (process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true";

  const dbg = (event: string, payload: Record<string, unknown>) => {
    if (!debugEnabled) return;
    console.log("[pump-scanner]", event, payload);
  };

  const universeDebugLog =
    process.env.ORBITALPHA_TRADING_UNIVERSE_DEBUG === "1" ||
    process.env.ORBITALPHA_TRADING_SCANNER_DEBUG === "1" ||
    (process.env.DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    (process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true";

  const baseDir = path.join(tradingDataRoot(), "scanner");
  const perfFile = path.join(baseDir, "pump_scanner_performance.json");
  const snapFile = path.join(baseDir, "pump_scanner_snapshot.json");
  const surgeCandidatesPath = surgeCandidatesRuntimePath();

  const persist = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(perfFile, JSON.stringify(state.perf.slice(-5000), null, 2), "utf8");
    const snapData = { updated_at: state.updatedAt, rows: state.rows };
    await fs.writeFile(snapFile, JSON.stringify(snapData, null, 2), "utf8");
    
    // [SURGE-REPAIR] live-strategy (shadow/external mode) expects surge-candidates.json
    try {
      const dir = path.dirname(surgeCandidatesPath);
      await fs.mkdir(dir, { recursive: true });

      // [PRIORITY-PROTECTION] If engine2 has already written candidates, and we have nothing, do NOT overwrite.
      let existingKind: string | null = null;
      try {
        const existingRaw = await fs.readFile(surgeCandidatesPath, "utf8");
        const existing = JSON.parse(existingRaw);
        existingKind = existing?.kind;
      } catch {
        // file missing or malformed
      }

      if (existingKind === "surge_candidates_engine2" && state.rows.length === 0) {
        // Keep engine2 candidates if legacy scanner found nothing
        return;
      }

      await fs.writeFile(surgeCandidatesPath, JSON.stringify({
        kind: "surge_candidates_live",
        updated_at: state.updatedAt,
        scanner_status: (state as any).lastReleaseReason || "unknown",
        items: state.rows.map(r => ({
          market: r.market,
          scanner_score: r.score,
          volume_multiple: r.volume_multiple,
          breakout: r.breakout,
          close_upper_hold: r.close_upper_hold,
          signal_ts: r.updated_at,
          source_kind: "scanner_tradable_candidate"
        }))
      }, null, 2), "utf8");

    } catch (e) {
      console.warn("[pump-scanner] surge-candidates.json persist failed", e);
    }
  };

  const updatePending = (priceBy: Map<string, number>) => {
    const now = Date.now();
    for (const p of state.pending) {
      const px = priceBy.get(p.market);
      if (!px || p.entry_price <= 0) continue;
      const ret = ((px / p.entry_price) - 1) * 100;
      const row = state.perf.find((r) => r.timestamp === p.ts && r.market === p.market);
      if (!row) continue;
      if (!p.done3 && now >= p.due3) {
        row.return_3m_pct = Number(ret.toFixed(3));
        row.saved_3m = true;
        p.done3 = true;
        dbg("3m_result_saved", { market: p.market, captured_at: p.ts, return_3m_pct: row.return_3m_pct });
      }
      if (!p.done5 && now >= p.due5) {
        row.return_5m_pct = Number(ret.toFixed(3));
        row.saved_5m = true;
        p.done5 = true;
        dbg("5m_result_saved", { market: p.market, captured_at: p.ts, return_5m_pct: row.return_5m_pct });
      }
      if (!p.done10 && now >= p.due10) {
        row.return_10m_pct = Number(ret.toFixed(3));
        row.saved_10m = true;
        p.done10 = true;
        dbg("10m_result_saved", { market: p.market, captured_at: p.ts, return_10m_pct: row.return_10m_pct });
      }
    }
    state.pending = state.pending.filter((p) => !(p.done3 && p.done5 && p.done10));
  };

  const getCandlesSafe = async (market: string, signal?: AbortSignal): Promise<{ c1: UpbitCandle[]; c5: UpbitCandle[] } | null> => {
    const cached = candleSnapshotCache.get(market);
    const now = Date.now();
    if (cached && now - cached.fetchedAtMs < CANDLE_SNAPSHOT_CACHE_TTL_MS) {
      return { c1: cached.c1, c5: cached.c5 };
    }
    for (let attempt = 1; attempt <= CANDLE_429_MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), CANDLE_FETCH_TIMEOUT_MS);
      
      // Link external signal to internal abort controller
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      try {
        const c1Promise = fetchMinuteCandles(market, 1, 30, ctrl.signal);
        const c5Promise = fetchMinuteCandles(market, 5, 20, ctrl.signal);
        const [c1, c5] = await Promise.all([c1Promise, c5Promise]);
        return { c1, c5 };
      } catch (e: any) {
        const isTimeout = e.name === "AbortError" || e.message?.includes("timeout") || e.message?.includes("TIMEOUT");
        if (isTimeout) {
          console.warn(JSON.stringify({ tag: "PUMP_SCANNER_CANDLE_TIMEOUT_COOLDOWN", market, attempt, cooldown_min: 10 }));
          market429CooldownUntilMs.set(market, Date.now() + 10 * 60_000);
          return null;
        }
        const status = e.status;
        const msg = e.message || String(e);
        const is429 = status === 429 || msg.includes("429");
        if (!is429 || attempt >= CANDLE_429_MAX_ATTEMPTS) return null;
        const backoffMs = CANDLE_429_BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(backoffMs);
      } finally {
        clearTimeout(tid);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }
    return null;
  };

  const tick = async () => {
    if (isTickInFlight) {
      const elapsedSinceStart = Date.now() - lastTickStartedAt;
      if (elapsedSinceStart > 120_000) {
        console.warn(
          JSON.stringify({
            tag: "PUMP_SCANNER_STALE_IN_FLIGHT_RESET",
            ts: new Date().toISOString(),
            elapsed_ms: elapsedSinceStart,
            reset_at: new Date().toISOString(),
            aborted_hung_fetch: Boolean(activeTickAbort),
          }),
        );
        try {
          activeTickAbort?.abort();
        } catch {
          // ignore
        }
        activeTickAbort = null;
        isTickInFlight = false;
      } else {
        console.warn(
          JSON.stringify({
            tag: "PUMP_SCANNER_TICK_SKIPPED_IN_FLIGHT",
            ts: new Date().toISOString(),
            in_flight_skipped: true,
            elapsed_ms: elapsedSinceStart,
          }),
        );
        return;
      }
    }
    isTickInFlight = true;
    lastTickStartedAt = Date.now();
    const tickT0 = lastTickStartedAt;
    const rawDetected: ScannerRow[] = [];
    let candleTimeouts = 0;
    let skippedDueToBudget = 0;
    let releaseReason = "normal";
    const tickAbort = new AbortController();
    activeTickAbort = tickAbort;

    try {
      const heldMarkets = Array.from(new Set(getHeldMarkets().filter((m) => typeof m === "string" && m.length > 0)));

      const is429Excluded = (market: string) => {
        const until = market429CooldownUntilMs.get(market) ?? 0;
        return until > 0 && Date.now() < until;
      };

      let baseTickers: UpbitTicker[] = [];
      try {
        baseTickers = await fetchTickers([...BASE_MARKETS], {
          debugCaller: "pump-scanner:ticker_base",
          signal: tickAbort.signal,
          batchTimeoutMs: Math.max(800, Number(process.env.PUMP_SCANNER_TICKER_BATCH_TIMEOUT_MS ?? 3500)),
          totalTimeoutMs: Math.max(1000, Number(process.env.PUMP_SCANNER_TICKER_BASE_TOTAL_TIMEOUT_MS ?? 7000)),
        });
      } catch (e) {
        console.warn(JSON.stringify({
          tag: "PUMP_SCANNER_BASE_TICKER_FETCH_FAILED",
          error: e instanceof Error ? e.message : String(e)
        }));
      }
      const tAfterBaseTickers = Date.now();
      const btc = baseTickers.find((t) => t.market === "KRW-BTC");
      const btcDropPenalty = btc && (btc.signed_change_rate ?? 0) < -0.01 ? 8 : 0;

      let krwMarkets: string[];
      if (cachedKrwMarkets && Date.now() - cachedKrwMarketsAtMs < MARKET_LIST_CACHE_TTL_MS) {
        krwMarkets = cachedKrwMarkets;
      } else {
        try {
          const marketRows = await fetch("https://api.upbit.com/v1/market/all?isDetails=false").then((r) => r.json() as Promise<Array<{ market: string }>>);
          krwMarkets = marketRows.map((m) => m.market).filter((m) => m.startsWith("KRW-"));
          cachedKrwMarkets = krwMarkets;
          cachedKrwMarketsAtMs = Date.now();
        } catch {
          krwMarkets = cachedKrwMarkets ?? [...BASE_MARKETS];
        }
      }
      let altMarkets = krwMarkets.filter((m) => !BASE_MARKET_SET.has(m));
      const altValidity = await partitionKrwMarketsByUpbitValidity(altMarkets);
      if (!altValidity.skippedBecauseUnknown) {
        if (altValidity.rejected.length > 0) {
          console.info(
            JSON.stringify({
              tag: "DEBUG_PUMP_SCANNER_ALT_MARKETS_PRUNED",
              rejected_sample: altValidity.rejected.slice(0, 12),
              rejected_count: altValidity.rejected.length,
            }),
          );
        }
        altMarkets = altValidity.accepted;
      }
      let tickers: UpbitTicker[] = [];
      try {
        tickers = await fetchTickers(altMarkets, {
          ...pumpAltTickerOptsBase,
          maxMarkets: altMarkets.length,
          debugCaller: "pump-scanner:ticker_alt",
          signal: tickAbort.signal,
          batchTimeoutMs: Math.max(800, Number(process.env.PUMP_SCANNER_TICKER_BATCH_TIMEOUT_MS ?? 3500)),
          totalTimeoutMs: Math.max(1000, Number(process.env.PUMP_SCANNER_TICKER_ALT_TOTAL_TIMEOUT_MS ?? 12_000)),
        });
      } catch (e) {
        console.warn(JSON.stringify({
          tag: "PUMP_SCANNER_ALT_TICKER_FETCH_FAILED",
          error: e instanceof Error ? e.message : String(e)
        }));
      }
      if (tickers.length === 0) {
        console.warn(
          JSON.stringify({
            tag: "PUMP_SCANNER_TICK_BUDGET_DROPPED_PROOF",
            ts: new Date().toISOString(),
            phase: "ticker_alt_returned_zero",
            ticker_returned: 0,
            alt_market_count: altMarkets.length,
            elapsed_ms: Date.now() - tickT0,
            action: "attempt_held_only_ticker_recovery",
          }),
        );
        const heldAltOnly = heldMarkets.filter((m) => !BASE_MARKET_SET.has(m));
        if (heldAltOnly.length > 0) {
          try {
            tickers = await fetchTickers(heldAltOnly, {
              sortByCached24hVolume: false,
              batchSize: Math.min(20, Math.max(1, heldAltOnly.length)),
              batchDelayMs: PUMP_TICKER_BATCH_DELAY_MS,
              parallelTickerBatches: 1,
              maxMarkets: heldAltOnly.length,
              debugCaller: "pump-scanner:ticker_alt_degraded_held",
              signal: tickAbort.signal,
              batchTimeoutMs: Math.max(800, Number(process.env.PUMP_SCANNER_TICKER_HELD_RECOVERY_BATCH_TIMEOUT_MS ?? 2500)),
              totalTimeoutMs: Math.max(1000, Number(process.env.PUMP_SCANNER_TICKER_HELD_RECOVERY_TOTAL_TIMEOUT_MS ?? 6000)),
            });
          } catch (e) {
            console.warn(
              JSON.stringify({
                tag: "PUMP_SCANNER_ALT_DEGRADED_HELD_FETCH_FAILED",
                ts: new Date().toISOString(),
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        }
        if (tickers.length === 0) {
          releaseReason = "ticker_alt_and_held_recovery_empty";
          tickAbort.abort();
          console.warn(
            JSON.stringify({
              tag: "PUMP_SCANNER_TICK_RELEASE_EARLY_EMPTY_UNIVERSE",
              ts: new Date().toISOString(),
              phase: "ticker_alt_returned_zero",
              elapsed_ms: Date.now() - tickT0,
              held_alt_markets_attempted: heldAltOnly.length,
            }),
          );
          return;
        }
        console.info(
          JSON.stringify({
            tag: "PUMP_SCANNER_TICK_DEGRADED_UNIVERSE_PROOF",
            ts: new Date().toISOString(),
            ticker_returned: tickers.length,
            held_recovery_markets: tickers.map((t) => t.market).slice(0, 24),
            elapsed_ms: Date.now() - tickT0,
          }),
        );
      }
      const tAfterAltTickers = Date.now();
      const fetchedAltSet = new Set(tickers.map((t) => t.market));
      const heldMissingFromTicker = heldMarkets.filter((m) => !BASE_MARKET_SET.has(m) && !fetchedAltSet.has(m) && !is429Excluded(m));
      
      let heldExtraTickers: UpbitTicker[] = [];
      try {
        heldExtraTickers =
          heldMissingFromTicker.length > 0
            ? await fetchTickers(heldMissingFromTicker, {
                debugCaller: "pump-scanner:ticker_held_extra",
                signal: tickAbort.signal,
                batchTimeoutMs: Math.max(800, Number(process.env.PUMP_SCANNER_TICKER_BATCH_TIMEOUT_MS ?? 3500)),
                totalTimeoutMs: Math.max(1000, Number(process.env.PUMP_SCANNER_TICKER_HELD_TOTAL_TIMEOUT_MS ?? 5000)),
              })
            : [];
      } catch (e) {
        console.warn(JSON.stringify({
          tag: "PUMP_SCANNER_HELD_TICKER_FETCH_FAILED",
          error: e instanceof Error ? e.message : String(e)
        }));
      }
      const tAfterHeldExtraTickers = Date.now();

      const momSel = selectMomentumTopM(tickers, {
        is429Excluded,
        lookbackMin: MOMENTUM_LOOKBACK_MIN,
        topM: MOMENTUM_TOP_M,
        useVolumeWeight: USE_VOLUME_WEIGHT,
        snapshot: momentumSnapshot,
        prevRankByMarket: lastMomentumRankByMarket,
      });
      momentumSnapshot = momSel.nextSnapshot;
      lastMomentumRankByMarket = momSel.nextRankByMarket;
      const momentumCandidates = momSel.momentumTop;
      const momentumScoreByMarket = momSel.momentumScoreByMarket;
      const tAfterMomentum = Date.now();

      if (universeDebugLog) {
        console.info(
          JSON.stringify({
            tag: "DEBUG_UNIVERSE_SELECTION",
            totalSymbols: altMarkets.length,
            tickerReturned: tickers.length,
            selectedSymbols: momentumCandidates.length,
            considered: momSel.totalConsidered,
            topMomentumSample: momentumCandidates.slice(0, 12).map((t) => t.market),
            기준: {
              price_change: "signed_change_rate + short-term vs prev snapshot within lookback",
              volume_change: "delta acc_trade_price_24h vs prev snapshot when USE_VOLUME_WEIGHT",
            },
          }),
        );
      }

      const allTickers = [...baseTickers, ...tickers, ...heldExtraTickers];
      const tByMarket = new Map(allTickers.map((t) => [t.market, t]));

      // 기본: 보유 종목은 항상 스캔 대상에 포함(단, 429 쿨다운이면 제외).
      const heldTickers = heldMarkets
        .map((m) => tByMarket.get(m))
        .filter((t): t is UpbitTicker => Boolean(t))
        .filter((t) => !is429Excluded(t.market));

      const seen = new Set<string>();
      const marketsToScore = [...heldTickers, ...momentumCandidates].filter((t) => {
        if (seen.has(t.market)) return false;
        seen.add(t.market);
        return true;
      });

      const tradableCandidates: ScannerRow[] = [];

      const heldSet = new Set(heldMarkets);
      const marketsRanked = [...marketsToScore].sort((a, b) => {
        const heldBiasA = heldSet.has(a.market) ? 1 : 0;
        const heldBiasB = heldSet.has(b.market) ? 1 : 0;
        if (heldBiasA !== heldBiasB) return heldBiasB - heldBiasA;
        return (momentumScoreByMarket.get(b.market) ?? 0) - (momentumScoreByMarket.get(a.market) ?? 0);
      });
      const candleTargets = marketsRanked.slice(0, dynamicCandleTarget);
      const tBeforeCandles = Date.now();
      const batches = chunk(candleTargets, CANDLE_BATCH_SIZE);

      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi]!;
        for (const t of batch) {
          if (Date.now() - tickT0 > TICK_BUDGET_SECONDS * 1000) {
            console.warn(JSON.stringify({ tag: "PUMP_SCANNER_TICK_BUDGET_EXCEEDED", market: t.market, elapsed_ms: Date.now() - tickT0 }));
            skippedDueToBudget += (marketsRanked.length - rawDetected.length);
            releaseReason = "budget_exceeded";
            tickAbort.abort();
            break;
          }

          const candles = await getCandlesSafe(t.market, tickAbort.signal);
          if (!candles) {
            if (candleSnapshotCache.has(t.market)) {
              // already warned in getCandlesSafe or it's a 429
            } else {
               candleTimeouts += 1;
            }
            market429CooldownUntilMs.set(t.market, Date.now() + MARKET_429_EXCLUDE_MS);
            continue;
          }

          // Manage Fakeout State
          let fState = fakeoutStateMap.get(t.market);
          const s = scoreOne(candles.c1, candles.c5, t as UpbitTicker, btcDropPenalty, fState);
          if (!s) continue;

          // Update Peaks if not currently rejected
          if (s.status !== "제외") {
            if (!fState) {
              fState = {
                peakVolumeMultiple: s.volumeMultiple,
                peakPrice: t.trade_price,
                detectedAtMs: Date.now(),
                rejectedUntilMs: 0
              };
              fakeoutStateMap.set(t.market, fState);
            } else {
              fState.peakVolumeMultiple = Math.max(fState.peakVolumeMultiple, s.volumeMultiple);
              fState.peakPrice = Math.max(fState.peakPrice, t.trade_price);
            }
          } else {
            // If rejected by fakeout specifically, apply persistence
            const fakeoutReasons = (s.exclude_reasons || []).filter(r =>
              ["VOLUME_FADE_REJECTED", "HIGH_REJECTED", "RETEST_FAIL_REJECTED"].includes(r)
            );
            if (fakeoutReasons.length > 0) {
              if (fState) {
                fState.rejectedUntilMs = Date.now() + 10 * 60_000; // 10 min cooldown
                fState.lastReason = fakeoutReasons[0];
              }
            }
          }

          const row: ScannerRow = {
            rank: 0,
            market: t.market,
            score: Number(s.score.toFixed(1)),
            status: s.status,
            volume_multiple: Number(s.volumeMultiple.toFixed(2)),
            breakout: s.breakout,
            close_upper_hold: s.closeUpperHold,
            rise_3m_pct: Number(s.rise3mPct.toFixed(2)),
            early_entry_eligible: s.earlyEntryEligible,
            add_entry_eligible: s.addEntryEligible,
            exclude_reasons: s.exclude_reasons,
            price: s.price,
            updated_at: new Date().toISOString(),
          };

          // 1) RAW_DETECTED Log
          console.info(JSON.stringify({
            tag: "RAW_DETECTED",
            ts: row.updated_at,
            market: row.market,
            score: row.score,
            status: row.status,
            volume_multiple: row.volume_multiple
          }));
          rawDetected.push(row);

          // 2) Categorize: Tradable vs Rejected
          if (row.status === "제외") {
            if (opts.onEvent) {
              await opts.onEvent({
                timestamp: row.updated_at,
                event_type: "FILTER_REJECTED",
                market: row.market,
                strategy_type: "SURGE_SCANNER",
                reason: (row.exclude_reasons ?? []).join(","),
                note: `score: ${row.score}`
              });
            }
          } else {
            if (opts.onEvent) {
              await opts.onEvent({
                timestamp: row.updated_at,
                event_type: "TRADABLE_CONFIRMED",
                market: row.market,
                strategy_type: "SURGE_SCANNER",
                reason: row.status,
                note: `score: ${row.score}`
              });
            }
            tradableCandidates.push(row);
          }

          if (row.status !== "제외" && row.early_entry_eligible) {
            dbg("early_entry_eligible", { market: t.market, volume_multiple: s.volumeMultiple, rise_3m_pct: s.rise3mPct });
          }
          if (row.status !== "제외" && row.add_entry_eligible) {
            dbg("add_entry_eligible", {
              market: t.market,
              breakout: s.breakout,
              box_top_breakout: s.boxTopBreakout,
              volume_multiple: s.volumeMultiple,
            });
          }
        }
        if (releaseReason === "budget_exceeded") break;
        if (bi < batches.length - 1) {
          await sleep(CANDLE_BATCH_DELAY_MS);
        }
      }
      const tAfterCandles = Date.now();

      // UI/API Exposure: Only tradable candidates
      tradableCandidates.sort((a, b) => b.score - a.score);
      tradableCandidates.forEach((r, i) => {
        r.rank = i + 1;
      });
      state.rows = tradableCandidates.slice(0, 15);
      state.allResults = rawDetected;
      state.updatedAt = new Date().toISOString();

      if (PUMP_TIMING_LOG) {
        const tickerBatchesAlt = Math.ceil(altMarkets.length / PUMP_TICKER_BATCH_SIZE);
        const tickTotalMs = Date.now() - tickT0;
        const candleMs = tAfterCandles - tBeforeCandles;
        console.info(
          JSON.stringify({
            tag: "DEBUG_PUMP_SCANNER_TICK_TIMING",
            tick_total_ms: tickTotalMs,
            ticker_base_ms: tAfterBaseTickers - tickT0,
            ticker_alt_ms: tAfterAltTickers - tAfterBaseTickers,
            ticker_held_extra_ms: tAfterHeldExtraTickers - tAfterAltTickers,
            ticker_phase_ms: tAfterHeldExtraTickers - tickT0,
            momentum_ms: tAfterMomentum - tAfterHeldExtraTickers,
            post_momentum_prep_ms: tBeforeCandles - tAfterMomentum,
            candle_ms: candleMs,
            alt_market_count: altMarkets.length,
            ticker_returned: tickers.length,
            ticker_batches_alt: tickerBatchesAlt,
            ticker_batch_size: PUMP_TICKER_BATCH_SIZE,
            ticker_parallel: PUMP_TICKER_PARALLEL,
            ticker_batch_delay_ms: PUMP_TICKER_BATCH_DELAY_MS,
            momentum_considered: momSel.totalConsidered,
            momentum_top_m: MOMENTUM_TOP_M,
            markets_to_score: marketsToScore.length,
            candle_targets_count: candleTargets.length,
            candle_timeouts: candleTimeouts,
            skipped_due_to_budget: skippedDueToBudget,
            in_flight_skipped: false,
            dynamic_candle_target: dynamicCandleTarget,
            raw_detected_count: rawDetected.length,
            tradable_confirmed_count: tradableCandidates.length,
          }),
        );

        console.info(
          JSON.stringify({
            tag: "LIVE_SURGE_SOURCE_REPAIR_PROOF",
            ts: new Date().toISOString(),
            fresh_scanner_candidates_count: tradableCandidates.length,
            raw_detected_count: rawDetected.length,
            newest_scanner_updated_at: state.updatedAt,
            candle_targets: candleTargets.length,
            ticker_returned: tickers.length,
          })
        );
        const staleThresholdMs = LIVE_ENTRY_SIGNAL_STALE_SECONDS_FOR_WARN * 1_000;
        if (tickTotalMs > staleThresholdMs) {
          console.warn(
            JSON.stringify({
              tag: "PUMP_SCANNER_TICK_EXCEEDS_STALE_THRESHOLD",
              tick_total_ms: tickTotalMs,
              candle_ms: candleMs,
              stale_threshold_seconds: LIVE_ENTRY_SIGNAL_STALE_SECONDS_FOR_WARN,
              candle_targets_count: candleTargets.length,
              candle_timeouts: candleTimeouts,
              skipped_due_to_budget: skippedDueToBudget,
              in_flight_skipped: false,
              dynamic_candle_target: dynamicCandleTarget,
            }),
          );
          // dynamic reduce
          dynamicCandleTarget = Math.max(2, Math.floor(dynamicCandleTarget * 0.6));
          consecutiveNormalTicks = 0;
        } else {
          consecutiveNormalTicks += 1;
          if (consecutiveNormalTicks >= 3 && dynamicCandleTarget < CANDLE_MAX_MARKETS_PER_TICK) {
            dynamicCandleTarget = Math.min(CANDLE_MAX_MARKETS_PER_TICK, dynamicCandleTarget + 1);
            consecutiveNormalTicks = 0;
          }
        }
      }

      const priceBy = new Map(allTickers.map((t) => [t.market, t.trade_price]));
      for (const r of state.rows.slice(0, 8)) {
        const ts = new Date().toISOString();
        const exists = state.perf.find((x) => x.timestamp === ts && x.market === r.market);
        if (exists) continue;
        dbg("candidate_captured", {
          market: r.market,
          captured_at: ts,
          score: r.score,
          status: r.status,
          volume_multiple: r.volume_multiple,
          breakout: r.breakout,
          close_upper_hold: r.close_upper_hold,
          rise_3m_pct: r.rise_3m_pct,
          early_entry_eligible: r.early_entry_eligible,
          add_entry_eligible: r.add_entry_eligible,
        });
        state.perf.push({
          timestamp: ts,
          market: r.market,
          score: r.score,
          status: r.status,
          volume_multiple: r.volume_multiple,
          breakout: r.breakout,
          early_entry_eligible: r.early_entry_eligible,
          add_entry_eligible: r.add_entry_eligible,
          captured_at: ts,
          saved_3m: false,
          saved_5m: false,
          saved_10m: false,
          return_3m_pct: null,
          return_5m_pct: null,
          return_10m_pct: null,
        });
        state.pending.push({
          ts,
          market: r.market,
          score: r.score,
          status: r.status,
          volume_multiple: r.volume_multiple,
          breakout: r.breakout,
          early_entry_eligible: r.early_entry_eligible,
          add_entry_eligible: r.add_entry_eligible,
          entry_price: priceBy.get(r.market) ?? 0,
          due3: Date.now() + 3 * 60_000,
          due5: Date.now() + 5 * 60_000,
          due10: Date.now() + 10 * 60_000,
          done3: false,
          done5: false,
          done10: false,
        });
      }

      updatePending(priceBy);
      try {
        await persist();
      } catch {
        // persistence failure should not fail scanner tick
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Aborted") || msg.includes("AbortError")) {
        releaseReason = "aborted";
      } else {
        console.warn("[pump-scanner] tick_partial_failure", { error: msg, tick_id: tickT0 });
        releaseReason = "error";
      }
    } finally {
      tickAbort.abort(); // Cleanup any pending fetches
      if (activeTickAbort === tickAbort) activeTickAbort = null;
      isTickInFlight = false;
      const elapsed = Date.now() - tickT0;
      
      // Ensure state is updated even if budget was exceeded or error occurred
      state.updatedAt = new Date().toISOString();
      (state as any).lastReleaseReason = releaseReason;
      
      console.info(
        JSON.stringify({
          tag: "PUMP_SCANNER_TICK_RELEASED_PROOF",
          ts: state.updatedAt,
          tick_id: tickT0,
          elapsed_ms: elapsed,
          released: true,
          reason: releaseReason,
          raw_detected_count: rawDetected.length,
          tradable_candidates_count: state.rows.length,
          candle_timeouts: candleTimeouts,
          skipped_due_to_budget: skippedDueToBudget,
          is_stale_reset: false,
        }),
      );
    }
  };

  return {
    intervalMs: SCANNER_INTERVAL_MS,
    tick,
    signalFeed: () =>
      state.rows
        .map((r) => ({
          market: r.market,
          score: r.score,
          scanner_score: r.score,
          status: r.status,
          breakout: r.breakout,
          close_upper_hold: r.close_upper_hold,
          rise_3m_pct: r.rise_3m_pct,
          volume_multiple: r.volume_multiple,
          price: r.price,
          captured_at: r.captured_at ?? null,
          updated_at: r.updated_at,
          signal_ts: r.updated_at,
          early_entry_eligible: r.early_entry_eligible,
          add_entry_eligible: r.add_entry_eligible,
          source_kind: "scanner_tradable_candidate",
          signal_key: `${r.market}|${r.updated_at}|${r.score.toFixed(1)}|${r.status}|e${r.early_entry_eligible ? 1 : 0}a${r.add_entry_eligible ? 1 : 0}`,
          reason: r.early_entry_eligible
            ? `surge_scanner:pre_breakout_early:vr_${r.volume_multiple.toFixed(2)}:score_${r.score.toFixed(1)}`
            : r.add_entry_eligible
              ? `surge_scanner:add_leg_ready:${r.breakout ? "high20" : "box_top"}:score_${r.score.toFixed(1)}`
              : `surge_scanner:pre_entry_watch:score_${r.score.toFixed(1)}`,
          exclude_reasons: r.exclude_reasons,
        })),
    status: () => {
      // Latest perf per market for post verification columns.
      const latestPerfByMarket = new Map<string, PerfRow>();
      for (let i = state.perf.length - 1; i >= 0; i--) {
        const p = state.perf[i]!;
        if (!latestPerfByMarket.has(p.market)) latestPerfByMarket.set(p.market, p);
        if (latestPerfByMarket.size >= state.rows.length) break;
      }
      return {
        mode: "paper_validation",
        updated_at: state.updatedAt,
        items: state.rows.map((r) => {
          const p = latestPerfByMarket.get(r.market);
          return {
            ...r,
            captured_at: p ? p.captured_at : null,
            return_3m_pct: p ? p.return_3m_pct : null,
            return_5m_pct: p ? p.return_5m_pct : null,
            return_10m_pct: p ? p.return_10m_pct : null,
          };
        }),
      };
    },
    files: { performance: perfFile, snapshot: snapFile },
  };
}

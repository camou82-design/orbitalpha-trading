import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";
import { fetchMinuteCandles, fetchTickers, type UpbitCandle, type UpbitTicker } from "./upbit-public.js";

type ScannerRow = {
  rank: number;
  market: string;
  score: number;
  status: "진입후보" | "강관찰" | "예비후보" | "제외";
  volume_multiple: number;
  breakout: boolean;
  close_upper_hold: boolean;
  rise_3m_pct: number;
  /** When status is "제외", show why it was excluded. */
  exclude_reasons?: string[];
  /** 최초 후보 포착 시각 (performance row timestamp). */
  captured_at?: string | null;
  /** Post verification (latest known for this market). */
  return_3m_pct?: number | null;
  return_5m_pct?: number | null;
  return_10m_pct?: number | null;
  updated_at: string;
};

type PendingEval = {
  ts: string;
  market: string;
  score: number;
  status: ScannerRow["status"];
  volume_multiple: number;
  breakout: boolean;
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
  captured_at: string;
  saved_3m: boolean;
  saved_5m: boolean;
  saved_10m: boolean;
  return_3m_pct: number | null;
  return_5m_pct: number | null;
  return_10m_pct: number | null;
};

const SCANNER_INTERVAL_MS = 15_000;
const LIQUIDITY_SCAN_MIN_24H_KRW = 300_000_000; // 3억 이상만 스캔(단, 후보 제외 사유로도 표시)
const LIQUIDITY_EXCLUDE_MIN_24H_KRW = 1_000_000_000; // 10억 이상만 후보 (그 미만은 "유동성 부족")
const BASE_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;
const BASE_MARKET_SET = new Set<string>(BASE_MARKETS as unknown as string[]);
const MAX_SCAN_MARKETS = 24;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function toStatus(score: number): ScannerRow["status"] {
  if (score >= 80) return "진입후보";
  if (score >= 65) return "강관찰";
  if (score >= 50) return "예비후보";
  return "제외";
}

function avg(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function scoreOne(c1: UpbitCandle[], c5: UpbitCandle[], ticker: UpbitTicker, btcDropPenalty: number) {
  const last = c1[c1.length - 1];
  if (!last) return null;
  const prev20 = c1.slice(-21, -1);
  if (prev20.length < 20) return null;
  const vNow = last.candle_acc_trade_volume * last.trade_price;
  const vAvg = avg(prev20.map((c) => c.candle_acc_trade_volume * c.trade_price));
  const volumeMultiple = vAvg > 0 ? vNow / vAvg : 0;
  const scoreVol = clamp((volumeMultiple - 1) * 12, 0, 30);

  const high20 = Math.max(...prev20.map((c) => c.high_price));
  const breakout = last.trade_price >= high20;
  const scoreBreak = breakout ? 20 : clamp(((last.trade_price / high20) - 0.98) * 1000, 0, 20);

  const range = Math.max(1e-9, last.high_price - last.low_price);
  const closeTopRatio = (last.trade_price - last.low_price) / range;
  const closeUpperHold = closeTopRatio >= 0.65;
  const scoreCloseTop = clamp((closeTopRatio - 0.35) * 50, 0, 15);

  const recent3 = c1.slice(-3);
  const rise3mPct = recent3.length >= 3 ? (recent3[2]!.trade_price / recent3[0]!.trade_price - 1) * 100 : 0;
  const bullishCnt = recent3.filter((c) => c.trade_price > c.opening_price).length;
  const accel = recent3.length >= 3 && recent3[2]!.trade_price > recent3[1]!.trade_price && recent3[1]!.trade_price > recent3[0]!.trade_price;
  const scoreAccel = clamp((bullishCnt - 1) * 7 + (accel ? 4 : 0), 0, 15);

  const scoreSpeed = clamp((volumeMultiple - 1) * 4, 0, 10);

  const upperWickRatio = (last.high_price - last.trade_price) / range;
  const scoreStability = upperWickRatio <= 0.35 ? 10 : clamp((0.6 - upperWickRatio) * 40, 0, 10);

  let penalty = 0;
  if (upperWickRatio > 0.55) penalty += 8;
  const oneMinPump = prev20.length > 0 ? (last.trade_price / prev20[prev20.length - 1]!.trade_price - 1) * 100 : 0;
  if (oneMinPump > 4.5) penalty += 6;
  if (volumeMultiple < 0.95) penalty += 10;
  penalty += btcDropPenalty;

  const liquidity24h = Number(ticker.acc_trade_price_24h ?? 0);
  const liquidityBad = liquidity24h < LIQUIDITY_EXCLUDE_MIN_24H_KRW;
  if (liquidityBad) penalty += 100;

  // Strong candidates: breakout + upper hold + clear volume surge.
  const hasOnAltAltPattern = breakout && closeUpperHold && volumeMultiple >= 1.3;

  // Re-weighting for "real alt breakout" detection.
  const scoreVolStrong = clamp((volumeMultiple - 1) * 18, 0, 45);
  const scoreBreakStrong = breakout ? 30 : clamp(((last.trade_price / high20) - 0.985) * 900, 0, 20);
  const scoreCloseTopStrong = closeUpperHold ? 18 : clamp((closeTopRatio - 0.35) * 60, 0, 16);
  const scoreSpeedStrong = clamp((volumeMultiple - 1) * 6, 0, 18);
  const scoreRise3m = clamp((rise3mPct - 1) * 0.9, 0, 25);
  const scoreOnPattern = hasOnAltAltPattern ? 15 : 0;

  const scoreRaw = scoreVolStrong + scoreBreakStrong + scoreCloseTopStrong + scoreAccel + scoreSpeedStrong + scoreStability + scoreRise3m + scoreOnPattern - penalty;
  let score = clamp(scoreRaw, 0, 100);

  // If liquidity is insufficient, always keep it excluded (so that reasons can be shown).
  if (liquidityBad) score = Math.min(score, 49);

  // Ensure ONT-like breakouts don't get stuck as "제외".
  if (!liquidityBad && hasOnAltAltPattern) score = Math.max(score, 65);

  const status = toStatus(score);
  const exclude_reasons: string[] = [];
  if (liquidityBad) exclude_reasons.push("유동성 부족");
  if (btcDropPenalty > 0) exclude_reasons.push("BTC 역풍");
  if (upperWickRatio > 0.55) exclude_reasons.push("윗꼬리 과다");
  if (oneMinPump > 4.5) exclude_reasons.push("과열");
  if (volumeMultiple < 0.95) exclude_reasons.push("거래대금 부족");

  return {
    score: Number(score.toFixed(1)),
    status,
    volumeMultiple,
    breakout,
    closeUpperHold,
    rise3mPct,
    price: ticker.trade_price,
    exclude_reasons:
      status === "제외"
        ? Array.from(
            new Set(
              exclude_reasons.length > 0 ? exclude_reasons : ["거래대금 부족"], // always show something
            ),
          )
        : undefined,
  };
}

export function createPumpScanner() {
  const state = {
    rows: [] as ScannerRow[],
    updatedAt: null as string | null,
    pending: [] as PendingEval[],
    perf: [] as PerfRow[],
  };

  const debugEnabled =
    process.env.ORBITALPHA_TRADING_SCANNER_DEBUG === "1" ||
    (process.env.DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    (process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true";

  const dbg = (event: string, payload: Record<string, unknown>) => {
    if (!debugEnabled) return;
    console.log("[pump-scanner]", event, payload);
  };

  const baseDir = path.join(tradingDataRoot(), "scanner");
  const perfFile = path.join(baseDir, "pump_scanner_performance.json");
  const snapFile = path.join(baseDir, "pump_scanner_snapshot.json");

  const persist = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(perfFile, JSON.stringify(state.perf.slice(-5000), null, 2), "utf8");
    await fs.writeFile(snapFile, JSON.stringify({ updated_at: state.updatedAt, rows: state.rows }, null, 2), "utf8");
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

  const tick = async () => {
    const baseTickers = await fetchTickers([...BASE_MARKETS]);
    const btc = baseTickers.find((t) => t.market === "KRW-BTC");
    const btcDropPenalty = btc && (btc.signed_change_rate ?? 0) < -0.01 ? 8 : 0;

    const marketRows = await fetch("https://api.upbit.com/v1/market/all?isDetails=false").then((r) => r.json() as Promise<Array<{ market: string }>>);
    const krwMarkets = marketRows.map((m) => m.market).filter((m) => m.startsWith("KRW-"));
    const altMarkets = krwMarkets.filter((m) => !BASE_MARKET_SET.has(m));
    const tickers = await fetchTickers(altMarkets);
    const liquid = tickers
      .filter((t) => (t.acc_trade_price_24h ?? 0) >= LIQUIDITY_SCAN_MIN_24H_KRW)
      .sort((a, b) => (b.acc_trade_price_24h ?? 0) - (a.acc_trade_price_24h ?? 0))
      .slice(0, MAX_SCAN_MARKETS);

    const rows: ScannerRow[] = [];
    for (const t of liquid) {
      try {
        const c1 = await fetchMinuteCandles(t.market, 1, 30);
        const c5 = await fetchMinuteCandles(t.market, 5, 20);
        const s = scoreOne(c1, c5, t as UpbitTicker, btcDropPenalty);
        if (!s) continue;
        rows.push({
          rank: 0,
          market: t.market,
          score: Number(s.score.toFixed(1)),
          status: s.status,
          volume_multiple: Number(s.volumeMultiple.toFixed(2)),
          breakout: s.breakout,
          close_upper_hold: s.closeUpperHold,
          rise_3m_pct: Number(s.rise3mPct.toFixed(2)),
          exclude_reasons: s.exclude_reasons,
          updated_at: new Date().toISOString(),
        });
      } catch {
        continue;
      }
    }

    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => {
      r.rank = i + 1;
    });
    state.rows = rows.slice(0, 15);
    state.updatedAt = new Date().toISOString();

    const priceBy = new Map(tickers.map((t) => [t.market, t.trade_price]));
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
      });
      state.perf.push({
        timestamp: ts,
        market: r.market,
        score: r.score,
        status: r.status,
        volume_multiple: r.volume_multiple,
        breakout: r.breakout,
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
    await persist();
  };

  return {
    intervalMs: SCANNER_INTERVAL_MS,
    tick,
    status: () => {
      // Latest perf per market for post verification columns.
      const latestPerfByMarket = new Map<string, PerfRow>();
      for (let i = state.perf.length - 1; i >= 0; i--) {
        const p = state.perf[i]!;
        if (!latestPerfByMarket.has(p.market)) latestPerfByMarket.set(p.market, p);
        if (latestPerfByMarket.size >= state.rows.length) break;
      }
      return {
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

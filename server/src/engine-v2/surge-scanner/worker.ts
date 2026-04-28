import { atomicWriteJson } from "../../runtime-file-io.js";
import { surgeCandidatesRuntimePath } from "../../runtime-paths.js";
import { fetchMinuteCandles, fetchTickers, partitionKrwMarketsByUpbitValidity } from "../../upbit-public.js";
import { evaluateEngine2SurgeCandidate } from "./evaluate.js";
import type { Engine2SurgeCandidate, Engine2SurgeCandidatesFile } from "./types.js";

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE_MARKETS = new Set(["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"]);

export function startEngine2SurgeScannerWorker(params: {
  intervalMs?: number;
  maxItems?: number;
  topM?: number;
  candleMaxPerTick?: number;
  candleBatchSize?: number;
  candleBatchDelayMs?: number;
  staleSeconds?: number;
  log?: (row: Record<string, unknown>) => void;
}): { stop: () => void } {
  const intervalMs = Math.max(5_000, params.intervalMs ?? 15_000);
  const maxItems = Math.max(10, Math.min(200, params.maxItems ?? 60));
  const topM = Math.max(10, Math.min(150, params.topM ?? 50));
  const candleMaxPerTick = Math.max(5, Math.min(60, params.candleMaxPerTick ?? 18));
  const candleBatchSize = Math.max(1, Math.min(10, params.candleBatchSize ?? 3));
  const candleBatchDelayMs = Math.max(0, params.candleBatchDelayMs ?? 1_200);
  const staleSeconds = Math.max(30, Math.min(1800, params.staleSeconds ?? 300));
  const outPath = surgeCandidatesRuntimePath();

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  const log = (row: Record<string, unknown>) => params.log?.(row);

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const t0 = Date.now();
    try {
      const marketRows = await fetch("https://api.upbit.com/v1/market/all?isDetails=false").then(
        (r) => r.json() as Promise<Array<{ market: string }>>,
      );
      const krw = marketRows.map((m) => m.market).filter((m) => m.startsWith("KRW-") && !BASE_MARKETS.has(m));
      const validity = await partitionKrwMarketsByUpbitValidity(krw);
      const markets = validity.skippedBecauseUnknown ? krw : validity.accepted;
      const tickers = await fetchTickers(markets, { maxMarkets: markets.length, batchSize: 80, parallelTickerBatches: 3 });
      const momentumTop = [...tickers]
        .sort((a, b) => Number(b.signed_change_rate ?? 0) - Number(a.signed_change_rate ?? 0))
        .slice(0, topM);

      const targets = momentumTop.slice(0, candleMaxPerTick);
      const batches = chunk(targets, candleBatchSize);
      const nowIso = new Date().toISOString();
      const candidates: Engine2SurgeCandidate[] = [];

      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi]!;
        for (const t of batch) {
          try {
            const c1 = await fetchMinuteCandles(t.market, 1, 30);
            const c = evaluateEngine2SurgeCandidate({ market: t.market, ticker: t, candles1m: c1 }, nowIso);
            if (!c) continue;
            // Minimum quality gate for candidate file.
            const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(c.signal_ts)) / 1000));
            if (ageSeconds > staleSeconds) continue;
            if (c.scanner_score < 35) continue;
            candidates.push(c);
          } catch {
            // keep worker resilient per-market
          }
        }
        if (bi < batches.length - 1 && candleBatchDelayMs > 0) await sleep(candleBatchDelayMs);
      }

      const items = candidates
        .sort((a, b) => b.scanner_score - a.scanner_score || b.volume_multiple - a.volume_multiple)
        .slice(0, maxItems);

      const payload: Engine2SurgeCandidatesFile = {
        kind: "surge_candidates_engine2",
        engine: "engine2_surge_scanner",
        updated_at: nowIso,
        items,
      };
      atomicWriteJson(outPath, payload);

      log({
        tag: "ENGINE2_SURGE_SCANNER_TICK",
        ts: nowIso,
        duration_ms: Date.now() - t0,
        symbols_considered: markets.length,
        top_m: topM,
        candle_targets: targets.length,
      });
      log({
        tag: "ENGINE2_SURGE_CANDIDATES_WRITTEN",
        ts: nowIso,
        items_count: items.length,
        path: outPath.replace(/\\/g, "/"),
      });
    } catch (e) {
      log({
        tag: "ENGINE2_SURGE_SCANNER_FAILED",
        ts: new Date().toISOString(),
        err: String(e).slice(0, 300),
      });
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => void tick(), intervalMs);
  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}


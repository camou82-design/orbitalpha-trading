import {
  companyIdSchema,
  mvpSignalPayloadV2Schema,
  serviceIdSchema,
} from "@orbitalpha/shared";
import type { Env } from "./env.js";
import { beginMonitorInstance, clearMonitorInstance } from "./monitor-instance-meta.js";
import { appendLog } from "./log-store.js";
import { evaluateMvpSignal } from "./signal-engine.js";
import { fetchMinuteCandles, resolveWatchMarkets, type UpbitCandle } from "./upbit-public.js";
import { getVolumeThresholdForMarket } from "./volume-thresholds.js";
import { startUpbitTickerWs, type TickerWsHandle } from "./upbit-ws.js";

export type MonitorHandle = { stop: () => void };

/** 동일 프로세스에서 startSignalMonitor 중복 호출 방지 (HMR/실수 대비) */
let runningHandle: MonitorHandle | null = null;

/** 스캔 주기 — REST 부하·429 완화 (기본 60s보다 길게). */
const SCAN_MS = 90_000;
const BETWEEN_MARKETS_MS = 450;
/** 429 등 실패 시 해당 종목 쿨다운 (같은 스캔에서 반복 호출 억제). */
const MARKET_ERROR_COOLDOWN_MS = 3 * 60_000;
const MAX_429_RETRIES = 1;
const RETRY_BACKOFF_MS = 2_200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchCandlesWithRetry(
  market: string,
  unit: 1 | 5,
  count: number,
): Promise<UpbitCandle[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fetchMinuteCandles(market, unit, count);
    } catch (e) {
      lastErr = e;
      const s = String(e);
      if (attempt < MAX_429_RETRIES && s.includes("429")) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Upbit REST(캔들) + WebSocket(ticker). 주문 없음.
 * 프로세스당 1회만 실제 구동 — 재호출 시 기존 핸들 반환.
 */
export function startSignalMonitor(env: Env): MonitorHandle {
  if (runningHandle) {
    return runningHandle;
  }

  const { monitor_instance_id, started_at } = beginMonitorInstance();

  const withMonitorPayload = (payload: Record<string, unknown>) => ({
    ...payload,
    monitor_instance_id,
  });

  const companyId = companyIdSchema.parse(env.companyId);
  const serviceId = serviceIdSchema.parse(env.serviceId);

  const marketRef = { list: [] as string[] };
  let wsHandle: TickerWsHandle | null = null;
  const cooldownUntil = new Map<string, number>();

  async function loadWatchMarkets(): Promise<string[]> {
    const markets = await resolveWatchMarkets(env.excludedMarkets);
    marketRef.list = markets;
    return markets;
  }

  async function runScan(): Promise<void> {
    let markets: string[];
    try {
      markets = await loadWatchMarkets();
    } catch (e) {
      await appendLog({
        company_id: companyId,
        service_id: serviceId,
        ts: new Date().toISOString(),
        kind: "system",
        message: "watch_list_resolve_failed",
        payload: withMonitorPayload({ error: String(e) }),
      });
      return;
    }

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i]!;
      if (i > 0) await sleep(BETWEEN_MARKETS_MS);

      const until = cooldownUntil.get(market) ?? 0;
      if (Date.now() < until) {
        await appendLog({
          company_id: companyId,
          service_id: serviceId,
          ts: new Date().toISOString(),
          kind: "system",
          message: `market_scan_skipped_cooldown:${market}`,
          payload: withMonitorPayload({ until_iso: new Date(until).toISOString() }),
        });
        continue;
      }

      try {
        const candles5 = await fetchCandlesWithRetry(market, 5, 42);
        await sleep(BETWEEN_MARKETS_MS);
        const candles1 = await fetchCandlesWithRetry(market, 1, 30);
        cooldownUntil.delete(market);

        const ev = evaluateMvpSignal(market, candles5, candles1, {
          volumeThresholdMain: getVolumeThresholdForMarket(market, env.volumeThresholdMain),
        });
        const lastPx = wsHandle?.getLastPrice(market);
        const payload = mvpSignalPayloadV2Schema.parse({
          v: 2,
          market,
          monitor_instance_id,
          signal_type: ev.signal_type,
          signal_reason: ev.signal_reason,
          filter_pass: ev.filter_pass,
          filter_fail_reason: ev.filter_fail_reason,
          filters: ev.filters,
          volume_ratio: ev.volume_ratio,
          volume_threshold_main: ev.volume_threshold_main,
          volume_threshold_alt: ev.volume_threshold_alt,
          would_pass_at_095: ev.would_pass_at_095,
          would_pass_at_075: ev.would_pass_at_075,
          pullback_relaxed_pass: ev.pullback_relaxed_pass,
          would_pass_with_pullback_relaxed: ev.would_pass_with_pullback_relaxed,
          vol_close_relaxed_a_pass: ev.vol_close_relaxed_a_pass,
          vol_close_relaxed_b_pass: ev.vol_close_relaxed_b_pass,
          would_pass_with_vol_close_relaxed_a: ev.would_pass_with_vol_close_relaxed_a,
          would_pass_with_vol_close_relaxed_b: ev.would_pass_with_vol_close_relaxed_b,
          breakout_relaxed_a_pass: ev.breakout_relaxed_a_pass,
          breakout_relaxed_b_pass: ev.breakout_relaxed_b_pass,
          would_pass_with_breakout_relaxed_a: ev.would_pass_with_breakout_relaxed_a,
          would_pass_with_breakout_relaxed_b: ev.would_pass_with_breakout_relaxed_b,
          pair_pass_breakout_b_and_pullback_relaxed: ev.pair_pass_breakout_b_and_pullback_relaxed,
          pair_pass_breakout_b_and_vol_close_a: ev.pair_pass_breakout_b_and_vol_close_a,
        });
        await appendLog({
          company_id: companyId,
          service_id: serviceId,
          ts: new Date().toISOString(),
          kind: "signal",
          message: ev.filter_pass ? `signal:${market}` : `eval:${market}`,
          payload: {
            ...payload,
            ...(lastPx !== undefined ? { ws_last_trade_price: lastPx } : {}),
          } as unknown as Record<string, unknown>,
        });
      } catch (e) {
        cooldownUntil.set(market, Date.now() + MARKET_ERROR_COOLDOWN_MS);
        await appendLog({
          company_id: companyId,
          service_id: serviceId,
          ts: new Date().toISOString(),
          kind: "system",
          message: `market_scan_failed:${market}`,
          payload: withMonitorPayload({ error: String(e), cooldown_ms: MARKET_ERROR_COOLDOWN_MS }),
        });
      }
    }
  }

  let stopped = false;
  const kick = () => {
    if (stopped) return;
    void runScan();
  };

  void (async () => {
    try {
      const initial = await loadWatchMarkets();
      wsHandle = startUpbitTickerWs(() => marketRef.list);
      await appendLog({
        company_id: companyId,
        service_id: serviceId,
        ts: new Date().toISOString(),
        kind: "system",
        message: "signal_monitor_started",
        payload: withMonitorPayload({
          started_at,
          markets: initial,
          excluded_markets: env.excludedMarkets,
          interval_ms: SCAN_MS,
          between_markets_ms: BETWEEN_MARKETS_MS,
          rest: "https://api.upbit.com",
          ws: "wss://socket.upbit.com/websocket/v1",
          note: "REST=캔들 스캔, WS=참고 체결가; 429 시 재시도·쿨다운; 프로세스당 1회 부팅",
        }),
      });
    } catch (e) {
      await appendLog({
        company_id: companyId,
        service_id: serviceId,
        ts: new Date().toISOString(),
        kind: "system",
        message: "signal_monitor_start_partial",
        payload: withMonitorPayload({ error: String(e) }),
      });
    }
    kick();
  })();

  const interval = setInterval(kick, SCAN_MS);

  runningHandle = {
    stop: () => {
      stopped = true;
      clearInterval(interval);
      wsHandle?.stop();
      wsHandle = null;
      clearMonitorInstance();
      runningHandle = null;
    },
  };

  return runningHandle;
}

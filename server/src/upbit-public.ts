const UPBIT = "https://api.upbit.com";

class UpbitHttpError extends Error {
  status: number;
  path: string;
  constructor(message: string, status: number, path: string) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

export type UpbitCandle = {
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
  candle_date_time_kst: string;
};

type CandleCacheEntry = {
  value: UpbitCandle[];
  fetchedAtMs: number;
  expiresAtMs: number;
  staleUntilMs: number;
};

export type UpbitTicker = {
  market: string;
  trade_price: number;
  signed_change_rate?: number;
  acc_trade_price_24h?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 캔들 REST 과호출/429 완화를 위한 공용 캐시/쿨다운 (프로세스 내).
const CANDLE_CACHE_TTL_MS = Number(process.env.UPBIT_CANDLE_CACHE_TTL_MS ?? 15_000); // 10~20s 권장
const CANDLE_CACHE_STALE_GRACE_MS = Number(process.env.UPBIT_CANDLE_CACHE_STALE_GRACE_MS ?? 30_000); // 429 시 마지막 값 서빙
const CANDLE_429_COOLDOWN_MS = Number(process.env.UPBIT_CANDLE_429_COOLDOWN_MS ?? 20_000); // 10~30s 권장
const CANDLE_429_MIN_BACKOFF_MS = Number(process.env.UPBIT_CANDLE_429_MIN_BACKOFF_MS ?? 10_000);
const CANDLE_429_MAX_BACKOFF_MS = Number(process.env.UPBIT_CANDLE_429_MAX_BACKOFF_MS ?? 30_000);
const CANDLE_429_MAX_ATTEMPTS = Number(process.env.UPBIT_CANDLE_429_MAX_ATTEMPTS ?? 2); // 1회 재시도

const CANDLE_429_LOG_INTERVAL_MS = Number(process.env.UPBIT_CANDLE_429_LOG_INTERVAL_MS ?? 60_000);
const CANDLE_CACHE_STATS_LOG_INTERVAL_MS = Number(process.env.UPBIT_CANDLE_CACHE_STATS_LOG_INTERVAL_MS ?? 60_000);

const candleCache = new Map<string, CandleCacheEntry>();
const candleInFlight = new Map<string, Promise<UpbitCandle[]>>();
const candleCooldownUntilMs = new Map<string, number>();
let candleGlobalCooldownUntilMs = 0;
const candle429LastLogAtMs = new Map<string, number>();

let candleHttpFetchesSinceLastLog = 0;
let candleCacheHitsSinceLastLog = 0;
let candleStaleServedSinceLastLog = 0;
let candleLastStatsLogAtMs = 0;

function candleKey(market: string, unit: 1 | 5 | 15, count: number) {
  return `${market}|u${unit}|c${count}`;
}

function maybeLogCandleCacheStats(nowMs: number) {
  if (nowMs - candleLastStatsLogAtMs < CANDLE_CACHE_STATS_LOG_INTERVAL_MS) return;
  if (candleLastStatsLogAtMs !== 0 && candleHttpFetchesSinceLastLog + candleCacheHitsSinceLastLog + candleStaleServedSinceLastLog === 0) {
    candleLastStatsLogAtMs = nowMs;
    return;
  }
  candleLastStatsLogAtMs = nowMs;
  console.log(
    `[upbit-candles][stats] http_calls=${candleHttpFetchesSinceLastLog} cache_hits=${candleCacheHitsSinceLastLog} stale_served=${candleStaleServedSinceLastLog} inFlight=${candleInFlight.size}`,
  );
  candleHttpFetchesSinceLastLog = 0;
  candleCacheHitsSinceLastLog = 0;
  candleStaleServedSinceLastLog = 0;
}

function maybeLog429(nowMs: number, key: string, meta: { market: string; unit: 1 | 5 | 15; count: number }, cooldownUntilMs: number, status: number) {
  const last = candle429LastLogAtMs.get(key) ?? 0;
  if (nowMs - last < CANDLE_429_LOG_INTERVAL_MS) return;
  candle429LastLogAtMs.set(key, nowMs);
  console.log(
    `[upbit-candles][429] status=${status} market=${meta.market} unit=${meta.unit} count=${meta.count} cooldown_until=${new Date(cooldownUntilMs).toISOString()}`,
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${UPBIT}${path}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new UpbitHttpError(`Upbit ${path} → ${r.status}: ${text.slice(0, 200)}`, r.status, path);
  }
  return r.json() as Promise<T>;
}

/** Newest candle first — reverse to oldest-first for indicators. */
export async function fetchMinuteCandles(
  market: string,
  unit: 1 | 5 | 15,
  count: number,
): Promise<UpbitCandle[]> {
  const key = candleKey(market, unit, count);
  const nowMs = Date.now();
  maybeLogCandleCacheStats(nowMs);

  const cached = candleCache.get(key);
  if (cached) {
    if (nowMs <= cached.expiresAtMs) {
      candleCacheHitsSinceLastLog += 1;
      return cached.value;
    }
    // fresh TTL 지났더라도, 429 쿨다운 중이면 마지막 값을 재사용할 수 있도록 허용.
    const cooldownUntilMs = candleCooldownUntilMs.get(key) ?? 0;
    if (nowMs <= cached.staleUntilMs && (nowMs < cooldownUntilMs || nowMs < candleGlobalCooldownUntilMs)) {
      candleStaleServedSinceLastLog += 1;
      return cached.value;
    }
  }

  const inFlight = candleInFlight.get(key);
  if (inFlight) return inFlight;

  const task = (async (): Promise<UpbitCandle[]> => {
    const meta = { market, unit, count };
    let attempt = 0;

    while (attempt < CANDLE_429_MAX_ATTEMPTS) {
      attempt += 1;
      const cooldownUntilMs = candleCooldownUntilMs.get(key) ?? 0;
      const left = cooldownUntilMs - Date.now();
      if (left > 0) {
        // 쿨다운 중에는 즉시 재시도하지 않고 대기.
        // (콜러가 여러 개여도 inFlight dedupe로 HTTP 호출은 1번만 발생)
        await sleep(left);
      }

      const globalLeft = candleGlobalCooldownUntilMs - Date.now();
      if (globalLeft > 0) {
        await sleep(globalLeft);
      }

      try {
        const path = `/v1/candles/minutes/${unit}?market=${encodeURIComponent(market)}&count=${count}`;
        const rows = await fetchJson<UpbitCandle[]>(path);
        const value = [...rows].reverse();
        const fetchedAtMs = Date.now();
        candleHttpFetchesSinceLastLog += 1;
        candleCache.set(key, {
          value,
          fetchedAtMs,
          expiresAtMs: fetchedAtMs + CANDLE_CACHE_TTL_MS,
          staleUntilMs: fetchedAtMs + CANDLE_CACHE_TTL_MS + CANDLE_CACHE_STALE_GRACE_MS,
        });
        return value;
      } catch (e) {
        if (e instanceof UpbitHttpError && e.status === 429) {
          const now = Date.now();
          const cooldownUntilMs2 = now + CANDLE_429_COOLDOWN_MS;
          candleCooldownUntilMs.set(key, cooldownUntilMs2);
          candleGlobalCooldownUntilMs = Math.max(candleGlobalCooldownUntilMs, cooldownUntilMs2);

          maybeLog429(now, key, meta, cooldownUntilMs2, e.status);

          const cached2 = candleCache.get(key);
          if (cached2 && now <= cached2.staleUntilMs) {
            candleStaleServedSinceLastLog += 1;
            return cached2.value;
          }

          const backoffMs = Math.min(CANDLE_429_MAX_BACKOFF_MS, Math.max(CANDLE_429_MIN_BACKOFF_MS, CANDLE_429_COOLDOWN_MS * 2 ** (attempt - 1)));
          if (attempt >= CANDLE_429_MAX_ATTEMPTS) throw e;
          await sleep(backoffMs);
          continue;
        }
        throw e;
      }
    }

    // 논리상 도달 불가(while 종료) — 타입 만족용
    throw new Error(`Upbit candles fetch failed unexpectedly: ${market} unit=${unit} count=${count}`);
  })();

  candleInFlight.set(key, task);
  try {
    return await task;
  } finally {
    candleInFlight.delete(key);
  }
}

/**
 * 1차 MVP 고정 감시 (USDT/AKT 등 제외 — 목록에 아예 포함하지 않음).
 */
export const MVP_WATCH_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;

/** `excluded`에 있는 마켓(대소문자·공백 정규화 없음 — Upbit 코드 그대로)은 감시에서 뺀다. */
export function getMvpWatchMarkets(excluded: readonly string[]): string[] {
  const ex = new Set(excluded);
  return MVP_WATCH_MARKETS.filter((m) => !ex.has(m));
}

export function resolveWatchMarkets(excluded: readonly string[] = []): Promise<string[]> {
  return Promise.resolve(getMvpWatchMarkets(excluded));
}

function numTradePrice(v: unknown): number {
  const p = Number(v);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

export async function fetchTickers(markets: string[]): Promise<UpbitTicker[]> {
  if (markets.length === 0) return [];
  const q = encodeURIComponent(markets.join(","));
  const rows = await fetchJson<UpbitTicker[]>(`/v1/ticker?markets=${q}`);
  return rows.map((r) => ({
    ...r,
    trade_price: numTradePrice((r as { trade_price?: unknown }).trade_price),
  }));
}

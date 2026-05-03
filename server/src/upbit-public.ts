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

/** `fetchTickers` 기본 동작(24h 힌트 정렬 + 상위 N개)은 그대로 — 옵션으로만 확장. */
export type FetchTickersOptions = {
  /** 기본: `UPBIT_TICKER_MAX_MARKETS_PER_TICK`(15). 전체 조회 시 `markets.length` 등 큰 값. */
  maxMarkets?: number;
  /** false 이면 입력 순서 유지(모멘텀 유니버스 등). 기본 true. */
  sortByCached24hVolume?: boolean;
  /** 기본 `UPBIT_TICKER_BATCH_SIZE`. pump 전체 유니버스 조회 시 크게 줄이면 HTTP 왕복 횟수 감소. */
  batchSize?: number;
  /** 기본 `UPBIT_TICKER_BATCH_DELAY_MS`. 0 이면 배치 간 대기 없음. */
  batchDelayMs?: number;
  /** 동시에 요청할 배치 수(1=기존 순차). 2~4 권장, 429 시 1로 낮춤. */
  parallelTickerBatches?: number;
  /** DEBUG_LIVE_DATA_SOURCE / DEBUG_TICKER_RATE_LIMIT 로깅용 호출자 라벨. */
  debugCaller?: string;
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
const UPBIT_MARKET_CACHE_TTL_MS = Number(process.env.UPBIT_MARKET_CACHE_TTL_MS ?? 10 * 60_000);
const UPBIT_INVALID_MARKET_TTL_MS = Number(process.env.UPBIT_INVALID_MARKET_TTL_MS ?? 20 * 60_000);

const candleCache = new Map<string, CandleCacheEntry>();
const candleInFlight = new Map<string, Promise<UpbitCandle[]>>();
const candleCooldownUntilMs = new Map<string, number>();
let candleGlobalCooldownUntilMs = 0;
const candle429LastLogAtMs = new Map<string, number>();

let candleHttpFetchesSinceLastLog = 0;
let candleCacheHitsSinceLastLog = 0;
let candleStaleServedSinceLastLog = 0;
let candleLastStatsLogAtMs = 0;
let validKrwMarketsCache: Set<string> | null = null;
let validKrwMarketsFetchedAtMs = 0;
const invalidMarketUntilMs = new Map<string, number>();
const invalidMarketLoggedOnce = new Set<string>();
const excludedByValidSetLoggedOnce = new Set<string>();

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

async function fetchJson<T>(path: string, signal?: AbortSignal, timeoutMs = 8000): Promise<T> {
  const url = `${UPBIT}${path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => ctrl.abort());
  }

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      throw new UpbitHttpError(`Upbit ${path} → ${r.status}: ${text.slice(0, 200)}`, r.status, path);
    }
    return (await r.json()) as Promise<T>;
  } finally {
    clearTimeout(tid);
  }
}

function is404MarketError(err: unknown): boolean {
  return err instanceof UpbitHttpError && err.status === 404;
}

function logInvalidOnce(market: string, reason: string) {
  if (invalidMarketLoggedOnce.has(market)) return;
  invalidMarketLoggedOnce.add(market);
  console.warn(`[upbit-market] excluded_invalid market=${market} reason=${reason}`);
}

function markInvalidMarket(market: string) {
  const until = Date.now() + UPBIT_INVALID_MARKET_TTL_MS;
  invalidMarketUntilMs.set(market, until);
  validKrwMarketsCache?.delete(market);
  logInvalidOnce(market, "upbit_404");
}

function isInvalidMarketBlocked(market: string): boolean {
  const until = invalidMarketUntilMs.get(market) ?? 0;
  if (until <= 0) return false;
  if (Date.now() >= until) {
    invalidMarketUntilMs.delete(market);
    return false;
  }
  return true;
}

async function getValidKrwMarkets(): Promise<Set<string>> {
  const now = Date.now();
  if (validKrwMarketsCache && now - validKrwMarketsFetchedAtMs < UPBIT_MARKET_CACHE_TTL_MS) {
    return validKrwMarketsCache;
  }
  try {
    const rows = await fetchJson<Array<{ market: string }>>("/v1/market/all?isDetails=false");
    const set = new Set(rows.map((r) => r.market).filter((m) => m.startsWith("KRW-")));
    validKrwMarketsCache = set;
    validKrwMarketsFetchedAtMs = now;
    return set;
  } catch {
    return validKrwMarketsCache ?? new Set<string>();
  }
}

async function sanitizeKrwMarkets(markets: string[]): Promise<string[]> {
  const uniq = Array.from(new Set(markets)).filter((m) => m.startsWith("KRW-"));
  if (uniq.length === 0) return [];
  const valid = await getValidKrwMarkets();
  const out: string[] = [];
  for (const m of uniq) {
    if (isInvalidMarketBlocked(m)) {
      logInvalidOnce(m, "blacklist_ttl");
      continue;
    }
    // valid set 확보 실패 시 fail-close로 API 호출 차단 (404/429 악화 방지)
    if (valid.size === 0) continue;
    if (!valid.has(m)) {
      if (!excludedByValidSetLoggedOnce.has(m)) {
        excludedByValidSetLoggedOnce.add(m);
        console.warn(`[upbit-market] excluded_not_in_valid_set market=${m}`);
      }
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Upbit `/v1/market/all` 기준 유효 KRW 마켓만 통과.
 * 유효 셋을 아직 못 가져온 경우(skippedBecauseUnknown)에는 호출부에서 맵을 비우지 말고 그대로 둔다.
 */
export async function partitionKrwMarketsByUpbitValidity(
  markets: string[],
): Promise<{ accepted: string[]; rejected: string[]; skippedBecauseUnknown: boolean }> {
  const uniq = Array.from(new Set(markets)).filter((m) => m.startsWith("KRW-"));
  if (uniq.length === 0) return { accepted: [], rejected: [], skippedBecauseUnknown: false };
  const valid = await getValidKrwMarkets();
  if (valid.size === 0) {
    return { accepted: uniq, rejected: [], skippedBecauseUnknown: true };
  }
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const m of uniq) {
    if (isInvalidMarketBlocked(m)) {
      rejected.push(m);
      continue;
    }
    if (!valid.has(m)) {
      rejected.push(m);
      continue;
    }
    accepted.push(m);
  }
  return { accepted, rejected, skippedBecauseUnknown: false };
}

/** Newest candle first — reverse to oldest-first for indicators. */
export async function fetchMinuteCandles(
  market: string,
  unit: 1 | 5 | 15,
  count: number,
  signal?: AbortSignal,
): Promise<UpbitCandle[]> {
  const validMarkets = await sanitizeKrwMarkets([market]);
  if (validMarkets.length === 0) return [];
  const key = candleKey(market, unit, count);
  const nowMs = Date.now();
  maybeLogCandleCacheStats(nowMs);
  const circuitOpenUntil = candleCircuitOpenUntilByKey.get(key) ?? 0;
  if (nowMs < circuitOpenUntil) {
    const cachedOnCircuit = candleCache.get(key);
    if (cachedOnCircuit) return cachedOnCircuit.value;
    return [];
  }

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
        const rows = await fetchJson<UpbitCandle[]>(path, signal);
        const value = [...rows].reverse();
        const fetchedAtMs = Date.now();
        candleFailureCountByKey.delete(key);
        candleCircuitOpenUntilByKey.delete(key);
        candleHttpFetchesSinceLastLog += 1;
        candleCache.set(key, {
          value,
          fetchedAtMs,
          expiresAtMs: fetchedAtMs + CANDLE_CACHE_TTL_MS,
          staleUntilMs: fetchedAtMs + CANDLE_CACHE_TTL_MS + CANDLE_CACHE_STALE_GRACE_MS,
        });
        return value;
      } catch (e) {
        if (is404MarketError(e)) {
          markInvalidMarket(market);
          return [];
        }
        const failCount = (candleFailureCountByKey.get(key) ?? 0) + 1;
        candleFailureCountByKey.set(key, failCount);
        if (failCount >= UPBIT_FETCH_CIRCUIT_BREAKER_FAIL_THRESHOLD) {
          const circuitUntil = Date.now() + UPBIT_FETCH_CIRCUIT_BREAKER_COOLDOWN_MS;
          candleCircuitOpenUntilByKey.set(key, circuitUntil);
          maybeLogRateLimitedFailure(
            candleFailureLastLogAtMs,
            key,
            `[upbit-candle] circuit_open market=${market} unit=${unit} count=${count} fails=${failCount} cooldown_ms=${UPBIT_FETCH_CIRCUIT_BREAKER_COOLDOWN_MS}`,
          );
          const cachedOnFailure = candleCache.get(key);
          if (cachedOnFailure) return cachedOnFailure.value;
          return [];
        }
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

/** 콤마 구분. signal-monitor 전용 — live `DEBUG_INCLUDE_UNIVERSE_MARKETS`와 별도. */
function parseSignalMonitorExtraMarketsFromEnv(): string[] {
  const raw = String(process.env.ORBITALPHA_SIGNAL_MONITOR_EXTRA_MARKETS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.startsWith("KRW-"));
}

/**
 * signal-monitor 감시 목록. 기본은 MVP 4종 + env로 추가(유효 마켓만 통과 시 prune).
 * Upbit market/all를 아직 못 받은 경우에는 prune 생략(fail-open).
 */
export async function resolveWatchMarkets(excluded: readonly string[] = []): Promise<string[]> {
  const ex = new Set(excluded);
  const base = getMvpWatchMarkets(excluded);
  const extra = parseSignalMonitorExtraMarketsFromEnv().filter((m) => !ex.has(m));
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const m of [...base, ...extra]) {
    if (seen.has(m)) continue;
    seen.add(m);
    merged.push(m);
  }
  const part = await partitionKrwMarketsByUpbitValidity(merged);
  if (part.skippedBecauseUnknown) {
    return merged;
  }
  if (part.rejected.length > 0) {
    console.warn(
      JSON.stringify({
        tag: "DEBUG_SIGNAL_MONITOR_WATCHLIST_PRUNED_INVALID",
        rejected: part.rejected,
        accepted: part.accepted,
      }),
    );
  }
  return part.accepted;
}

function numTradePrice(v: unknown): number {
  const p = Number(v);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

const TICKER_MAX_MARKETS_PER_TICK = Number(process.env.UPBIT_TICKER_MAX_MARKETS_PER_TICK ?? 25);
const TICKER_BATCH_SIZE = Number(process.env.UPBIT_TICKER_BATCH_SIZE ?? 15);
const TICKER_BATCH_DELAY_MS = Number(process.env.UPBIT_TICKER_BATCH_DELAY_MS ?? 400); // 배치 간 간격 대폭 축소
const TICKER_429_MAX_ATTEMPTS = Number(process.env.UPBIT_TICKER_429_MAX_ATTEMPTS ?? 1); // 기본: 재시도 없음(429 과호출 방지)
const TICKER_429_RETRY_DELAY_MS = Number(process.env.UPBIT_TICKER_429_RETRY_DELAY_MS ?? 3_000); // 재시도 시 최소 대기

// ticker REST 과호출/429 완화를 위한 공용 캐시/쿨다운 (프로세스 내).
const TICKER_CACHE_TTL_MS = Number(process.env.UPBIT_TICKER_CACHE_TTL_MS ?? 12_000); // 8~15s 권장
const TICKER_CACHE_STALE_GRACE_MS = Number(process.env.UPBIT_TICKER_CACHE_STALE_GRACE_MS ?? 30_000); // 429 시 마지막 값 서빙
const TICKER_429_COOLDOWN_MS = Number(process.env.UPBIT_TICKER_429_COOLDOWN_MS ?? 20_000); // 10~30s 권장
const TICKER_429_LOG_INTERVAL_MS = Number(process.env.UPBIT_TICKER_429_LOG_INTERVAL_MS ?? 60_000);
const UPBIT_FETCH_CIRCUIT_BREAKER_FAIL_THRESHOLD = Math.max(1, Number(process.env.UPBIT_FETCH_CIRCUIT_BREAKER_FAIL_THRESHOLD ?? 3));
const UPBIT_FETCH_CIRCUIT_BREAKER_COOLDOWN_MS = Math.max(1_000, Number(process.env.UPBIT_FETCH_CIRCUIT_BREAKER_COOLDOWN_MS ?? 60_000));
const UPBIT_FETCH_FAILURE_LOG_INTERVAL_MS = Math.max(1_000, Number(process.env.UPBIT_FETCH_FAILURE_LOG_INTERVAL_MS ?? 30_000));

type TickerCacheEntry = {
  value: UpbitTicker;
  fetchedAtMs: number;
  expiresAtMs: number;
  staleUntilMs: number;
};

const tickerCache = new Map<string, TickerCacheEntry>();
const tickerCooldownUntilMs = new Map<string, number>();
const ticker429LastLogAtMs = new Map<string, number>();
const tickerFailureCountByMarket = new Map<string, number>();
const tickerCircuitOpenUntilByMarket = new Map<string, number>();
const tickerFailureLastLogAtMs = new Map<string, number>();

function tickerDebugEnabled(): boolean {
  return (
    process.env.UPBIT_TICKER_DEBUG === "1" ||
    (process.env.DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    (process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true"
  );
}

function maybeLogTicker429(nowMs: number, payload: Record<string, unknown>) {
  const key = String(payload["cooldown_key"] ?? "global");
  const last = ticker429LastLogAtMs.get(key) ?? 0;
  if (nowMs - last < TICKER_429_LOG_INTERVAL_MS) return;
  ticker429LastLogAtMs.set(key, nowMs);
  console.info(JSON.stringify({ tag: "DEBUG_TICKER_RATE_LIMIT", ts: new Date().toISOString(), ...payload }));
}

const ticker24hVolumeHintByMarket = new Map<string, number>();
const candleFailureCountByKey = new Map<string, number>();
const candleCircuitOpenUntilByKey = new Map<string, number>();
const candleFailureLastLogAtMs = new Map<string, number>();

function maybeLogRateLimitedFailure(lastLogMap: Map<string, number>, key: string, message: string): void {
  const now = Date.now();
  const last = lastLogMap.get(key) ?? 0;
  if (now - last < UPBIT_FETCH_FAILURE_LOG_INTERVAL_MS) return;
  lastLogMap.set(key, now);
  console.warn(message);
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchTickerBatchGroup(group: string[]): Promise<UpbitTicker[]> {
  const out: UpbitTicker[] = [];
  for (let attempt = 1; attempt <= Math.max(1, TICKER_429_MAX_ATTEMPTS); attempt++) {
    try {
      const rows: UpbitTicker[] = [];
      const q = encodeURIComponent(group.join(","));
      try {
        rows.push(...(await fetchJson<UpbitTicker[]>(`/v1/ticker?markets=${q}`)));
      } catch (batchErr) {
        if (!is404MarketError(batchErr)) throw batchErr;
        for (const market of group) {
          try {
            const sq = encodeURIComponent(market);
            const one = await fetchJson<UpbitTicker[]>(`/v1/ticker?markets=${sq}`);
            rows.push(...one);
          } catch (singleErr) {
            if (is404MarketError(singleErr)) {
              markInvalidMarket(market);
              continue;
            }
            throw singleErr;
          }
        }
      }
      const mapped = rows.map((r) => ({
        ...r,
        trade_price: numTradePrice((r as { trade_price?: unknown }).trade_price),
      }));
      for (const t of mapped) {
        ticker24hVolumeHintByMarket.set(t.market, Number(t.acc_trade_price_24h ?? 0));
        tickerFailureCountByMarket.delete(t.market);
        tickerCircuitOpenUntilByMarket.delete(t.market);
      }
      out.push(...mapped);
      break;
    } catch (e) {
      const status = e instanceof UpbitHttpError ? e.status : undefined;
      const is429 = status === 429 || (e instanceof Error && e.message.includes("429"));
      if (is429) {
        const now = Date.now();
        for (const m of group) tickerCooldownUntilMs.set(m, now + TICKER_429_COOLDOWN_MS);
        if (tickerDebugEnabled()) {
          maybeLogTicker429(now, {
            cooldown_key: `batch:${group.length}`,
            markets: group,
            status: status ?? 429,
            retry_count: attempt,
            cooldown_ms: TICKER_429_COOLDOWN_MS,
            cache_fallback_used: group.some((m) => {
              const c = tickerCache.get(m);
              return Boolean(c && now <= c.staleUntilMs);
            }),
          });
        }
      }
      if (!is429 || attempt >= Math.max(1, TICKER_429_MAX_ATTEMPTS)) {
        for (const market of group) {
          const failCount = (tickerFailureCountByMarket.get(market) ?? 0) + 1;
          tickerFailureCountByMarket.set(market, failCount);
          if (failCount >= UPBIT_FETCH_CIRCUIT_BREAKER_FAIL_THRESHOLD) {
            tickerCircuitOpenUntilByMarket.set(market, Date.now() + UPBIT_FETCH_CIRCUIT_BREAKER_COOLDOWN_MS);
          }
        }
        maybeLogRateLimitedFailure(
          tickerFailureLastLogAtMs,
          `batch:${group.join(",")}`,
          `[upbit-ticker] batch_failed markets=${group.length} attempt=${attempt} status=${status ?? "unknown"} error=${e instanceof Error ? e.message : String(e)}`,
        );
        break;
      }
      const retryDelay = TICKER_429_RETRY_DELAY_MS * attempt;
      await sleep(retryDelay);
    }
  }
  return out;
}

export async function fetchTickers(markets: string[], opts?: FetchTickersOptions): Promise<UpbitTicker[]> {
  if (markets.length === 0) return [];
  const sanitized = await sanitizeKrwMarkets(markets);
  if (sanitized.length === 0) return [];
  const now0 = Date.now();
  const dbgOn = tickerDebugEnabled();
  const sourceByMarket = new Map<string, "live" | "cache" | "fallback" | "cooldown_skip">();
  const ageByMarketMs = new Map<string, number>();
  const maxCap = opts?.maxMarkets ?? TICKER_MAX_MARKETS_PER_TICK;
  const ordered =
    opts?.sortByCached24hVolume === false
      ? [...sanitized]
      : [...sanitized].sort((a, b) => (ticker24hVolumeHintByMarket.get(b) ?? 0) - (ticker24hVolumeHintByMarket.get(a) ?? 0));
  const limited =
    maxCap >= ordered.length ? ordered : ordered.slice(0, Math.max(1, maxCap));

  // 1) TTL 캐시 먼저 반영 → TTL 내 중복 호출 제거.
  const needFetch: string[] = [];
  const cachedOut: UpbitTicker[] = [];
  for (const m of limited) {
    const c = tickerCache.get(m);
    const circuitOpenUntil = tickerCircuitOpenUntilByMarket.get(m) ?? 0;
    if (circuitOpenUntil > now0) {
      if (c) {
        cachedOut.push(c.value);
        sourceByMarket.set(m, "fallback");
        ageByMarketMs.set(m, now0 - c.fetchedAtMs);
      } else {
        sourceByMarket.set(m, "cooldown_skip");
      }
      continue;
    }
    if (c && now0 <= c.expiresAtMs) {
      cachedOut.push(c.value);
      sourceByMarket.set(m, "cache");
      ageByMarketMs.set(m, now0 - c.fetchedAtMs);
      continue;
    }
    // 2) 429 쿨다운 중이면, stale grace 내 캐시가 있으면 fallback, 없으면 스킵(호출 억제)
    const cd = tickerCooldownUntilMs.get(m) ?? 0;
    if (cd > now0) {
      if (c && now0 <= c.staleUntilMs) {
        cachedOut.push(c.value);
        sourceByMarket.set(m, "fallback");
        ageByMarketMs.set(m, now0 - c.fetchedAtMs);
      } else {
        sourceByMarket.set(m, "cooldown_skip");
      }
      continue;
    }
    needFetch.push(m);
  }
  const batchSize = Math.max(1, opts?.batchSize ?? TICKER_BATCH_SIZE);
  const batchDelayMs = opts?.batchDelayMs ?? TICKER_BATCH_DELAY_MS;
  const parallelTickerBatches = Math.max(1, Math.min(20, opts?.parallelTickerBatches ?? 1));
  const batches = chunk(needFetch, batchSize);

  const out: UpbitTicker[] = [...cachedOut];
  for (let i = 0; i < batches.length; i += parallelTickerBatches) {
    const slice = batches.slice(i, i + parallelTickerBatches);
    const results = await Promise.all(slice.map((g) => fetchTickerBatchGroup(g)));
    for (const r of results) {
      for (const t of r) {
        const now = Date.now();
        tickerCache.set(t.market, {
          value: t,
          fetchedAtMs: now,
          expiresAtMs: now + TICKER_CACHE_TTL_MS,
          staleUntilMs: now + TICKER_CACHE_TTL_MS + TICKER_CACHE_STALE_GRACE_MS,
        });
        sourceByMarket.set(t.market, "live");
        ageByMarketMs.set(t.market, 0);
      }
      out.push(...r);
    }
    if (i + parallelTickerBatches < batches.length) {
      await sleep(Math.max(0, batchDelayMs));
    }
  }

  if (dbgOn) {
    // 호출자가 live-strategy인 경우, 심볼별 데이터 소스/age를 남겨 “429로 미평가 vs 신호부족”을 구분 가능하게 함.
    for (const m of limited) {
      const src = sourceByMarket.get(m);
      if (!src) continue;
      const age = ageByMarketMs.get(m) ?? null;
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_DATA_SOURCE",
          ts: new Date().toISOString(),
          symbol: m,
          ticker_source: src,
          ticker_age_ms: age,
          caller: opts?.debugCaller ?? null,
        }),
      );
    }
  }
  return out;
}

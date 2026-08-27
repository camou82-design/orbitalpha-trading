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
  /** 라이브 틱 취소 시 진행 중인 ticker 배치가 길게 붙잡히지 않도록 전달. */
  signal?: AbortSignal;
  /** 각 ticker 배치(Upbit /v1/ticker 호출 단위)의 하드 타임아웃(ms). */
  batchTimeoutMs?: number;
  /** 전체 fetchTickers 호출의 하드 예산(ms). 초과 시 남은 배치는 드랍하고 현재까지 결과만 반환. */
  totalTimeoutMs?: number;
  /** 실제 보유잔고/관리종목 조회 여부 (우선순위 큐 락 선점용) */
  isPriority?: boolean;
  /** 캐시를 무시하고 최신 REST API로 강제 조회할지 여부 */
  forceRefresh?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
const candleInFlightStartedAtMs = new Map<string, number>();
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

/** 단일 Upbit REST 호출 상한 — racePhase보다 짧으면 underlying fetch가 먼저 끊겨 candidate_meta가 불필요하게 timeout 된다. */
const UPBIT_CANDLE_HTTP_TIMEOUT_MS = Math.max(8_000, Number(process.env.UPBIT_CANDLE_HTTP_TIMEOUT_MS ?? 24_000));

/**
 * 프로세스 공유 캔들 캐시 조회(HTTP 없음). live-strategy candidate_meta / precheck 등에서 최근 정상 캔들 우선에 사용.
 */
export function peekMinuteCandleCache(
  market: string,
  unit: 1 | 5 | 15,
  count: number,
): { rows: UpbitCandle[]; age_ms: number; expires_at_ms: number; stale_until_ms: number } | null {
  const key = candleKey(market, unit, count);
  const c = candleCache.get(key);
  if (!c?.value?.length) return null;
  const now = Date.now();
  return {
    rows: c.value,
    age_ms: now - c.fetchedAtMs,
    expires_at_ms: c.expiresAtMs,
    stale_until_ms: c.staleUntilMs,
  };
}

function maybeLogCandleCacheStats(nowMs: number) {
  if (nowMs - candleLastStatsLogAtMs < CANDLE_CACHE_STATS_LOG_INTERVAL_MS) return;
  if (candleLastStatsLogAtMs !== 0 && candleHttpFetchesSinceLastLog + candleCacheHitsSinceLastLog + candleStaleServedSinceLastLog === 0) {
    candleLastStatsLogAtMs = nowMs;
    return;
  }
  candleLastStatsLogAtMs = nowMs;
  console.log(
    `[upbit-candles][stats] http_calls=${candleHttpFetchesSinceLastLog} cache_hits=${candleCacheHitsSinceLastLog} stale_served=${candleStaleServedSinceLastLog} inFlight=${candleInFlight.size} inFlight_keys=${Array.from(candleInFlight.keys()).join(",")}`,
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
  const t0 = Date.now();
  const url = `${UPBIT}${path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

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
  } catch (e) {
    if (ctrl.signal.aborted && !signal?.aborted && Date.now() - t0 >= timeoutMs) {
      // Local timeout
      (e as any).isUpbitHttpTimeout = true;
    }
    throw e;
  } finally {
    clearTimeout(tid);
    if (signal) signal.removeEventListener("abort", onAbort);
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

export type FetchMinuteCandlesOptions = {
  /** fetchJson(HTTP) 하드 타임아웃 — 미지정 시 UPBIT_CANDLE_HTTP_TIMEOUT_MS */
  httpTimeoutMs?: number;
};

/** Newest candle first — reverse to oldest-first for indicators. */
export async function fetchMinuteCandles(
  market: string,
  unit: 1 | 5 | 15,
  count: number,
  signal?: AbortSignal,
  opts?: FetchMinuteCandlesOptions,
): Promise<UpbitCandle[]> {
  const t0_overall = Date.now();
  const validMarkets = await sanitizeKrwMarkets([market]);
  if (validMarkets.length === 0) return [];
  const key = candleKey(market, unit, count);
  const nowMs = Date.now();
  maybeLogCandleCacheStats(nowMs);

  // 0) inFlight stale purge (hard defense)
  const MAX_INFLIGHT_DURATION_MS = 120_000;
  for (const [k, startedAt] of candleInFlightStartedAtMs.entries()) {
    if (nowMs - startedAt > MAX_INFLIGHT_DURATION_MS) {
      console.warn(`[upbit-candles][inFlight] force_purge_stale key=${k} age_ms=${nowMs - startedAt}`);
      console.info(JSON.stringify({
        tag: "UPBIT_CANDLE_INFLIGHT_STALE_PURGE",
        ts: new Date().toISOString(),
        key: k,
        age_ms: nowMs - startedAt,
        inFlight_size: candleInFlight.size
      }));
      candleInFlight.delete(k);
      candleInFlightStartedAtMs.delete(k);
    }
  }

  const circuitOpenUntil = candleCircuitOpenUntilByKey.get(key) ?? 0;
  if (nowMs < circuitOpenUntil) {
    const cachedOnCircuit = candleCache.get(key);
    if (cachedOnCircuit) {
      console.info(JSON.stringify({
        tag: "CANDIDATE_META_DATA_SOURCE_PROOF",
        market, unit, count, key,
        result_source: "stale_served",
        final_reason: "circuit_breaker_open",
        cache_age_ms: nowMs - cachedOnCircuit.fetchedAtMs,
        inFlight_size: candleInFlight.size
      }));
      return cachedOnCircuit.value;
    }
    return [];
  }

  const cached = candleCache.get(key);
  if (cached) {
    if (nowMs <= cached.expiresAtMs) {
      candleCacheHitsSinceLastLog += 1;
      console.info(JSON.stringify({
        tag: "UPBIT_CANDLE_CACHE_HIT",
        market, unit, count, key,
        cache_age_ms: nowMs - cached.fetchedAtMs
      }));
      return cached.value;
    }
    // fresh TTL 지났더라도, 429 쿨다운 중이면 마지막 값을 재사용할 수 있도록 허용.
    const cooldownUntilMs = candleCooldownUntilMs.get(key) ?? 0;
    if (nowMs <= cached.staleUntilMs && (nowMs < cooldownUntilMs || nowMs < candleGlobalCooldownUntilMs)) {
      candleStaleServedSinceLastLog += 1;
      console.info(JSON.stringify({
        tag: "UPBIT_CANDLE_STALE_SERVED",
        market, unit, count, key,
        reason: "cooldown_active",
        cache_age_ms: nowMs - cached.fetchedAtMs
      }));
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
        await sleepAbortable(left, signal);
      }

      const globalLeft = candleGlobalCooldownUntilMs - Date.now();
      if (globalLeft > 0) {
        await sleepAbortable(globalLeft, signal);
      }

      try {
        const path = `/v1/candles/minutes/${unit}?market=${encodeURIComponent(market)}&count=${count}`;
        const httpTimeoutMs = Math.max(5_000, opts?.httpTimeoutMs ?? UPBIT_CANDLE_HTTP_TIMEOUT_MS);
        const rows = await fetchJson<UpbitCandle[]>(path, signal, httpTimeoutMs);
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
        console.info(JSON.stringify({
          tag: "UPBIT_CANDLE_FETCH_FINAL_STATUS",
          ts: new Date().toISOString(),
          market, unit, count, key,
          result_source: "live_http",
          final_reason: "success",
          elapsed_ms: Date.now() - t0_overall,
          inFlight_size: candleInFlight.size
        }));
        return value;
      } catch (e) {
        const nowCatch = Date.now();
        const elapsed = nowCatch - t0_overall;
        
        if (e instanceof DOMException && e.name === "AbortError") {
          console.info(JSON.stringify({
            tag: "UPBIT_CANDLE_ABORTED",
            market, unit, count, key,
            elapsed_ms: elapsed,
            inFlight_size: candleInFlight.size
          }));
          throw e;
        }

        if ((e as any).isUpbitHttpTimeout) {
          console.info(JSON.stringify({
            tag: "UPBIT_CANDLE_HTTP_TIMEOUT",
            market, unit, count, key,
            timeout_ms: opts?.httpTimeoutMs ?? UPBIT_CANDLE_HTTP_TIMEOUT_MS,
            elapsed_ms: elapsed,
            inFlight_size: candleInFlight.size
          }));
        }

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
          const cooldownUntilMs2 = nowCatch + CANDLE_429_COOLDOWN_MS;
          candleCooldownUntilMs.set(key, cooldownUntilMs2);
          candleGlobalCooldownUntilMs = Math.max(candleGlobalCooldownUntilMs, cooldownUntilMs2);

          maybeLog429(nowCatch, key, meta, cooldownUntilMs2, e.status);

          const cached2 = candleCache.get(key);
          if (cached2 && nowCatch <= cached2.staleUntilMs) {
            candleStaleServedSinceLastLog += 1;
            return cached2.value;
          }

          const backoffMs = Math.min(CANDLE_429_MAX_BACKOFF_MS, Math.max(CANDLE_429_MIN_BACKOFF_MS, CANDLE_429_COOLDOWN_MS * 2 ** (attempt - 1)));
          if (attempt >= CANDLE_429_MAX_ATTEMPTS) throw e;
          await sleepAbortable(backoffMs, signal);
          continue;
        }

        // For other errors (timeout, server error), try to serve stale cache if available
        const fallback = candleCache.get(key);
        if (fallback && nowCatch <= fallback.staleUntilMs) {
          console.info(JSON.stringify({
            tag: "UPBIT_CANDLE_STALE_SERVED",
            ts: new Date().toISOString(),
            market, unit, count, key,
            reason: "live_fetch_failed",
            error: e instanceof Error ? e.message : String(e),
            cache_age_ms: nowCatch - fallback.fetchedAtMs,
            inFlight_size: candleInFlight.size
          }));
          return fallback.value;
        }

        throw e;
      }
    }

    throw new Error(`Upbit candles fetch failed unexpectedly: ${market} unit=${unit} count=${count}`);
  })();

  console.info(JSON.stringify({
    tag: "UPBIT_CANDLE_INFLIGHT_SET",
    ts: new Date().toISOString(),
    market, unit, count, key,
    inFlight_size: candleInFlight.size + 1
  }));
  candleInFlight.set(key, task);
  candleInFlightStartedAtMs.set(key, nowMs);

  try {
    const res = await task;
    return res;
  } finally {
    candleInFlight.delete(key);
    candleInFlightStartedAtMs.delete(key);
    console.info(JSON.stringify({
      tag: "UPBIT_CANDLE_INFLIGHT_CLEAR",
      ts: new Date().toISOString(),
      market, unit, count, key,
      inFlight_size: candleInFlight.size,
      total_elapsed_ms: Date.now() - t0_overall
    }));
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
const TICKER_BATCH_SIZE = Number(process.env.UPBIT_TICKER_BATCH_SIZE ?? 10);
const TICKER_BATCH_DELAY_MS = Number(process.env.UPBIT_TICKER_BATCH_DELAY_MS ?? 400); // 배치 간 간격 대폭 축소
const TICKER_429_MAX_ATTEMPTS = Number(process.env.UPBIT_TICKER_429_MAX_ATTEMPTS ?? 1); // 기본: 재시도 없음(429 과호출 방지)
const TICKER_429_RETRY_DELAY_MS = Number(process.env.UPBIT_TICKER_429_RETRY_DELAY_MS ?? 3_000); // 재시도 시 최소 대기

// ticker REST 과호출/429 완화를 위한 공용 캐시/쿨다운 (프로세스 내).
const TICKER_CACHE_TTL_MS = Number(process.env.UPBIT_TICKER_CACHE_TTL_MS ?? 60_000); // 캐시 TTL 60초
const TICKER_CACHE_STALE_GRACE_MS = Number(process.env.UPBIT_TICKER_CACHE_STALE_GRACE_MS ?? 30_000); // 429 시 마지막 값 서빙
const TICKER_429_COOLDOWN_MS = Number(process.env.UPBIT_TICKER_429_COOLDOWN_MS ?? 10_000); // 10초 쿨다운
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

export const lastGoodTickerCache = new Map<string, UpbitTicker>();
export const tickerSourceMap = new Map<string, "live" | "last_good_cache" | "candle_fallback" | "missing" | "fresh_cache" | "cache">();
export const tickerAgeMap = new Map<string, number>();

const tickerCache = new Map<string, TickerCacheEntry>();
const tickerCooldownUntilMs = new Map<string, number>();
let tickerGlobalCooldownUntilMs = 0; // 429 10초 차단용 전역 쿨다운
const ticker429LastLogAtMs = new Map<string, number>();
const tickerFailureCountByMarket = new Map<string, number>();
const tickerCircuitOpenUntilByMarket = new Map<string, number>();
const tickerFailureLastLogAtMs = new Map<string, number>();

// 동시성 제어를 위한 우선순위 락 큐
export interface TickerLockOptions {
  priority?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  caller?: string;
}

interface TickerRequestTask {
  id: number;
  priority: boolean;
  caller: string;
  createdAt: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  timerId?: NodeJS.Timeout;
  abortHandler?: () => void;
  aborted: boolean;
}

const tickerQueue: TickerRequestTask[] = [];
let tickerActiveRequests = 0;
let tickerTaskIdSeq = 0;
const UPBIT_TICKER_MAX_CONCURRENCY = Number(process.env.UPBIT_TICKER_MAX_CONCURRENCY ?? 1);

function createIdempotentRelease(caller: string, acquiredAt: number): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    tickerActiveRequests = Math.max(0, tickerActiveRequests - 1);
    if (tickerDebugEnabled()) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_TICKER_LOCK_RELEASE",
          ts: new Date().toISOString(),
          caller,
          held_ms: Date.now() - acquiredAt,
          active_requests: tickerActiveRequests,
          queue_len: tickerQueue.length,
        }),
      );
    }
    processNextTickerRequest();
  };
}

export function acquireTickerLock(opts?: boolean | TickerLockOptions): Promise<() => void> {
  const options: TickerLockOptions = typeof opts === "boolean" ? { priority: opts } : (opts ?? {});
  const priority = options.priority === true;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs;
  const caller = options.caller ?? "unknown";
  const now0 = Date.now();

  // 1. 이미 취소된 signal인 경우 즉시 거부 (큐 진입 안 함)
  if (signal?.aborted) {
    if (tickerDebugEnabled()) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_TICKER_LOCK_ABORT",
          ts: new Date().toISOString(),
          caller,
          reason: "already_aborted",
          active_requests: tickerActiveRequests,
          queue_len: tickerQueue.length,
        }),
      );
    }
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  // 2. 동시성 슬롯이 남아있으면 즉시 획득
  if (tickerActiveRequests < UPBIT_TICKER_MAX_CONCURRENCY) {
    tickerActiveRequests++;
    if (tickerDebugEnabled()) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_TICKER_LOCK_ACQUIRE",
          ts: new Date().toISOString(),
          caller,
          status: "immediate",
          wait_ms: 0,
          active_requests: tickerActiveRequests,
          queue_len: tickerQueue.length,
        }),
      );
    }
    return Promise.resolve(createIdempotentRelease(caller, now0));
  }

  // 3. 대기 큐 진입
  return new Promise((resolve, reject) => {
    const taskId = ++tickerTaskIdSeq;
    const task: TickerRequestTask = {
      id: taskId,
      priority,
      caller,
      createdAt: now0,
      resolve,
      reject,
      signal,
      timeoutMs,
      aborted: false,
    };

    const cleanup = () => {
      if (task.timerId) {
        clearTimeout(task.timerId);
        task.timerId = undefined;
      }
      if (task.signal && task.abortHandler) {
        task.signal.removeEventListener("abort", task.abortHandler);
        task.abortHandler = undefined;
      }
    };

    const removeTaskFromQueue = () => {
      const idx = tickerQueue.findIndex((t) => t.id === taskId);
      if (idx !== -1) {
        tickerQueue.splice(idx, 1);
      }
    };

    if (signal) {
      task.abortHandler = () => {
        if (task.aborted) return;
        task.aborted = true;
        cleanup();
        removeTaskFromQueue();
        if (tickerDebugEnabled()) {
          console.info(
            JSON.stringify({
              tag: "DEBUG_TICKER_LOCK_ABORT",
              ts: new Date().toISOString(),
              caller,
              task_id: taskId,
              wait_ms: Date.now() - now0,
              active_requests: tickerActiveRequests,
              queue_len: tickerQueue.length,
            }),
          );
        }
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", task.abortHandler, { once: true });
    }

    if (timeoutMs !== undefined && timeoutMs !== null && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      task.timerId = setTimeout(() => {
        if (task.aborted) return;
        task.aborted = true;
        cleanup();
        removeTaskFromQueue();
        if (tickerDebugEnabled()) {
          console.info(
            JSON.stringify({
              tag: "DEBUG_TICKER_LOCK_TIMEOUT",
              ts: new Date().toISOString(),
              caller,
              task_id: taskId,
              wait_ms: Date.now() - now0,
              timeout_ms: timeoutMs,
              active_requests: tickerActiveRequests,
              queue_len: tickerQueue.length,
            }),
          );
        }
        reject(new Error(`Ticker lock acquisition timed out after ${timeoutMs}ms (caller=${caller})`));
      }, timeoutMs);
    } else if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs <= 0) {
      task.aborted = true;
      cleanup();
      reject(new Error(`Ticker lock acquisition timed out immediately (caller=${caller})`));
      return;
    }

    if (priority) {
      const firstNonPriorityIndex = tickerQueue.findIndex((t) => !t.priority);
      if (firstNonPriorityIndex !== -1) {
        tickerQueue.splice(firstNonPriorityIndex, 0, task);
      } else {
        tickerQueue.push(task);
      }
    } else {
      tickerQueue.push(task);
    }

    if (tickerDebugEnabled()) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_TICKER_LOCK_WAIT",
          ts: new Date().toISOString(),
          caller,
          task_id: taskId,
          priority,
          active_requests: tickerActiveRequests,
          queue_len: tickerQueue.length,
        }),
      );
    }
  });
}

function processNextTickerRequest() {
  while (tickerQueue.length > 0 && tickerActiveRequests < UPBIT_TICKER_MAX_CONCURRENCY) {
    const next = tickerQueue.shift();
    if (!next) break;
    if (next.aborted) continue;

    if (next.timerId) {
      clearTimeout(next.timerId);
      next.timerId = undefined;
    }
    if (next.signal && next.abortHandler) {
      next.signal.removeEventListener("abort", next.abortHandler);
      next.abortHandler = undefined;
    }

    tickerActiveRequests++;
    const now = Date.now();
    const waitMs = now - next.createdAt;
    if (tickerDebugEnabled()) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_TICKER_LOCK_ACQUIRE",
          ts: new Date().toISOString(),
          caller: next.caller,
          task_id: next.id,
          status: "queued",
          wait_ms: waitMs,
          active_requests: tickerActiveRequests,
          queue_len: tickerQueue.length,
        }),
      );
    }
    const release = createIdempotentRelease(next.caller, now);
    next.resolve(release);
    break;
  }
}

export function getTickerLockStats() {
  return {
    activeRequests: tickerActiveRequests,
    queueLength: tickerQueue.length,
    maxConcurrency: UPBIT_TICKER_MAX_CONCURRENCY,
  };
}

export function resetTickerLockStateForTest() {
  tickerActiveRequests = 0;
  tickerQueue.length = 0;
}

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

async function fetchTickerBatchGroup(args: {
  group: string[];
  signal?: AbortSignal;
  batchTimeoutMs?: number;
  debugCaller?: string;
}): Promise<UpbitTicker[]> {
  const { group, signal, batchTimeoutMs, debugCaller } = args;
  const out: UpbitTicker[] = [];
  const batchT0 = Date.now();
  const batchCtrl = new AbortController();
  const onAbort = () => batchCtrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const tid = setTimeout(() => batchCtrl.abort(), Math.max(200, batchTimeoutMs ?? 8000));
  for (let attempt = 1; attempt <= Math.max(1, TICKER_429_MAX_ATTEMPTS); attempt++) {
    try {
      if (batchCtrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const rows: UpbitTicker[] = [];
      const q = encodeURIComponent(group.join(","));
      try {
        rows.push(...(await fetchJson<UpbitTicker[]>(`/v1/ticker?markets=${q}`, batchCtrl.signal)));
      } catch (batchErr) {
        if (!is404MarketError(batchErr)) throw batchErr;
        for (const market of group) {
          try {
            const sq = encodeURIComponent(market);
            const one = await fetchJson<UpbitTicker[]>(`/v1/ticker?markets=${sq}`, batchCtrl.signal);
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
      if (batchCtrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        if (String(debugCaller ?? "").includes("pump")) {
          console.info(
            JSON.stringify({
              tag: "PUMP_SCANNER_FETCH_BATCH_TIMEOUT_PROOF",
              ts: new Date().toISOString(),
              markets_count: group.length,
              sample: group.slice(0, 12),
              elapsed_ms: Date.now() - batchT0,
              timeout_ms: Math.max(200, batchTimeoutMs ?? 8000),
              attempt,
            }),
          );
        }
        break;
      }
      const status = e instanceof UpbitHttpError ? e.status : undefined;
      const is429 = status === 429 || (e instanceof Error && e.message.includes("429"));
      if (is429) {
        const now = Date.now();
        for (const m of group) tickerCooldownUntilMs.set(m, now + TICKER_429_COOLDOWN_MS);
        tickerGlobalCooldownUntilMs = now + TICKER_429_COOLDOWN_MS; // 전역 429 쿨다운 세팅
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
      await sleepAbortable(retryDelay, batchCtrl.signal);
    }
  }
  clearTimeout(tid);
  if (signal) signal.removeEventListener("abort", onAbort);
  return out;
}

export async function fetchTickers(markets: string[], opts?: FetchTickersOptions): Promise<UpbitTicker[]> {
  if (markets.length === 0) return [];
  const sanitized = await sanitizeKrwMarkets(markets);
  if (sanitized.length === 0) return [];
  const now0 = Date.now();
  const dbgOn = tickerDebugEnabled();
  const isPriority = opts?.isPriority === true;
  
  // 글로벌 429 쿨다운 확인: 비우선순위(스캐너) 요청이고 쿨다운 중이면 REST API 호출을 원천 차단
  const isGlobalCooldown = now0 < tickerGlobalCooldownUntilMs;
  
  const maxCap = opts?.maxMarkets ?? TICKER_MAX_MARKETS_PER_TICK;
  const ordered =
    opts?.sortByCached24hVolume === false
      ? [...sanitized]
      : [...sanitized].sort((a, b) => (ticker24hVolumeHintByMarket.get(b) ?? 0) - (ticker24hVolumeHintByMarket.get(a) ?? 0));
  const limited =
    maxCap >= ordered.length ? ordered : ordered.slice(0, Math.max(1, maxCap));

  // 1) 캐시 먼저 반영
  const needFetch: string[] = [];
  const cachedOut: UpbitTicker[] = [];
  
  for (const m of limited) {
    const c = tickerCache.get(m);
    const circuitOpenUntil = tickerCircuitOpenUntilByMarket.get(m) ?? 0;
    
    if (circuitOpenUntil > now0) {
      if (c) {
        cachedOut.push(c.value);
        tickerSourceMap.set(m, "last_good_cache");
        tickerAgeMap.set(m, now0 - c.fetchedAtMs);
      } else {
        tickerSourceMap.set(m, "missing");
      }
      continue;
    }
    
    // TTL 이내의 캐시가 있으면 그것을 사용 (forceRefresh가 아닐 때만)
    if (c && now0 <= c.expiresAtMs && opts?.forceRefresh !== true) {
      cachedOut.push(c.value);
      tickerSourceMap.set(m, "fresh_cache"); // fresh cache는 live가 아닌 fresh_cache로 설정
      tickerAgeMap.set(m, now0 - c.fetchedAtMs);
      continue;
    }
    
    // 개별 마켓 쿨다운 중이거나 전역 쿨다운 중인 경우
    const cd = tickerCooldownUntilMs.get(m) ?? 0;
    if (cd > now0 || (isGlobalCooldown && !isPriority)) {
      if (c && now0 <= c.staleUntilMs) {
        cachedOut.push(c.value);
        tickerSourceMap.set(m, "last_good_cache");
        tickerAgeMap.set(m, now0 - c.fetchedAtMs);
      } else {
        // 캐시도 없으면 missing
        const lastGood = lastGoodTickerCache.get(m);
        if (lastGood) {
          cachedOut.push(lastGood);
          tickerSourceMap.set(m, "last_good_cache");
          tickerAgeMap.set(m, c ? now0 - c.fetchedAtMs : 0);
        } else {
          tickerSourceMap.set(m, "missing");
        }
      }
      continue;
    }
    
    needFetch.push(m);
  }

  // 2) REST 호출 진행 (needFetch 가 존재하는 경우)
  const out: UpbitTicker[] = [...cachedOut];
  
  if (needFetch.length > 0) {
    // 배치 크기는 최대 10개로 제한
    const batchSize = Math.max(1, Math.min(10, opts?.batchSize ?? TICKER_BATCH_SIZE));
    const batchDelayMs = opts?.batchDelayMs ?? TICKER_BATCH_DELAY_MS;
    
    // 동시성은 무조건 1로 제한
    const parallelTickerBatches = 1; 
    const batches = chunk(needFetch, batchSize);
    const tickSignal = opts?.signal;
    const totalTimeoutMs = opts?.totalTimeoutMs ?? null;
    const batchTimeoutMs = opts?.batchTimeoutMs ?? null;

    // 전체 남은 예산 계산 (락 대기 시간도 total budget에 포함)
    const elapsedSoFar = Date.now() - now0;
    const remainingBudgetMs = totalTimeoutMs !== null ? Math.max(0, totalTimeoutMs - elapsedSoFar) : undefined;
    
    // 락 획득 타임아웃: 남은 전체 예산이 있으면 그것을 상한으로, 없으면 batchTimeoutMs의 2배 또는 기본 10초
    const lockTimeoutMs = remainingBudgetMs !== undefined
      ? remainingBudgetMs
      : (batchTimeoutMs ? Math.max(2000, batchTimeoutMs * 2) : 10_000);

    let releaseLock: (() => void) | null = null;
    try {
      if (remainingBudgetMs !== undefined && remainingBudgetMs <= 0) {
        throw new Error(`fetchTickers budget expired before acquiring lock (caller=${opts?.debugCaller})`);
      }
      releaseLock = await acquireTickerLock({
        priority: isPriority,
        signal: tickSignal,
        timeoutMs: lockTimeoutMs,
        caller: opts?.debugCaller ?? "fetchTickers",
      });

      for (let i = 0; i < batches.length; i += parallelTickerBatches) {
        if (tickSignal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (totalTimeoutMs !== null && Date.now() - now0 > totalTimeoutMs) {
          break;
        }
        const slice = batches.slice(i, i + parallelTickerBatches);
        const results = await Promise.all(
          slice.map((g) =>
            fetchTickerBatchGroup({ group: g, signal: tickSignal, batchTimeoutMs: batchTimeoutMs ?? undefined, debugCaller: opts?.debugCaller }),
          ),
        );
        for (const r of results) {
          for (const t of r) {
            const now = Date.now();
            tickerCache.set(t.market, {
              value: t,
              fetchedAtMs: now,
              expiresAtMs: now + TICKER_CACHE_TTL_MS,
              staleUntilMs: now + TICKER_CACHE_TTL_MS + TICKER_CACHE_STALE_GRACE_MS,
            });
            lastGoodTickerCache.set(t.market, t); // 무기한 캐시 업데이트
            tickerSourceMap.set(t.market, "live");
            tickerAgeMap.set(t.market, 0);
          }
          out.push(...r);
        }
        if (i + parallelTickerBatches < batches.length) {
          await sleepAbortable(Math.max(0, batchDelayMs), tickSignal);
        }
      }
    } catch (fetchErr) {
      if (dbgOn) {
        console.warn(
          `[upbit-ticker] fetchTickers REST fetch aborted or failed (caller=${opts?.debugCaller}): ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        );
      }
    } finally {
      if (releaseLock) {
        releaseLock(); // 락 해제 (idempotent)
      }
    }
  }

  // 3) Fallback 보강: 요청된 limited 마켓들 중 여전히 결과 out에 없는 마켓들에 대해 순차적 fallback 적용
  for (const m of limited) {
    if (out.some((t) => t.market === m)) continue;
    
    // 3.1. lastGoodTickerCache 조회
    const lastGood = lastGoodTickerCache.get(m);
    if (lastGood) {
      out.push(lastGood);
      tickerSourceMap.set(m, "last_good_cache");
      const c = tickerCache.get(m);
      tickerAgeMap.set(m, c ? now0 - c.fetchedAtMs : 0);
      continue;
    }
    
    // 3.2. 1분 캔들 종가 fallback
    const candle = peekMinuteCandleCache(m, 1, 1);
    if (candle && candle.rows.length > 0) {
      const lastCandle = candle.rows[0];
      const fallbackTicker: UpbitTicker = {
        market: m,
        trade_price: lastCandle.trade_price,
      };
      out.push(fallbackTicker);
      tickerSourceMap.set(m, "candle_fallback");
      tickerAgeMap.set(m, now0 - candle.expires_at_ms);
      continue;
    }
    
    // 3.3. null / missing
    tickerSourceMap.set(m, "missing");
    tickerAgeMap.set(m, 0);
  }

  if (dbgOn) {
    for (const m of limited) {
      const src = tickerSourceMap.get(m);
      if (!src) continue;
      const age = tickerAgeMap.get(m) ?? null;
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

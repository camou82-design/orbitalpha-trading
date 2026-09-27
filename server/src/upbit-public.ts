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
  /** /v1/ticker/all?quote_currencies=KRW 단일 snapshot 엔드포인트 우선 사용 여부 */
  preferAllEndpoint?: boolean;
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

export type UpbitRateLimitInfo = {
  group?: string;
  minRemaining?: number;
  secRemaining?: number;
  raw?: string;
};

export function parseRemainingReqHeader(header: string | null): UpbitRateLimitInfo | null {
  if (!header) return null;
  const parts = header.split(";").map((s) => s.trim());
  let group: string | undefined;
  let minRemaining: number | undefined;
  let secRemaining: number | undefined;
  for (const part of parts) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k === "group") group = v;
    else if (k === "min") minRemaining = Number(v);
    else if (k === "sec") secRemaining = Number(v);
  }
  return { group, minRemaining, secRemaining, raw: header };
}

let lastTickerRateLimitInfo: UpbitRateLimitInfo | null = null;
let global429Count = 0;
let globalRetryCount = 0;

async function fetchJson<T>(path: string, signal?: AbortSignal, timeoutMs = 8000): Promise<T> {
  const t0 = Date.now();
  const url = `${UPBIT}${path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  const run = async (): Promise<T> => {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    const remainingReq = r.headers?.get?.("remaining-req") ?? r.headers?.get?.("Remaining-Req") ?? null;
    if (remainingReq) {
      lastTickerRateLimitInfo = parseRemainingReqHeader(remainingReq);
    }
    if (!r.ok) {
      const text = await r.text();
      throw new UpbitHttpError(`Upbit ${path} → ${r.status}: ${text.slice(0, 200)}`, r.status, path);
    }
    return (await r.json()) as T;
  };

  let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const hardTimeoutP = new Promise<never>((_, reject) => {
    hardTimeoutId = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Upbit fetch hard timeout ${path} (${timeoutMs}ms)`));
    }, timeoutMs + 50);
  });

  try {
    return await Promise.race([run(), hardTimeoutP]);
  } catch (e) {
    if (ctrl.signal.aborted && !signal?.aborted && Date.now() - t0 >= timeoutMs) {
      (e as { isUpbitHttpTimeout?: boolean }).isUpbitHttpTimeout = true;
    }
    throw e;
  } finally {
    if (hardTimeoutId) clearTimeout(hardTimeoutId);
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
const TICKER_429_MAX_ATTEMPTS = Math.max(1, Number(process.env.UPBIT_TICKER_429_MAX_ATTEMPTS ?? 2)); // 기본 2회 (1회 재시도)
const TICKER_429_RETRY_DELAY_MS = Math.max(200, Number(process.env.UPBIT_TICKER_429_RETRY_DELAY_MS ?? 1_000)); // 재시도 시 최소 대기

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

export type TickerSource = "live" | "last_good_cache" | "candle_fallback" | "missing" | "fresh_cache" | "cache";

export type TickerMeta = {
  source: TickerSource;
  ageMs: number;
  fetchedAtMs: number;
};

export type FetchTickersWithMetaResult = {
  tickers: UpbitTicker[];
  metaByMarket: Map<string, TickerMeta>;
  fetchedLiveCount: number;
  freshCacheCount: number;
  staleFallbackCount: number;
  missingCount: number;
  momentumEligibleCount: number;
  maxTickerAgeMs: number;
  oldestTickerAgeMs: number;
  lockWaitMs: number;
  actualParallel: number;
  configuredParallel: number;
  budgetExpired: boolean;
};

export function isFreshForMomentum(meta: TickerMeta | undefined, maxAgeMs: number = 60_000): boolean {
  if (!meta || typeof meta.source !== "string" || !meta.source) return false;
  if (meta.source === "live") return true;
  if (meta.source === "fresh_cache" || meta.source === "cache") {
    return typeof meta.ageMs === "number" && Number.isFinite(meta.ageMs) && meta.ageMs >= 0 && meta.ageMs <= maxAgeMs;
  }
  // Strict allowlist: "last_good_cache", "candle_fallback", "missing" and any unknown are strictly denied
  return false;
}

export const lastGoodTickerCache = new Map<string, UpbitTicker>();
export const lastGoodTickerFetchedAtMap = new Map<string, number>();
export const tickerSourceMap = new Map<string, "live" | "last_good_cache" | "candle_fallback" | "missing" | "fresh_cache" | "cache">();
export const tickerAgeMap = new Map<string, number>();

export const tickerCache = new Map<string, TickerCacheEntry>();
const tickerCooldownUntilMs = new Map<string, number>();
let tickerGlobalCooldownUntilMs = 0; // 429 10초 차단용 전역 쿨다운
const ticker429LastLogAtMs = new Map<string, number>();
const tickerFailureCountByMarket = new Map<string, number>();
const tickerCircuitOpenUntilByMarket = new Map<string, number>();
const tickerFailureLastLogAtMs = new Map<string, number>();

export function getTickerTransportStats() {
  const now = Date.now();
  let circuitOpenCount = 0;
  for (const [m, until] of tickerCircuitOpenUntilByMarket.entries()) {
    if (until > now) circuitOpenCount++;
  }
  return {
    globalCooldownActive: now < tickerGlobalCooldownUntilMs,
    globalCooldownUntilMs: tickerGlobalCooldownUntilMs,
    global429Count,
    globalRetryCount,
    circuitOpenCount,
    rateLimitInfo: lastTickerRateLimitInfo,
  };
}

export function resetTickerTransportStatsForTest() {
  tickerGlobalCooldownUntilMs = 0;
  global429Count = 0;
  globalRetryCount = 0;
  lastTickerRateLimitInfo = null;
  tickerCooldownUntilMs.clear();
  tickerFailureCountByMarket.clear();
  tickerCircuitOpenUntilByMarket.clear();
  ticker429LastLogAtMs.clear();
}

// 동시성 제어를 위한 우선순위 락 큐
export interface TickerLockOptions {
  priority?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  caller?: string;
}

export type TickerLockRelease = (() => void) & { lockId: string };

interface TickerRequestTask {
  id: number;
  priority: boolean;
  caller: string;
  createdAt: number;
  resolve: (release: TickerLockRelease) => void;
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
let tickerLockIdSeq = 0;
/** Distinguishes in-process runtime recurrence vs post-restart clean slate (in-memory lock state resets on exit). */
const TICKER_LOCK_RUNTIME_ID = `${process.pid}-${Date.now()}`;
const UPBIT_TICKER_MAX_CONCURRENCY = Number(process.env.UPBIT_TICKER_MAX_CONCURRENCY ?? 1);
let consecutivePriorityGrants = 0;
const MAX_CONSECUTIVE_PRIORITY_GRANTS = Number(process.env.UPBIT_TICKER_MAX_CONSECUTIVE_PRIORITY_GRANTS ?? 2);
const NORMAL_STARVATION_THRESHOLD_MS = Number(process.env.UPBIT_TICKER_NORMAL_STARVATION_THRESHOLD_MS ?? 1500);
/** Legitimate ticker HTTP + batch work upper bound; exceeded => orphaned holder recovery (not waiter timeout inflation). */
const TICKER_LOCK_MAX_HOLD_MS = Math.max(
  8_000,
  Number(process.env.UPBIT_TICKER_LOCK_MAX_HOLD_MS ?? 45_000),
);
const TICKER_LOCK_LONG_HOLD_THRESHOLDS_MS = [10_000, 20_000, 30_000] as const;
const TICKER_LOCK_LIFECYCLE_MAX = Math.max(50, Number(process.env.UPBIT_TICKER_LOCK_LIFECYCLE_MAX ?? 200));

type TickerLockReleasePath = "normal" | "force" | "desync" | "pending";

type TickerLockHolderState = {
  lock_id: string;
  caller: string;
  acquired_at: number;
  release_at: number | null;
  hold_ms: number | null;
  priority: boolean;
  waiter_task_id?: number;
  source_hint: string;
  release: TickerLockRelease;
  long_hold_timer_ids: ReturnType<typeof setTimeout>[];
  long_hold_logged: Set<number>;
};

export type TickerLockLifecycleEntry = {
  lock_id: string;
  runtime_id: string;
  caller: string;
  priority: boolean;
  acquired_at: number;
  release_at: number | null;
  hold_ms: number | null;
  released: boolean;
  release_path: TickerLockReleasePath;
  source_hint: string;
  force_recovered: boolean;
};

let tickerLockHolder: TickerLockHolderState | null = null;
const tickerLockLifecycleById = new Map<string, TickerLockLifecycleEntry>();
const tickerLockLifecycleOrder: string[] = [];
let tickerLockForceRecoveryTotal = 0;
const tickerLockForceRecoveryByCaller = new Map<string, number>();
const tickerLockLongHoldCountByCaller = new Map<string, { t10: number; t20: number; t30: number }>();
let tickerLockReleasePathOverride: TickerLockReleasePath | null = null;

function nextTickerLockId(): string {
  tickerLockIdSeq += 1;
  return `tl-${TICKER_LOCK_RUNTIME_ID}-${tickerLockIdSeq}`;
}

function captureTickerLockSourceHint(): string {
  try {
    const stack = new Error().stack ?? "";
    const lines = stack
      .split("\n")
      .slice(2, 8)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.join(" | ").slice(0, 512);
  } catch {
    return "";
  }
}

function tickerLockAuditEnabled(): boolean {
  return (
    process.env.UPBIT_TICKER_LOCK_AUDIT === "1" ||
    tickerDebugEnabled() ||
    (process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true"
  );
}

function shouldEmitTickerLockLifecycleLog(caller: string): boolean {
  return (
    tickerLockAuditEnabled() ||
    caller.includes("pump") ||
    caller.includes("exit") ||
    caller.includes("sell") ||
    caller.includes("live-strategy")
  );
}

function emitTickerLockLifecycleLog(tag: string, payload: Record<string, unknown>, caller?: string) {
  const c = String(caller ?? payload["caller"] ?? payload["waiter_caller"] ?? "");
  if (!shouldEmitTickerLockLifecycleLog(c) && !tag.includes("FORCE") && !tag.includes("DESYNC") && !tag.includes("LONG_HOLD")) {
    return;
  }
  console.info(
    JSON.stringify({
      tag,
      ts: new Date().toISOString(),
      runtime_id: TICKER_LOCK_RUNTIME_ID,
      ...payload,
    }),
  );
}

function adjustActiveRequests(delta: number, event: string, meta: Record<string, unknown>) {
  const counter_before = tickerActiveRequests;
  tickerActiveRequests = Math.max(0, counter_before + delta);
  emitTickerLockLifecycleLog("DEBUG_TICKER_LOCK_COUNTER", {
    event,
    counter_before,
    counter_after: tickerActiveRequests,
    queue_len: tickerQueue.length,
    ...meta,
  }, String(meta["caller"] ?? ""));
}

function trimTickerLockLifecycleHistory() {
  while (tickerLockLifecycleOrder.length > TICKER_LOCK_LIFECYCLE_MAX) {
    const dropId = tickerLockLifecycleOrder.shift();
    if (dropId) tickerLockLifecycleById.delete(dropId);
  }
}

function registerTickerLockLifecyclePending(entry: Omit<TickerLockLifecycleEntry, "released" | "release_path" | "force_recovered">) {
  tickerLockLifecycleById.set(entry.lock_id, {
    ...entry,
    released: false,
    release_path: "pending",
    force_recovered: false,
  });
  tickerLockLifecycleOrder.push(entry.lock_id);
  trimTickerLockLifecycleHistory();
  emitTickerLockLifecycleLog(
    "DEBUG_TICKER_LOCK_LIFECYCLE",
    { phase: "acquire_registered", lock_id: entry.lock_id, caller: entry.caller, priority: entry.priority, source_hint: entry.source_hint },
    entry.caller,
  );
}

function finalizeTickerLockLifecycle(
  lockId: string,
  releasePath: TickerLockReleasePath,
  releaseAt: number,
  holdMs: number,
  forceRecovered = false,
) {
  const row = tickerLockLifecycleById.get(lockId);
  if (!row) return;
  row.release_at = releaseAt;
  row.hold_ms = holdMs;
  row.released = releasePath !== "pending";
  row.release_path = releasePath;
  row.force_recovered = forceRecovered;
  emitTickerLockLifecycleLog(
    "DEBUG_TICKER_LOCK_LIFECYCLE",
    {
      phase: "release_finalized",
      lock_id: lockId,
      caller: row.caller,
      release_path: releasePath,
      hold_ms: holdMs,
      force_recovered: forceRecovered,
    },
    row.caller,
  );
}

function logTickerLockHolderSnapshot(extra: Record<string, unknown> = {}) {
  const now = Date.now();
  const holder = tickerLockHolder;
  return {
    lock_id: holder?.lock_id ?? null,
    holder_caller: holder?.caller ?? null,
    holder_held_ms: holder ? now - holder.acquired_at : null,
    holder_task_id: holder?.waiter_task_id ?? null,
    holder_priority: holder?.priority ?? null,
    holder_source_hint: holder?.source_hint ?? null,
    holder_acquired_at: holder?.acquired_at ?? null,
    active_requests: tickerActiveRequests,
    queue_len: tickerQueue.length,
    runtime_id: TICKER_LOCK_RUNTIME_ID,
    force_recovery_total: tickerLockForceRecoveryTotal,
    ...extra,
  };
}

function clearLongHoldTimers(holder: TickerLockHolderState) {
  for (const tid of holder.long_hold_timer_ids) {
    clearTimeout(tid);
  }
  holder.long_hold_timer_ids.length = 0;
}

function scheduleLongHoldWatchdog(holder: TickerLockHolderState) {
  for (const thresholdMs of TICKER_LOCK_LONG_HOLD_THRESHOLDS_MS) {
    const tid = setTimeout(() => {
      if (tickerLockHolder?.lock_id !== holder.lock_id) return;
      if (holder.long_hold_logged.has(thresholdMs)) return;
      holder.long_hold_logged.add(thresholdMs);
      const heldMs = Date.now() - holder.acquired_at;
      const bucketKey = thresholdMs === 10_000 ? "t10" : thresholdMs === 20_000 ? "t20" : "t30";
      const agg = tickerLockLongHoldCountByCaller.get(holder.caller) ?? { t10: 0, t20: 0, t30: 0 };
      agg[bucketKey] += 1;
      tickerLockLongHoldCountByCaller.set(holder.caller, agg);
      console.warn(
        JSON.stringify({
          ...logTickerLockHolderSnapshot(),
          tag: "DEBUG_TICKER_LOCK_LONG_HOLD",
          ts: new Date().toISOString(),
          lock_id: holder.lock_id,
          caller: holder.caller,
          priority: holder.priority,
          threshold_ms: thresholdMs,
          held_ms: heldMs,
          long_hold_count_by_caller: agg,
        }),
      );
    }, thresholdMs);
    holder.long_hold_timer_ids.push(tid);
  }
}

function registerTickerLockHolder(state: Omit<TickerLockHolderState, "long_hold_timer_ids" | "long_hold_logged">) {
  const holder: TickerLockHolderState = {
    ...state,
    long_hold_timer_ids: [],
    long_hold_logged: new Set<number>(),
  };
  tickerLockHolder = holder;
  scheduleLongHoldWatchdog(holder);
}

function clearTickerLockHolderIfMatches(release: TickerLockRelease) {
  if (tickerLockHolder?.release === release) {
    clearLongHoldTimers(tickerLockHolder);
    tickerLockHolder = null;
  }
}

function logTickerLockQueueMutation(op: "push" | "pop" | "remove", meta: Record<string, unknown>) {
  emitTickerLockLifecycleLog(`DEBUG_TICKER_LOCK_QUEUE_${op.toUpperCase()}`, meta, String(meta["caller"] ?? ""));
}

function snapshotPriorHolderForForceRecovery() {
  if (!tickerLockHolder) return null;
  const now = Date.now();
  return {
    lock_id: tickerLockHolder.lock_id,
    caller: tickerLockHolder.caller,
    priority: tickerLockHolder.priority,
    acquired_at: tickerLockHolder.acquired_at,
    held_ms: now - tickerLockHolder.acquired_at,
    source_hint: tickerLockHolder.source_hint,
    waiter_task_id: tickerLockHolder.waiter_task_id ?? null,
    lifecycle: tickerLockLifecycleById.get(tickerLockHolder.lock_id) ?? null,
  };
}

function recordForceRecovery(caller: string, priorHolder: ReturnType<typeof snapshotPriorHolderForForceRecovery>) {
  tickerLockForceRecoveryTotal += 1;
  const key = priorHolder?.caller ?? caller;
  tickerLockForceRecoveryByCaller.set(key, (tickerLockForceRecoveryByCaller.get(key) ?? 0) + 1);
}

/** Recover active_requests=1 with no progress (orphaned holder / desync). Does not extend waiter timeouts. */
export function forceRecoverStaleOrDesyncedTickerLock(reason: string): boolean {
  const now = Date.now();
  if (tickerActiveRequests <= 0 && !tickerLockHolder) {
    tickerActiveRequests = 0;
    return false;
  }

  if (tickerLockHolder) {
    const heldMs = now - tickerLockHolder.acquired_at;
    if (heldMs >= TICKER_LOCK_MAX_HOLD_MS) {
      const prior_holder = snapshotPriorHolderForForceRecovery();
      recordForceRecovery(tickerLockHolder.caller, prior_holder);
      console.warn(
        JSON.stringify({
          ...logTickerLockHolderSnapshot(),
          tag: "DEBUG_TICKER_LOCK_FORCE_RELEASE",
          ts: new Date().toISOString(),
          reason,
          held_ms: heldMs,
          max_hold_ms: TICKER_LOCK_MAX_HOLD_MS,
          prior_holder,
          force_recovery_by_caller: Object.fromEntries(tickerLockForceRecoveryByCaller.entries()),
          unreleased_lock_ids: [...tickerLockLifecycleById.values()].filter((e) => !e.released).map((e) => e.lock_id),
        }),
      );
      try {
        tickerLockReleasePathOverride = "force";
        tickerLockHolder.release();
      } catch {
        const before = tickerActiveRequests;
        tickerActiveRequests = 0;
        emitTickerLockLifecycleLog("DEBUG_TICKER_LOCK_COUNTER", {
          event: "force_release_exception_reset",
          counter_before: before,
          counter_after: 0,
          caller: prior_holder?.caller ?? "unknown",
          lock_id: prior_holder?.lock_id ?? null,
        });
        tickerLockHolder = null;
        processNextTickerRequest();
      } finally {
        tickerLockReleasePathOverride = null;
      }
      return true;
    }
  }

  if (tickerActiveRequests > 0 && !tickerLockHolder) {
    const unreleased = [...tickerLockLifecycleById.values()].filter((e) => !e.released);
    recordForceRecovery("desync", null);
    console.warn(
      JSON.stringify({
        ...logTickerLockHolderSnapshot(),
        tag: "DEBUG_TICKER_LOCK_DESYNC_RECOVER",
        ts: new Date().toISOString(),
        reason,
        unreleased_lock_ids: unreleased.map((e) => e.lock_id),
        unreleased_callers: unreleased.map((e) => e.caller),
        force_recovery_by_caller: Object.fromEntries(tickerLockForceRecoveryByCaller.entries()),
      }),
    );
    adjustActiveRequests(-tickerActiveRequests, "desync_recover_reset", { caller: "desync", lock_id: null });
    consecutivePriorityGrants = 0;
    processNextTickerRequest();
    return true;
  }

  return false;
}

function createIdempotentRelease(
  lockId: string,
  caller: string,
  acquiredAt: number,
  priority: boolean,
  sourceHint: string,
  taskId?: number,
): TickerLockRelease {
  let released = false;
  const release = (() => {
    if (released) return;
    released = true;
    const releaseAt = Date.now();
    const holdMs = releaseAt - acquiredAt;
    clearTickerLockHolderIfMatches(release);
    adjustActiveRequests(-1, "release", { caller, lock_id: lockId, hold_ms: holdMs });
    emitTickerLockLifecycleLog(
      "DEBUG_TICKER_LOCK_RELEASE",
      {
        lock_id: lockId,
        caller,
        priority,
        acquired_at: acquiredAt,
        release_at: releaseAt,
        hold_ms: holdMs,
        waiter_task_id: taskId ?? null,
        source_hint: sourceHint,
        queue_len: tickerQueue.length,
      },
      caller,
    );
    const releasePath = tickerLockReleasePathOverride ?? "normal";
    const forceRecovered = releasePath === "force" || releasePath === "desync";
    finalizeTickerLockLifecycle(lockId, releasePath, releaseAt, holdMs, forceRecovered);
    processNextTickerRequest();
  }) as TickerLockRelease;
  release.lockId = lockId;
  registerTickerLockHolder({
    lock_id: lockId,
    caller,
    acquired_at: acquiredAt,
    release_at: null,
    hold_ms: null,
    priority,
    waiter_task_id: taskId,
    source_hint: sourceHint,
    release,
  });
  return release;
}

export function getTickerLockLifecycleAuditSnapshot() {
  const now = Date.now();
  const unreleased = [...tickerLockLifecycleById.values()].filter((e) => !e.released);
  return {
    runtime_id: TICKER_LOCK_RUNTIME_ID,
    active_requests: tickerActiveRequests,
    queue_len: tickerQueue.length,
    current_holder: tickerLockHolder
      ? {
          lock_id: tickerLockHolder.lock_id,
          caller: tickerLockHolder.caller,
          priority: tickerLockHolder.priority,
          acquired_at: tickerLockHolder.acquired_at,
          held_ms: now - tickerLockHolder.acquired_at,
          source_hint: tickerLockHolder.source_hint,
        }
      : null,
    unreleased_locks: unreleased,
    force_recovery_total: tickerLockForceRecoveryTotal,
    force_recovery_by_caller: Object.fromEntries(tickerLockForceRecoveryByCaller.entries()),
    long_hold_count_by_caller: Object.fromEntries(tickerLockLongHoldCountByCaller.entries()),
    recent_lifecycle: tickerLockLifecycleOrder.slice(-20).map((id) => tickerLockLifecycleById.get(id)).filter(Boolean),
  };
}

export async function withTickerLock<T>(opts: TickerLockOptions | undefined, fn: () => Promise<T>): Promise<T> {
  const release = await acquireTickerLock(opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function acquireTickerLockMeasured(
  opts: TickerLockOptions,
  onLockWaitMs: (waitMs: number) => void,
): Promise<TickerLockRelease> {
  const t0 = Date.now();
  try {
    return await acquireTickerLock(opts);
  } finally {
    onLockWaitMs(Math.max(0, Date.now() - t0));
  }
}

export function acquireTickerLock(opts?: boolean | TickerLockOptions): Promise<TickerLockRelease> {
  const options: TickerLockOptions = typeof opts === "boolean" ? { priority: opts } : (opts ?? {});
  const priority = options.priority === true;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs;
  const caller = options.caller ?? "unknown";
  const now0 = Date.now();

  forceRecoverStaleOrDesyncedTickerLock("pre_acquire_sweep");

  // 1. 이미 취소된 signal인 경우 즉시 거부 (큐 진입 안 함)
  if (signal?.aborted) {
    emitTickerLockLifecycleLog(
      "DEBUG_TICKER_LOCK_ABORT",
      {
        lock_id: null,
        caller,
        reason: "already_aborted",
        active_requests: tickerActiveRequests,
        queue_len: tickerQueue.length,
      },
      caller,
    );
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  // 2. 동시성 슬롯이 남아있으면 즉시 획득
  if (tickerActiveRequests < UPBIT_TICKER_MAX_CONCURRENCY) {
    const lockId = nextTickerLockId();
    const sourceHint = captureTickerLockSourceHint();
    if (priority) {
      consecutivePriorityGrants++;
    } else {
      consecutivePriorityGrants = 0;
    }
    adjustActiveRequests(1, "acquire_immediate", { caller, lock_id: lockId, priority });
    registerTickerLockLifecyclePending({
      lock_id: lockId,
      runtime_id: TICKER_LOCK_RUNTIME_ID,
      caller,
      priority,
      acquired_at: now0,
      release_at: null,
      hold_ms: null,
      source_hint: sourceHint,
    });
    emitTickerLockLifecycleLog(
      "DEBUG_TICKER_LOCK_ACQUIRE",
      {
        lock_id: lockId,
        caller,
        status: "immediate",
        priority,
        consecutive_priority: consecutivePriorityGrants,
        wait_ms: 0,
        acquired_at: now0,
        source_hint: sourceHint,
        queue_len: tickerQueue.length,
      },
      caller,
    );
    return Promise.resolve(createIdempotentRelease(lockId, caller, now0, priority, sourceHint));
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
        const queue_len_before = tickerQueue.length;
        tickerQueue.splice(idx, 1);
        logTickerLockQueueMutation("remove", {
          caller,
          waiter_task_id: taskId,
          queue_len_before,
          queue_len_after: tickerQueue.length,
        });
      }
    };

    if (signal) {
      task.abortHandler = () => {
        if (task.aborted) return;
        task.aborted = true;
        cleanup();
        removeTaskFromQueue();
        emitTickerLockLifecycleLog(
          "DEBUG_TICKER_LOCK_ABORT",
          {
            ...logTickerLockHolderSnapshot(),
            lock_id: null,
            caller,
            waiter_task_id: taskId,
            wait_ms: Date.now() - now0,
            reason: "signal_abort_while_waiting",
          },
          caller,
        );
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
        console.warn(
          JSON.stringify({
            ...logTickerLockHolderSnapshot(),
            tag: "DEBUG_TICKER_LOCK_TIMEOUT",
            ts: new Date().toISOString(),
            lock_id: null,
            caller,
            waiter_task_id: taskId,
            wait_ms: Date.now() - now0,
            timeout_ms: timeoutMs,
            priority: task.priority,
            prior_holder: snapshotPriorHolderForForceRecovery(),
          }),
        );
        forceRecoverStaleOrDesyncedTickerLock(`waiter_timeout:${caller}`);
        reject(new Error(`Ticker lock acquisition timed out after ${timeoutMs}ms (caller=${caller})`));
      }, timeoutMs);
    } else if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs <= 0) {
      task.aborted = true;
      cleanup();
      reject(new Error(`Ticker lock acquisition timed out immediately (caller=${caller})`));
      return;
    }

    // Queue in FIFO order; processNextTickerRequest performs bounded fairness selection
    const queue_len_before = tickerQueue.length;
    tickerQueue.push(task);
    logTickerLockQueueMutation("push", {
      caller,
      waiter_task_id: taskId,
      priority,
      queue_len_before,
      queue_len_after: tickerQueue.length,
    });
    emitTickerLockLifecycleLog(
      "DEBUG_TICKER_LOCK_WAIT",
      {
        lock_id: null,
        caller,
        waiter_task_id: taskId,
        priority,
        active_requests: tickerActiveRequests,
        queue_len: tickerQueue.length,
      },
      caller,
    );
  });
}

function processNextTickerRequest() {
  while (tickerQueue.length > 0 && tickerActiveRequests < UPBIT_TICKER_MAX_CONCURRENCY) {
    const hasPriority = tickerQueue.some((t) => t.priority && !t.aborted);
    const hasNormal = tickerQueue.some((t) => !t.priority && !t.aborted);

    let nextIndex = -1;
    if (hasPriority && hasNormal) {
      const oldestNormalIndex = tickerQueue.findIndex((t) => !t.priority && !t.aborted);
      const oldestNormal = oldestNormalIndex !== -1 ? tickerQueue[oldestNormalIndex] : null;
      const normalWaitMs = oldestNormal ? Date.now() - oldestNormal.createdAt : 0;

      // 만약 연속 priority grant 상한에 도달했거나, normal waiter가 기아 한계 시간 이상 대기했으면 normal 우선 서비스
      if (
        consecutivePriorityGrants >= MAX_CONSECUTIVE_PRIORITY_GRANTS ||
        normalWaitMs >= NORMAL_STARVATION_THRESHOLD_MS
      ) {
        nextIndex = oldestNormalIndex;
      } else {
        nextIndex = tickerQueue.findIndex((t) => t.priority && !t.aborted);
      }
    } else if (hasPriority) {
      nextIndex = tickerQueue.findIndex((t) => t.priority && !t.aborted);
    } else {
      nextIndex = tickerQueue.findIndex((t) => !t.aborted);
    }

    if (nextIndex === -1) {
      for (let i = tickerQueue.length - 1; i >= 0; i--) {
        if (tickerQueue[i]?.aborted) {
          tickerQueue.splice(i, 1);
        }
      }
      break;
    }

    const queue_len_before = tickerQueue.length;
    const [next] = tickerQueue.splice(nextIndex, 1);
    if (next) {
      logTickerLockQueueMutation("pop", {
        caller: next.caller,
        waiter_task_id: next.id,
        queue_len_before,
        queue_len_after: tickerQueue.length,
        selected_index: nextIndex,
      });
    }
    if (!next || next.aborted) continue;

    if (next.timerId) {
      clearTimeout(next.timerId);
      next.timerId = undefined;
    }
    if (next.signal && next.abortHandler) {
      next.signal.removeEventListener("abort", next.abortHandler);
      next.abortHandler = undefined;
    }

    if (next.priority) {
      consecutivePriorityGrants++;
    } else {
      consecutivePriorityGrants = 0;
    }

    const lockId = nextTickerLockId();
    const sourceHint = captureTickerLockSourceHint();
    adjustActiveRequests(1, "acquire_from_queue", {
      caller: next.caller,
      lock_id: lockId,
      priority: next.priority,
      waiter_task_id: next.id,
    });
    const now = Date.now();
    const waitMs = now - next.createdAt;
    registerTickerLockLifecyclePending({
      lock_id: lockId,
      runtime_id: TICKER_LOCK_RUNTIME_ID,
      caller: next.caller,
      priority: next.priority,
      acquired_at: now,
      release_at: null,
      hold_ms: null,
      source_hint: sourceHint,
    });
    emitTickerLockLifecycleLog(
      "DEBUG_TICKER_LOCK_ACQUIRE",
      {
        lock_id: lockId,
        caller: next.caller,
        waiter_task_id: next.id,
        priority: next.priority,
        consecutive_priority: consecutivePriorityGrants,
        status: "queued",
        wait_ms: waitMs,
        acquired_at: now,
        source_hint: sourceHint,
        queue_len: tickerQueue.length,
      },
      next.caller,
    );
    const release = createIdempotentRelease(lockId, next.caller, now, next.priority, sourceHint, next.id);
    next.resolve(release);
    break;
  }
}

export function getTickerLockStats() {
  return {
    activeRequests: tickerActiveRequests,
    queueLength: tickerQueue.length,
    maxConcurrency: UPBIT_TICKER_MAX_CONCURRENCY,
    consecutivePriorityGrants,
    holderCaller: tickerLockHolder?.caller ?? null,
    holderLockId: tickerLockHolder?.lock_id ?? null,
    holderHeldMs: tickerLockHolder ? Date.now() - tickerLockHolder.acquired_at : null,
    runtimeId: TICKER_LOCK_RUNTIME_ID,
  };
}

export function resetTickerLockStateForTest() {
  if (tickerLockHolder) {
    clearLongHoldTimers(tickerLockHolder);
  }
  tickerActiveRequests = 0;
  tickerQueue.length = 0;
  consecutivePriorityGrants = 0;
  tickerLockHolder = null;
  tickerLockLifecycleById.clear();
  tickerLockLifecycleOrder.length = 0;
  tickerLockForceRecoveryTotal = 0;
  tickerLockForceRecoveryByCaller.clear();
  tickerLockLongHoldCountByCaller.clear();
}

/** Test-only: simulate orphaned active_requests counter without holder metadata. */
export function injectTickerLockDesyncForTest(activeRequests = 1) {
  tickerActiveRequests = Math.max(0, activeRequests);
  tickerLockHolder = null;
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
  const maxAttempts = Math.max(1, TICKER_429_MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      tickerGlobalCooldownUntilMs = 0; // 429 복구 시 전역 쿨다운 즉시 해제
      for (const t of mapped) {
        ticker24hVolumeHintByMarket.set(t.market, Number(t.acc_trade_price_24h ?? 0));
        tickerFailureCountByMarket.delete(t.market);
        tickerCircuitOpenUntilByMarket.delete(t.market);
        tickerCooldownUntilMs.delete(t.market);
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
        global429Count++;
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
            caller: debugCaller,
            cache_fallback_used: group.some((m) => {
              const c = tickerCache.get(m);
              return Boolean(c && now <= c.staleUntilMs);
            }),
          });
        }
      }
      if (!is429 || attempt >= maxAttempts) {
        // 429는 전역 transport 문제이므로 개별 마켓 서킷 브레이커(tickerFailureCountByMarket)를 오염시키지 않음.
        if (!is429) {
          for (const market of group) {
            const failCount = (tickerFailureCountByMarket.get(market) ?? 0) + 1;
            tickerFailureCountByMarket.set(market, failCount);
            if (failCount >= UPBIT_FETCH_CIRCUIT_BREAKER_FAIL_THRESHOLD) {
              tickerCircuitOpenUntilByMarket.set(market, Date.now() + UPBIT_FETCH_CIRCUIT_BREAKER_COOLDOWN_MS);
            }
          }
        }
        maybeLogRateLimitedFailure(
          tickerFailureLastLogAtMs,
          `batch:${group.join(",")}`,
          `[upbit-ticker] batch_failed markets=${group.length} attempt=${attempt} status=${status ?? "unknown"} error=${e instanceof Error ? e.message : String(e)}`,
        );
        break;
      }
      globalRetryCount++;
      const retryDelay = Math.max(300, TICKER_429_RETRY_DELAY_MS * attempt);
      await sleepAbortable(retryDelay, batchCtrl.signal);
    }
  }
  clearTimeout(tid);
  if (signal) signal.removeEventListener("abort", onAbort);
  return out;
}

export async function fetchTickersAllKrw(opts?: {
  signal?: AbortSignal;
  timeoutMs?: number;
  debugCaller?: string;
}): Promise<UpbitTicker[]> {
  const timeoutMs = Math.max(500, opts?.timeoutMs ?? 8000);
  const debugCaller = opts?.debugCaller ?? "fetchTickersAllKrw";
  const fetchT0 = Date.now();
  const maxAttempts = Math.max(1, TICKER_429_MAX_ATTEMPTS);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // Global cooldown check before attempt
    const now = Date.now();
    if (now < tickerGlobalCooldownUntilMs) {
      const remainingCd = tickerGlobalCooldownUntilMs - now;
      if (attempt > 1 && remainingCd <= 5000) {
        await sleepAbortable(remainingCd, opts?.signal);
      } else {
        throw new UpbitHttpError(`Ticker in global 429 cooldown (${remainingCd}ms remaining)`, 429, "/v1/ticker/all?quote_currencies=KRW");
      }
    }

    try {
      const rows = await fetchJson<UpbitTicker[]>("/v1/ticker/all?quote_currencies=KRW", opts?.signal, timeoutMs);
      const mapped = rows.map((r) => ({
        ...r,
        trade_price: numTradePrice((r as { trade_price?: unknown }).trade_price),
      }));

      const nowAfter = Date.now();
      tickerGlobalCooldownUntilMs = 0; // 429 복구 시 전역 쿨다운 즉시 해제
      for (const t of mapped) {
        ticker24hVolumeHintByMarket.set(t.market, Number(t.acc_trade_price_24h ?? 0));
        tickerCache.set(t.market, {
          value: t,
          fetchedAtMs: nowAfter,
          expiresAtMs: nowAfter + TICKER_CACHE_TTL_MS,
          staleUntilMs: nowAfter + TICKER_CACHE_TTL_MS + TICKER_CACHE_STALE_GRACE_MS,
        });
        lastGoodTickerCache.set(t.market, t);
        lastGoodTickerFetchedAtMap.set(t.market, nowAfter);
        tickerSourceMap.set(t.market, "live");
        tickerAgeMap.set(t.market, 0);
        tickerFailureCountByMarket.delete(t.market);
        tickerCircuitOpenUntilByMarket.delete(t.market);
        tickerCooldownUntilMs.delete(t.market);
      }
      return mapped;
    } catch (e) {
      if (opts?.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        throw e;
      }
      const status = e instanceof UpbitHttpError ? e.status : undefined;
      const is429 = status === 429 || (e instanceof Error && e.message.includes("429"));
      if (is429) {
        global429Count++;
        const nowCd = Date.now();
        tickerGlobalCooldownUntilMs = nowCd + TICKER_429_COOLDOWN_MS;
        if (tickerDebugEnabled()) {
          maybeLogTicker429(nowCd, {
            cooldown_key: "ticker_all_krw",
            status: status ?? 429,
            retry_count: attempt,
            cooldown_ms: TICKER_429_COOLDOWN_MS,
            caller: debugCaller,
          });
        }
      }
      if (!is429 || attempt >= maxAttempts) {
        throw e;
      }
      globalRetryCount++;
      const retryDelay = Math.max(300, TICKER_429_RETRY_DELAY_MS * attempt);
      await sleepAbortable(retryDelay, opts?.signal);
    }
  }
  throw new Error("fetchTickersAllKrw exhausted attempts without result");
}

export async function fetchTickersWithMeta(
  markets: string[],
  opts?: FetchTickersOptions
): Promise<FetchTickersWithMetaResult> {
  const localMetaMap = new Map<string, TickerMeta>();
  const parallelTickerBatches = Math.max(1, Math.min(4, opts?.parallelTickerBatches ?? 1));

  if (markets.length === 0) {
    return {
      tickers: [],
      metaByMarket: localMetaMap,
      fetchedLiveCount: 0,
      freshCacheCount: 0,
      staleFallbackCount: 0,
      missingCount: 0,
      momentumEligibleCount: 0,
      maxTickerAgeMs: 0,
      oldestTickerAgeMs: 0,
      lockWaitMs: 0,
      actualParallel: parallelTickerBatches,
      configuredParallel: parallelTickerBatches,
      budgetExpired: false,
    };
  }

  const sanitized = await sanitizeKrwMarkets(markets);
  if (sanitized.length === 0) {
    return {
      tickers: [],
      metaByMarket: localMetaMap,
      fetchedLiveCount: 0,
      freshCacheCount: 0,
      staleFallbackCount: 0,
      missingCount: 0,
      momentumEligibleCount: 0,
      maxTickerAgeMs: 0,
      oldestTickerAgeMs: 0,
      lockWaitMs: 0,
      actualParallel: parallelTickerBatches,
      configuredParallel: parallelTickerBatches,
      budgetExpired: false,
    };
  }

  const now0 = Date.now();
  const dbgOn = tickerDebugEnabled();
  const isPriority = opts?.isPriority === true;
  let budgetExpired = false;
  let totalLockWaitMs = 0;

  const maxCap = opts?.maxMarkets ?? TICKER_MAX_MARKETS_PER_TICK;
  const ordered =
    opts?.sortByCached24hVolume === false
      ? [...sanitized]
      : [...sanitized].sort((a, b) => (ticker24hVolumeHintByMarket.get(b) ?? 0) - (ticker24hVolumeHintByMarket.get(a) ?? 0));
  const limited = maxCap >= ordered.length ? ordered : ordered.slice(0, Math.max(1, maxCap));

  const shouldTryAllEndpoint =
    opts?.preferAllEndpoint === true ||
    (opts?.preferAllEndpoint !== false && limited.length >= 20 && limited.every((m) => m.startsWith("KRW-")));

  // 1) Primary Full-Universe Snapshot: /v1/ticker/all?quote_currencies=KRW
  if (shouldTryAllEndpoint) {
    const isGlobalCooldown = Date.now() < tickerGlobalCooldownUntilMs;
    if (!isGlobalCooldown || isPriority) {
      let releaseLock: (() => void) | null = null;
      let allSuccess = false;
      try {
        const sliceLockTimeoutMs = opts?.totalTimeoutMs ?? (opts?.batchTimeoutMs ? Math.max(2000, opts.batchTimeoutMs * 2) : 10_000);
        releaseLock = await acquireTickerLockMeasured(
          {
            priority: isPriority,
            signal: opts?.signal,
            timeoutMs: sliceLockTimeoutMs,
            caller: opts?.debugCaller ?? "fetchTickersWithMeta:all",
          },
          (waitMs) => {
            totalLockWaitMs += waitMs;
          },
        );

        const allRows = await fetchTickersAllKrw({
          signal: opts?.signal,
          timeoutMs: opts?.batchTimeoutMs ?? 8000,
          debugCaller: opts?.debugCaller,
        });
        allSuccess = true;

        const allMap = new Map(allRows.map((t) => [t.market, t]));
        const out: UpbitTicker[] = [];
        const nowFetched = Date.now();

        for (const m of limited) {
          const t = allMap.get(m);
          if (t) {
            out.push(t);
            localMetaMap.set(m, { source: "live", ageMs: 0, fetchedAtMs: nowFetched });
          }
        }

        // Fallback for any missing in requested limited
        for (const m of limited) {
          if (out.some((t) => t.market === m)) continue;
          const lastGood = lastGoodTickerCache.get(m);
          if (lastGood) {
            out.push(lastGood);
            const c = tickerCache.get(m);
            const fetchedAt = lastGoodTickerFetchedAtMap.get(m) ?? (c ? c.fetchedAtMs : 0);
            const age = fetchedAt > 0 ? Math.max(0, now0 - fetchedAt) : (c ? Math.max(0, now0 - c.fetchedAtMs) : 0);
            tickerSourceMap.set(m, "last_good_cache");
            tickerAgeMap.set(m, age);
            localMetaMap.set(m, { source: "last_good_cache", ageMs: age, fetchedAtMs: fetchedAt });
            continue;
          }
          tickerSourceMap.set(m, "missing");
          tickerAgeMap.set(m, 0);
          localMetaMap.set(m, { source: "missing", ageMs: 0, fetchedAtMs: 0 });
        }

        let fetchedLiveCount = 0;
        let freshCacheCount = 0;
        let staleFallbackCount = 0;
        let missingCount = 0;
        let momentumEligibleCount = 0;
        let maxTickerAgeMs = 0;

        for (const t of out) {
          const meta = localMetaMap.get(t.market);
          if (!meta) {
            missingCount++;
            continue;
          }
          if (meta.source === "live") fetchedLiveCount++;
          else if (meta.source === "fresh_cache" || meta.source === "cache") freshCacheCount++;
          else if (meta.source === "last_good_cache" || meta.source === "candle_fallback") staleFallbackCount++;
          else missingCount++;

          if (isFreshForMomentum(meta, 60_000)) {
            momentumEligibleCount++;
          }
          if (meta.ageMs > maxTickerAgeMs) maxTickerAgeMs = meta.ageMs;
        }

        return {
          tickers: out,
          metaByMarket: localMetaMap,
          fetchedLiveCount,
          freshCacheCount,
          staleFallbackCount,
          missingCount,
          momentumEligibleCount,
          maxTickerAgeMs,
          oldestTickerAgeMs: maxTickerAgeMs,
          lockWaitMs: totalLockWaitMs,
          actualParallel: 1,
          configuredParallel: parallelTickerBatches,
          budgetExpired: false,
        };
      } catch (err) {
        if (dbgOn) {
          console.warn(
            `[upbit-ticker] fetchTickers /v1/ticker/all failed or cooldown active (caller=${opts?.debugCaller}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        if (releaseLock) {
          releaseLock();
          releaseLock = null;
        }
      }
    }
  }

  // 2) Cache & Fallback check before batch fetch
  const needFetch: string[] = [];
  const cachedOut: UpbitTicker[] = [];

  for (const m of limited) {
    const c = tickerCache.get(m);
    const circuitOpenUntil = tickerCircuitOpenUntilByMarket.get(m) ?? 0;
    const isGlobalCooldown = Date.now() < tickerGlobalCooldownUntilMs;

    if (circuitOpenUntil > now0) {
      if (c) {
        cachedOut.push(c.value);
        const age = now0 - c.fetchedAtMs;
        tickerSourceMap.set(m, "last_good_cache");
        tickerAgeMap.set(m, age);
        localMetaMap.set(m, { source: "last_good_cache", ageMs: age, fetchedAtMs: c.fetchedAtMs });
      } else {
        tickerSourceMap.set(m, "missing");
        tickerAgeMap.set(m, 0);
        localMetaMap.set(m, { source: "missing", ageMs: 0, fetchedAtMs: 0 });
      }
      continue;
    }

    // TTL 이내의 캐시가 있으면 그것을 사용
    if (c && now0 <= c.expiresAtMs && opts?.forceRefresh !== true) {
      cachedOut.push(c.value);
      const age = now0 - c.fetchedAtMs;
      tickerSourceMap.set(m, "fresh_cache");
      tickerAgeMap.set(m, age);
      localMetaMap.set(m, { source: "fresh_cache", ageMs: age, fetchedAtMs: c.fetchedAtMs });
      continue;
    }

    // 개별 마켓 쿨다운 중이거나 전역 쿨다운 중인 경우 (priority 또는 forceRefresh 시 우회)
    const cd = tickerCooldownUntilMs.get(m) ?? 0;
    if ((cd > now0 || isGlobalCooldown) && !isPriority && opts?.forceRefresh !== true) {
      if (c && now0 <= c.staleUntilMs) {
        cachedOut.push(c.value);
        const age = now0 - c.fetchedAtMs;
        tickerSourceMap.set(m, "last_good_cache");
        tickerAgeMap.set(m, age);
        localMetaMap.set(m, { source: "last_good_cache", ageMs: age, fetchedAtMs: c.fetchedAtMs });
      } else {
        const lastGood = lastGoodTickerCache.get(m);
        if (lastGood) {
          cachedOut.push(lastGood);
          const fetchedAt = lastGoodTickerFetchedAtMap.get(m) ?? (c ? c.fetchedAtMs : 0);
          const age = fetchedAt > 0 ? Math.max(0, now0 - fetchedAt) : (c ? Math.max(0, now0 - c.fetchedAtMs) : 0);
          tickerSourceMap.set(m, "last_good_cache");
          tickerAgeMap.set(m, age);
          localMetaMap.set(m, { source: "last_good_cache", ageMs: age, fetchedAtMs: fetchedAt });
        } else {
          tickerSourceMap.set(m, "missing");
          tickerAgeMap.set(m, 0);
          localMetaMap.set(m, { source: "missing", ageMs: 0, fetchedAtMs: 0 });
        }
      }
      continue;
    }

    needFetch.push(m);
  }

  // 3) REST Batch 호출 진행 (Fallback/Pair Ticker Batch)
  const out: UpbitTicker[] = [...cachedOut];

  if (needFetch.length > 0) {
    const batchSize = Math.max(1, Math.min(10, opts?.batchSize ?? TICKER_BATCH_SIZE));
    const batchDelayMs = opts?.batchDelayMs ?? TICKER_BATCH_DELAY_MS;
    const batches = chunk(needFetch, batchSize);
    const tickSignal = opts?.signal;
    const totalTimeoutMs = opts?.totalTimeoutMs ?? null;
    const batchTimeoutMs = opts?.batchTimeoutMs ?? null;

    for (let i = 0; i < batches.length; i += parallelTickerBatches) {
      if (tickSignal?.aborted) break;
      // 실시간 전역 429 쿨다운 체크: 진행 중 429가 발생했으면 남은 배치들 즉시 중단
      if (Date.now() < tickerGlobalCooldownUntilMs && !isPriority) {
        if (dbgOn) {
          console.warn(`[upbit-ticker] fetchTickers batch aborted due to real-time global 429 cooldown (caller=${opts?.debugCaller})`);
        }
        break;
      }

      const elapsedSoFar = Date.now() - now0;
      if (totalTimeoutMs !== null && elapsedSoFar >= totalTimeoutMs) {
        budgetExpired = true;
        if (dbgOn) {
          console.warn(`[upbit-ticker] fetchTickers total budget expired (${elapsedSoFar}ms >= ${totalTimeoutMs}ms, caller=${opts?.debugCaller})`);
        }
        break;
      }
      const remainingBudgetMs = totalTimeoutMs !== null ? Math.max(0, totalTimeoutMs - elapsedSoFar) : undefined;
      const sliceLockTimeoutMs = remainingBudgetMs !== undefined
        ? remainingBudgetMs
        : (batchTimeoutMs ? Math.max(2000, batchTimeoutMs * 2) : 10_000);

      let releaseLock: (() => void) | null = null;
      try {
        if (remainingBudgetMs !== undefined && remainingBudgetMs <= 0) {
          budgetExpired = true;
          break;
        }
        releaseLock = await acquireTickerLockMeasured(
          {
            priority: isPriority,
            signal: tickSignal,
            timeoutMs: sliceLockTimeoutMs,
            caller: opts?.debugCaller ?? "fetchTickers",
          },
          (waitMs) => {
            totalLockWaitMs += waitMs;
          },
        );

        const slice = batches.slice(i, i + parallelTickerBatches);
        const results = await Promise.all(
          slice.map((g) =>
            fetchTickerBatchGroup({
              group: g,
              signal: tickSignal,
              batchTimeoutMs: batchTimeoutMs ?? undefined,
              debugCaller: opts?.debugCaller,
            }),
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
            lastGoodTickerCache.set(t.market, t);
            lastGoodTickerFetchedAtMap.set(t.market, now);
            tickerSourceMap.set(t.market, "live");
            tickerAgeMap.set(t.market, 0);
            localMetaMap.set(t.market, { source: "live", ageMs: 0, fetchedAtMs: now });
          }
          out.push(...r);
        }
      } catch (fetchErr) {
        if (dbgOn) {
          console.warn(
            `[upbit-ticker] fetchTickers slice fetch aborted or failed (caller=${opts?.debugCaller}): ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          );
        }
        break;
      } finally {
        if (releaseLock) {
          releaseLock();
          releaseLock = null;
        }
      }

      if (i + parallelTickerBatches < batches.length) {
        await sleepAbortable(Math.max(0, batchDelayMs), tickSignal);
      }
    }
  }

  // 4) Fallback 보강
  for (const m of limited) {
    if (out.some((t) => t.market === m)) continue;

    const lastGood = lastGoodTickerCache.get(m);
    if (lastGood) {
      out.push(lastGood);
      const c = tickerCache.get(m);
      const fetchedAt = lastGoodTickerFetchedAtMap.get(m) ?? (c ? c.fetchedAtMs : 0);
      const age = fetchedAt > 0 ? Math.max(0, now0 - fetchedAt) : (c ? Math.max(0, now0 - c.fetchedAtMs) : 0);
      tickerSourceMap.set(m, "last_good_cache");
      tickerAgeMap.set(m, age);
      localMetaMap.set(m, { source: "last_good_cache", ageMs: age, fetchedAtMs: fetchedAt });
      continue;
    }

    const candle = peekMinuteCandleCache(m, 1, 1);
    if (candle && candle.rows.length > 0) {
      const lastCandle = candle.rows[0];
      const fallbackTicker: UpbitTicker = {
        market: m,
        trade_price: lastCandle.trade_price,
      };
      out.push(fallbackTicker);
      const age = Math.max(0, now0 - candle.expires_at_ms);
      tickerSourceMap.set(m, "candle_fallback");
      tickerAgeMap.set(m, age);
      localMetaMap.set(m, { source: "candle_fallback", ageMs: age, fetchedAtMs: candle.expires_at_ms });
      continue;
    }

    tickerSourceMap.set(m, "missing");
    tickerAgeMap.set(m, 0);
    localMetaMap.set(m, { source: "missing", ageMs: 0, fetchedAtMs: 0 });
  }

  // Aggregate local statistics
  let fetchedLiveCount = 0;
  let freshCacheCount = 0;
  let staleFallbackCount = 0;
  let missingCount = 0;
  let momentumEligibleCount = 0;
  let maxTickerAgeMs = 0;

  for (const t of out) {
    const meta = localMetaMap.get(t.market);
    if (!meta) {
      missingCount++;
      continue;
    }
    if (meta.source === "live") fetchedLiveCount++;
    else if (meta.source === "fresh_cache" || meta.source === "cache") freshCacheCount++;
    else if (meta.source === "last_good_cache" || meta.source === "candle_fallback") staleFallbackCount++;
    else missingCount++;

    if (isFreshForMomentum(meta, 60_000)) {
      momentumEligibleCount++;
    }
    if (meta.ageMs > maxTickerAgeMs) maxTickerAgeMs = meta.ageMs;
  }

  if (dbgOn) {
    for (const m of limited) {
      const meta = localMetaMap.get(m);
      if (!meta) continue;
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_DATA_SOURCE",
          ts: new Date().toISOString(),
          symbol: m,
          ticker_source: meta.source,
          ticker_age_ms: meta.ageMs,
          caller: opts?.debugCaller ?? null,
        }),
      );
    }
  }

  return {
    tickers: out,
    metaByMarket: localMetaMap,
    fetchedLiveCount,
    freshCacheCount,
    staleFallbackCount,
    missingCount,
    momentumEligibleCount,
    maxTickerAgeMs,
    oldestTickerAgeMs: maxTickerAgeMs,
    lockWaitMs: totalLockWaitMs,
    actualParallel: parallelTickerBatches,
    configuredParallel: parallelTickerBatches,
    budgetExpired,
  };
}

export async function fetchTickers(markets: string[], opts?: FetchTickersOptions): Promise<UpbitTicker[]> {
  const res = await fetchTickersWithMeta(markets, opts);
  return res.tickers;
}

export async function fetchLiveTickersDirect(
  markets: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number; debugCaller?: string; priority?: boolean }
): Promise<{ ok: boolean; source: "live" | "fallback" | "failed"; rows: UpbitTicker[]; fetchedAtMs: number | null }> {
  if (markets.length === 0) return { ok: false, source: "failed", rows: [], fetchedAtMs: null };
  const sanitized = await sanitizeKrwMarkets(markets);
  if (sanitized.length === 0) return { ok: false, source: "failed", rows: [], fetchedAtMs: null };

  try {
    const rows = await withTickerLock(
      {
        priority: opts?.priority ?? true,
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs ?? 3000,
        caller: opts?.debugCaller ?? "fetchLiveTickersDirect",
      },
      () =>
        fetchTickerBatchGroup({
          group: sanitized,
          signal: opts?.signal,
          batchTimeoutMs: opts?.timeoutMs ? Math.floor(opts.timeoutMs * 0.8) : 2500,
          debugCaller: opts?.debugCaller ?? "fetchLiveTickersDirect",
        }),
    );

    const now = Date.now();
    for (const t of rows) {
      tickerCache.set(t.market, {
        value: t,
        fetchedAtMs: now,
        expiresAtMs: now + TICKER_CACHE_TTL_MS,
        staleUntilMs: now + TICKER_CACHE_TTL_MS + TICKER_CACHE_STALE_GRACE_MS,
      });
      lastGoodTickerCache.set(t.market, t);
      lastGoodTickerFetchedAtMap.set(t.market, now);
      tickerSourceMap.set(t.market, "live");
      tickerAgeMap.set(t.market, 0);
    }

    const allPresent = sanitized.every((m) => rows.some((r) => r.market === m && Number(r.trade_price) > 0));
    if (allPresent && rows.length > 0) {
      return { ok: true, source: "live", rows, fetchedAtMs: now };
    }
    return { ok: false, source: "failed", rows: [], fetchedAtMs: null };
  } catch {
    return { ok: false, source: "failed", rows: [], fetchedAtMs: null };
  }
}

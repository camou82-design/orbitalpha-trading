import {
  fetchTickers,
  tickerCache,
  lastGoodTickerCache,
  partitionKrwMarketsByUpbitValidity,
} from "./upbit-public.js";

const UPBIT_FEE_RATE = 0.0005;

const MANAGED_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;

/** Dashboard / Account Valuation 전용 가격 신선도 임계치 (기본 5초, 1~30초 범위 클램프) */
export const DEFAULT_ACCOUNT_VALUATION_TICKER_FRESH_MAX_AGE_MS = 5000;
export const ACCOUNT_VALUATION_TICKER_FRESH_MAX_AGE_MS = Math.max(
  1000,
  Math.min(30000, Number(process.env.ACCOUNT_VALUATION_TICKER_FRESH_MAX_AGE_MS ?? DEFAULT_ACCOUNT_VALUATION_TICKER_FRESH_MAX_AGE_MS)),
);

/** Dashboard polling용 REST fetch 전체 예산 (기본 800ms, 300~2000ms 클램프) */
export const DEFAULT_ACCOUNT_VALUATION_TOTAL_TIMEOUT_MS = 800;
export const ACCOUNT_VALUATION_TOTAL_TIMEOUT_MS = Math.max(
  300,
  Math.min(2000, Number(process.env.ACCOUNT_VALUATION_TOTAL_TIMEOUT_MS ?? DEFAULT_ACCOUNT_VALUATION_TOTAL_TIMEOUT_MS)),
);

/** Dashboard polling용 REST fetch 배치 예산 (기본 600ms, 200~1500ms 클램프) */
export const DEFAULT_ACCOUNT_VALUATION_BATCH_TIMEOUT_MS = 600;
export const ACCOUNT_VALUATION_BATCH_TIMEOUT_MS = Math.max(
  200,
  Math.min(1500, Number(process.env.ACCOUNT_VALUATION_BATCH_TIMEOUT_MS ?? DEFAULT_ACCOUNT_VALUATION_BATCH_TIMEOUT_MS)),
);

export type BalanceRow = {
  currency: string;
  balance: number;
  locked: number;
  avg_buy_price: number;
};

/** 업비트 잔고 currency → 티커 마켓 코드(KRW-BTC). KRW는 그대로. */
export function normalizeBalanceCurrency(raw: string): string {
  const s = String(raw ?? "").trim();
  if (s.toUpperCase() === "KRW") return "KRW";
  return s.toUpperCase();
}

function marketCodeForCurrency(currency: string): string {
  return "KRW-" + normalizeBalanceCurrency(currency);
}

export type AccountPortfolioSnapshot = {
  /** KRW + 보유 암호화폐를 현재가로 환산한 총평가(업비트 앱의 총 보유자산과 동일 기준). */
  total_evaluated_krw: number;
  krw_available_krw: number;
  /** 출금가능 + 주문 중(잠금) KRW 합 */
  krw_total_krw: number;
  /** 매수금액 기준 합(KRW 잔고는 1:1, 코인은 평단×수량). */
  buy_cost_krw: number;
  estimated_fees_krw: number;
  net_pnl_krw: number;
  net_return_pct: number;
  cost_basis_unknown_krw: number;
  passive_holding_value_krw: number;
  as_of: string;
};

export type AccountValuationResult = {
  portfolio: AccountPortfolioSnapshot;
  /** 대시보드 4종목 현재가 — `trade/status`와 동일 시각의 스냅샷. */
  mark_prices: Record<string, number>;
};

/**
 * 잔고 + 시세 맵으로 스냅샷 계산(네트워크 없음). 티커 실패 시에도 동일 함수로 일관된 KPI를 만든다.
 */
export function computeAccountValuationFromPrices(balances: BalanceRow[], tradePriceByMarket: Record<string, number>, as_of: string): AccountValuationResult {
  const krwRow = balances.find((b) => b.currency === "KRW");
  const krwAvail = Math.max(0, Number(krwRow?.balance ?? 0));
  const krwLocked = Math.max(0, Number(krwRow?.locked ?? 0));
  const krwTotal = krwAvail + krwLocked;

  const mark_prices: Record<string, number> = {};
  const addMark = (m: string) => {
    const p = tradePriceByMarket[m];
    if (typeof p === "number" && Number.isFinite(p) && p > 0) mark_prices[m] = p;
  };
  for (const m of MANAGED_MARKETS) addMark(m);
  for (const b of balances) {
    if (b.currency === "KRW") continue;
    if (b.balance + b.locked <= 0) continue;
    addMark(marketCodeForCurrency(b.currency));
  }

  let total_evaluated = krwTotal;
  let known_buy_cost = krwTotal;
  let known_evaluated = krwTotal;
  let estimated_fees = 0;
  let cost_basis_unknown_krw = 0;
  let passive_holding_value_krw = 0;

  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty <= 0) continue;
    const market = marketCodeForCurrency(b.currency);
    const price = tradePriceByMarket[market];
    
    // 가격이 없거나 0 이하이면 이 종목의 자산평가 및 평단 매수 금액을 제외한다
    if (price === undefined || price === null || Number.isNaN(price) || price <= 0) {
      continue;
    }
    
    const evalAmt = qty * price;
    const avg = Number(b.avg_buy_price ?? 0);

    // 업비트 앱 연동 총자산(total_evaluated_krw)에는 소액 비관리 잔고를 포함한 전 코인 평가금액 합산
    total_evaluated += evalAmt;

    // 관리 대상 종목(MANAGED_MARKETS)이 아닌 코인의 평가금액 합산
    const isManaged = MANAGED_MARKETS.includes(market as any);
    if (!isManaged) {
      passive_holding_value_krw += evalAmt;
    }

    if (avg <= 0) {
      cost_basis_unknown_krw += evalAmt;
      continue;
    }

    const buyCost = qty * avg;
    known_buy_cost += buyCost;
    known_evaluated += evalAmt;
    estimated_fees += evalAmt * UPBIT_FEE_RATE;
  }

  const net_pnl_krw = known_evaluated - known_buy_cost - estimated_fees;
  const net_return_pct = known_buy_cost > 0 ? (net_pnl_krw / known_buy_cost) * 100 : 0;

  const portfolio: AccountPortfolioSnapshot = {
    total_evaluated_krw: total_evaluated,
    krw_available_krw: krwAvail,
    krw_total_krw: krwTotal,
    buy_cost_krw: known_buy_cost,
    estimated_fees_krw: estimated_fees,
    net_pnl_krw,
    net_return_pct,
    cost_basis_unknown_krw,
    passive_holding_value_krw,
    as_of,
  };

  return { portfolio, mark_prices };
}

const num = (v: unknown, d = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

/** JSON 직렬화/부동소수 이후에도 KPI가 항상 유한 숫자를 갖도록 정규화. */
export function sanitizeAccountPortfolioSnapshot(p: AccountPortfolioSnapshot): AccountPortfolioSnapshot {
  return {
    total_evaluated_krw: num(p.total_evaluated_krw),
    krw_available_krw: num(p.krw_available_krw),
    krw_total_krw: num(p.krw_total_krw),
    buy_cost_krw: num(p.buy_cost_krw),
    estimated_fees_krw: num(p.estimated_fees_krw),
    net_pnl_krw: num(p.net_pnl_krw),
    net_return_pct: num(p.net_return_pct),
    cost_basis_unknown_krw: num(p.cost_basis_unknown_krw),
    passive_holding_value_krw: num(p.passive_holding_value_krw),
    as_of: typeof p.as_of === "string" && p.as_of.length > 0 ? p.as_of : new Date().toISOString(),
  };
}

/** 티커 요청에 쓸 마켓 목록(보유 코인 + 대시보드 4종). */
export function marketsForAccountValuation(balances: BalanceRow[]): string[] {
  const marketsFromHoldings = new Set<string>();
  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty > 0) marketsFromHoldings.add(marketCodeForCurrency(b.currency));
  }
  for (const m of MANAGED_MARKETS) marketsFromHoldings.add(m);
  return [...marketsFromHoldings];
}

/**
 * 티커 맵에 없거나 0인 보유 코인은 평단을 평가가로 사용(시세 부재 시에도 KPI·카드가 동일 맵 기준으로 숫자 표시).
 * 티커가 있으면 항상 티커 우선.
 */
export function buildEffectiveValuationPriceMap(balances: BalanceRow[], tickerMap: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(tickerMap)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 보유 중인 모든 코인에 대해 양(>0)의 현재가가 맵에 있어야 한다. KRW만 보유면 true.
 * 빈 맵으로 평가해 "현금=총자산" 오표시를 막는다.
 */
export function holdingsFullyPriced(balances: BalanceRow[], tradePriceByMarket: Record<string, number>): boolean {
  const eff = buildEffectiveValuationPriceMap(balances, tradePriceByMarket);
  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty <= 0) continue;
    const market = marketCodeForCurrency(b.currency);
    const p = eff[market];
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) return false;
  }
  return true;
}

/** Upbit ticker는 JSON에서 trade_price가 문자열로 올 수 있음 — 숫자만 인정. */
function parseTickerRow(t: { market?: unknown; trade_price?: unknown }): { market: string; price: number } | null {
  if (typeof t.market !== "string" || !t.market) return null;
  const p = Number(t.trade_price);
  if (!Number.isFinite(p) || p <= 0) return null;
  return { market: t.market, price: p };
}

export type FetchTickerPriceMapOptions = {
  forceRefresh?: boolean;
  debugCaller?: string;
  totalTimeoutMs?: number;
  batchTimeoutMs?: number;
  signal?: AbortSignal;
};

/** 공개 티커 조회 실패 시 throw — 호출부에서 마지막 정상 가격맵으로 폴백한다. */
export async function fetchTickerPriceMap(
  markets: string[],
  isPriority = true,
  opts?: FetchTickerPriceMapOptions,
): Promise<Record<string, number>> {
  if (markets.length === 0) return {};
  const tickerRows = await fetchTickers(markets, {
    isPriority,
    forceRefresh: opts?.forceRefresh,
    debugCaller: opts?.debugCaller,
    totalTimeoutMs: opts?.totalTimeoutMs,
    batchTimeoutMs: opts?.batchTimeoutMs,
    signal: opts?.signal,
  });
  const tradePriceByMarket: Record<string, number> = {};
  for (const t of tickerRows) {
    const parsed = parseTickerRow(t as { market?: unknown; trade_price?: unknown });
    if (parsed) tradePriceByMarket[parsed.market] = parsed.price;
  }
  return tradePriceByMarket;
}

function heldMarketsNeedingPrice(balances: BalanceRow[], priceMap: Record<string, number>): string[] {
  const miss: string[] = [];
  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty <= 0) continue;
    const market = marketCodeForCurrency(b.currency);
    const p = priceMap[market];
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) miss.push(market);
  }
  return miss;
}

const TICKER_CHUNK = 10; // Chunk 크기를 10 이하로 조정

async function fetchTickerPriceMapChunked(
  markets: string[],
  isPriority = true,
  opts?: FetchTickerPriceMapOptions,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < markets.length; i += TICKER_CHUNK) {
    const chunk = markets.slice(i, i + TICKER_CHUNK);
    try {
      const part = await fetchTickerPriceMap(chunk, isPriority, opts);
      Object.assign(out, part);
    } catch {
      /* 청크 단위 실패는 무시 — 단건 보충에서 이어짐 */
    }
  }
  return out;
}

export type InitialMarketFreshnessResult = {
  initialMerged: Record<string, number>;
  freshMarkets: Set<string>;
  staleMarkets: string[];
};

/**
 * 캐시(tickerCache / lastGoodTickerCache)와 직전 시드(seed)로부터
 * 마켓별 초기 fallback 가격 및 freshness(5초 이내 live 여부)를 평가하는 순수 함수.
 * 네트워크 I/O 없이 완전히 결정론적으로 동작한다.
 */
export function evaluateInitialMarketFreshness(params: {
  markets: string[];
  tickerCacheMap: Map<string, { value?: { trade_price?: unknown } | null; fetchedAtMs?: number | null }>;
  lastGoodMap: Map<string, { trade_price?: unknown } | null>;
  seed: Record<string, number> | null;
  now: number;
  freshMaxAgeMs: number;
}): InitialMarketFreshnessResult {
  const { markets, tickerCacheMap, lastGoodMap, seed, now, freshMaxAgeMs } = params;
  const initialMerged: Record<string, number> = {};
  const freshMarkets = new Set<string>();
  const staleMarkets: string[] = [];

  // 1) Seed 가격을 fallback 기본값으로 먼저 탑재
  if (seed) {
    for (const [k, v] of Object.entries(seed)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        initialMerged[k] = v;
      }
    }
  }

  // 2) 대상 마켓별 캐시 검사
  for (const m of markets) {
    const c = tickerCacheMap.get(m);
    const lg = lastGoodMap.get(m);

    const cachePrice = c && c.value && Number(c.value.trade_price) > 0 ? Number(c.value.trade_price) : null;
    const lastGoodPrice = lg && Number(lg.trade_price) > 0 ? Number(lg.trade_price) : null;

    if (cachePrice !== null && c && typeof c.fetchedAtMs === "number" && c.fetchedAtMs > 0) {
      initialMerged[m] = cachePrice;
      const age = now - c.fetchedAtMs;
      if (age >= 0 && age <= freshMaxAgeMs) {
        // Fresh: 최근 5초 이내 캐시
        freshMarkets.add(m);
      } else {
        // Stale: 5초 초과 캐시 -> fallback 가격은 유지하되 refresh 대상으로 분류
        staleMarkets.push(m);
      }
    } else if (lastGoodPrice !== null) {
      // lastGoodTickerCache만 있는 경우: fallback 가격은 보존하되 fresh로는 넣지 않고 refresh 대상
      initialMerged[m] = lastGoodPrice;
      staleMarkets.push(m);
    } else {
      // tickerCache/lastGood 모두 없는 경우 (seed에 있더라도 stale로 분류하여 REST refresh 시도)
      staleMarkets.push(m);
    }
  }

  return { initialMerged, freshMarkets, staleMarkets };
}

/**
 * seed(직전 성공 맵) + 엔진 최신 캐시(tickerCache/lastGoodTickerCache) + 배치 티커(재시도)로 가격맵을 채운다.
 * 대시보드/계좌 조회가 Live Execution의 Ticker Lock을 침범/경합하지 않도록 비우선순위(isPriority: false)를 사용하고 짧은 타임아웃 예산을 적용한다.
 * `rest_fresh_markets`: 이번 호출 시점에 5초 이내 신선도가 보장된 마켓 집합 (stale/lastGood fallback은 제외).
 */
export async function resolveTickerPricesForBalances(
  balances: BalanceRow[],
  seed: Record<string, number> | null,
  opts?: {
    isPriority?: boolean;
    freshMaxAgeMs?: number;
    totalTimeoutMs?: number;
    batchTimeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ merged: Record<string, number>; rest_fresh_markets: Set<string> }> {
  const isPriority = opts?.isPriority ?? false;
  const freshMaxAgeMs = opts?.freshMaxAgeMs ?? ACCOUNT_VALUATION_TICKER_FRESH_MAX_AGE_MS;
  const totalTimeoutMs = opts?.totalTimeoutMs ?? ACCOUNT_VALUATION_TOTAL_TIMEOUT_MS;
  const batchTimeoutMs = opts?.batchTimeoutMs ?? ACCOUNT_VALUATION_BATCH_TIMEOUT_MS;
  const now = Date.now();

  const allValuationMarkets = marketsForAccountValuation(balances);
  const { accepted: markets } = await partitionKrwMarketsByUpbitValidity(allValuationMarkets);

  // 1. Live Engine이 이미 갱신 중인 tickerCache / lastGoodTickerCache 및 seed에서 초기 상태 평가
  const { initialMerged, freshMarkets, staleMarkets } = evaluateInitialMarketFreshness({
    markets,
    tickerCacheMap: tickerCache,
    lastGoodMap: lastGoodTickerCache,
    seed,
    now,
    freshMaxAgeMs,
  });

  const merged: Record<string, number> = { ...initialMerged };
  const restFresh = new Set<string>(freshMarkets);

  // 2. Stale하거나 아직 가격이 없는 마켓이 존재하면 forceRefresh로 REST 조회 (isPriority: false로 Live Engine 보호)
  if (staleMarkets.length > 0) {
    const fetchStartMs = Date.now();
    try {
      const freshPrices = staleMarkets.length <= TICKER_CHUNK
        ? await fetchTickerPriceMap(staleMarkets, isPriority, {
            forceRefresh: true,
            debugCaller: "account_portfolio_dashboard_refresh",
            totalTimeoutMs,
            batchTimeoutMs,
            signal: opts?.signal,
          })
        : await fetchTickerPriceMapChunked(staleMarkets, isPriority, {
            forceRefresh: true,
            debugCaller: "account_portfolio_dashboard_refresh",
            totalTimeoutMs,
            batchTimeoutMs,
            signal: opts?.signal,
          });

      for (const [k, v] of Object.entries(freshPrices)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          const c = tickerCache.get(k);
          // fetch 시작 이후 실제로 REST를 통해 최신 캐시가 갱신된 마켓만 fresh로 인정
          if (c && typeof c.fetchedAtMs === "number" && c.fetchedAtMs >= fetchStartMs) {
            merged[k] = v;
            restFresh.add(k);
          } else {
            // REST 실패로 fetchTickers 내부 lastGood fallback이 반환된 경우: 가격이 아예 없던 경우에만 fallback 채움
            if (!(Number(merged[k] ?? 0) > 0)) {
              merged[k] = v;
            }
          }
        }
      }
    } catch {
      /* REST 실패 시 기존 fallback(seed/lastGood/tickerCache) 유지 */
    }
  }

  // 3. 보유 마켓 중 여전히 유효 가격(>0)이 전혀 없는 종목 단건 보충 (유효 마켓 대상만)
  const heldNeeding = heldMarketsNeedingPrice(balances, merged).filter((m) => markets.includes(m));
  for (const m of heldNeeding) {
    try {
      const singleStart = Date.now();
      const one = await fetchTickerPriceMap([m], isPriority, {
        forceRefresh: true,
        debugCaller: "account_portfolio_held_single_refresh",
        totalTimeoutMs: Math.min(500, totalTimeoutMs),
        batchTimeoutMs: Math.min(400, batchTimeoutMs),
        signal: opts?.signal,
      });
      for (const [k, v] of Object.entries(one)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          const c = tickerCache.get(k);
          if (c && typeof c.fetchedAtMs === "number" && c.fetchedAtMs >= singleStart) {
            merged[k] = v;
            restFresh.add(k);
          } else {
            if (!(Number(merged[k] ?? 0) > 0)) {
              merged[k] = v;
            }
          }
        }
      }
    } catch {
      /* 다음 종목 */
    }
  }

  return { merged, rest_fresh_markets: restFresh };
}

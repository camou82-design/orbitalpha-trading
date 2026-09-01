import {
  fetchTickers,
  tickerCache,
  lastGoodTickerCache,
  partitionKrwMarketsByUpbitValidity,
} from "./upbit-public.js";

const UPBIT_FEE_RATE = 0.0005;

const MANAGED_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;

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
  return `KRW-${normalizeBalanceCurrency(currency)}`;
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

    // 평단가가 0이거나 미산정(avg <= 0)인 자산인 경우
    if (!Number.isFinite(avg) || avg <= 0) {
      cost_basis_unknown_krw += evalAmt;
      // 손익 계산 대상 및 수익률 분모에서 별도 제외 (net_pnl 기여 0원, 수익률 분모 왜곡 방지)
    } else {
      const cost = qty * avg;
      known_buy_cost += cost;
      known_evaluated += evalAmt;
      if (evalAmt > 0 && cost > 0) {
        estimated_fees += UPBIT_FEE_RATE * (evalAmt + cost);
      }
    }
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

/** 공개 티커 조회 실패 시 throw — 호출부에서 마지막 정상 가격맵으로 폴백한다. */
export async function fetchTickerPriceMap(markets: string[], isPriority = true): Promise<Record<string, number>> {
  if (markets.length === 0) return {};
  const tickerRows = await fetchTickers(markets, { isPriority });
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

async function fetchTickerPriceMapChunked(markets: string[], isPriority = true): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < markets.length; i += TICKER_CHUNK) {
    const chunk = markets.slice(i, i + TICKER_CHUNK);
    try {
      const part = await fetchTickerPriceMap(chunk, isPriority);
      Object.assign(out, part);
    } catch {
      /* 청크 단위 실패는 무시 — 단건 보충에서 이어짐 */
    }
  }
  return out;
}

/**
 * seed(직전 성공 맵) + 엔진 최신 캐시(tickerCache/lastGoodTickerCache) + 배치 티커(재시도)로 가격맵을 채운다.
 * 대시보드/계좌 조회가 Live Execution의 Ticker Lock을 침범/경합하지 않도록 캐시를 우선 활용하고 비우선순위(isPriority: false)를 사용한다.
 * `rest_fresh_markets`: 이번 호출 또는 최신 캐시로 유효 가격을 확보한 마켓 집합.
 */
export async function resolveTickerPricesForBalances(
  balances: BalanceRow[],
  seed: Record<string, number> | null,
  opts?: { isPriority?: boolean },
): Promise<{ merged: Record<string, number>; rest_fresh_markets: Set<string> }> {
  const isPriority = opts?.isPriority ?? false;
  const restFresh = new Set<string>();
  let merged: Record<string, number> = { ...(seed ?? {}) };

  const allValuationMarkets = marketsForAccountValuation(balances);
  const { accepted: markets } = await partitionKrwMarketsByUpbitValidity(allValuationMarkets);

  // 1. Live Engine이 이미 갱신 중인 tickerCache / lastGoodTickerCache에서 우선 흡수 (0ms, 락 경합 없음)
  for (const m of markets) {
    const c = tickerCache.get(m);
    if (c && c.value && Number(c.value.trade_price) > 0) {
      merged[m] = Number(c.value.trade_price);
      restFresh.add(m);
    } else {
      const lg = lastGoodTickerCache.get(m);
      if (lg && Number(lg.trade_price) > 0) {
        merged[m] = Number(lg.trade_price);
        restFresh.add(m);
      }
    }
  }

  const absorb = (part: Record<string, number>) => {
    for (const [k, v] of Object.entries(part)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        merged[k] = v;
        restFresh.add(k);
      }
    }
  };

  // 2. 캐시로도 아직 가격이 없는 유효 마켓이 남아있을 때만 REST 조회 (isPriority: false로 Live Engine 보호)
  const needingPrice = markets.filter((m) => !(Number(merged[m] ?? 0) > 0));
  if (needingPrice.length > 0) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fresh = needingPrice.length <= TICKER_CHUNK
          ? await fetchTickerPriceMap(needingPrice, isPriority)
          : await fetchTickerPriceMapChunked(needingPrice, isPriority);
        absorb(fresh);
        break;
      } catch {
        if (attempt < 1) await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // 3. 보유 마켓 중 여전히 가격이 없는 종목 단건 보충 (유효 마켓 대상만)
  const heldNeeding = heldMarketsNeedingPrice(balances, merged).filter((m) => markets.includes(m));
  for (const m of heldNeeding) {
    try {
      const one = await fetchTickerPriceMap([m], isPriority);
      absorb(one);
    } catch {
      /* 다음 종목 */
    }
  }

  return { merged, rest_fresh_markets: restFresh };
}

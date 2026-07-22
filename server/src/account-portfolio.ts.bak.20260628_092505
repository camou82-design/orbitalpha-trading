import { fetchTickers } from "./upbit-public.js";

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
  let buy_cost = krwTotal;
  let estimated_fees = 0;

  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty <= 0) continue;
    const market = marketCodeForCurrency(b.currency);
    const price = tradePriceByMarket[market] ?? 0;
    const evalAmt = qty * price;
    const avg = Number(b.avg_buy_price ?? 0);
    const cost = qty * avg;
    total_evaluated += evalAmt;
    buy_cost += cost;
    if (evalAmt > 0 && cost > 0) {
      estimated_fees += UPBIT_FEE_RATE * (evalAmt + cost);
    }
  }

  const net_pnl_krw = total_evaluated - buy_cost - estimated_fees;
  const net_return_pct = buy_cost > 0 ? (net_pnl_krw / buy_cost) * 100 : 0;

  const portfolio: AccountPortfolioSnapshot = {
    total_evaluated_krw: total_evaluated,
    krw_available_krw: krwAvail,
    krw_total_krw: krwTotal,
    buy_cost_krw: buy_cost,
    estimated_fees_krw: estimated_fees,
    net_pnl_krw,
    net_return_pct,
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
  const out: Record<string, number> = { ...tickerMap };
  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty <= 0) continue;
    const m = marketCodeForCurrency(b.currency);
    const tp = out[m];
    if (typeof tp === "number" && Number.isFinite(tp) && tp > 0) continue;
    const avg = Number(b.avg_buy_price ?? 0);
    if (Number.isFinite(avg) && avg > 0) out[m] = avg;
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
export async function fetchTickerPriceMap(markets: string[]): Promise<Record<string, number>> {
  if (markets.length === 0) return {};
  const tickerRows = await fetchTickers(markets);
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

const TICKER_CHUNK = 18;

async function fetchTickerPriceMapChunked(markets: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < markets.length; i += TICKER_CHUNK) {
    const chunk = markets.slice(i, i + TICKER_CHUNK);
    try {
      const part = await fetchTickerPriceMap(chunk);
      Object.assign(out, part);
    } catch {
      /* 청크 단위 실패는 무시 — 단건 보충에서 이어짐 */
    }
  }
  return out;
}

/**
 * seed(직전 성공 맵) + 배치 티커(재시도) + 보유 종목 단건 조회로 가격맵을 최대한 채운다.
 * account_portfolio·하단 카드가 같은 맵을 쓰도록 한 번에 반환한다.
 * `rest_fresh_markets`: 이번 호출에서 REST 응답으로 유효 가격을 받은 마켓(캐시만으로 채운 경우 제외).
 */
export async function resolveTickerPricesForBalances(
  balances: BalanceRow[],
  seed: Record<string, number> | null,
): Promise<{ merged: Record<string, number>; rest_fresh_markets: Set<string> }> {
  const restFresh = new Set<string>();
  let merged: Record<string, number> = { ...(seed ?? {}) };
  const markets = marketsForAccountValuation(balances);

  const absorb = (part: Record<string, number>) => {
    for (const [k, v] of Object.entries(part)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        merged[k] = v;
        restFresh.add(k);
      }
    }
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fresh = markets.length <= TICKER_CHUNK ? await fetchTickerPriceMap(markets) : await fetchTickerPriceMapChunked(markets);
      absorb(fresh);
      break;
    } catch {
      if (attempt < 1) await new Promise((r) => setTimeout(r, 350));
    }
  }

  for (const m of heldMarketsNeedingPrice(balances, merged)) {
    try {
      const one = await fetchTickerPriceMap([m]);
      absorb(one);
    } catch {
      /* 다음 종목 */
    }
  }

  return { merged, rest_fresh_markets: restFresh };
}

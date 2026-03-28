import { fetchTickers } from "./upbit-public.js";

const UPBIT_FEE_RATE = 0.0005;

const MANAGED_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;

export type BalanceRow = {
  currency: string;
  balance: number;
  locked: number;
  avg_buy_price: number;
};

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
  for (const m of MANAGED_MARKETS) {
    const p = tradePriceByMarket[m];
    if (typeof p === "number" && Number.isFinite(p)) mark_prices[m] = p;
  }

  let total_evaluated = krwTotal;
  let buy_cost = krwTotal;
  let estimated_fees = 0;

  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty <= 0) continue;
    const market = `KRW-${b.currency}`;
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

/** 티커 요청에 쓸 마켓 목록(보유 코인 + 대시보드 4종). */
export function marketsForAccountValuation(balances: BalanceRow[]): string[] {
  const marketsFromHoldings = new Set<string>();
  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty > 0) marketsFromHoldings.add(`KRW-${b.currency}`);
  }
  for (const m of MANAGED_MARKETS) marketsFromHoldings.add(m);
  return [...marketsFromHoldings];
}

/**
 * 보유 중인 모든 코인에 대해 양(>0)의 현재가가 맵에 있어야 한다. KRW만 보유면 true.
 * 빈 맵으로 평가해 "현금=총자산" 오표시를 막는다.
 */
export function holdingsFullyPriced(balances: BalanceRow[], tradePriceByMarket: Record<string, number>): boolean {
  for (const b of balances) {
    if (b.currency === "KRW") continue;
    const qty = b.balance + b.locked;
    if (qty <= 0) continue;
    const market = `KRW-${b.currency}`;
    const p = tradePriceByMarket[market];
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
    const market = `KRW-${b.currency}`;
    const p = priceMap[market];
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) miss.push(market);
  }
  return miss;
}

/**
 * seed(직전 성공 맵) + 배치 티커(재시도) + 보유 종목 단건 조회로 가격맵을 최대한 채운다.
 * account_portfolio·하단 카드가 같은 맵을 쓰도록 한 번에 반환한다.
 */
export async function resolveTickerPricesForBalances(
  balances: BalanceRow[],
  seed: Record<string, number> | null,
): Promise<Record<string, number>> {
  let merged: Record<string, number> = { ...(seed ?? {}) };
  const markets = marketsForAccountValuation(balances);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fresh = await fetchTickerPriceMap(markets);
      merged = { ...merged, ...fresh };
      break;
    } catch {
      if (attempt < 1) await new Promise((r) => setTimeout(r, 350));
    }
  }

  for (const m of heldMarketsNeedingPrice(balances, merged)) {
    try {
      const one = await fetchTickerPriceMap([m]);
      merged = { ...merged, ...one };
    } catch {
      /* 다음 종목 */
    }
  }

  return merged;
}

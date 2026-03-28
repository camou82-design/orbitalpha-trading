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

/** 공개 티커 조회 실패 시 throw — 호출부에서 마지막 정상 가격맵으로 폴백한다. */
export async function fetchTickerPriceMap(markets: string[]): Promise<Record<string, number>> {
  if (markets.length === 0) return {};
  const tickerRows = await fetchTickers(markets);
  const tradePriceByMarket: Record<string, number> = {};
  for (const t of tickerRows) {
    if (typeof t.market === "string" && typeof t.trade_price === "number") {
      tradePriceByMarket[t.market] = t.trade_price;
    }
  }
  return tradePriceByMarket;
}

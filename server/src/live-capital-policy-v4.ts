/**
 * Unified spot CORE/SURGE capital split for REST trade/status and live-strategy tick.
 * USDT 제외 평가, CORE 50% / SURGE 50%, pending 예약금은 진행중 매수 심볼 기준 근사 배분.
 */
export const LIVE_CORE_TRADE_MARKETS_POLICY = [
  "KRW-BTC",
  "KRW-ETH",
  "KRW-SOL",
  "KRW-XRP",
  "KRW-TRX",
  "KRW-DOGE",
] as const;

export type LiveCapitalBalancesRow = {
  currency: string;
  balance?: number | string;
  locked?: number | string;
  avg_buy_price?: number | string;
};

export type LiveCapitalPolicyV4Result = {
  totalAssetEquityKrw: number;
  excludedUsdtValueKrw: number;
  okxTransferReserveKrw: number;
  spotTradingEquityKrw: number;
  coreCapAmount: number;
  surgeCapAmount: number;
  /** CORE 6 보유 평가 + CORE 예약 매수금 (cap 적용 분자) */
  coreUsedCapitalKrw: number;
  /** SURGE(및 그 외 코인) 보유 평가 + SURGE 예약 매수금 */
  surgeUsedCapitalKrw: number;
  coreHoldingsEvaluationKrw: number;
  surgeHoldingsEvaluationKrw: number;
  corePendingBuyReservedKrw: number;
  surgePendingBuyReservedKrw: number;
  coreRemainingKrw: number;
  surgeRemainingKrw: number;
};

export function computeLiveCapitalPolicyV4(params: {
  balances: readonly LiveCapitalBalancesRow[];
  /** market -> trade price OR avg fallback applied by caller via markPrices + avg_buy_price merge */
  markPriceOrAvgByMarket: (market: string, avgFallback: number) => number;
  accountPortfolioTotalEvaluatedKrw: number | null | undefined;
  totalKrwFallback: number | undefined | null;
  reservedKrw: number | undefined | null;
  inFlightMarket: string | null | undefined;
  inFlight: boolean;
}): LiveCapitalPolicyV4Result {
  const coreMarketSet = new Set<string>(LIVE_CORE_TRADE_MARKETS_POLICY as unknown as string[]);

  let coreHoldingsEval = 0;
  let surgeHoldingsEval = 0;
  let usdtValueKrw = 0;

  for (const b of params.balances) {
    const currency = String(b.currency ?? "").toUpperCase();
    if (!currency || currency === "KRW") continue;
    const mk = `KRW-${currency}`;
    const qty = Number(b.balance ?? 0) + Number(b.locked ?? 0);
    const avgFb = Number(b.avg_buy_price ?? 0);
    const px = params.markPriceOrAvgByMarket(mk, avgFb);
    const val = qty * px;
    if (currency === "USDT") {
      usdtValueKrw += val;
    } else if (coreMarketSet.has(mk)) {
      coreHoldingsEval += val;
    } else {
      surgeHoldingsEval += val;
    }
  }

  const reservedRaw = Math.max(0, Number(params.reservedKrw ?? 0));
  const inflightMk = typeof params.inFlightMarket === "string" ? params.inFlightMarket.trim() : "";
  const coreInflightPending =
    Boolean(params.inFlight) && inflightMk.length > 0 && coreMarketSet.has(inflightMk) ? reservedRaw : 0;
  const surgeInflightPending = Math.max(0, reservedRaw - coreInflightPending);

  const coreUsedCapitalKrwRaw = coreHoldingsEval + coreInflightPending;
  const surgeUsedCapitalKrwRaw = surgeHoldingsEval + surgeInflightPending;

  const portfolioEval = Number(params.accountPortfolioTotalEvaluatedKrw ?? NaN);
  const fallbackEquityKrw =
    Math.max(0, Number(params.totalKrwFallback ?? 0)) +
    Math.max(0, coreHoldingsEval + surgeHoldingsEval - reservedRaw);
  const totalAssetEquityKrw = Math.floor(
    Number.isFinite(portfolioEval) && portfolioEval > 0 ? portfolioEval : fallbackEquityKrw,
  );

  const excludedUsdtValueKrw = Math.floor(usdtValueKrw);
  const okxTransferReserveKrw = excludedUsdtValueKrw;
  const spotTradingEquityKrw = Math.max(0, totalAssetEquityKrw - excludedUsdtValueKrw);

  const coreCapAmount = Math.floor(spotTradingEquityKrw * 0.5);
  const surgeCapAmount = Math.floor(spotTradingEquityKrw * 0.5);

  const coreUsedCapitalAll = Math.floor(coreUsedCapitalKrwRaw);
  const surgeUsedCapitalAll = Math.floor(surgeUsedCapitalKrwRaw);

  return {
    totalAssetEquityKrw,
    excludedUsdtValueKrw,
    okxTransferReserveKrw,
    spotTradingEquityKrw,
    coreCapAmount,
    surgeCapAmount,
    coreUsedCapitalKrw: coreUsedCapitalAll,
    surgeUsedCapitalKrw: surgeUsedCapitalAll,
    coreHoldingsEvaluationKrw: Math.floor(coreHoldingsEval),
    surgeHoldingsEvaluationKrw: Math.floor(surgeHoldingsEval),
    corePendingBuyReservedKrw: Math.floor(coreInflightPending),
    surgePendingBuyReservedKrw: Math.floor(surgeInflightPending),
    coreRemainingKrw: Math.max(0, coreCapAmount - coreUsedCapitalAll),
    surgeRemainingKrw: Math.max(0, surgeCapAmount - surgeUsedCapitalAll),
  };
}

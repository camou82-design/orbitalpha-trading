/**
 * 종목별 거래량 증가 비율 (직전 20봉 평균 대비). 미등록 종목은 `fallback` 사용.
 * 1차 임시 — 검증 후 조정.
 */
export const VOLUME_THRESHOLD_BY_MARKET: Record<string, number> = {
  "KRW-BTC": 0.75,
  "KRW-ETH": 1.15,
  "KRW-XRP": 0.75,
  "KRW-TRX": 1.15,
};

export function getVolumeThresholdForMarket(market: string, fallback: number): number {
  const v = VOLUME_THRESHOLD_BY_MARKET[market];
  return typeof v === "number" ? v : fallback;
}

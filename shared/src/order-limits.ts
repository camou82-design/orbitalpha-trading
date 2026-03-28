/**
 * 주문 엔진·market-state API·UI가 동일 숫자를 참조하도록 단일 정의.
 */
export const ORDER_LIMITS = {
  /** 전략: 최초 1회 + 추가 1회까지 (총 2체결). */
  MAX_STRATEGY_ENTRIES_PER_MARKET: 2,
  /** 전략: 종목당 누적 매수 KRW 상한 (추가 물타기 포함). */
  MAX_STRATEGY_INVESTED_KRW_PER_MARKET: 55_000,
  /** 레거시 DCA: 횟수 상한 (초기 보유 외 추가 매수). */
  MAX_LEGACY_DCA_COUNT_PER_MARKET: 2,
  /** 레거시: 종목당 DCA 누적 KRW 상한. */
  MAX_LEGACY_DCA_KRW_PER_MARKET: 28_000,
} as const;

/**
 * Trading 앱 전용 제품 네임스페이스 (jj-admin / homepage / shopping 과 경로·import 혼선 금지).
 */
export const TRADING_PRODUCT_NAMESPACE = "orbitalpha-trading" as const;

/** 기본 `company_id` (MVP). */
export const DEFAULT_TRADING_COMPANY_ID = "orbitalpha" as const;

/** 기본 `service_id` — 신호봇·대시보드 API 스코프. */
export const DEFAULT_TRADING_SERVICE_ID = "trading" as const;

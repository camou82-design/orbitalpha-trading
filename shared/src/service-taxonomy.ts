/**
 * Orbitalpha 플랫폼의 **논리 서비스 라인** 식별자 (참고용 상수).
 * 저장소/배너를 공유하더라도 **조회·쓰기는 항상 (company_id, service_id)로 스코프**하고,
 * 아래 라인끼리 레코드를 섞지 않는다. shopping / jj-admin / homepage 데이터 모델과 연결 금지.
 */
export const ORBITALPHA_SERVICE_LINES = {
  jjAdmin: "jj-admin",
  homepage: "homepage",
  trading: "trading",
  shopping: "shopping",
} as const;

export type OrbitalphaServiceLine = (typeof ORBITALPHA_SERVICE_LINES)[keyof typeof ORBITALPHA_SERVICE_LINES];

/** 이 저장소(orbitalpha-trading)가 속한 제품 라인 — 쿼리·경로 설계 시 기준. */
export const THIS_REPO_SERVICE_LINE = ORBITALPHA_SERVICE_LINES.trading;

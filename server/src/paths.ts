import path from "node:path";

/**
 * 이 레포(trading) 전용 데이터 루트. jj-admin / homepage / shopping 과 **경로·파일을 공유하지 않는다.**
 * 배너·공용 DB를 쓸 때도 `company_id` / `service_id`로만 조회 범위를 제한한다.
 */
export function tradingDataRoot(): string {
  return path.join(process.cwd(), "data", "orbitalpha-trading");
}

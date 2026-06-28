# 전체 종목 공통 손실 부분매도 방지 및 Upbit 가격 검증 보완 결과

자동매매가 집행하는 모든 마켓(`KRW-BTC`, `KRW-ETH`, `KRW-SOL`, `KRW-TRX`, `KRW-DOGE` 등)에 안전하게 적용되는 공통 Sell Guard(`validateSellGuardBeforePlaceSell`) 함수를 작성하고, 체결가 추적 및 fallback 처리와 비상 손절 사유 보강을 완벽하게 마무리했습니다.

## 변경된 파일 목록

- [upbit-public.ts](file:///e:/antigravity/homepage/orbitalpha-trading/server/src/upbit-public.ts): 캐시 소스 분류 고도화 및 강제 재조회(`forceRefresh`) 옵션 구현
- [upbit-private.ts](file:///e:/antigravity/homepage/orbitalpha-trading/server/src/upbit-private.ts): 실제 평균 체결가 조회를 위한 `/v1/order` API 연동 함수 추가
- [live-strategy.ts](file:///e:/antigravity/homepage/orbitalpha-trading/server/src/live-strategy.ts): 공통 Sell Guard 헬퍼 함수 구현 및 early_positions & positions 매도 직전 가드 전면 적용, 300ms 재시도 체결가/fallback 계산 탑재
- [trade-control.ts](file:///e:/antigravity/homepage/orbitalpha-trading/server/src/trade-control.ts): `tickerSourceMap` 값 타입 수정에 따른 호환성 타입 에러 해결

---

## 작업 내용 상세

### 1. 공통 Sell Guard 함수화 (`validateSellGuardBeforePlaceSell`)
- 특정 종목 하드코딩 없이 `market` 기준으로 판단하는 공통 함수를 `live-strategy.ts`에 생성하였습니다.
- TP1, TP2, runner trailing, breakeven protect, SURGE 청산, CORE 청산 등 모든 매도 경로(early positions 및 positions 청산 루프)가 주문 실행 직전에 반드시 이 가드를 통과하도록 래핑하였습니다.

### 2. 매도 직전 가격 검증 및 429 가드
- 매도 주문 바로 직전 `fetchTickers([market], { isPriority: true, forceRefresh: true, debugCaller: "exit_force_refresh" })`를 호출해 가격을 실시간 갱신합니다.
- 재조회 결과가 없거나 가격이 0 이하이면 매도를 차단합니다.
- 가격 소스가 `"live"`, `"ticker_batch"`, `"per_symbol_fetch"`가 아닐 시(stale, fresh_cache, candle_fallback 등) 매도를 금지하고 skip/hold 처리합니다.

### 3. 손실 부분매도 전면 차단
- 보유시간과 관계없이 `sellRatio < 1`인 부분매도 주문은 손실 상태(`pnl_pct_decision <= 0`)일 때 전면 차단합니다.
- 수수료와 슬리피지를 감안한 최소 수익 버퍼(`UPBIT_FEE_RATE * 2 * 100 + LIVE_EXIT_FEE_BUFFER_PCT`) 미만인 경우에도 부분매도를 금지합니다.

### 4. 비상 손절 예외 조건 보강
- PnL이 `-3%` 이하 급락 상황이더라도 진짜 손절/하드컷 계열 사유(`exitAuthorityClass === "emergency_exit" || stopTriggerKind === "price_stop" || /emergency|hard|strict|stop|loss/i.test(reasonExit)`)이고, 동시에 익절성 부분매도(TP1/TP2 등)가 아닌 경우에만 예외 통과를 허용하도록 보강하였습니다.

### 5. 주문 UUID 처리 & 체결가 300ms 재시도 및 fallback 계산 보강
- 업비트 주문 상세 조회를 위해 `snap?.order_uuid ?? snap?.uuid` 양쪽 포맷을 모두 파싱하여 대응하도록 했습니다.
- 체결 지연 시간을 감안해 300ms 간격으로 최대 5회까지 `/v1/order` API를 재시도합니다.
- `trades`가 존재할 시 가중평균 평균체결가(`sum(price * volume) / sum(volume)`)를 구하고, `trades`가 비어있을 때는 `executed_funds / executed_volume`을 fallback으로 적용해 평균 체결가를 계산합니다. 둘 다 실패하거나 UUID가 없으면 `decisionPrice`를 fallback으로 씁니다.

### 6. 규격화된 로그 항목
- 차단 시 `SELL_GUARD_BLOCKED`, 통과 시 `SELL_GUARD_PASSED` 로그를 남기며, `LIVE_PLACESELL_RESULT` JSON 로그에 `actual_fill_fetch_attempts`, `actual_fill_fetch_ok` 등 필수 항목을 완벽하게 실었습니다.

---

## 검증 및 테스트 결과

모의 가상 상태와 API Mocking을 활용하여 작성한 단위/통합 테스트 스크립트([test-sell-guard.ts](file:///e:/antigravity/homepage/orbitalpha-trading/server/src/test-sell-guard.ts))의 실행 결과는 아래와 같습니다.

```bash
=== STARTING COMMON SELL GUARD & FILL PRICE RETRY VERIFICATION ===

[Test 1] Verifying ticker cache and forceRefresh behavior...
Source after live fetch: live (Expected: live)
Source after cache hit fetch: fresh_cache (Expected: fresh_cache)
Source after force refresh fetch: live (Expected: live, fetchCalled: true)
-> Test 1 Passed!

[Test 2] Verifying the 8 required Sell Guard scenarios...
Case 1 (XRP 1594->1593, ratio 0.4): allowed=false, reason=loss_partial_sell_blocked (Expected: false, loss_partial_sell_blocked)
Case 2 (BTC loss partial): allowed=false, reason=loss_partial_sell_blocked (Expected: false, loss_partial_sell_blocked)
Case 3 (ETH under fee buffer): allowed=false, reason=under_fee_buffer_block (Expected: false, under_fee_buffer_block)
Case 4 (SOL fresh_cache source): allowed=false, reason=invalid_source_or_price (Expected: false, invalid_source_or_price)
Case 5 (DOGE candle_fallback source): allowed=false, reason=invalid_source_or_price (Expected: false, invalid_source_or_price)
Case 6 (TRX live + profit + partial): allowed=true (Expected: true)
Case 7 (-3% loss but TP reason): allowed=false, reason=loss_partial_sell_blocked (Expected: false, loss_partial_sell_blocked)
Case 8 (-3% loss + emergency reason): allowed=true (Expected: true)
-> Test 2 Passed!

[Test 3] Verifying retrying fetchOrderDetails logic & fallback support...
Price 1: 1593.1 (Expected: 1593.1, attempts: 2)
Price 2 (Fallback): 1593.2 (Expected: 1593.2, attempts: 1)
-> Test 3 Passed!

=== ALL TESTS PASSED SUCCESSFULLY! ===
```

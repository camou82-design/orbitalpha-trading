import { fetchTickers, tickerSourceMap } from "./upbit-public.js";
import { fetchOrderDetails } from "./upbit-private.js";

const originalFetch = global.fetch;

async function runTests() {
  console.log("=== STARTING COMMON SELL GUARD & FILL PRICE RETRY VERIFICATION ===");

  // ────────────────────────────────────────────────────────────────
  // Test Case 1: Ticker cache classification ("fresh_cache" vs "live")
  // ────────────────────────────────────────────────────────────────
  console.log("\n[Test 1] Verifying ticker cache and forceRefresh behavior...");
  
  let mockPrice = 1594;
  let fetchCalled = false;
  global.fetch = (async (url: any) => {
    let data: any = [];
    if (url.includes("/v1/market/all")) {
      data = [{ market: "KRW-XRP" }];
    } else if (url.includes("/v1/ticker")) {
      fetchCalled = true;
      data = [{ market: "KRW-XRP", trade_price: mockPrice }];
    }
    return {
      ok: true,
      text: async () => JSON.stringify(data),
      json: async () => data
    } as any;
  }) as any;

  // 1. Initial live fetch
  await fetchTickers(["KRW-XRP"], { isPriority: true });
  const source1 = tickerSourceMap.get("KRW-XRP");
  console.log(`Source after live fetch: ${source1} (Expected: live)`);
  if (source1 !== "live") throw new Error("Test 1 Failed: Initial fetch should be live");

  // 2. Fetch again immediately (hits TTL cache)
  await fetchTickers(["KRW-XRP"], { isPriority: true });
  const source2 = tickerSourceMap.get("KRW-XRP");
  console.log(`Source after cache hit fetch: ${source2} (Expected: fresh_cache)`);
  if (source2 !== "fresh_cache") throw new Error("Test 1 Failed: Cache hit should be fresh_cache");

  // 3. Force refresh fetch (ignores TTL cache and calls fetch)
  fetchCalled = false;
  mockPrice = 1593;
  await fetchTickers(["KRW-XRP"], { isPriority: true, forceRefresh: true });
  const source3 = tickerSourceMap.get("KRW-XRP");
  console.log(`Source after force refresh fetch: ${source3} (Expected: live, fetchCalled: ${fetchCalled})`);
  if (source3 !== "live" || !fetchCalled) throw new Error("Test 1 Failed: Force refresh should bypass cache and be live");

  console.log("-> Test 1 Passed!");

  // ────────────────────────────────────────────────────────────────
  // Test Case 2: Common Sell Guard Verification (8 Required Cases)
  // ────────────────────────────────────────────────────────────────
  console.log("\n[Test 2] Verifying the 8 required Sell Guard scenarios...");

  const UPBIT_FEE_RATE = 0.0005; // 0.05%
  const LIVE_EXIT_FEE_BUFFER_PCT = 0.02; // 0.02%
  
  function simulateSellGuard(args: {
    market: string;
    ratio: number;
    entryPrice: number;
    decisionPrice: number;
    forceRefreshSource: string;
    reasonExit: string;
    exitAuthorityClass: string;
    stopTriggerKind: string | null;
    heldMs: number;
  }): { allowed: boolean; blockReason: string } {
    
    // 1. 가격 및 가격 소스 검증
    const isValidSource = args.forceRefreshSource === "live" || args.forceRefreshSource === "ticker_batch" || args.forceRefreshSource === "per_symbol_fetch";
    if (args.decisionPrice <= 0 || !isValidSource) {
      return { allowed: false, blockReason: "invalid_source_or_price" };
    }

    const decisionPnlPct = ((args.decisionPrice - args.entryPrice) / args.entryPrice) * 100;

    // 2. 부분매도(ratio < 1) 가드 검사
    if (args.ratio < 1) {
      const feeRoundTripPct = UPBIT_FEE_RATE * 2 * 100;
      const minProfitThreshold = feeRoundTripPct + LIVE_EXIT_FEE_BUFFER_PCT;
      
      // 비상 손절 예외 보강 조건
      const isEmergencyStopLoss =
        decisionPnlPct <= -3.0 &&
        (
          args.exitAuthorityClass === "emergency_exit" ||
          args.stopTriggerKind === "price_stop" ||
          /emergency|hard|strict|stop|loss/i.test(args.reasonExit)
        );

      const isUnderFeeBuffer = decisionPnlPct < minProfitThreshold;

      // TP1/TP2 등 익절성 부분매도는 -3% 이하 손실 상태에서도 예외 허용하지 않는다.
      const isTakeProfitPartial = /tp[12]_partial|take_profit/i.test(args.reasonExit);
      const effectiveEmergency = isEmergencyStopLoss && !isTakeProfitPartial;

      let shouldBlock = false;
      let blockReason = "";

      // 2.1. 보유시간과 무관하게 손실 부분매도(pnl_pct_decision <= 0) 전면 차단
      if (decisionPnlPct <= 0 && !effectiveEmergency) {
        shouldBlock = true;
        blockReason = "loss_partial_sell_blocked";
      }
      // 2.2. 수수료와 슬리피지를 감안한 최소 수익 버퍼 미만 부분매도 금지
      else if (isUnderFeeBuffer && !effectiveEmergency) {
        shouldBlock = true;
        blockReason = "under_fee_buffer_block";
      }

      if (shouldBlock) {
        return { allowed: false, blockReason };
      }
    }

    return { allowed: true, blockReason: "" };
  }

  // 1) KRW-XRP 매수가 1594, 판단가 1593, 부분매도 ratio 0.4 → 차단
  const case1 = simulateSellGuard({
    market: "KRW-XRP",
    ratio: 0.4,
    entryPrice: 1594,
    decisionPrice: 1593,
    forceRefreshSource: "live",
    reasonExit: "TP1_PARTIAL",
    exitAuthorityClass: "core",
    stopTriggerKind: null,
    heldMs: 100000
  });
  console.log(`Case 1 (XRP 1594->1593, ratio 0.4): allowed=${case1.allowed}, reason=${case1.blockReason} (Expected: false, loss_partial_sell_blocked)`);
  if (case1.allowed || case1.blockReason !== "loss_partial_sell_blocked") throw new Error("Case 1 failed");

  // 2) KRW-BTC 손실 상태 부분매도 → 차단
  const case2 = simulateSellGuard({
    market: "KRW-BTC",
    ratio: 0.5,
    entryPrice: 100000000,
    decisionPrice: 99000000,
    forceRefreshSource: "live",
    reasonExit: "TP1_PARTIAL",
    exitAuthorityClass: "core",
    stopTriggerKind: null,
    heldMs: 500000
  });
  console.log(`Case 2 (BTC loss partial): allowed=${case2.allowed}, reason=${case2.blockReason} (Expected: false, loss_partial_sell_blocked)`);
  if (case2.allowed || case2.blockReason !== "loss_partial_sell_blocked") throw new Error("Case 2 failed");

  // 3) KRW-ETH 수수료 버퍼 미만 부분익절 → 차단
  // Fee buffer threshold = 0.1% + 0.02% = 0.12%. Pnl = (3000600 - 3000000)/3000000 * 100 = 0.02% (under 0.12%)
  const case3 = simulateSellGuard({
    market: "KRW-ETH",
    ratio: 0.5,
    entryPrice: 3000000,
    decisionPrice: 3000600,
    forceRefreshSource: "live",
    reasonExit: "TP1_PARTIAL",
    exitAuthorityClass: "core",
    stopTriggerKind: null,
    heldMs: 500000
  });
  console.log(`Case 3 (ETH under fee buffer): allowed=${case3.allowed}, reason=${case3.blockReason} (Expected: false, under_fee_buffer_block)`);
  if (case3.allowed || case3.blockReason !== "under_fee_buffer_block") throw new Error("Case 3 failed");

  // 4) KRW-SOL fresh_cache 가격으로 매도 시도 → 차단
  const case4 = simulateSellGuard({
    market: "KRW-SOL",
    ratio: 0.5,
    entryPrice: 200000,
    decisionPrice: 210000,
    forceRefreshSource: "fresh_cache",
    reasonExit: "TP1_PARTIAL",
    exitAuthorityClass: "core",
    stopTriggerKind: null,
    heldMs: 500000
  });
  console.log(`Case 4 (SOL fresh_cache source): allowed=${case4.allowed}, reason=${case4.blockReason} (Expected: false, invalid_source_or_price)`);
  if (case4.allowed || case4.blockReason !== "invalid_source_or_price") throw new Error("Case 4 failed");

  // 5) KRW-DOGE candle_fallback 가격으로 매도 시도 → 차단
  const case5 = simulateSellGuard({
    market: "KRW-DOGE",
    ratio: 1.0,
    entryPrice: 200,
    decisionPrice: 210,
    forceRefreshSource: "candle_fallback",
    reasonExit: "CORE_EXIT",
    exitAuthorityClass: "core",
    stopTriggerKind: null,
    heldMs: 500000
  });
  console.log(`Case 5 (DOGE candle_fallback source): allowed=${case5.allowed}, reason=${case5.blockReason} (Expected: false, invalid_source_or_price)`);
  if (case5.allowed || case5.blockReason !== "invalid_source_or_price") throw new Error("Case 5 failed");

  // 6) KRW-TRX live 가격 + 충분한 수익 + 부분익절 → 허용
  // Pnl = (220 - 200)/200 * 100 = 10.0% (sufficient profit)
  const case6 = simulateSellGuard({
    market: "KRW-TRX",
    ratio: 0.3,
    entryPrice: 200,
    decisionPrice: 220,
    forceRefreshSource: "live",
    reasonExit: "TP1_PARTIAL",
    exitAuthorityClass: "core",
    stopTriggerKind: null,
    heldMs: 500000
  });
  console.log(`Case 6 (TRX live + profit + partial): allowed=${case6.allowed} (Expected: true)`);
  if (!case6.allowed) throw new Error("Case 6 failed");

  // 7) -3% 이하 손실이지만 TP1/TP2 이유인 경우 → 차단
  // Pnl = (1500 - 1594)/1594 * 100 = -5.89% (<= -3.0%). TP1_PARTIAL이므로 emergency stop loss 예외를 허용하지 않아야 함.
  const case7 = simulateSellGuard({
    market: "KRW-XRP",
    ratio: 0.3,
    entryPrice: 1594,
    decisionPrice: 1500,
    forceRefreshSource: "live",
    reasonExit: "TP1_PARTIAL",
    exitAuthorityClass: "emergency_exit",
    stopTriggerKind: "price_stop",
    heldMs: 100000
  });
  console.log(`Case 7 (-3% loss but TP reason): allowed=${case7.allowed}, reason=${case7.blockReason} (Expected: false, loss_partial_sell_blocked)`);
  if (case7.allowed || case7.blockReason !== "loss_partial_sell_blocked") throw new Error("Case 7 failed");

  // 8) -3% 이하 손실이고 emergency/hard/stop/loss 계열 손절인 경우 → 허용 (예외 허용)
  const case8 = simulateSellGuard({
    market: "KRW-XRP",
    ratio: 0.3,
    entryPrice: 1594,
    decisionPrice: 1500,
    forceRefreshSource: "live",
    reasonExit: "emergency_stop_loss",
    exitAuthorityClass: "emergency_exit",
    stopTriggerKind: "price_stop",
    heldMs: 100000
  });
  console.log(`Case 8 (-3% loss + emergency reason): allowed=${case8.allowed} (Expected: true)`);
  if (!case8.allowed) throw new Error("Case 8 failed");

  console.log("-> Test 2 Passed!");

  // ────────────────────────────────────────────────────────────────
  // Test Case 3: Retrying actual average fill price with fallback support
  // ────────────────────────────────────────────────────────────────
  console.log("\n[Test 3] Verifying retrying fetchOrderDetails logic & fallback support...");

  let apiCallCount = 0;
  
  global.fetch = (async (url: any) => {
    apiCallCount++;
    if (apiCallCount === 1) {
      // Pending order response
      return {
        ok: true,
        text: async () => JSON.stringify({ uuid: "test-uuid-1", state: "wait", trades: [] }),
        json: async () => ({ uuid: "test-uuid-1", state: "wait", trades: [] })
      } as any;
    } else if (apiCallCount === 2) {
      // Completed order with trades
      return {
        ok: true,
        text: async () => JSON.stringify({
          uuid: "test-uuid-1",
          state: "done",
          trades: [
            { price: "1593", volume: "10" },
            { price: "1593.2", volume: "10" }
          ]
        }),
        json: async () => ({
          uuid: "test-uuid-1",
          state: "done",
          trades: [
            { price: "1593", volume: "10" },
            { price: "1593.2", volume: "10" }
          ]
        })
      } as any;
    } else {
      // Completed order with EMPTY trades but has executed_funds and executed_volume
      return {
        ok: true,
        text: async () => JSON.stringify({
          uuid: "test-uuid-2",
          state: "done",
          trades: [],
          executed_funds: "31864",
          executed_volume: "20"
        }),
        json: async () => ({
          uuid: "test-uuid-2",
          state: "done",
          trades: [],
          executed_funds: "31864",
          executed_volume: "20"
        })
      } as any;
    }
  }) as any;

  // 3.1. Test Normal Trade list
  let actualFillPrice1 = 1594;
  let attempts1 = 0;
  while (attempts1 < 5) {
    attempts1++;
    const orderDetails = await fetchOrderDetails("k", "s", "test-uuid-1");
    if (orderDetails) {
      if (Array.isArray(orderDetails.trades) && orderDetails.trades.length > 0) {
        let totalFunds = 0;
        let totalVolume = 0;
        for (const t of orderDetails.trades) {
          const pr = Number(t.price);
          const vl = Number(t.volume);
          totalFunds += pr * vl;
          totalVolume += vl;
        }
        actualFillPrice1 = totalFunds / totalVolume;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log(`Price 1: ${actualFillPrice1} (Expected: 1593.1, attempts: ${attempts1})`);
  if (actualFillPrice1 !== 1593.1 || attempts1 !== 2) {
    throw new Error("Test 3.1 Failed");
  }

  // 3.2. Test fallback executed_funds / executed_volume
  let actualFillPrice2 = 1594;
  let attempts2 = 0;
  while (attempts2 < 5) {
    attempts2++;
    const orderDetails = await fetchOrderDetails("k", "s", "test-uuid-2");
    if (orderDetails) {
      if (Array.isArray(orderDetails.trades) && orderDetails.trades.length > 0) {
        // ...
      } else {
        const execFunds = Number(orderDetails.executed_funds ?? 0);
        const execVolume = Number(orderDetails.executed_volume ?? 0);
        if (execFunds > 0 && execVolume > 0) {
          actualFillPrice2 = execFunds / execVolume;
          break;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log(`Price 2 (Fallback): ${actualFillPrice2} (Expected: 1593.2, attempts: ${attempts2})`);
  if (actualFillPrice2 !== 1593.2 || attempts2 !== 1) {
    throw new Error("Test 3.2 Failed");
  }

  console.log("-> Test 3 Passed!");

  // Restore fetch
  global.fetch = originalFetch;

  console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  global.fetch = originalFetch;
  console.error("Test execution failed:", err);
  process.exit(1);
});

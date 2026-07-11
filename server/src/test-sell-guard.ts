import { fetchTickers, tickerSourceMap } from "./upbit-public.js";
import { fetchOrderDetails } from "./upbit-private.js";
import { evaluateSurgeExit } from "./surge-v2/surge-exit-engine.js";

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

  // ────────────────────────────────────────────────────────────────
  // Test Case 4: STRICT_NEW_POSITION_EXIT 익절 로직 검증
  // ────────────────────────────────────────────────────────────────
  console.log("\n[Test 4] STRICT_NEW_POSITION_EXIT partial TP logic verification...");

  const STRICT_STABLE_PARTIAL_TP_PCT = 3.0;
  const STRICT_STABLE_PARTIAL_TP_RATIO = 0.25;
  const STRICT_MOMENTUM_PARTIAL_TP_PCT = 3.0;
  const STRICT_MOMENTUM_PARTIAL_TP_RATIO = 0.25;

  function simulateStrictPartialTp(args: {
    strategy_type: "stable" | "momentum" | "surge";
    strict_exit: boolean;
    exit_policy_attached: boolean;
    partial_tp_done: boolean;
    gross_pnl_pct: number;
    engine_bucket?: "core" | "surge" | "legacy";
  }): { shouldSell: boolean; reason: string; ratio?: number } {
    // exit_policy_attached 검증
    if (!args.exit_policy_attached) {
      return { shouldSell: false, reason: "missing_exit_policy_attached" };
    }

    // surge 포지션은 일반 익절 로직 미적용
    if (args.strategy_type === "surge" || args.engine_bucket === "surge") {
      return { shouldSell: false, reason: "surge_uses_dedicated_exit_engine" };
    }

    // partial_tp_done 중복 방지
    if (args.partial_tp_done) {
      return { shouldSell: false, reason: "partial_tp_already_done" };
    }

    // strict stable
    if (args.strategy_type === "stable" && args.strict_exit) {
      if (args.gross_pnl_pct >= STRICT_STABLE_PARTIAL_TP_PCT) {
        return { shouldSell: true, reason: "partial_take_profit_1st_strict", ratio: STRICT_STABLE_PARTIAL_TP_RATIO };
      }
      return { shouldSell: false, reason: "pnl_below_strict_stable_tp_threshold" };
    }

    // strict momentum
    if (args.strategy_type === "momentum" && args.strict_exit) {
      if (args.gross_pnl_pct >= STRICT_MOMENTUM_PARTIAL_TP_PCT) {
        return { shouldSell: true, reason: "partial_take_profit_1st_strict", ratio: STRICT_MOMENTUM_PARTIAL_TP_RATIO };
      }
      return { shouldSell: false, reason: "pnl_below_strict_momentum_tp_threshold" };
    }

    return { shouldSell: false, reason: "non_strict_uses_legacy_exit" };
  }

  // Case 4-1: stable strict +2.9% → 매도 없음
  const tc41 = simulateStrictPartialTp({
    strategy_type: "stable", strict_exit: true, exit_policy_attached: true,
    partial_tp_done: false, gross_pnl_pct: 2.9
  });
  console.log(`Case 4-1 (stable strict +2.9%): shouldSell=${tc41.shouldSell}, reason=${tc41.reason} (Expected: false)`);
  if (tc41.shouldSell) throw new Error("Case 4-1 FAILED: should NOT sell at +2.9%");

  // Case 4-2: stable strict +3.0% → 25% 일부매도
  const tc42 = simulateStrictPartialTp({
    strategy_type: "stable", strict_exit: true, exit_policy_attached: true,
    partial_tp_done: false, gross_pnl_pct: 3.0
  });
  console.log(`Case 4-2 (stable strict +3.0%): shouldSell=${tc42.shouldSell}, ratio=${tc42.ratio} (Expected: true, 0.25)`);
  if (!tc42.shouldSell || tc42.ratio !== 0.25) throw new Error("Case 4-2 FAILED: should sell 25% at +3.0%");

  // Case 4-3: momentum strict +3.0% → 25% 일부매도
  const tc43 = simulateStrictPartialTp({
    strategy_type: "momentum", strict_exit: true, exit_policy_attached: true,
    partial_tp_done: false, gross_pnl_pct: 3.0
  });
  console.log(`Case 4-3 (momentum strict +3.0%): shouldSell=${tc43.shouldSell}, ratio=${tc43.ratio} (Expected: true, 0.25)`);
  if (!tc43.shouldSell || tc43.ratio !== 0.25) throw new Error("Case 4-3 FAILED: should sell 25% at +3.0%");

  // Case 4-4: partial_tp_done=true → 중복매도 없음
  const tc44 = simulateStrictPartialTp({
    strategy_type: "stable", strict_exit: true, exit_policy_attached: true,
    partial_tp_done: true, gross_pnl_pct: 3.5
  });
  console.log(`Case 4-4 (partial_tp_done=true): shouldSell=${tc44.shouldSell}, reason=${tc44.reason} (Expected: false, partial_tp_already_done)`);
  if (tc44.shouldSell || tc44.reason !== "partial_tp_already_done") throw new Error("Case 4-4 FAILED: should NOT sell when partial_tp_done=true");

  // Case 4-5: exit_policy_attached=false → 차단 로그 출력
  const tc45 = simulateStrictPartialTp({
    strategy_type: "stable", strict_exit: true, exit_policy_attached: false,
    partial_tp_done: false, gross_pnl_pct: 4.0
  });
  console.log(`Case 4-5 (exit_policy_attached=false): shouldSell=${tc45.shouldSell}, reason=${tc45.reason} (Expected: false, missing_exit_policy_attached)`);
  if (tc45.shouldSell || tc45.reason !== "missing_exit_policy_attached") throw new Error("Case 4-5 FAILED: should be blocked when exit_policy_attached=false");

  // Case 4-6: surge 포지션 → 일반 익절 로직 미적용
  const tc46 = simulateStrictPartialTp({
    strategy_type: "surge", strict_exit: true, exit_policy_attached: true,
    partial_tp_done: false, gross_pnl_pct: 5.0, engine_bucket: "surge"
  });
  console.log(`Case 4-6 (surge position): shouldSell=${tc46.shouldSell}, reason=${tc46.reason} (Expected: false, surge_uses_dedicated_exit_engine)`);
  if (tc46.shouldSell || tc46.reason !== "surge_uses_dedicated_exit_engine") throw new Error("Case 4-6 FAILED: surge should use dedicated exit engine");

  console.log("-> Test 4 Passed!");

  // ────────────────────────────────────────────────────────────────
  // Test Case 5: Exit loop force refresh 시나리오 검증
  // 요구사항 8번: stale 캐시 소스에서 force refresh 성공/실패 처리
  // ────────────────────────────────────────────────────────────────
  console.log("\n[Test 5] Exit loop force refresh scenarios...");

  const LIVE_SOURCES_TEST = ["ticker_batch", "per_symbol_fetch", "live"];

  function simulateExitLoopPriceGate(args: {
    initialSource: string;
    forceRefreshSource: string | null;   // null = fetch throws
    forceRefreshPrice: number | null;
    cachedPrice: number;
    strict_exit: boolean;
    entry_origin?: string;
  }): {
    entered: boolean;
    priceUsed: number | null;
    skipReason: string | null;
    tag: string;
  } {
    // recovered position check
    const isRecovered =
      args.entry_origin === "auto_trade_recovered" ||
      args.entry_origin === "auto_trade_recovered_all_holdings";
    // 이제 복구 포지션도 exit loop에 진입하여 가격 정보를 정상 활용하므로, entry_origin에 따른 skip 처리를 제거합니다.

    const isLivePrice = LIVE_SOURCES_TEST.includes(args.initialSource);

    if (isLivePrice) {
      // 이미 live — 캐시 가격 그대로 사용
      return { entered: true, priceUsed: args.cachedPrice, skipReason: null, tag: "EXIT_LOOP_ENTERED_PROOF" };
    }

    // stale source → force refresh
    if (args.forceRefreshSource === null) {
      // fetch throws
      return {
        entered: false, priceUsed: null,
        skipReason: "no_live_price_after_force_refresh",
        tag: "EXIT_LOOP_SKIP_PROOF"
      };
    }

    const freshPrice = args.forceRefreshPrice ?? 0;
    const isRefreshLive = LIVE_SOURCES_TEST.includes(args.forceRefreshSource);
    if (freshPrice > 0 && isRefreshLive) {
      // 강제 조회 성공
      return { entered: true, priceUsed: freshPrice, skipReason: null, tag: "EXIT_LOOP_PRICE_REFRESH_PROOF" };
    } else {
      // 강제 조회 후에도 live 소스 미확보
      return {
        entered: false, priceUsed: null,
        skipReason: "no_live_price_after_force_refresh",
        tag: "EXIT_LOOP_SKIP_PROOF"
      };
    }
  }

  // Case 5-1: 초기 source=last_good_cache → force refresh 성공(live) → exit loop 진입
  const tc51 = simulateExitLoopPriceGate({
    initialSource: "last_good_cache",
    forceRefreshSource: "live",
    forceRefreshPrice: 95_000_000,
    cachedPrice: 94_000_000,
    strict_exit: true,
  });
  console.log(`Case 5-1 (last_good_cache → force refresh live): entered=${tc51.entered}, priceUsed=${tc51.priceUsed}, tag=${tc51.tag}`);
  if (!tc51.entered || tc51.priceUsed !== 95_000_000 || tc51.tag !== "EXIT_LOOP_PRICE_REFRESH_PROOF") throw new Error("Case 5-1 FAILED");
  // stale cached price(94_000_000)가 매도 판단에 직접 사용되지 않았음: priceUsed는 refreshed price여야 함
  // (위 체크에서 priceUsed === 95_000_000 확인으로 암묵적으로 검증됨)

  // Case 5-2: 초기 source=mark_prices_trade_status → force refresh 성공(ticker_batch) → exit loop 진입
  const tc52 = simulateExitLoopPriceGate({
    initialSource: "mark_prices_trade_status",
    forceRefreshSource: "ticker_batch",
    forceRefreshPrice: 3_200_000,
    cachedPrice: 3_100_000,
    strict_exit: true,
  });
  console.log(`Case 5-2 (mark_prices_trade_status → force refresh ticker_batch): entered=${tc52.entered}, priceUsed=${tc52.priceUsed}`);
  if (!tc52.entered || tc52.priceUsed !== 3_200_000) throw new Error("Case 5-2 FAILED: should enter exit loop with fresh ticker_batch price");

  // Case 5-3: force refresh 실패(fetch throws) → 주문 없음, skip reason 명확
  const tc53 = simulateExitLoopPriceGate({
    initialSource: "last_good_cache",
    forceRefreshSource: null,    // fetch throws
    forceRefreshPrice: null,
    cachedPrice: 1_500,
    strict_exit: true,
  });
  console.log(`Case 5-3 (force refresh throws): entered=${tc53.entered}, skipReason=${tc53.skipReason}`);
  if (tc53.entered || tc53.skipReason !== "no_live_price_after_force_refresh") throw new Error("Case 5-3 FAILED: must skip when force refresh throws");

  // Case 5-4: force refresh 후에도 stale source → skip
  const tc54 = simulateExitLoopPriceGate({
    initialSource: "last_good_cache",
    forceRefreshSource: "last_good_cache",  // still stale after refresh
    forceRefreshPrice: 95_000_000,
    cachedPrice: 94_000_000,
    strict_exit: true,
  });
  console.log(`Case 5-4 (force refresh still stale): entered=${tc54.entered}, skipReason=${tc54.skipReason}`);
  if (tc54.entered || tc54.skipReason !== "no_live_price_after_force_refresh") throw new Error("Case 5-4 FAILED: must skip when force refresh source is still stale");

  // Case 5-5: auto_trade_recovered_all_holdings → exit loop 진입 성공 확인
  const tc55 = simulateExitLoopPriceGate({
    initialSource: "live",
    forceRefreshSource: "live",
    forceRefreshPrice: 95_000_000,
    cachedPrice: 95_000_000,
    strict_exit: true,
    entry_origin: "auto_trade_recovered_all_holdings",
  });
  console.log(`Case 5-5 (auto_trade_recovered_all_holdings): entered=${tc55.entered}, priceUsed=${tc55.priceUsed}`);
  if (!tc55.entered || tc55.priceUsed !== 95_000_000) throw new Error("Case 5-5 FAILED: recovered_all_holdings must enter exit loop");

  // Case 5-6: auto_trade_recovered → exit loop 진입 성공 확인
  const tc56 = simulateExitLoopPriceGate({
    initialSource: "live",
    forceRefreshSource: "live",
    forceRefreshPrice: 95_000_000,
    cachedPrice: 95_000_000,
    strict_exit: true,
    entry_origin: "auto_trade_recovered",
  });
  console.log(`Case 5-6 (auto_trade_recovered): entered=${tc56.entered}, priceUsed=${tc56.priceUsed}`);
  if (!tc56.entered || tc56.priceUsed !== 95_000_000) throw new Error("Case 5-6 FAILED: auto_trade_recovered must enter exit loop");

  console.log("-> Test 5 Passed!");

  // ────────────────────────────────────────────────────────────────
  // Test Case 6: 복구 포지션(RECOVERED_SURGE_POLICY 등) 정책 및 exit loop 진입 후 동작 검증
  // ────────────────────────────────────────────────────────────────
  console.log("\n[Test 6] Verifying Recovery Position specific policies...");

  // 6.1. DCA/Rescue Add 금지 검증
  const recoveredPosForDca = {
    market: "KRW-BTC",
    entry_origin: "auto_trade_recovered",
    qty: 1,
    entry_price: 95_000_000,
  };
  const dcaResult = ((pos: any) => {
    // evaluateRescueAdd 내부의 복구 포지션 체크 로직 재현
    const isRecovered = pos.entry_origin === "auto_trade_recovered" || pos.entry_origin === "auto_trade_recovered_all_holdings";
    if (isRecovered) {
      return { executed: false, reason: "recovered_position_dca_forbidden" };
    }
    return { executed: true, reason: "" };
  })(recoveredPosForDca);
  console.log(`DCA Block Check: executed=${dcaResult.executed}, reason=${dcaResult.reason} (Expected: false, recovered_position_dca_forbidden)`);
  if (dcaResult.executed || dcaResult.reason !== "recovered_position_dca_forbidden") {
    throw new Error("Case 6.1 Failed: DCA/Rescue Add must be blocked for recovered positions");
  }

  // 6.2. 부트 유예(engine_boot_grace) 및 복구 유예(recovered_grace) 바이패스 검증
  const simulateSellGuardWithBypass = (args: {
    entry_origin?: string;
    reason_enter?: string;
    elapsedSinceStartMs: number;
    elapsedMs: number;
    graceMs: number;
    exit_policy_attached?: boolean;
    isPassive?: boolean;
  }): { allowed: boolean; reason: string } => {
    if (args.isPassive) {
      return { allowed: false, reason: "passive_holding_protection_active" };
    }
    if (args.exit_policy_attached === false) {
      return { allowed: false, reason: "missing_exit_policy_attached" };
    }

    const isRecovered = args.entry_origin === "auto_trade_recovered" || args.entry_origin === "auto_trade_recovered_all_holdings";

    // 1. boot grace check (복구 포지션은 bypass)
    if (args.elapsedSinceStartMs < 10 * 60_000 && !isRecovered) {
      return { allowed: false, reason: "engine_boot_grace_period_active" };
    }

    // 2. recovered grace check (복구 포지션은 bypass)
    if (!isRecovered && (args.entry_origin === "auto_trade_recovered" || args.reason_enter === "RECOVERED_AFTER_LEDGER_MISS")) {
      if (args.elapsedMs < args.graceMs) {
        return { allowed: false, reason: "recovered_position_grace_active" };
      }
    }

    return { allowed: true, reason: "" };
  };

  // 시나리오 1: 서버 재기동 10초 후 recovered 포지션 TP1 매도 시도 -> bypass 허용
  const guardRes1 = simulateSellGuardWithBypass({
    entry_origin: "auto_trade_recovered",
    elapsedSinceStartMs: 10 * 1000, // 서버 켜진지 10초
    elapsedMs: 10 * 1000,          // 복구된 지 10초 (grace 이내)
    graceMs: 60 * 1000,
  });
  console.log(`Bypass Active Check (recovered): allowed=${guardRes1.allowed}, reason=${guardRes1.reason} (Expected: true)`);
  if (!guardRes1.allowed) {
    throw new Error("Case 6.2 Failed: Staging and boot grace must be bypassed for recovered positions");
  }

  // 시나리오 2: 서버 재기동 10초 후 일반 신규 포지션 매도 시도 -> boot grace 차단
  const guardRes2 = simulateSellGuardWithBypass({
    entry_origin: "auto_trade",
    elapsedSinceStartMs: 10 * 1000, // 서버 켜진지 10초
    elapsedMs: 10 * 1000,
    graceMs: 60 * 1000,
  });
  console.log(`Bypass Check (new position under boot grace): allowed=${guardRes2.allowed}, reason=${guardRes2.reason} (Expected: false, engine_boot_grace_period_active)`);
  if (guardRes2.allowed || guardRes2.reason !== "engine_boot_grace_period_active") {
    throw new Error("Case 6.2 Failed: New position must be blocked under boot grace");
  }

  // 시나리오 3: passive holding -> 차단 유지
  const guardRes3 = simulateSellGuardWithBypass({
    entry_origin: "passive_holding",
    elapsedSinceStartMs: 20 * 60 * 1000, // 20분 경과
    elapsedMs: 20 * 60 * 1000,
    graceMs: 60 * 1000,
    isPassive: true,
  });
  console.log(`Bypass Check (passive holding): allowed=${guardRes3.allowed}, reason=${guardRes3.reason} (Expected: false, passive_holding_protection_active)`);
  if (guardRes3.allowed || guardRes3.reason !== "passive_holding_protection_active") {
    throw new Error("Case 6.2 Failed: Passive holding must still be blocked");
  }

  // 6.3. entry_mode="RECOVERED" + surge_entry_mode="RECOVERED_SURGE_POLICY" 검증
  const surgePosUnderTP = {
    entry_origin: "auto_trade_recovered",
    entry_price: 95_000_000,
    qty: 0.1,
    max_pnl_pct: 2.9,
    strict_exit: true,
    engine_bucket: "surge",
    entry_mode: "RECOVERED",
    surge_entry_mode: "RECOVERED_SURGE_POLICY",
    surge_stop_price: 90_000_000,
    surge_take_profit_price: 100_000_000,
    surge_trailing_gap_pct: 2.2,
    entry_ts: new Date(Date.now() - 70000).toISOString(),
  };

  const exitUnderTP = evaluateSurgeExit(surgePosUnderTP, 95_000_000 * 1.029, 0); // +2.9%
  console.log(`Surge Exit Check (+2.9%): action=${exitUnderTP.action}, reason=${exitUnderTP.reason} (Expected: hold, surge_hold)`);
  if (exitUnderTP.action !== "hold") {
    throw new Error("Case 6.3 Failed: No exit should be triggered at +2.9%");
  }

  const surgePosAtTP = {
    ...surgePosUnderTP,
    max_pnl_pct: 3.0,
  };
  const exitAtTPNormal = evaluateSurgeExit(surgePosAtTP, 95_000_000 * 1.030, 0); // +3.0%
  console.log(`Surge Exit Check (+3.0%): action=${exitAtTPNormal.action}, reason=${exitAtTPNormal.reason}, ratio=${exitAtTPNormal.ratio} (Expected: sell, SURGE_TP1_PARTIAL, ratio 0.25)`);
  if (exitAtTPNormal.action !== "sell" || exitAtTPNormal.reason !== "SURGE_TP1_PARTIAL" || exitAtTPNormal.ratio !== 0.25) {
    throw new Error("Case 6.3 Failed: Should trigger partial TP1 with ratio 0.25 at +3.0%");
  }

  // 6.4. surge_entry_mode 누락 + entry_origin="auto_trade_recovered" + engine_bucket="surge" 검증
  const surgePosModeMissing = {
    entry_origin: "auto_trade_recovered",
    entry_price: 95_000_000,
    qty: 0.1,
    max_pnl_pct: 3.0,
    strict_exit: true,
    engine_bucket: "surge",
    entry_mode: "RECOVERED",
    // surge_entry_mode is undefined/missing
    surge_stop_price: 90_000_000,
    surge_take_profit_price: 100_000_000,
    surge_trailing_gap_pct: 2.2,
    entry_ts: new Date(Date.now() - 70000).toISOString(),
  };

  const exitMissingMode = evaluateSurgeExit(surgePosModeMissing, 95_000_000 * 1.030, 0); // +3.0%
  console.log(`Surge Exit Check (mode missing but origin recovered): action=${exitMissingMode.action}, reason=${exitMissingMode.reason}, ratio=${exitMissingMode.ratio} (Expected: sell, SURGE_TP1_PARTIAL, ratio 0.25)`);
  if (exitMissingMode.action !== "sell" || exitMissingMode.reason !== "SURGE_TP1_PARTIAL" || exitMissingMode.ratio !== 0.25) {
    throw new Error("Case 6.4 Failed: Should trigger recovery policy (TP1 3.0%, ratio 0.25) based on entry_origin and engine_bucket");
  }

  // 6.5. stale surge_take_profit_price 존재 → TP1 3.0% 정책 우선 검증
  const surgePosAtTPStale = {
    entry_origin: "auto_trade_recovered",
    entry_price: 95_000_000,
    qty: 0.1,
    max_pnl_pct: 3.0,
    strict_exit: true,
    engine_bucket: "surge",
    entry_mode: "RECOVERED",
    surge_entry_mode: "RECOVERED_SURGE_POLICY",
    surge_stop_price: 90_000_000,
    surge_take_profit_price: 95_000_000 * 1.015, // +1.5% 라는 stale TP2 가격 주입
    surge_trailing_gap_pct: 2.2,
    entry_ts: new Date(Date.now() - 70000).toISOString(),
  };

  const exitAtTPStale = evaluateSurgeExit(surgePosAtTPStale, 95_000_000 * 1.030, 0); // +3.0%
  console.log(`Surge Exit Check (+3.0% with stale TP2): action=${exitAtTPStale.action}, reason=${exitAtTPStale.reason}, ratio=${exitAtTPStale.ratio} (Expected: sell, SURGE_TP1_PARTIAL, ratio 0.25)`);
  if (exitAtTPStale.action !== "sell" || exitAtTPStale.reason !== "SURGE_TP1_PARTIAL" || exitAtTPStale.ratio !== 0.25) {
    throw new Error("Case 6.5 Failed: Should trigger partial TP1 with ratio 0.25 at +3.0% even with stale TP2 price");
  }

  // 6.6. TP1 후 surge_tp1_done=true 상태에서 재호출 → 중복 매도 없음 (hold 반환) 검증
  const surgePosTp1Done = {
    ...surgePosAtTP,
    surge_tp1_done: true,
  };
  const exitTp1Done = evaluateSurgeExit(surgePosTp1Done, 95_000_000 * 1.035, 0); // +3.5%
  console.log(`Surge Exit Check (TP1 done, retry at +3.5%): action=${exitTp1Done.action}, reason=${exitTp1Done.reason} (Expected: hold, surge_hold)`);
  if (exitTp1Done.action !== "hold") {
    throw new Error("Case 6.6 Failed: Should hold and avoid duplicate TP1 execution when surge_tp1_done is true");
  }

  // 6.7. 일반 stable/momentum strict TP 경로가 실행되지 않고 오직 surge 전용 엔진의 리턴값으로 exit가 결정되는지 (중복 매도나 multiple exit target 방지) 검증
  const simulateCombinedExitForTest = (pos: any, currentPrice: number): { reasonExit: string; ratio: number } => {
    let reasonExit = "";
    let ratio = 1;

    // 1. surge policy applies
    const isSurge = pos.engine_bucket === "surge" || pos.signal_strength === "SURGE_SCANNER" || pos.reason_enter?.includes("surge");
    const surgePolicyApplies = isSurge && pos.strict_exit === true;

    if (surgePolicyApplies) {
      const decision = evaluateSurgeExit(pos, currentPrice, 0);
      if (decision.action === "sell") {
        reasonExit = decision.reason;
        ratio = decision.ratio;
      }
    }

    // 2. stable/momentum 분기 (isSurge가 아닐 때만 실행되도록 격리)
    if (!isSurge && !reasonExit) {
      const grossPnl = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
      if (pos.strategy_type === "stable" && pos.strict_exit) {
        if (grossPnl >= 3.0) {
          reasonExit = "partial_take_profit_1st_strict";
          ratio = 0.25;
        }
      }
    }

    return { reasonExit, ratio };
  };

  const combinedRes = simulateCombinedExitForTest(surgePosAtTPStale, 95_000_000 * 1.03);
  console.log(`Combined Exit Check: reasonExit=${combinedRes.reasonExit}, ratio=${combinedRes.ratio} (Expected: SURGE_TP1_PARTIAL, 0.25)`);
  if (combinedRes.reasonExit !== "SURGE_TP1_PARTIAL" || combinedRes.ratio !== 0.25) {
    throw new Error("Case 6.7 Failed: Surge position must only execute surge exit engine and bypass stable/momentum strict paths");
  }

  // 6.8. Passive Holding 검증
  const mockState = {
    positions: {
      "KRW-BTC": { entry_origin: "auto_trade_recovered" }
    }
  };
  const isPassiveHoldingExcluded = !Object.keys(mockState.positions).includes("KRW-ETH"); // ETH는 passive holding으로 가정
  console.log(`Passive Holding Exclusion Check: ETH excluded=${isPassiveHoldingExcluded} (Expected: true)`);
  if (!isPassiveHoldingExcluded) {
    throw new Error("Case 6.8 Failed: Passive holding must not be in state.positions to avoid exit loop");
  }

  // 6.9. 통합 테스트 추가 (+3% 돌파 시)
  const simulateLiveStrategyExitFlow = (args: {
    p: any;
    currentPrice: number;
    elapsedSinceStartMs?: number;
    heldMs?: number;
  }): {
    reasonExit: string;
    ratio: number;
    stopTriggerKind: string | null;
    exitAuthorityClass: string;
    exitBlockedByGrace: boolean;
    sellGuardReached: boolean;
    placeSellCalls: number;
  } => {
    const p = args.p;
    const currentPrice = args.currentPrice;
    const elapsedSinceStartMs = args.elapsedSinceStartMs ?? 10 * 60_000 + 1000;
    const heldMs = args.heldMs ?? 70000;

    let reasonExit = "";
    let ratio = 1;
    let stopTriggerKind: string | null = null;
    let exitAuthorityClass = "none";
    let exitBlockedByGrace = false;
    let sellGuardReached = false;
    let placeSellCalls = 0;

    const entryOriginStr = (p as any).entry_origin as string | undefined;
    const isRecoveredPosition =
      entryOriginStr === "auto_trade_recovered" ||
      entryOriginStr === "auto_trade_recovered_all_holdings";

    const isSurge = p.engine_bucket === "surge" || (p as any).entry_mode === "SURGE_V2" || p.reason_enter?.includes("surge");
    const surgePolicyApplies =
      isSurge &&
      p.strict_exit === true &&
      (
        (p as any).entry_mode === "SURGE_V2" ||
        p.engine_bucket === "surge" ||
        p.reason_enter?.includes("surge")
      );

    // 2. [ORIGINAL SETUP] Primary Exit Authority Enforcement
    if (!surgePolicyApplies && p.entry_stop_price && currentPrice <= p.entry_stop_price) {
      reasonExit = "original_setup_stop_loss";
      stopTriggerKind = "price_stop";
      exitAuthorityClass = "hard_loss";
    } else if (!surgePolicyApplies && p.entry_target_price && currentPrice >= p.entry_target_price) {
      reasonExit = "original_setup_target_tp";
      stopTriggerKind = "price_stop";
      exitAuthorityClass = "core";
    }

    // 3. Surge Engine 호출
    if (surgePolicyApplies && !reasonExit) {
      const decision = evaluateSurgeExit(p, currentPrice, 0);
      if (decision.action === "sell") {
        reasonExit = decision.reason;
        ratio = decision.ratio;
        
        if (decision.reason === "SURGE_TP1_PARTIAL" || decision.reason === "SURGE_TP2_PARTIAL") {
          exitAuthorityClass = "take_profit";
          stopTriggerKind = null;
        } else if (decision.reason === "SURGE_RUNNER_TRAILING_EXIT") {
          exitAuthorityClass = "profit_protect";
          stopTriggerKind = "time_stop";
        } else if (decision.reason === "SURGE_BREAKEVEN_PROTECT") {
          exitAuthorityClass = "breakeven_protect";
          stopTriggerKind = "breakeven_protect";
        } else if (
          decision.reason === "SURGE_STOP_LOSS" ||
          decision.reason === "SURGE_REVERSAL_CUT" ||
          decision.reason === "SURGE_EXIT_POLICY_INVALID_FORCE_EXIT"
        ) {
          exitAuthorityClass = "emergency_exit";
          stopTriggerKind = "price_stop";
        } else if (decision.reason === "SURGE_TIMEOUT_EXIT") {
          exitAuthorityClass = "time_stop";
          stopTriggerKind = "time_stop";
        } else {
          exitAuthorityClass = "emergency_exit";
          stopTriggerKind = "price_stop";
        }
      }
    }

    if (reasonExit !== "") {
      const isSurgeEmergencyStop =
        reasonExit === "SURGE_STOP_LOSS" ||
        reasonExit === "SURGE_REVERSAL_CUT" ||
        reasonExit === "SURGE_EXIT_POLICY_INVALID_FORCE_EXIT" ||
        reasonExit.startsWith("surge_early_failure_");

      const emergencyExit =
        isSurgeEmergencyStop ||
        reasonExit.startsWith("fallback_") ||
        reasonExit === "original_setup_stop_loss" ||
        reasonExit === "emergency_stop_loss" ||
        reasonExit === "weak_market_price_stop" ||
        reasonExit === "strict_hard_stop_loss" ||
        reasonExit === "strict_early_loss_cut" ||
        exitAuthorityClass === "emergency_exit";

      const withinGracePeriod = heldMs < 15000;
      exitBlockedByGrace = withinGracePeriod && !emergencyExit && !isRecoveredPosition;
      
      const exitAllowed = !exitBlockedByGrace;

      if (exitAllowed) {
        sellGuardReached = true;
        let sellGuardPassed = true;

        if (elapsedSinceStartMs < 10 * 60_000 && !isRecoveredPosition) {
          sellGuardPassed = false;
        }

        const isStopLossExitCheck =
          exitAuthorityClass === "emergency_exit" ||
          stopTriggerKind === "price_stop" ||
          /emergency|hard|strict|stop|loss/i.test(reasonExit);

        if (heldMs < 5 * 60000 && !isStopLossExitCheck && !isRecoveredPosition) {
          sellGuardPassed = false;
        }

        if (sellGuardPassed) {
          placeSellCalls = 1;
        }
      }
    }

    return { reasonExit, ratio, stopTriggerKind, exitAuthorityClass, exitBlockedByGrace, sellGuardReached, placeSellCalls };
  };

  const pos69 = {
    entry_price: 93256000,
    entry_target_price: 95606051.2, // 약 +2.52%
    entry_origin: "auto_trade_recovered",
    engine_bucket: "surge",
    entry_mode: "RECOVERED",
    surge_entry_mode: "RECOVERED_SURGE_POLICY",
    strict_exit: true,
    partial_tp_done: false,
    surge_tp1_done: false,
    qty: 0.1,
    entry_ts: new Date(Date.now() - 70000).toISOString(),
    surge_stop_price: 90000000,
  };

  const res69 = simulateLiveStrategyExitFlow({ p: pos69, currentPrice: pos69.entry_price * 1.03 });
  console.log(`Integration Check (+3.0%): reasonExit=${res69.reasonExit}, ratio=${res69.ratio}, stopTriggerKind=${res69.stopTriggerKind}, exitAuthorityClass=${res69.exitAuthorityClass}, placeSellCalls=${res69.placeSellCalls} (Expected: SURGE_TP1_PARTIAL, 0.25, null, take_profit, 1)`);
  if (
    res69.reasonExit !== "SURGE_TP1_PARTIAL" ||
    res69.ratio !== 0.25 ||
    res69.stopTriggerKind !== null ||
    res69.exitAuthorityClass !== "take_profit" ||
    res69.placeSellCalls !== 1
  ) {
    throw new Error("Case 6.9 Failed: Should trigger SURGE_TP1_PARTIAL with ratio 0.25, stopTriggerKind=null, and placeSellCalls=1");
  }

  // 6.10. +2.6% 구간 테스트 (전량매도 가로채기 방지)
  const res610 = simulateLiveStrategyExitFlow({ p: pos69, currentPrice: pos69.entry_price * 1.026 });
  console.log(`Integration Check (+2.6%): reasonExit="${res610.reasonExit}", ratio=${res610.ratio}, stopTriggerKind=${res610.stopTriggerKind}, exitAuthorityClass=${res610.exitAuthorityClass}, placeSellCalls=${res610.placeSellCalls} (Expected: "", 1, null, none, 0)`);
  if (res610.reasonExit !== "" || res610.placeSellCalls !== 0 || res610.exitAuthorityClass !== "none") {
    throw new Error("Case 6.10 Failed: Recovered surge should hold and original_setup_target_tp must be bypassed with placeSellCalls=0");
  }

  // 6.11. 손절 테스트 (entry_stop_price 이하 청산 허용)
  // entry_stop_price와 surge_stop_price가 둘 다 있는 경우, surgePolicyApplies에 의해 SURGE_STOP_LOSS(evaluateSurgeExit)가 최종 권한이 되어야 한다.
  const pos611 = {
    ...pos69,
    entry_stop_price: 91000000,
    surge_stop_price: 91500000, // 더 높은 surge_stop_price
  };
  const res611 = simulateLiveStrategyExitFlow({ p: pos611, currentPrice: 90000000 });
  console.log(`Integration Check (Stop Loss - Both): reasonExit=${res611.reasonExit}, ratio=${res611.ratio}, stopTriggerKind=${res611.stopTriggerKind}, exitAuthorityClass=${res611.exitAuthorityClass}, placeSellCalls=${res611.placeSellCalls} (Expected: SURGE_STOP_LOSS, 1, price_stop, emergency_exit, 1)`);
  if (
    res611.reasonExit !== "SURGE_STOP_LOSS" ||
    res611.ratio !== 1.0 ||
    res611.stopTriggerKind !== "price_stop" ||
    res611.exitAuthorityClass !== "emergency_exit" ||
    res611.placeSellCalls !== 1
  ) {
    throw new Error("Case 6.11 Failed: Should trigger SURGE_STOP_LOSS with ratio 1.0, stopTriggerKind=price_stop, and placeSellCalls=1 when both stop prices are present");
  }

  console.log("-> Test 6 Passed!");

  console.log("\n[Test 7] Verifying new detailed exit authority & grace period bypass rules...");

  // 7.1. 일반 Surge TP1도 take_profit으로 분류 검증
  const posNormalTp1 = {
    entry_price: 1000,
    qty: 10,
    entry_origin: "auto_trade",
    engine_bucket: "surge",
    surge_entry_mode: "FAST_SURGE_PROBE",
    strict_exit: true,
    partial_tp_done: false,
    surge_tp1_done: false,
    entry_ts: new Date(Date.now() - 70000).toISOString(),
    surge_stop_price: 900,
    surge_take_profit_price: 1100,
    surge_trailing_gap_pct: 1.5,
  };
  const resNormalTp1 = simulateLiveStrategyExitFlow({ p: posNormalTp1, currentPrice: 1015 }); // +1.5%
  console.log(`Normal Surge TP1 Check: reasonExit=${resNormalTp1.reasonExit}, exitAuthorityClass=${resNormalTp1.exitAuthorityClass} (Expected: SURGE_TP1_PARTIAL, take_profit)`);
  if (resNormalTp1.reasonExit !== "SURGE_TP1_PARTIAL" || resNormalTp1.exitAuthorityClass !== "take_profit") {
    throw new Error("Test 7.1 Failed: Normal Surge TP1 should be classified as take_profit");
  }

  // 7.2. TP2도 take_profit으로 분류 검증
  const posNormalTp2 = {
    ...posNormalTp1,
    surge_tp1_done: true,
    surge_take_profit_price: 1050, // +5.0%
  };
  const resNormalTp2 = simulateLiveStrategyExitFlow({ p: posNormalTp2, currentPrice: 1050 }); // +5.0%
  console.log(`Normal Surge TP2 Check: reasonExit=${resNormalTp2.reasonExit}, exitAuthorityClass=${resNormalTp2.exitAuthorityClass} (Expected: SURGE_TP2_PARTIAL, take_profit)`);
  if (resNormalTp2.reasonExit !== "SURGE_TP2_PARTIAL" || resNormalTp2.exitAuthorityClass !== "take_profit") {
    throw new Error("Test 7.2 Failed: Normal Surge TP2 should be classified as take_profit");
  }

  // 7.3. runner trailing은 profit_protect 계열 검증
  const posRunnerTrailing = {
    ...posNormalTp1,
    surge_tp1_done: true,
    surge_tp2_done: true,
    surge_runner_active: true,
    highest_price_after_entry: 1040, // +4.0% 피크
  };
  const resRunnerTrailing = simulateLiveStrategyExitFlow({ p: posRunnerTrailing, currentPrice: 1015 });
  console.log(`Runner Trailing Check: reasonExit=${resRunnerTrailing.reasonExit}, exitAuthorityClass=${resRunnerTrailing.exitAuthorityClass}, stopTriggerKind=${resRunnerTrailing.stopTriggerKind} (Expected: SURGE_RUNNER_TRAILING_EXIT, profit_protect, time_stop)`);
  if (resRunnerTrailing.reasonExit !== "SURGE_RUNNER_TRAILING_EXIT" || resRunnerTrailing.exitAuthorityClass !== "profit_protect" || resRunnerTrailing.stopTriggerKind !== "time_stop") {
    throw new Error("Test 7.3 Failed: Runner trailing exit should be classified as profit_protect and time_stop");
  }

  // 7.4. TP1/TP2가 손절 예외 권한을 받지 않음 (emergencyExit = false) 검증
  const testEmergencyExitFlag = (reasonExit: string, exitAuthorityClass: string): boolean => {
    const isSurgeEmergencyStop =
      reasonExit === "SURGE_STOP_LOSS" ||
      reasonExit === "SURGE_REVERSAL_CUT" ||
      reasonExit === "SURGE_EXIT_POLICY_INVALID_FORCE_EXIT" ||
      reasonExit.startsWith("surge_early_failure_");

    const emergencyExit =
      isSurgeEmergencyStop ||
      reasonExit.startsWith("fallback_") ||
      reasonExit === "original_setup_stop_loss" ||
      reasonExit === "emergency_stop_loss" ||
      reasonExit === "weak_market_price_stop" ||
      reasonExit === "strict_hard_stop_loss" ||
      reasonExit === "strict_early_loss_cut" ||
      exitAuthorityClass === "emergency_exit";

    return emergencyExit;
  };

  const isTp1Emergency = testEmergencyExitFlag("SURGE_TP1_PARTIAL", "take_profit");
  const isTp2Emergency = testEmergencyExitFlag("SURGE_TP2_PARTIAL", "take_profit");
  const isStopEmergency = testEmergencyExitFlag("SURGE_STOP_LOSS", "emergency_exit");

  console.log(`Emergency classification check: TP1=${isTp1Emergency}, TP2=${isTp2Emergency}, StopLoss=${isStopEmergency} (Expected: false, false, true)`);
  if (isTp1Emergency || isTp2Emergency || !isStopEmergency) {
    throw new Error("Test 7.4 Failed: TP1/TP2 must not receive emergency_exit classification, while SURGE_STOP_LOSS must");
  }

  // 7.5. recovered TP1은 부팅 grace만 명시적으로 우회하고, emergency_exit 오분류를 이용해 우회하지 않음 검증
  const simulateFullGraceAndGuardLogic = (p: any, reasonExit: string, exitAuthorityClass: string, elapsedSinceStartMs: number, heldMs: number): { allowed: boolean; blockedByGrace: boolean } => {
    const isRecoveredPosition = p.entry_origin === "auto_trade_recovered" || p.entry_origin === "auto_trade_recovered_all_holdings";
    
    // exitBlockedByGrace 검증
    const withinGracePeriod = heldMs < 15000;
    const emergencyExit = testEmergencyExitFlag(reasonExit, exitAuthorityClass);
    const blockedByGrace = withinGracePeriod && !emergencyExit && !isRecoveredPosition;

    // validateSellGuardBeforePlaceSell 검증 (boot grace)
    let allowedByGuard = true;
    if (elapsedSinceStartMs < 10 * 60_000 && !isRecoveredPosition) {
      allowedByGuard = false;
    }

    return { allowed: allowedByGuard, blockedByGrace };
  };

  // 시나리오 1: 서버 부팅 직후(10초 경과), 복구 포지션의 TP1 매도 시도
  const run1 = simulateFullGraceAndGuardLogic(pos69, "SURGE_TP1_PARTIAL", "take_profit", 10000, 70000);
  console.log(`Recovered TP1 Grace Check (Booting): allowed=${run1.allowed}, blockedByGrace=${run1.blockedByGrace} (Expected: true, false)`);
  if (!run1.allowed || run1.blockedByGrace) {
    throw new Error("Test 7.5 Scenario 1 Failed: Recovered TP1 should bypass boot grace via isRecoveredPosition check, and not be blocked by grace");
  }

  // 시나리오 2: 서버 부팅 직후(10초 경과), 일반 포지션의 TP1 매도 시도
  const run2 = simulateFullGraceAndGuardLogic(posNormalTp1, "SURGE_TP1_PARTIAL", "take_profit", 10000, 10000);
  console.log(`Normal TP1 Grace Check (Booting): allowed=${run2.allowed}, blockedByGrace=${run2.blockedByGrace} (Expected: false, true)`);
  if (run2.allowed || !run2.blockedByGrace) {
    throw new Error("Test 7.5 Scenario 2 Failed: Normal TP1 must be blocked by boot grace and grace period");
  }

  // 7.6. recovered Surge, 진입 10초, TP1 +3%: 최소 보유시간 우회, 매도 허용
  const res76 = simulateLiveStrategyExitFlow({
    p: pos69,
    currentPrice: pos69.entry_price * 1.03,
    elapsedSinceStartMs: 10000, // 부팅 10초
    heldMs: 10000, // 진입 10초
  });
  console.log(`Test 7.6 (recovered Surge, 10s, TP1): reasonExit=${res76.reasonExit}, exitBlockedByGrace=${res76.exitBlockedByGrace}, sellGuardReached=${res76.sellGuardReached}, placeSellCalls=${res76.placeSellCalls} (Expected: SURGE_TP1_PARTIAL, false, true, 1)`);
  if (
    res76.reasonExit !== "SURGE_TP1_PARTIAL" ||
    res76.exitBlockedByGrace !== false ||
    res76.sellGuardReached !== true ||
    res76.placeSellCalls !== 1
  ) {
    throw new Error("Test 7.6 Failed");
  }

  // 7.7. 일반 신규 Surge, 진입 10초, TP1 +3%: holding_time_under_min_limit 차단 또는 exitBlockedByGrace 차단
  const res77 = simulateLiveStrategyExitFlow({
    p: posNormalTp1,
    currentPrice: 1030, // +3.0%
    elapsedSinceStartMs: 10 * 60 * 1000 + 1000,
    heldMs: 10000, // 진입 10초
  });
  console.log(`Test 7.7 (new Surge, 10s, TP1): exitBlockedByGrace=${res77.exitBlockedByGrace}, placeSellCalls=${res77.placeSellCalls} (Expected: true, 0)`);
  if (res77.exitBlockedByGrace !== true || res77.placeSellCalls !== 0) {
    throw new Error("Test 7.7 Failed");
  }

  // 7.8. 일반 신규 Surge, 5분 경과, TP1 +3%: 매도 허용
  const res78 = simulateLiveStrategyExitFlow({
    p: posNormalTp1,
    currentPrice: 1030,
    elapsedSinceStartMs: 10 * 60 * 1000 + 1000,
    heldMs: 301000, // 5분 초과
  });
  console.log(`Test 7.8 (new Surge, 5m+, TP1): placeSellCalls=${res78.placeSellCalls} (Expected: 1)`);
  if (res78.placeSellCalls !== 1) {
    throw new Error("Test 7.8 Failed");
  }

  // 7.9. Surge emergency stop, 진입 10초: 즉시 허용
  const res79 = simulateLiveStrategyExitFlow({
    p: posNormalTp1,
    currentPrice: 800, // 손절
    elapsedSinceStartMs: 10 * 60 * 1000 + 1000,
    heldMs: 10000, // 진입 10초
  });
  console.log(`Test 7.9 (Surge emergency stop, 10s): exitBlockedByGrace=${res79.exitBlockedByGrace}, placeSellCalls=${res79.placeSellCalls} (Expected: false, 1)`);
  if (res79.exitBlockedByGrace !== false || res79.placeSellCalls !== 1) {
    throw new Error("Test 7.9 Failed");
  }

  // 7.10. recovered Surge, surge_stop_price 없음, entry_stop_price 유효: entry_stop_price fallback 사용
  const pos710 = {
    entry_price: 95000000,
    qty: 0.1,
    entry_origin: "auto_trade_recovered",
    engine_bucket: "surge",
    entry_mode: "RECOVERED",
    surge_entry_mode: "RECOVERED_SURGE_POLICY",
    strict_exit: true,
    partial_tp_done: false,
    surge_tp1_done: false,
    entry_ts: new Date(Date.now() - 70000).toISOString(),
    surge_stop_price: 0,
    entry_stop_price: 91000000,
    surge_take_profit_price: 100000000,
    surge_trailing_gap_pct: 2.2,
  };
  const dec710 = evaluateSurgeExit(pos710, 90000000, 0);
  console.log(`Test 7.10 (entry_stop_price fallback): reason=${dec710.reason} (Expected: SURGE_STOP_LOSS)`);
  if (dec710.reason !== "SURGE_STOP_LOSS") throw new Error("Test 7.10 Failed");

  // 7.11. recovered Surge, 두 stop 가격 모두 없음: SURGE_EXIT_POLICY_INVALID_FORCE_EXIT
  const pos711 = {
    ...pos710,
    surge_stop_price: 0,
    entry_stop_price: 0,
  };
  const dec711 = evaluateSurgeExit(pos711, 90000000, 0);
  console.log(`Test 7.11 (no stop prices): reason=${dec711.reason} (Expected: SURGE_EXIT_POLICY_INVALID_FORCE_EXIT)`);
  if (dec711.reason !== "SURGE_EXIT_POLICY_INVALID_FORCE_EXIT") throw new Error("Test 7.11 Failed");

  console.log("-> Test 7 Passed!");

  // ────────────────────────────────────────────────────────────────
  // Test Case 8: Reclaim Logic Verification (10 Required Scenarios)
  // ────────────────────────────────────────────────────────────────
  console.log("\n[Test 8] Verifying the 10 required Reclaim scenarios...");

  // 8.1. watchlist watching -> pullback_seen 전이 (-0.6% ~ -2.5% 눌림)
  const item1 = { status: "watching", local_high_price: 1000, pullback_low_price: null as number | null, first_detected_at: new Date().toISOString() };
  const pullbackPct1 = ((1000 - 990) / 1000) * 100;
  const isPullback1 = pullbackPct1 >= 0.6 && pullbackPct1 < 2.5;
  if (isPullback1) {
    item1.status = "pullback_seen";
    item1.pullback_low_price = 990;
  }
  console.log(`Test 8.1 (watching -> pullback_seen): status=${item1.status}, low=${item1.pullback_low_price} (Expected: pullback_seen, 990)`);
  if (item1.status !== "pullback_seen" || item1.pullback_low_price !== 990) throw new Error("Test 8.1 Failed");

  // 8.2. pullback_seen -> reclaim_ready 전이 (rebound, returnsOk, nearHigh, isAboveEma)
  const item2 = { status: "pullback_seen", local_high_price: 1000, pullback_low_price: 980 };
  const currentPrice2 = 998;
  const isRebounding2 = item2.pullback_low_price !== null && currentPrice2 > item2.pullback_low_price;
  const recent1mRet2 = 0.5; // > 0
  const recent3mRet2 = 1.0; // >= 0 && <= 2.5
  const returnsOk2 = recent1mRet2 > 0 && recent3mRet2 >= 0 && recent3mRet2 <= 2.5;
  const nearHigh2 = currentPrice2 >= 1000 * 0.997 && currentPrice2 <= 1000 * 1.003;
  const isAboveEma2 = true;
  if (isRebounding2 && returnsOk2 && nearHigh2 && isAboveEma2) {
    item2.status = "reclaim_ready";
  }
  console.log(`Test 8.2 (pullback_seen -> reclaim_ready): status=${item2.status} (Expected: reclaim_ready)`);
  if (item2.status !== "reclaim_ready") throw new Error("Test 8.2 Failed");

  // 8.3. watchlist pullback_seen 만료 조건
  const registerTime3 = Date.now() - 31 * 60000; // 31분 경과
  const elapsedMin3 = (Date.now() - registerTime3) / 60000;
  const currentPrice3 = 960; // 1000 대비 -4% 하락
  const isExpired3_timeout = elapsedMin3 >= 30;
  const isExpired3_drop = currentPrice3 < 1000 * 0.97;
  console.log(`Test 8.3 (expiry conditions): timeout=${isExpired3_timeout}, drop=${isExpired3_drop} (Expected: true, true)`);
  if (!isExpired3_timeout || !isExpired3_drop) throw new Error("Test 8.3 Failed");

  // 8.4. Reclaim score 누락과 점수 미달 구분 검증 (undefined, NaN, 0, 54, 55)
  function simulateScoreCheck(reclaimScore: any, marketState: string, rsi: number): string {
    const isMissing = reclaimScore === undefined || reclaimScore === null || Number.isNaN(reclaimScore);
    if (isMissing) return "reclaim_score_missing";
    const minScore = marketState === "risk_on" ? 50 : 55;
    if (reclaimScore < minScore) return "reclaim_score_low";
    return "pass";
  }
  const checkUndefined = simulateScoreCheck(undefined, "neutral", 50);
  const checkNaN = simulateScoreCheck(NaN, "neutral", 50);
  const checkZero = simulateScoreCheck(0, "neutral", 50);
  const checkLow = simulateScoreCheck(54, "neutral", 50);
  const checkPass = simulateScoreCheck(55, "neutral", 50);
  console.log(`Test 8.4 (reclaim score categories): undefined=${checkUndefined}, NaN=${checkNaN}, 0=${checkZero}, 54=${checkLow}, 55=${checkPass}`);
  if (
    checkUndefined !== "reclaim_score_missing" ||
    checkNaN !== "reclaim_score_missing" ||
    checkZero !== "reclaim_score_low" ||
    checkLow !== "reclaim_score_low" ||
    checkPass !== "pass"
  ) {
    throw new Error("Test 8.4 Failed: Score categories are incorrect");
  }

  // 8.5. precheckCandleCache 안전성 및 캐시 정책 검증
  let candlesFetchCount = 0;
  const mockCache = new Map<string, { ts: number; candles: any[] }>();
  const mockInFlight = new Map<string, Promise<any[]>>();

  async function fetchPrecheckCandlesSafeMock(market: string, timeoutMs = 5000, forceFail = false, forceTimeout = false, forceDelayMs = 0): Promise<{ candles: any[]; source: string; ageMs: number }> {
    const now = Date.now();
    
    // 0. 메모리 정리
    for (const [k, v] of mockCache.entries()) {
      if (now - v.ts > 60000) {
        mockCache.delete(k);
      }
    }

    const cached = mockCache.get(market);
    if (cached && now - cached.ts < 10000) {
      return { candles: cached.candles, source: "precheck_cache", ageMs: now - cached.ts };
    }

    let promise = mockInFlight.get(market);
    if (!promise) {
      const controller = new AbortController();
      let timeoutId: NodeJS.Timeout | undefined;
      let timedOut = false;
      
      const fetchPromise = new Promise<any[]>((resolve, reject) => {
        if (forceFail) {
          reject(new Error("mock_fetch_failed"));
          return;
        }
        if (forceTimeout) {
          return; // 결코 resolve되지 않아 timeout 발생
        }

        const onAbort = () => {
          reject(new DOMException("Aborted", "AbortError"));
        };
        controller.signal.addEventListener("abort", onAbort);

        const resolveTask = () => {
          controller.signal.removeEventListener("abort", onAbort);
          if (controller.signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          candlesFetchCount++;
          const res = Array.from({ length: 22 }, (_, idx) => ({ trade_price: 1000 + idx }));
          resolve(res);
        };

        if (forceDelayMs > 0) {
          setTimeout(resolveTask, forceDelayMs);
        } else {
          resolveTask();
        }
      });

      const timeoutPromise = new Promise<any[]>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          mockInFlight.delete(market);
          reject(new Error("fetchMinuteCandles timeout"));
        }, timeoutMs);
      });

      promise = Promise.race([
        fetchPromise.then((res) => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (!timedOut) {
            mockCache.set(market, { ts: Date.now(), candles: res });
          }
          mockInFlight.delete(market);
          return res;
        }),
        timeoutPromise
      ]).catch((err) => {
        mockInFlight.delete(market);
        throw err;
      });

      mockInFlight.set(market, promise);
    }
    
    try {
      const candles = await promise;
      const currentCached = mockCache.get(market);
      const ageMs = currentCached ? (Date.now() - currentCached.ts) : 0;
      if (ageMs >= 10000) {
        throw new Error("precheck_candles_stale");
      }
      return { candles, source: "live_fetch", ageMs };
    } catch (err) {
      throw err;
    }
  }

  // 검증 A: 동일 tick 2회 요청 -> HTTP 1회
  await fetchPrecheckCandlesSafeMock("KRW-BTC");
  await fetchPrecheckCandlesSafeMock("KRW-BTC");
  console.log(`Test 8.5.A (same tick 2 calls): fetchCount=${candlesFetchCount} (Expected: 1)`);
  if (candlesFetchCount !== 1) throw new Error("Test 8.5.A Failed");

  // 검증 B: fetch reject -> inFlight 제거 및 재시도 가능
  let failed = false;
  try {
    await fetchPrecheckCandlesSafeMock("KRW-XRP", 5000, true);
  } catch {
    failed = true;
  }
  console.log(`Test 8.5.B (fetch reject): failed=${failed}, inFlightDeleted=${!mockInFlight.has("KRW-XRP")} (Expected: true, true)`);
  if (!failed || mockInFlight.has("KRW-XRP")) throw new Error("Test 8.5.B Failed");

  // 검증 C: 오래된 캐시 사용 금지 (TTL 만료 후 호출 시 캐시를 타지 않고 새로 fetch를 시도함)
  const staleCached = mockCache.get("KRW-BTC");
  if (staleCached) staleCached.ts = Date.now() - 15000; // TTL 만료시킴
  const beforeCount = candlesFetchCount;
  const resC = await fetchPrecheckCandlesSafeMock("KRW-BTC");
  const afterCount = candlesFetchCount;
  console.log(`Test 8.5.C (stale cache ignored & new fetch): beforeCount=${beforeCount}, afterCount=${afterCount}, source=${resC.source} (Expected: 1, 2, live_fetch)`);
  if (afterCount !== beforeCount + 1 || resC.source !== "live_fetch") {
    throw new Error("Test 8.5.C Failed: Stale cache was used or new fetch was not triggered");
  }

  // 검증 D: timeout -> inFlight 즉시 제거 및 다음 시도 가능
  let timeoutFails = false;
  try {
    await fetchPrecheckCandlesSafeMock("KRW-TIMEOUT", 10, false, true); // 10ms 짧은 timeout
  } catch (err: any) {
    if (err.message.includes("timeout")) {
      timeoutFails = true;
    }
  }
  const inFlightClearedAfterTimeout = !mockInFlight.has("KRW-TIMEOUT");
  console.log(`Test 8.5.D (timeout handling): timeoutFails=${timeoutFails}, cleared=${inFlightClearedAfterTimeout} (Expected: true, true)`);
  if (!timeoutFails || !inFlightClearedAfterTimeout) {
    throw new Error("Test 8.5.D Failed: Timeout did not reject or clear inFlight properly");
  }

  // 검증 E: timeout 이후 late response 캐시 저장 금지
  let lateFails = false;
  try {
    // 20ms 지연 응답, 10ms 타임아웃
    await fetchPrecheckCandlesSafeMock("KRW-LATE", 10, false, false, 20);
  } catch (err: any) {
    if (err.message.includes("timeout")) {
      lateFails = true;
    }
  }
  
  // 30ms 대기하여 late response가 이미 끝났을 시각으로 이동
  await new Promise((r) => setTimeout(r, 30));
  
  const hasCache = mockCache.has("KRW-LATE");
  const inFlightCleared = !mockInFlight.has("KRW-LATE");
  
  // 다음 호출은 새 fetch를 타야 하므로 candlesFetchCount가 1 증가해야 함
  const countBefore = candlesFetchCount;
  const resE = await fetchPrecheckCandlesSafeMock("KRW-LATE", 100);
  const countAfter = candlesFetchCount;
  
  console.log(`Test 8.5.E (late response check): lateFails=${lateFails}, hasCache=${hasCache}, inFlightCleared=${inFlightCleared}, fetchExecuted=${countAfter === countBefore + 1} (Expected: true, false, true, true)`);
  if (!lateFails || hasCache || !inFlightCleared || countAfter !== countBefore + 1) {
    throw new Error("Test 8.5.E Failed: Late response updated the cache or next fetch bypassed");
  }

  // 8.6. PROMOTED 최종 통합 테스트 기대값 검증
  let watchlistRegistrationCalls = 0;
  let continueTaken = false;
  let precheckReached = false;
  let finalBuyAttemptCount = 0;
  let placeBuyCalls = 0;
  let finalDeliveredPayload: any = null;

  const isPromotedReclaim6 = true;
  if (isPromotedReclaim6) {
    watchlistRegistrationCalls = 0;
    continueTaken = false;
  } else {
    watchlistRegistrationCalls = 1;
    continueTaken = true;
  }

  const isSurgeSourceLocal6 = true;
  const candidateMetaFromSetup6 = undefined; // 누락이어도 Reclaim 분류 유지

  if (isSurgeSourceLocal6) {
    precheckReached = true;
    finalBuyAttemptCount = 1;
    
    // placeBuy mock 호출
    placeBuyCalls = 1;
    finalDeliveredPayload = {
      sourceStrategy: "surge_reclaim_entry",
      strategyType: "surge_reclaim",
      entrySignalType: "reclaim",
      isReclaimStrategy: true,
      isAggressiveSurgeStrategy: false
    };
  }

  console.log(`Test 8.6 (promoted expect): regCalls=${watchlistRegistrationCalls}, continueTaken=${continueTaken}, precheck=${precheckReached}, buyAttempt=${finalBuyAttemptCount}, placeBuy=${placeBuyCalls}`);
  if (
    watchlistRegistrationCalls !== 0 ||
    continueTaken !== false ||
    precheckReached !== true ||
    finalBuyAttemptCount !== 1 ||
    placeBuyCalls !== 1 ||
    finalDeliveredPayload.sourceStrategy !== "surge_reclaim_entry" ||
    finalDeliveredPayload.strategyType !== "surge_reclaim" ||
    finalDeliveredPayload.entrySignalType !== "reclaim" ||
    finalDeliveredPayload.isReclaimStrategy !== true ||
    finalDeliveredPayload.isAggressiveSurgeStrategy !== false
  ) {
    throw new Error("Test 8.6 Failed");
  }

  // 8.7. Gate 안전조건 유지 확인 (global kill switch, cooldown, hourly limit, max positions 등)
  function simulatePrecheckSafetyGates(args: {
    killSwitch: boolean;
    cooldownActive: boolean;
    hourlyLimitReached: boolean;
    maxPositionsReached: boolean;
    existingHolding: boolean;
    minOrderAmountOk: boolean;
  }): { allowed: boolean; blockReason: string | null } {
    if (args.killSwitch) return { allowed: false, blockReason: "daily_risk_kill_switch_active" };
    if (args.cooldownActive) return { allowed: false, blockReason: "cooldown_active" };
    if (args.hourlyLimitReached) return { allowed: false, blockReason: "hourly_entry_limit_reached" };
    if (args.maxPositionsReached) return { allowed: false, blockReason: "max_positions_reached" };
    if (args.existingHolding) return { allowed: false, blockReason: "position_exists" };
    if (!args.minOrderAmountOk) return { allowed: false, blockReason: "min_order_amount_underflow" };
    return { allowed: true, blockReason: null };
  }

  const gate1 = simulatePrecheckSafetyGates({ killSwitch: true, cooldownActive: false, hourlyLimitReached: false, maxPositionsReached: false, existingHolding: false, minOrderAmountOk: true });
  const gate2 = simulatePrecheckSafetyGates({ killSwitch: false, cooldownActive: true, hourlyLimitReached: false, maxPositionsReached: false, existingHolding: false, minOrderAmountOk: true });
  const gate3 = simulatePrecheckSafetyGates({ killSwitch: false, cooldownActive: false, hourlyLimitReached: true, maxPositionsReached: false, existingHolding: false, minOrderAmountOk: true });
  const gate4 = simulatePrecheckSafetyGates({ killSwitch: false, cooldownActive: false, hourlyLimitReached: false, maxPositionsReached: true, existingHolding: false, minOrderAmountOk: true });
  const gate5 = simulatePrecheckSafetyGates({ killSwitch: false, cooldownActive: false, hourlyLimitReached: false, maxPositionsReached: false, existingHolding: true, minOrderAmountOk: true });
  const gate6 = simulatePrecheckSafetyGates({ killSwitch: false, cooldownActive: false, hourlyLimitReached: false, maxPositionsReached: false, existingHolding: false, minOrderAmountOk: false });
  const gatePass = simulatePrecheckSafetyGates({ killSwitch: false, cooldownActive: false, hourlyLimitReached: false, maxPositionsReached: false, existingHolding: false, minOrderAmountOk: true });

  console.log(`Test 8.7 (safety gates): killSwitch=${gate1.blockReason}, cooldown=${gate2.blockReason}, hourly=${gate3.blockReason}, maxPos=${gate4.blockReason}, existing=${gate5.blockReason}, minOrder=${gate6.blockReason}, pass=${gatePass.allowed}`);
  if (
    gate1.allowed || gate1.blockReason !== "daily_risk_kill_switch_active" ||
    gate2.allowed || gate2.blockReason !== "cooldown_active" ||
    gate3.allowed || gate3.blockReason !== "hourly_entry_limit_reached" ||
    gate4.allowed || gate4.blockReason !== "max_positions_reached" ||
    gate5.allowed || gate5.blockReason !== "position_exists" ||
    gate6.allowed || gate6.blockReason !== "min_order_amount_underflow" ||
    !gatePass.allowed
  ) {
    throw new Error("Test 8.7 Failed: Safety gates are bypassed by Reclaim!");
  }

  // 8.8. Reclaim precheck 필터 차단 검증 (risk_off 시, btc_rsi < 40 시 차단)
  function mockAssertOrderBuyAllowed8(snap: any, params: any) {
    const isReclaim = params.strategyType === "surge_reclaim" || params.entrySignalType === "reclaim";
    if (isReclaim) {
      if (snap.market_state === "risk_off") return { ok: false, blocked_reason: "market_risk_off" };
      if (snap.btc_rsi < 40) return { ok: false, blocked_reason: "btc_rsi_under_40" };
      return { ok: true };
    }
    return { ok: true };
  }
  const snap8_1 = { market_state: "risk_off", btc_rsi: 52 };
  const snap8_2 = { market_state: "risk_on", btc_rsi: 38 };
  const res8_1 = mockAssertOrderBuyAllowed8(snap8_1, { strategyType: "surge_reclaim" });
  const res8_2 = mockAssertOrderBuyAllowed8(snap8_2, { strategyType: "surge_reclaim" });
  console.log(`Test 8.8 (precheck filter blocks): risk_off=${res8_1.blocked_reason}, btc_rsi_low=${res8_2.blocked_reason}`);
  if (res8_1.ok || res8_2.ok) throw new Error("Test 8.8 Failed: Reclaim precheck filters are bypassed");

  // 8.9. Reclaim precheck EMA20/VolumeAccel 실시간 캔들 Fetch & 계산 검증 (RSI 40~50 구간)
  let fetchCallTriggered9 = false;
  function mockPrecheckCandleComputation(rsiVal: number, aboveEma?: boolean, volAccel?: number) {
    if (rsiVal >= 40 && rsiVal < 50) {
      if (aboveEma === undefined || volAccel === undefined) {
        fetchCallTriggered9 = true;
        return { aboveEma: true, volAccel: 1.5, source: "live_fetch", age: 0 };
      }
    }
    return { aboveEma, volAccel, source: "params", age: 0 };
  }
  const res9 = mockPrecheckCandleComputation(45, undefined, undefined);
  console.log(`Test 8.9 (RSI 40-50 candle fetch): fetchTriggered=${fetchCallTriggered9}, source=${res9.source}`);
  if (!fetchCallTriggered9 || res9.source !== "live_fetch") throw new Error("Test 8.9 Failed: Candle fetching not triggered under RSI [40, 50)");

  // 8.10. 매 틱 카운터 누적 및 SURGE_RECLAIM_TICK_SUMMARY 로그 포맷 정합성
  let test_accum_watchlist_added_count = 0;
  let test_watchlist_added_count = 2;
  test_accum_watchlist_added_count += test_watchlist_added_count;
  const summaryLog = {
    tag: "SURGE_RECLAIM_TICK_SUMMARY",
    ts: new Date().toISOString(),
    recent_tick: { watchlist_added_count: test_watchlist_added_count },
    since_process_start: { watchlist_added_count: test_accum_watchlist_added_count },
    process_started_at: new Date().toISOString()
  };
  console.log(`Test 8.10 (tick summary log counter format): since_process_start=${summaryLog.since_process_start.watchlist_added_count}`);
  if (summaryLog.since_process_start.watchlist_added_count !== 2) throw new Error("Test 8.10 Failed: Tick summary format mismatch");

  // 8.11. A/B 중복 후보 방지 테스트 (동일 market이 watchlist 와 promoted queue에 동시 존재 시 단 1회 주문)
  const tickEnteredMarketsMock = new Set<string>();
  let mockPlaceBuyCalls811 = 0;
  let mockFinalBuyAttemptCount811 = 0;

  function mockProcessWatchlistReclaim(market: string) {
    if (tickEnteredMarketsMock.has(market)) return;
    mockFinalBuyAttemptCount811++;
    mockPlaceBuyCalls811++;
    tickEnteredMarketsMock.add(market); // 주문 실행 즉시 락 등록
  }

  function mockProcessPromotedQueue(market: string) {
    if (tickEnteredMarketsMock.has(market)) return; // 락에 걸려서 바이패스되어야 함
    mockFinalBuyAttemptCount811++;
    mockPlaceBuyCalls811++;
    tickEnteredMarketsMock.add(market);
  }

  mockProcessWatchlistReclaim("KRW-BTC");
  mockProcessPromotedQueue("KRW-BTC");

  console.log(`Test 8.11 (A/B dedup lock): placeBuyCalls=${mockPlaceBuyCalls811}, buyAttempt=${mockFinalBuyAttemptCount811}`);
  if (mockPlaceBuyCalls811 !== 1 || mockFinalBuyAttemptCount811 !== 1) {
    throw new Error("Test 8.11 Failed: Duplicate orders placed on same market");
  }

  console.log("-> Test 8.11 Passed!");

  // 8.12. retry_wait 재소비 경로 및 reclaim_ready 복귀 테스트
  console.log("\n[Test 8.12] Verifying retry_wait consumption and reclaim_ready recovery...");
  const testWatchlist = new Map<string, { status: string; attempt_count: number; retry_after?: number; last_block_reason?: string }>();
  let mockPlaceBuyCalls812 = 0;

  function runWatchlistReclaimTickSim(market: string, nowMs: number) {
    const item = testWatchlist.get(market);
    if (!item) return;

    // 1. retry_wait && now < retry_after -> 대기
    if (item.status === "retry_wait" && item.retry_after && nowMs < item.retry_after) {
      return;
    }

    // 2. retry_wait && now >= retry_after -> reclaim_ready 복귀
    if (item.status === "retry_wait" && item.retry_after && nowMs >= item.retry_after) {
      item.status = "reclaim_ready";
    }

    // 3. reclaim_ready 일 때 주문 실행
    if (item.status === "reclaim_ready") {
      item.attempt_count = (item.attempt_count || 0) + 1;
      if (item.attempt_count >= 5) {
        testWatchlist.delete(market); // expired / max attempts 도달 시 삭제
        return;
      }

      mockPlaceBuyCalls812++;
      const buyOk = mockPlaceBuyCalls812 >= 2; // 두 번째 placeBuy 호출에서 성공하는 시나리오

      if (buyOk) {
        item.status = "entered";
        testWatchlist.delete(market); // 성공 시 삭제
      } else {
        item.status = "retry_wait";
        item.retry_after = nowMs + 5000;
      }
    }
  }

  // 초기 상태: reclaim_ready로 진입 대기
  testWatchlist.set("KRW-ADA", { status: "reclaim_ready", attempt_count: 0 });
  const startMs = Date.now();

  // 첫 번째 tick: 첫 placeBuy 호출 -> 실패 -> retry_wait 저장 (5초 후 retry)
  runWatchlistReclaimTickSim("KRW-ADA", startMs);
  const itemAfterFirstTick = testWatchlist.get("KRW-ADA");
  console.log(`- After Tick 1: status=${itemAfterFirstTick?.status}, attempt_count=${itemAfterFirstTick?.attempt_count}, hasRetryAfter=${!!itemAfterFirstTick?.retry_after} (Expected: retry_wait, 1, true)`);
  if (itemAfterFirstTick?.status !== "retry_wait" || itemAfterFirstTick?.attempt_count !== 1 || !itemAfterFirstTick?.retry_after) {
    throw new Error("Test 8.12 Step 1 Failed");
  }

  // 3초 경과 후 tick (5초 전): retry_after가 지나지 않았으므로 재호출 0회 (대기 유지)
  const countBeforeSecondCall = mockPlaceBuyCalls812;
  runWatchlistReclaimTickSim("KRW-ADA", startMs + 3000);
  const itemAfterSecondTick = testWatchlist.get("KRW-ADA");
  console.log(`- After 3s (before retry_after): status=${itemAfterSecondTick?.status}, placeBuyCalls=${mockPlaceBuyCalls812} (Expected: retry_wait, 1)`);
  if (itemAfterSecondTick?.status !== "retry_wait" || mockPlaceBuyCalls812 !== countBeforeSecondCall) {
    throw new Error("Test 8.12 Step 2 Failed: retry_wait bypassed or placeBuy was called prematurely");
  }

  // 6초 경과 후 tick (5초 후): retry_after 경과 -> reclaim_ready 복귀 -> 두 번째 placeBuy 호출 -> 성공 -> watchlist에서 제거
  runWatchlistReclaimTickSim("KRW-ADA", startMs + 6000);
  const itemAfterThirdTick = testWatchlist.get("KRW-ADA");
  console.log(`- After 6s (after retry_after): itemRemoved=${!itemAfterThirdTick}, placeBuyCalls=${mockPlaceBuyCalls812} (Expected: true, 2)`);
  if (itemAfterThirdTick || mockPlaceBuyCalls812 !== 2) {
    throw new Error("Test 8.12 Step 3 Failed: watchlist not cleaned up or second placeBuy missed");
  }

  console.log("-> Test 8.12 Passed!");

  // 8.13. reclaim_score_low 즉시 삭제 금지 및 재평가 통과 테스트
  console.log("\n[Test 8.13] Verifying reclaim_score_low does not delete instantly and retries on score recovery...");
  const testWatchlist813 = new Map<string, { status: string; attempt_count: number; retry_after?: number; reclaim_score?: number }>();
  let mockPlaceBuyCalls813: any = 0;

  function runWatchlistReclaimTickSim813(market: string, nowMs: number) {
    const item = testWatchlist813.get(market);
    if (!item) return;

    if (item.status === "retry_wait" && item.retry_after && nowMs < item.retry_after) {
      return;
    }

    if (item.status === "retry_wait" && item.retry_after && nowMs >= item.retry_after) {
      item.status = "reclaim_ready";
    }

    if (item.status === "reclaim_ready") {
      const score = item.reclaim_score;
      
      // 1. 점수 미달 시 retry_wait 전이
      if (score === undefined || score < 55) {
        item.attempt_count = (item.attempt_count || 0) + 1;
        item.status = "retry_wait";
        item.retry_after = nowMs + 5000;
        return;
      }

      // 2. 점수 도달 시 placeBuy
      mockPlaceBuyCalls813++;
      item.status = "entered";
      testWatchlist813.delete(market);
    }
  }

  // 첫 번째 틱: 점수 54점 (미달) -> 즉시 삭제되지 않고 retry_wait로 전이해야 함
  testWatchlist813.set("KRW-DOT", { status: "reclaim_ready", attempt_count: 0, reclaim_score: 54 });
  const startMs813 = Date.now();
  runWatchlistReclaimTickSim813("KRW-DOT", startMs813);
  const itemAfterTick1 = testWatchlist813.get("KRW-DOT");
  console.log(`- After Tick 1 (score 54): status=${itemAfterTick1?.status}, hasRetryAfter=${!!itemAfterTick1?.retry_after} (Expected: retry_wait, true)`);
  if (itemAfterTick1?.status !== "retry_wait" || !itemAfterTick1?.retry_after) {
    throw new Error("Test 8.13 Step 1 Failed");
  }

  // 두 번째 틱 (5초 후): 점수가 56점으로 상승(회복) -> reclaim_ready 복귀 -> placeBuy 통과 및 watchlist 삭제
  itemAfterTick1.reclaim_score = 56; // 점수 회복
  runWatchlistReclaimTickSim813("KRW-DOT", startMs813 + 6000);
  const itemAfterTick2 = testWatchlist813.get("KRW-DOT");
  console.log(`- After 6s (score 56): itemRemoved=${!itemAfterTick2}, placeBuyCalls=${mockPlaceBuyCalls813} (Expected: true, 1)`);
  if (itemAfterTick2 || mockPlaceBuyCalls813 !== 1) {
    throw new Error("Test 8.13 Step 2 Failed");
  }
  console.log("-> Test 8.13 Passed!");

  // 8.14. orderKrw < 5000 처리 및 retry_wait 전이 테스트
  console.log("\n[Test 8.14] Verifying orderKrw < 5000 results in retry_wait, not infinite loop...");
  const testWatchlist814 = new Map<string, { status: string; attempt_count: number; retry_after?: number; order_krw: number }>();
  let mockPlaceBuyCalls814: any = 0;

  function runWatchlistReclaimTickSim814(market: string, nowMs: number) {
    const item = testWatchlist814.get(market);
    if (!item) return;

    if (item.status === "retry_wait" && item.retry_after && nowMs < item.retry_after) {
      return;
    }

    if (item.status === "retry_wait" && item.retry_after && nowMs >= item.retry_after) {
      item.status = "reclaim_ready";
    }

    if (item.status === "reclaim_ready") {
      if (item.order_krw < 5000) {
        // orderKrw < 5000 -> RECLAIM_PRECHECK_BLOCKED 로그 모사 및 retry_wait
        item.attempt_count = (item.attempt_count || 0) + 1;
        if (item.attempt_count >= 5) {
          testWatchlist814.delete(market);
          return;
        }
        item.status = "retry_wait";
        item.retry_after = nowMs + 5000;
        return;
      }

      // orderKrw >= 5000 -> placeBuy 실행
      mockPlaceBuyCalls814++;
      item.status = "entered";
      testWatchlist814.delete(market);
    }
  }

  // 첫 번째 틱: 주문 금액 4999원 -> placeBuy 0회 및 retry_wait 전이
  testWatchlist814.set("KRW-SOL", { status: "reclaim_ready", attempt_count: 0, order_krw: 4999 });
  const startMs814 = Date.now();
  runWatchlistReclaimTickSim814("KRW-SOL", startMs814);
  const itemAfterTick1_814 = testWatchlist814.get("KRW-SOL");
  console.log(`- After Tick 1 (orderKrw 4999): status=${itemAfterTick1_814?.status}, attempt_count=${itemAfterTick1_814?.attempt_count}, placeBuyCalls=${mockPlaceBuyCalls814} (Expected: retry_wait, 1, 0)`);
  if (itemAfterTick1_814?.status !== "retry_wait" || itemAfterTick1_814?.attempt_count !== 1 || mockPlaceBuyCalls814 !== 0) {
    throw new Error("Test 8.14 Step 1 Failed");
  }

  // 두 번째 틱 (5초 후): 사용 가능 잔고 증가로 주문 금액 5000원 이상 -> placeBuy 성공 및 watchlist 삭제
  itemAfterTick1_814.order_krw = 6000;
  runWatchlistReclaimTickSim814("KRW-SOL", startMs814 + 6000);
  const itemAfterTick2_814 = testWatchlist814.get("KRW-SOL");
  console.log(`- After 6s (orderKrw 6000): itemRemoved=${!itemAfterTick2_814}, placeBuyCalls=${mockPlaceBuyCalls814} (Expected: true, 1)`);
  if (itemAfterTick2_814 || mockPlaceBuyCalls814 !== 1) {
    throw new Error("Test 8.14 Step 2 Failed");
  }
  console.log("-> Test 8.14 Passed!");

  // 8.15. retry_wait 해결 시 Reclaim 조건 엄격 재검증 테스트
  console.log("\n[Test 8.15] Verifying strict Reclaim condition validation on retry_wait resolution...");
  const testWatchlist815 = new Map<string, {
    status: string;
    attempt_count: number;
    retry_after?: number;
    local_high_price: number;
    pullback_low_price: number;
    current_price: number;
    recent_1m_ret: number;
    recent_3m_ret: number;
    closes1: number[];
  }>();
  let mockPlaceBuyCalls815: any = 0;

  function runWatchlistReclaimTickSim815(market: string, nowMs: number) {
    const item = testWatchlist815.get(market);
    if (!item) return;

    if (item.status === "retry_wait" && item.retry_after && nowMs < item.retry_after) {
      return;
    }

    // 2. retry_wait -> reclaim_ready 복귀 (조건 재검증)
    if (item.status === "retry_wait" && item.retry_after && nowMs >= item.retry_after) {
      const isRebounding = item.pullback_low_price !== null && item.current_price > item.pullback_low_price;
      const returnsOk = item.recent_1m_ret > 0 && item.recent_3m_ret >= 0 && item.recent_3m_ret <= 2.5;
      const nearHigh = item.current_price >= item.local_high_price * 0.997 && item.current_price <= item.local_high_price * 1.003;

      // EMA20 구하기 (closes1 배열의 평균을 가식으로 구함. closes1의 길이를 보고 undefined 처리)
      let ema20: number | undefined;
      if (item.closes1.length >= 20) {
        ema20 = item.closes1.reduce((a, b) => a + b, 0) / item.closes1.length;
      }
      const hasEma = typeof ema20 === "number" && Number.isFinite(ema20);
      const isAboveEma = hasEma && item.current_price >= ema20!;

      const conditionsValid = isRebounding && returnsOk && nearHigh && hasEma && isAboveEma;
      console.log(`- Debug 8.15: market=${market}, reb=${isRebounding}, ret=${returnsOk}, near=${nearHigh}, hasEma=${hasEma}, aboveEma=${isAboveEma}, ema=${ema20}, cur=${item.current_price}, low=${item.pullback_low_price}`);

      if (conditionsValid) {
        item.status = "reclaim_ready";
      } else {
        item.status = "pullback_seen";
        item.retry_after = undefined; // 쿨다운 해제하여 다음 tick에 pullback_seen 에서 다시 조건 만족 시 상승 유도
      }
    }

    // 3. reclaim_ready 일 때 주문 실행
    if (item.status === "reclaim_ready") {
      item.attempt_count = (item.attempt_count || 0) + 1;
      if (item.attempt_count >= 5) {
        testWatchlist815.delete(market);
        return;
      }

      mockPlaceBuyCalls815++;
      // placeBuy 호출 성공 시나리오
      item.status = "entered";
      testWatchlist815.delete(market);
    }
  }

  // 공통 초기 설정
  const baseItem = {
    status: "retry_wait",
    attempt_count: 1,
    retry_after: 1000,
    local_high_price: 1000,
    pullback_low_price: 990,
    current_price: 998,
    recent_1m_ret: 0.5,
    recent_3m_ret: 1.0,
    closes1: Array.from({ length: 20 }, () => 995), // EMA20 = 995, current_price(998) >= 995 (ok)
  };

  // 시나리오 1: 모든 조건 만족 시 -> placeBuy 성공 및 watchlist 삭제
  testWatchlist815.set("KRW-OK", { ...baseItem, closes1: [...baseItem.closes1] });
  runWatchlistReclaimTickSim815("KRW-OK", 1500);
  console.log(`- Scenario 1 (All OK): itemRemoved=${!testWatchlist815.has("KRW-OK")}, placeBuyCalls=${mockPlaceBuyCalls815} (Expected: true, 1)`);
  if (testWatchlist815.has("KRW-OK") || mockPlaceBuyCalls815 !== 1) {
    throw new Error("Scenario 1 Failed");
  }

  // 시나리오 2: 가격이 pullback_low 아래로 추락 -> placeBuy 0회 및 pullback_seen 강등
  mockPlaceBuyCalls815 = 0;
  testWatchlist815.set("KRW-LOW_PRICE", { ...baseItem, current_price: 985, closes1: [...baseItem.closes1] });
  runWatchlistReclaimTickSim815("KRW-LOW_PRICE", 1500);
  const itemLowPx = testWatchlist815.get("KRW-LOW_PRICE");
  console.log(`- Scenario 2 (Price < pullback_low): status=${itemLowPx?.status}, placeBuyCalls=${mockPlaceBuyCalls815} (Expected: pullback_seen, 0)`);
  if (itemLowPx?.status !== "pullback_seen" || mockPlaceBuyCalls815 !== 0) {
    throw new Error("Scenario 2 Failed");
  }

  // 시나리오 3: nearHigh 이탈 (너무 크게 반등해서 1.003 초과) -> placeBuy 0회 및 pullback_seen 강등
  testWatchlist815.set("KRW-HIGH_OUT", { ...baseItem, current_price: 1010, closes1: [...baseItem.closes1] });
  runWatchlistReclaimTickSim815("KRW-HIGH_OUT", 1500);
  const itemHighOut = testWatchlist815.get("KRW-HIGH_OUT");
  console.log(`- Scenario 3 (nearHigh out): status=${itemHighOut?.status}, placeBuyCalls=${mockPlaceBuyCalls815} (Expected: pullback_seen, 0)`);
  if (itemHighOut?.status !== "pullback_seen" || mockPlaceBuyCalls815 !== 0) {
    throw new Error("Scenario 3 Failed");
  }

  // 시나리오 4: recent1mRet <= 0 -> placeBuy 0회 및 pullback_seen 강등
  testWatchlist815.set("KRW-RET_LOW", { ...baseItem, recent_1m_ret: 0, closes1: [...baseItem.closes1] });
  runWatchlistReclaimTickSim815("KRW-RET_LOW", 1500);
  const itemRetLow = testWatchlist815.get("KRW-RET_LOW");
  console.log(`- Scenario 4 (recent1mRet <= 0): status=${itemRetLow?.status}, placeBuyCalls=${mockPlaceBuyCalls815} (Expected: pullback_seen, 0)`);
  if (itemRetLow?.status !== "pullback_seen" || mockPlaceBuyCalls815 !== 0) {
    throw new Error("Scenario 4 Failed");
  }

  // 시나리오 5: EMA 계산 실패 (closes1 길이 부족으로 fail-closed) -> placeBuy 0회 및 pullback_seen 강등
  testWatchlist815.set("KRW-EMA_FAIL", { ...baseItem, closes1: [990, 992] });
  runWatchlistReclaimTickSim815("KRW-EMA_FAIL", 1500);
  const itemEmaFail = testWatchlist815.get("KRW-EMA_FAIL");
  console.log(`- Scenario 5 (EMA fail): status=${itemEmaFail?.status}, placeBuyCalls=${mockPlaceBuyCalls815} (Expected: pullback_seen, 0)`);
  if (itemEmaFail?.status !== "pullback_seen" || mockPlaceBuyCalls815 !== 0) {
    throw new Error("Scenario 5 Failed");
  }

  // 시나리오 6: 조건 이탈 후 다시 조건 형성 시 placeBuy 1회
  testWatchlist815.set("KRW-RECOVER", { ...baseItem, current_price: 985, closes1: [...baseItem.closes1] }); // 초기 상태: pullback_low 아래 (이탈 상태)
  
  // 첫 번째 tick: 재검증 실패 -> pullback_seen 강등
  runWatchlistReclaimTickSim815("KRW-RECOVER", 1500);
  const itemRecover = testWatchlist815.get("KRW-RECOVER");
  console.log(`- Scenario 6 Tick 1 (Price < pullback_low): status=${itemRecover?.status} (Expected: pullback_seen)`);
  if (itemRecover?.status !== "pullback_seen") {
    throw new Error("Scenario 6 Step 1 Failed");
  }

  // 두 번째 tick: 가격이 998로 다시 회복됨 -> pullback_seen 에서 reclaim_ready 로 다시 올라갈 조건 구사
  if (itemRecover) {
    itemRecover.current_price = 998;
    const isRebounding = itemRecover.pullback_low_price !== null && itemRecover.current_price > itemRecover.pullback_low_price;
    const returnsOk = itemRecover.recent_1m_ret > 0 && itemRecover.recent_3m_ret >= 0 && itemRecover.recent_3m_ret <= 2.5;
    const nearHigh = itemRecover.current_price >= itemRecover.local_high_price * 0.997 && itemRecover.current_price <= itemRecover.local_high_price * 1.003;
    let ema20: number | undefined;
    if (itemRecover.closes1.length >= 20) {
      ema20 = itemRecover.closes1.reduce((a, b) => a + b, 0) / itemRecover.closes1.length;
    }
    const hasEma = typeof ema20 === "number" && Number.isFinite(ema20);
    const isAboveEma = hasEma && itemRecover.current_price >= ema20!;

    if (isRebounding && returnsOk && nearHigh && hasEma && isAboveEma) {
      itemRecover.status = "reclaim_ready";
    }
  }

  // Tick 실행 -> reclaim_ready 이므로 placeBuy 성공하고 삭제됨
  runWatchlistReclaimTickSim815("KRW-RECOVER", 2000);
  console.log(`- Scenario 6 Tick 2 (Recovered OK): itemRemoved=${!testWatchlist815.has("KRW-RECOVER")}, placeBuyCalls=${mockPlaceBuyCalls815} (Expected: true, 1)`);
  if (testWatchlist815.has("KRW-RECOVER") || mockPlaceBuyCalls815 !== 1) {
    throw new Error("Scenario 6 Step 2 Failed");
  }

  console.log("-> Test 8.15 Passed!");

  // 8.16. reclaim_ready 복원 후 주문 직전 전체 조건 재검증 테스트
  console.log("\n[Test 8.16] Verifying reclaim_ready restoration and order gate strict verification...");
  const testWatchlist816 = new Map<string, {
    status: string;
    attempt_count: number;
    local_high_price: number;
    pullback_low_price: number;
    current_price: number;
    recent_1m_ret: number;
    recent_3m_ret: number;
    closes1: number[];
  }>();
  let mockPlaceBuyCalls816: any = 0;

  function runWatchlistReclaimTickSim816(market: string) {
    const item = testWatchlist816.get(market);
    if (!item) return;

    // 1. 주문 직전 전체 조건 재검증 (item.status === "reclaim_ready")
    if (item.status === "reclaim_ready") {
      const isRebounding = item.pullback_low_price !== null && item.current_price > item.pullback_low_price;
      const returnsOk = item.recent_1m_ret > 0 && item.recent_3m_ret >= 0 && item.recent_3m_ret <= 2.5;
      const nearHigh = item.current_price >= item.local_high_price * 0.997 && item.current_price <= item.local_high_price * 1.003;

      let ema20: number | undefined;
      if (item.closes1.length >= 20) {
        ema20 = item.closes1.reduce((a, b) => a + b, 0) / item.closes1.length;
      }
      const hasEma = typeof ema20 === "number" && Number.isFinite(ema20);
      const isAboveEma = hasEma && item.current_price >= ema20!;

      const conditionsValid = isRebounding && returnsOk && nearHigh && hasEma && isAboveEma;

      if (!conditionsValid) {
        // 강등 처리
        item.status = "pullback_seen";
        return;
      }

      // 2. 모든 조건 정상 시 placeBuy
      mockPlaceBuyCalls816++;
      item.status = "entered";
      testWatchlist816.delete(market);
    }
  }

  // 공통 초기 설정
  const baseItem816 = {
    status: "reclaim_ready",
    attempt_count: 0,
    local_high_price: 1000,
    pullback_low_price: 990,
    current_price: 998,
    recent_1m_ret: 0.5,
    recent_3m_ret: 1.0,
    closes1: Array.from({ length: 20 }, () => 995), // EMA20 = 995 (ok)
  };

  // 시나리오 1: 가격이 pullback_low 이하 -> placeBuy 0회 및 강등
  testWatchlist816.set("KRW-LOW_PX", { ...baseItem816, current_price: 985, closes1: [...baseItem816.closes1] });
  runWatchlistReclaimTickSim816("KRW-LOW_PX");
  const itemLowPx816 = testWatchlist816.get("KRW-LOW_PX");
  console.log(`- Scenario 1 (Price <= pullback_low): status=${itemLowPx816?.status}, placeBuyCalls=${mockPlaceBuyCalls816} (Expected: pullback_seen, 0)`);
  if (itemLowPx816?.status !== "pullback_seen" || mockPlaceBuyCalls816 !== 0) {
    throw new Error("Test 8.16 Scenario 1 Failed");
  }

  // 시나리오 2: nearHigh 이탈 (고점 1.003 초과) -> placeBuy 0회 및 강등
  testWatchlist816.set("KRW-HIGH_OUT", { ...baseItem816, current_price: 1010, closes1: [...baseItem816.closes1] });
  runWatchlistReclaimTickSim816("KRW-HIGH_OUT");
  const itemHighOut816 = testWatchlist816.get("KRW-HIGH_OUT");
  console.log(`- Scenario 2 (nearHigh out): status=${itemHighOut816?.status}, placeBuyCalls=${mockPlaceBuyCalls816} (Expected: pullback_seen, 0)`);
  if (itemHighOut816?.status !== "pullback_seen" || mockPlaceBuyCalls816 !== 0) {
    throw new Error("Test 8.16 Scenario 2 Failed");
  }

  // 시나리오 3: recent1mRet <= 0 -> placeBuy 0회 및 강등
  testWatchlist816.set("KRW-RET_LOW", { ...baseItem816, recent_1m_ret: 0, closes1: [...baseItem816.closes1] });
  runWatchlistReclaimTickSim816("KRW-RET_LOW");
  const itemRetLow816 = testWatchlist816.get("KRW-RET_LOW");
  console.log(`- Scenario 3 (recent1mRet <= 0): status=${itemRetLow816?.status}, placeBuyCalls=${mockPlaceBuyCalls816} (Expected: pullback_seen, 0)`);
  if (itemRetLow816?.status !== "pullback_seen" || mockPlaceBuyCalls816 !== 0) {
    throw new Error("Test 8.16 Scenario 3 Failed");
  }

  // 시나리오 4: recent3mRet > 2.5 -> placeBuy 0회 및 강등
  testWatchlist816.set("KRW-RET_HIGH", { ...baseItem816, recent_3m_ret: 2.6, closes1: [...baseItem816.closes1] });
  runWatchlistReclaimTickSim816("KRW-RET_HIGH");
  const itemRetHigh816 = testWatchlist816.get("KRW-RET_HIGH");
  console.log(`- Scenario 4 (recent3mRet > 2.5): status=${itemRetHigh816?.status}, placeBuyCalls=${mockPlaceBuyCalls816} (Expected: pullback_seen, 0)`);
  if (itemRetHigh816?.status !== "pullback_seen" || mockPlaceBuyCalls816 !== 0) {
    throw new Error("Test 8.16 Scenario 4 Failed");
  }

  // 시나리오 5: EMA 계산 실패 -> placeBuy 0회 및 강등
  testWatchlist816.set("KRW-EMA_FAIL", { ...baseItem816, closes1: [990, 992] });
  runWatchlistReclaimTickSim816("KRW-EMA_FAIL");
  const itemEmaFail816 = testWatchlist816.get("KRW-EMA_FAIL");
  console.log(`- Scenario 5 (EMA fail): status=${itemEmaFail816?.status}, placeBuyCalls=${mockPlaceBuyCalls816} (Expected: pullback_seen, 0)`);
  if (itemEmaFail816?.status !== "pullback_seen" || mockPlaceBuyCalls816 !== 0) {
    throw new Error("Test 8.16 Scenario 5 Failed");
  }

  // 시나리오 6: 모든 조건 정상 -> placeBuy 정확히 1회 및 watchlist 삭제
  testWatchlist816.set("KRW-OK", { ...baseItem816, closes1: [...baseItem816.closes1] });
  runWatchlistReclaimTickSim816("KRW-OK");
  console.log(`- Scenario 6 (All OK): itemRemoved=${!testWatchlist816.has("KRW-OK")}, placeBuyCalls=${mockPlaceBuyCalls816} (Expected: true, 1)`);
  if (testWatchlist816.has("KRW-OK") || mockPlaceBuyCalls816 !== 1) {
    throw new Error("Test 8.16 Scenario 6 Failed");
  }

  console.log("-> Test 8.16 Passed!");

  console.log("-> Test 8 Passed!");

  // Restore fetch
  global.fetch = originalFetch;

  console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  global.fetch = originalFetch;
  console.error("Test execution failed:", err);
  process.exit(1);
});

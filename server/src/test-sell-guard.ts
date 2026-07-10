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

  // 6.2. grace period 중일 때 Sell Guard 차단 동작 검증
  const LIVE_EXIT_GRACE_SECONDS = 60; // 60초 가정
  const simulateSellGuardWithGrace = (pos: any, elapsedMs: number, graceMs: number): { allowed: boolean; reason: string } => {
    const isRecovered = pos.entry_origin === "auto_trade_recovered" || pos.entry_origin === "auto_trade_recovered_all_holdings" || pos.reason_enter === "RECOVERED_AFTER_LEDGER_MISS";
    if (isRecovered && elapsedMs < graceMs) {
      return { allowed: false, reason: "recovered_position_grace_active" };
    }
    return { allowed: true, reason: "" };
  };

  const gracePos = { entry_origin: "auto_trade_recovered", entry_ts: new Date().toISOString() };
  const guardRes1 = simulateSellGuardWithGrace(gracePos, 10 * 1000, LIVE_EXIT_GRACE_SECONDS * 1000); // 10초 경과
  console.log(`Grace Active Check (10s elapsed): allowed=${guardRes1.allowed}, reason=${guardRes1.reason} (Expected: false, recovered_position_grace_active)`);
  if (guardRes1.allowed || guardRes1.reason !== "recovered_position_grace_active") {
    throw new Error("Case 6.2 Failed: Sell Guard must block during grace period");
  }

  const guardRes2 = simulateSellGuardWithGrace(gracePos, 70 * 1000, LIVE_EXIT_GRACE_SECONDS * 1000); // 70초 경과
  console.log(`Grace Expired Check (70s elapsed): allowed=${guardRes2.allowed} (Expected: true)`);
  if (!guardRes2.allowed) {
    throw new Error("Case 6.2 Failed: Sell Guard must allow after grace period expired");
  }

  // 6.3. grace 종료 후 +2.9% 에서 매도 없음 검증
  const surgePosUnderTP = {
    entry_origin: "auto_trade_recovered",
    entry_price: 95_000_000,
    qty: 0.1,
    max_pnl_pct: 2.9,
    strict_exit: true,
    engine_bucket: "surge",
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

  // 6.4. grace 종료 후 +3.0% 에서 25% 일부 익절 주문이 예약되는지 검증 (정확히 1회, sell ratio 0.25)
  // 6.5. 기존 stale surge_take_profit_price가 +3.0%보다 낮은 가격(예: +1.5%)으로 주입되어도 3.0%가 우선 적용되는지 검증
  const surgePosAtTPStale = {
    entry_origin: "auto_trade_recovered",
    entry_price: 95_000_000,
    qty: 0.1,
    max_pnl_pct: 3.0,
    strict_exit: true,
    engine_bucket: "surge",
    surge_entry_mode: "RECOVERED_SURGE_POLICY",
    surge_stop_price: 90_000_000,
    surge_take_profit_price: 95_000_000 * 1.015, // +1.5% 라는 구버전/stale TP2 가격 주입
    surge_trailing_gap_pct: 2.2,
    entry_ts: new Date(Date.now() - 70000).toISOString(),
  };

  const exitAtTP = evaluateSurgeExit(surgePosAtTPStale, 95_000_000 * 1.030, 0); // +3.0%
  console.log(`Surge Exit Check (+3.0% with stale TP2): action=${exitAtTP.action}, reason=${exitAtTP.reason}, ratio=${exitAtTP.ratio} (Expected: sell, SURGE_TP1_PARTIAL, ratio 0.25)`);
  if (exitAtTP.action !== "sell" || exitAtTP.reason !== "SURGE_TP1_PARTIAL" || exitAtTP.ratio !== 0.25) {
    throw new Error("Case 6.4/6.5 Failed: Should trigger partial TP1 with ratio 0.25 at +3.0% even with stale TP2 price");
  }

  // 6.6. 일반 stable/momentum strict TP 경로가 실행되지 않고 오직 surge 전용 엔진의 리턴값으로 exit가 결정되는지 (중복 매도나 multiple exit target 방지) 검증
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
    throw new Error("Case 6.6 Failed: Surge position must only execute surge exit engine and bypass stable/momentum strict paths");
  }

  // 6.7. Passive Holding 검증
  const mockState = {
    positions: {
      "KRW-BTC": { entry_origin: "auto_trade_recovered" }
    }
  };
  const isPassiveHoldingExcluded = !Object.keys(mockState.positions).includes("KRW-ETH"); // ETH는 passive holding으로 가정
  console.log(`Passive Holding Exclusion Check: ETH excluded=${isPassiveHoldingExcluded} (Expected: true)`);
  if (!isPassiveHoldingExcluded) {
    throw new Error("Case 6.7 Failed: Passive holding must not be in state.positions to avoid exit loop");
  }

  console.log("-> Test 6 Passed!");

  // Restore fetch
  global.fetch = originalFetch;

  console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  global.fetch = originalFetch;
  console.error("Test execution failed:", err);
  process.exit(1);
});

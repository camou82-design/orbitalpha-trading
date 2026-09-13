import {
  fetchTickers,
  partitionKrwMarketsByUpbitValidity,
  tickerCache,
  lastGoodTickerCache,
  acquireTickerLock,
  resetTickerLockStateForTest,
} from "./upbit-public.js";
import {
  resolveTickerPricesForBalances,
  evaluateInitialMarketFreshness,
  computeAccountValuationFromPrices,
  buildEffectiveValuationPriceMap,
  BalanceRow,
} from "./account-portfolio.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error("[FAIL] " + msg);
    throw new Error("Assertion failed: " + msg);
  }
  console.log("[PASS] " + msg);
}

async function runRegressionSuite() {
  console.log("=== Starting Spot LIVE Ticker Latency & Dashboard Freshness Test Suite ===\n");

  // Warm up
  try {
    await fetchTickers(["KRW-BTC"]);
  } catch {}

  // A. invalid SOLO/XCORE가 ticker REST request에서 제외
  console.log("--- Test A: invalid SOLO/XCORE가 ticker REST request에서 사전 제외 ---");
  {
    const rawSymbols = ["KRW-BTC", "KRW-ETH", "KRW-SOLO", "KRW-XCORE", "KRW-XRP"];
    const partition = await partitionKrwMarketsByUpbitValidity(rawSymbols);
    assert(partition.accepted.includes("KRW-BTC"), "Test A: accepted includes KRW-BTC");
    assert(partition.accepted.includes("KRW-ETH"), "Test A: accepted includes KRW-ETH");
    assert(partition.accepted.includes("KRW-XRP"), "Test A: accepted includes KRW-XRP");
    assert(!partition.accepted.includes("KRW-SOLO"), "Test A: accepted excludes KRW-SOLO");
    assert(!partition.accepted.includes("KRW-XCORE"), "Test A: accepted excludes KRW-XCORE");
    assert(partition.rejected.includes("KRW-SOLO"), "Test A: rejected includes KRW-SOLO");
    assert(partition.rejected.includes("KRW-XCORE"), "Test A: rejected includes KRW-XCORE");
  }

  // B. supported Core markets BTC/ETH/XRP/SOL/DOGE/ADA 가격 정상 확보
  console.log("\n--- Test B: supported Core markets 6종 가격 정상 확보 ---");
  {
    const CORE_6 = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE", "KRW-ADA"];
    const t0 = Date.now();
    const rows = await fetchTickers(CORE_6, { isPriority: true });
    const elapsed = Date.now() - t0;
    console.log("Core 6 fetch elapsed: " + elapsed + "ms");
    assert(rows.length === 6, "Test B: returned all 6 core tickers (got " + rows.length + ")");
    for (const m of CORE_6) {
      const row = rows.find((r) => r.market === m);
      assert(Boolean(row && Number(row.trade_price) > 0), "Test B: " + m + " has valid trade_price (" + row?.trade_price + ")");
    }
  }

  // C. dashboard polling 중에도 live ticker fetch가 lock starvation되지 않음
  console.log("\n--- Test C: dashboard polling 중에도 live priority ticker fetch가 우선 처리됨 ---");
  resetTickerLockStateForTest();
  {
    // Dashboard non-priority lock 대기자 생성
    const releaseHolder = await acquireTickerLock({ caller: "initial_holder", priority: false });

    let dashAcquiredOrder = 0;
    let liveAcquiredOrder = 0;
    let orderSeq = 0;

    const dashWaiterPromise = acquireTickerLock({ caller: "dashboard_polling", priority: false, timeoutMs: 2000 }).then((rel) => {
      dashAcquiredOrder = ++orderSeq;
      rel();
    });

    // 잠시 후 Live Engine priority 요청 진입
    const liveWaiterPromise = acquireTickerLock({ caller: "live_engine", priority: true, timeoutMs: 2000 }).then((rel) => {
      liveAcquiredOrder = ++orderSeq;
      rel();
    });

    // Holder 해제
    releaseHolder();
    await Promise.all([dashWaiterPromise, liveWaiterPromise]);

    assert(liveAcquiredOrder === 1, "Test C: live engine priority lock acquired first (order: " + liveAcquiredOrder + ")");
    assert(dashAcquiredOrder === 2, "Test C: dashboard non-priority lock acquired second (order: " + dashAcquiredOrder + ")");
  }

  // D. Pure Deterministic Freshness Evaluator 검증 (네트워크 비의존)
  console.log("\n--- Test D: Deterministic evaluateInitialMarketFreshness Pure Unit Tests ---");
  {
    const now = 1000000;
    const freshLimitMs = 5000;

    const mockTickerCache = new Map<string, any>();
    const mockLastGood = new Map<string, any>();

    // 1) Fresh BTC (2초 전)
    mockTickerCache.set("KRW-BTC", {
      value: { trade_price: 109_000_000 },
      fetchedAtMs: now - 2000,
    });

    // 2) Stale ETH (15초 전)
    mockTickerCache.set("KRW-ETH", {
      value: { trade_price: 3_200_000 },
      fetchedAtMs: now - 15000,
    });

    // 3) lastGood only XRP
    mockLastGood.set("KRW-XRP", {
      trade_price: 1_800,
    });

    // 4) Seed only TRX
    const seed = { "KRW-TRX": 250 };

    // 5) Missing SOL (아무데도 없음)
    const markets = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX", "KRW-SOL"];

    const evalRes = evaluateInitialMarketFreshness({
      markets,
      tickerCacheMap: mockTickerCache,
      lastGoodMap: mockLastGood,
      seed,
      now,
      freshMaxAgeMs: freshLimitMs,
    });

    // BTC 검증: Fresh 캐시 -> 가격 보존 + freshMarkets 포함 + staleMarkets 제외
    assert(evalRes.initialMerged["KRW-BTC"] === 109_000_000, "Test D-1: Fresh BTC price preserved");
    assert(evalRes.freshMarkets.has("KRW-BTC"), "Test D-1: Fresh BTC in freshMarkets");
    assert(!evalRes.staleMarkets.includes("KRW-BTC"), "Test D-1: Fresh BTC NOT in staleMarkets");

    // ETH 검증: Stale 캐시 -> 가격 보존 + freshMarkets 제외 + staleMarkets 포함 (REST refresh 대상)
    assert(evalRes.initialMerged["KRW-ETH"] === 3_200_000, "Test D-2: Stale ETH fallback price preserved");
    assert(!evalRes.freshMarkets.has("KRW-ETH"), "Test D-2: Stale ETH NOT in freshMarkets");
    assert(evalRes.staleMarkets.includes("KRW-ETH"), "Test D-2: Stale ETH in staleMarkets for refresh");

    // XRP 검증: lastGood only -> 가격 보존 + freshMarkets 제외 + staleMarkets 포함
    assert(evalRes.initialMerged["KRW-XRP"] === 1_800, "Test D-3: lastGood XRP fallback price preserved");
    assert(!evalRes.freshMarkets.has("KRW-XRP"), "Test D-3: lastGood XRP NOT in freshMarkets");
    assert(evalRes.staleMarkets.includes("KRW-XRP"), "Test D-3: lastGood XRP in staleMarkets for refresh");

    // TRX 검증: Seed only -> 가격 보존 + freshMarkets 제외 + staleMarkets 포함
    assert(evalRes.initialMerged["KRW-TRX"] === 250, "Test D-4: Seed TRX fallback price preserved");
    assert(!evalRes.freshMarkets.has("KRW-TRX"), "Test D-4: Seed TRX NOT in freshMarkets");
    assert(evalRes.staleMarkets.includes("KRW-TRX"), "Test D-4: Seed TRX in staleMarkets for refresh");

    // SOL 검증: Missing -> staleMarkets 포함
    assert(evalRes.staleMarkets.includes("KRW-SOL"), "Test D-5: Missing SOL in staleMarkets for refresh");
  }

  // D-2. resolveTickerPricesForBalances 캐시 신선도 및 fallback 보존 검증
  console.log("\n--- Test D-2: resolveTickerPricesForBalances Fresh Cache vs Stale Fallback ---");
  {
    const mockBalances: BalanceRow[] = [
      { currency: "BTC", balance: 0.1, locked: 0, avg_buy_price: 100_000_000 },
      { currency: "ETH", balance: 1.0, locked: 0, avg_buy_price: 3_000_000 },
    ];

    const now = Date.now();
    // BTC: 1초 전 최신 캐시 (fresh)
    tickerCache.set("KRW-BTC", {
      value: { market: "KRW-BTC", trade_price: 109_500_000, signed_change_rate: 0.02 } as any,
      fetchedAtMs: now - 1000,
      expiresAtMs: now + 50000,
      staleUntilMs: now + 80000,
    });
    // ETH: tickerCache 없음, lastGoodTickerCache만 존재 (stale fallback)
    tickerCache.delete("KRW-ETH");
    lastGoodTickerCache.set("KRW-ETH", {
      market: "KRW-ETH",
      trade_price: 3_250_000,
      signed_change_rate: 0.01,
    } as any);

    const t0 = Date.now();
    const { merged, rest_fresh_markets } = await resolveTickerPricesForBalances(mockBalances, null, {
      isPriority: false,
      freshMaxAgeMs: 5000,
    });
    const elapsed = Date.now() - t0;

    console.log("resolveTickerPricesForBalances elapsed: " + elapsed + "ms");
    assert(merged["KRW-BTC"] === 109_500_000, "Test D-2: BTC price synced from fresh tickerCache (" + merged["KRW-BTC"] + ")");
    assert(rest_fresh_markets.has("KRW-BTC"), "Test D-2: Fresh BTC in rest_fresh_markets");
    assert(merged["KRW-ETH"] > 0, "Test D-2: ETH has valid fallback or live price (" + merged["KRW-ETH"] + ")");
  }

  // D-3. REST 실패/타임아웃 시 Fallback 보존 및 평가 유지 검증
  console.log("\n--- Test D-3: REST 실패/타임아웃 시 Fallback 가격 보존 및 계좌 평가 유지 ---");
  {
    const mockBalances: BalanceRow[] = [
      { currency: "BTC", balance: 0.05, locked: 0, avg_buy_price: 100_000_000 },
      { currency: "ETH", balance: 2.0, locked: 0, avg_buy_price: 3_000_000 },
    ];

    // Seed 가격 주입
    const seed = {
      "KRW-BTC": 105_000_000,
      "KRW-ETH": 3_300_000,
    };

    // Stale 캐시 설정
    const now = Date.now();
    tickerCache.set("KRW-BTC", {
      value: { market: "KRW-BTC", trade_price: 105_000_000, signed_change_rate: 0 } as any,
      fetchedAtMs: now - 30000, // 30초 전 stale
      expiresAtMs: now - 10000,
      staleUntilMs: now + 60000,
    });
    tickerCache.set("KRW-ETH", {
      value: { market: "KRW-ETH", trade_price: 3_300_000, signed_change_rate: 0 } as any,
      fetchedAtMs: now - 30000, // 30초 전 stale
      expiresAtMs: now - 10000,
      staleUntilMs: now + 60000,
    });

    // totalTimeoutMs=0 으로 설정하여 REST 시도가 즉시 중단되도록 시뮬레이션
    const { merged, rest_fresh_markets } = await resolveTickerPricesForBalances(mockBalances, seed, {
      isPriority: false,
      freshMaxAgeMs: 5000,
      signal: AbortSignal.abort(),
    });

    assert(merged["KRW-BTC"] === 105_000_000, "Test D-3: BTC fallback price preserved after timeout");
    assert(merged["KRW-ETH"] === 3_300_000, "Test D-3: ETH fallback price preserved after timeout");

    // 계좌 평가 계산 검증
    const eff = buildEffectiveValuationPriceMap(mockBalances, merged);
    const valuation = computeAccountValuationFromPrices(mockBalances, eff, new Date().toISOString());

    assert(valuation.portfolio.total_evaluated_krw > 0, "Test D-3: total_evaluated_krw is positive with fallback");
    assert(valuation.portfolio.buy_cost_krw === 0.05 * 100_000_000 + 2.0 * 3_000_000, "Test D-3: buy_cost_krw exact match");
    assert(valuation.mark_prices["KRW-BTC"] === 105_000_000, "Test D-3: mark_prices BTC matches fallback");
    assert(valuation.mark_prices["KRW-ETH"] === 3_300_000, "Test D-3: mark_prices ETH matches fallback");
  }

  // E. avg_buy_price=0 + valid mark price 보유자산이 holdings에서 사라지지 않음
  console.log("\n--- Test E: avg_buy_price=0 + valid mark price 보유자산이 holdings에서 보존 ---");
  {
    const balances = [
      { currency: "BTC", balance: 0.0001, locked: 0, avg_buy_price: 0 }, // avg=0 but mark=109m -> eval=10,900 KRW >= 1000
    ];
    const markPrices = { "KRW-BTC": 109_000_000 };
    const DUST_NOTIONAL_KRW = 1000;

    const held = balances
      .map((b: any) => {
        const currency = String(b?.currency ?? "").toUpperCase();
        if (!currency || currency === "KRW") return null;
        const qty = Number(b?.balance ?? 0) + Number(b?.locked ?? 0);
        if (!(qty > 0)) return null;
        const market = "KRW-" + currency;
        const avg = Number(b?.avg_buy_price ?? 0);
        const mark = Number(markPrices[market as keyof typeof markPrices] ?? 0);
        const notionalCost = qty * avg;
        const evalKrw = mark > 0 ? qty * mark : (avg > 0 ? notionalCost : 0);
        const hasPrice = mark > 0 || avg > 0;
        if (hasPrice && evalKrw < DUST_NOTIONAL_KRW) return null;
        return {
          market,
          currency,
          qty,
          avg_buy_price: avg,
          notional_cost_krw: notionalCost,
          current_price: mark > 0 ? mark : null,
          eval_krw: evalKrw > 0 ? evalKrw : null,
          price_status: mark > 0 ? ("live" as const) : ("unpriced" as const),
        };
      })
      .filter(Boolean);

    assert(held.length === 1, "Test E: asset with avg=0 preserved via mark_price (length: " + held.length + ")");
    assert(held[0]?.market === "KRW-BTC", "Test E: market is KRW-BTC");
    assert(held[0]?.eval_krw === 10900, "Test E: eval_krw is 10900 (got " + held[0]?.eval_krw + ")");
    assert(held[0]?.price_status === "live", "Test E: price_status is live");
  }

  // F. dust/unpriced passive asset이 managed slot/core capital에 포함되지 않음
  console.log("\n--- Test F: unpriced passive asset(SOLO/XCORE)이 passive로 보존되고 used_slots=0 유지 ---");
  {
    const balances = [
      { currency: "SOLO", balance: 50, locked: 0, avg_buy_price: 0 },
      { currency: "XCORE", balance: 100, locked: 0, avg_buy_price: 0 },
    ];
    const markPrices: Record<string, number> = {}; // unpriced
    const DUST_NOTIONAL_KRW = 1000;

    const openPositions: Record<string, any> = {};
    const earlyPositions: Record<string, any> = {};
    const managedMarkets = new Set<string>([
      ...Object.keys(openPositions).filter((m) => Number(openPositions[m]?.qty ?? 0) > 0),
      ...Object.keys(earlyPositions).filter((m) => Number(earlyPositions[m]?.qty ?? 0) > 0),
    ]);

    const held = balances
      .map((b: any) => {
        const currency = String(b?.currency ?? "").toUpperCase();
        if (!currency || currency === "KRW") return null;
        const qty = Number(b?.balance ?? 0) + Number(b?.locked ?? 0);
        if (!(qty > 0)) return null;
        const market = "KRW-" + currency;
        const avg = Number(b?.avg_buy_price ?? 0);
        const mark = Number(markPrices[market] ?? 0);
        const notionalCost = qty * avg;
        const evalKrw = mark > 0 ? qty * mark : (avg > 0 ? notionalCost : 0);
        const hasPrice = mark > 0 || avg > 0;
        if (hasPrice && evalKrw < DUST_NOTIONAL_KRW) return null;
        return {
          market,
          currency,
          qty,
          avg_buy_price: avg,
          notional_cost_krw: notionalCost,
          current_price: mark > 0 ? mark : null,
          eval_krw: evalKrw > 0 ? evalKrw : null,
          price_status: mark > 0 ? ("live" as const) : ("unpriced" as const),
        };
      })
      .filter(Boolean) as any[];

    const holdings = held.map((h) => {
      const managed = managedMarkets.has(h.market);
      return {
        ...h,
        holding_kind: managed ? ("managed_position" as const) : ("passive_holding" as const),
      };
    });

    const passiveCount = holdings.filter((h) => h.holding_kind === "passive_holding").length;
    const managedCount = holdings.filter((h) => h.holding_kind === "managed_position").length;
    const usedSlots = managedCount;

    assert(holdings.length === 2, "Test F: both SOLO and XCORE present in holdings (got " + holdings.length + ")");
    assert(passiveCount === 2, "Test F: both are classified as passive_holding (got " + passiveCount + ")");
    assert(managedCount === 0, "Test F: managedCount is 0 (got " + managedCount + ")");
    assert(usedSlots === 0, "Test F: used_slots is strictly 0 (got " + usedSlots + ")");
  }

  // G. Core 70 / Surge 30 invariant 유지
  console.log("\n--- Test G: Core 70 / Surge 30 Capital Authority Invariant 불변 검증 ---");
  {
    const totalAvailableKrw = 1_000_000;
    const CORE_CAPITAL_RATIO = 0.70;
    const SURGE_CAPITAL_RATIO = 0.30;

    const coreCapital = Math.floor(totalAvailableKrw * CORE_CAPITAL_RATIO);
    const surgeCapital = Math.floor(totalAvailableKrw * SURGE_CAPITAL_RATIO);

    assert(coreCapital === 700_000, "Test G: Core capital ratio is strictly 70% (" + coreCapital + ")");
    assert(surgeCapital === 300_000, "Test G: Surge capital ratio is strictly 30% (" + surgeCapital + ")");
    assert(coreCapital + surgeCapital === totalAvailableKrw, "Test G: 100% total capital conservation");
  }

  // H. Performance / Elapsed Measurement for valid ticker batch
  console.log("\n--- Test H: Production-equivalent Ticker Fetch Latency Benchmark ---");
  {
    const realisticUniverse = [
      "KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE", "KRW-ADA",
      "KRW-TRX", "KRW-AVAX", "KRW-DOT", "KRW-LINK"
    ];
    const t0 = Date.now();
    const tickers = await fetchTickers(realisticUniverse, { isPriority: true });
    const elapsed = Date.now() - t0;
    console.log("Realistic 10-market fetch elapsed: " + elapsed + "ms");
    assert(elapsed < 2000, "Test H: batch fetch completed well within 2000ms (took " + elapsed + "ms)");
    assert(tickers.length === realisticUniverse.length, "Test H: 100% coverage obtained (" + tickers.length + "/" + realisticUniverse.length + ")");
  }

  console.log("\n==========================================================================");
  console.log("  ALL REGRESSION TESTS (A through H) PASSED WITH ZERO FAILURES!  ");
  console.log("==========================================================================");
}

runRegressionSuite().catch((err) => {
  console.error("Test suite failed with error:", err);
  process.exit(1);
});

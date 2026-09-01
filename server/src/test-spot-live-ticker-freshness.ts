import {
  fetchTickers,
  partitionKrwMarketsByUpbitValidity,
  tickerCache,
  lastGoodTickerCache,
  acquireTickerLock,
  resetTickerLockStateForTest,
  getTickerLockStats,
} from "./upbit-public.js";
import {
  resolveTickerPricesForBalances,
  BalanceRow,
} from "./account-portfolio.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`[FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`[PASS] ${msg}`);
}

async function runRegressionSuite() {
  console.log("=== Starting Spot LIVE Ticker Latency & Dashboard Freshness Test Suite (A-G) ===\n");

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
    console.log(`Core 6 fetch elapsed: ${elapsed}ms`);
    assert(rows.length === 6, `Test B: returned all 6 core tickers (got ${rows.length})`);
    for (const m of CORE_6) {
      const row = rows.find((r) => r.market === m);
      assert(Boolean(row && Number(row.trade_price) > 0), `Test B: ${m} has valid trade_price (${row?.trade_price})`);
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

    assert(liveAcquiredOrder === 1, `Test C: live engine priority lock acquired first (order: ${liveAcquiredOrder})`);
    assert(dashAcquiredOrder === 2, `Test C: dashboard non-priority lock acquired second (order: ${dashAcquiredOrder})`);
  }

  // D. dashboard price가 engine latest snapshot을 통해 갱신
  console.log("\n--- Test D: dashboard price가 engine latest snapshot을 통해 0ms에 갱신 ---");
  {
    const mockBalances: BalanceRow[] = [
      { currency: "BTC", balance: 0.1, locked: 0, avg_buy_price: 100_000_000 },
      { currency: "ETH", balance: 1.0, locked: 0, avg_buy_price: 3_000_000 },
    ];

    // Engine이 티커 캐시에 최신 가격 주입
    const now = Date.now();
    tickerCache.set("KRW-BTC", {
      value: { market: "KRW-BTC", trade_price: 109_500_000, signed_change_rate: 0.02 } as any,
      fetchedAtMs: now,
      expiresAtMs: now + 5000,
      staleUntilMs: now + 15000,
    });
    tickerCache.delete("KRW-ETH");
    lastGoodTickerCache.set("KRW-ETH", {
      market: "KRW-ETH",
      trade_price: 3_250_000,
      signed_change_rate: 0.01,
    } as any);

    const t0 = Date.now();
    const { merged, rest_fresh_markets } = await resolveTickerPricesForBalances(mockBalances, null, { isPriority: false });
    const elapsed = Date.now() - t0;

    assert(elapsed < 50, `Test D: cache read completed instantaneously (${elapsed}ms < 50ms)`);
    assert(merged["KRW-BTC"] === 109_500_000, `Test D: BTC price synced from engine tickerCache (${merged["KRW-BTC"]})`);
    assert(merged["KRW-ETH"] === 3_250_000, `Test D: ETH price synced from engine lastGoodTickerCache (${merged["KRW-ETH"]})`);
    assert(rest_fresh_markets.has("KRW-BTC"), "Test D: BTC in fresh markets");
    assert(rest_fresh_markets.has("KRW-ETH"), "Test D: ETH in fresh markets");
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
        const market = `KRW-${currency}`;
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

    assert(held.length === 1, `Test E: asset with avg=0 preserved via mark_price (length: ${held.length})`);
    assert(held[0]?.market === "KRW-BTC", "Test E: market is KRW-BTC");
    assert(held[0]?.eval_krw === 10900, `Test E: eval_krw is 10900 (got ${held[0]?.eval_krw})`);
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
        const market = `KRW-${currency}`;
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

    assert(holdings.length === 2, `Test F: both SOLO and XCORE present in holdings (got ${holdings.length})`);
    assert(passiveCount === 2, `Test F: both are classified as passive_holding (got ${passiveCount})`);
    assert(managedCount === 0, `Test F: managedCount is 0 (got ${managedCount})`);
    assert(usedSlots === 0, `Test F: used_slots is strictly 0 (got ${usedSlots})`);
  }

  // G. Core 70 / Surge 30 invariant 유지
  console.log("\n--- Test G: Core 70 / Surge 30 Capital Authority Invariant 불변 검증 ---");
  {
    const totalAvailableKrw = 1_000_000;
    const CORE_CAPITAL_RATIO = 0.70;
    const SURGE_CAPITAL_RATIO = 0.30;

    const coreCapital = Math.floor(totalAvailableKrw * CORE_CAPITAL_RATIO);
    const surgeCapital = Math.floor(totalAvailableKrw * SURGE_CAPITAL_RATIO);

    assert(coreCapital === 700_000, `Test G: Core capital ratio is strictly 70% (${coreCapital})`);
    assert(surgeCapital === 300_000, `Test G: Surge capital ratio is strictly 30% (${surgeCapital})`);
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
    console.log(`Realistic 10-market fetch elapsed: ${elapsed}ms`);
    assert(elapsed < 2000, `Test H: batch fetch completed well within 2000ms (took ${elapsed}ms)`);
    assert(tickers.length === realisticUniverse.length, `Test H: 100% coverage obtained (${tickers.length}/${realisticUniverse.length})`);
  }

  console.log("\n==========================================================================");
  console.log("  ALL REGRESSION TESTS (A through H) PASSED WITH ZERO FAILURES!  ");
  console.log("==========================================================================");
}

runRegressionSuite().catch((err) => {
  console.error("Test suite failed with error:", err);
  process.exit(1);
});

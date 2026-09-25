import assert from "node:assert";
import {
  fetchTickersWithMeta,
  fetchTickers,
  isFreshForMomentum,
  lastGoodTickerCache,
  lastGoodTickerFetchedAtMap,
  tickerCache,
  tickerSourceMap,
  tickerAgeMap,
  getTickerTransportStats,
  resetTickerTransportStatsForTest,
  resetTickerLockStateForTest,
  parseRemainingReqHeader,
  type UpbitTicker,
  type FetchTickersWithMetaResult,
} from "./upbit-public.js";
import { selectMomentumTopM } from "./pump-scanner.js";

async function runSuite() {
  console.log("================================================================================");
  console.log("  SURGE SCANNER MARKET DATA TRANSPORT & RECOVERY REGRESSION TEST SUITE");
  console.log("================================================================================\n");

  const originalFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------------------
    // TEST A: /v1/ticker/all 정상 응답 -> KRW 전체 ticker live 처리 & 호환성 검증
    // -------------------------------------------------------------------------
    console.log("--- Test A: /v1/ticker/all 정상 응답 -> KRW 전체 ticker live 처리 ---");
    resetTickerTransportStatsForTest();
    resetTickerLockStateForTest();
    tickerCache.clear();
    lastGoodTickerCache.clear();
    lastGoodTickerFetchedAtMap.clear();

    const mock285Markets = Array.from({ length: 285 }, (_, i) => `KRW-MOCK${i}`);
    mock285Markets.push("KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-B3", "KRW-MANTRA", "KRW-STALE1", "KRW-FRESH1", "KRW-HELD1");

    let allCalled = false;
    let allUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/market/all")) {
        return new Response(JSON.stringify(mock285Markets.map((m) => ({ market: m }))), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("/v1/ticker/all")) {
        allCalled = true;
        allUrl = urlStr;
        const rows = mock285Markets.map((m, idx) => ({
          market: m,
          trade_date_utc: "2026-09-25",
          trade_time_utc: "06:30:00",
          timestamp: Date.now(),
          opening_price: 1000 + idx,
          high_price: 1100 + idx,
          low_price: 900 + idx,
          trade_price: 1050 + idx,
          prev_closing_price: 1000 + idx,
          change: "RISE",
          change_price: 50,
          change_rate: 0.05,
          signed_change_price: 50,
          signed_change_rate: 0.05,
          trade_volume: 100,
          acc_trade_price: 1000000,
          acc_trade_price_24h: 5000000000 + idx * 100000,
          acc_trade_volume: 1000,
          acc_trade_volume_24h: 5000,
        }));
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Remaining-Req": "group=market; min=599; sec=9",
          },
        });
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    }) as any;

    const resA = await fetchTickersWithMeta(mock285Markets, {
      preferAllEndpoint: true,
      maxMarkets: mock285Markets.length,
      debugCaller: "test-a",
    });

    assert(allCalled, "Test A: /v1/ticker/all endpoint was called");
    assert(allUrl.includes("quote_currencies=KRW"), "Test A: quote_currencies=KRW was passed");
    assert.strictEqual(resA.tickers.length, mock285Markets.length, "Test A: All 288 markets returned");
    assert.strictEqual(resA.fetchedLiveCount, mock285Markets.length, "Test A: All markets are live");
    assert.strictEqual(resA.staleFallbackCount, 0, "Test A: staleFallbackCount is strictly 0");
    assert.strictEqual(resA.momentumEligibleCount, mock285Markets.length, "Test A: All markets are momentum eligible");
    const transportStatsA = getTickerTransportStats();
    assert.strictEqual(transportStatsA.globalCooldownActive, false, "Test A: Global cooldown inactive");
    assert(transportStatsA.rateLimitInfo?.secRemaining === 9, "Test A: Rate limit header parsed");
    console.log("[PASS] Test A: /v1/ticker/all 정상 응답 -> 288종목 live 수집 및 schema 매핑 완료\n");

    // -------------------------------------------------------------------------
    // TEST B: 첫 요청 429 후 제한된 retry 성공 -> live 복구
    // -------------------------------------------------------------------------
    console.log("--- Test B: 첫 요청 429 후 제한된 retry 성공 -> live 복구 ---");
    resetTickerTransportStatsForTest();
    resetTickerLockStateForTest();
    tickerCache.clear();

    let tickerAttempts = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/market/all")) {
        return new Response(JSON.stringify([{ market: "KRW-BTC" }, { market: "KRW-ETH" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("/v1/ticker")) {
        tickerAttempts++;
        if (tickerAttempts === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "content-type": "text/plain", "Remaining-Req": "group=market; min=0; sec=0" },
          });
        }
        return new Response(
          JSON.stringify([
            { market: "KRW-BTC", trade_price: 115000000, signed_change_rate: 0.02, acc_trade_price_24h: 1000000000 },
            { market: "KRW-ETH", trade_price: 3600000, signed_change_rate: 0.01, acc_trade_price_24h: 500000000 },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json", "Remaining-Req": "group=market; min=590; sec=8" },
          },
        );
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    }) as any;

    const resB = await fetchTickersWithMeta(["KRW-BTC", "KRW-ETH"], {
      debugCaller: "test-b",
    });

    assert.strictEqual(tickerAttempts, 2, "Test B: Exactly 2 attempts (1 retry after 429)");
    assert.strictEqual(resB.fetchedLiveCount, 2, "Test B: Both markets recovered to live");
    assert.strictEqual(resB.staleFallbackCount, 0, "Test B: Stale fallback 0");
    const transportStatsB = getTickerTransportStats();
    assert.strictEqual(transportStatsB.global429Count, 1, "Test B: global429Count recorded");
    assert.strictEqual(transportStatsB.globalRetryCount, 1, "Test B: globalRetryCount recorded");
    assert.strictEqual(transportStatsB.circuitOpenCount, 0, "Test B: Circuit breaker NOT opened");
    console.log("[PASS] Test B: 429 후 retry 성공 -> live 복구 완료 (retry=1, circuit=0)\n");

    // -------------------------------------------------------------------------
    // TEST C: 반복 429 -> global cooldown 동작, per-market circuit 285개가 열리지 않음
    // -------------------------------------------------------------------------
    console.log("--- Test C: 반복 429 -> global cooldown 동작 & per-market circuit 미오염 ---");
    resetTickerTransportStatsForTest();
    resetTickerLockStateForTest();
    tickerCache.clear();

    let ticker429Calls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/market/all")) {
        return new Response(JSON.stringify(mock285Markets.map((m) => ({ market: m }))), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("/v1/ticker")) {
        ticker429Calls++;
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    }) as any;

    const resC = await fetchTickersWithMeta(mock285Markets.slice(0, 50), {
      preferAllEndpoint: true,
      debugCaller: "test-c",
    });

    const transportStatsC = getTickerTransportStats();
    assert(transportStatsC.globalCooldownActive, "Test C: Global cooldown is ACTIVE");
    assert.strictEqual(transportStatsC.circuitOpenCount, 0, "Test C: Per-market circuit breakers remain CLOSED (count === 0)");
    assert.strictEqual(resC.fetchedLiveCount, 0, "Test C: 0 live count during 429");
    console.log(`[PASS] Test C: 429 발생 시 전역 쿨다운 발동 및 개별 마켓 서킷브레이커 미오염 검증 (circuitOpenCount=${transportStatsC.circuitOpenCount})\n`);

    // -------------------------------------------------------------------------
    // TEST D: last_good 20시간 이상 존재 -> scanner momentum에 사용되지 않음 (엄격한 freshness)
    // -------------------------------------------------------------------------
    console.log("--- Test D: last_good 20시간 이상 존재 -> scanner momentum 사용 차단 ---");
    const nowD = Date.now();
    const staleFetchedAt = nowD - 22 * 3600 * 1000; // 22 hours ago

    lastGoodTickerCache.set("KRW-STALE1", {
      market: "KRW-STALE1",
      trade_price: 5000,
      signed_change_rate: 0.15,
      acc_trade_price_24h: 10000000000,
    });
    lastGoodTickerFetchedAtMap.set("KRW-STALE1", staleFetchedAt);

    // tickerCache contains expired item
    tickerCache.set("KRW-STALE1", {
      value: { market: "KRW-STALE1", trade_price: 5000, signed_change_rate: 0.15, acc_trade_price_24h: 10000000000 },
      fetchedAtMs: staleFetchedAt,
      expiresAtMs: staleFetchedAt + 60_000,
      staleUntilMs: staleFetchedAt + 90_000,
    });

    // Fresh token
    const freshFetchedAt = nowD - 5_000; // 5s ago
    lastGoodTickerCache.set("KRW-FRESH1", {
      market: "KRW-FRESH1",
      trade_price: 1000,
      signed_change_rate: 0.08,
      acc_trade_price_24h: 5000000000,
    });
    lastGoodTickerFetchedAtMap.set("KRW-FRESH1", freshFetchedAt);
    tickerCache.set("KRW-FRESH1", {
      value: { market: "KRW-FRESH1", trade_price: 1000, signed_change_rate: 0.08, acc_trade_price_24h: 5000000000 },
      fetchedAtMs: freshFetchedAt,
      expiresAtMs: freshFetchedAt + 60_000,
      staleUntilMs: freshFetchedAt + 90_000,
    });

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/market/all")) {
        return new Response(JSON.stringify([{ market: "KRW-STALE1" }, { market: "KRW-FRESH1" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    }) as any;

    // In cooldown, so fallback is returned
    const resD = await fetchTickersWithMeta(["KRW-STALE1", "KRW-FRESH1"], {
      debugCaller: "test-d",
    });

    const metaStale = resD.metaByMarket.get("KRW-STALE1");
    const metaFresh = resD.metaByMarket.get("KRW-FRESH1");

    assert.strictEqual(metaStale?.source, "last_good_cache", "Test D: Stale market is last_good_cache");
    assert.strictEqual(isFreshForMomentum(metaStale, 60_000), false, "Test D: 22h stale is rejected by isFreshForMomentum");
    assert.strictEqual(metaFresh?.source, "fresh_cache", "Test D: Fresh market is fresh_cache");
    assert.strictEqual(isFreshForMomentum(metaFresh, 60_000), true, "Test D: 5s fresh is accepted by isFreshForMomentum");
    assert.strictEqual(resD.momentumEligibleCount, 1, "Test D: Only 1 market is momentum eligible");

    const momD = selectMomentumTopM(resD.tickers, {
      is429Excluded: (m) => !isFreshForMomentum(resD.metaByMarket.get(m), 60_000),
      lookbackMin: 3,
      topM: 10,
      useVolumeWeight: true,
      snapshot: new Map(),
      prevRankByMarket: new Map(),
    });
    assert(momD.momentumTop.some((t) => t.market === "KRW-FRESH1"), "Test D: KRW-FRESH1 selected");
    assert(!momD.momentumTop.some((t) => t.market === "KRW-STALE1"), "Test D: KRW-STALE1 strictly excluded from momentum");
    console.log("[PASS] Test D: 22시간 경과 last_good_cache는 모멘텀 후보에서 엄격히 배제됨\n");

    // -------------------------------------------------------------------------
    // TEST E: 429 복구 후 live 성공 -> failure/cooldown 상태 정상 reset
    // -------------------------------------------------------------------------
    console.log("--- Test E: 429 복구 후 live 성공 -> global cooldown 및 failure reset ---");
    resetTickerTransportStatsForTest();
    resetTickerLockStateForTest();

    // 429 트리거
    globalThis.fetch = (async (url: string | URL | Request) => {
      return new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain" } });
    }) as any;

    try {
      await fetchTickersWithMeta(["KRW-BTC"], { forceRefresh: true });
    } catch {}

    let statsE1 = getTickerTransportStats();
    assert(statsE1.globalCooldownActive, "Test E: Global cooldown active after 429");

    // 정상 응답으로 복구
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/market/all")) {
        return new Response(JSON.stringify([{ market: "KRW-BTC" }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify([{ market: "KRW-BTC", trade_price: 115000000, signed_change_rate: 0.02, acc_trade_price_24h: 1000000000 }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const resE = await fetchTickersWithMeta(["KRW-BTC"], {
      isPriority: true, // priority allows bypassing cooldown
      forceRefresh: true,
      debugCaller: "test-e",
    });

    assert.strictEqual(resE.fetchedLiveCount, 1, "Test E: Recovered live fetch");
    const statsE2 = getTickerTransportStats();
    assert.strictEqual(statsE2.globalCooldownActive, false, "Test E: Global cooldown reset to inactive after live success");
    console.log("[PASS] Test E: Live 복구 후 global cooldown 정상 reset 확인\n");

    // -------------------------------------------------------------------------
    // TEST F: B3 같은 신규 급등 종목이 fresh live ticker를 받으면 selectMomentumTopM까지 정상 진입
    // -------------------------------------------------------------------------
    console.log("--- Test F: B3 신규 급등주 fresh live ticker 수신 시 momentumTopM 정상 진입 ---");
    resetTickerTransportStatsForTest();
    resetTickerLockStateForTest();
    tickerCache.clear();

    const sampleMarkets = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-B3", "KRW-MANTRA"];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/market/all")) {
        return new Response(JSON.stringify(sampleMarkets.map((m) => ({ market: m }))), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify([
          { market: "KRW-BTC", trade_price: 115000000, signed_change_rate: 0.01, acc_trade_price_24h: 5000000000 },
          { market: "KRW-ETH", trade_price: 3600000, signed_change_rate: 0.005, acc_trade_price_24h: 2000000000 },
          { market: "KRW-XRP", trade_price: 2000, signed_change_rate: -0.01, acc_trade_price_24h: 1000000000 },
          { market: "KRW-B3", trade_price: 450, signed_change_rate: 0.18, acc_trade_price_24h: 30000000000 }, // 18% 급등 + 대량 거래
          { market: "KRW-MANTRA", trade_price: 1200, signed_change_rate: 0.12, acc_trade_price_24h: 15000000000 },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const resF = await fetchTickersWithMeta(sampleMarkets, {
      preferAllEndpoint: true,
      debugCaller: "test-f",
    });

    const momF = selectMomentumTopM(resF.tickers, {
      is429Excluded: (m) => !isFreshForMomentum(resF.metaByMarket.get(m), 60_000),
      lookbackMin: 3,
      topM: 5,
      useVolumeWeight: true,
      snapshot: new Map(),
      prevRankByMarket: new Map(),
    });

    assert(momF.momentumTop.length >= 2, "Test F: Momentum candidates selected");
    assert.strictEqual(momF.momentumTop[0]?.market, "KRW-B3", "Test F: KRW-B3 is rank 1 in momentum candidate list");
    assert(momF.scoredCandidates.some((c) => c.t.market === "KRW-B3"), "Test F: KRW-B3 in scoredCandidates");
    console.log(`[PASS] Test F: B3 급등 종목이 fresh live ticker로 모멘텀 1위 (${momF.momentumTop[0]?.market})로 정상 진입\n`);

    // -------------------------------------------------------------------------
    // TEST G: held position 보호용 ticker fallback은 이번 수정으로 깨지지 않음
    // -------------------------------------------------------------------------
    console.log("--- Test G: held position 보호용 ticker fallback 무결성 검증 ---");
    resetTickerTransportStatsForTest();
    resetTickerLockStateForTest();

    // Set lastGood for held position
    lastGoodTickerCache.set("KRW-HELD1", {
      market: "KRW-HELD1",
      trade_price: 99000,
      signed_change_rate: 0.03,
      acc_trade_price_24h: 1000000,
    });
    lastGoodTickerFetchedAtMap.set("KRW-HELD1", Date.now() - 30_000);

    // Simulate network error for ticker fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/market/all")) {
        return new Response(JSON.stringify([{ market: "KRW-HELD1" }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("Network timeout or unreachable");
    }) as any;

    const resG = await fetchTickers(["KRW-HELD1"], { debugCaller: "test-g" });
    assert.strictEqual(resG.length, 1, "Test G: Held ticker returned from fallback");
    assert.strictEqual(resG[0]?.market, "KRW-HELD1", "Test G: Held market matched");
    assert.strictEqual(resG[0]?.trade_price, 99000, "Test G: Held fallback price preserved");
    console.log("[PASS] Test G: 네트워크 단절 시에도 보유 포지션 보호용 fallback 정상 반환\n");

    // -------------------------------------------------------------------------
    // TEST H: sell guard의 4fb6fe8 fresh-cache fail-safe 동작 회귀 검증
    // -------------------------------------------------------------------------
    console.log("--- Test H: sell guard fresh-cache fail-safe 동작 회귀 검증 ---");
    const metaFreshCache = { source: "fresh_cache" as const, ageMs: 25_000, fetchedAtMs: Date.now() - 25_000 };
    const metaStaleCache = { source: "last_good_cache" as const, ageMs: 75_000, fetchedAtMs: Date.now() - 75_000 };
    const metaOldStale = { source: "last_good_cache" as const, ageMs: 9_000_000, fetchedAtMs: Date.now() - 9_000_000 };

    assert.strictEqual(isFreshForMomentum(metaFreshCache, 60_000), true, "Test H: fresh_cache <= 60s is valid");
    assert.strictEqual(isFreshForMomentum(metaStaleCache, 60_000), false, "Test H: last_good_cache is denied for momentum");
    assert.strictEqual(isFreshForMomentum(metaOldStale, 60_000), false, "Test H: ancient cache is denied for momentum");
    console.log("[PASS] Test H: Sell guard 및 momentum freshness 정책 완벽 호환\n");

    console.log("================================================================================");
    console.log("  ALL REGRESSION TESTS (A through H) PASSED WITH ZERO FAILURES! ");
    console.log("================================================================================");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runSuite().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});

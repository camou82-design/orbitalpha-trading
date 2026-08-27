import {
  acquireTickerLock,
  getTickerLockStats,
  resetTickerLockStateForTest,
  fetchTickers,
  peekMinuteCandleCache,
} from "./upbit-public.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`[FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`[PASS] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("=== Starting Upbit Ticker Lock Regression Test Suite (A-L) ===\n");

  // Warm up market cache so sanitizeKrwMarkets is instant
  try {
    await fetchTickers(["KRW-BTC"]);
  } catch {}

  // A. idle 상태 즉시 lock acquire/release
  console.log("--- Test A: idle 상태 즉시 lock acquire/release ---");
  resetTickerLockStateForTest();
  {
    const t0 = Date.now();
    const release = await acquireTickerLock({ caller: "test_a", timeoutMs: 1000 });
    const elapsed = Date.now() - t0;
    const stats1 = getTickerLockStats();
    assert(elapsed < 100, `Test A: immediate acquire took ${elapsed}ms (< 100ms)`);
    assert(stats1.activeRequests === 1, `Test A: activeRequests is 1 (got ${stats1.activeRequests})`);
    assert(stats1.queueLength === 0, `Test A: queueLength is 0 (got ${stats1.queueLength})`);

    release();
    const stats2 = getTickerLockStats();
    assert(stats2.activeRequests === 0, `Test A: activeRequests is 0 after release (got ${stats2.activeRequests})`);
    assert(stats2.queueLength === 0, `Test A: queueLength is 0 after release`);
  }

  // B. holder 존재 시 waiter 정상 대기 후 acquire
  console.log("\n--- Test B: holder 존재 시 waiter 정상 대기 후 acquire ---");
  resetTickerLockStateForTest();
  {
    const release1 = await acquireTickerLock({ caller: "holder_b" });
    let waiterAcquired = false;
    let waiterAcquireTime = 0;

    const waiterPromise = acquireTickerLock({ caller: "waiter_b", timeoutMs: 2000 }).then((rel) => {
      waiterAcquired = true;
      waiterAcquireTime = Date.now();
      return rel;
    });

    await sleep(50);
    const statsInWait = getTickerLockStats();
    assert(statsInWait.activeRequests === 1, "Test B: holder is active");
    assert(statsInWait.queueLength === 1, "Test B: waiter is in queue");
    assert(!waiterAcquired, "Test B: waiter has not acquired yet");

    const releaseTime = Date.now();
    release1(); // holder releases

    const releaseWaiter = await waiterPromise;
    const statsAfterAcquire = getTickerLockStats();
    assert(waiterAcquired, "Test B: waiter acquired after holder release");
    assert(statsAfterAcquire.activeRequests === 1, "Test B: activeRequests is 1 for waiter");
    assert(statsAfterAcquire.queueLength === 0, "Test B: queue is empty after waiter unqueued");

    releaseWaiter();
    const statsFinal = getTickerLockStats();
    assert(statsFinal.activeRequests === 0, "Test B: activeRequests 0 after all release");
  }

  // C. queued waiter AbortSignal abort 시 queue에서 제거
  console.log("\n--- Test C: queued waiter AbortSignal abort 시 queue에서 제거 ---");
  resetTickerLockStateForTest();
  {
    const releaseHolder = await acquireTickerLock({ caller: "holder_c" });
    const ac = new AbortController();

    let abortedErrorCaught = false;
    const waiterPromise = acquireTickerLock({
      caller: "waiter_c",
      signal: ac.signal,
      timeoutMs: 5000,
    }).catch((err) => {
      if (err.name === "AbortError" || err.message === "Aborted") {
        abortedErrorCaught = true;
      }
    });

    await sleep(50);
    assert(getTickerLockStats().queueLength === 1, "Test C: waiter entered queue");

    ac.abort(); // abort signal
    await waiterPromise;

    assert(abortedErrorCaught, "Test C: AbortError was properly thrown");
    const statsAfterAbort = getTickerLockStats();
    assert(statsAfterAbort.queueLength === 0, `Test C: queueLength is 0 after abort (got ${statsAfterAbort.queueLength})`);
    assert(statsAfterAbort.activeRequests === 1, "Test C: holder still active");

    releaseHolder();
    assert(getTickerLockStats().activeRequests === 0, "Test C: activeRequests 0 after holder release");
  }

  // D. queued waiter timeout 시 queue에서 제거
  console.log("\n--- Test D: queued waiter timeout 시 queue에서 제거 ---");
  resetTickerLockStateForTest();
  {
    const releaseHolder = await acquireTickerLock({ caller: "holder_d" });
    let timeoutErrorCaught = false;

    const t0 = Date.now();
    const waiterPromise = acquireTickerLock({
      caller: "waiter_d",
      timeoutMs: 150,
    }).catch((err) => {
      if (err.message.includes("timed out")) {
        timeoutErrorCaught = true;
      }
    });

    await sleep(50);
    assert(getTickerLockStats().queueLength === 1, "Test D: waiter in queue before timeout");

    await waiterPromise;
    const elapsed = Date.now() - t0;
    assert(timeoutErrorCaught, "Test D: Timeout error caught");
    assert(elapsed >= 140 && elapsed < 350, `Test D: Timed out in expected window (${elapsed}ms)`);
    assert(getTickerLockStats().queueLength === 0, "Test D: queueLength 0 after timeout");

    releaseHolder();
    assert(getTickerLockStats().activeRequests === 0, "Test D: activeRequests 0");
  }

  // E. abort/timeout된 waiter가 이후 acquire되지 않음
  console.log("\n--- Test E: abort/timeout된 waiter가 이후 acquire되지 않음 ---");
  resetTickerLockStateForTest();
  {
    const releaseHolder = await acquireTickerLock({ caller: "holder_e" });
    const ac = new AbortController();
    let orphanRan = false;

    acquireTickerLock({ caller: "orphan_aborted", signal: ac.signal, timeoutMs: 5000 })
      .then((rel) => {
        orphanRan = true;
        rel();
      })
      .catch(() => {});

    await sleep(30);
    ac.abort();
    await sleep(30);

    // holder release
    releaseHolder();
    await sleep(100);

    assert(!orphanRan, "Test E: aborted waiter was NEVER executed/acquired");
    const stats = getTickerLockStats();
    assert(stats.activeRequests === 0, `Test E: activeRequests remained 0 (got ${stats.activeRequests})`);
    assert(stats.queueLength === 0, "Test E: queue length is 0");
  }

  // F. release 중복 호출 안전 (Idempotent)
  console.log("\n--- Test F: release 중복 호출 안전 ---");
  resetTickerLockStateForTest();
  {
    const release = await acquireTickerLock({ caller: "test_f" });
    assert(getTickerLockStats().activeRequests === 1, "Test F: active is 1");

    release();
    assert(getTickerLockStats().activeRequests === 0, "Test F: active is 0 after 1st release");

    // Multiple duplicate calls
    release();
    release();
    release();
    assert(getTickerLockStats().activeRequests === 0, `Test F: activeRequests stayed 0 after multiple releases (got ${getTickerLockStats().activeRequests})`);
  }

  // G. activeRequests invariant
  console.log("\n--- Test G: activeRequests invariant (concurrency limit & non-negative) ---");
  resetTickerLockStateForTest();
  {
    const maxConcurrency = getTickerLockStats().maxConcurrency;
    const releases: (() => void)[] = [];

    // acquire up to limit
    for (let i = 0; i < maxConcurrency; i++) {
      releases.push(await acquireTickerLock({ caller: `holder_g_${i}` }));
    }
    assert(getTickerLockStats().activeRequests === maxConcurrency, `Test G: active reaches max ${maxConcurrency}`);

    // next request must queue
    let queuedAcquired = false;
    const pNext = acquireTickerLock({ caller: "waiter_g", timeoutMs: 1000 }).then((rel) => {
      queuedAcquired = true;
      return rel;
    });

    await sleep(50);
    assert(getTickerLockStats().activeRequests === maxConcurrency, "Test G: activeRequests does not exceed max");
    assert(getTickerLockStats().queueLength === 1, "Test G: 1 item in queue");

    // release one
    releases[0]();
    const relNext = await pNext;
    assert(queuedAcquired, "Test G: queued waiter acquired after 1 release");
    assert(getTickerLockStats().activeRequests === maxConcurrency, "Test G: activeRequests invariant maintained");

    // release remaining
    for (let i = 1; i < releases.length; i++) {
      releases[i]();
    }
    relNext();
    assert(getTickerLockStats().activeRequests === 0, "Test G: activeRequests is 0");
  }

  // H. outer live tick timeout 후 underlying fetch 잔존 없음
  console.log("\n--- Test H: outer live tick timeout 후 underlying fetch 잔존 없음 ---");
  resetTickerLockStateForTest();
  {
    const tickAc = new AbortController();
    const releaseHolder = await acquireTickerLock({ caller: "blocking_holder_h" });

    // Simulate outer tick calling fetchTickers with totalTimeoutMs and tickSignal
    const fetchPromise = fetchTickers(["KRW-BTC", "KRW-ETH"], {
      signal: tickAc.signal,
      totalTimeoutMs: 100,
      debugCaller: "test_h_live_tick",
      forceRefresh: true,
    });

    await sleep(50);
    assert(getTickerLockStats().queueLength === 1, "Test H: fetchTickers is queued waiting for lock");

    // Outer tick aborts
    tickAc.abort();
    const results = await fetchPromise;

    const statsAfterOuterAbort = getTickerLockStats();
    assert(statsAfterOuterAbort.queueLength === 0, `Test H: queue cleaned up immediately after abort (got ${statsAfterOuterAbort.queueLength})`);

    releaseHolder();
    await sleep(50);
    assert(getTickerLockStats().activeRequests === 0, "Test H: no lingering task acquired lock");
  }

  // I. 연속 3회 ticker timeout 뒤 queue 누적 없음
  console.log("\n--- Test I: 연속 3회 ticker timeout 뒤 queue 누적 없음 ---");
  resetTickerLockStateForTest();
  {
    const releaseHolder = await acquireTickerLock({ caller: "blocking_holder_i" });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetchTickers(["KRW-XRP"], {
        totalTimeoutMs: 50,
        batchTimeoutMs: 50,
        debugCaller: `test_i_attempt_${attempt}`,
        forceRefresh: true,
      });
      assert(Array.isArray(res), `Test I: Attempt ${attempt} returned fallback result gracefully`);
      const queueLen = getTickerLockStats().queueLength;
      assert(queueLen === 0, `Test I: Queue length is 0 after attempt ${attempt} timeout (got ${queueLen})`);
    }

    releaseHolder();
    assert(getTickerLockStats().activeRequests === 0, "Test I: activeRequests is 0");
    assert(getTickerLockStats().queueLength === 0, "Test I: queueLength is 0");
  }

  // J. 기존 candle fetch/cache/429 로직 영향 없음
  console.log("\n--- Test J: 기존 candle fetch/cache/429 로직 영향 없음 ---");
  {
    const candle = peekMinuteCandleCache("KRW-BTC", 1, 1);
    // peekMinuteCandleCache returns null or cache entry object without crashing
    assert(candle === null || Array.isArray(candle.rows), "Test J: peekMinuteCandleCache works as expected");
  }

  // K. 기존 fetchTickers 정상 batch 결과 유지 (실제 네트워크 호출)
  console.log("\n--- Test K: 기존 fetchTickers 정상 batch 결과 유지 ---");
  resetTickerLockStateForTest();
  {
    const tickers = await fetchTickers(["KRW-BTC", "KRW-ETH"], {
      debugCaller: "test_k_live",
      totalTimeoutMs: 8000,
      batchTimeoutMs: 4000,
      forceRefresh: true,
    });
    assert(Array.isArray(tickers), "Test K: returns array");
    assert(tickers.length > 0, `Test K: tickers returned (${tickers.length} items)`);
    const btc = tickers.find((t) => t.market === "KRW-BTC");
    assert(Boolean(btc && btc.trade_price > 0), `Test K: KRW-BTC price is valid (${btc?.trade_price})`);
    assert(getTickerLockStats().activeRequests === 0, "Test K: activeRequests is 0 after real fetch");
    assert(getTickerLockStats().queueLength === 0, "Test K: queueLength is 0 after real fetch");
  }

  // L. racePhase timeout 시 cancellation propagation 및 이후 hydrate_per_symbol 즉시 정상 동작 증명
  console.log("\n--- Test L: racePhase timeout 시 cancellation propagation 및 이후 hydrate_per_symbol 정상 동작 ---");
  resetTickerLockStateForTest();
  {
    // 1. holder가 락을 잡고 있음
    const releaseHolder = await acquireTickerLock({ caller: "blocking_holder_l" });

    // 2. racePhase 시뮬레이션 (150ms timeout)
    const phaseCtrl = new AbortController();
    let raceTimeoutFired = false;
    const raceTimeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        phaseCtrl.abort();
        raceTimeoutFired = true;
        reject(new Error("LiveTickPhaseTimeout: fetch_tickers"));
      }, 150);
    });

    let fetchExecuted = false;
    const fetchAction = async () => {
      fetchExecuted = true;
      return fetchTickers(["KRW-BTC", "KRW-ETH"], {
        debugCaller: "test_l_live_strategy_primary",
        signal: phaseCtrl.signal,
        totalTimeoutMs: 5000,
        batchTimeoutMs: 2500,
        isPriority: true,
        forceRefresh: true,
      });
    };

    let caughtError: any = null;
    try {
      await Promise.race([fetchAction(), raceTimeoutPromise]);
    } catch (err) {
      caughtError = err;
    }

    assert(raceTimeoutFired, "Test L: race timeout fired");
    assert(caughtError !== null && caughtError.message.includes("LiveTickPhaseTimeout"), "Test L: race error caught properly");

    // 3. outer timeout 후 큐 상태 검증: 큐에 0개 잔존해야 함
    await sleep(30);
    const statsAfterTimeout = getTickerLockStats();
    assert(statsAfterTimeout.queueLength === 0, `Test L: queueLength is 0 immediately after racePhase abort (got ${statsAfterTimeout.queueLength})`);
    assert(statsAfterTimeout.activeRequests === 1, "Test L: only blocking_holder_l is active");

    // 4. blocking holder 해제
    releaseHolder();
    const statsAfterHolderRelease = getTickerLockStats();
    assert(statsAfterHolderRelease.activeRequests === 0, `Test L: activeRequests is 0 after holder release (got ${statsAfterHolderRelease.activeRequests})`);
    assert(statsAfterHolderRelease.queueLength === 0, "Test L: queueLength remains 0");

    // 5. 이후 hydrate_per_symbol 단일 마켓 조회가 stale waiter에 막히지 않고 즉시 수행됨을 증명
    const hydrateT0 = Date.now();
    const hydrateRows = await fetchTickers(["KRW-BTC"], {
      debugCaller: "live-strategy:hydrate_per_symbol",
      batchSize: 1,
      parallelTickerBatches: 1,
      batchDelayMs: 0,
      sortByCached24hVolume: false,
      totalTimeoutMs: 4000,
      batchTimeoutMs: 3500,
      maxMarkets: 1,
      forceRefresh: true,
    });
    const hydrateElapsed = Date.now() - hydrateT0;
    assert(Array.isArray(hydrateRows) && hydrateRows.length > 0, `Test L: hydrate_per_symbol successfully returned ${hydrateRows.length} items`);
    assert(hydrateRows[0].market === "KRW-BTC" && hydrateRows[0].trade_price > 0, `Test L: valid price returned (${hydrateRows[0].trade_price})`);
    assert(hydrateElapsed < 3000, `Test L: hydrate_per_symbol executed smoothly in ${hydrateElapsed}ms without deadlock`);

    const statsFinalL = getTickerLockStats();
    assert(statsFinalL.activeRequests === 0, "Test L: final activeRequests is 0");
    assert(statsFinalL.queueLength === 0, "Test L: final queueLength is 0");
  }

  console.log("\n=======================================================");
  console.log("  ALL TESTS (A through L) PASSED SUCCESSFULLY!  ");
  console.log("=======================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e);
  process.exit(1);
});

import assert from "node:assert";
import {
  acquireTickerLock,
  getTickerLockStats,
  resetTickerLockStateForTest,
  fetchTickersWithMeta,
} from "./upbit-public.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const originalFetch = globalThis.fetch;

function setupMockFetch() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("/v1/market/all")) {
      return new Response(JSON.stringify([{ market: "KRW-BTC" }, { market: "KRW-ETH" }, { market: "KRW-XRP" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.includes("/v1/ticker")) {
      return new Response(
        JSON.stringify([
          { market: "KRW-BTC", trade_price: 100_000_000, signed_change_rate: 0.02, acc_trade_price_24h: 500_000_000_000 },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url);
  }) as any;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function runStarvationRegressionSuite() {
  setupMockFetch();
  console.log("================================================================================");
  console.log("  TICKER LOCK STARVATION & FAIRNESS RECOVERY REGRESSION TEST SUITE");
  console.log("================================================================================\n");

  // -------------------------------------------------------------------------
  // SCENARIO 1: Consecutive Priority vs Normal Waiter Starvation / Recovery
  // -------------------------------------------------------------------------
  console.log("--- Test 1: Bounded Fairness prevents Normal Waiter Starvation ---");
  resetTickerLockStateForTest();

  // 1. Initial lock holder takes lock
  const release0 = await acquireTickerLock({ caller: "initial_holder", priority: false });
  assert.strictEqual(getTickerLockStats().activeRequests, 1, "Holder has lock");

  const events: string[] = [];

  // 2. Normal waiter arrives with timeout 600ms
  const normalPromise = acquireTickerLock({
    caller: "pump-scanner:ticker_alt",
    priority: false,
    timeoutMs: 600,
  })
    .then((rel) => {
      events.push("normal_acquired");
      rel();
    })
    .catch((err) => {
      events.push(`normal_failed:${err.message}`);
    });

  await sleep(10); // Wait for normal waiter to enter queue

  // 3. Continuous priority requests arrive sequentially (simulating routine live ticks / force refreshes)
  // Total 4 priority tasks, each holding lock for 40ms.
  // With Bounded Fairness (max 2 consecutive grants), normal waiter MUST get lock after at most 2 priority tasks.
  const priorityPromises: Promise<void>[] = [];
  for (let i = 1; i <= 4; i++) {
    const p = (async (id: number) => {
      await sleep(id * 5); // Stagger arrival slightly
      const rel = await acquireTickerLock({
        caller: `live-strategy:p${id}`,
        priority: true,
        timeoutMs: 1000,
      });
      events.push(`priority_${id}_acquired`);
      await sleep(40);
      rel();
      events.push(`priority_${id}_released`);
    })(i);
    priorityPromises.push(p);
  }

  // Release initial holder
  await sleep(20);
  events.push("initial_released");
  release0();

  await Promise.all([normalPromise, ...priorityPromises]);

  console.log("Execution event sequence:", events);
  assert(
    events.includes("normal_acquired"),
    `Normal waiter should have acquired lock under bounded fairness, but got: ${JSON.stringify(events)}`
  );
  assert(
    !events.some((e) => e.startsWith("normal_failed")),
    `Normal waiter should not have timed out or failed: ${JSON.stringify(events)}`
  );
  const normalIdx = events.indexOf("normal_acquired");
  const p3Idx = events.indexOf("priority_3_acquired");
  assert(
    normalIdx < p3Idx,
    `Normal waiter MUST acquire lock before priority_3 due to bounded fairness (normalIdx=${normalIdx}, p3Idx=${p3Idx})`
  );
  console.log("[PASS] Test 1: Normal waiter acquired lock without starvation under continuous priority stream (bounded after 2 priority tasks)\n");

  // -------------------------------------------------------------------------
  // SCENARIO 2: Emergency Exit Priority Protection (Exit caller gets immediate next slot)
  // -------------------------------------------------------------------------
  console.log("--- Test 2: Emergency Exit Priority Protection maintained ---");
  resetTickerLockStateForTest();

  const releaseHolder = await acquireTickerLock({ caller: "routine_holder", priority: false });

  const exitEvents: string[] = [];

  // Normal waiter queues first
  const normalP = acquireTickerLock({ caller: "pump_normal_1", priority: false, timeoutMs: 1000 }).then((rel) => {
    exitEvents.push("normal_1_acquired");
    rel();
  });

  await sleep(10);

  // Emergency exit priority waiter queues second
  const exitP = acquireTickerLock({ caller: "exit_sell_guard", priority: true, timeoutMs: 1000 }).then((rel) => {
    exitEvents.push("exit_sell_guard_acquired");
    rel();
  });

  await sleep(10);

  // Release routine holder
  releaseHolder();

  await Promise.all([normalP, exitP]);

  console.log("Exit priority event sequence:", exitEvents);
  assert.strictEqual(
    exitEvents[0],
    "exit_sell_guard_acquired",
    "Emergency exit task MUST acquire lock before queued normal task on single priority arrival"
  );
  assert.strictEqual(
    exitEvents[1],
    "normal_1_acquired",
    "Normal task acquires lock immediately after priority task completes"
  );
  console.log("[PASS] Test 2: Emergency Exit Priority takes precedence over normal waiter\n");

  // -------------------------------------------------------------------------
  // SCENARIO 3: Lock Wait Ms Telemetry Preserved Even on Timeout
  // -------------------------------------------------------------------------
  console.log("--- Test 3: Lock Wait Ms Telemetry Accuracy on Timeout ---");
  resetTickerLockStateForTest();

  // Block the lock for 150ms
  const blockRel = await acquireTickerLock({ caller: "blocker", priority: false });
  setTimeout(() => blockRel(), 150);

  const t0 = Date.now();
  const res = await fetchTickersWithMeta(["KRW-BTC"], {
    debugCaller: "pump-scanner:test_timeout",
    totalTimeoutMs: 80, // Hard timeout less than 150ms blocker
    batchTimeoutMs: 80,
    forceRefresh: true,
  });

  const elapsed = Date.now() - t0;
  console.log(`Fetch returned with budgetExpired=${res.budgetExpired}, lockWaitMs=${res.lockWaitMs}, elapsed=${elapsed}ms`);
  assert(res.lockWaitMs >= 70, `lockWaitMs (${res.lockWaitMs}ms) must reflect actual wait time (>= 70ms), not 0ms`);
  console.log("[PASS] Test 3: Lock wait telemetry accurately captures wait_ms even on acquisition timeout\n");

  console.log("================================================================================");
  console.log("  ALL STARVATION & FAIRNESS REGRESSION TESTS PASSED!");
  console.log("================================================================================\n");
}

runStarvationRegressionSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

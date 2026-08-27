import { evaluateHourlyEntryLimit } from "./live-strategy.js";
import { evaluateHourlyEntryLimit as evaluatePaperHourlyLimit } from "./paper-trading.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`[FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`[PASS] ${msg}`);
}

async function runTests() {
  console.log("=== Starting Hourly Entry Limiter Deduplication Regression Tests (A-P) ===\n");

  const now = Date.parse("2026-08-27T10:00:00.000Z");
  const SECOND_MS = 1000;
  const MINUTE_MS = 60 * 1000;

  // A. history BUY 1 + 같은 open position 1 (동일 진입, 시간차 47ms) -> unique count 1, limit OFF
  console.log("--- Test A: history BUY 1 + 같은 open position 1 -> unique count 1, limit OFF ---");
  {
    const tradeTs = new Date(now - 10 * MINUTE_MS).toISOString();
    const posTs = new Date(now - 10 * MINUTE_MS - 47).toISOString(); // 47ms 차이

    const trades = [
      { market: "KRW-BTC", action: "buy", timestamp: tradeTs, order_krw: 100000, filled_qty: 0.001 },
    ];
    const positions = {
      "KRW-BTC": { market: "KRW-BTC", entry_ts: posTs, order_krw: 100000, qty: 0.001 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 1, `Test A: totalUnique1hEntries must be 1 (got ${res.totalUnique1hEntries})`);
    assert(res.active === false, "Test A: limit must be OFF (active === false)");
    assert(res.reason === null, "Test A: reason must be null");
    assert(res.meta.deduped_overlap_count === 1, `Test A: deduped overlap count must be 1 (got ${res.meta.deduped_overlap_count})`);
    assert(res.meta.recovered_open_only_count === 0, "Test A: recovered open only must be 0");
  }

  // B. history BUY 2 + 동일 open positions 2 -> unique count 2, limit ON
  console.log("\n--- Test B: history BUY 2 + 동일 open positions 2 -> unique count 2, limit ON ---");
  {
    const ts1 = new Date(now - 20 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 10 * MINUTE_MS).toISOString();

    const trades = [
      { market: "KRW-BTC", action: "buy", timestamp: ts1, order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-ETH", action: "buy", timestamp: ts2, order_krw: 100000, filled_qty: 0.03 },
    ];
    const positions = {
      "KRW-BTC": { market: "KRW-BTC", entry_ts: ts1, order_krw: 100000, qty: 0.001 },
      "KRW-ETH": { market: "KRW-ETH", entry_ts: ts2, order_krw: 100000, qty: 0.03 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test B: totalUnique1hEntries must be 2 (got ${res.totalUnique1hEntries})`);
    assert(res.active === true, "Test B: limit must be ON (active === true)");
    assert(res.meta.deduped_overlap_count === 2, "Test B: deduped overlap count is 2");
    assert(res.meta.recovered_open_only_count === 0, "Test B: recovered open only is 0");
  }

  // C. history BUY 1 + 별도 open position 1 (서로 다른 코인) -> unique count 2, limit ON
  console.log("\n--- Test C: history BUY 1 (BTC) + 별도 open position 1 (ETH) -> unique count 2, limit ON ---");
  {
    const ts1 = new Date(now - 20 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 10 * MINUTE_MS).toISOString();

    const trades = [
      { market: "KRW-BTC", action: "buy", timestamp: ts1, order_krw: 100000, filled_qty: 0.001 },
    ];
    const positions = {
      "KRW-ETH": { market: "KRW-ETH", entry_ts: ts2, order_krw: 100000, qty: 0.03 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test C: totalUnique1hEntries must be 2 (got ${res.totalUnique1hEntries})`);
    assert(res.active === true, "Test C: limit must be ON for 2 distinct entries");
    assert(res.meta.history_buy_1h_count === 1, "Test C: history buy count is 1");
    assert(res.meta.recovered_open_only_count === 1, "Test C: recovered open count is 1");
    assert(res.meta.deduped_overlap_count === 0, "Test C: deduped overlap count is 0");
  }

  // D. history BUY 0 + recovered open position 1 -> count 1, limit OFF
  console.log("\n--- Test D: history BUY 0 + recovered open position 1 -> count 1, limit OFF ---");
  {
    const ts = new Date(now - 15 * MINUTE_MS).toISOString();
    const trades: any[] = [];
    const positions = {
      "KRW-SOL": { market: "KRW-SOL", entry_ts: ts, order_krw: 100000, qty: 0.5 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 1, `Test D: count is 1 (got ${res.totalUnique1hEntries})`);
    assert(res.active === false, "Test D: limit is OFF for 1 recovered position");
    assert(res.meta.recovered_open_only_count === 1, "Test D: recovered open count is 1");
  }

  // E. history BUY 0 + recovered open positions 2 -> count 2, limit ON
  console.log("\n--- Test E: history BUY 0 + recovered open positions 2 -> count 2, limit ON ---");
  {
    const ts1 = new Date(now - 25 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 15 * MINUTE_MS).toISOString();
    const trades: any[] = [];
    const positions = {
      "KRW-SOL": { market: "KRW-SOL", entry_ts: ts1, order_krw: 100000, qty: 0.5 },
      "KRW-DOGE": { market: "KRW-DOGE", entry_ts: ts2, order_krw: 100000, qty: 500 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test E: count is 2 (got ${res.totalUnique1hEntries})`);
    assert(res.active === true, "Test E: limit is ON for 2 recovered positions");
    assert(res.meta.recovered_open_only_count === 2, "Test E: recovered count is 2");
  }

  // F. 1시간 초과 old BUY -> 제외
  console.log("\n--- Test F: 1시간 초과 old BUY -> 제외 ---");
  {
    const oldTs = new Date(now - 70 * MINUTE_MS).toISOString();
    const trades = [
      { market: "KRW-BTC", action: "buy", timestamp: oldTs, order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-ETH", action: "buy", timestamp: oldTs, order_krw: 100000, filled_qty: 0.03 },
    ];
    const positions = {};

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 0, `Test F: old buys excluded, count 0 (got ${res.totalUnique1hEntries})`);
    assert(res.active === false, "Test F: limit is OFF");
  }

  // G. 1시간 초과 old open position -> 제외
  console.log("\n--- Test G: 1시간 초과 old open position -> 제외 ---");
  {
    const oldTs = new Date(now - 80 * MINUTE_MS).toISOString();
    const trades: any[] = [];
    const positions = {
      "KRW-BTC": { market: "KRW-BTC", entry_ts: oldTs, order_krw: 100000, qty: 0.001 },
      "KRW-ETH": { market: "KRW-ETH", entry_ts: oldTs, order_krw: 100000, qty: 0.03 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 0, `Test G: old positions excluded, count 0 (got ${res.totalUnique1hEntries})`);
    assert(res.active === false, "Test G: limit is OFF");
  }

  // H. timestamp missing/invalid -> recent count 오염 없음
  console.log("\n--- Test H: timestamp missing/invalid -> recent count 오염 없음 ---");
  {
    const trades = [
      { market: "KRW-BTC", action: "buy", order_krw: 100000, filled_qty: 0.001 }, // missing
      { market: "KRW-ETH", action: "buy", timestamp: "invalid-date", order_krw: 100000, filled_qty: 0.03 },
    ];
    const positions = {
      "KRW-SOL": { market: "KRW-SOL", entry_ts: "", order_krw: 100000, qty: 0.5 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 0, "Test H: count must be 0 for invalid/missing timestamps");
    assert(res.active === false, "Test H: limit is OFF");
    assert(res.meta.invalid_timestamp_count === 3, `Test H: invalid count is 3 (got ${res.meta.invalid_timestamp_count})`);
  }

  // I. future timestamp -> recent count 오염 없음
  console.log("\n--- Test I: future timestamp -> recent count 오염 없음 ---");
  {
    const futureTs = new Date(now + 10 * MINUTE_MS).toISOString();
    const trades = [
      { market: "KRW-BTC", action: "buy", timestamp: futureTs, order_krw: 100000, filled_qty: 0.001 },
      { market: "KRW-ETH", action: "buy", timestamp: futureTs, order_krw: 100000, filled_qty: 0.03 },
    ];
    const positions = {
      "KRW-SOL": { market: "KRW-SOL", entry_ts: futureTs, order_krw: 100000, qty: 0.5 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 0, "Test I: future timestamps excluded");
    assert(res.active === false, "Test I: limit is OFF");
    assert(res.meta.invalid_timestamp_count === 3, "Test I: 3 future items marked invalid");
  }

  // J. 현재 실서버 XRP 실제 데이터 -> unique count 정확히 1
  console.log("\n--- Test J: 현재 실서버 XRP 실제 데이터 -> unique count 정확히 1, limit OFF ---");
  {
    const serverNow = Date.parse("2026-08-27T09:40:00.000Z");
    const xrpTrades = [
      {
        market: "KRW-XRP",
        action: "buy",
        timestamp: "2026-08-27T09:37:25.833Z",
        order_krw: 160261,
        filled_qty: 80.37161484,
      },
    ];
    const xrpPositions = {
      "KRW-XRP": {
        market: "KRW-XRP",
        entry_ts: "2026-08-27T09:37:25.786Z",
        order_krw: 160261,
        qty: 80.37161484,
      },
    };

    const res = evaluateHourlyEntryLimit(xrpTrades, xrpPositions, serverNow);
    assert(res.totalUnique1hEntries === 1, `Test J: Live XRP count must be EXACTLY 1 (got ${res.totalUnique1hEntries})`);
    assert(res.active === false, "Test J: limit must be OFF for single XRP entry");
    assert(res.reason === null, "Test J: reason must be null");
    assert(res.meta.deduped_overlap_count === 1, "Test J: deduped overlap count must be 1");
    assert(res.meta.history_buy_1h_count === 1, "Test J: history buy 1h count is 1");
    assert(res.meta.recovered_open_only_count === 0, "Test J: recovered count is 0");

    const paperRes = evaluatePaperHourlyLimit(
      [
        {
          market: "KRW-XRP",
          state: "OPEN",
          ts: "2026-08-27T09:37:25.833Z",
          order_krw: 160261,
          qty: 80.37161484,
        },
      ],
      xrpPositions,
      serverNow,
    );
    assert(paperRes.totalUnique1hEntries === 1, `Test J (Paper): count must be 1 (got ${paperRes.totalUnique1hEntries})`);
    assert(paperRes.active === false, "Test J (Paper): limit must be OFF");
  }

  // K. 같은 market, 10초 차이, 같은 order_krw지만 실제 서로 다른 두 진입 -> unique count 2 (False dedupe 방어)
  console.log("\n--- Test K: 같은 market, 10초 차이, 같은 order_krw (서로 다른 두 진입) -> unique count 2 ---");
  {
    const ts1 = new Date(now - 10 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 10 * MINUTE_MS - 10 * SECOND_MS).toISOString(); // 10초 차이 (> 5초)

    // history에 1건만 기록되고, 10초 전에 진입했던 open position이 남아있는 상황 (서로 다른 2회 진입)
    const trades = [
      { market: "KRW-BTC", action: "buy", timestamp: ts1, order_krw: 100000, filled_qty: 0.001 },
    ];
    const positions = {
      "KRW-BTC": { market: "KRW-BTC", entry_ts: ts2, order_krw: 100000, qty: 0.001 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test K: 10s difference must NOT be falsely merged into 1 (got ${res.totalUnique1hEntries})`);
    assert(res.active === true, "Test K: limit must be ON for 2 distinct entries");
    assert(res.meta.deduped_overlap_count === 0, "Test K: overlap must be 0");
    assert(res.meta.recovered_open_only_count === 1, "Test K: recovered open count is 1");
  }

  // L. 같은 market, 20초 차이, qty가 우연히 동일하지만 실제 서로 다른 두 진입 -> unique count 2
  console.log("\n--- Test L: 같은 market, 20초 차이, 동일 qty (서로 다른 두 진입) -> unique count 2 ---");
  {
    const ts1 = new Date(now - 5 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 5 * MINUTE_MS - 20 * SECOND_MS).toISOString(); // 20초 차이

    const trades = [
      { market: "KRW-ETH", action: "buy", timestamp: ts1, order_krw: 50000, filled_qty: 0.015 },
    ];
    const positions = {
      "KRW-ETH": { market: "KRW-ETH", entry_ts: ts2, order_krw: 50000, qty: 0.015 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test L: 20s difference must NOT be falsely deduped (got ${res.totalUnique1hEntries})`);
    assert(res.active === true, "Test L: limit ON for 2 distinct entries");
  }

  // M. 같은 market, 47ms 차이, order_krw/qty/entry identity 모두 일치 -> unique count 1 (정상 dedupe)
  console.log("\n--- Test M: 같은 market, 47ms 차이, 동일 주문 -> unique count 1 ---");
  {
    const ts1 = new Date(now - 8 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 8 * MINUTE_MS - 47).toISOString(); // 47ms

    const trades = [
      { market: "KRW-SOL", action: "buy", timestamp: ts1, order_krw: 200000, filled_qty: 1.25 },
    ];
    const positions = {
      "KRW-SOL": { market: "KRW-SOL", entry_ts: ts2, order_krw: 200000, qty: 1.25 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 1, `Test M: 47ms diff must be deduped to 1 (got ${res.totalUnique1hEntries})`);
    assert(res.active === false, "Test M: limit OFF");
    assert(res.meta.deduped_overlap_count === 1, "Test M: overlap count 1");
  }

  // N. 같은 market에서 history BUY 2건 + open position 1건 (open position이 1번째 BUY와만 일치) -> overlap 1, total unique 2
  console.log("\n--- Test N: history BUY 2건 + open position 1건 (1건만 일치) -> total unique 2 ---");
  {
    const ts1 = new Date(now - 20 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 5 * MINUTE_MS).toISOString();

    const trades = [
      { market: "KRW-DOGE", action: "buy", timestamp: ts1, order_krw: 100000, filled_qty: 500 }, // 1st BUY
      { market: "KRW-DOGE", action: "buy", timestamp: ts2, order_krw: 100000, filled_qty: 500 }, // 2nd BUY
    ];
    const positions = {
      "KRW-DOGE": { market: "KRW-DOGE", entry_ts: ts2, order_krw: 100000, qty: 500 }, // matches 2nd BUY only
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test N: totalUnique1hEntries must be 2 (got ${res.totalUnique1hEntries})`);
    assert(res.meta.deduped_overlap_count === 1, `Test N: deduped overlap count must be 1 (got ${res.meta.deduped_overlap_count})`);
    assert(res.meta.recovered_open_only_count === 0, "Test N: recovered open count is 0");
    assert(res.active === true, "Test N: limit ON");
  }

  // O. history BUY 2건 + open positions 2건 각각 정확히 1:1 대응 -> overlap 2, total unique 2 (절대 1이 아님)
  console.log("\n--- Test O: history BUY 2건 + open positions 2건 각각 1:1 대응 -> total unique 2 ---");
  {
    const ts1 = new Date(now - 25 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 10 * MINUTE_MS).toISOString();

    const trades = [
      { market: "KRW-BTC", action: "buy", timestamp: ts1, order_krw: 150000, filled_qty: 0.0015 },
      { market: "KRW-BTC", action: "buy", timestamp: ts2, order_krw: 150000, filled_qty: 0.0015 },
    ];
    const positions = {
      "pos-1": { market: "KRW-BTC", entry_ts: ts1, order_krw: 150000, qty: 0.0015 },
      "pos-2": { market: "KRW-BTC", entry_ts: ts2, order_krw: 150000, qty: 0.0015 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test O: totalUnique1hEntries must be exactly 2 (got ${res.totalUnique1hEntries})`);
    assert(res.meta.deduped_overlap_count === 2, `Test O: overlap count must be 2 (got ${res.meta.deduped_overlap_count})`);
    assert(res.meta.recovered_open_only_count === 0, "Test O: recovered count is 0");
    assert(res.active === true, "Test O: limit ON");
  }

  // P. position_id 명시적 ID가 있을 때 1:1 매칭 우선순위 검증
  console.log("\n--- Test P: position_id / order_id 명시적 ID 기반 1:1 매칭 검증 ---");
  {
    const ts1 = new Date(now - 15 * MINUTE_MS).toISOString();
    const ts2 = new Date(now - 15 * MINUTE_MS - 200).toISOString(); // 200ms 차이

    const trades = [
      { position_id: "pos-a", market: "KRW-XRP", action: "buy", timestamp: ts1, order_krw: 100000, filled_qty: 50 },
      { position_id: "pos-b", market: "KRW-XRP", action: "buy", timestamp: ts2, order_krw: 100000, filled_qty: 50 },
    ];
    const positions = {
      "p1": { position_id: "pos-b", market: "KRW-XRP", entry_ts: ts2, order_krw: 100000, qty: 50 },
      "p2": { position_id: "pos-a", market: "KRW-XRP", entry_ts: ts1, order_krw: 100000, qty: 50 },
    };

    const res = evaluateHourlyEntryLimit(trades, positions, now);
    assert(res.totalUnique1hEntries === 2, `Test P: 2 distinct positions with explicit IDs must be total 2 (got ${res.totalUnique1hEntries})`);
    assert(res.meta.deduped_overlap_count === 2, "Test P: overlap count is 2");
    assert(res.meta.recovered_open_only_count === 0, "Test P: recovered count is 0");
  }

  console.log("\n=======================================================");
  console.log("  ALL TESTS (A through P) PASSED SUCCESSFULLY!  ");
  console.log("=======================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e);
  process.exit(1);
});

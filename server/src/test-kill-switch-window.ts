import { evaluateGlobalKillSwitch } from "./live-strategy.js";
import { evaluateGlobalKillSwitch as evaluatePaperKillSwitch } from "./paper-trading.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`[FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`[PASS] ${msg}`);
}

async function runTests() {
  console.log("=== Starting Global Kill Switch Time-Bounded Window Regression Tests (A-P) ===\n");

  const now = Date.now(); // 기준 가상 now
  const DAY_MS = 24 * 3600 * 1000;
  const HOUR_MS = 3600 * 1000;

  // A. 20일 전 6건 (1승 5패, 승률 16.7%, 합산 -0.916%) -> kill switch OFF
  console.log("--- Test A: 20일 전 6건 historical trades (승률 16.7%) -> kill switch OFF ---");
  {
    const twentyDaysAgo = new Date(now - 20 * DAY_MS).toISOString();
    const staleTrades = [
      { market: "KRW-BTC", pnl_pct: -0.2, timestamp: twentyDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -0.15, timestamp: twentyDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: 0.3, timestamp: twentyDaysAgo, action: "sell", filled_qty: 1 }, // win
      { market: "KRW-SOL", pnl_pct: -0.25, timestamp: twentyDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.3, timestamp: twentyDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-ADA", pnl_pct: -0.316, timestamp: twentyDaysAgo, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(staleTrades, now);
    assert(res.active === false, "Test A: kill switch must be OFF for 20-day old trades");
    assert(res.reason === null, "Test A: reason must be null");
    assert(res.meta?.recent_window_count === 0, "Test A: recent window count must be 0");
    assert((res.meta?.latest_trade_age_hours as number) >= 480, "Test A: latest trade age is >= 480h");
  }

  // B. 최근 48시간 내 6건 (1승 5패, 승률 16.7%) -> kill switch ON
  console.log("\n--- Test B: 최근 48시간 내 6건 (승률 16.7%) -> kill switch ON ---");
  {
    const recentTime = new Date(now - 12 * HOUR_MS).toISOString();
    const recentLossTrades = [
      { market: "KRW-BTC", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -0.15, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: 0.3, timestamp: recentTime, action: "sell", filled_qty: 1 }, // win
      { market: "KRW-SOL", pnl_pct: -0.25, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.3, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ADA", pnl_pct: -0.316, timestamp: recentTime, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(recentLossTrades, now);
    assert(res.active === true, "Test B: kill switch must be ON for recent 48h low win rate");
    assert(String(res.reason).includes("Win rate under 20%"), `Test B: reason: ${res.reason}`);
    assert(res.meta?.recent_window_count === 6, "Test B: recent window count is 6");
  }

  // C. 최근 48시간 내 4건 (0승 4패, 표본 수 < 5, 누적 pnl > -5%) -> win-rate guard OFF
  console.log("\n--- Test C: 최근 48시간 내 4건 (표본 < 5) -> win-rate guard OFF ---");
  {
    const recentTime = new Date(now - 6 * HOUR_MS).toISOString();
    const fourLossTrades = [
      { market: "KRW-BTC", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(fourLossTrades, now);
    assert(res.active === false, "Test C: kill switch must be OFF when sample size < 5 and pnl > -5%");
  }

  // D. 최근 24시간 내 손실 5건 (2승 5패, 승률 28.6% >= 20%) -> ON
  console.log("\n--- Test D: 최근 24시간 내 손실 5건 (승률 28.6% >= 20%) -> ON ---");
  {
    const recent24hTime = new Date(now - 10 * HOUR_MS).toISOString();
    const fiveLossesWithWins24h = [
      { market: "KRW-BTC", pnl_pct: 0.5, timestamp: recent24hTime, action: "sell", filled_qty: 1 }, // win 1
      { market: "KRW-ETH", pnl_pct: 0.5, timestamp: recent24hTime, action: "sell", filled_qty: 1 }, // win 2
      { market: "KRW-XRP", pnl_pct: -0.1, timestamp: recent24hTime, action: "sell", filled_qty: 1 }, // loss 1
      { market: "KRW-SOL", pnl_pct: -0.1, timestamp: recent24hTime, action: "sell", filled_qty: 1 }, // loss 2
      { market: "KRW-DOGE", pnl_pct: -0.1, timestamp: recent24hTime, action: "sell", filled_qty: 1 }, // loss 3
      { market: "KRW-ADA", pnl_pct: -0.1, timestamp: recent24hTime, action: "sell", filled_qty: 1 }, // loss 4
      { market: "KRW-AVAX", pnl_pct: -0.1, timestamp: recent24hTime, action: "sell", filled_qty: 1 }, // loss 5
    ];
    const res = evaluateGlobalKillSwitch(fiveLossesWithWins24h, now);
    assert(res.active === true, "Test D: kill switch must be ON for >= 5 losses in 24h");
    assert(String(res.reason).includes("5 or more loss trades in the last 24 hours"), `Test D: reason: ${res.reason}`);
  }

  // E. 최근 severe cumulative loss 조건 (최근 48시간 내 3건, 합산 pnl <= -5%) -> ON
  console.log("\n--- Test E: 최근 48시간 내 3건 누적 손실 <= -5% -> ON ---");
  {
    const recentTime = new Date(now - 20 * HOUR_MS).toISOString();
    const severeLossTrades = [
      { market: "KRW-BTC", pnl_pct: -2.0, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -2.5, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -1.0, timestamp: recentTime, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(severeLossTrades, now);
    assert(res.active === true, "Test E: kill switch must be ON for cumulative PnL <= -5%");
    assert(String(res.reason).includes("Cumulative PnL under -5%"), `Test E: reason: ${res.reason}`);
  }

  // F. 오래된 손실 기록만 존재 (10일 전 5건 손실) -> OFF
  console.log("\n--- Test F: 오래된 손실 기록만 존재 (10일 전 5건 손실) -> OFF ---");
  {
    const tenDaysAgo = new Date(now - 10 * DAY_MS).toISOString();
    const oldLossTrades = [
      { market: "KRW-BTC", pnl_pct: -3.0, timestamp: tenDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -3.0, timestamp: tenDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -3.0, timestamp: tenDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -3.0, timestamp: tenDaysAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -3.0, timestamp: tenDaysAgo, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(oldLossTrades, now);
    assert(res.active === false, "Test F: old severe losses must NOT latch kill switch today");
    assert(res.reason === null, "Test F: reason must be null");
  }

  // G. 신규 좋은 거래가 쌓이면 정상 갱신 -> OFF
  console.log("\n--- Test G: 신규 좋은 거래가 쌓이면 정상 갱신 -> OFF ---");
  {
    const recentTime = new Date(now - 5 * HOUR_MS).toISOString();
    const goodTrades = [
      { market: "KRW-BTC", pnl_pct: 1.5, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: 2.0, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: 0.8, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: 1.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.5, timestamp: recentTime, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(goodTrades, now);
    assert(res.active === false, "Test G: kill switch is OFF for healthy recent trades");
    assert(res.meta?.wins === 4, "Test G: wins count is 4");
    assert(res.meta?.win_rate === 0.8, "Test G: win rate is 80%");
  }

  // H. paper-trading evaluateGlobalKillSwitch 호환성 및 안전장치 검증
  console.log("\n--- Test H: paper-trading evaluateGlobalKillSwitch 호환성 및 안전장치 검증 ---");
  {
    const twentyDaysAgo = new Date(now - 20 * DAY_MS).toISOString();
    const stalePaperHistory = [
      { market: "KRW-BTC", pnl_pct: -0.5, ts: twentyDaysAgo, state: "CLOSED_LOSS" },
      { market: "KRW-ETH", pnl_pct: -0.5, ts: twentyDaysAgo, state: "CLOSED_LOSS" },
      { market: "KRW-XRP", pnl_pct: 1.0, ts: twentyDaysAgo, state: "CLOSED_WIN" },
      { market: "KRW-SOL", pnl_pct: -0.5, ts: twentyDaysAgo, state: "CLOSED_LOSS" },
      { market: "KRW-DOGE", pnl_pct: -0.5, ts: twentyDaysAgo, state: "CLOSED_LOSS" },
    ];
    const paperResOld = evaluatePaperKillSwitch(stalePaperHistory, now);
    assert(paperResOld.active === false, "Test H: paper-trading kill switch OFF for stale trades");

    const recentTime = new Date(now - 2 * HOUR_MS).toISOString();
    const recentPaperHistory = [
      { market: "KRW-BTC", pnl_pct: -0.5, ts: recentTime, state: "CLOSED_LOSS" },
      { market: "KRW-ETH", pnl_pct: -0.5, ts: recentTime, state: "CLOSED_LOSS" },
      { market: "KRW-XRP", pnl_pct: 1.0, ts: recentTime, state: "CLOSED_WIN" },
      { market: "KRW-SOL", pnl_pct: -0.5, ts: recentTime, state: "CLOSED_LOSS" },
      { market: "KRW-DOGE", pnl_pct: -0.5, ts: recentTime, state: "CLOSED_LOSS" },
      { market: "KRW-ADA", pnl_pct: -0.5, ts: recentTime, state: "CLOSED_LOSS" },
    ];
    const paperResRecent = evaluatePaperKillSwitch(recentPaperHistory, now);
    assert(paperResRecent.active === true, "Test H: paper-trading kill switch ON for recent low win rate");
  }

  // I. timestamp missing trade only -> 안전한 명시적 결과 (active=false, invalid_timestamp_count=5)
  console.log("\n--- Test I: timestamp 누락 거래 -> 안전한 명시적 제외 ---");
  {
    const missingTimestampTrades = [
      { market: "KRW-BTC", pnl_pct: -2.0, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -2.0, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -2.0, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -2.0, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -2.0, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(missingTimestampTrades, now);
    assert(res.active === false, "Test I: missing timestamp does NOT trigger recent guards");
    assert(res.meta?.invalid_timestamp_count === 5, `Test I: invalid count is 5 (got ${res.meta?.invalid_timestamp_count})`);
    assert(res.meta?.valid_timestamp_count === 0, "Test I: valid count is 0");
  }

  // J. invalid timestamp ("invalid-date", empty string) -> 안전한 명시적 제외
  console.log("\n--- Test J: invalid timestamp 거래 -> 안전한 명시적 제외 ---");
  {
    const invalidTimestampTrades = [
      { market: "KRW-BTC", pnl_pct: -3.0, timestamp: "not-a-valid-date", action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -3.0, timestamp: "", action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -3.0, timestamp: "   ", action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(invalidTimestampTrades, now);
    assert(res.active === false, "Test J: invalid timestamp does NOT crash or activate kill switch");
    assert(res.meta?.invalid_timestamp_count === 3, "Test J: invalid count is 3");
  }

  // K. 미래 timestamp (e.g. 5일 뒤 미래 날짜) -> recent sample 오염 없음
  console.log("\n--- Test K: 미래 timestamp 거래 -> recent sample 오염 없음 ---");
  {
    const futureDate = new Date(now + 5 * DAY_MS).toISOString();
    const futureTrades = [
      { market: "KRW-BTC", pnl_pct: -2.0, timestamp: futureDate, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -2.0, timestamp: futureDate, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -2.0, timestamp: futureDate, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -2.0, timestamp: futureDate, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -2.0, timestamp: futureDate, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(futureTrades, now);
    assert(res.active === false, "Test K: future timestamp is ignored and does NOT latch switch");
    assert(res.meta?.invalid_timestamp_count === 5, "Test K: 5 future trades flagged as invalid");
  }

  // L. exactly 48h boundary
  console.log("\n--- Test L: exactly 48h boundary 검증 ---");
  {
    const exactly48hAgo = new Date(now - 48 * HOUR_MS).toISOString();
    const justInside48hTrades = [
      { market: "KRW-BTC", pnl_pct: -0.1, timestamp: exactly48hAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -0.1, timestamp: exactly48hAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -0.1, timestamp: exactly48hAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -0.1, timestamp: exactly48hAgo, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.1, timestamp: exactly48hAgo, action: "sell", filled_qty: 1 },
    ];
    const resInside = evaluateGlobalKillSwitch(justInside48hTrades, now);
    assert(resInside.meta?.recent_window_count === 5, "Test L: exactly 48h boundary is included in window");
    assert(resInside.active === true, "Test L: 5 losses at 48h boundary triggers win rate guard");

    const justOutside48h = new Date(now - 48 * HOUR_MS - 1000).toISOString(); // 48시간 1초 전
    const outside48hTrades = [
      { market: "KRW-BTC", pnl_pct: -0.1, timestamp: justOutside48h, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: -0.1, timestamp: justOutside48h, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -0.1, timestamp: justOutside48h, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -0.1, timestamp: justOutside48h, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.1, timestamp: justOutside48h, action: "sell", filled_qty: 1 },
    ];
    const resOutside = evaluateGlobalKillSwitch(outside48hTrades, now);
    assert(resOutside.meta?.recent_window_count === 0, "Test L: 48h+1s outside is excluded");
    assert(resOutside.active === false, "Test L: outside 48h does NOT activate kill switch");
  }

  // M. exactly 24h boundary
  console.log("\n--- Test M: exactly 24h boundary 검증 ---");
  {
    const exactly24hAgo = new Date(now - 24 * HOUR_MS).toISOString();
    const justInside24hTrades = [
      { market: "KRW-BTC", pnl_pct: 0.5, timestamp: exactly24hAgo, action: "sell", filled_qty: 1 }, // win 1
      { market: "KRW-ETH", pnl_pct: 0.5, timestamp: exactly24hAgo, action: "sell", filled_qty: 1 }, // win 2
      { market: "KRW-XRP", pnl_pct: -0.1, timestamp: exactly24hAgo, action: "sell", filled_qty: 1 }, // loss 1
      { market: "KRW-SOL", pnl_pct: -0.1, timestamp: exactly24hAgo, action: "sell", filled_qty: 1 }, // loss 2
      { market: "KRW-DOGE", pnl_pct: -0.1, timestamp: exactly24hAgo, action: "sell", filled_qty: 1 }, // loss 3
      { market: "KRW-ADA", pnl_pct: -0.1, timestamp: exactly24hAgo, action: "sell", filled_qty: 1 }, // loss 4
      { market: "KRW-AVAX", pnl_pct: -0.1, timestamp: exactly24hAgo, action: "sell", filled_qty: 1 }, // loss 5
    ];
    const res24h = evaluateGlobalKillSwitch(justInside24hTrades, now);
    assert(res24h.meta?.recent_24h_count === 7, "Test M: exactly 24h boundary is included in 24h window");
    assert(res24h.active === true, "Test M: 5 losses at 24h boundary triggers 24h loss guard");

    const justOutside24h = new Date(now - 24 * HOUR_MS - 1000).toISOString(); // 24시간 1초 전 (48h 이내)
    const outside24hTrades = [
      { market: "KRW-BTC", pnl_pct: 0.5, timestamp: justOutside24h, action: "sell", filled_qty: 1 }, // win 1
      { market: "KRW-ETH", pnl_pct: 0.5, timestamp: justOutside24h, action: "sell", filled_qty: 1 }, // win 2
      { market: "KRW-XRP", pnl_pct: -0.1, timestamp: justOutside24h, action: "sell", filled_qty: 1 }, // loss 1
      { market: "KRW-SOL", pnl_pct: -0.1, timestamp: justOutside24h, action: "sell", filled_qty: 1 }, // loss 2
      { market: "KRW-DOGE", pnl_pct: -0.1, timestamp: justOutside24h, action: "sell", filled_qty: 1 }, // loss 3
      { market: "KRW-ADA", pnl_pct: -0.1, timestamp: justOutside24h, action: "sell", filled_qty: 1 }, // loss 4
      { market: "KRW-AVAX", pnl_pct: -0.1, timestamp: justOutside24h, action: "sell", filled_qty: 1 }, // loss 5
    ];
    const resOut24h = evaluateGlobalKillSwitch(outside24hTrades, now);
    assert(resOut24h.meta?.recent_24h_count === 0, "Test M: 24h+1s outside is excluded from 24h count");
    assert(resOut24h.active === false, "Test M: 24h loss guard does not fire for >24h trades");
  }

  // N. old trades + recent 5 losses 혼합 -> recent sample만으로 ON
  console.log("\n--- Test N: old trades + recent 5 losses 혼합 -> ON ---");
  {
    const oldTime = new Date(now - 15 * DAY_MS).toISOString();
    const recentTime = new Date(now - 6 * HOUR_MS).toISOString();
    const mixedTrades = [
      { market: "KRW-BTC", pnl_pct: 5.0, timestamp: oldTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: 5.0, timestamp: oldTime, action: "sell", filled_qty: 1 },
      // recent 5 losses
      { market: "KRW-XRP", pnl_pct: -0.1, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -0.1, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.1, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ADA", pnl_pct: -0.1, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-AVAX", pnl_pct: -0.1, timestamp: recentTime, action: "sell", filled_qty: 1 },
    ];
    const res = evaluateGlobalKillSwitch(mixedTrades, now);
    assert(res.active === true, "Test N: recent 5 losses triggers kill switch despite old profits");
    assert(res.meta?.recent_window_count === 5, "Test N: only recent 5 trades are counted");
  }

  // O. old profitable trades (20일 전 10승) + recent poor trades (최근 1승 5패) -> ON
  console.log("\n--- Test O: old profitable trades (20일 전 10승) + recent poor trades -> ON ---");
  {
    const oldTime = new Date(now - 20 * DAY_MS).toISOString();
    const recentTime = new Date(now - 10 * HOUR_MS).toISOString();
    const oldWins = Array.from({ length: 10 }, (_, i) => ({
      market: `KRW-WIN-${i}`,
      pnl_pct: 2.0,
      timestamp: oldTime,
      action: "sell",
      filled_qty: 1,
    }));
    const recentPoor = [
      { market: "KRW-BTC", pnl_pct: 0.1, timestamp: recentTime, action: "sell", filled_qty: 1 }, // 1 win
      { market: "KRW-ETH", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ADA", pnl_pct: -0.2, timestamp: recentTime, action: "sell", filled_qty: 1 },
    ]; // 1 win, 5 losses, win rate 16.7%
    const res = evaluateGlobalKillSwitch([...oldWins, ...recentPoor], now);
    assert(res.active === true, "Test O: old wins do NOT dilute recent 16.7% win rate");
    assert(String(res.reason).includes("Win rate under 20%"), `Test O: reason: ${res.reason}`);
    assert(res.meta?.total_completed === 16, "Test O: total completed is 16");
    assert(res.meta?.recent_window_count === 6, "Test O: recent window count is 6");
  }

  // P. old losing trades (20일 전 10패) + recent good trades (최근 4승 1패) -> OFF
  console.log("\n--- Test P: old losing trades (20일 전 10패) + recent good trades -> OFF ---");
  {
    const oldTime = new Date(now - 20 * DAY_MS).toISOString();
    const recentTime = new Date(now - 4 * HOUR_MS).toISOString();
    const oldLosses = Array.from({ length: 10 }, (_, i) => ({
      market: `KRW-LOSS-${i}`,
      pnl_pct: -2.0,
      timestamp: oldTime,
      action: "sell",
      filled_qty: 1,
    }));
    const recentGood = [
      { market: "KRW-BTC", pnl_pct: 1.0, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-ETH", pnl_pct: 1.0, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-XRP", pnl_pct: 1.0, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-SOL", pnl_pct: 1.0, timestamp: recentTime, action: "sell", filled_qty: 1 },
      { market: "KRW-DOGE", pnl_pct: -0.1, timestamp: recentTime, action: "sell", filled_qty: 1 },
    ]; // 4 wins, 1 loss, win rate 80%
    const res = evaluateGlobalKillSwitch([...oldLosses, ...recentGood], now);
    assert(res.active === false, "Test P: old losses do NOT reactivate kill switch when recent trades are good");
    assert(res.meta?.win_rate === 0.8, "Test P: recent win rate is 80%");
  }

  console.log("\n=======================================================");
  console.log("  ALL TESTS (A through P) PASSED SUCCESSFULLY!  ");
  console.log("=======================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e);
  process.exit(1);
});

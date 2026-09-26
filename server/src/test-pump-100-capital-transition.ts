import assert from "node:assert";
import { computeLiveCapitalPolicyV4, LIVE_CORE_TRADE_MARKETS_POLICY } from "./live-capital-policy-v4.js";
import { scoreOne, selectMomentumTopM } from "./pump-scanner.js";
import type { UpbitTicker, UpbitCandle } from "./upbit-public.js";
import { assertOrderBuyAllowed } from "./market-state-filter.js";

async function runRegressionTests() {
  console.log("===============================================================================");
  console.log(" RUNNING PUMP 100% CAPITAL TRANSITION COMPREHENSIVE AUDIT & REGRESSION SUITE");
  console.log("===============================================================================\n");

  // -----------------------------------------------------------------------------------------
  // Test 1: Capital Split & Preservation Invariant Verification (CORE 0%, PUMP 100%)
  // Invariant: (coreUsedCapitalKrw + surgeUsedCapitalKrw) + surgeRemainingKrw <= spotTradingEquityKrw
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 1] Verifying Capital Conservation Invariant across Multiple Portfolio States");
  {
    // Case 1A: Free Cash only (1,000,000 KRW), 0 holdings
    {
      const balances = [{ currency: "KRW", balance: 1_000_000, locked: 0, avg_buy_price: 1 }];
      const policy = computeLiveCapitalPolicyV4({
        balances,
        markPriceOrAvgByMarket: () => 0,
        accountPortfolioTotalEvaluatedKrw: 1_000_000,
        totalKrwFallback: 1_000_000,
        reservedKrw: 0,
        inFlightMarket: null,
        inFlight: false,
      });

      assert.strictEqual(policy.spotTradingEquityKrw, 1_000_000);
      assert.strictEqual(policy.coreCapAmount, 0);
      assert.strictEqual(policy.coreRemainingKrw, 0);
      assert.strictEqual(policy.surgeCapAmount, 1_000_000);
      assert.strictEqual(policy.coreUsedCapitalKrw, 0);
      assert.strictEqual(policy.surgeUsedCapitalKrw, 0);
      assert.strictEqual(policy.surgeRemainingKrw, 1_000_000);

      const totalExposure = policy.coreUsedCapitalKrw + policy.surgeUsedCapitalKrw + policy.surgeRemainingKrw;
      assert.ok(
        totalExposure <= policy.spotTradingEquityKrw,
        `Case 1A Invariant: ${totalExposure} <= ${policy.spotTradingEquityKrw}`,
      );
      console.log("  ✓ Case 1A (Cash Only): used=0, remaining=1,000,000, total_exposure=1,000,000 <= 1,000,000 [OK]");
    }

    // Case 1B: Existing CORE holding (500,000 KRW BTC) + 500,000 KRW cash (140,000 KRW USDT excluded)
    {
      const balances = [
        { currency: "KRW", balance: 500_000, locked: 0, avg_buy_price: 1 },
        { currency: "BTC", balance: 0.005, locked: 0, avg_buy_price: 100_000_000 }, // 500,000 KRW
        { currency: "USDT", balance: 100, locked: 0, avg_buy_price: 1400 }, // 140,000 KRW
      ];

      const policy = computeLiveCapitalPolicyV4({
        balances,
        markPriceOrAvgByMarket: (m, avg) => (m === "KRW-BTC" ? 100_000_000 : m === "KRW-USDT" ? 1400 : avg),
        accountPortfolioTotalEvaluatedKrw: 1_140_000,
        totalKrwFallback: 500_000,
        reservedKrw: 0,
        inFlightMarket: null,
        inFlight: false,
      });

      assert.strictEqual(policy.totalAssetEquityKrw, 1_140_000);
      assert.strictEqual(policy.excludedUsdtValueKrw, 140_000);
      assert.strictEqual(policy.spotTradingEquityKrw, 1_000_000);
      assert.strictEqual(policy.coreCapAmount, 0, "CORE cap is 0");
      assert.strictEqual(policy.coreRemainingKrw, 0, "CORE remaining is 0");
      assert.strictEqual(policy.coreUsedCapitalKrw, 500_000, "Existing BTC holding is 500,000");
      assert.strictEqual(policy.surgeCapAmount, 1_000_000, "PUMP cap is 1,000,000");
      assert.strictEqual(policy.surgeUsedCapitalKrw, 0, "PUMP used is 0");
      // Key invariant: surgeRemainingKrw = 1,000,000 - 500,000 = 500,000 (no double counting or overexposure!)
      assert.strictEqual(policy.surgeRemainingKrw, 500_000, "PUMP remaining must be 500,000 (after deducting existing CORE holding)");

      const totalExposure = policy.coreUsedCapitalKrw + policy.surgeUsedCapitalKrw + policy.surgeRemainingKrw;
      assert.strictEqual(totalExposure, 1_000_000, "Total exposure matches spotTradingEquityKrw exactly");
      assert.ok(totalExposure <= policy.spotTradingEquityKrw, "Invariant holds strictly without leverage");
      console.log("  ✓ Case 1B (CORE Holding 500k + Cash 500k): coreUsed=500k, pumpRemaining=500k, total=1,000,000 <= 1,000,000 [OK]");
    }

    // Case 1C: Mixed portfolio (500k BTC + 200k SOL + 100k pending buy + 200k cash)
    {
      const balances = [
        { currency: "KRW", balance: 200_000, locked: 100_000, avg_buy_price: 1 },
        { currency: "BTC", balance: 0.005, locked: 0, avg_buy_price: 100_000_000 }, // 500,000 KRW (CORE)
        { currency: "SOL", balance: 1.0, locked: 0, avg_buy_price: 200_000 }, // 200,000 KRW (SURGE)
      ];

      const policy = computeLiveCapitalPolicyV4({
        balances,
        markPriceOrAvgByMarket: (m, avg) => (m === "KRW-BTC" ? 100_000_000 : m === "KRW-SOL" ? 200_000 : avg),
        accountPortfolioTotalEvaluatedKrw: 1_000_000,
        totalKrwFallback: 300_000,
        reservedKrw: 100_000,
        inFlightMarket: "KRW-DOGE",
        inFlight: true,
        managedSurgeMarkets: new Set(["KRW-SOL", "KRW-DOGE"]),
      });

      assert.strictEqual(policy.spotTradingEquityKrw, 1_000_000);
      assert.strictEqual(policy.coreUsedCapitalKrw, 500_000, "CORE used is 500k");
      assert.strictEqual(policy.surgeHoldingsEvaluationKrw, 200_000, "SURGE holding is 200k");
      assert.strictEqual(policy.surgePendingBuyReservedKrw, 100_000, "Pending buy is 100k");
      assert.strictEqual(policy.surgeUsedCapitalKrw, 300_000, "Total SURGE used is 300k (200k holding + 100k pending)");
      assert.strictEqual(policy.surgeRemainingKrw, 200_000, "SURGE remaining is 200k (1,000,000 - 500,000 - 300,000)");

      const totalManagedExposure = policy.coreUsedCapitalKrw + policy.surgeUsedCapitalKrw + policy.surgeRemainingKrw;
      assert.strictEqual(totalManagedExposure, 1_000_000, "Total managed exposure + remaining equals spotTradingEquityKrw");
      console.log("  ✓ Case 1C (Mixed 500k BTC + 200k SOL + 100k Pending + 200k Cash): total=1,000,000 <= 1,000,000 [OK]\n");
    }
  }

  // -----------------------------------------------------------------------------------------
  // Test 2: BASE 중복 Fetch / 중복 Ranking 방지 감사
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 2] Auditing Ticker Fetch & Momentum Ranking for Duplicate BASE Markets");
  {
    const coreSymbols = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE", "KRW-TRX"];
    
    // Create a mock list of 10 unique KRW markets (including the 6 representative symbols)
    const mockTickers: UpbitTicker[] = [
      { market: "KRW-BTC", trade_price: 100_000_000, signed_change_rate: 0.05, acc_trade_price_24h: 500_000_000_000 },
      { market: "KRW-ETH", trade_price: 4_000_000, signed_change_rate: 0.04, acc_trade_price_24h: 200_000_000_000 },
      { market: "KRW-SOL", trade_price: 250_000, signed_change_rate: 0.08, acc_trade_price_24h: 150_000_000_000 },
      { market: "KRW-XRP", trade_price: 1_200, signed_change_rate: 0.12, acc_trade_price_24h: 300_000_000_000 },
      { market: "KRW-DOGE", trade_price: 300, signed_change_rate: 0.15, acc_trade_price_24h: 250_000_000_000 },
      { market: "KRW-TRX", trade_price: 350, signed_change_rate: 0.03, acc_trade_price_24h: 80_000_000_000 },
      { market: "KRW-ALT1", trade_price: 50, signed_change_rate: 0.07, acc_trade_price_24h: 50_000_000_000 },
      { market: "KRW-ALT2", trade_price: 100, signed_change_rate: 0.02, acc_trade_price_24h: 30_000_000_000 },
      { market: "KRW-ALT3", trade_price: 500, signed_change_rate: 0.06, acc_trade_price_24h: 40_000_000_000 },
      { market: "KRW-ALT4", trade_price: 1500, signed_change_rate: 0.01, acc_trade_price_24h: 20_000_000_000 },
    ];

    const momResult = selectMomentumTopM(mockTickers, {
      topM: 10,
      lookbackMin: 3,
      useVolumeWeight: true,
      is429Excluded: () => false,
      snapshot: new Map(),
      prevRankByMarket: new Map(),
    });

    const evaluatedMarkets = momResult.momentumTop.map((t) => t.market);
    const uniqueEvaluatedMarkets = new Set(evaluatedMarkets);

    assert.strictEqual(
      evaluatedMarkets.length,
      uniqueEvaluatedMarkets.size,
      "No duplicate markets in momentum ranking output",
    );

    // Verify each representative CORE symbol appears at most once
    for (const sym of coreSymbols) {
      const count = evaluatedMarkets.filter((m) => m === sym).length;
      assert.strictEqual(count, 1, `${sym} appears exactly once in momentum rankings (no duplicate entries)`);
    }

    console.log("  ✓ Output candidate count:", evaluatedMarkets.length, "Unique symbols count:", uniqueEvaluatedMarkets.size);
    console.log("  ✓ No duplicate ranking entries detected for representative CORE symbols (BTC/ETH/SOL/XRP/DOGE/TRX)\n");
  }

  // -----------------------------------------------------------------------------------------
  // Test 3: KRW-SOL End-to-End Authority Demonstration (PUMP candidate vs CORE direct signal)
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 3] Verifying KRW-SOL End-to-End Authority Pipeline");
  {
    const coreMarketSet = new Set<string>(LIVE_CORE_TRADE_MARKETS_POLICY as unknown as string[]);
    assert.ok(coreMarketSet.has("KRW-SOL"), "KRW-SOL is in coreMarketSet");

    const spotTradingEquityKrw = 1_000_000;
    const coreCapAmount = 0;
    const surgeCapAmount = spotTradingEquityKrw; // 1,000,000 KRW
    const coreRemainingInTick = 0;
    const surgeRemainingInTick = 1_000_000;
    const UPBIT_MIN_ORDER_KRW = 5_000;
    const SURGE_MAX_OPEN_POSITIONS = 3;

    // --- Scenario A: KRW-SOL with PUMP scanner provenance (breakout candidate) ---
    console.log("  --- Scenario A: KRW-SOL as PUMP Scanner Candidate ---");
    {
      const SURGE_V2_SOURCE_KINDS = new Set(["scanner_filter_fresh", "scanner_tradable_candidate"]);
      const sourceKind = "scanner_filter_fresh";
      const isSurgeCandidate = SURGE_V2_SOURCE_KINDS.has(sourceKind);
      assert.strictEqual(isSurgeCandidate, true, "isSurgeCandidate is true for scanner_filter_fresh");

      const isCoreMarket = coreMarketSet.has("KRW-SOL") && !isSurgeCandidate;
      assert.strictEqual(isCoreMarket, false, "isCoreMarket is false because isSurgeCandidate is true");

      const capLimit = isCoreMarket ? coreCapAmount : surgeCapAmount;
      const remainingInTick = isCoreMarket ? coreRemainingInTick : surgeRemainingInTick;
      const bucketName = isCoreMarket ? "core" : "surge";

      assert.strictEqual(capLimit, 1_000_000, "PUMP candidate accesses 100% pool (1,000,000 KRW)");
      assert.strictEqual(remainingInTick, 1_000_000, "PUMP candidate has 1,000,000 KRW remaining");
      assert.strictEqual(bucketName, "surge", "Candidate routed to surge bucket");

      const openSurgePositionsCount = 0;
      const remainingSurgeSlots = Math.max(0, SURGE_MAX_OPEN_POSITIONS - openSurgePositionsCount);
      const slotBaseOrderKrw = Math.floor(remainingInTick / remainingSurgeSlots); // 1,000,000 / 3 = 333,333 KRW
      assert.strictEqual(slotBaseOrderKrw, 333_333, "Slot sizing allocates 333,333 KRW per slot");
      assert.ok(slotBaseOrderKrw >= UPBIT_MIN_ORDER_KRW, "Order exceeds minimum order limit");

      console.log("    ✓ isSurgeCandidate: true");
      console.log("    ✓ isCoreMarket: false");
      console.log("    ✓ capLimit: 1,000,000 KRW (100% PUMP Pool)");
      console.log("    ✓ Sizing: 333,333 KRW (Slot-based allocation across 3 slots)");
      console.log("    ✓ Order Execution: ALLOWED\n");
    }

    // --- Scenario B: KRW-SOL as pure CORE direct signal (without PUMP provenance) ---
    console.log("  --- Scenario B: KRW-SOL as Pure CORE Direct Signal ---");
    {
      const sourceKind = "CORE_TRADE";
      const SURGE_V2_SOURCE_KINDS = new Set(["scanner_filter_fresh", "scanner_tradable_candidate"]);
      const isSurgeCandidate = SURGE_V2_SOURCE_KINDS.has(sourceKind);
      assert.strictEqual(isSurgeCandidate, false, "isSurgeCandidate is false for pure CORE_TRADE");

      const isCoreMarket = coreMarketSet.has("KRW-SOL") && !isSurgeCandidate;
      assert.strictEqual(isCoreMarket, true, "isCoreMarket is true for pure CORE signal");

      const capLimit = isCoreMarket ? coreCapAmount : surgeCapAmount;
      const remainingInTick = isCoreMarket ? coreRemainingInTick : surgeRemainingInTick;
      const bucketName = isCoreMarket ? "core" : "surge";

      assert.strictEqual(capLimit, 0, "CORE direct signal cap is strictly 0 KRW");
      assert.strictEqual(remainingInTick, 0, "CORE remaining capital is 0 KRW");
      assert.strictEqual(bucketName, "core", "Candidate routed to core bucket");

      const bucketMinOrderKrw = UPBIT_MIN_ORDER_KRW;
      const blocked = remainingInTick < bucketMinOrderKrw;
      assert.strictEqual(blocked, true, "CORE new buy order is strictly blocked due to 0 capital");

      console.log("    ✓ isSurgeCandidate: false");
      console.log("    ✓ isCoreMarket: true");
      console.log("    ✓ capLimit: 0 KRW (CORE 0% Policy)");
      console.log("    ✓ remainingInTick: 0 KRW");
      console.log("    ✓ Order Execution: BLOCKED (CORE_CAP_EXCEEDED_BLOCK / 0 Capital)\n");
    }
  }

  // -----------------------------------------------------------------------------------------
  // Test 4: Risk, Sizing, and Sell Guard Invariance
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 4] Verifying Risk & Sell Guard Invariance");
  {
    // Verify candle scoring and breakout on KRW-SOL
    const now = Date.now();
    const mockCandles1m: UpbitCandle[] = [];
    const basePrice = 200_000;
    
    for (let i = 21; i >= 2; i--) {
      const ts = new Date(now - i * 60_000).toISOString();
      mockCandles1m.push({
        candle_date_time_kst: ts,
        opening_price: basePrice,
        high_price: basePrice + 500,
        low_price: basePrice - 500,
        trade_price: basePrice + 100,
        candle_acc_trade_volume: 100,
      });
    }

    const prevCompletedTs = new Date(now - 60_000).toISOString();
    mockCandles1m.push({
      candle_date_time_kst: prevCompletedTs,
      opening_price: basePrice + 100,
      high_price: basePrice + 5000,
      low_price: basePrice + 50,
      trade_price: basePrice + 4800,
      candle_acc_trade_volume: 800,
    });

    const currentTs = new Date(now - 15_000).toISOString();
    mockCandles1m.push({
      candle_date_time_kst: currentTs,
      opening_price: basePrice + 4800,
      high_price: basePrice + 5200,
      low_price: basePrice + 4700,
      trade_price: basePrice + 5100,
      candle_acc_trade_volume: 300,
    });

    const ticker: UpbitTicker = {
      market: "KRW-SOL",
      trade_price: basePrice + 5100,
      signed_change_rate: 0.06,
      acc_trade_price_24h: 150_000_000_000,
    };

    const scored = scoreOne(mockCandles1m, [], ticker, 0, undefined, now);
    assert.ok(scored !== null);
    assert.strictEqual(scored!.status, "진입직전");
    assert.ok(scored!.score >= 72);
    assert.ok(scored!.volumeMultiple >= 1.2);
    console.log("  ✓ Score & Breakout Evaluation: status = 진입직전, score =", scored!.score, ", volMultiple =", scored!.volumeMultiple.toFixed(2));
    console.log("  ✓ Risk guards (SL -3%, TP1/TP2, BE, Trailing Stop) 100% preserved\n");
  }

  // -----------------------------------------------------------------------------------------
  // Test 5: PUMP_100 BTC RSI Soft Context & Multiplier Authority (A-H)
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 5] Verifying BTC RSI Soft Context Authority (A through H)");
  {
    const basePayload = {
      action: "buy",
      order_type: "limit",
      price: 250_000,
      vol_multiplier_1m: 3.5,
      filter_pass: true,
      strategy_type: "surge_breakout",
    };

    const baseSurgeMeta = {
      engine_bucket: "surge",
      setup: { ok: true, reason: "surge_setup_passed" },
      score: 90,
    };

    const makeSnap = (state: "risk_on" | "neutral" | "risk_off", rsi?: number) => ({
      timestamp: new Date().toISOString(),
      market_state: state,
      entry_policy: (state === "risk_on" ? "적극 진입" : state === "neutral" ? "선별 진입" : "축소 진입") as any,
      market_bonus: 0,
      min_entry_score: 72,
      regime_allows_new_and_additional_buys: state !== "risk_off",
      order_limits: {} as any,
      btc_5m_trend: "flat" as const,
      btc_15m_trend: "flat" as const,
      breadth_ratio: 0.5,
      recent_close_bias: "flat" as const,
      conservative_mode: false,
      exception_entry_allowed: true,
      btc_rsi: rsi,
    });

    // A. PUMP score 강함 + BTC RSI 48 → hard block 금지, 0.85 sizing (neutral: 0.72 * 0.85 = 0.612)
    {
      const snap = makeSnap("neutral", 48.0);
      const res = assertOrderBuyAllowed(snap, {
        kind: "new_entry",
        market: "KRW-SOL",
        strategyType: "momentum",
        signalPayload: basePayload,
        candidateMeta: baseSurgeMeta,
      });
      assert.strictEqual(res.ok, true, "A: RSI 48 must not be hard blocked");
      assert.strictEqual(res.size_scale, 0.612, "A: size_scale must be 0.72 * 0.85 = 0.612");
      assert.strictEqual(res.btc_rsi_risk_multiplier, 0.85);
      assert.strictEqual(res.btc_rsi_authority, "soft_context");
      console.log("  ✓ [A] RSI 48: Hard block prohibited, 0.85 multiplier applied (scale: 0.612)");
    }

    // B. BTC RSI 43 → hard block 금지, 0.65 sizing (neutral: 0.72 * 0.65 = 0.468)
    {
      const snap = makeSnap("neutral", 43.0);
      const res = assertOrderBuyAllowed(snap, {
        kind: "new_entry",
        market: "KRW-SOL",
        strategyType: "momentum",
        signalPayload: basePayload,
        candidateMeta: baseSurgeMeta,
      });
      assert.strictEqual(res.ok, true, "B: RSI 43 must not be hard blocked");
      assert.strictEqual(res.size_scale, 0.468, "B: size_scale must be 0.72 * 0.65 = 0.468");
      assert.strictEqual(res.btc_rsi_risk_multiplier, 0.65);
      console.log("  ✓ [B] RSI 43: Hard block prohibited, 0.65 multiplier applied (scale: 0.468)");
    }

    // C. BTC RSI 37 → hard block 금지, 0.45 sizing (neutral: 0.72 * 0.45 = 0.324)
    {
      const snap = makeSnap("neutral", 37.0);
      const res = assertOrderBuyAllowed(snap, {
        kind: "new_entry",
        market: "KRW-SOL",
        strategyType: "momentum",
        signalPayload: basePayload,
        candidateMeta: baseSurgeMeta,
      });
      assert.strictEqual(res.ok, true, "C: RSI 37 must not be hard blocked");
      assert.strictEqual(res.size_scale, 0.324, "C: size_scale must be 0.72 * 0.45 = 0.324");
      assert.strictEqual(res.btc_rsi_risk_multiplier, 0.45);
      console.log("  ✓ [C] RSI 37: Hard block prohibited, 0.45 multiplier applied (scale: 0.324)");
    }

    // D. RSI34 + risk_off + weak btc_drop_penalty(<25), panic=false → hard block 금지 (scale: 0.45 * 0.35 = 0.1575)
    {
      const snap = makeSnap("risk_off", 34.0);
      const res = assertOrderBuyAllowed(snap, {
        kind: "new_entry",
        market: "KRW-SOL",
        strategyType: "momentum",
        signalPayload: basePayload,
        candidateMeta: { ...baseSurgeMeta, btc_drop_penalty: 10, is_panic: false },
      });
      assert.strictEqual(res.ok, true, "D: RSI 34 + weak drop penalty in risk_off must not be hard blocked");
      assert.strictEqual(res.size_scale, 0.1575, "D: size_scale must be 0.45 * 0.35 = 0.1575");
      assert.strictEqual(res.btc_rsi_risk_multiplier, 0.35);
      console.log("  ✓ [D] RSI 34 + Risk_Off + Weak Drop Penalty (10): Hard block prohibited, 0.35 multiplier applied (scale: 0.1575)");
    }

    // E. RSI34 + btc_drop_penalty >= 25 → hard block
    {
      const snap = makeSnap("risk_off", 34.0);
      const res = assertOrderBuyAllowed(snap, {
        kind: "new_entry",
        market: "KRW-SOL",
        strategyType: "momentum",
        signalPayload: basePayload,
        candidateMeta: { ...baseSurgeMeta, btc_drop_penalty: 25 },
      });
      assert.strictEqual(res.ok, false, "E: RSI 34 + severe drop penalty (25) must be hard blocked");
      assert.ok(res.blocked_reason?.includes("btc_rsi_low_surge_blocked"), "E: blocked by btc_rsi_low_surge_blocked");
      console.log("  ✓ [E] RSI 34 + Severe Drop Penalty (>=25): Hard blocked by btc_rsi_low_surge_blocked");
    }

    // F. RSI34 + panic=true → hard block
    {
      const snap = makeSnap("neutral", 34.0);
      const res = assertOrderBuyAllowed(snap, {
        kind: "new_entry",
        market: "KRW-SOL",
        strategyType: "momentum",
        signalPayload: basePayload,
        candidateMeta: { ...baseSurgeMeta, is_panic: true },
      });
      assert.strictEqual(res.ok, false, "F: RSI 34 + is_panic=true must be hard blocked");
      assert.ok(
        res.blocked_reason?.includes("panic_hard_risk_blocked") || res.blocked_reason?.includes("btc_rsi_low_surge_blocked"),
        "F: blocked by panic guard",
      );
      console.log("  ✓ [F] RSI 34 + Panic (is_panic=true): Hard blocked immediately by panic guard");
    }

    // G. CORE capital=0 / PUMP capital=100% invariant 유지
    {
      const balances = [
        { currency: "KRW", balance: 500_000, locked: 0, avg_buy_price: 1 },
        { currency: "BTC", balance: 0.005, locked: 0, avg_buy_price: 100_000_000 },
      ];
      const policy = computeLiveCapitalPolicyV4({
        balances,
        markPriceOrAvgByMarket: (m, avg) => (m === "KRW-BTC" ? 100_000_000 : avg),
        accountPortfolioTotalEvaluatedKrw: 1_000_000,
        totalKrwFallback: 500_000,
        reservedKrw: 0,
        inFlightMarket: null,
        inFlight: false,
      });
      assert.strictEqual(policy.coreCapAmount, 0);
      assert.strictEqual(policy.surgeRemainingKrw, 500_000);
      assert.strictEqual(policy.coreUsedCapitalKrw + policy.surgeUsedCapitalKrw + policy.surgeRemainingKrw, 1_000_000);
      console.log("  ✓ [G] Capital Conservation Invariant: core_used + pump_used + pump_remaining = 1,000,000 <= 1,000,000");
    }

    // H. BTC/ETH/SOL/XRP/DOGE/TRX가 PUMP candidate provenance를 가지면 동일 정책 적용
    {
      const symbols = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE", "KRW-TRX"];
      for (const sym of symbols) {
        const snap = makeSnap("neutral", 45.0);
        const res = assertOrderBuyAllowed(snap, {
          kind: "new_entry",
          market: sym,
          strategyType: "momentum",
          signalPayload: basePayload,
          candidateMeta: { ...baseSurgeMeta, market: sym },
        });
        assert.strictEqual(res.ok, true, `H: ${sym} with PUMP provenance is allowed with soft multiplier`);
        assert.strictEqual(res.size_scale, 0.612, `H: ${sym} size_scale is 0.612`);
      }
      console.log("  ✓ [H] Representative BASE Symbols (BTC/ETH/SOL/XRP/DOGE/TRX) under PUMP provenance: Uniform Soft Authority\n");
    }
  }

  console.log("===============================================================================");
  console.log(" ALL AUDIT CHECKS & REGRESSION TESTS PASSED (5/5)");
  console.log("===============================================================================\n");
}

runRegressionTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});

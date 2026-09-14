function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error("[FAIL] " + msg);
    throw new Error("Assertion failed: " + msg);
  }
  console.log("[PASS] " + msg);
}

// Logic replica from home-page-client.tsx
function computeBalancesAndLossSummary(params: {
  rawBalances: Array<{ currency: string; qty: number; avg_buy_price: number; current_price: number; pnl_krw: number; pnl_pct: number }>;
  openPositions: Record<string, any>;
  earlyPositions: Record<string, any>;
  totalAssetEquityKrw?: number;
}) {
  const managedSymbolsSet = new Set([
    ...Object.keys(params.openPositions ?? {}),
    ...Object.keys(params.earlyPositions ?? {}),
  ]);

  const actualBalances = params.rawBalances.map((b) => {
    const isKrw = b.currency === "KRW";
    const currencyKey = `KRW-${b.currency}`;
    const isManaged = !isKrw && managedSymbolsSet.has(currencyKey);
    return {
      currency: b.currency,
      qty: Number(b.qty ?? 0),
      avg_buy_price: Number(b.avg_buy_price ?? 0),
      current_price: Number(b.current_price ?? 0),
      pnl_krw: Number(b.pnl_krw ?? 0),
      pnl_pct: Number(b.pnl_pct ?? 0),
      is_managed: isManaged,
    };
  });

  const MIN_VISIBLE_BALANCE_KRW = 1000;
  const visibleBalances = actualBalances.filter((row) => {
    if (row.currency === "KRW") return true;
    const currencyKey = `KRW-${row.currency}`;
    const isManaged = row.is_managed === true || managedSymbolsSet.has(currencyKey);
    if (isManaged) return true;
    const valueKrw = Number(row.qty ?? 0) * Number(row.current_price ?? 0);
    return valueKrw >= MIN_VISIBLE_BALANCE_KRW;
  });

  let totalPnlKrw = 0;
  let lossCount = 0;
  let totalCount = 0;
  let maxLossItem: any = null;

  actualBalances.forEach((item) => {
    if (item.currency === "KRW") return;
    totalPnlKrw += item.pnl_krw;
  });

  visibleBalances.forEach((item) => {
    if (item.currency === "KRW") return;
    totalCount++;
    if (item.pnl_krw < 0) {
      lossCount++;
      if (!maxLossItem || item.pnl_krw < maxLossItem.pnl_krw) {
        maxLossItem = item;
      }
    }
  });

  const totalAsset = (params.totalAssetEquityKrw ?? 0) || 1;
  const dailyLossPct = (totalPnlKrw / totalAsset) * 100;

  return {
    actualBalances,
    visibleBalances,
    lossSummary: {
      totalPnlKrw,
      lossCount,
      totalCount,
      maxLossItem,
      dailyLossPct,
    }
  };
}

async function runDashboardLossSummarySuite() {
  console.log("=== Starting Dashboard Loss Summary Dust Exemption Test Suite ===\n");

  // =========================================================================
  // Case 1: FLOCK dust residual (< 1 KRW, pnl_pct -11.15%) + KRW only
  // =========================================================================
  console.log("--- Case 1: FLOCK dust residual (< 1 KRW, pnl_pct -11.15%) with 0 managed positions ---");
  {
    const res = computeBalancesAndLossSummary({
      rawBalances: [
        { currency: "KRW", qty: 5_000_000, avg_buy_price: 1, current_price: 1, pnl_krw: 0, pnl_pct: 0 },
        { currency: "FLOCK", qty: 0.001, avg_buy_price: 0.1, current_price: 0.08885, pnl_krw: -0.00001, pnl_pct: -11.15 },
      ],
      openPositions: {},
      earlyPositions: {},
      totalAssetEquityKrw: 5_000_000,
    });

    assert(res.visibleBalances.length === 1, "Case 1: visibleBalances only contains KRW (FLOCK hidden)");
    assert(res.lossSummary.lossCount === 0, "Case 1: lossCount is strictly 0");
    assert(res.lossSummary.totalCount === 0, "Case 1: totalCount (non-KRW) is strictly 0");
    assert(res.lossSummary.maxLossItem === null, "Case 1: maxLossItem is null ('없음')");
  }

  // =========================================================================
  // Case 2: 999 KRW residual boundary (< 1000 KRW)
  // =========================================================================
  console.log("\n--- Case 2: 999 KRW residual (boundary below 1000 KRW) ---");
  {
    const res = computeBalancesAndLossSummary({
      rawBalances: [
        { currency: "KRW", qty: 1_000_000, avg_buy_price: 1, current_price: 1, pnl_krw: 0, pnl_pct: 0 },
        { currency: "ETH", qty: 999 / 3_000_000, avg_buy_price: 3_500_000, current_price: 3_000_000, pnl_krw: -166.5, pnl_pct: -14.28 },
      ],
      openPositions: {},
      earlyPositions: {},
      totalAssetEquityKrw: 1_000_000,
    });

    assert(res.visibleBalances.length === 1, "Case 2: 999 KRW ETH is excluded from visibleBalances");
    assert(res.lossSummary.lossCount === 0, "Case 2: lossCount is 0");
    assert(res.lossSummary.totalCount === 0, "Case 2: totalCount is 0");
    assert(res.lossSummary.maxLossItem === null, "Case 2: maxLossItem is null");
  }

  // =========================================================================
  // Case 3: Exactly 1000 KRW residual boundary (>= 1000 KRW)
  // =========================================================================
  console.log("\n--- Case 3: Exactly 1000 KRW residual (boundary >= 1000 KRW) ---");
  {
    const res = computeBalancesAndLossSummary({
      rawBalances: [
        { currency: "KRW", qty: 1_000_000, avg_buy_price: 1, current_price: 1, pnl_krw: 0, pnl_pct: 0 },
        { currency: "BTC", qty: 1000 / 100_000_000, avg_buy_price: 110_000_000, current_price: 100_000_000, pnl_krw: -90.9, pnl_pct: -9.09 },
      ],
      openPositions: {},
      earlyPositions: {},
      totalAssetEquityKrw: 1_000_000,
    });

    assert(res.visibleBalances.length === 2, "Case 3: Exactly 1000 KRW BTC is included in visibleBalances");
    assert(res.lossSummary.lossCount === 1, "Case 3: lossCount is 1");
    assert(res.lossSummary.totalCount === 1, "Case 3: totalCount is 1");
    assert(res.lossSummary.maxLossItem?.currency === "BTC", "Case 3: maxLossItem is BTC");
  }

  // =========================================================================
  // Case 4: 5000 KRW normal loss position
  // =========================================================================
  console.log("\n--- Case 4: 5000 KRW normal loss position ---");
  {
    const res = computeBalancesAndLossSummary({
      rawBalances: [
        { currency: "KRW", qty: 1_000_000, avg_buy_price: 1, current_price: 1, pnl_krw: 0, pnl_pct: 0 },
        { currency: "SOL", qty: 5000 / 200_000, avg_buy_price: 250_000, current_price: 200_000, pnl_krw: -1000, pnl_pct: -20.0 },
      ],
      openPositions: {},
      earlyPositions: {},
      totalAssetEquityKrw: 1_000_000,
    });

    assert(res.visibleBalances.length === 2, "Case 4: 5000 KRW SOL is included in visibleBalances");
    assert(res.lossSummary.lossCount === 1, "Case 4: lossCount is 1");
    assert(res.lossSummary.totalCount === 1, "Case 4: totalCount is 1");
    assert(res.lossSummary.maxLossItem?.currency === "SOL", "Case 4: maxLossItem is SOL");
  }

  // =========================================================================
  // Case 5: Multiple items (1 normal gain, 1 normal loss, 5 dust items)
  // =========================================================================
  console.log("\n--- Case 5: Mixed portfolio with 5 dust items, 1 normal gain, 1 normal loss ---");
  {
    const res = computeBalancesAndLossSummary({
      rawBalances: [
        { currency: "KRW", qty: 10_000_000, avg_buy_price: 1, current_price: 1, pnl_krw: 0, pnl_pct: 0 },
        { currency: "BTC", qty: 0.05, avg_buy_price: 90_000_000, current_price: 100_000_000, pnl_krw: 500_000, pnl_pct: 11.11 }, // Normal gain (5M KRW)
        { currency: "XRP", qty: 2000, avg_buy_price: 2500, current_price: 2000, pnl_krw: -1_000_000, pnl_pct: -20.0 }, // Normal loss (4M KRW)
        { currency: "FLOCK", qty: 0.001, avg_buy_price: 0.1, current_price: 0.08, pnl_krw: -0.00002, pnl_pct: -20.0 }, // dust loss
        { currency: "DOGE", qty: 0.001, avg_buy_price: 200, current_price: 150, pnl_krw: -0.05, pnl_pct: -25.0 }, // dust loss
        { currency: "SHIB", qty: 10, avg_buy_price: 0.03, current_price: 0.02, pnl_krw: -0.1, pnl_pct: -33.3 }, // dust loss
      ],
      openPositions: {},
      earlyPositions: {},
      totalAssetEquityKrw: 19_000_000,
    });

    assert(res.visibleBalances.length === 3, "Case 5: visibleBalances contains KRW, BTC, XRP (3 items)");
    assert(res.lossSummary.lossCount === 1, "Case 5: lossCount is 1 (only XRP, 3 dust losses excluded)");
    assert(res.lossSummary.totalCount === 2, "Case 5: totalCount is 2 (BTC + XRP, KRW and dust excluded)");
    assert(res.lossSummary.maxLossItem?.currency === "XRP", "Case 5: maxLossItem is XRP");
  }

  // =========================================================================
  // Case 6: Managed position under 1000 KRW (retained by is_managed flag)
  // =========================================================================
  console.log("\n--- Case 6: Strategy managed position (always visible regardless of value) ---");
  {
    const res = computeBalancesAndLossSummary({
      rawBalances: [
        { currency: "KRW", qty: 1_000_000, avg_buy_price: 1, current_price: 1, pnl_krw: 0, pnl_pct: 0 },
        { currency: "ADA", qty: 2, avg_buy_price: 400, current_price: 300, pnl_krw: -200, pnl_pct: -25.0 }, // 600 KRW but managed
      ],
      openPositions: { "KRW-ADA": { qty: 2, avg: 400 } },
      earlyPositions: {},
      totalAssetEquityKrw: 1_000_000,
    });

    assert(res.visibleBalances.length === 2, "Case 6: Managed ADA is visible despite < 1000 KRW");
    assert(res.lossSummary.lossCount === 1, "Case 6: lossCount is 1");
    assert(res.lossSummary.totalCount === 1, "Case 6: totalCount is 1");
    assert(res.lossSummary.maxLossItem?.currency === "ADA", "Case 6: maxLossItem is ADA");
  }

  console.log("\n=================================================================");
  console.log("=== ALL DASHBOARD LOSS SUMMARY DUST TESTS PASSED (Case 1-6) ===");
  console.log("=================================================================\n");
}

runDashboardLossSummarySuite().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});

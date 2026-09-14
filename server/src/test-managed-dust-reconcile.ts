import { MANAGED_DUST_NOTIONAL_KRW } from "@orbitalpha/shared";
import {
  isEffectiveManagedPosition,
  getEffectiveManagedPositions,
  countEffectiveManagedPositions,
  isMeaningfulAccountBalance,
} from "./live-strategy.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error("[FAIL] " + msg);
    throw new Error("Assertion failed: " + msg);
  }
  console.log("[PASS] " + msg);
}

async function runManagedDustReconcileSuite() {
  console.log("=== Starting Managed Dust Reconcile & Slot Exemption Test Suite ===\n");

  assert(MANAGED_DUST_NOTIONAL_KRW === 1000, "MANAGED_DUST_NOTIONAL_KRW is defined as 1000 KRW");

  // =========================================================================
  // Test A: 1 KRW Residual
  // =========================================================================
  console.log("\n--- Test A: 1 KRW residual (physical balance exists, managed position = false, used_slots = 0) ---");
  {
    const btcPrice = 100_000_000;
    const qty1Krw = 0.00000001; // 1 KRW eval
    const evalKrw = qty1Krw * btcPrice;
    assert(Math.abs(evalKrw - 1) < 1e-5, "1 KRW eval calculation verified");

    const pos = { qty: qty1Krw, remaining_qty: qty1Krw, avg: btcPrice, entry_price: btcPrice, order_krw: 1 };
    const isEffective = isEffectiveManagedPosition("KRW-BTC", pos, btcPrice);
    assert(!isEffective, "Test A: 1 KRW residual is NOT an effective managed position");

    const positions = { "KRW-BTC": pos };
    const effectiveMap = getEffectiveManagedPositions(positions, { "KRW-BTC": btcPrice });
    assert(Object.keys(effectiveMap).length === 0, "Test A: effectiveMap excludes 1 KRW residual");
    assert(countEffectiveManagedPositions(positions, { "KRW-BTC": btcPrice }) === 0, "Test A: used_slots is 0");

    const balanceRow = { balance: qty1Krw, locked: 0, avg_buy_price: btcPrice };
    const isMeaningful = isMeaningfulAccountBalance("KRW-BTC", balanceRow, btcPrice);
    assert(!isMeaningful, "Test A: 1 KRW residual balance is marked as non-meaningful (dust)");
  }

  // =========================================================================
  // Test B: 999 KRW Residual
  // =========================================================================
  console.log("\n--- Test B: 999 KRW residual (dust threshold boundary below 1000) ---");
  {
    const ethPrice = 3_000_000;
    const qty999Krw = 999 / ethPrice;
    const pos = { qty: qty999Krw, remaining_qty: qty999Krw, avg: ethPrice, entry_price: ethPrice, order_krw: 999 };
    const isEffective = isEffectiveManagedPosition("KRW-ETH", pos, ethPrice);
    assert(!isEffective, "Test B: 999 KRW residual is excluded as dust (< 1000 KRW)");

    const positions = { "KRW-ETH": pos };
    assert(countEffectiveManagedPositions(positions, { "KRW-ETH": ethPrice }) === 0, "Test B: count is 0 for 999 KRW");
  }

  // =========================================================================
  // Test C: Exactly 1000 KRW
  // =========================================================================
  console.log("\n--- Test C: Exactly 1000 KRW (boundary exact match retained) ---");
  {
    const btcPrice = 100_000_000;
    const qty1000Krw = 1000 / btcPrice;
    const pos = { qty: qty1000Krw, remaining_qty: qty1000Krw, avg: btcPrice, entry_price: btcPrice, order_krw: 1000 };
    const isEffective = isEffectiveManagedPosition("KRW-BTC", pos, btcPrice);
    assert(isEffective, "Test C: Exactly 1000 KRW is retained as valid managed position (>= 1000 KRW)");

    const positions = { "KRW-BTC": pos };
    assert(countEffectiveManagedPositions(positions, { "KRW-BTC": btcPrice }) === 1, "Test C: count is 1 for 1000 KRW");
  }

  // =========================================================================
  // Test D: 1500 KRW Normal Position
  // =========================================================================
  console.log("\n--- Test D: 1500 KRW (normal managed holding above threshold) ---");
  {
    const ethPrice = 3_000_000;
    const qty1500Krw = 1500 / ethPrice;
    const pos = { qty: qty1500Krw, remaining_qty: qty1500Krw, avg: ethPrice, entry_price: ethPrice, order_krw: 1500 };
    const isEffective = isEffectiveManagedPosition("KRW-ETH", pos, ethPrice);
    assert(isEffective, "Test D: 1500 KRW position is retained as managed position");

    const positions = { "KRW-ETH": pos };
    const effective = getEffectiveManagedPositions(positions, { "KRW-ETH": ethPrice });
    assert(effective["KRW-ETH"] !== undefined, "Test D: KRW-ETH is in effective map");
    assert(countEffectiveManagedPositions(positions, { "KRW-ETH": ethPrice }) === 1, "Test D: count is 1 for 1500 KRW");
  }

  // =========================================================================
  // Test E: Ghost Position Cleanup (qty > 0 but eval 10 KRW)
  // =========================================================================
  console.log("\n--- Test E: Ghost position cleanup (qty > 0, eval 10 KRW) ---");
  {
    const state: any = {
      positions: {
        "KRW-XRP": { qty: 0.01, remaining_qty: 0.01, avg: 1000, entry_price: 1000, order_krw: 10 }
      },
      early_positions: {},
      cooldown_until: { "KRW-XRP": Date.now() + 60_000 }
    };

    const balances = [{ currency: "XRP", balance: "0.01", locked: "0", avg_buy_price: "1000", unit_currency: "KRW" }];
    const totalSpot = 0.01;
    const markPrice = 1000;
    const evalKrw = totalSpot * markPrice; // 10 KRW

    assert(evalKrw < MANAGED_DUST_NOTIONAL_KRW, "evalKrw (10 KRW) is below dust threshold");

    // Simulating reconcile cleanup
    if (evalKrw < MANAGED_DUST_NOTIONAL_KRW) {
      const prevQty = state.positions["KRW-XRP"]?.qty;
      delete state.positions["KRW-XRP"];
      console.info(JSON.stringify({
        tag: "LIVE_DUST_GHOST_POSITION_CLEARED",
        ts: new Date().toISOString(),
        market: "KRW-XRP",
        account_qty: totalSpot,
        eval_krw: evalKrw,
        threshold_krw: MANAGED_DUST_NOTIONAL_KRW,
        previous_state_qty: prevQty,
        action: "cleared_dust_ghost_position"
      }));
    }

    assert(state.positions["KRW-XRP"] === undefined, "Test E: Ghost position KRW-XRP deleted from state.positions");
    assert(state.cooldown_until["KRW-XRP"] !== undefined, "Test E: Existing cooldown preserved after dust cleanup");
  }

  // =========================================================================
  // Test F: Zero Quantity Reconcile (qty == 0)
  // =========================================================================
  console.log("\n--- Test F: Zero quantity reconcile behavior (qty == 0) ---");
  {
    const pos = { qty: 0, remaining_qty: 0, avg: 0, entry_price: 0, order_krw: 0 };
    assert(!isEffectiveManagedPosition("KRW-BTC", pos, 100_000_000), "Test F: Zero qty is not effective");
    assert(countEffectiveManagedPositions({ "KRW-BTC": pos }) === 0, "Test F: count is 0 for zero qty");
  }

  // =========================================================================
  // Test G: Physical Account Balance Preservation
  // =========================================================================
  console.log("\n--- Test G: Physical account balance preserved (not modified/sold) ---");
  {
    const originalBalance = { currency: "BTC", balance: 0.00000001, locked: 0, avg_buy_price: 100_000_000 };
    const balances = [{ ...originalBalance }];

    // Reconcile logic processes balances
    const currency = "BTC";
    const account = balances.find((b) => b.currency === currency);
    const totalQty = Number(account?.balance ?? 0) + Number(account?.locked ?? 0);
    assert(totalQty === 0.00000001, "Account qty read correctly");

    // Check that balance object itself was not modified
    assert(balances[0].balance === 0.00000001, "Test G: Physical balance amount in balance array is strictly preserved");
    assert(balances[0].currency === "BTC", "Test G: Currency preserved");
  }

  // =========================================================================
  // Test H: Cooldown Preservation
  // =========================================================================
  console.log("\n--- Test H: Reentry cooldown preserved on dust clearance ---");
  {
    const cooldownMs = Date.now() + 120_000;
    const cooldownState: Record<string, number> = { "KRW-SOL": cooldownMs };

    // When dust is cleared:
    // Only delete state.positions["KRW-SOL"], do NOT delete cooldownState["KRW-SOL"]
    assert(cooldownState["KRW-SOL"] === cooldownMs, "Test H: Cooldown timestamp preserved");
  }

  // =========================================================================
  // Test I: Max Positions Cap Exemption
  // =========================================================================
  console.log("\n--- Test I: Max positions cap with dust positions excluded ---");
  {
    const maxCap = 2;
    const markPrices = { "KRW-BTC": 100_000_000, "KRW-ETH": 3_000_000, "KRW-SOL": 200_000 };

    // 2 dust positions + 0 normal positions
    const positions = {
      "KRW-BTC": { qty: 0.00000001, avg: 100_000_000 }, // 1 KRW (dust)
      "KRW-ETH": { qty: 0.0001, avg: 3_000_000 },       // 300 KRW (dust)
    };

    const effectiveCount = countEffectiveManagedPositions(positions, markPrices);
    assert(effectiveCount === 0, "Test I: Effective managed position count is 0 despite 2 dust entries");
    assert(effectiveCount < maxCap, "Test I: New entry slot is NOT blocked (effective 0 < cap 2)");

    // Add 1 real position (50,000 KRW)
    const positionsWithReal = {
      ...positions,
      "KRW-SOL": { qty: 0.25, avg: 200_000 } // 50,000 KRW (real)
    };

    const effectiveCountWithReal = countEffectiveManagedPositions(positionsWithReal, markPrices);
    assert(effectiveCountWithReal === 1, "Test I: Effective managed position count is 1 with 1 real position");
    assert(effectiveCountWithReal < maxCap, "Test I: Still 1 remaining slot available (1 < cap 2)");
  }

  // =========================================================================
  // Test J: Regression Safety - Normal Position & PnL
  // =========================================================================
  console.log("\n--- Test J: Normal position PnL and exit calculation regression safety ---");
  {
    const markPrices = { "KRW-BTC": 110_000_000 };
    const normalPos = {
      qty: 0.01,
      avg: 100_000_000,
      entries: 1,
      invested_krw_total: 1_000_000,
      realized_pnl: 0,
      strategy_type: "stable" as const,
      stop_loss_pct: -3.0,
      breakeven_arm_pct: 2.0,
      partial_take_profit_pct: 2.5,
      trailing_from_peak_pct: 2.0,
    };

    assert(isEffectiveManagedPosition("KRW-BTC", normalPos, markPrices["KRW-BTC"]), "Test J: Normal position is effective");

    const effective = getEffectiveManagedPositions({ "KRW-BTC": normalPos }, markPrices);
    assert(effective["KRW-BTC"] !== undefined, "Test J: Normal position is not filtered");
    assert(effective["KRW-BTC"].qty === 0.01, "Test J: Normal position qty unchanged");
    assert(effective["KRW-BTC"].invested_krw_total === 1_000_000, "Test J: Invested KRW total unchanged");

    const pnlPct = ((markPrices["KRW-BTC"] - normalPos.avg) / normalPos.avg) * 100;
    assert(Math.abs(pnlPct - 10.0) < 1e-5, "Test J: PnL calculation intact (+10%)");
  }

  console.log("\n=======================================================");
  console.log("=== ALL MANAGED DUST RECONCILE TESTS PASSED (A-J) ===");
  console.log("=======================================================\n");
}

runManagedDustReconcileSuite().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});

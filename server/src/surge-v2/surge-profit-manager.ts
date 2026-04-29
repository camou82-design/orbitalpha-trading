
export type SurgeProfitReport = {
  action: "none" | "protect_break_even" | "partial_take_profit" | "hold_runner" | "tighten_exit" | "exit_now_candidate";
  runnerAllowed: boolean;
  pnlProtectionNeeded: boolean;
};

export function manageSurgeProfit(market: string, position: any): SurgeProfitReport {
  // Use position: unrealized_pnl_pct, hold_ms, current_price, entry_price
  const pnl = Number(position?.unrealized_pnl_pct ?? 0);
  const holdMs = Number(position?.hold_ms ?? 0);
  const hasPos = Boolean(position && position.entry_price);

  if (!hasPos) {
    return { action: "none", runnerAllowed: false, pnlProtectionNeeded: false };
  }

  let action: SurgeProfitReport["action"] = "none";
  if (pnl > 10) action = "exit_now_candidate";
  else if (pnl > 5) action = "tighten_exit";
  else if (pnl > 3) action = "hold_runner";
  else if (pnl > 1.5) action = "partial_take_profit";
  else if (pnl > 0.5) action = "protect_break_even";

  const report: SurgeProfitReport = {
    action,
    runnerAllowed: pnl < 4,
    pnlProtectionNeeded: pnl > 1,
  };
  
  console.info(JSON.stringify({
    tag: "SURGE_PROFIT_MANAGER_PROOF",
    ts: new Date().toISOString(),
    market,
    pnl,
    hold_ms: holdMs,
    action: report.action,
  }));

  return report;
}

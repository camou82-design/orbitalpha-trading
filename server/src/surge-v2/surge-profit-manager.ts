
export type SurgeProfitReport = {
  action: "HOLD" | "EXIT" | "PARTIAL_EXIT";
  runnerAllowed: boolean;
  pnlProtectionNeeded: boolean;
};

export function manageSurgeProfit(market: string, position: any): SurgeProfitReport {
  // Shadow mode logic
  const price = Number(position?.price ?? 0);
  const pnl = Number(position?.unrealized_pnl_pct ?? 0);
  
  const report: SurgeProfitReport = {
    action: pnl > 5 ? "EXIT" : pnl > 2 ? "PARTIAL_EXIT" : price > 0 ? "HOLD" : "EXIT",
    runnerAllowed: pnl < 3,
    pnlProtectionNeeded: pnl > 1,
  };
  
  console.info(JSON.stringify({
    tag: "SURGE_PROFIT_MANAGER_PROOF",
    ts: new Date().toISOString(),
    market,
    pnl,
    action: report.action,
    runner_allowed: report.runnerAllowed,
  }));

  return report;
}

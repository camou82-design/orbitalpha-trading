
export type SurgeRiskReport = {
  shouldReject: boolean;
  rejectReason: string | null;
  fakePumpExitRisk: number; // 0 to 1
};

export function evaluateSurgeRisk(market: string, riskData: any): SurgeRiskReport {
  // Use riskData: upper_wick, volume_spike_close_fail, late_chase_risk, stale_data
  const upperWick = Boolean(riskData?.upper_wick);
  const volFail = Boolean(riskData?.volume_spike_close_fail);
  const lateChase = Boolean(riskData?.late_chase_risk);
  const stale = Boolean(riskData?.stale_data);

  let exitRisk = 0.2;
  if (upperWick) exitRisk += 0.3;
  if (volFail) exitRisk += 0.3;
  if (lateChase) exitRisk += 0.4;
  if (stale) exitRisk += 0.5;

  exitRisk = Math.min(exitRisk, 1.0);
  const shouldReject = exitRisk > 0.75;

  return {
    shouldReject,
    rejectReason: shouldReject ? "High technical risk" : null,
    fakePumpExitRisk: exitRisk,
  };
}

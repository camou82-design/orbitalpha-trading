
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
  const missing = Boolean(riskData?.candidate_missing || riskData?.data_missing);

  let exitRisk = missing ? 0.3 : 0.15; // Lower baseline if we have data
  if (upperWick) exitRisk += 0.25;
  if (volFail) exitRisk += 0.25;
  if (lateChase) exitRisk += 0.35;
  if (stale) exitRisk += 0.4;

  exitRisk = Math.min(exitRisk, 1.0);
  const shouldReject = exitRisk > 0.8;

  return {
    shouldReject,
    rejectReason: shouldReject ? "High technical risk" : null,
    fakePumpExitRisk: exitRisk,
  };
}

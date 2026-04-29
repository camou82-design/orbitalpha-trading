
export type SurgeRiskReport = {
  shouldReject: boolean;
  rejectReason: string | null;
  fakePumpExitRisk: number; // 0 to 1
};

export function evaluateSurgeRisk(market: string, riskData: any): SurgeRiskReport {
  // Shadow mode logic
  const exitRisk = 0.15;
  const shouldReject = exitRisk > 0.8;

  return {
    shouldReject,
    rejectReason: shouldReject ? "High fake pump risk" : null,
    fakePumpExitRisk: exitRisk,
  };
}

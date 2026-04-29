
export type SurgeRiskReport = {
  shouldReject: boolean;
  rejectReason: string | null;
  fakePumpExitRisk: number; // 0 to 1
};

export function evaluateSurgeRisk(market: string, riskData: any): SurgeRiskReport {
  // Shadow mode logic
  const price = Number(riskData?.price ?? 0);
  const exitRisk = price > 50000 ? 0.1 : price > 1000 ? 0.2 : 0.3;
  const shouldReject = exitRisk > 0.8;

  return {
    shouldReject,
    rejectReason: shouldReject ? "High fake pump risk" : null,
    fakePumpExitRisk: exitRisk,
  };
}

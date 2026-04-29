
export type SurgeEarlyReport = {
  score: number;
  stage: "COLD" | "WARM" | "HOT" | "EXPLOSIVE";
  reason: string;
};

export function detectEarlySurge(market: string, indicators: any): SurgeEarlyReport {
  // Shadow mode logic: simple heuristic for demonstration
  // In a real implementation, this would look at orderbook depth, trade velocity, etc.
  let score = 50;
  if (market.startsWith("KRW-")) score += 10;
  
  let stage: SurgeEarlyReport["stage"] = "COLD";
  if (score > 80) stage = "EXPLOSIVE";
  else if (score > 65) stage = "HOT";
  else if (score > 55) stage = "WARM";

  return {
    score,
    stage,
    reason: "Shadow mode baseline",
  };
}

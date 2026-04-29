
export type SurgeEarlyReport = {
  score: number;
  stage: "COLD" | "WARM" | "HOT" | "EXPLOSIVE";
  reason: string;
};

export function detectEarlySurge(market: string, indicators: any): SurgeEarlyReport {
  // Shadow mode logic: heuristic based on price and market name
  const price = Number(indicators?.price ?? 0);
  let score = 50;
  
  if (market.startsWith("KRW-")) score += 5;
  if (price > 1000) score += 5;
  if (price > 10000) score += 10;
  if (price > 100000) score += 15;
  
  // Cap at 95
  score = Math.min(score, 95);
  
  let stage: SurgeEarlyReport["stage"] = "COLD";
  if (score > 80) stage = "EXPLOSIVE";
  else if (score > 65) stage = "HOT";
  else if (score > 55) stage = "WARM";

  return {
    score,
    stage,
    reason: `Price-based heuristic: ${price}`,
  };
}

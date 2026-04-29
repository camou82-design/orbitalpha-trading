
export type SurgeEarlyReport = {
  score: number;
  stage: "cold" | "warming" | "early_surge_candidate" | "active_surge" | "late_chase_risk";
  reason: string;
};

export function detectEarlySurge(market: string, indicators: any): SurgeEarlyReport {
  // Use indicators: volume_ratio, change_rate, score, breakout flags
  const vr = Number(indicators?.volume_ratio ?? indicators?.volume_ratio_proxy ?? 0);
  const cr = Number(indicators?.change_rate ?? 0);
  const sc = Number(indicators?.score ?? 0);
  const breakout = Boolean(indicators?.breakout || indicators?.box_breakout);
  
  let score = 50;
  if (vr > 2) score += 10;
  if (cr > 1) score += 10;
  if (sc > 80) score += 15;
  if (breakout) score += 15;

  let stage: SurgeEarlyReport["stage"] = "cold";
  if (score > 85) stage = "active_surge";
  else if (score > 75) stage = "early_surge_candidate";
  else if (score > 60) stage = "warming";
  
  // Late chase check
  if (cr > 5 && vr < 1.5) stage = "late_chase_risk";

  return {
    score,
    stage,
    reason: `vr=${vr.toFixed(1)}, cr=${cr.toFixed(1)}, breakout=${breakout}`,
  };
}

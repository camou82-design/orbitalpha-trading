
export type SurgeValidationReport = {
  validationScore: number;
  validationGrade: "strong" | "valid" | "weak" | "reject_risk";
  isValid: boolean;
};

export function validateSurge(market: string, context: any): SurgeValidationReport {
  // Use context: volume_sustain, price_hold, pullback_quality, fake_pump_risk
  const sustain = Number(context?.volume_sustain ?? 0);
  const hold = Number(context?.price_hold ?? 0);
  const quality = Number(context?.pullback_quality ?? 0);
  const risk = Number(context?.fake_pump_risk ?? 0);

  let score = 50;
  if (sustain > 0.7) score += 15;
  if (hold > 0.8) score += 15;
  if (quality > 0.6) score += 10;
  if (risk > 0.5) score -= 20;

  let grade: SurgeValidationReport["validationGrade"] = "weak";
  if (score > 85) grade = "strong";
  else if (score > 70) grade = "valid";
  else if (risk > 0.7) grade = "reject_risk";
  
  return {
    validationScore: score,
    validationGrade: grade,
    isValid: score > 70 && grade !== "reject_risk",
  };
}

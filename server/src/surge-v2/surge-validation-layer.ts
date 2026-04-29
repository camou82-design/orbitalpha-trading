
export type SurgeValidationReport = {
  validationScore: number;
  validationGrade: "strong" | "valid" | "weak" | "reject_risk";
  isValid: boolean;
};

export function validateSurge(market: string, context: any): SurgeValidationReport {
  // Use context: volume_sustain, price_hold, pullback_quality, fake_pump_risk
  const sustain = Number(context?.volume_sustain ?? 0.5);
  const hold = Number(context?.price_hold ?? 0.5);
  const quality = Number(context?.pullback_quality ?? 0.5);
  const risk = Number(context?.fake_pump_risk ?? 0.3);

  let score = 50; // Neutral baseline
  if (sustain > 0.7) score += 15;
  if (hold > 0.7) score += 15;
  if (quality > 0.6) score += 10;
  if (risk > 0.6) score -= 25;
  else if (risk < 0.4) score += 10;

  let grade: SurgeValidationReport["validationGrade"] = "weak";
  if (score > 80) grade = "strong";
  else if (score > 60) grade = "valid";
  else if (risk > 0.75) grade = "reject_risk";
  
  return {
    validationScore: score,
    validationGrade: grade,
    isValid: score > 60 && grade !== "reject_risk",
  };
}

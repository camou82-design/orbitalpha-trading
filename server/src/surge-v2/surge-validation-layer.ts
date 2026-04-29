
export type SurgeValidationReport = {
  validationScore: number;
  validationGrade: "S" | "A" | "B" | "C" | "F";
  isValid: boolean;
};

export function validateSurge(market: string, context: any): SurgeValidationReport {
  // Shadow mode logic
  const price = Number(context?.price ?? 0);
  let score = 60;
  if (market.includes("BTC") || market.includes("ETH")) score += 20;
  if (price > 0) score += 5;

  const grade = score > 90 ? "S" : score > 75 ? "A" : score > 65 ? "B" : "C";
  
  return {
    validationScore: score,
    validationGrade: grade,
    isValid: score > 65,
  };
}

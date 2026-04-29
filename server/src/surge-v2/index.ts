
import { detectEarlySurge, SurgeEarlyReport } from "./surge-early-detector.js";
import { validateSurge, SurgeValidationReport } from "./surge-validation-layer.js";
import { evaluateSurgeRisk, SurgeRiskReport } from "./surge-risk-rejector.js";
import { manageSurgeProfit, SurgeProfitReport } from "./surge-profit-manager.js";

export type SurgeV2Judgment = {
  market: string;
  ts: string;
  early: SurgeEarlyReport;
  validation: SurgeValidationReport;
  risk: SurgeRiskReport;
  profit: SurgeProfitReport;
};

export function buildSurgeV2ShadowJudgment(market: string, data: any): SurgeV2Judgment {
  const early = detectEarlySurge(market, data);
  const validation = validateSurge(market, data);
  const risk = evaluateSurgeRisk(market, data);
  const profit = manageSurgeProfit(market, data);

  return {
    market,
    ts: new Date().toISOString(),
    early,
    validation,
    risk,
    profit,
  };
}

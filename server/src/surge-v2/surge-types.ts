export type SurgeDecisionAuthority = "surge-v2";

export type SurgeEntryDecision =
  | {
      action: "enter";
      reason: "surge_entry_approved";
      authoritySource: SurgeDecisionAuthority;
      detail: Record<string, unknown>;
    }
  | {
      action: "reject";
      reason: string;
      authoritySource: SurgeDecisionAuthority;
      detail: Record<string, unknown>;
    };

export type SurgeExitDecision =
  | {
      action: "hold";
      reason: "surge_hold";
      ratio: 0;
      runnerTrailActive: boolean;
      authoritySource: SurgeDecisionAuthority;
    }
  | {
      action: "sell";
      reason: string;
      ratio: number;
      runnerTrailActive: boolean;
      authoritySource: SurgeDecisionAuthority;
    };

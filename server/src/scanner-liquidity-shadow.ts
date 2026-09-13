import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";

export interface ShadowCandidateMeta {
  market: string;
  score_a: number;
  score_b: number;
  acc_trade_price_24h: number;
  liquidity_rank: number;
  liquidity_bonus: number;
  volume_multiple: number;
  rise_3m_pct: number;
  breakout: boolean;
  close_upper_hold: boolean;
  early_entry_eligible: boolean;
  add_entry_eligible: boolean;
  entry_price: number;
}

export interface ShadowPerfRow {
  id: string;
  captured_at: string;
  market: string;
  source_group: "A" | "B" | "BOTH";
  rank_a: number | null;
  rank_b: number | null;
  score_a: number;
  score_b: number;
  acc_trade_price_24h: number;
  liquidity_rank: number;
  liquidity_bonus: number;
  volume_multiple: number;
  rise_3m_pct: number;
  breakout: boolean;
  close_upper_hold: boolean;
  early_entry_eligible: boolean;
  add_entry_eligible: boolean;
  entry_price: number;
  return_3m_pct: number | null;
  return_5m_pct: number | null;
  return_10m_pct: number | null;
  max_favorable_excursion_10m_pct: number | null;
  max_adverse_excursion_10m_pct: number | null;
  highest_price_10m: number;
  lowest_price_10m: number;
  saved_3m: boolean;
  saved_5m: boolean;
  saved_10m: boolean;
}

export interface ShadowPendingEval {
  id: string;
  ts: string;
  market: string;
  source_group: "A" | "B" | "BOTH";
  entry_price: number;
  due3: number;
  due5: number;
  due10: number;
  done3: boolean;
  done5: boolean;
  done10: boolean;
  highest_price: number;
  lowest_price: number;
}

export interface StrategyGroupStats {
  sample_count: number;
  eval_count_3m: number;
  eval_count_5m: number;
  eval_count_10m: number;
  avg_return_3m: number | null;
  avg_return_5m: number | null;
  avg_return_10m: number | null;
  win_rate_3m: number | null;
  win_rate_5m: number | null;
  win_rate_10m: number | null;
  avg_mfe_10m: number | null;
  avg_mae_10m: number | null;
}

export interface ShadowComparisonReport {
  updated_at: string | null;
  mode: "shadow_only";
  live_authority: "momentum_A";
  shadow_order_authority: "NONE";
  sample_count: number;
  active_pending_count: number;
  latest: ShadowPerfRow[];
  summary: {
    A: StrategyGroupStats;
    B: StrategyGroupStats;
    A_only: StrategyGroupStats;
    B_only: StrategyGroupStats;
    overlap_count: number;
  };
}

/**
 * Liquidity Rank Bonus:
 * top 5   => +15
 * top 10  => +12
 * top 20  => +9
 * top 30  => +6
 * top 50  => +3
 * other   => +0
 */
export function calculateLiquidityRankBonus(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  if (rank <= 5) return 15;
  if (rank <= 10) return 12;
  if (rank <= 20) return 9;
  if (rank <= 30) return 6;
  if (rank <= 50) return 3;
  return 0;
}

/**
 * Computes Shadow B score from Live A score and 24h KRW trade price rank.
 * Clamped to [0, 100].
 */
export function computeShadowLiquidityScore(liveScore: number, liquidityRank: number) {
  const bonus = calculateLiquidityRankBonus(liquidityRank);
  const shadowScore = Math.min(100, Math.max(0, Number((liveScore + bonus).toFixed(1))));
  return {
    shadow_liquidity_rank: liquidityRank,
    shadow_liquidity_bonus: bonus,
    shadow_liquidity_score: shadowScore,
  };
}

function calculateGroupStats(rows: ShadowPerfRow[]): StrategyGroupStats {
  const r3 = rows.filter((r) => r.saved_3m && r.return_3m_pct !== null).map((r) => r.return_3m_pct as number);
  const r5 = rows.filter((r) => r.saved_5m && r.return_5m_pct !== null).map((r) => r.return_5m_pct as number);
  const r10 = rows.filter((r) => r.saved_10m && r.return_10m_pct !== null).map((r) => r.return_10m_pct as number);
  const mfe10 = rows.filter((r) => r.saved_10m && r.max_favorable_excursion_10m_pct !== null).map((r) => r.max_favorable_excursion_10m_pct as number);
  const mae10 = rows.filter((r) => r.saved_10m && r.max_adverse_excursion_10m_pct !== null).map((r) => r.max_adverse_excursion_10m_pct as number);

  const avg = (arr: number[]) => (arr.length > 0 ? Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(3)) : null);
  const winRate = (arr: number[]) => (arr.length > 0 ? Number(((arr.filter((v) => v > 0).length / arr.length) * 100).toFixed(1)) : null);

  return {
    sample_count: rows.length,
    eval_count_3m: r3.length,
    eval_count_5m: r5.length,
    eval_count_10m: r10.length,
    avg_return_3m: avg(r3),
    avg_return_5m: avg(r5),
    avg_return_10m: avg(r10),
    win_rate_3m: winRate(r3),
    win_rate_5m: winRate(r5),
    win_rate_10m: winRate(r10),
    avg_mfe_10m: avg(mfe10),
    avg_mae_10m: avg(mae10),
  };
}

export class LiquidityShadowTracker {
  private perf: ShadowPerfRow[] = [];
  private pending: ShadowPendingEval[] = [];
  private updatedAt: string | null = null;
  private readonly shadowFilePath: string;
  private lastSummaryLogTs = 0;

  constructor(customPath?: string) {
    const baseDir = path.join(tradingDataRoot(), "scanner");
    this.shadowFilePath = customPath ?? path.join(baseDir, "scanner_liquidity_shadow.json");
  }

  public async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.shadowFilePath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.latest)) {
        this.perf = data.latest.slice(-3000);
      }
      this.updatedAt = data.updated_at ?? null;
    } catch {
      // file might not exist yet
    }
  }

  public onTick(params: {
    ts: string;
    tradableCandidates: ShadowCandidateMeta[];
    priceBy: Map<string, number>;
  }): {
    a_top3: string[];
    b_top3: string[];
    overlap: string[];
    a_only: string[];
    b_only: string[];
  } {
    const { ts, tradableCandidates, priceBy } = params;
    this.updatedAt = ts;

    if (tradableCandidates.length === 0) {
      return { a_top3: [], b_top3: [], overlap: [], a_only: [], b_only: [] };
    }

    // A ranking: sorted by live score_a descending
    const listA = [...tradableCandidates].sort((a, b) => b.score_a - a.score_a);
    // B ranking: sorted by score_b descending (score_a + liquidity rank bonus)
    const listB = [...tradableCandidates].sort((a, b) => b.score_b - a.score_b);

    const aTop3Candidates = listA.slice(0, 3);
    const bTop3Candidates = listB.slice(0, 3);

    const aTop3Markets = aTop3Candidates.map((c) => c.market);
    const bTop3Markets = bTop3Candidates.map((c) => c.market);

    const aSet = new Set(aTop3Markets);
    const bSet = new Set(bTop3Markets);

    const overlap = aTop3Markets.filter((m) => bSet.has(m));
    const aOnly = aTop3Markets.filter((m) => !bSet.has(m));
    const bOnly = bTop3Markets.filter((m) => !aSet.has(m));

    // Proof Log for comparison
    console.info(
      JSON.stringify({
        tag: "LIQUIDITY_PRIORITY_SHADOW_COMPARISON_PROOF",
        ts,
        a_top3: aTop3Markets,
        b_top3: bTop3Markets,
        overlap_markets: overlap,
        a_only_markets: aOnly,
        b_only_markets: bOnly,
        live_authority: "A_MOMENTUM",
        shadow_order_authority: "NONE",
      }),
    );

    // Track candidates into Shadow evaluation pool
    const capturedMarkets = new Set<string>();

    const captureCandidate = (
      c: ShadowCandidateMeta,
      rankA: number | null,
      rankB: number | null,
      sourceGroup: "A" | "B" | "BOTH",
    ) => {
      if (capturedMarkets.has(c.market)) return;
      capturedMarkets.add(c.market);

      const entryPrice = priceBy.get(c.market) ?? c.entry_price;
      if (entryPrice <= 0) return;

      const id = `${c.market}_${ts}`;
      const exists = this.perf.some((r) => r.id === id);
      if (exists) return;

      const row: ShadowPerfRow = {
        id,
        captured_at: ts,
        market: c.market,
        source_group: sourceGroup,
        rank_a: rankA,
        rank_b: rankB,
        score_a: c.score_a,
        score_b: c.score_b,
        acc_trade_price_24h: c.acc_trade_price_24h,
        liquidity_rank: c.liquidity_rank,
        liquidity_bonus: c.liquidity_bonus,
        volume_multiple: c.volume_multiple,
        rise_3m_pct: c.rise_3m_pct,
        breakout: c.breakout,
        close_upper_hold: c.close_upper_hold,
        early_entry_eligible: c.early_entry_eligible,
        add_entry_eligible: c.add_entry_eligible,
        entry_price: entryPrice,
        return_3m_pct: null,
        return_5m_pct: null,
        return_10m_pct: null,
        max_favorable_excursion_10m_pct: null,
        max_adverse_excursion_10m_pct: null,
        highest_price_10m: entryPrice,
        lowest_price_10m: entryPrice,
        saved_3m: false,
        saved_5m: false,
        saved_10m: false,
      };

      this.perf.push(row);
      this.pending.push({
        id,
        ts,
        market: c.market,
        source_group: sourceGroup,
        entry_price: entryPrice,
        due3: Date.now() + 3 * 60_000,
        due5: Date.now() + 5 * 60_000,
        due10: Date.now() + 10 * 60_000,
        done3: false,
        done5: false,
        done10: false,
        highest_price: entryPrice,
        lowest_price: entryPrice,
      });
    };

    // 1) Process Overlap (in both A top 3 and B top 3)
    for (const m of overlap) {
      const idxA = aTop3Markets.indexOf(m);
      const idxB = bTop3Markets.indexOf(m);
      const cand = aTop3Candidates[idxA]!;
      captureCandidate(cand, idxA + 1, idxB + 1, "BOTH");
    }

    // 2) Process A only
    for (const m of aOnly) {
      const idxA = aTop3Markets.indexOf(m);
      const cand = aTop3Candidates[idxA]!;
      const rankBInAll = listB.findIndex((x) => x.market === m) + 1;
      captureCandidate(cand, idxA + 1, rankBInAll > 0 ? rankBInAll : null, "A");
    }

    // 3) Process B only
    for (const m of bOnly) {
      const idxB = bTop3Markets.indexOf(m);
      const cand = bTop3Candidates[idxB]!;
      const rankAInAll = listA.findIndex((x) => x.market === m) + 1;
      captureCandidate(cand, rankAInAll > 0 ? rankAInAll : null, idxB + 1, "B");
    }

    return {
      a_top3: aTop3Markets,
      b_top3: bTop3Markets,
      overlap,
      a_only: aOnly,
      b_only: bOnly,
    };
  }

  public updatePending(priceBy: Map<string, number>): void {
    const now = Date.now();
    let hasEvaluations = false;

    for (const p of this.pending) {
      const currentPrice = priceBy.get(p.market);
      if (!currentPrice || currentPrice <= 0 || p.entry_price <= 0) continue;

      if (currentPrice > p.highest_price) p.highest_price = currentPrice;
      if (currentPrice < p.lowest_price) p.lowest_price = currentPrice;

      const ret = ((currentPrice / p.entry_price) - 1) * 100;
      const row = this.perf.find((r) => r.id === p.id);
      if (!row) continue;

      row.highest_price_10m = Math.max(row.highest_price_10m, currentPrice);
      row.lowest_price_10m = Math.min(row.lowest_price_10m, currentPrice);

      if (!p.done3 && now >= p.due3) {
        row.return_3m_pct = Number(ret.toFixed(3));
        row.saved_3m = true;
        p.done3 = true;
        hasEvaluations = true;
      }
      if (!p.done5 && now >= p.due5) {
        row.return_5m_pct = Number(ret.toFixed(3));
        row.saved_5m = true;
        p.done5 = true;
        hasEvaluations = true;
      }
      if (!p.done10 && now >= p.due10) {
        row.return_10m_pct = Number(ret.toFixed(3));
        const mfe = ((row.highest_price_10m / p.entry_price) - 1) * 100;
        const mae = ((row.lowest_price_10m / p.entry_price) - 1) * 100;
        row.max_favorable_excursion_10m_pct = Number(mfe.toFixed(3));
        row.max_adverse_excursion_10m_pct = Number(mae.toFixed(3));
        row.saved_10m = true;
        p.done10 = true;
        hasEvaluations = true;
      }
    }

    this.pending = this.pending.filter((p) => !(p.done3 && p.done5 && p.done10));

    // Periodic / Event Summary Proof log
    if (hasEvaluations || (this.perf.length > 0 && now - this.lastSummaryLogTs >= 5 * 60_000)) {
      this.lastSummaryLogTs = now;
      this.logPeriodicSummaryProof();
    }
  }

  public getSummaryReport(): ShadowComparisonReport {
    const allA = this.perf.filter((r) => r.source_group === "A" || r.source_group === "BOTH");
    const allB = this.perf.filter((r) => r.source_group === "B" || r.source_group === "BOTH");
    const aOnly = this.perf.filter((r) => r.source_group === "A");
    const bOnly = this.perf.filter((r) => r.source_group === "B");
    const overlapCount = this.perf.filter((r) => r.source_group === "BOTH").length;

    return {
      updated_at: this.updatedAt,
      mode: "shadow_only",
      live_authority: "momentum_A",
      shadow_order_authority: "NONE",
      sample_count: this.perf.length,
      active_pending_count: this.pending.length,
      latest: this.perf.slice(-500),
      summary: {
        A: calculateGroupStats(allA),
        B: calculateGroupStats(allB),
        A_only: calculateGroupStats(aOnly),
        B_only: calculateGroupStats(bOnly),
        overlap_count: overlapCount,
      },
    };
  }

  public logPeriodicSummaryProof(): void {
    const report = this.getSummaryReport();
    console.info(
      JSON.stringify({
        tag: "LIQUIDITY_PRIORITY_SHADOW_SUMMARY",
        ts: new Date().toISOString(),
        sample_count: report.sample_count,
        active_pending_count: report.active_pending_count,
        a_avg_3m: report.summary.A.avg_return_3m,
        a_avg_5m: report.summary.A.avg_return_5m,
        a_avg_10m: report.summary.A.avg_return_10m,
        b_avg_3m: report.summary.B.avg_return_3m,
        b_avg_5m: report.summary.B.avg_return_5m,
        b_avg_10m: report.summary.B.avg_return_10m,
        a_win_rate_3m: report.summary.A.win_rate_3m,
        a_win_rate_5m: report.summary.A.win_rate_5m,
        a_win_rate_10m: report.summary.A.win_rate_10m,
        b_win_rate_3m: report.summary.B.win_rate_3m,
        b_win_rate_5m: report.summary.B.win_rate_5m,
        b_win_rate_10m: report.summary.B.win_rate_10m,
        a_only_count: report.summary.A_only.sample_count,
        b_only_count: report.summary.B_only.sample_count,
        overlap_count: report.summary.overlap_count,
        a_only_avg_10m: report.summary.A_only.avg_return_10m,
        b_only_avg_10m: report.summary.B_only.avg_return_10m,
        live_authority: report.live_authority,
        shadow_order_authority: report.shadow_order_authority,
      }),
    );
  }

  public async persist(): Promise<void> {
    const dir = path.dirname(this.shadowFilePath);
    await fs.mkdir(dir, { recursive: true });
    const report = this.getSummaryReport();
    await fs.writeFile(this.shadowFilePath, JSON.stringify(report, null, 2), "utf8");
  }

  public getRows(): ShadowPerfRow[] {
    return this.perf;
  }

  public getPending(): ShadowPendingEval[] {
    return this.pending;
  }
}

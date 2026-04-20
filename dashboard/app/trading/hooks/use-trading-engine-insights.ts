import { useEffect, useMemo } from "react";

type TradeLike = {
  balances?: Array<Record<string, unknown>>;
  account_portfolio?: unknown;
  total_krw?: number;
  krw_available?: number;
};

type StrategyLike = {
  max_positions?: number | null;
  strategy_available_krw?: number | null;
  open_positions?: Record<string, { remaining_qty?: unknown }> | null;
};

export function useTradingEngineInsights<TScannerItem extends { market: string }>(params: {
  trade: TradeLike | null;
  strategy: StrategyLike | null;
  scanner: { updated_at?: string | null; items?: TScannerItem[] | null } | null;
  accountPortfolioForKpi: (v: unknown) => {
    krw_total_krw: number;
    krw_available_krw: number;
    net_pnl_krw: number;
    net_return_pct: number;
  } | null;
}) {
  const { trade, strategy, scanner, accountPortfolioForKpi } = params;

  const heldLiveSymbols = useMemo(() => {
    const out = new Set<string>();
    const DUST_NOTIONAL_KRW = 1000;
    for (const b of trade?.balances ?? []) {
      if (!b || typeof b !== "object") continue;
      const o = b as Record<string, unknown>;
      const currency = String(o.currency ?? "").toUpperCase();
      if (!currency || currency === "KRW") continue;
      const qtyRaw = Number(o.balance ?? 0) + Number(o.locked ?? 0);
      const avg = Number(o.avg_buy_price ?? 0);
      const notionalByCost = qtyRaw * avg;
      if (Number.isFinite(qtyRaw) && qtyRaw > 0 && notionalByCost >= DUST_NOTIONAL_KRW) out.add(`KRW-${currency}`);
    }
    return [...out].sort();
  }, [trade]);

  const scannerItemsExcludingHeld = useMemo(() => {
    const before = Array.isArray(scanner?.items) ? scanner.items : ([] as TScannerItem[]);
    const held = new Set(heldLiveSymbols);
    const after = before.filter((it) => !held.has(it.market));
    const excluded = before.filter((it) => held.has(it.market)).map((it) => it.market);
    return { before, after, excluded };
  }, [scanner, heldLiveSymbols]);

  const accountPositionsCount = heldLiveSymbols.length;
  const ap = useMemo(() => accountPortfolioForKpi(trade?.account_portfolio ?? null), [trade, accountPortfolioForKpi]);
  const accountTotalEquity = Number(ap?.krw_total_krw ?? trade?.total_krw ?? trade?.krw_available ?? 0);
  const accountAvailableKrw = Number(ap?.krw_available_krw ?? trade?.krw_available ?? 0);
  const accountPnlKrw = Number(ap?.net_pnl_krw ?? 0);
  const accountPnlPct = Number(ap?.net_return_pct ?? 0);

  const strategyOpenPositions = useMemo(() => {
    const ops = strategy?.open_positions ?? {};
    return Object.values(ops).filter((p) => Number((p as { remaining_qty?: unknown } | null | undefined)?.remaining_qty ?? 0) > 0).length;
  }, [strategy]);
  const strategyMaxPositions = Math.max(1, Math.floor(Number(strategy?.max_positions ?? 6)));
  const strategyRemainingSlots = Math.max(0, strategyMaxPositions - strategyOpenPositions);
  const strategyUsableKrw = Math.max(0, Number(strategy?.strategy_available_krw ?? 0));
  const perPositionBudgetKrw = Math.floor((strategyUsableKrw * 0.9) / Math.max(1, strategyMaxPositions));
  const strategyCurrentUsedKrw = strategyOpenPositions * perPositionBudgetKrw;
  const strategyMaxNeededKrw = strategyMaxPositions * perPositionBudgetKrw;
  const entryPossible = strategyRemainingSlots > 0 && strategyUsableKrw >= perPositionBudgetKrw && perPositionBudgetKrw > 0;
  const blockReason: "slot" | "fund" | "condition" | "none" = (() => {
    if (strategyRemainingSlots <= 0) return "slot";
    if (!(strategyUsableKrw >= perPositionBudgetKrw) || perPositionBudgetKrw <= 0) return "fund";
    if (scannerItemsExcludingHeld.after.length === 0) return "condition";
    return "none";
  })();
  const engineStatusLine = (() => {
    if (blockReason === "slot") return "슬롯 부족으로 신규 진입 차단";
    if (blockReason === "fund") return "자금 부족으로 신규 진입 차단";
    if (blockReason === "condition") return "진입 조건 미충족";
    return "신규 진입 가능 상태";
  })();

  useEffect(() => {
    if (!scanner?.items?.length) return;
    try {
      const beforeSymbols = scannerItemsExcludingHeld.before.map((x) => x.market).slice(0, 50);
      const afterSymbols = scannerItemsExcludingHeld.after.map((x) => x.market).slice(0, 50);
      const excludedSymbols = scannerItemsExcludingHeld.excluded.slice(0, 50);
      console.info(
        JSON.stringify({
          tag: "DEBUG_SCANNER_EXCLUDING_HELD",
          ts: new Date().toISOString(),
          held_symbols: heldLiveSymbols,
          scanner_symbols_before: beforeSymbols,
          scanner_symbols_after: afterSymbols,
          excluded_held_symbols: excludedSymbols,
          before_count: scannerItemsExcludingHeld.before.length,
          after_count: scannerItemsExcludingHeld.after.length,
        }),
      );
    } catch {
      // ignore logging failures
    }
  }, [scanner?.updated_at, heldLiveSymbols.join(","), scannerItemsExcludingHeld.before.length, scannerItemsExcludingHeld.after.length]);

  useEffect(() => {
    try {
      console.info(
        JSON.stringify({
          tag: "DEBUG_UI_ACCOUNT_STRATEGY_SPLIT",
          ts: new Date().toISOString(),
          account_positions_count: accountPositionsCount,
          strategy_open_positions: strategyOpenPositions,
          strategy_max_positions: strategyMaxPositions,
          available_krw: accountAvailableKrw,
          per_position_budget_krw: perPositionBudgetKrw,
          entry_possible: entryPossible,
          block_reason: blockReason,
        }),
      );
    } catch {
      // ignore logging failures
    }
  }, [
    accountPositionsCount,
    strategyOpenPositions,
    strategyMaxPositions,
    accountAvailableKrw,
    perPositionBudgetKrw,
    entryPossible,
    blockReason,
  ]);

  return {
    heldLiveSymbols,
    scannerItemsExcludingHeld,
    accountPositionsCount,
    accountTotalEquity,
    accountAvailableKrw,
    accountPnlKrw,
    accountPnlPct,
    strategyOpenPositions,
    strategyMaxPositions,
    strategyRemainingSlots,
    strategyUsableKrw,
    perPositionBudgetKrw,
    strategyCurrentUsedKrw,
    strategyMaxNeededKrw,
    entryPossible,
    blockReason,
    engineStatusLine,
  };
}

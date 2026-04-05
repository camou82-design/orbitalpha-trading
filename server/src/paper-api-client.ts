export type FuturesPaperDataBundle = {
    configured: boolean;
    configHint: string | null;
    summary: any | null;
    summaryDaily: any | null;
    summaryWindow: any | null;
    summaryHealth: any | null;
    dashboard: any | null;
    latestSnapshot: any | null;
    latestMeta: any | null;
    symbolRows: any[];
    healthHistoryRecent: any[];
    ledgerPerformance: {
        all: {
            totalPnlUsdNet: number;
            winTrades: number;
            lossTrades: number;
            totalTrades: number;
        };
    } | null;
    openPositions: any[];
    positionsHistory: any[];
    generatedAt: number;
};

export type PaperStatus = {
    mode: string;
    updated_at: string;
    config: {
        start_krw: number;
        entry_krw_per_trade: number;
        max_open_positions: number;
        take_profit_pct: number;
        stop_loss_pct: number;
        timeout_minutes: number;
        fee_rate: number;
    };
    account: {
        total_asset_krw: number;
        cash_krw: number;
        holdings_eval_krw: number;
        total_pnl_krw: number;
        total_return_pct: number;
        open_unrealized_pnl_krw: number;
    };
    counters: {
        open_positions: number;
        closed_wins: number;
        closed_losses: number;
        closed_timeouts: number;
    };
    holdings: Array<{
        market: string;
        entry_ts: string;
        entry_price: number;
        current_price: number;
        qty: number;
        invested_krw: number;
        unrealized_pnl_krw: number;
        unrealized_pnl_pct: number;
        signal_strength: string;
    }>;
    recent_history: Array<{
        ts: string;
        market: string;
        state: string;
        note: string;
        signal_strength: string | null;
        entry_price: number | null;
        exit_price: number | null;
        qty: number | null;
        pnl_krw: number | null;
        pnl_pct: number | null;
    }>;
};

/**
 * Map USDT balance/PnL to numerical values for the dashboard.
 * Assuming 1:1 or constant scale for simulation purpose as requested.
 */
const START_KRW = 500000;
const ENTRY_KRW_PER_TRADE = 45000;
const USD_TO_KRW_SCALE = 450; // Derived from 45000 / 100 USD trade size

export function transformFuturesBundleToPaperStatus(bundle: FuturesPaperDataBundle): PaperStatus {
    const perf = bundle.ledgerPerformance?.all || {
        totalPnlUsdNet: 0,
        winTrades: 0,
        lossTrades: 0,
        totalTrades: 0,
    };

    // 1. Build a ticker map for real-time price lookup
    const tickerMap = new Map<string, number>();
    if (bundle.latestSnapshot?.snapshots) {
        for (const s of bundle.latestSnapshot.snapshots) {
            tickerMap.set(s.symbol, Number(s.lastPrice) || 0);
        }
    }

    const totalPnlUsd = Number(perf.totalPnlUsdNet) || 0;
    const totalPnlKrw = totalPnlUsd * USD_TO_KRW_SCALE;

    // 2. Map open positions with real-time unrealized PnL
    let openUnrealizedPnlUsd = 0;
    const holdings = (bundle.openPositions || []).map((p: any) => {
        const entryPrice = Number(p.entryPrice) || 0;
        const sizeUsd = Number(p.sizeUsd) || 100;
        const curPrice = tickerMap.get(p.symbol) || entryPrice;
        const qty = entryPrice > 0 ? sizeUsd / entryPrice : 0;

        let unrealizedUsd = 0;
        if (p.side === "long") unrealizedUsd = (curPrice - entryPrice) * qty;
        else if (p.side === "short") unrealizedUsd = (entryPrice - curPrice) * qty;

        openUnrealizedPnlUsd += unrealizedUsd;

        return {
            market: String(p.symbol),
            entry_ts: new Date(p.openedAt).toISOString(),
            entry_price: entryPrice,
            current_price: curPrice,
            qty,
            invested_krw: ENTRY_KRW_PER_TRADE,
            unrealized_pnl_krw: unrealizedUsd * USD_TO_KRW_SCALE,
            unrealized_pnl_pct: entryPrice > 0 ? (unrealizedUsd / sizeUsd) * 100 : 0,
            signal_strength: p.sourceSignal || "HIGH",
        };
    });

    const openUnrealizedPnlKrw = openUnrealizedPnlUsd * USD_TO_KRW_SCALE;
    const totalAssetKrw = START_KRW + totalPnlKrw + openUnrealizedPnlKrw;
    const investedKrw = holdings.reduce((acc, h) => acc + h.invested_krw, 0);

    // 3. Map history
    const history = (bundle.positionsHistory || []).slice(-50).map((h: any) => {
        const pnlUsd = Number(h.pnlUsdNet || h.pnlUsd || 0);
        const entryPrice = Number(h.entryPrice) || 0;
        const closePrice = Number(h.closePrice) || 0;
        const sizeUsd = Number(h.sizeUsd) || 100;
        const state = pnlUsd > 0 ? "CLOSED_WIN" : pnlUsd < 0 ? "CLOSED_LOSS" : "CLOSED_TIMEOUT";

        return {
            ts: new Date(h.closedAt || h.openedAt).toISOString(),
            market: h.symbol,
            state,
            note: h.closeReason || "closed",
            signal_strength: h.sourceSignal || "HIGH",
            entry_price: entryPrice,
            exit_price: closePrice,
            qty: entryPrice > 0 ? sizeUsd / entryPrice : 0,
            pnl_krw: pnlUsd * USD_TO_KRW_SCALE,
            pnl_pct: entryPrice > 0 ? (pnlUsd / sizeUsd) * 100 : 0,
        };
    }).reverse();

    // 4. Resolve configuration (real engine values prioritized)
    const maxOpen = 3; // From engine config

    return {
        mode: (bundle.latestMeta as any)?.strategyVersion || "paper-v1",
        updated_at: new Date(bundle.generatedAt || Date.now()).toISOString(),
        config: {
            start_krw: START_KRW,
            entry_krw_per_trade: ENTRY_KRW_PER_TRADE,
            max_open_positions: maxOpen,
            take_profit_pct: 0.5,
            stop_loss_pct: 1.0,
            timeout_minutes: 0,
            fee_rate: 0.0006,
        },
        account: {
            total_asset_krw: totalAssetKrw,
            cash_krw: totalAssetKrw - investedKrw - openUnrealizedPnlKrw,
            holdings_eval_krw: investedKrw + openUnrealizedPnlKrw,
            total_pnl_krw: totalPnlKrw + openUnrealizedPnlKrw,
            total_return_pct: ((totalPnlKrw + openUnrealizedPnlKrw) / START_KRW) * 100,
            open_unrealized_pnl_krw: openUnrealizedPnlKrw,
        },
        counters: {
            open_positions: holdings.length,
            closed_wins: perf.winTrades,
            closed_losses: perf.lossTrades,
            closed_timeouts: 0,
        },
        holdings,
        recent_history: history,
    };
}

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
const START_USDT = 10000;

export function transformFuturesBundleToPaperStatus(bundle: FuturesPaperDataBundle): PaperStatus {
    const perf = bundle.ledgerPerformance?.all || {
        totalPnlUsdNet: 0,
        winTrades: 0,
        lossTrades: 0,
        totalTrades: 0,
    };

    const totalPnl = Number(perf.totalPnlUsdNet) || 0;
    const totalAsset = START_USDT + totalPnl;

    const holdings = (bundle.openPositions || []).map((p: any) => {
        const entryPrice = Number(p.entryPrice) || 0;
        const sizeUsd = Number(p.sizeUsd) || 0;
        return {
            market: String(p.symbol),
            entry_ts: new Date(p.openedAt).toISOString(),
            entry_price: entryPrice,
            current_price: entryPrice, // fallback as we don't have live ticker in bundle
            qty: entryPrice > 0 ? sizeUsd / entryPrice : 0,
            invested_krw: sizeUsd,
            unrealized_pnl_krw: 0,
            unrealized_pnl_pct: 0,
            signal_strength: p.sourceSignal || "HIGH",
        };
    });

    const invested = holdings.reduce((acc, h) => acc + h.invested_krw, 0);

    const history = (bundle.positionsHistory || []).slice(-50).map((h: any) => {
        const pnl = Number(h.pnlUsdNet || h.pnlUsd || 0);
        const state = pnl > 0 ? "CLOSED_WIN" : pnl < 0 ? "CLOSED_LOSS" : "CLOSED_TIMEOUT";
        return {
            ts: new Date(h.closedAt || h.openedAt).toISOString(),
            market: h.symbol,
            state,
            note: h.closeReason || "closed",
            signal_strength: h.sourceSignal || "HIGH",
            entry_price: Number(h.entryPrice) || 0,
            exit_price: Number(h.closePrice) || 0,
            qty: Number(h.entryPrice) > 0 ? Number(h.sizeUsd) / Number(h.entryPrice) : 0,
            pnl_krw: pnl,
            pnl_pct: Number(h.entryPrice) > 0 ? ((Number(h.closePrice) / Number(h.entryPrice)) - 1) * 100 : 0,
        };
    }).reverse();

    return {
        mode: (bundle.latestMeta as any)?.strategyVersion || "paper-v1",
        updated_at: new Date(bundle.generatedAt || Date.now()).toISOString(),
        config: {
            start_krw: START_USDT,
            entry_krw_per_trade: 100,
            max_open_positions: 10,
            take_profit_pct: 0.5,
            stop_loss_pct: 1.0,
            timeout_minutes: 0,
            fee_rate: 0.0005,
        },
        account: {
            total_asset_krw: totalAsset,
            cash_krw: totalAsset - invested,
            holdings_eval_krw: invested,
            total_pnl_krw: totalPnl,
            total_return_pct: (totalPnl / START_USDT) * 100,
            open_unrealized_pnl_krw: 0,
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

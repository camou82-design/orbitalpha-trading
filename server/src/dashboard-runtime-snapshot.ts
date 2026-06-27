import fs from "node:fs";
import path from "node:path";

const HISTORY_FILE = path.join(process.cwd(), "portfolio_history.json");
let portfolioHistoryCache: Array<{
  ts: string;
  total_asset_equity_krw: number;
  spot_trading_equity_krw: number;
  unrealized_pnl_krw: number;
  realized_pnl_krw: number;
}> = [];

try {
  if (fs.existsSync(HISTORY_FILE)) {
    portfolioHistoryCache = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  }
} catch {}

export type DashboardMonitorSnap = {
  monitor_instance_id: string | null;
  monitor_started_at: string | null;
  process_pid: number;
  last_strategy_tick_at: string | null;
  last_scanner_tick_at: string | null;
  last_market_state_tick_at: string | null;
};

export type DashboardFinalizeDeps = {
  strategyStatus: Record<string, unknown>;
  monitor: DashboardMonitorSnap;
  apiStartedAtIso: string;
  surgeCandidatesPath: string | null | undefined;
};

function readCandidateMtimeIso(pathLike: string | null | undefined): string | null {
  if (!pathLike) return null;
  try {
    return fs.statSync(pathLike).mtime.toISOString();
  } catch {
    return null;
  }
}

function strategyBookQty(open: Record<string, unknown>, early: Record<string, unknown>, mk: string): number {
  const p = open[mk] as Record<string, unknown> | undefined;
  if (p && typeof p === "object") {
    const rq = Number(p.remaining_qty);
    const q = Number(p.qty);
    const v = Number.isFinite(rq) ? rq : Number.isFinite(q) ? q : 0;
    return v > 0 ? v : 0;
  }
  const ex = early[mk] as Record<string, unknown> | undefined;
  if (ex && typeof ex === "object") {
    const q = Number(ex.qty);
    return Number.isFinite(q) && q > 0 ? q : 0;
  }
  return 0;
}

export function buildPositionSourceSummary(
  body: Record<string, unknown>,
  strategySt: Record<string, unknown>,
): Record<string, unknown> {
  const ledger = body.ledger_reconcile as { zeroed?: unknown[]; clamped?: unknown[] } | null | undefined;
  const zeroed = new Set((Array.isArray(ledger?.zeroed) ? ledger!.zeroed : []).map(String));
  const clamped = new Set((Array.isArray(ledger?.clamped) ? ledger!.clamped : []).map(String));
  const open = (strategySt.open_positions ?? {}) as Record<string, unknown>;
  const early = (strategySt.early_positions ?? {}) as Record<string, unknown>;
  const balances = Array.isArray(body.balances) ? (body.balances as Record<string, unknown>[]) : [];
  const lastOrder = body.last_order as Record<string, unknown> | null | undefined;

  const byMarket: Record<string, Record<string, unknown>> = {};
  const PLACEBUY_RECENT_MS = 7 * 24 * 3600 * 1000;

  for (const b of balances) {
    const currency = String(b?.currency ?? "").toUpperCase();
    if (!currency || currency === "KRW") continue;
    const mk = `KRW-${currency}`;
    const qty = Number(b.balance) + Number(b.locked);
    if (!(qty > 0)) continue;
    const strategyQty = strategyBookQty(open, early, mk);
    const managed = strategyQty > 0;
    const reconcileFlag = zeroed.has(mk) || clamped.has(mk);
    let classification: "managed" | "passive" | "suspected_orphan_passive";
    if (managed) classification = "managed";
    else if (reconcileFlag) classification = "suspected_orphan_passive";
    else classification = "passive";

    let LIVE_PLACEBUY_RESULT_recent_ok = false;
    if (
      lastOrder &&
      lastOrder.side === "buy" &&
      lastOrder.market === mk &&
      lastOrder.status === "ok" &&
      typeof lastOrder.ts === "string"
    ) {
      LIVE_PLACEBUY_RESULT_recent_ok = Date.now() - Date.parse(String(lastOrder.ts)) < PLACEBUY_RECENT_MS;
    }

    const pos = (open[mk] ?? early[mk]) as Record<string, unknown> | undefined;
    const engine_bucket = pos && typeof pos.engine_bucket === "string" ? pos.engine_bucket : null;
    const strict_exit = Boolean(pos?.strict_exit ?? false);

    let ui_primary_label_ko = "계좌 보유 / 자동매매 관리 아님";
    const ui_hints: string[] = [];

    if (managed) {
      ui_primary_label_ko =
        engine_bucket === "surge" ? "자동매매 관리 중 (급등주 버킷)" : "자동매매 관리 중 (CORE 등 엔진 버킷)";
      if (strict_exit) ui_hints.push("손절·익절 관리 대상(strict_exit)");
      const st = typeof pos?.strategy_type === "string" ? pos.strategy_type : null;
      if (st) ui_hints.push(`전략 유형: ${st}`);
    } else if (classification === "suspected_orphan_passive") {
      ui_primary_label_ko = "장부 불일치 의심";
      ui_hints.push("ledger reconcile가 이 종목에 플래그를 남겼습니다 — SPOT 상태를 확인하세요.");
    }
    if (!managed && LIVE_PLACEBUY_RESULT_recent_ok) {
      ui_hints.push("last_order 기준 최근 매수 성공 기록이 있습니다 — 장부/관리 상태를 교차 확인하세요.");
    }

    const entry_mode = pos && typeof (pos as any).entry_mode === "string" ? (pos as any).entry_mode : null;
    const entry_origin = pos && typeof pos.entry_origin === "string" ? pos.entry_origin : null;
    const exit_policy_attached = Boolean(pos?.exit_policy_attached ?? false);
    const entry_stop_price = pos && Number(pos.entry_stop_price) > 0 ? Number(pos.entry_stop_price) : null;
    const surge_stop_price = pos && Number((pos as any).surge_stop_price) > 0 ? Number((pos as any).surge_stop_price) : null;
    const surge_take_profit_price = pos && Number((pos as any).surge_take_profit_price) > 0 ? Number((pos as any).surge_take_profit_price) : null;
    const entry_price_for_pct = pos && Number(pos.entry_price) > 0 ? Number(pos.entry_price) : null;

    // 현재가 대비 stop 거리 % (stop이 있고 entry_price가 있을 때만 계산)
    const stopRef = entry_stop_price ?? surge_stop_price;
    const stop_distance_pct_from_entry: number | null =
      entry_price_for_pct && stopRef
        ? Number((((stopRef - entry_price_for_pct) / entry_price_for_pct) * 100).toFixed(2))
        : null;

    byMarket[mk] = {
      classification,
      engine_bucket,
      strict_exit_managed: strict_exit,
      entry_mode,
      entry_origin,
      exit_policy_attached,
      entry_stop_price,
      surge_stop_price,
      surge_take_profit_price,
      stop_distance_pct_from_entry,
      rescue_add_count: pos?.rescue_add_count ?? 0,
      last_rescue_add_at: pos?.last_rescue_add_at ?? null,
      rescue_add_total_krw: pos?.rescue_add_total_krw ?? null,
      rescue_add_reason: pos?.rescue_add_reason ?? null,
      rescue_add_avg_before: pos?.rescue_add_avg_before ?? null,
      rescue_add_avg_after_est: pos?.rescue_add_avg_after_est ?? null,
      rescue_add_stop_rebased: pos?.rescue_add_stop_rebased ?? null,
      spot_qty: qty,
      strategy_book_qty: strategyQty,
      reconcile_zeroed: zeroed.has(mk),
      reconcile_clamped: clamped.has(mk),
      LIVE_PLACEBUY_RESULT_recent_ok,
      LIVE_MANAGED_POSITION_REGISTERED_BOOK: managed,
      SPOT_LEDGER_ADJUST_HINT: reconcileFlag,
      ui_primary_label_ko,
      ui_hints,
      display_lines_ko: [ui_primary_label_ko, ...ui_hints],
    };
  }

  return { by_market: byMarket, ledger_reconcile: ledger ?? null };
}

/**
 * 응답 직전 호출: `dashboard_runtime`을 항상 새로 붙인다(숨겨진 API 캐시에도 시각 필드가 따라가게).
 */
export function finalizeDashboardTradeStatusPayload(
  rawBody: Record<string, unknown>,
  deps: DashboardFinalizeDeps,
): Record<string, unknown> {
  const server_now = new Date().toISOString();
  const ap = rawBody.account_portfolio as Record<string, unknown> | null | undefined;
  const holdingsAsOf = ap && typeof ap.as_of === "string" ? ap.as_of : null;

  // Portfolio History snapshot accumulation
  let addedNew = false;
  try {
    const lastHistory = portfolioHistoryCache[portfolioHistoryCache.length - 1];
    const currentMinuteStr = new Date(server_now).toISOString().slice(0, 16);
    const lastMinuteStr = lastHistory ? new Date(lastHistory.ts).toISOString().slice(0, 16) : "";

    if (currentMinuteStr !== lastMinuteStr || portfolioHistoryCache.length === 0) {
      const total_asset_equity_krw = Number(rawBody.totalAssetEquityKrw ?? rawBody.total_asset_equity_krw ?? ap?.total_evaluated_krw ?? 0);
      const spot_trading_equity_krw = Number(rawBody.spotTradingEquityKrw ?? rawBody.spot_trading_equity_krw ?? 0);
      const realized_pnl_krw = Number(deps.strategyStatus.strategy_pnl_krw ?? 0);
      
      let unrealized_pnl_krw = 0;
      try {
        const open = (deps.strategyStatus.open_positions ?? {}) as Record<string, any>;
        for (const k of Object.keys(open)) {
          unrealized_pnl_krw += Number(open[k]?.pnl_krw ?? 0);
        }
      } catch {}

      portfolioHistoryCache.push({
        ts: server_now,
        total_asset_equity_krw,
        spot_trading_equity_krw,
        unrealized_pnl_krw,
        realized_pnl_krw,
      });

      if (portfolioHistoryCache.length > 150) {
        portfolioHistoryCache.shift();
      }
      addedNew = true;
    }
  } catch (err) {
    console.error("PORTFOLIO_HISTORY_PERSIST_FAILED", err);
  }

  if (addedNew) {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(portfolioHistoryCache, null, 2), "utf8");
    } catch (err) {
      console.error("PORTFOLIO_HISTORY_PERSIST_FAILED", err);
    }
  }

  const position_source_summary = buildPositionSourceSummary(rawBody, deps.strategyStatus);
  const lastOrder = rawBody.last_order as Record<string, unknown> | null | undefined;

  const recent_placebuy_results =
    lastOrder && typeof lastOrder === "object"
      ? [
          {
            market: String(lastOrder.market ?? ""),
            side: lastOrder.side,
            ok: lastOrder.status === "ok",
            ts: lastOrder.ts,
            detail: lastOrder.detail,
          },
        ]
      : [];

  const lm = deps.monitor;
  const scannerTsIso = lm.last_scanner_tick_at;
  const scannerEpoch = scannerTsIso ? Date.parse(scannerTsIso) : NaN;
  const scanner_age_seconds = Number.isFinite(scannerEpoch) ? Math.max(0, (Date.now() - scannerEpoch) / 1000) : null;

  const liveTs = lm.last_strategy_tick_at ? Date.parse(lm.last_strategy_tick_at) : NaN;
  const live_loop_age_seconds = Number.isFinite(liveTs) ? Math.max(0, (Date.now() - liveTs) / 1000) : null;

  const reconcile = rawBody.ledger_reconcile as { zeroed?: string[]; clamped?: string[] } | undefined;
  const recent_reconcile_actions: string[] = [];
  if (reconcile?.zeroed?.length)
    recent_reconcile_actions.push(`ledger_zeroed:${reconcile.zeroed.slice(0, 12).join(",")}`);
  if (reconcile?.clamped?.length)
    recent_reconcile_actions.push(`ledger_clamped:${reconcile.clamped.slice(0, 12).join(",")}`);

  const bym = position_source_summary.by_market as Record<string, Record<string, unknown>>;
  const managed_positions = Object.keys(bym).filter((mk) => bym[mk]?.classification === "managed");
  const passive_positions = Object.keys(bym).filter((mk) => bym[mk]?.classification === "passive");
  const orphan_positions = Object.keys(bym).filter((mk) => bym[mk]?.classification === "suspected_orphan_passive");

  const dashboard_runtime = {
    server_now,
    api_response_at: server_now,
    process_pid: deps.monitor.process_pid,
    portfolio_history: portfolioHistoryCache,
    git_head:
      (typeof process.env.ORBITALPHA_GIT_HEAD === "string" && process.env.ORBITALPHA_GIT_HEAD.trim()) ||
      (typeof process.env.GIT_COMMIT === "string" && process.env.GIT_COMMIT.trim().slice(0, 12)) ||
      null,
    api_started_at: deps.apiStartedAtIso,
    live_loop_latest_ts: lm.last_strategy_tick_at ?? null,
    live_loop_age_seconds,
    capital_policy_latest: {
      source_updated_at: server_now,
      spot_trading_equity_krw: rawBody.spotTradingEquityKrw ?? rawBody.spot_trading_equity_krw ?? null,
      excluded_usdt_value_krw: rawBody.excludedUsdtValueKrw ?? rawBody.excluded_usdt_value_krw ?? null,
      okx_transfer_reserve_krw: rawBody.okxTransferReserveKrw ?? rawBody.okx_transfer_reserve_krw ?? null,
      total_asset_equity_krw: rawBody.totalAssetEquityKrw ?? rawBody.total_asset_equity_krw ?? null,
      core_cap_amount: rawBody.coreCapAmount ?? rawBody.core_cap_amount ?? null,
      surge_cap_amount: rawBody.surgeCapAmount ?? rawBody.surge_cap_amount ?? null,
      core_used_capital_krw: rawBody.coreUsedCapital ?? rawBody.core_used_capital_krw ?? null,
      surge_used_capital_krw: rawBody.surgeUsedCapital ?? rawBody.surge_used_capital_krw ?? null,
      core_pending_buy_reserved_krw: rawBody.corePendingBuyReserved ?? rawBody.core_pending_buy_reserved_krw ?? null,
      surge_pending_buy_reserved_krw: rawBody.surgePendingBuyReserved ?? rawBody.surge_pending_buy_reserved_krw ?? null,
      core_remaining_krw: rawBody.coreRemaining ?? rawBody.core_remaining_krw ?? null,
      surge_remaining_krw: rawBody.surgeRemaining ?? rawBody.surge_remaining_krw ?? null,
    },
    holdings_snapshot: {
      source_updated_at: holdingsAsOf ?? server_now,
      total_evaluated_krw: ap?.total_evaluated_krw ?? null,
    },
    scanner_updated_at: lm.last_scanner_tick_at ?? null,
    scanner_age_seconds,
    market_state_latest_ts: lm.last_market_state_tick_at ?? null,
    candidate_updated_at: readCandidateMtimeIso(deps.surgeCandidatesPath ?? null),
    position_state_updated_at: server_now,
    position_source_summary,
    orphan_positions,
    managed_positions,
    passive_positions,
    recent_placebuy_results,
    recent_reconcile_actions,
    monitor_instance_id: lm.monitor_instance_id,
    monitor_started_at: lm.monitor_started_at,
    dashboard_data_version: 2,
  };

  return { ...rawBody, dashboard_runtime };
}

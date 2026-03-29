const UPBIT = "https://api.upbit.com";

export type UpbitCandle = {
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
  candle_date_time_kst: string;
};

export type UpbitTicker = {
  market: string;
  trade_price: number;
  signed_change_rate?: number;
  acc_trade_price_24h?: number;
};

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${UPBIT}${path}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Upbit ${path} → ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json() as Promise<T>;
}

/** Newest candle first — reverse to oldest-first for indicators. */
export async function fetchMinuteCandles(
  market: string,
  unit: 1 | 5 | 15,
  count: number,
): Promise<UpbitCandle[]> {
  const path = `/v1/candles/minutes/${unit}?market=${encodeURIComponent(market)}&count=${count}`;
  const rows = await fetchJson<UpbitCandle[]>(path);
  return [...rows].reverse();
}

/**
 * 1차 MVP 고정 감시 (USDT/AKT 등 제외 — 목록에 아예 포함하지 않음).
 */
export const MVP_WATCH_MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;

/** `excluded`에 있는 마켓(대소문자·공백 정규화 없음 — Upbit 코드 그대로)은 감시에서 뺀다. */
export function getMvpWatchMarkets(excluded: readonly string[]): string[] {
  const ex = new Set(excluded);
  return MVP_WATCH_MARKETS.filter((m) => !ex.has(m));
}

export function resolveWatchMarkets(excluded: readonly string[] = []): Promise<string[]> {
  return Promise.resolve(getMvpWatchMarkets(excluded));
}

function numTradePrice(v: unknown): number {
  const p = Number(v);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

export async function fetchTickers(markets: string[]): Promise<UpbitTicker[]> {
  if (markets.length === 0) return [];
  const q = encodeURIComponent(markets.join(","));
  const rows = await fetchJson<UpbitTicker[]>(`/v1/ticker?markets=${q}`);
  return rows.map((r) => ({
    ...r,
    trade_price: numTradePrice((r as { trade_price?: unknown }).trade_price),
  }));
}

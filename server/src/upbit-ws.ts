import WebSocket from "ws";

const UPBIT_WS = "wss://socket.upbit.com/websocket/v1";

export type TickerWsHandle = {
  stop: () => void;
  getLastPrice: (market: string) => number | undefined;
  getLastMessageAt: () => number | undefined;
  isConnected: () => boolean;
};

function parseTickerSimple(raw: string): { cd: string; tp: number } | null {
  try {
    const d = JSON.parse(raw) as unknown;
    const tryOne = (o: unknown): { cd: string; tp: number } | null => {
      if (!o || typeof o !== "object") return null;
      const r = o as Record<string, unknown>;
      const cd = r.cd ?? r.code;
      const tp = r.tp ?? r.trade_price;
      if (typeof cd !== "string") return null;
      const n = typeof tp === "number" ? tp : typeof tp === "string" ? Number(tp) : NaN;
      if (!Number.isFinite(n)) return null;
      return { cd, tp: n };
    };
    if (Array.isArray(d)) {
      for (const item of d) {
        const p = tryOne(item);
        if (p) return p;
      }
      return null;
    }
    return tryOne(d);
  } catch {
    return null;
  }
}

/**
 * Upbit 현물 ticker WebSocket. REST 캔들과 병행 (실시간 시세 수신).
 */
export function startUpbitTickerWs(
  getCodes: () => string[],
  opts?: { onStatus?: (msg: string) => void },
): TickerWsHandle {
  const lastPrice = new Map<string, number>();
  let lastMessageAt: number | undefined;
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;

  const notify = (msg: string) => opts?.onStatus?.(msg);

  const subscribe = (socket: WebSocket, codes: string[]) => {
    if (codes.length === 0) return;
    const payload = [
      { ticket: `orbitalpha-${Date.now()}` },
      { type: "ticker", codes, isOnlyRealtime: true },
      { format: "SIMPLE" },
    ];
    socket.send(JSON.stringify(payload));
  };

  const connect = () => {
    if (stopped) return;
    const codes = getCodes();
    if (codes.length === 0) {
      notify("ws_skip_empty_codes");
      return;
    }

    ws = new WebSocket(UPBIT_WS);

    ws.on("open", () => {
      connected = true;
      notify("ws_open");
      subscribe(ws!, codes);
    });

    ws.on("message", (raw) => {
      lastMessageAt = Date.now();
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const p = parseTickerSimple(text);
      if (p) lastPrice.set(p.cd, p.tp);
    });

    ws.on("close", () => {
      connected = false;
      notify("ws_close");
      if (!stopped) {
        reconnectTimer = setTimeout(() => connect(), 3_000);
      }
    });

    ws.on("error", (err) => {
      notify(`ws_error:${String(err)}`);
    });
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    },
    getLastPrice: (market: string) => lastPrice.get(market),
    getLastMessageAt: () => lastMessageAt,
    isConnected: () => connected,
  };
}

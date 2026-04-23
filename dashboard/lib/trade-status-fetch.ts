/** 프록시/직렬화 이슈로 api_connected 가 문자열로 올 수 있음 — 검증 전에 boolean 으로 맞춘다. */
export function normalizeTradeStatusJson(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const o = body as Record<string, unknown>;
  const ac = o.api_connected;
  if (ac === true || ac === "true" || ac === 1) o.api_connected = true;
  else if (ac === false || ac === "false" || ac === 0) o.api_connected = false;
}

/** Validates `/api/v1/trade/status` (and 동일 페이로드의 `/api/v1/account/status`) JSON. */
export function isValidTradeStatusPayload(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  normalizeTradeStatusJson(o);
  if (typeof o.api_connected !== "boolean") return false;
  const mode = o.trading_mode;
  if (mode === undefined) return true;
  if (mode === "paper" || mode === "live") return true;
  return typeof mode === "string" && mode.length > 0;
}

function readFailureFromBody(body: unknown, httpStatus: number): { code: string; message: string } {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const c = o.account_sync_failure_code;
    const m = o.account_sync_failure_message;
    if (typeof c === "string" && typeof m === "string") return { code: c, message: m };
    if (typeof c === "string") return { code: c, message: typeof o.error === "string" ? o.error : `HTTP ${httpStatus}` };
    if (typeof o.error === "string") return { code: `http_${httpStatus}`, message: o.error };
  }
  return { code: `http_${httpStatus}`, message: `HTTP ${httpStatus}` };
}

export type TradeStatusFetchResult = {
  httpStatus: number;
  body: unknown | null;
  payload: unknown | null;
  failureCode: string | null;
  failureMessage: string | null;
};

let lastGoodTradeStatusPayload: unknown | null = null;

export function isSoftTradeStatusFailureCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return (
    code === "client_fetch_aborted" ||
    code === "client_fetch_timeout" ||
    code === "client_fetch_failed" ||
    code === "soft_fetch_failed_with_last_good"
  );
}

export async function fetchTradeStatusDetailed(apiBase: string): Promise<TradeStatusFetchResult> {
  void apiBase;
  const ts = Date.now();
  let httpStatus = 0;
  let body: unknown | null = null;
  try {
    // 동일 본문(account_portfolio 포함): GET /api/v1/account/status
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`/api/v1/trade/status?_=${ts}`, {
      cache: "no-store",
      credentials: "include",
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    httpStatus = r.status;
    const text = await r.text();
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    if (body && typeof body === "object") normalizeTradeStatusJson(body);
    if (!r.ok) {
      const { code, message } = readFailureFromBody(body, r.status);
      return { httpStatus, body, payload: null, failureCode: code, failureMessage: message };
    }
    if (body && isValidTradeStatusPayload(body)) {
      lastGoodTradeStatusPayload = body;
      return { httpStatus, body, payload: body, failureCode: null, failureMessage: null };
    }
    return {
      httpStatus,
      body,
      payload: null,
      failureCode: "invalid_trade_status_payload",
      failureMessage: "Response JSON is not a valid trade status shape",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    const isAbort = e instanceof Error && e.name === "AbortError";
    const failureCode = isAbort
      ? "client_fetch_aborted"
      : /timeout|timed out|etimedout|und_err_connect_timeout/.test(lower)
        ? "client_fetch_timeout"
        : "client_fetch_failed";
    if (lastGoodTradeStatusPayload) {
      return {
        httpStatus,
        body,
        payload: lastGoodTradeStatusPayload,
        failureCode: "soft_fetch_failed_with_last_good",
        failureMessage: msg.slice(0, 400),
      };
    }
    return {
      httpStatus,
      body,
      payload: null,
      failureCode,
      failureMessage: msg.slice(0, 400),
    };
  }
}

export async function fetchTradeStatusOnce(apiBase: string): Promise<unknown | null> {
  const r = await fetchTradeStatusDetailed(apiBase);
  return r.payload;
}

function logTradeStatusAttempt(
  context: string,
  attempt: number,
  result: TradeStatusFetchResult,
  extra?: { api_connected?: boolean },
) {
  const row = {
    context,
    attempt,
    httpStatus: result.httpStatus,
    api_connected: extra?.api_connected,
    failureCode: result.failureCode,
    failureMessage: result.failureMessage?.slice(0, 240),
    hasValidPayload: Boolean(result.payload),
  };
  console.log("[orbitalpha-trading] trade/status attempt", row);
}

export type TradeStatusUntilSyncedOptions = {
  maxAttempts?: number;
  /** 전체 재시도 상한(밀리초). 초과 시 마지막 유효 payload 또는 null 로 종료 — 무한 대기 방지 */
  maxWallMs?: number;
  /** When set, each attempt and the final summary are logged to the console. */
  logContext?: "login" | "trading_page_initial";
};

export type TradeStatusUntilSyncedResult = {
  payload: unknown | null;
  attempts: number;
  lastFetch: TradeStatusFetchResult | null;
};

/**
 * Retries while session/upbit may still be settling: 401 → retry, valid body with keys but !api_connected → retry.
 * Returns last valid payload, or null if never received a valid body.
 */
export async function fetchTradeStatusUntilSynced(
  apiBase: string,
  opts?: TradeStatusUntilSyncedOptions,
): Promise<unknown | null> {
  const r = await fetchTradeStatusUntilSyncedWithLog(apiBase, opts);
  return r.payload;
}

export async function fetchTradeStatusUntilSyncedWithLog(
  apiBase: string,
  opts?: TradeStatusUntilSyncedOptions,
): Promise<TradeStatusUntilSyncedResult> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 15);
  const maxWallMs = opts?.maxWallMs ?? 22_000;
  const deadline = Date.now() + maxWallMs;
  const ctx = opts?.logContext ?? "trading_page_initial";
  let lastGood: unknown | null = null;
  let lastFetch: TradeStatusFetchResult | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() > deadline) {
      if (opts?.logContext) {
        console.log("[orbitalpha-trading] trade/status sync wall clock exceeded", {
          context: ctx,
          maxWallMs,
          attempts_done: i,
          lastHttpStatus: lastFetch?.httpStatus,
        });
      }
      return { payload: lastGood, attempts: i, lastFetch };
    }
    const attempt = i + 1;
    const res = await fetchTradeStatusDetailed(apiBase);
    lastFetch = res;

    if (opts?.logContext) {
      const ac =
        res.payload && typeof res.payload === "object"
          ? (res.payload as { api_connected?: boolean }).api_connected
          : undefined;
      logTradeStatusAttempt(ctx, attempt, res, { api_connected: ac });
    }

    if (res.payload) {
      lastGood = res.payload;
      const o = res.payload as Record<string, unknown>;
      if (o.api_connected === true) {
        if (opts?.logContext) {
          console.log("[orbitalpha-trading] trade/status sync done", {
            context: ctx,
            attempts: attempt,
            outcome: "api_connected",
            httpStatus: res.httpStatus,
          });
        }
        return { payload: res.payload, attempts: attempt, lastFetch };
      }
      const hasKeys = o.env_access_key_present === true && o.env_secret_key_present === true;
      if (!hasKeys) {
        if (opts?.logContext) {
          console.log("[orbitalpha-trading] trade/status sync done", {
            context: ctx,
            attempts: attempt,
            outcome: "no_env_keys_stop_retry",
            account_sync_failure_code: o.account_sync_failure_code,
          });
        }
        return { payload: res.payload, attempts: attempt, lastFetch };
      }
    }

    if (i < maxAttempts - 1) {
      if (res.httpStatus === 404) {
        if (opts?.logContext) {
          console.log("[orbitalpha-trading] trade/status sync failed immediately (404)", {
            context: ctx,
            attempts: attempt,
            httpStatus: 404,
          });
        }
        return { payload: lastGood, attempts: attempt, lastFetch: res };
      }
      const delayMs = Math.min(150 + i * 95, 1500);
      await new Promise((r2) => setTimeout(r2, delayMs));
    }

  }

  if (opts?.logContext) {
    const o = lastGood && typeof lastGood === "object" ? (lastGood as Record<string, unknown>) : null;
    console.log("[orbitalpha-trading] trade/status sync done", {
      context: ctx,
      attempts: maxAttempts,
      outcome: lastGood ? "exhausted_retries_api_still_disconnected" : "no_valid_payload",
      lastHttpStatus: lastFetch?.httpStatus,
      lastFailureCode: lastFetch?.failureCode,
      lastAccountCode: o?.account_sync_failure_code,
      lastApiReason: typeof o?.api_reason === "string" ? o.api_reason.slice(0, 200) : o?.api_reason,
    });
  }

  return { payload: lastGood ?? lastGoodTradeStatusPayload, attempts: maxAttempts, lastFetch };
}

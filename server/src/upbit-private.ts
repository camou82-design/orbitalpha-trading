import crypto from "node:crypto";

const UPBIT = "https://api.upbit.com";

function base64UrlJson(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeJwt(secretKey: string, payload: Record<string, unknown>): string {
  const header = { alg: "HS512", typ: "JWT" };
  const head = base64UrlJson(header);
  const body = base64UrlJson(payload);
  const unsigned = `${head}.${body}`;
  const sig = crypto.createHmac("sha512", secretKey).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

function buildAuthHeader(accessKey: string, secretKey: string, queryOrParams?: URLSearchParams | Record<string, unknown>): string {
  const payload: Record<string, unknown> = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };
  let queryString = "";
  if (queryOrParams instanceof URLSearchParams) {
    queryString = queryOrParams.toString();
  } else if (queryOrParams && typeof queryOrParams === "object") {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(queryOrParams)) {
      if (v !== undefined && v !== null) {
        searchParams.set(k, String(v));
      }
    }
    queryString = searchParams.toString();
  }

  if (queryString) {
    payload.query_hash = crypto.createHash("sha512").update(queryString).digest("hex");
    payload.query_hash_alg = "SHA512";
  }
  const jwt = makeJwt(secretKey, payload);
  return `Bearer ${jwt}`;
}

async function upbitFetch<T>(args: {
  method: "GET" | "POST";
  path: string;
  accessKey: string;
  secretKey: string;
  query?: URLSearchParams;
  jsonBody?: Record<string, unknown>;
  body?: URLSearchParams;
}): Promise<T> {
  const queryOrParams = args.query ?? args.jsonBody ?? args.body;
  const auth = buildAuthHeader(args.accessKey, args.secretKey, queryOrParams);
  const url = `${UPBIT}${args.path}${args.query ? `?${args.query.toString()}` : ""}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: auth,
  };
  let bodyStr: string | undefined = undefined;

  if (args.method === "POST") {
    if (args.jsonBody) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      bodyStr = JSON.stringify(args.jsonBody);
    } else if (args.body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      bodyStr = args.body.toString();
    }
  }

  const r = await fetch(url, {
    method: args.method,
    headers,
    body: bodyStr,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Upbit private ${args.path} -> ${r.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

export type UpbitAccount = {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified: boolean;
  unit_currency: string;
};

export type UpbitOrderResponse = {
  uuid: string;
  identifier?: string;
  side: "bid" | "ask";
  ord_type: string;
  price: string | null;
  state: string;
  market: string;
  created_at: string;
  volume: string;
  remaining_volume: string;
  reserved_fee: string;
  remaining_fee: string;
  paid_fee: string;
  locked: string;
  executed_volume: string;
  trades_count: number;
  trades?: any[];
  executed_funds?: string;
};

export function fetchAccounts(accessKey: string, secretKey: string): Promise<UpbitAccount[]> {
  return upbitFetch<UpbitAccount[]>({
    method: "GET",
    path: "/v1/accounts",
    accessKey,
    secretKey,
  });
}

export function placeMarketBuy(args: {
  accessKey: string;
  secretKey: string;
  market: string;
  krwAmount: number;
  identifier?: string;
}): Promise<UpbitOrderResponse> {
  const jsonBody: Record<string, unknown> = {
    market: args.market,
    side: "bid",
    ord_type: "price",
    price: String(Math.floor(args.krwAmount)),
  };
  if (args.identifier) {
    jsonBody.identifier = args.identifier;
  }
  return upbitFetch<UpbitOrderResponse>({
    method: "POST",
    path: "/v1/orders",
    accessKey: args.accessKey,
    secretKey: args.secretKey,
    jsonBody,
  });
}

export function placeMarketSell(args: {
  accessKey: string;
  secretKey: string;
  market: string;
  volume: number;
  identifier?: string;
}): Promise<UpbitOrderResponse> {
  const jsonBody: Record<string, unknown> = {
    market: args.market,
    side: "ask",
    ord_type: "market",
    volume: String(args.volume),
  };
  if (args.identifier) {
    jsonBody.identifier = args.identifier;
  }
  return upbitFetch<UpbitOrderResponse>({
    method: "POST",
    path: "/v1/orders",
    accessKey: args.accessKey,
    secretKey: args.secretKey,
    jsonBody,
  });
}

export function fetchOrderDetails(
  accessKey: string,
  secretKey: string,
  uuid: string,
): Promise<UpbitOrderResponse> {
  const query = new URLSearchParams();
  query.set("uuid", uuid);
  return upbitFetch<UpbitOrderResponse>({
    method: "GET",
    path: "/v1/order",
    accessKey,
    secretKey,
    query,
  });
}

export function fetchOrderByIdentifier(
  accessKey: string,
  secretKey: string,
  identifier: string,
): Promise<UpbitOrderResponse> {
  const query = new URLSearchParams();
  query.set("identifier", identifier);
  return upbitFetch<UpbitOrderResponse>({
    method: "GET",
    path: "/v1/order",
    accessKey,
    secretKey,
    query,
  });
}

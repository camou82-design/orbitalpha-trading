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

function buildAuthHeader(accessKey: string, secretKey: string, query?: URLSearchParams): string {
  const payload: Record<string, unknown> = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };
  if (query && [...query.keys()].length > 0) {
    const raw = query.toString();
    payload.query_hash = crypto.createHash("sha512").update(raw).digest("hex");
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
  body?: URLSearchParams;
}): Promise<T> {
  const query = args.query ?? args.body;
  const auth = buildAuthHeader(args.accessKey, args.secretKey, query);
  const url = `${UPBIT}${args.path}${args.query ? `?${args.query.toString()}` : ""}`;
  const r = await fetch(url, {
    method: args.method,
    headers: {
      Accept: "application/json",
      Authorization: auth,
      ...(args.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: args.method === "POST" ? args.body?.toString() : undefined,
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
}): Promise<UpbitOrderResponse> {
  const body = new URLSearchParams();
  body.set("market", args.market);
  body.set("side", "bid");
  body.set("ord_type", "price");
  body.set("price", String(Math.floor(args.krwAmount)));
  return upbitFetch<UpbitOrderResponse>({
    method: "POST",
    path: "/v1/orders",
    accessKey: args.accessKey,
    secretKey: args.secretKey,
    body,
  });
}

export function placeMarketSell(args: {
  accessKey: string;
  secretKey: string;
  market: string;
  volume: number;
}): Promise<UpbitOrderResponse> {
  const body = new URLSearchParams();
  body.set("market", args.market);
  body.set("side", "ask");
  body.set("ord_type", "market");
  body.set("volume", String(args.volume));
  return upbitFetch<UpbitOrderResponse>({
    method: "POST",
    path: "/v1/orders",
    accessKey: args.accessKey,
    secretKey: args.secretKey,
    body,
  });
}

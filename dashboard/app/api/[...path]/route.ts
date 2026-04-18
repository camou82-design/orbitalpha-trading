import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 브라우저는 동일 출처로 `/api/*` 를 호출한다. 정적/Nginx만 있으면 `/api/session` 이 404가 되어
 * 인증 로딩이 끝나지 않는다. Next 서버가 있을 때는 여기서 trading API 로 프록시한다.
 *
 * 로컬: 기본 `http://127.0.0.1:8787`
 * 배포: `ORBITALPHA_TRADING_API_ORIGIN` (예: http://127.0.0.1:8787 또는 내부 주소)
 */
function upstreamBase(): string {
  const raw =
    process.env.ORBITALPHA_TRADING_API_ORIGIN?.trim() ||
    process.env.ORBITALPHA_TRADING_INTERNAL_API_URL?.trim() ||
    process.env.ORBITALPHA_TRADING_DASHBOARD_API_PROXY?.trim() ||
    "";
  const base = raw.replace(/\/$/, "");
  return base.length > 0 ? base : "http://127.0.0.1:8787";
}

async function proxy(req: NextRequest, pathSegments: string[]): Promise<Response> {
  const sub = pathSegments.length ? pathSegments.join("/") : "";
  const src = new URL(req.url);
  const target = `${upstreamBase()}/api/${sub}${src.search}`;

  const headers = new Headers();
  const pass = ["cookie", "authorization", "content-type", "accept", "accept-language", "user-agent"];
  for (const name of pass) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const xfProto = req.headers.get("x-forwarded-proto") ?? src.protocol.replace(":", "");
  const xfHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  headers.set("x-forwarded-proto", xfProto);
  if (xfHost) headers.set("x-forwarded-host", xfHost);
  const xff = req.headers.get("x-forwarded-for");
  if (xff) headers.set("x-forwarded-for", xff);

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: "no-store",
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let res: Response;
  try {
    res = await fetch(target, init);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: "api_upstream_unreachable", message: msg.slice(0, 400), upstream: upstreamBase() },
      { status: 502 },
    );
  }

  const outHeaders = new Headers();
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === "transfer-encoding") return;
    outHeaders.set(k, v);
  });
  return new NextResponse(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders });
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const p = await ctx.params;
  return proxy(req, p.path ?? []);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const p = await ctx.params;
  return proxy(req, p.path ?? []);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const p = await ctx.params;
  return proxy(req, p.path ?? []);
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const p = await ctx.params;
  return proxy(req, p.path ?? []);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const p = await ctx.params;
  return proxy(req, p.path ?? []);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const protectedRoute =
    pathname.startsWith("/trading") || pathname.startsWith("/trade") || pathname.startsWith("/dashboard/trading") || pathname.startsWith("/replay");
  if (!protectedRoute) return NextResponse.next();
  const token = req.cookies.get("orbitalpha_trading_session")?.value;
  if (token) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  const nextPath = `${pathname}${req.nextUrl.search}`;
  url.searchParams.set("next", nextPath);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/trading",
    "/trading/:path*",
    "/trade",
    "/trade/:path*",
    "/dashboard/trading",
    "/dashboard/trading/:path*",
    "/replay",
    "/replay/:path*",
  ],
};

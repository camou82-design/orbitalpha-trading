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
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/trading/:path*", "/trade/:path*", "/dashboard/trading/:path*", "/replay/:path*"],
};

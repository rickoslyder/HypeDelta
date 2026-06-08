import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { validateAuthToken } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/admin");

  // Fail closed: if no admin password is configured, admin surfaces are locked.
  // Set ADMIN_PASSWORD to enable access.
  if (!expectedPassword) {
    if (isApiRoute) {
      return NextResponse.json(
        { error: "Admin access is not configured" },
        { status: 503 }
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "not-configured");
    return NextResponse.redirect(loginUrl);
  }

  // Next.js already decodes cookie values; our token is plain [0-9a-f:] so no
  // further decoding is needed. (Calling decodeURIComponent on attacker-supplied
  // values can throw URIError -> 500, so we avoid it.)
  const token = request.cookies.get("admin-auth")?.value;
  const isValid = token ? await validateAuthToken(token, expectedPassword) : false;

  if (!isValid) {
    if (isApiRoute) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};

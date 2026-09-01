import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getAdminSessionSecret,
  isAdminAuthConfigured,
  validateAuthToken,
} from "@/lib/auth";

export async function proxy(request: NextRequest) {
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/admin");

  // Fail closed: both ADMIN_PASSWORD and ADMIN_SESSION_SECRET must be set.
  if (!isAdminAuthConfigured()) {
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

  const sessionSecret = getAdminSessionSecret();
  if (!sessionSecret) {
    // Defense in depth — isAdminAuthConfigured already requires a non-empty secret.
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
  const isValid = token ? await validateAuthToken(token, sessionSecret) : false;

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

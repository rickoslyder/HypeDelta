import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { validateAuthToken } from "@/lib/auth";

export function middleware(request: NextRequest) {
  const expectedPassword = process.env.ADMIN_PASSWORD;

  // Check if the request is for an admin route
  if (request.nextUrl.pathname.startsWith("/admin")) {
    // If no password is set, allow access (development mode)
    if (!expectedPassword) {
      return NextResponse.next();
    }

    // Check for admin auth cookie
    const authCookie = request.cookies.get("admin-auth");
    const token = authCookie?.value;

    // Validate the token
    if (!token || !validateAuthToken(token, expectedPassword)) {
      // Redirect to login page
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Check admin API routes
  if (request.nextUrl.pathname.startsWith("/api/admin")) {
    // If no password is set, allow access (development mode)
    if (!expectedPassword) {
      return NextResponse.next();
    }

    const authCookie = request.cookies.get("admin-auth");
    const token = authCookie?.value;

    // Validate the token
    if (!token || !validateAuthToken(token, expectedPassword)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};

import { NextRequest, NextResponse } from "next/server";
import { generateAuthToken } from "@/lib/auth";

// Simple rate limiting - track failed attempts per IP
const failedAttempts = new Map<string, { count: number; lastAttempt: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_FAILED_ATTEMPTS = 5;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = failedAttempts.get(ip);

  if (!record) return true;

  // Reset if window has passed
  if (now - record.lastAttempt > RATE_LIMIT_WINDOW) {
    failedAttempts.delete(ip);
    return true;
  }

  return record.count < MAX_FAILED_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const record = failedAttempts.get(ip);

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW) {
    failedAttempts.set(ip, { count: 1, lastAttempt: now });
  } else {
    failedAttempts.set(ip, { count: record.count + 1, lastAttempt: now });
  }
}

function clearFailedAttempts(ip: string): void {
  failedAttempts.delete(ip);
}

export async function POST(request: NextRequest) {
  try {
    // Get client IP for rate limiting
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip")
      || "unknown";

    // Check rate limit
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many failed attempts. Please wait before trying again." },
        { status: 429 }
      );
    }

    const { password } = await request.json();
    const expectedPassword = process.env.ADMIN_PASSWORD;

    // If no password is configured, allow any access (development mode)
    if (!expectedPassword) {
      const token = generateAuthToken("dev-mode-secret");
      const response = NextResponse.json({ success: true });
      response.cookies.set("admin-auth", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: "/",
      });
      return response;
    }

    // Check password
    if (password !== expectedPassword) {
      recordFailedAttempt(ip);
      return NextResponse.json(
        { error: "Invalid password" },
        { status: 401 }
      );
    }

    // Clear failed attempts on success
    clearFailedAttempts(ip);

    // Generate secure token (uses password as HMAC secret, token doesn't contain password)
    const token = generateAuthToken(expectedPassword);

    // Set auth cookie with secure token
    const response = NextResponse.json({ success: true });
    response.cookies.set("admin-auth", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "An error occurred" },
      { status: 500 }
    );
  }
}

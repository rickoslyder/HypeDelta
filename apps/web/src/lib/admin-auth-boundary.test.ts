import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST as loginPOST } from "../app/api/auth/login/route";
import { generateAuthToken, validateAuthToken } from "./auth";
import { proxy } from "../proxy";

const ENV_KEYS = ["ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"] as const;

describe("admin auth route and proxy boundary", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
    {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function loginRequest(password: string): NextRequest {
    return new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.50",
      },
      body: JSON.stringify({ password }),
    });
  }

  it("returns 503 from login when ADMIN_SESSION_SECRET is missing", async () => {
    process.env.ADMIN_PASSWORD = "configured-password";
    delete process.env.ADMIN_SESSION_SECRET;

    const response = await loginPOST(loginRequest("configured-password"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Admin access is not configured",
    });
  });

  it("returns 503 from login when ADMIN_PASSWORD is missing", async () => {
    delete process.env.ADMIN_PASSWORD;
    process.env.ADMIN_SESSION_SECRET = "configured-session";

    const response = await loginPOST(loginRequest("anything"));
    expect(response.status).toBe(503);
  });

  it("rejects wrong password with 401 when both secrets are configured", async () => {
    process.env.ADMIN_PASSWORD = "configured-password";
    process.env.ADMIN_SESSION_SECRET = "configured-session";

    const response = await loginPOST(loginRequest("wrong-password"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid password",
    });
  });

  it("sets a session-secret-signed cookie on successful login", async () => {
    process.env.ADMIN_PASSWORD = "configured-password";
    process.env.ADMIN_SESSION_SECRET = "configured-session";

    const response = await loginPOST(loginRequest("configured-password"));
    expect(response.status).toBe(200);

    const cookie = response.cookies.get("admin-auth");
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.maxAge).toBe(60 * 60 * 24 * 7);

    const token = cookie!.value;
    expect(await validateAuthToken(token, "configured-session")).toBe(true);
    expect(await validateAuthToken(token, "configured-password")).toBe(false);
  });

  it("proxy redirects admin GET to not-configured when session secret missing", async () => {
    process.env.ADMIN_PASSWORD = "configured-password";
    delete process.env.ADMIN_SESSION_SECRET;

    const request = new NextRequest("http://localhost/admin/settings");
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?error=not-configured",
    );
  });

  it("proxy returns 503 for admin API when password missing", async () => {
    delete process.env.ADMIN_PASSWORD;
    process.env.ADMIN_SESSION_SECRET = "configured-session";

    const request = new NextRequest("http://localhost/api/admin/fetch", {
      method: "POST",
    });
    const response = await proxy(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Admin access is not configured",
    });
  });

  it("proxy allows admin API with a valid session-secret cookie", async () => {
    process.env.ADMIN_PASSWORD = "configured-password";
    process.env.ADMIN_SESSION_SECRET = "configured-session";

    const token = await generateAuthToken("configured-session");
    const request = new NextRequest("http://localhost/api/admin/pipeline", {
      headers: { cookie: `admin-auth=${token}` },
    });
    const response = await proxy(request);

    expect(response.status).toBe(200);
    // NextResponse.next() has no body; ensure we did not 401/503.
    expect(response.headers.get("location")).toBeNull();
  });

  it("proxy rejects a password-keyed cookie even when both secrets are set", async () => {
    process.env.ADMIN_PASSWORD = "configured-password";
    process.env.ADMIN_SESSION_SECRET = "configured-session";

    const token = await generateAuthToken("configured-password");
    const request = new NextRequest("http://localhost/api/admin/pipeline", {
      headers: { cookie: `admin-auth=${token}` },
    });
    const response = await proxy(request);

    expect(response.status).toBe(401);
  });
});

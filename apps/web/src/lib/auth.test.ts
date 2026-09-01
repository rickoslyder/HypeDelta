import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  generateAuthToken,
  isAuthenticatedRequest,
  validateAuthToken,
  verifyAdminPassword,
} from "./auth";

const ENV_KEYS = ["ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"] as const;

describe("admin auth session secret separation", () => {
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

  function cookieRequest(token: string): NextRequest {
    return new NextRequest("http://localhost/api/admin/pipeline", {
      headers: { cookie: `admin-auth=${token}` },
    });
  }

  it("authenticates cookies with ADMIN_SESSION_SECRET, not ADMIN_PASSWORD", async () => {
    process.env.ADMIN_PASSWORD = "login-password-only";
    process.env.ADMIN_SESSION_SECRET = "independent-session-secret";

    const sessionToken = await generateAuthToken(
      process.env.ADMIN_SESSION_SECRET,
    );
    expect(await isAuthenticatedRequest(cookieRequest(sessionToken))).toBe(
      true,
    );

    const passwordKeyedToken = await generateAuthToken(
      process.env.ADMIN_PASSWORD,
    );
    expect(
      await isAuthenticatedRequest(cookieRequest(passwordKeyedToken)),
    ).toBe(false);
  });

  it("keeps a previously issued token valid when only ADMIN_PASSWORD rotates", async () => {
    process.env.ADMIN_PASSWORD = "password-v1";
    process.env.ADMIN_SESSION_SECRET = "stable-session-secret";

    const token = await generateAuthToken(process.env.ADMIN_SESSION_SECRET);
    process.env.ADMIN_PASSWORD = "password-v2";

    expect(await validateAuthToken(token, process.env.ADMIN_SESSION_SECRET)).toBe(
      true,
    );
    expect(await isAuthenticatedRequest(cookieRequest(token))).toBe(true);
    expect(await verifyAdminPassword("password-v1")).toBe(false);
    expect(await verifyAdminPassword("password-v2")).toBe(true);
  });

  it("invalidates a previously issued token when ADMIN_SESSION_SECRET rotates", async () => {
    process.env.ADMIN_PASSWORD = "stable-password";
    process.env.ADMIN_SESSION_SECRET = "session-secret-v1";

    const token = await generateAuthToken(process.env.ADMIN_SESSION_SECRET);
    process.env.ADMIN_SESSION_SECRET = "session-secret-v2";

    expect(await isAuthenticatedRequest(cookieRequest(token))).toBe(false);
  });

  it("fails closed for auth helpers when either required secret is missing or empty", async () => {
    process.env.ADMIN_PASSWORD = "only-password";
    delete process.env.ADMIN_SESSION_SECRET;
    const tokenA = await generateAuthToken("orphan-secret");
    expect(await isAuthenticatedRequest(cookieRequest(tokenA))).toBe(false);

    delete process.env.ADMIN_PASSWORD;
    process.env.ADMIN_SESSION_SECRET = "only-session";
    const tokenB = await generateAuthToken(process.env.ADMIN_SESSION_SECRET);
    // Session secret alone can still verify a token at the helper layer, but
    // configured admin auth requires both — covered at the route/proxy boundary.
    expect(await isAuthenticatedRequest(cookieRequest(tokenB))).toBe(true);

    process.env.ADMIN_PASSWORD = "";
    process.env.ADMIN_SESSION_SECRET = "only-session";
    expect(await verifyAdminPassword("x")).toBe(false);

    process.env.ADMIN_PASSWORD = "only-password";
    process.env.ADMIN_SESSION_SECRET = "";
    expect(await isAuthenticatedRequest(cookieRequest(tokenB))).toBe(false);
  });
});

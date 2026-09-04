/**
 * Admin CLI-trigger routes: unauthenticated 401, authenticated 501,
 * zero cli-runner invocation. No worker control plane.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const cliRunner = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runFetch: vi.fn(),
  runSynthesize: vi.fn(),
  isOperationRunning: vi.fn(() => false),
  getRunningOperations: vi.fn(() => []),
  runCliCommand: vi.fn(),
}));

const spawn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cli-runner", () => cliRunner);

vi.mock("child_process", () => ({
  spawn,
  default: { spawn },
}));

import { generateAuthToken } from "@/lib/auth";

const ENV_KEYS = ["ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"] as const;

const ROUTES = [
  { name: "process", path: "/api/admin/process", load: () => import("./process/route") },
  { name: "pipeline", path: "/api/admin/pipeline", load: () => import("./pipeline/route") },
  { name: "fetch", path: "/api/admin/fetch", load: () => import("./fetch/route") },
  { name: "synthesize", path: "/api/admin/synthesize", load: () => import("./synthesize/route") },
] as const;

function expectCliRunnerUnused(): void {
  for (const [name, fn] of Object.entries(cliRunner)) {
    expect(fn, name).not.toHaveBeenCalled();
  }
  expect(spawn).not.toHaveBeenCalled();
}

describe("admin cli-runner routes are fail-closed", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    process.env.ADMIN_PASSWORD = "configured-password";
    process.env.ADMIN_SESSION_SECRET = "configured-session-secret";
    spawn.mockReset();
    for (const fn of Object.values(cliRunner)) {
      fn.mockReset();
    }
    cliRunner.isOperationRunning.mockReturnValue(false);
    cliRunner.getRunningOperations.mockReturnValue([]);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function authedCookie(): Promise<string> {
    const token = await generateAuthToken("configured-session-secret");
    return `admin-auth=${token}`;
  }

  function request(path: string, method: "GET" | "POST", cookie?: string): NextRequest {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (method === "POST") headers["content-type"] = "application/json";
    return new NextRequest(`http://localhost${path}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify({}) : undefined,
    });
  }

  it("does not import the cli-runner module path from any of the four routes", () => {
    const dir = path.resolve(__dirname);
    for (const name of ["process", "pipeline", "fetch", "synthesize"] as const) {
      const src = readFileSync(path.join(dir, name, "route.ts"), "utf8");
      expect(src, name).not.toMatch(/cli-runner/);
      expect(src, name).not.toMatch(/child_process/);
      expect(src, name).not.toMatch(/\bnpx\b/);
      expect(src, name).not.toMatch(/\btsx\b/);
    }
  });

  for (const route of ROUTES) {
    it(`${route.name} GET unauthenticated returns 401 before any cli-runner call`, async () => {
      const mod = await route.load();
      const res = await mod.GET(request(route.path, "GET"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
      expectCliRunnerUnused();
    });

    it(`${route.name} POST unauthenticated returns 401 before any cli-runner call`, async () => {
      const mod = await route.load();
      const res = await mod.POST(request(route.path, "POST"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
      expectCliRunnerUnused();
    });

    it(`${route.name} GET authenticated returns 501 before any cli-runner call`, async () => {
      const mod = await route.load();
      const res = await mod.GET(request(route.path, "GET", await authedCookie()));
      expect(res.status).toBe(501);
      const text = await res.text();
      expect(text).toMatch(/Not Implemented/i);
      expect(text).not.toMatch(/\bnpx\b/i);
      expect(text).not.toMatch(/\btsx\b/i);
      expect(text).not.toMatch(/src\/cli\.ts/);
      expect(text).not.toMatch(/postgresql:\/\//i);
      expect(text).not.toMatch(/ADMIN_PASSWORD|ADMIN_SESSION_SECRET|DATABASE_URL/i);
      expectCliRunnerUnused();
    });

    it(`${route.name} POST authenticated returns 501 before any cli-runner call`, async () => {
      const mod = await route.load();
      const res = await mod.POST(request(route.path, "POST", await authedCookie()));
      expect(res.status).toBe(501);
      const text = await res.text();
      expect(text).toMatch(/Not Implemented/i);
      expect(text).not.toMatch(/\bnpx\b/i);
      expect(text).not.toMatch(/\btsx\b/i);
      expect(text).not.toMatch(/src\/cli\.ts/);
      expect(text).not.toMatch(/postgresql:\/\//i);
      expect(text).not.toMatch(/ADMIN_PASSWORD|ADMIN_SESSION_SECRET|DATABASE_URL/i);
      expectCliRunnerUnused();
    });
  }
});

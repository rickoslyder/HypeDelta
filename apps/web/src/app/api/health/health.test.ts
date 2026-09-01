/**
 * Web liveness / readiness health route contracts.
 * Mocked DB only — no live postgres, no secret leakage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCheckDatabaseReady = vi.fn();

vi.mock("@/lib/db", () => ({
  checkDatabaseReady: (...args: unknown[]) => mockCheckDatabaseReady(...args),
}));

describe("GET /api/health/live", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns 200 JSON with stable non-secret service/status and Cache-Control: no-store", async () => {
    const { GET } = await import("./live/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        status: expect.any(String),
        service: expect.any(String),
      }),
    );
    expect(body.status).toMatch(/^(ok|live|up)$/i);
    expect(String(body.service).length).toBeGreaterThan(0);

    const text = JSON.stringify(body);
    expect(text).not.toMatch(/DATABASE_URL/i);
    expect(text).not.toMatch(/postgresql:\/\//i);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/ECONNREFUSED|stack|Error:/i);
  });

  it("does not call the database readiness helper", async () => {
    const { GET } = await import("./live/route");
    await GET();
    expect(mockCheckDatabaseReady).not.toHaveBeenCalled();
  });
});

describe("GET /api/health/ready", () => {
  const savedUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://user:s3cret@db.internal:5432/ai_intel";
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  it("returns 200 with Cache-Control: no-store when DB is ready", async () => {
    mockCheckDatabaseReady.mockResolvedValue(true);
    const { GET } = await import("./ready/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ status: expect.any(String) }));
    expect(String(body.status).toLowerCase()).toMatch(/ready|ok/);

    const text = JSON.stringify(body);
    expect(text).not.toMatch(/postgresql:\/\//i);
    expect(text).not.toMatch(/s3cret/i);
    expect(text).not.toMatch(/db\.internal/i);
  });

  it("returns generic 503 when readiness helper reports not ready", async () => {
    mockCheckDatabaseReady.mockResolvedValue(false);
    const { GET } = await import("./ready/route");
    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toMatch(/postgresql:\/\//i);
    expect(text).not.toMatch(/s3cret/i);
    expect(text).not.toMatch(/DATABASE_URL/i);
    expect(text).not.toMatch(/ECONNREFUSED|timeout|password|token/i);
    expect(text).not.toMatch(/Error:/i);
  });

  it("returns generic 503 without leaking exception text when helper throws", async () => {
    mockCheckDatabaseReady.mockRejectedValue(
      new Error("connect ECONNREFUSED postgresql://user:s3cret@db.internal:5432/ai_intel token=abc"),
    );
    const { GET } = await import("./ready/route");
    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toMatch(/postgresql:\/\//i);
    expect(text).not.toMatch(/s3cret/i);
    expect(text).not.toMatch(/ECONNREFUSED/i);
    expect(text).not.toMatch(/token=abc/i);
    expect(text).not.toMatch(/db\.internal/i);
  });
});

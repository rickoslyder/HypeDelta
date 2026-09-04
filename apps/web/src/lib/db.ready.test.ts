/**
 * checkDatabaseReady unit tests (mocked pg Pool — no live DB).
 * Kept separate from route tests so the @/lib/db mock does not collide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("pg", () => {
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

describe("checkDatabaseReady", () => {
  const savedUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://localhost/test";
    mockQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  it("returns true on successful SELECT 1", async () => {
    const { checkDatabaseReady } = await import("./db");
    await expect(checkDatabaseReady(500)).resolves.toBe(true);
    expect(mockQuery).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns false on query failure without throwing", async () => {
    mockQuery.mockRejectedValue(new Error("ECONNREFUSED secret://leak"));
    const { checkDatabaseReady } = await import("./db");
    await expect(checkDatabaseReady(500)).resolves.toBe(false);
  });

  it("returns false when DATABASE_URL is missing (fail-closed)", async () => {
    delete process.env.DATABASE_URL;
    const { checkDatabaseReady } = await import("./db");
    await expect(checkDatabaseReady(500)).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

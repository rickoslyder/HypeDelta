/**
 * GET /api/health/pipeline — freshness probe, no-store, no secret leakage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetProductFreshnessSnapshot = vi.fn();

vi.mock("@/lib/db", () => ({
  getProductFreshnessSnapshot: (...args: unknown[]) =>
    mockGetProductFreshnessSnapshot(...args),
  checkDatabaseReady: vi.fn(),
}));

const NOW = new Date("2026-08-28T12:00:00.000Z");

function freshSnapshot() {
  const hourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  return {
    synthesisLatest: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    unprocessedCount: 3,
    activeSources: [
      {
        identifier: "sama",
        type: "twitter",
        last_fetched: hourAgo,
        fetch_frequency_hours: 4,
      },
    ],
    pipelineLatestSuccessAt: hourAgo,
    pipelineLatestFinishedAt: hourAgo,
    pipelineLatestOk: true,
    pipelineLatestErrorClass: null,
    fetchLatestSuccessAt: hourAgo,
  };
}

describe("GET /api/health/pipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 200 no-store JSON when the product is fresh", async () => {
    mockGetProductFreshnessSnapshot.mockResolvedValue(freshSnapshot());
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("fresh");
    expect(body.ok).toBe(true);
    expect(body.reasons).toEqual([]);
    expect(body.lastSynthesisDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.pendingCount).toBe(3);
    expect(JSON.stringify(body)).not.toMatch(/postgresql:\/\//i);
    expect(JSON.stringify(body)).not.toMatch(/DATABASE_URL/i);
  });

  it("returns 503 when synthesis is stale", async () => {
    mockGetProductFreshnessSnapshot.mockResolvedValue({
      ...freshSnapshot(),
      synthesisLatest: new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("stale");
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain("SYNTHESIS_STALE");
  });

  it("returns 200 and reports overdueSourceCount when a single feed is overdue", async () => {
    mockGetProductFreshnessSnapshot.mockResolvedValue({
      ...freshSnapshot(),
      activeSources: [
        {
          identifier: "sama",
          type: "twitter",
          last_fetched: new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString(),
          fetch_frequency_hours: 4,
        },
      ],
    });
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("fresh");
    expect(body.ok).toBe(true);
    expect(body.overdueSourceCount).toBe(1);
    expect(body.reasons).not.toContain("SOURCES_OVERDUE");
  });

  it("returns 503 when overdue sources are material (3 of 20)", async () => {
    const graceMs = Math.max(4 * 2, 4 + 6) * 60 * 60 * 1000;
    mockGetProductFreshnessSnapshot.mockResolvedValue({
      ...freshSnapshot(),
      activeSources: Array.from({ length: 20 }, (_, i) => ({
        identifier: `s${i}`,
        type: "twitter",
        last_fetched:
          i < 3
            ? new Date(NOW.getTime() - graceMs - 1).toISOString()
            : new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
        fetch_frequency_hours: 4,
      })),
    });
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.ok).toBe(false);
    expect(body.overdueSourceCount).toBe(3);
    expect(body.reasons).toContain("SOURCES_OVERDUE");
  });

  it("returns 200 when only a large backlog is present", async () => {
    mockGetProductFreshnessSnapshot.mockResolvedValue({
      ...freshSnapshot(),
      unprocessedCount: 500,
    });
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("fresh");
    expect(body.ok).toBe(true);
    expect(body.reasons).toContain("BACKLOG_LARGE");
    expect(body.pendingCount).toBe(500);
  });

  it("returns generic 503 without leaking SQL/config when the snapshot throws", async () => {
    mockGetProductFreshnessSnapshot.mockRejectedValue(
      new Error(
        'relation "synthesis_results" connect ECONNREFUSED postgresql://user:s3cret@db.internal:5432/ai_intel DATABASE_URL token=abc',
      ),
    );
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toMatch(/postgresql:\/\//i);
    expect(text).not.toMatch(/s3cret/i);
    expect(text).not.toMatch(/DATABASE_URL/i);
    expect(text).not.toMatch(/ECONNREFUSED/i);
    expect(text).not.toMatch(/token=abc/i);
    expect(text).not.toMatch(/db\.internal/i);
    expect(text).not.toMatch(/synthesis_results/i);
    expect(text).not.toMatch(/Error:/i);
  });

  it("returns 503 when synthesis/sources are fresh but no pipeline success within 6h", async () => {
    const pipelineAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000 - 1).toISOString();
    const fetchAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    mockGetProductFreshnessSnapshot.mockResolvedValue({
      ...freshSnapshot(),
      pipelineLatestSuccessAt: pipelineAt,
      pipelineLatestFinishedAt: pipelineAt,
      pipelineLatestOk: true,
      pipelineLatestErrorClass: null,
      fetchLatestSuccessAt: fetchAt,
    });
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain("PIPELINE_NO_RECENT_SUCCESS");
    expect(body.lastPipelineSuccessAt).toBe(pipelineAt);
    expect(body.lastFetchSuccessAt).toBe(fetchAt);
    expect(body).not.toHaveProperty("error_message");
    expect(JSON.stringify(body)).not.toMatch(/postgresql:\/\//i);
  });

  it("returns 503 when synthesis/sources/pipeline are fresh but no fetch success within 6h", async () => {
    const pipelineAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const fetchAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000 - 1).toISOString();
    mockGetProductFreshnessSnapshot.mockResolvedValue({
      ...freshSnapshot(),
      pipelineLatestSuccessAt: pipelineAt,
      pipelineLatestFinishedAt: pipelineAt,
      pipelineLatestOk: true,
      pipelineLatestErrorClass: null,
      fetchLatestSuccessAt: fetchAt,
    });
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain("FETCH_NO_RECENT_SUCCESS");
    expect(body.lastFetchSuccessAt).toBe(fetchAt);
    expect(body.lastPipelineSuccessAt).toBe(pipelineAt);
    expect(body).not.toHaveProperty("error_message");
  });

  it("returns 503 with bounded errorClass when the latest pipeline_runs row failed", async () => {
    const successAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const finishedAt = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    mockGetProductFreshnessSnapshot.mockResolvedValue({
      ...freshSnapshot(),
      pipelineLatestSuccessAt: successAt,
      pipelineLatestOk: false,
      pipelineLatestErrorClass: "database",
      pipelineLatestFinishedAt: finishedAt,
      fetchLatestSuccessAt: successAt,
    });
    const { GET } = await import("./pipeline/route");
    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain("PIPELINE_FAILED");
    expect(body.errorClass).toBe("database");
    expect(body.lastPipelineSuccessAt).toBe(successAt);
    expect(body.lastFetchSuccessAt).toBe(successAt);
    expect(body).not.toHaveProperty("error_message");
    expect(JSON.stringify(body)).not.toMatch(/error_message/i);
    expect(JSON.stringify(body)).not.toMatch(/postgresql:\/\//i);
    expect(JSON.stringify(body)).not.toMatch(/SELECT /i);
    expect(JSON.stringify(body)).not.toMatch(/stack/i);
  });
});

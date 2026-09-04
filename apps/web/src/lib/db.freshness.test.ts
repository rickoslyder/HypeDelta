/**
 * Product-freshness read model — persisted outcomes + source schedule state.
 * Mocked pg Pool only; no live postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("pg", () => {
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

const { getProductFreshnessSnapshot } = await import("./db");

function sqlText(sql: unknown): string {
  if (sql && typeof sql === "object" && "text" in sql) {
    return String((sql as { text: unknown }).text ?? "").replace(/\s+/g, " ");
  }
  return String(sql ?? "").replace(/\s+/g, " ");
}

function mentionsTable(sql: string, table: string): boolean {
  return new RegExp(`\\b${table}\\b`, "i").test(sql);
}

function allSql(): string[] {
  return mockQuery.mock.calls.map((c) => sqlText(c[0]));
}

/** Dispatch by table even if aliases, FILTER, or extra columns are present. */
function freshnessQueryResult(sql: unknown): { rows: Record<string, unknown>[] } {
  const s = sqlText(sql);
  if (mentionsTable(s, "synthesis_results")) {
    return { rows: [{ latest: "2026-08-20T00:00:00.000Z" }] };
  }
  if (mentionsTable(s, "content")) {
    return { rows: [{ unprocessed: "1" }] };
  }
  if (mentionsTable(s, "sources")) {
    return { rows: [] };
  }
  if (mentionsTable(s, "pipeline_runs")) {
    // One rich row covers separate success/latest queries and a combined SELECT.
    return {
      rows: [
        {
          latest_success: "2026-08-28T10:00:00.000Z",
          finished_at: "2026-08-28T11:00:00.000Z",
          ok: false,
          error_class: "timeout",
          error_message: "password authentication failed postgresql://secret@db/ai_intel",
        },
      ],
    };
  }
  if (mentionsTable(s, "source_fetch_attempts")) {
    return { rows: [{ latest_success: "2026-08-28T09:30:00.000Z" }] };
  }
  return { rows: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://localhost/test";
  mockQuery.mockImplementation(async (sql: unknown) => freshnessQueryResult(sql));
});

describe("getProductFreshnessSnapshot", () => {
  it("reads synthesis time, unprocessed count, and active source cadence — not SELECT 1", async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = sqlText(sql);
      if (mentionsTable(s, "synthesis_results")) {
        return { rows: [{ latest: "2026-08-20T00:00:00.000Z" }] };
      }
      if (mentionsTable(s, "content")) {
        return { rows: [{ unprocessed: "42" }] };
      }
      if (mentionsTable(s, "sources")) {
        return {
          rows: [
            {
              identifier: "sama",
              type: "twitter",
              last_fetched: "2026-08-28T08:00:00.000Z",
              fetch_frequency_hours: 4,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const snapshot = await getProductFreshnessSnapshot();

    expect(snapshot.synthesisLatest).toBe("2026-08-20T00:00:00.000Z");
    expect(snapshot.unprocessedCount).toBe(42);
    expect(snapshot.activeSources).toEqual([
      {
        identifier: "sama",
        type: "twitter",
        last_fetched: "2026-08-28T08:00:00.000Z",
        fetch_frequency_hours: 4,
      },
    ]);

    const joined = allSql().join("\n");
    expect(joined).not.toMatch(/SELECT\s+1\b/i);
    expect(joined).toMatch(/synthesis_results/i);
    expect(joined).toMatch(/generated_at/i);
    expect(joined).toMatch(/FROM\s+content/i);
    expect(joined).toMatch(/processed_at/i);
    expect(joined).toMatch(/FROM\s+sources/i);
    expect(joined).toMatch(/last_fetched/i);
    expect(joined).toMatch(/fetch_frequency_hours/i);
    expect(joined).toMatch(/is_active/i);
  });

  it("returns empty-safe defaults when tables are empty, including null ledger fields", async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = sqlText(sql);
      if (mentionsTable(s, "synthesis_results")) {
        return { rows: [{ latest: null }] };
      }
      if (mentionsTable(s, "content")) {
        return { rows: [{ unprocessed: "0" }] };
      }
      return { rows: [] };
    });

    const snapshot = await getProductFreshnessSnapshot();
    expect(snapshot.synthesisLatest).toBeNull();
    expect(snapshot.unprocessedCount).toBe(0);
    expect(snapshot.activeSources).toEqual([]);
    expect(snapshot.pipelineLatestSuccessAt).toBeNull();
    expect(snapshot.pipelineLatestFinishedAt).toBeNull();
    expect(snapshot.pipelineLatestOk).toBeNull();
    expect(snapshot.pipelineLatestErrorClass).toBeNull();
    expect(snapshot.fetchLatestSuccessAt).toBeNull();
  });

  it("reads pipeline_runs and source_fetch_attempts and never exposes raw error_message", async () => {
    const snapshot = await getProductFreshnessSnapshot();
    const joined = allSql().join("\n");

    expect(joined).toMatch(/pipeline_runs/i);
    expect(joined).toMatch(/source_fetch_attempts/i);
    expect(joined).not.toMatch(/SELECT\s+1\b/i);
    // Latest-row SQL needs error_class only; never pull raw error_message.
    expect(joined).not.toMatch(/error_message/i);

    expect(snapshot.pipelineLatestSuccessAt).toBe("2026-08-28T10:00:00.000Z");
    expect(snapshot.pipelineLatestFinishedAt).toBe("2026-08-28T11:00:00.000Z");
    expect(snapshot.fetchLatestSuccessAt).toBe("2026-08-28T09:30:00.000Z");
    expect(snapshot.pipelineLatestOk).toBe(false);
    expect(snapshot.pipelineLatestErrorClass).toBe("timeout");
    expect(snapshot).not.toHaveProperty("error_message");
    expect(JSON.stringify(snapshot)).not.toMatch(/error_message/i);
    expect(JSON.stringify(snapshot)).not.toMatch(/postgresql:\/\//i);
    expect(JSON.stringify(snapshot)).not.toMatch(/password authentication/i);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret@db/i);
  });
});

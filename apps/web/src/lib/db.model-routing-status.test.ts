/**
 * Packet 3: bounded model routing telemetry on getSystemStatus.
 * Mocked pg Pool only — no live postgres, no secrets.
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

const { getSystemStatus } = await import("./db");

function sqlText(sql: unknown): string {
  if (sql && typeof sql === "object" && "text" in sql) {
    return String((sql as { text: unknown }).text ?? "");
  }
  return String(sql ?? "");
}

function normalize(sql: unknown): string {
  return sqlText(sql).replace(/\s+/g, " ");
}

function allSql(): string[] {
  return mockQuery.mock.calls.map((c) => sqlText(c[0]));
}

function mentionsTable(sql: unknown, table: string): boolean {
  return new RegExp(`\\b${table}\\b`, "i").test(sqlText(sql));
}

const ATTEMPT_ALLOWED_KEYS = [
  "stage",
  "requestedProvider",
  "requestedModel",
  "effectiveProvider",
  "effectiveModel",
  "credentialClass",
  "ok",
  "errorClass",
  "latencyMs",
  "startedAt",
  "promptVersion",
] as const;

const STAGE_ALLOWED_KEYS = [
  "stage",
  "attempts",
  "successes",
  "failures",
  "lastSuccessAt",
  "lastErrorClass",
  "averageLatencyMs",
] as const;

function baselineStatusResult(sql: unknown): { rows: Record<string, unknown>[] } {
  const s = normalize(sql);
  if (/FROM\s+sources\b/i.test(s) && /COUNT/i.test(s) && !/extracted_claims/i.test(s)) {
    return { rows: [{ total: "10", active: "8" }] };
  }
  if (/FROM\s+content\b/i.test(s) && /total_content/i.test(s)) {
    return {
      rows: [
        {
          total_content: "100",
          processed_content: "90",
          unprocessed_content: "10",
          content_last_24h: "5",
        },
      ],
    };
  }
  if (/FROM\s+extracted_claims\b/i.test(s) && /url_backed/i.test(s)) {
    return {
      rows: [
        {
          total: "4",
          last_24h: "1",
          url_backed: "3",
          quote_backed: "2",
          author_identified: "2",
        },
      ],
    };
  }
  if (/FROM\s+synthesis_results\b/i.test(s)) {
    return { rows: [{ latest: "2026-08-20T00:00:00.000Z", count: "2" }] };
  }
  return { rows: [] };
}

function missingRelationError(): Error & { code: string } {
  const err = new Error('relation "model_attempts" does not exist') as Error & {
    code: string;
  };
  err.code = "42P01";
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://localhost/test";
  mockQuery.mockImplementation(async (sql: unknown) => baselineStatusResult(sql));
});

describe("getSystemStatus model routing telemetry", () => {
  it("returns the newest 20 attempts with only the bounded public fields", async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = normalize(sql);
      if (mentionsTable(s, "model_attempts") && /LIMIT\s+20/i.test(s)) {
        return {
          rows: [
            {
              stage: "filter",
              requested_provider: "deepseek",
              requested_model: "deepseek-v4-flash",
              effective_provider: "deepseek",
              effective_model: "deepseek-v4-flash",
              credential_class: "deepseek_api_key",
              ok: true,
              error_class: null,
              latency_ms: 120,
              started_at: "2026-08-30T12:00:00.000Z",
              prompt_version: "filter-v3",
              prompt_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              error_message: "secret boom postgresql://user:pass@db/ai_intel",
              raw_payload: { choices: [{ text: "leak" }] },
            },
            {
              stage: "synthesis",
              requested_provider: "kimi-coding",
              requested_model: "kimi-k3",
              effective_provider: null,
              effective_model: null,
              credential_class: "kimi_code_subscription",
              ok: false,
              error_class: "timeout",
              latency_ms: 30000,
              started_at: "2026-08-30T11:59:00.000Z",
              prompt_version: "synth-v1",
            },
          ],
        };
      }
      return baselineStatusResult(sql);
    });

    const status = await getSystemStatus();
    expect(status.routing.available).toBe(true);
    expect(status.routing.recent).toHaveLength(2);
    expect(status.routing.recent[0]).toEqual({
      stage: "filter",
      requestedProvider: "deepseek",
      requestedModel: "deepseek-v4-flash",
      effectiveProvider: "deepseek",
      effectiveModel: "deepseek-v4-flash",
      credentialClass: "deepseek_api_key",
      ok: true,
      errorClass: null,
      latencyMs: 120,
      startedAt: "2026-08-30T12:00:00.000Z",
      promptVersion: "filter-v3",
    });
    expect(status.routing.recent[1]).toEqual({
      stage: "synthesis",
      requestedProvider: "kimi-coding",
      requestedModel: "kimi-k3",
      effectiveProvider: null,
      effectiveModel: null,
      credentialClass: "kimi_code_subscription",
      ok: false,
      errorClass: "timeout",
      latencyMs: 30000,
      startedAt: "2026-08-30T11:59:00.000Z",
      promptVersion: "synth-v1",
    });

    for (const row of status.routing.recent) {
      expect(Object.keys(row).sort()).toEqual([...ATTEMPT_ALLOWED_KEYS].sort());
    }

    const dumped = JSON.stringify(status);
    expect(dumped).not.toMatch(/prompt_hash|promptHash/i);
    expect(dumped).not.toMatch(/error_message|raw_payload/i);
    expect(dumped).not.toMatch(/secret boom/i);
    expect(dumped).not.toMatch(/postgresql:\/\//i);

    const recentSql = allSql().find(
      (sql) => /model_attempts/i.test(sql) && /LIMIT\s+20/i.test(sql),
    );
    expect(recentSql).toBeDefined();
    const recentNorm = normalize(recentSql);
    expect(recentNorm).toMatch(/ORDER BY\s+started_at\s+DESC/i);
    expect(recentNorm).toMatch(/LIMIT\s+20/i);
    expect(recentNorm).not.toMatch(/SELECT\s+\*/i);
    expect(recentNorm).not.toMatch(/prompt_hash/i);
    expect(recentNorm).not.toMatch(/error_message/i);
    expect(recentNorm).not.toMatch(/raw_payload/i);
    expect(recentNorm).not.toMatch(/prompt_tokens|completion_tokens|total_tokens/i);
    expect(recentNorm).toMatch(/requested_provider/i);
    expect(recentNorm).toMatch(/requested_model/i);
    expect(recentNorm).toMatch(/effective_provider/i);
    expect(recentNorm).toMatch(/effective_model/i);
    expect(recentNorm).toMatch(/credential_class/i);
    expect(recentNorm).toMatch(/error_class/i);
    expect(recentNorm).toMatch(/latency_ms/i);
    expect(recentNorm).toMatch(/prompt_version/i);
  });

  it("aggregates the last 24h per stage without SELECT * or payload columns", async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = normalize(sql);
      if (
        mentionsTable(s, "model_attempts") &&
        /GROUP BY/i.test(s) &&
        /24\s*hours/i.test(s)
      ) {
        return {
          rows: [
            {
              stage: "filter",
              attempts: "3",
              successes: "2",
              failures: "1",
              last_success_at: "2026-08-30T12:00:00.000Z",
              last_error_class: "timeout",
              average_latency_ms: "150",
            },
            {
              stage: "digest",
              attempts: "1",
              successes: "1",
              failures: "0",
              last_success_at: "2026-08-30T10:00:00.000Z",
              last_error_class: null,
              average_latency_ms: "80.4",
            },
          ],
        };
      }
      return baselineStatusResult(sql);
    });

    const status = await getSystemStatus();
    expect(status.routing.available).toBe(true);
    expect(status.routing.last24h).toEqual([
      {
        stage: "filter",
        attempts: 3,
        successes: 2,
        failures: 1,
        lastSuccessAt: "2026-08-30T12:00:00.000Z",
        lastErrorClass: "timeout",
        averageLatencyMs: 150,
      },
      {
        stage: "digest",
        attempts: 1,
        successes: 1,
        failures: 0,
        lastSuccessAt: "2026-08-30T10:00:00.000Z",
        lastErrorClass: null,
        averageLatencyMs: 80.4,
      },
    ]);

    for (const row of status.routing.last24h) {
      expect(Object.keys(row).sort()).toEqual([...STAGE_ALLOWED_KEYS].sort());
    }

    const aggSql = allSql().find(
      (sql) => /model_attempts/i.test(sql) && /GROUP BY/i.test(sql),
    );
    expect(aggSql).toBeDefined();
    const aggNorm = normalize(aggSql);
    expect(aggNorm).toMatch(/INTERVAL\s+'24 hours'/i);
    expect(aggNorm).toMatch(/GROUP BY\s+stage/i);
    expect(aggNorm).not.toMatch(/SELECT\s+\*/i);
    expect(aggNorm).not.toMatch(/prompt_hash/i);
    expect(aggNorm).not.toMatch(/error_message/i);
  });

  it("returns available:false empty routing when model_attempts is missing", async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (mentionsTable(sql, "model_attempts")) {
        throw missingRelationError();
      }
      return baselineStatusResult(sql);
    });

    const status = await getSystemStatus();
    expect(status.routing).toEqual({
      available: false,
      recent: [],
      last24h: [],
    });
    expect(status.claims.total).toBe(4);
    expect(status.sources.total).toBe(10);
    expect(status.synthesis.count).toBe(2);
  });

  it("still fails when model_attempts queries hit a non-missing-relation DB error", async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (mentionsTable(sql, "model_attempts")) {
        const err = new Error("deadlock detected") as Error & { code: string };
        err.code = "40P01";
        throw err;
      }
      return baselineStatusResult(sql);
    });

    await expect(getSystemStatus()).rejects.toThrow(/deadlock detected/);
  });
});

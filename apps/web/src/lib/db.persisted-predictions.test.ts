/**
 * Persisted-predictions product read model.
 * Query-shape tests against a mocked pg Pool — no live DB.
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

const { getPersistedPredictions, getPredictions, getResearcherPredictions } = await import("./db");

function allSql(): string[] {
  return mockQuery.mock.calls.map((call) => String(call[0]));
}

function allParams(): unknown[][] {
  return mockQuery.mock.calls.map((call) => (call[1] ?? []) as unknown[]);
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ");
}

function sqlMatching(pattern: RegExp): string {
  const found = allSql().map(normalize).find((sql) => pattern.test(sql));
  expect(found, `expected a query matching ${pattern}`).toBeDefined();
  return found!;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://localhost/test";
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("getPersistedPredictions provenance join", () => {
  it("joins predictions to claims through claim_id, then content and sources", async () => {
    await getPersistedPredictions({ page: 1, pageSize: 20 });

    const itemsSql = sqlMatching(/FROM\s+predictions\s+p/i);
    expect(itemsSql).toMatch(/JOIN\s+extracted_claims\s+e\s+ON\s+p\.claim_id\s*=\s*e\.id/i);
    expect(itemsSql).toMatch(/JOIN\s+content\s+c\s+ON/i);
    expect(itemsSql).toMatch(/JOIN\s+sources\s+s\s+ON/i);
    expect(itemsSql).toMatch(/LEFT JOIN LATERAL/i);
    expect(itemsSql).toMatch(/FROM\s+source_researchers/i);
    expect(itemsSql).toMatch(/JOIN\s+researchers/i);
    expect(itemsSql).not.toMatch(/SELECT \*/i);
    expect(itemsSql).not.toMatch(/p\.author\s+as\s+researcher/i);
    expect(itemsSql).toMatch(/\br\.slug\b/);
  });

  it("projects canonical source URL with claim source_url then content.url fallback", async () => {
    await getPersistedPredictions({});

    const itemsSql = sqlMatching(/canonical_source_url/i);
    expect(itemsSql).toMatch(
      /COALESCE\s*\(\s*NULLIF\s*\(\s*(?:btrim\s*\(\s*)?e\.source_url/i,
    );
    expect(itemsSql).toMatch(/NULLIF\s*\(\s*(?:btrim\s*\(\s*)?c\.url/i);
    expect(itemsSql).toMatch(/original_quote/i);
  });
});

describe("getPersistedPredictions filters, pagination, and ordering", () => {
  it("parameterizes status and topic filters and never interpolates user values", async () => {
    const status = "pending'; DROP TABLE predictions;--";
    const topic = "agents OR 1=1";
    await getPersistedPredictions({ status, topic, page: 1, pageSize: 20 });

    const itemsSql = sqlMatching(/FROM\s+predictions\s+p/i);
    expect(itemsSql).not.toContain(status);
    expect(itemsSql).not.toContain(topic);
    expect(itemsSql).toMatch(/p\.status\s*=\s*\$\d+/i);
    expect(itemsSql).toMatch(/p\.topic\s*=\s*\$\d+/i);

    const bound = allParams().flat().map(String);
    expect(bound).toContain(status);
    expect(bound).toContain(topic);
  });

  it("clamps page and pageSize and parameterizes LIMIT/OFFSET", async () => {
    await getPersistedPredictions({ page: 0, pageSize: 9999 });

    const itemsSql = sqlMatching(/LIMIT/i);
    expect(itemsSql).not.toMatch(/9999/);
    expect(itemsSql).toMatch(/LIMIT\s+\$\d+/i);
    expect(itemsSql).toMatch(/OFFSET\s+\$\d+/i);

    const numeric = allParams()
      .flat()
      .filter((value) => typeof value === "number") as number[];
    expect(numeric.some((n) => n <= 50 && n >= 1)).toBe(true);
    expect(numeric).not.toContain(9999);
    expect(numeric.every((n) => n >= 0)).toBe(true);
  });

  it("orders items deterministically by made_at then id", async () => {
    await getPersistedPredictions({ page: 2, pageSize: 20 });

    const itemsSql = sqlMatching(/ORDER BY/i);
    expect(itemsSql).toMatch(/ORDER BY\s+p\.made_at\s+DESC\s*,\s*p\.id\s+DESC/i);
  });

  it("returns a filtered total for pagination while keeping global counts independent of selection", async () => {
    const globalCandidates = [
      {
        status: "pending",
        due_at: null,
        canonical_source_url: "https://example.com/ok",
        original_quote: "Quoted.",
      },
      {
        status: "pending",
        due_at: null,
        canonical_source_url: "javascript:alert(1)",
        original_quote: "Quoted.",
      },
      {
        status: "too-early",
        due_at: null,
        canonical_source_url: "https://example.com/ok",
        original_quote: "Quoted.",
      },
    ];
    const isSummaryCandidate = (s: string) =>
      /FROM\s+predictions\s+p/i.test(s) &&
      /canonical_source_url/i.test(s) &&
      !/LIMIT/i.test(s);

    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
      if (isSummaryCandidate(s)) {
        return { rows: globalCandidates };
      }
      if (/COUNT\(\*\)/i.test(s) && /FROM\s+predictions/i.test(s)) {
        return { rows: [{ count: "12" }] };
      }
      if (/DISTINCT/i.test(s) && /topic/i.test(s)) {
        return { rows: [{ topic: "agents" }, { topic: "scaling" }] };
      }
      return { rows: [] };
    });

    const filtered = await getPersistedPredictions({
      status: "pending",
      topic: "agents",
      page: 2,
      pageSize: 5,
    });
    expect(filtered.total).toBe(12);
    expect(filtered.summary.tracked).toBe(3);
    expect(filtered.summary.open).toBe(3);
    expect(filtered.summary.resolved).toBe(0);
    expect(filtered.summary.withTargetDate).toBe(0);
    expect(filtered.summary.withSourceAndQuote).toBe(2);
    expect(filtered.topicOptions).toEqual(["agents", "scaling"]);

    const summarySql = predictionSummarySql();
    expect(summarySql).not.toMatch(/LIMIT/i);
    expect(summarySql).not.toMatch(/OFFSET/i);
    expect(summarySql).not.toMatch(/p\.status\s*=\s*\$/i);
    expect(summarySql).not.toMatch(/p\.topic\s*=/i);
    expect(summarySql).not.toContain("agents");
    expect(summarySql).not.toMatch(/make_interval/i);

    mockQuery.mockClear();
    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
      if (isSummaryCandidate(s)) {
        return { rows: globalCandidates };
      }
      if (/COUNT\(\*\)/i.test(s) && /FROM\s+predictions/i.test(s)) {
        return { rows: [{ count: "238" }] };
      }
      if (/DISTINCT/i.test(s) && /topic/i.test(s)) {
        return { rows: [{ topic: "agents" }, { topic: "scaling" }] };
      }
      return { rows: [] };
    });

    const unfiltered = await getPersistedPredictions({ page: 1, pageSize: 20 });
    expect(unfiltered.total).toBe(238);
    expect(unfiltered.summary).toEqual(filtered.summary);
  });
});

function predictionSummarySql(): string {
  const found = allSql()
    .map(normalize)
    .find(
      (sql) =>
        /FROM\s+predictions\s+p/i.test(sql) &&
        /canonical_source_url/i.test(sql) &&
        /original_quote/i.test(sql) &&
        !/LIMIT/i.test(sql) &&
        !/OFFSET/i.test(sql),
    );
  expect(found, "expected an unbounded prediction summary candidate query").toBeDefined();
  return found!;
}

describe("getPersistedPredictions exact JS summary admission", () => {
  it("loads unbounded candidate rows and counts source+quote with safeAbsoluteHttpUrl, not a weaker SQL regex", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
      if (
        /FROM\s+predictions\s+p/i.test(s) &&
        /canonical_source_url/i.test(s) &&
        !/LIMIT/i.test(s)
      ) {
        return {
          rows: [
            {
              status: "pending",
              due_at: null,
              canonical_source_url: "https://example.com/ok",
              original_quote: "Quoted.",
            },
            {
              status: "pending",
              due_at: null,
              canonical_source_url: "javascript:alert(1)",
              original_quote: "Quoted.",
            },
            {
              status: "pending",
              due_at: null,
              canonical_source_url: "https://user:pass@example.com/secret",
              original_quote: "Quoted.",
            },
            {
              status: "verified",
              due_at: "2026-01-01T00:00:00.000Z",
              canonical_source_url: "https://example.com/ok",
              original_quote: "   ",
            },
          ],
        };
      }
      if (/COUNT\(\*\)/i.test(s) && /FROM\s+predictions/i.test(s)) {
        return { rows: [{ count: "4" }] };
      }
      if (/DISTINCT/i.test(s) && /topic/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await getPersistedPredictions({
      status: "pending",
      topic: "agents",
      page: 2,
      pageSize: 5,
    });
    expect(result.summary.tracked).toBe(4);
    expect(result.summary.withSourceAndQuote).toBe(1);
    expect(result.summary.open).toBe(3);
    expect(result.summary.resolved).toBe(1);
    expect(result.summary.withTargetDate).toBe(1);

    const summarySql = predictionSummarySql();
    expect(summarySql).toMatch(/\bp\.status\b/);
    expect(summarySql).toMatch(/\bp\.due_at\b/);
    expect(summarySql).not.toMatch(/~\s*\*/);
    expect(summarySql).not.toMatch(/COUNT\s*\(/i);
    expect(summarySql).not.toMatch(/p\.status\s*=\s*\$/i);
    expect(summarySql).not.toMatch(/p\.topic\s*=/i);
    expect(summarySql).not.toContain("agents");
    expect(summarySql).not.toMatch(/source_researchers/i);
    expect(summarySql).not.toMatch(/SELECT \*/i);
  });
});

describe("getPersistedPredictions researcher cardinality", () => {
  it("selects one deterministic researcher per prediction and cannot multiply rows", async () => {
    await getPersistedPredictions({ page: 1, pageSize: 20 });

    const itemsSql = sqlMatching(/LIMIT/i);
    expect(itemsSql).toMatch(/LEFT JOIN LATERAL/i);
    expect(itemsSql).toMatch(/ORDER BY\s+r\.slug/i);
    expect(itemsSql).toMatch(/LIMIT\s+1/);
    expect(itemsSql).toMatch(/\br\.slug\b/);
    expect(itemsSql).toMatch(/r\.display_name/);
    expect(itemsSql).not.toMatch(
      /LEFT JOIN\s+source_researchers\s+\w+\s+ON\s+\w+\.source_id\s*=\s*s\.id/i,
    );
    expect(itemsSql).not.toMatch(/SELECT\s+DISTINCT\b/i);
    expect(itemsSql).not.toMatch(/p\.author\s+as\s+researcher/i);

    const countSql = allSql()
      .map(normalize)
      .find((sql) => /COUNT\(\*\)/i.test(sql) && /FROM\s+predictions/i.test(sql));
    expect(countSql, "expected a filtered prediction count query").toBeDefined();
    expect(countSql!).toMatch(/LEFT JOIN LATERAL/i);
    expect(countSql!).not.toMatch(
      /LEFT JOIN\s+source_researchers\s+\w+\s+ON\s+\w+\.source_id\s*=\s*s\.id/i,
    );
    expect(countSql!).not.toMatch(/SELECT\s+DISTINCT\b/i);
  });
});

describe("existing prediction loaders stay backwards compatible", () => {
  it("keeps getPredictions on the predictions table without a claim provenance join", async () => {
    await getPredictions({ status: "pending", author: "sama", limit: 50 });
    const sql = normalize(String(mockQuery.mock.calls[0][0]));
    expect(sql).toMatch(/FROM predictions/i);
    expect(sql).not.toMatch(/extracted_claims/i);
    expect(sql).toMatch(/status = \$1/);
    expect(sql).toMatch(/author = \$2/);
    expect(mockQuery.mock.calls[0][1]).toEqual(["pending", "sama", 50]);
  });

  it("keeps researcher predictions on the claim_id join", async () => {
    await getResearcherPredictions("darioamodei", 90);
    const sql = normalize(String(mockQuery.mock.calls[0][0]));
    expect(sql).toMatch(/p\.claim_id\s*=\s*e\.id/i);
    expect(sql).toMatch(/s\.identifier\s*=\s*\$1/i);
    expect(mockQuery.mock.calls[0][1]).toEqual(["darioamodei", 90]);
  });
});

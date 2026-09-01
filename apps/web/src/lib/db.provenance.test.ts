/**
 * Provenance + researcher trust contracts for the public read model.
 * Query-shape / behavior tests against a mocked pg Pool — no live DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const mockQuery = vi.fn();

vi.mock("pg", () => {
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

// Import after mock so the module binds to mockQuery
const {
  getClaims,
  getClaimsByTopic,
  getResearcherClaims,
  getResearchers,
  getSystemStatus,
} = await import("./db");

const CLAIM_READ_FNS = [
  { name: "getClaims", run: () => getClaims({ limit: 10 }) },
  {
    name: "getClaimsByTopic",
    run: () => getClaimsByTopic("reasoning", 30),
  },
  {
    name: "getResearcherClaims",
    run: () => getResearcherClaims("darioamodei", 90),
  },
] as const;

function allSql(): string[] {
  return mockQuery.mock.calls.map((c) => String(c[0]));
}

function claimSelectSql(): string {
  // Last SELECT that projects claim fields
  const sqls = allSql().filter(
    (s) =>
      /SELECT/i.test(s) &&
      /extracted_claims/i.test(s) &&
      /source_url/i.test(s),
  );
  expect(sqls.length).toBeGreaterThan(0);
  return sqls[sqls.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://localhost/test";
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("claim read provenance contract", () => {
  for (const fn of CLAIM_READ_FNS) {
    it(`${fn.name} uses COALESCE source_url fallback and source identifier as author_handle`, async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (/COUNT\(\*\)/i.test(sql)) {
          return { rows: [{ count: "0" }] };
        }
        return { rows: [] };
      });

      await fn.run();

      const sql = claimSelectSql();
      // Canonical URL fallback — not raw e.source_url alone
      expect(sql.replace(/\s+/g, " ")).toMatch(
        /COALESCE\s*\(\s*NULLIF\s*\(\s*e\.source_url\s*,\s*''\s*\)\s*,\s*NULLIF\s*\(\s*c\.url\s*,\s*''\s*\)\s*\)/i,
      );
      // author_handle is the canonical researcher slug when mapped; source identifier stays provenance
      expect(sql).toMatch(/s\.identifier\s+as\s+source_identifier/i);
      expect(sql).not.toMatch(
        /(?:^|[^\w.])author\s+as\s+author_handle/i,
      );
      // Must join content + sources for the contract
      expect(sql).toMatch(/JOIN\s+content\s+c\s+ON/i);
      expect(sql).toMatch(/JOIN\s+sources\s+s\s+ON/i);
    });

    it(`${fn.name} parameterizes days (and author when present)`, async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
        return { rows: [] };
      });

      await fn.run();

      const calls = mockQuery.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [, params] of calls) {
        if (Array.isArray(params)) {
          // No raw string interpolation of free-form filter values into SQL
          expect(params.every((p) => typeof p !== "undefined")).toBe(true);
        }
      }
      const sqlJoined = allSql().join("\n");
      expect(sqlJoined).toMatch(/make_interval\s*\(\s*days\s*=>\s*\$\d+\s*\)/i);
    });
  }

  it("getClaims filters author via s.identifier with a bound parameter", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });

    await getClaims({ author: "sama", days: 90, limit: 50 });

    const countCall = mockQuery.mock.calls.find((c) =>
      /COUNT\(\*\)/i.test(String(c[0])),
    );
    expect(countCall).toBeDefined();
    expect(String(countCall![0])).toMatch(/s\.identifier\s*=\s*\$\d+/i);
    expect(countCall![1]).toContain("sama");
    expect(countCall![1]).toContain(90);
  });
});

describe("getSystemStatus provenance coverage", () => {
  it("reports total, url-backed, author-identified, and zero-safe percentages", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, " ");
      if (/FROM\s+sources/i.test(s) && /COUNT/i.test(s)) {
        return { rows: [{ total: "10", active: "8" }] };
      }
      if (/FROM\s+content/i.test(s) && /total_content/i.test(s)) {
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
      if (/FROM\s+extracted_claims/i.test(s) && /url_backed|with_source/i.test(s)) {
        return {
          rows: [
            {
              total: "4",
              last_24h: "1",
              url_backed: "3",
              author_identified: "2",
            },
          ],
        };
      }
      if (/FROM\s+synthesis_results/i.test(s)) {
        return { rows: [{ latest: "2026-01-01", count: "2" }] };
      }
      return { rows: [] };
    });

    const status = await getSystemStatus();

    expect(status.claims.total).toBe(4);
    expect(status.claims.last_24h).toBe(1);
    expect(status.claims.url_backed).toBe(3);
    expect(status.claims.author_identified).toBe(2);
    expect(status.claims.url_backed_pct).toBe(75);
    expect(status.claims.author_identified_pct).toBe(50);

    const claimsSql = allSql().find(
      (s) => /extracted_claims/i.test(s) && /url_backed/i.test(s),
    );
    expect(claimsSql).toBeDefined();
    const normalized = claimsSql!.replace(/\s+/g, " ");
    expect(normalized).toMatch(
      /COALESCE\s*\(\s*NULLIF\s*\(\s*e\.source_url\s*,\s*''\s*\)\s*,\s*NULLIF\s*\(\s*c\.url\s*,\s*''\s*\)\s*\)/i,
    );
    expect(normalized).toMatch(/s\.identifier/i);
    expect(normalized).toMatch(/JOIN\s+content\s+c/i);
    expect(normalized).toMatch(/JOIN\s+sources\s+s/i);
  });

  it("returns 0% coverage when there are zero claims", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, " ");
      if (/FROM\s+sources/i.test(s)) {
        return { rows: [{ total: "0", active: "0" }] };
      }
      if (/FROM\s+content/i.test(s) && /total_content/i.test(s)) {
        return {
          rows: [
            {
              total_content: "0",
              processed_content: "0",
              unprocessed_content: "0",
              content_last_24h: "0",
            },
          ],
        };
      }
      if (/FROM\s+extracted_claims/i.test(s)) {
        return {
          rows: [
            {
              total: "0",
              last_24h: "0",
              url_backed: "0",
              author_identified: "0",
            },
          ],
        };
      }
      if (/FROM\s+synthesis_results/i.test(s)) {
        return { rows: [{ latest: null, count: "0" }] };
      }
      return { rows: [] };
    });

    const status = await getSystemStatus();
    expect(status.claims.total).toBe(0);
    expect(status.claims.url_backed_pct).toBe(0);
    expect(status.claims.author_identified_pct).toBe(0);
  });
});

describe("researcher public window consistency", () => {
  it("defaults getResearchers to the explicit 90-day public window", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await getResearchers();
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([90]);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(
      /make_interval\s*\(\s*days\s*=>\s*\$1\s*\)/i,
    );
  });

  it("getClaims total (not page length) is the detail headline contract", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "120" }] };
      return {
        rows: Array.from({ length: 50 }, (_, i) => ({
          id: `c${i}`,
          claim_text: "x",
          author_handle: "sama",
          source_url: "https://example.com/x",
        })),
      };
    });

    const result = await getClaims({ author: "sama", days: 90, limit: 50 });
    expect(result.claims).toHaveLength(50);
    expect(result.total).toBe(120);
    // Callers must use total for headline counts — surface the contract
    expect(result.total).not.toBe(result.claims.length);
  });
});

describe("backfill-claim-provenance.sql contract", () => {
  const scriptPath = path.resolve(
    __dirname,
    "../../../../scripts/backfill-claim-provenance.sql",
  );

  it("exists and is additive/idempotent with before/after coverage", () => {
    const sql = readFileSync(scriptPath, "utf8");
    const normalized = sql.replace(/\s+/g, " ").toLowerCase();

    // Transaction-safe
    expect(normalized).toMatch(/begin\b/);
    expect(normalized).toMatch(/commit\b/);

    // Only fills blank/missing — never overwrites nonblank
    expect(normalized).toMatch(/nullif\s*\(\s*e\.source_url/);
    expect(normalized).toMatch(
      /coalesce\s*\(\s*nullif\s*\(\s*e\.source_url\s*,\s*''\s*\)/,
    );
    // UPDATE must guard existing nonblank values
    expect(normalized).toMatch(
      /where[\s\S]*?(e\.source_url\s+is\s+null|nullif\s*\(\s*e\.source_url)/i,
    );

    // Before/after coverage selects
    const selectCount = (sql.match(/\bSELECT\b/gi) || []).length;
    expect(selectCount).toBeGreaterThanOrEqual(2);

    // No destructive ops
    expect(normalized).not.toMatch(/\bdrop\s+table\b/);
    expect(normalized).not.toMatch(/\btruncate\b/);
    expect(normalized).not.toMatch(/\bdelete\s+from\b/);
    expect(normalized).not.toMatch(/\bdrop\s+column\b/);
  });

  it("is idempotent: second run would no-op nonblank values (static guard)", () => {
    const sql = readFileSync(scriptPath, "utf8");
    // Must set source_url via COALESCE of existing first
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /source_url\s*=\s*COALESCE\s*\(\s*NULLIF\s*\(\s*e\.source_url\s*,\s*''\s*\)/i,
    );
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /author\s*=\s*COALESCE\s*\(\s*NULLIF\s*\(\s*e\.author\s*,\s*''\s*\)/i,
    );
  });
});

describe("unsupported public accuracy copy", () => {
  const roots = [
    path.resolve(__dirname, "../app/page.tsx"),
    path.resolve(__dirname, "../app/researchers/page.tsx"),
    path.resolve(__dirname, "../app/researchers/[handle]/page.tsx"),
  ];

  it("public pages do not promise prediction accuracy / track record", () => {
    for (const file of roots) {
      const text = readFileSync(file, "utf8").toLowerCase();
      expect(text).not.toMatch(/prediction accuracy/);
      expect(text).not.toMatch(/track[\s-]?record/);
      expect(text).not.toMatch(/accuracy over time/);
    }
  });

  it("researcher list/detail label the 90-day window", () => {
    const list = readFileSync(
      path.resolve(__dirname, "../app/researchers/page.tsx"),
      "utf8",
    );
    const detail = readFileSync(
      path.resolve(__dirname, "../app/researchers/[handle]/page.tsx"),
      "utf8",
    );
    expect(list).toMatch(/90/);
    expect(detail).toMatch(/90/);
    // Detail headline must use query total, not the limited page length
    expect(detail).toMatch(/claimsResult\.total/);
    expect(detail).toMatch(/Claims \(90d\)/);
    expect(list).toMatch(/Claims \(90d\)/);
  });
});

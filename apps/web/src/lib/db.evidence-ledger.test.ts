/**
 * Live evidence-ledger + claim-detail + researcher-prediction read models.
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

const {
  getClaimDetail,
  getLiveEvidenceLedger,
  getResearchers,
  getResearcherPredictions,
  getSystemStatus,
} = await import("./db");

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

describe("getLiveEvidenceLedger", () => {
  it("admits only rows with nonblank canonical source URL and verbatim quote", async () => {
    await getLiveEvidenceLedger({ limit: 20 });

    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
    const selectedSql = sqlMatching(/LIMIT\s+\$1/i);
    expect(selectedSql).toMatch(
      /COALESCE\s*\(\s*NULLIF\s*\(\s*(?:btrim\s*\(\s*)?e\.source_url/i,
    );
    expect(selectedSql).toMatch(/NULLIF\s*\(\s*(?:btrim\s*\(\s*)?c\.url/i);
    expect(selectedSql).toMatch(/original_quote/i);
    expect(selectedSql).toMatch(/WHERE/i);
    expect(selectedSql).toMatch(
      /NULLIF\s*\(\s*(?:btrim\s*\(\s*)?e\.original_quote/i,
    );
    expect(selectedSql).not.toMatch(/SELECT \*/i);
    expect(selectedSql).toMatch(/LEFT JOIN\s+predictions\s+p\s+ON\s+p\.claim_id\s*=\s*e\.id/i);
    expect(selectedSql).toMatch(/JOIN\s+content\s+c\s+ON/i);
    expect(selectedSql).toMatch(/JOIN\s+sources\s+s\s+ON/i);
    expect(selectedSql).toMatch(/p\.evidence\s+as\s+prediction_evidence/i);
    expect(selectedSql).toMatch(/p\.evidence_url\s+as\s+prediction_evidence_url/i);

    const summarySql = liveSummaryCandidateSql();
    expect(summarySql).toMatch(
      /COALESCE\s*\(\s*NULLIF\s*\(\s*(?:btrim\s*\(\s*)?e\.source_url/i,
    );
    expect(summarySql).toMatch(/NULLIF\s*\(\s*(?:btrim\s*\(\s*)?c\.url/i);
    expect(summarySql).toMatch(/original_quote/i);
    expect(summarySql).not.toMatch(/SELECT \*/i);
    expect(summarySql).toMatch(/LEFT JOIN\s+predictions\s+p\s+ON\s+p\.claim_id\s*=\s*e\.id/i);
    expect(summarySql).toMatch(/JOIN\s+content\s+c\s+ON/i);
    expect(summarySql).not.toMatch(/COUNT\s*\(/i);
  });

  it("projects e.id as the live card id and parameterizes limit", async () => {
    await getLiveEvidenceLedger({ limit: 12 });

    const sql = sqlMatching(/LIMIT\s+\$1/i);
    expect(sql).toMatch(/\be\.id\b/);
    expect(sql).toMatch(/LIMIT\s+\$1/i);
    const selectedParams = mockQuery.mock.calls.find((call) =>
      /LIMIT\s+\$1/i.test(String(call[0])),
    )?.[1];
    expect(selectedParams).toEqual([12]);
    expect(sql).toMatch(/ORDER BY/i);
    expect(sql).toMatch(/e\.extracted_at\s+DESC/i);
  });

  it("maps pending past-due prediction rows to overdue without inventing evidence", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "claim_overdue_1",
          claim_text: "The eval will ship in Q1.",
          claim_type: "prediction",
          topic: "agents",
          stance: "bullish",
          author_handle: "sama",
          author_name: "Sam Altman",
          canonical_source_url: "https://openai.com/blog/eval",
          original_quote: "The eval will ship in Q1.",
          extracted_at: "2026-01-02T00:00:00.000Z",
          published_at: "2026-01-01T00:00:00.000Z",
          prediction_status: "pending",
          prediction_due_at: "2026-03-31T00:00:00.000Z",
          prediction_outcome_summary: null,
          prediction_evidence: null,
          prediction_evidence_url: null,
          prediction_next_observable: null,
          prediction_next_question: null,
          prediction_verified_at: null,
        },
      ],
    });

    const { cards } = await getLiveEvidenceLedger({
      limit: 20,
      now: new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("claim_overdue_1");
    expect(cards[0].presentationStatus).toBe("overdue");
    expect(cards[0].outcomeEvidence).toBeNull();
    expect(cards[0].nextObservable).toBeNull();
    expect(cards[0].canonicalSourceUrl).toBe("https://openai.com/blog/eval");
    expect(cards[0].originalQuote).toBe("The eval will ship in Q1.");
  });

  it("clamps limit and does not interpolate it into SQL", async () => {
    await getLiveEvidenceLedger({ limit: 9999 });
    const selectedCall = mockQuery.mock.calls.find((call) =>
      /LIMIT\s+\$1/i.test(String(call[0])),
    );
    expect(selectedCall).toBeDefined();
    const sql = String(selectedCall?.[0]);
    expect(sql).not.toMatch(/9999/);
    expect(selectedCall?.[1][0]).toBeLessThanOrEqual(50);
    expect(sql).toMatch(/LIMIT\s+\$1/i);
  });

  it("drops unsafe javascript: canonical sources from the admitted ledger", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "claim_unsafe_js",
          claim_text: "Ignore this.",
          claim_type: "fact",
          topic: "agents",
          stance: null,
          author_handle: "sama",
          author_name: "Sam Altman",
          canonical_source_url: "javascript:alert(1)",
          original_quote: "Quoted.",
          extracted_at: "2026-01-02T00:00:00.000Z",
          published_at: "2026-01-01T00:00:00.000Z",
          prediction_status: null,
          prediction_due_at: null,
          prediction_outcome_summary: null,
          prediction_evidence: null,
          prediction_evidence_url: null,
          prediction_next_observable: null,
          prediction_next_question: null,
          prediction_verified_at: null,
        },
        {
          id: "claim_safe_http",
          claim_text: "Keep this.",
          claim_type: "fact",
          topic: "agents",
          stance: null,
          author_handle: "sama",
          author_name: "Sam Altman",
          canonical_source_url: "https://openai.com/blog/eval",
          original_quote: "Quoted safely.",
          extracted_at: "2026-01-02T00:00:00.000Z",
          published_at: "2026-01-01T00:00:00.000Z",
          prediction_status: null,
          prediction_due_at: null,
          prediction_outcome_summary: null,
          prediction_evidence: null,
          prediction_evidence_url: null,
          prediction_next_observable: null,
          prediction_next_question: null,
          prediction_verified_at: null,
        },
      ],
    });

    const { cards } = await getLiveEvidenceLedger({ limit: 20 });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("claim_safe_http");
    expect(cards[0].canonicalSourceUrl).toBe("https://openai.com/blog/eval");
  });

  it("queries a whole-corpus admitted summary separately from the bounded selected cards", async () => {
    const candidates = [
      {
        canonical_source_url: "https://ok.example/a",
        original_quote: "Quoted.",
        claim_type: "prediction",
        prediction_status: "pending",
        prediction_due_at: "2026-12-31T00:00:00.000Z",
      },
      {
        canonical_source_url: "https://ok.example/b",
        original_quote: "Quoted.",
        claim_type: "prediction",
        prediction_status: "too-early",
        prediction_due_at: null,
      },
      {
        canonical_source_url: "https://ok.example/c",
        original_quote: "Quoted.",
        claim_type: "fact",
        prediction_status: null,
        prediction_due_at: null,
      },
      {
        canonical_source_url: "javascript:alert(1)",
        original_quote: "Quoted.",
        claim_type: "prediction",
        prediction_status: "pending",
        prediction_due_at: "2026-12-31T00:00:00.000Z",
      },
    ];
    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
      if (
        /FROM\s+extracted_claims/i.test(s) &&
        /canonical_source_url/i.test(s) &&
        !/LIMIT/i.test(s) &&
        !/e\.id\s*=\s*\$/i.test(s)
      ) {
        return { rows: candidates };
      }
      return { rows: [] };
    });

    const limited = await getLiveEvidenceLedger({
      limit: 20,
      now: new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(limited.cards).toEqual([]);
    expect(limited.summary).toEqual({
      admittedCount: 3,
      quoteBackedCount: 3,
      admittedPredictionCount: 2,
      openPredictionCount: 2,
      overdueCount: 0,
      resolvedCount: 0,
      evidenceOnlyCount: 1,
    });

    const summarySql = liveSummaryCandidateSql();
    expect(summarySql).not.toMatch(/LIMIT/i);
    expect(summarySql).not.toMatch(/COUNT\s*\(/i);
    expect(summarySql).toMatch(/original_quote/i);
    expect(summarySql).toMatch(/NULLIF\s*\(\s*(?:btrim\s*\(\s*)?e\.original_quote/i);
    expect(summarySql).toMatch(/COALESCE\s*\(\s*NULLIF\s*\(\s*(?:btrim\s*\(\s*)?e\.source_url/i);
    expect(summarySql).toMatch(/LEFT JOIN\s+predictions\s+p\s+ON\s+p\.claim_id\s*=\s*e\.id/i);
    expect(summarySql).not.toMatch(/timeframe/i);
    expect(summarySql).not.toMatch(/SELECT \*/i);

    const selectedSql = sqlMatching(/LIMIT\s+\$\d+/i);
    expect(selectedSql).not.toEqual(summarySql);
    expect(selectedSql).toMatch(/ORDER BY/i);
    expect(selectedSql).toMatch(/e\.claim_type\s*=\s*'prediction'/i);
    const orderAt = selectedSql.search(/ORDER BY/i);
    const predictionAt = selectedSql.indexOf("prediction", orderAt);
    const extractedAt = selectedSql.search(/e\.extracted_at\s+DESC/i);
    expect(predictionAt).toBeGreaterThan(orderAt);
    expect(extractedAt).toBeGreaterThan(predictionAt);
    expect(selectedSql).toMatch(/e\.id\s+DESC/i);
  });

  it("keeps global JS summary independent of selected-row limit", async () => {
    const candidates = [
      {
        canonical_source_url: "https://ok.example/a",
        original_quote: "Quoted.",
        claim_type: "prediction",
        prediction_status: "pending",
        prediction_due_at: "2026-01-01T00:00:00.000Z",
      },
      {
        canonical_source_url: "https://ok.example/b",
        original_quote: "Quoted.",
        claim_type: "prediction",
        prediction_status: "verified",
        prediction_due_at: "2026-01-01T00:00:00.000Z",
      },
      {
        canonical_source_url: "https://ok.example/c",
        original_quote: "Quoted.",
        claim_type: "fact",
        prediction_status: null,
        prediction_due_at: null,
      },
      {
        canonical_source_url: "javascript:alert(1)",
        original_quote: "Quoted.",
        claim_type: "fact",
        prediction_status: null,
        prediction_due_at: null,
      },
    ];
    const selectedCard = {
      id: "claim_safe_http",
      claim_text: "Keep this.",
      claim_type: "fact",
      topic: "agents",
      stance: null,
      author_handle: "sama",
      author_name: "Sam Altman",
      canonical_source_url: "https://openai.com/blog/eval",
      original_quote: "Quoted safely.",
      extracted_at: "2026-01-02T00:00:00.000Z",
      published_at: "2026-01-01T00:00:00.000Z",
      prediction_status: null,
      prediction_due_at: null,
      prediction_outcome_summary: null,
      prediction_evidence: null,
      prediction_evidence_url: null,
      prediction_next_observable: null,
      prediction_next_question: null,
      prediction_verified_at: null,
    };
    const isSummaryCandidate = (s: string) =>
      /FROM\s+extracted_claims/i.test(s) &&
      /canonical_source_url/i.test(s) &&
      !/LIMIT/i.test(s) &&
      !/e\.id\s*=\s*\$/i.test(s);

    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
      if (isSummaryCandidate(s)) return { rows: candidates };
      return { rows: [selectedCard] };
    });

    const first = await getLiveEvidenceLedger({
      limit: 1,
      now: new Date("2026-08-28T12:00:00.000Z"),
    });
    expect(first.cards).toHaveLength(1);
    expect(first.summary.admittedCount).toBe(3);
    expect(first.summary.quoteBackedCount).toBe(3);
    expect(first.summary.admittedPredictionCount).toBe(2);
    expect(first.summary.openPredictionCount).toBe(1);
    expect(first.summary.overdueCount).toBe(1);
    expect(first.summary.resolvedCount).toBe(1);
    expect(first.summary.evidenceOnlyCount).toBe(1);
    expect(first.summary.admittedCount).not.toBe(first.cards.length);

    mockQuery.mockClear();
    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
      if (isSummaryCandidate(s)) return { rows: candidates };
      return { rows: [] };
    });

    const emptySelection = await getLiveEvidenceLedger({
      limit: 20,
      now: new Date("2026-08-28T12:00:00.000Z"),
    });
    expect(emptySelection.cards).toEqual([]);
    expect(emptySelection.summary).toEqual(first.summary);
  });

  it("projects due_at and status on unbounded candidates so JS can count overdue and resolved", async () => {
    await getLiveEvidenceLedger({
      limit: 20,
      now: new Date("2026-08-30T12:00:00.000Z"),
    });

    const summarySql = liveSummaryCandidateSql();
    expect(summarySql).toMatch(/p\.due_at/i);
    expect(summarySql).toMatch(/p\.status/i);
    expect(summarySql).toMatch(/claim_type/i);
    expect(summarySql).not.toMatch(/timeframe/i);
    expect(summarySql).not.toMatch(/LIMIT/i);
    expect(summarySql).not.toMatch(/COUNT\s*\(/i);

    const summaryCall = mockQuery.mock.calls.find((call) => {
      const sql = normalize(String(call[0]));
      return (
        /FROM\s+extracted_claims/i.test(sql) &&
        /canonical_source_url/i.test(sql) &&
        !/LIMIT/i.test(sql)
      );
    });
    expect(summaryCall?.[1] ?? []).toEqual([]);
  });

  it("parameterizes and clamps selected-row limit without interpolating it", async () => {
    await getLiveEvidenceLedger({ limit: 12 });
    const selectedSql = sqlMatching(/LIMIT\s+\$\d+/i);
    expect(selectedSql).toMatch(/LIMIT\s+\$1/i);
    const selectedParams = mockQuery.mock.calls.find((call) =>
      /LIMIT\s+\$1/i.test(String(call[0])),
    )?.[1] as unknown[];
    expect(selectedParams).toEqual([12]);

    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
    await getLiveEvidenceLedger({ limit: 9999 });
    const clampedSql = String(
      mockQuery.mock.calls.find((call) => /LIMIT\s+\$1/i.test(String(call[0])))?.[0],
    );
    expect(clampedSql).not.toMatch(/9999/);
    const clampedParams = mockQuery.mock.calls.find((call) =>
      /LIMIT\s+\$1/i.test(String(call[0])),
    )?.[1] as unknown[];
    expect(clampedParams[0]).toBeLessThanOrEqual(50);
    expect(clampedParams[0]).toBeGreaterThanOrEqual(1);
    expect(allParams().flat()).not.toContain(9999);
  });
});

function liveSummaryCandidateSql(): string {
  const found = allSql()
    .map(normalize)
    .find(
      (sql) =>
        /FROM\s+extracted_claims/i.test(sql) &&
        /canonical_source_url/i.test(sql) &&
        /original_quote/i.test(sql) &&
        !/LIMIT/i.test(sql) &&
        !/e\.id\s*=\s*\$/i.test(sql),
    );
  expect(found, "expected an unbounded live-ledger summary candidate query").toBeDefined();
  return found!;
}

describe("getLiveEvidenceLedger exact JS summary admission", () => {
  it("loads unbounded candidate rows and admits coverage with safeAbsoluteHttpUrl, not SQL nonblank URL", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
      if (
        /FROM\s+extracted_claims/i.test(s) &&
        /canonical_source_url/i.test(s) &&
        !/LIMIT/i.test(s) &&
        !/e\.id\s*=\s*\$/i.test(s)
      ) {
        return {
          rows: [
            {
              canonical_source_url: "https://openai.com/blog/eval",
              original_quote: "Quoted safely.",
              claim_type: "prediction",
              prediction_status: "pending",
              prediction_due_at: "2026-12-31T00:00:00.000Z",
            },
            {
              canonical_source_url: "javascript:alert(1)",
              original_quote: "Quoted.",
              claim_type: "prediction",
              prediction_status: "pending",
              prediction_due_at: "2026-12-31T00:00:00.000Z",
            },
            {
              canonical_source_url: "https://user:pass@example.com/secret",
              original_quote: "Quoted.",
              claim_type: "fact",
              prediction_status: null,
              prediction_due_at: null,
            },
            {
              canonical_source_url: "https://openai.com/blog/eval",
              original_quote: "   ",
              claim_type: "prediction",
              prediction_status: "verified",
              prediction_due_at: "2026-01-01T00:00:00.000Z",
            },
            {
              canonical_source_url: "https://openai.com/blog/eval",
              original_quote: "Past due.",
              claim_type: "prediction",
              prediction_status: "pending",
              prediction_due_at: "2026-01-01T00:00:00.000Z",
            },
            {
              canonical_source_url: "https://openai.com/blog/eval",
              original_quote: "Resolved.",
              claim_type: "prediction",
              prediction_status: "falsified",
              prediction_due_at: "2026-01-01T00:00:00.000Z",
            },
            {
              canonical_source_url: "https://openai.com/blog/eval",
              original_quote: "Evidence only.",
              claim_type: "fact",
              prediction_status: null,
              prediction_due_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { cards, summary } = await getLiveEvidenceLedger({
      limit: 20,
      now: new Date("2026-08-28T12:00:00.000Z"),
    });
    expect(cards).toEqual([]);
    expect(summary).toEqual({
      admittedCount: 4,
      quoteBackedCount: 4,
      admittedPredictionCount: 3,
      openPredictionCount: 2,
      overdueCount: 1,
      resolvedCount: 1,
      evidenceOnlyCount: 1,
    });

    const summarySql = liveSummaryCandidateSql();
    expect(summarySql).toMatch(/claim_type/i);
    expect(summarySql).toMatch(/p\.status/i);
    expect(summarySql).toMatch(/p\.due_at/i);
    expect(summarySql).not.toMatch(/COUNT\s*\(/i);
    expect(summarySql).not.toMatch(/source_researchers/i);
    expect(summarySql).not.toMatch(/SELECT \*/i);
    expect(summarySql).toMatch(/LEFT JOIN\s+predictions\s+p\s+ON\s+p\.claim_id\s*=\s*e\.id/i);
  });
});

describe("getLiveEvidenceLedger researcher cardinality", () => {
  it("selects one deterministic researcher per claim and cannot multiply rows", async () => {
    await getLiveEvidenceLedger({ limit: 12 });

    const selectedSql = sqlMatching(/LIMIT\s+\$1/i);
    expect(selectedSql).toMatch(/LEFT JOIN LATERAL/i);
    expect(selectedSql).toMatch(/ORDER BY\s+r\.slug/i);
    expect(selectedSql).toMatch(/LIMIT\s+1/);
    expect(selectedSql).toMatch(/\br\.slug\b/);
    expect(selectedSql).not.toMatch(
      /LEFT JOIN\s+source_researchers\s+\w+\s+ON\s+\w+\.source_id\s*=\s*s\.id/i,
    );
    expect(selectedSql).not.toMatch(/SELECT\s+DISTINCT\b/i);
    expect(selectedSql).not.toMatch(/\bp\.author\b/);
  });
});

describe("getClaimDetail", () => {
  it("loads a single claim by parameterized id using the shared projection", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "claim_detail_1",
          claim_text: "Scaling laws will hold through 2027.",
          claim_type: "prediction",
          topic: "scaling",
          stance: "bullish",
          author_handle: "ilyasut",
          author_name: "Ilya Sutskever",
          canonical_source_url: "https://example.com/scaling",
          original_quote: "Scaling laws will hold through 2027.",
          extracted_at: "2026-08-01T00:00:00.000Z",
          published_at: "2026-08-01T00:00:00.000Z",
          prediction_status: "pending",
          prediction_due_at: "2027-12-31T00:00:00.000Z",
          prediction_outcome_summary: null,
          prediction_evidence: null,
          prediction_evidence_url: null,
          prediction_next_observable: "A 2027 scaling paper.",
          prediction_next_question: "Did the paper land?",
          prediction_verified_at: null,
        },
      ],
    });

    const claim = await getClaimDetail("claim_detail_1");
    expect(claim).not.toBeNull();
    expect(claim?.id).toBe("claim_detail_1");
    expect(claim?.canonicalSourceUrl).toBe("https://example.com/scaling");
    expect(claim?.originalQuote).toBe("Scaling laws will hold through 2027.");
    expect(claim?.authorHandle).toBe("ilyasut");

    const sql = normalize(String(mockQuery.mock.calls[0][0]));
    expect(sql).toMatch(/e\.id\s*=\s*\$1/i);
    expect(mockQuery.mock.calls[0][1]).toEqual(["claim_detail_1"]);
    expect(sql).not.toMatch(/SELECT \*/i);
    expect(sql).toMatch(/LEFT JOIN\s+predictions\s+p\s+ON\s+p\.claim_id\s*=\s*e\.id/i);
  });

  it("returns null for a missing or invalid claim id without interpolating the id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getClaimDetail("missing_claim")).resolves.toBeNull();

    expect(mockQuery.mock.calls[0][1]).toEqual(["missing_claim"]);
    expect(String(mockQuery.mock.calls[0][0])).not.toMatch(/missing_claim/);

    mockQuery.mockClear();
    await expect(getClaimDetail("bad id / injection")).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("keeps a non-admitted detail row but blanks an unsafe source instead of emitting an href value", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "claim_detail_1",
          claim_text: "Scaling laws will hold through 2027.",
          claim_type: "prediction",
          topic: "scaling",
          stance: "bullish",
          author_handle: "ilyasut",
          author_name: "Ilya Sutskever",
          canonical_source_url: "javascript:alert(1)",
          original_quote: "Scaling laws will hold through 2027.",
          extracted_at: "2026-08-01T00:00:00.000Z",
          published_at: "2026-08-01T00:00:00.000Z",
          prediction_status: "pending",
          prediction_due_at: "2027-12-31T00:00:00.000Z",
          prediction_outcome_summary: null,
          prediction_evidence: "https://example.com/from-evidence-text",
          prediction_evidence_url: "https://example.com/safe-evidence",
          prediction_next_observable: "A 2027 scaling paper.",
          prediction_next_question: "Did the paper land?",
          prediction_verified_at: null,
        },
      ],
    });

    const claim = await getClaimDetail("claim_detail_1");
    expect(claim).not.toBeNull();
    expect(claim?.id).toBe("claim_detail_1");
    expect(claim?.canonicalSourceUrl).toBe("");
    expect(claim?.evidenceUrl).toBe("https://example.com/safe-evidence");
    expect(claim?.outcomeEvidence).toBe("https://example.com/from-evidence-text");
  });
});

describe("researcher prediction counts from durable rows", () => {
  it("counts predictions via claim_id in the same public 90-day window", async () => {
    await getResearchers();
    const sql = normalize(String(mockQuery.mock.calls[0][0]));
    expect(sql).toMatch(/p\.claim_id\s*=\s*e2\.id/i);
    expect(sql).not.toMatch(/s\.identifier\s*=\s*p\.author/i);
    expect(sql).toMatch(/make_interval\s*\(\s*days\s*=>\s*\$1\s*\)/i);
    expect(mockQuery.mock.calls[0][1]).toEqual([90]);
  });

  it("lists researcher predictions through the claim_id join, not predictions.author", async () => {
    await getResearcherPredictions("darioamodei", 90);
    const sql = normalize(String(mockQuery.mock.calls[0][0]));
    expect(sql).toMatch(/p\.claim_id\s*=\s*e\.id/i);
    expect(sql).toMatch(/s\.identifier\s*=\s*\$1/i);
    expect(sql).toMatch(/make_interval\s*\(\s*days\s*=>\s*\$2\s*\)/i);
    expect(mockQuery.mock.calls[0][1]).toEqual(["darioamodei", 90]);
    expect(sql).not.toMatch(/WHERE\s+author\s*=/i);
  });
});

describe("quote coverage in system status", () => {
  it("reports quote_backed numerator/denominator independently of URL fallback", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = normalize(sql);
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
      if (/FROM\s+extracted_claims/i.test(s) && /url_backed/i.test(s)) {
        return {
          rows: [
            {
              total: "4",
              last_24h: "1",
              url_backed: "4",
              quote_backed: "2",
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
    expect(status.claims.url_backed).toBe(4);
    expect(status.claims.quote_backed).toBe(2);
    expect(status.claims.quote_backed_pct).toBe(50);

    const claimsSql = allSql().find(
      (sql) => /extracted_claims/i.test(sql) && /quote_backed/i.test(sql),
    );
    expect(claimsSql).toBeDefined();
    expect(normalize(claimsSql!)).toMatch(
      /NULLIF\s*\(\s*(?:btrim\s*\(\s*)?e\.original_quote/i,
    );
  });
});

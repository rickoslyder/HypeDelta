/**
 * Lab|critic|other product surfaces + canonical researcher identity.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  claimsFilterHref,
  researcherHref,
  researcherPathSegment,
} from "./claim-href";
import { publicAuthorLabel } from "../../../../src/researcher-identity";
import { authorSideSqlCase, authorSideSqlPredicate } from "../../../../src/author-side";
import { ClaimDetailBody } from "../components/claim-detail-body";
import { mapLiveEvidenceRow } from "./live-evidence-ledger";

const mockQuery = vi.fn();

vi.mock("pg", () => {
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

const {
  getClaims,
  getClaimFacets,
  getResearchers,
  getTopicStats,
} = await import("./db");

const webSrc = path.resolve(__dirname, "..");
function read(rel: string): string {
  return readFileSync(path.join(webSrc, rel), "utf8");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://localhost/test";
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("researcher href encoding", () => {
  it("encodes canonical slugs and refuses to build a single-segment href from a raw URL", () => {
    expect(researcherHref("simon-willison")).toBe("/researchers/simon-willison");
    expect(researcherHref("Francois Chollet")).toBe("/researchers/Francois%20Chollet");
    expect(researcherPathSegment("https://simonwillison.net/atom/everything/")).toBeNull();
    expect(researcherHref("https://simonwillison.net/atom/everything/")).toBe("/researchers");
    expect(researcherHref("http://example.com/feed")).toBe("/researchers");
  });
});

describe("claims facet param preservation", () => {
  it("preserves q and other params when toggling topic/type/days", () => {
    const current = { q: "scaling laws", topic: "agents", type: "prediction", days: "90" };
    expect(claimsFilterHref(current, { topic: "safety" })).toBe(
      "/claims?q=scaling+laws&topic=safety&type=prediction&days=90",
    );
    expect(claimsFilterHref(current, { type: "opinion" })).toContain("q=scaling+laws");
    expect(claimsFilterHref(current, { type: "opinion" })).toContain("topic=agents");
    expect(claimsFilterHref(current, { days: "14" })).toContain("q=scaling+laws");
    expect(claimsFilterHref(current, { topic: null })).not.toContain("topic=");
    expect(claimsFilterHref(current, { topic: "safety" })).not.toContain("page=");
  });
});

describe("topic stats SQL", () => {
  it("exposes lab_count, critic_count, other_count from the shared CASE", async () => {
    await getTopicStats(30);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("as other_count");
    expect(sql).toContain(authorSideSqlPredicate("author_category", "lab"));
    expect(sql).toContain(authorSideSqlPredicate("author_category", "critic"));
    expect(sql).toContain(authorSideSqlPredicate("author_category", "other"));
    expect(sql).not.toMatch(/author_category IN \('anthropic'/);
    expect(sql).toContain(authorSideSqlCase("author_category").slice(0, 20));
  });
});

describe("canonical researcher directory SQL", () => {
  it("never returns URL feed identifiers as directory handles or names", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          handle: "https://simonwillison.net/atom/everything/",
          name: "https://simonwillison.net/atom/everything/",
          lab_count: "0",
          critic_count: "0",
          other_count: "2",
          claim_count: "2",
          avg_bullishness: "0.4",
          prediction_count: "0",
          source_identifiers: ["https://simonwillison.net/atom/everything/"],
          source_categories: ["independent"],
        },
        {
          handle: "francois-chollet",
          name: "Francois Chollet",
          lab_count: "3",
          critic_count: "0",
          other_count: "0",
          claim_count: "3",
          avg_bullishness: "0.7",
          prediction_count: "1",
          source_identifiers: ["fchollet"],
          source_categories: ["critics"],
        },
      ],
    });
    const rows = await getResearchers();
    expect(rows.every((row) => !/^https?:/i.test(row.handle))).toBe(true);
    expect(rows.every((row) => !/^https?:/i.test(row.name))).toBe(true);
    expect(rows.every((row) => row.name.trim().length > 0)).toBe(true);
    const chollet = rows.find((row) => row.handle === "francois-chollet");
    expect(chollet?.side).toBe("lab");
  });

  it("aggregates by researcher slug and claim sides, not sources.category", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          handle: "francois-chollet",
          name: "Francois Chollet",
          lab_count: "3",
          critic_count: "0",
          other_count: "0",
          claim_count: "3",
          avg_bullishness: "0.7",
          prediction_count: "1",
          source_identifiers: ["fchollet"],
          source_categories: ["critics"],
        },
      ],
    });
    const rows = await getResearchers();
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/FROM\s+researchers/i);
    expect(sql).toMatch(/source_researchers/i);
    expect(sql).not.toMatch(/s\.category as category/i);
    expect(sql).toMatch(/author_category/i);
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe("francois-chollet");
    expect(rows[0].name).toBe("Francois Chollet");
    expect(rows[0].side).toBe("lab");
    expect(rows[0].name).not.toMatch(/^https?:/i);
    expect(rows[0].handle).not.toMatch(/^https?:/i);
  });
});

describe("getClaims canonical identity", () => {
  it("projects researcher slug for links and keeps source identifier as provenance", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "1" }] };
      return {
        rows: [
          {
            id: "c1",
            author_handle: "https://simonwillison.net/atom/everything/",
            researcher_slug: "simon-willison",
            researcher_display_name: "Simon Willison",
            source_identifier: "https://simonwillison.net/atom/everything/",
            author_category: "independent",
          },
        ],
      };
    });
    const result = await getClaims({ author: "simon-willison", days: 90, limit: 20 });
    const selectSql = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .find((s) => /SELECT/i.test(s) && /extracted_claims/i.test(s) && /source_url/i.test(s));
    expect(selectSql).toMatch(/researcher_slug|r\.slug/i);
    expect(selectSql).toMatch(/s\.identifier\s+as\s+source_identifier/i);
    expect(result.claims[0].researcher_slug).toBe("simon-willison");
    const filterSql = mockQuery.mock.calls.map((c) => String(c[0])).join("\n");
    expect(filterSql).toMatch(/r\.slug\s*=/i);
  });

  it("aggregates claims across mapped sources for one slug without duplicating ids", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "2" }] };
      return {
        rows: [
          {
            id: "claim_sw_twitter",
            researcher_slug: "simon-willison",
            source_identifier: "simonw",
          },
          {
            id: "claim_sw_blog",
            researcher_slug: "simon-willison",
            source_identifier: "https://simonwillison.net/atom/everything/",
          },
        ],
      };
    });
    const result = await getClaims({ author: "simon-willison", days: 90, limit: 50 });
    expect(result.total).toBe(2);
    expect(result.claims.map((c) => c.id).sort()).toEqual(["claim_sw_blog", "claim_sw_twitter"]);
    expect(new Set(result.claims.map((c) => c.id)).size).toBe(result.claims.length);
    const sql = mockQuery.mock.calls.map((c) => String(c[0])).join("\n");
    expect(sql).toMatch(/r\.slug\s*=/i);
    expect(sql).toMatch(/source_researchers/i);
  });
});

describe("claim facets over the window", () => {
  it("queries distinct topic/type over the date/search window, not the page", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/DISTINCT/i.test(sql) && /topic/i.test(sql)) {
        return { rows: [{ topic: "robotics" }, { topic: "scaling" }] };
      }
      if (/DISTINCT/i.test(sql) && /claim_type/i.test(sql)) {
        return { rows: [{ claim_type: "hint" }, { claim_type: "prediction" }] };
      }
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "40" }] };
      return {
        rows: Array.from({ length: 20 }, (_, i) => ({
          id: `page1_${i}`,
          topic: "scaling",
          claim_type: "prediction",
        })),
      };
    });

    const facets = await getClaimFacets({ search: "laws", days: 90 });
    expect(facets.topics).toEqual(expect.arrayContaining(["robotics", "scaling"]));
    expect(facets.types).toEqual(expect.arrayContaining(["hint", "prediction"]));
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /DISTINCT/i.test(s) && /topic/i.test(s))).toBe(true);
    expect(sqls.every((s) => !/LIMIT\s+20/i.test(s) || !/DISTINCT/i.test(s))).toBe(true);
  });
});

describe("public rendering contracts", () => {
  const pages = [
    "app/claims/page.tsx",
    "app/researchers/page.tsx",
    "app/researchers/[handle]/page.tsx",
    "app/topics/[topic]/page.tsx",
    "components/claim-detail-body.tsx",
  ];

  it("does not render @https handles or build researcher hrefs from raw URLs", () => {
    for (const rel of pages) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/@\$\{claim\.author_handle\}/);
      expect(text, rel).not.toMatch(/href=\{`\/researchers\/\$\{claim\.author_handle\}`\}/);
      expect(text, rel).not.toMatch(/href=\{`\/researchers\/\$\{researcher\.handle\}`\}/);
      expect(text, rel).not.toMatch(/href=\{`\/researchers\/\$\{decodedHandle\}`\}/);
    }
  });

  it("uses the shared author-side helper for topic grouping and researcher badges", () => {
    expect(read("app/topics/[topic]/page.tsx")).toMatch(/groupByAuthorSide/);
    expect(read("app/researchers/page.tsx")).toMatch(/side === ["']lab["']/);
    expect(read("app/researchers/page.tsx")).not.toMatch(/LAB_CATEGORIES/);
    expect(read("app/claims/page.tsx")).toMatch(/getClaimFacets/);
    expect(read("app/claims/page.tsx")).toMatch(/claimsFilterHref/);
    expect(read("app/topics/[topic]/page.tsx")).toMatch(/other_count|Other/);
  });

  it("aligns topic detail with RESEARCHER_PUBLIC_WINDOW_DAYS", () => {
    const topicPage = read("app/topics/[topic]/page.tsx");
    expect(topicPage).toMatch(/RESEARCHER_PUBLIC_WINDOW_DAYS/);
    expect(topicPage).not.toMatch(/getTopicStats\(\s*30\s*\)/);
    expect(topicPage).not.toMatch(/days:\s*30/);
  });

  it("resolves inbound source identifiers to the canonical slug and lists source provenance", () => {
    const detail = read("app/researchers/[handle]/page.tsx");
    expect(detail).toMatch(/redirect\(/);
    expect(detail).toMatch(/researcherHref\(researcher\.handle\)/);
    expect(detail).toMatch(/source_identifiers/);
    expect(detail).not.toMatch(/@\$\{decodedHandle\}/);
    expect(detail).not.toMatch(/<h1[^>]*>@/);
  });

  it("renders a canonical slug link and human name for a URL feed author", () => {
    const claim = mapLiveEvidenceRow({
      id: "claim_url_author",
      claim_text: "Prompt injection remains unsolved.",
      claim_type: "opinion",
      topic: "safety",
      stance: "bearish",
      author_handle: "simon-willison",
      author_name: "Simon Willison",
      researcher_slug: "simon-willison",
      canonical_source_url: "https://simonwillison.net/2026/aug/prompt-injection",
      original_quote: "Prompt injection remains unsolved.",
      extracted_at: "2026-08-10T00:00:00.000Z",
      published_at: "2026-08-09T00:00:00.000Z",
      prediction_status: null,
      prediction_due_at: null,
      prediction_outcome_summary: null,
      prediction_evidence: null,
      prediction_evidence_url: null,
      prediction_next_observable: null,
      prediction_next_question: null,
      prediction_verified_at: null,
    });
    const html = renderToStaticMarkup(createElement(ClaimDetailBody, { claim }));
    expect(html).toContain("/researchers/simon-willison");
    expect(html).toContain("Simon Willison");
    expect(html).not.toMatch(/@https?:/i);
    expect(publicAuthorLabel({
      displayName: "Simon Willison",
      identifier: "https://simonwillison.net/atom/everything/",
    }).handle).toBeNull();
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PersistedPredictionRow } from "../components/persisted-prediction-row";
import {
  TARGET_DATE_NOT_NORMALIZED,
  mapPersistedPredictionRow,
  summarizePersistedPredictionCandidates,
  type PersistedPredictionRowInput,
  type PersistedPredictionSummaryCandidate,
} from "./persisted-predictions";

function row(overrides: Partial<PersistedPredictionRowInput> = {}): PersistedPredictionRowInput {
  return {
    id: "pred_1",
    prediction_text: "Open-weight models will match closed models on reasoning.",
    status: "pending",
    confidence: 0.7,
    timeframe: "medium-term",
    topic: "reasoning",
    made_at: "2026-08-01T00:00:00.000Z",
    due_at: null,
    verified_at: null,
    outcome_summary: null,
    evidence: null,
    evidence_url: null,
    next_observable: null,
    next_question: null,
    claim_id: "claim_1",
    claim_text: "Open-weight models will match closed models on reasoning.",
    claim_type: "prediction",
    canonical_source_url: "https://example.com/lecun-reasoning",
    original_quote: "Open-weight models will match closed models on reasoning.",
    researcher_slug: "ylecun",
    researcher_display_name: "Yann LeCun",
    source_identifier: "ylecun",
    ...overrides,
  };
}

describe("mapPersistedPredictionRow", () => {
  it("keeps durable fields and provenance identity from the join, not predictions.author", () => {
    const mapped = mapPersistedPredictionRow(
      row({
        researcher_slug: "ylecun",
        researcher_display_name: "Yann LeCun",
        source_identifier: "https://example.com/feed",
      }),
    );

    expect(mapped.id).toBe("pred_1");
    expect(mapped.claimId).toBe("claim_1");
    expect(mapped.claimText).toBe("Open-weight models will match closed models on reasoning.");
    expect(mapped.claimType).toBe("prediction");
    expect(mapped.timeframe).toBe("medium-term");
    expect(mapped.canonicalSourceUrl).toBe("https://example.com/lecun-reasoning");
    expect(mapped.originalQuote).toBe("Open-weight models will match closed models on reasoning.");
    expect(mapped.researcherSlug).toBe("ylecun");
    expect(mapped.researcherDisplayName).toBe("Yann LeCun");
    expect(mapped.sourceLabel).toBe("Yann LeCun");
    expect(mapped.dueAt).toBeNull();
    expect(mapped.outcome).toBeNull();
    expect(mapped.nextObservable).toBeNull();
    expect(mapped.targetDateLabel).toBe(TARGET_DATE_NOT_NORMALIZED);
  });

  it("falls back to a safe public source identifier when no researcher slug exists", () => {
    const mapped = mapPersistedPredictionRow(
      row({
        researcher_slug: null,
        researcher_display_name: null,
        source_identifier: "karpathy",
      }),
    );
    expect(mapped.researcherSlug).toBeNull();
    expect(mapped.sourceLabel).toBe("karpathy");
  });

  it("does not treat an HTTP source identifier as a researcher slug", () => {
    const mapped = mapPersistedPredictionRow(
      row({
        researcher_slug: "https://simonwillison.net/atom/everything/",
        researcher_display_name: null,
        source_identifier: "https://simonwillison.net/atom/everything/",
      }),
    );
    expect(mapped.researcherSlug).toBeNull();
    expect(mapped.sourceLabel).toBe("Unknown researcher");
  });

  it("does not turn unsafe javascript: or data: source URLs into links", () => {
    for (const canonical_source_url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x"]) {
      const mapped = mapPersistedPredictionRow(row({ canonical_source_url }));
      expect(mapped.canonicalSourceUrl, canonical_source_url).toBeNull();
    }
  });

  it("does not synthesize due date, outcome, or next observable from timeframe", () => {
    const mapped = mapPersistedPredictionRow(
      row({
        timeframe: "near-term",
        due_at: null,
        outcome_summary: null,
        next_observable: null,
        verified_at: null,
      }),
    );
    expect(mapped.dueAt).toBeNull();
    expect(mapped.outcome).toBeNull();
    expect(mapped.nextObservable).toBeNull();
    expect(mapped.verifiedAt).toBeNull();
    expect(mapped.targetDateLabel).toBe(TARGET_DATE_NOT_NORMALIZED);
    expect(mapped.timeframe).toBe("near-term");
  });
});

describe("PersistedPredictionRow rendering", () => {
  it("shows the exact null due_at phrase and durable timeframe separately", () => {
    const html = renderToStaticMarkup(
      createElement(PersistedPredictionRow, { item: mapPersistedPredictionRow(row()) }),
    );
    expect(html).toContain(TARGET_DATE_NOT_NORMALIZED);
    expect(html).toContain("medium-term");
    expect(html).not.toMatch(/2026-1[12]|Q4|December 2026/i);
  });

  it("does not link an unsafe source URL", () => {
    const html = renderToStaticMarkup(
      createElement(PersistedPredictionRow, {
        item: mapPersistedPredictionRow(row({ canonical_source_url: "javascript:alert(1)" })),
      }),
    );
    expect(html).not.toMatch(/href=["']javascript:/i);
    expect(html).not.toContain("javascript:alert(1)");
  });

  it("links claim detail, researcher slug, and safe sources with noopener noreferrer", () => {
    const html = renderToStaticMarkup(
      createElement(PersistedPredictionRow, { item: mapPersistedPredictionRow(row()) }),
    );
    expect(html).toContain("/claims/claim_1");
    expect(html).toContain("/researchers/ylecun");
    expect(html).toMatch(/href="https:\/\/example.com\/lecun-reasoning"/);
    expect(html).toMatch(/target="_blank"/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  it("does not invent outcome or next observable copy when those fields are null", () => {
    const html = renderToStaticMarkup(
      createElement(PersistedPredictionRow, { item: mapPersistedPredictionRow(row()) }),
    );
    expect(html.toLowerCase()).not.toContain("will happen by");
    expect(html.toLowerCase()).not.toContain("inferred");
    expect(html).not.toMatch(/next observable(?![^<]*not recorded)/i);
  });
});

function candidate(
  overrides: Partial<PersistedPredictionSummaryCandidate> = {},
): PersistedPredictionSummaryCandidate {
  return {
    status: "pending",
    due_at: null,
    canonical_source_url: "https://example.com/lecun-reasoning",
    original_quote: "Open-weight models will match closed models on reasoning.",
    ...overrides,
  };
}

describe("summarizePersistedPredictionCandidates", () => {
  it("counts source+quote only when the URL passes safeAbsoluteHttpUrl and the quote is nonblank", () => {
    const summary = summarizePersistedPredictionCandidates([
      candidate(),
      candidate({ canonical_source_url: "  https://example.com/safe  " }),
    ]);
    expect(summary.tracked).toBe(2);
    expect(summary.withSourceAndQuote).toBe(2);
    expect(summary.open).toBe(2);
    expect(summary.resolved).toBe(0);
    expect(summary.withTargetDate).toBe(0);
  });

  it("does not treat malformed, credential-bearing, whitespace, javascript, or data URLs as admitted evidence", () => {
    const rejected = [
      "https://",
      "https://user:pass@example.com/secret",
      "https://example.com/foo bar",
      "https://example.com/foo\nbar",
      "https://example.com/foo\u0000bar",
      "javascript:alert(1)",
      "data:text/html,hi",
    ];
    const summary = summarizePersistedPredictionCandidates(
      rejected.map((canonical_source_url) => candidate({ canonical_source_url })),
    );
    expect(summary.tracked).toBe(rejected.length);
    expect(summary.withSourceAndQuote).toBe(0);
  });

  it("does not count a safe URL with a blank quote as source+quote", () => {
    const summary = summarizePersistedPredictionCandidates([
      candidate({ original_quote: "   " }),
      candidate({ original_quote: null }),
    ]);
    expect(summary.tracked).toBe(2);
    expect(summary.withSourceAndQuote).toBe(0);
  });

  it("treats pending with NULL due as open, not dated, and not resolved", () => {
    const summary = summarizePersistedPredictionCandidates([
      candidate({ status: "pending", due_at: null }),
    ]);
    expect(summary.open).toBe(1);
    expect(summary.withTargetDate).toBe(0);
    expect(summary.resolved).toBe(0);
  });

  it("does not count overdue status as open or resolved, and counts a stored due date", () => {
    const summary = summarizePersistedPredictionCandidates([
      candidate({ status: "overdue", due_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(summary.tracked).toBe(1);
    expect(summary.open).toBe(0);
    expect(summary.resolved).toBe(0);
    expect(summary.withTargetDate).toBe(1);
    expect(summary.withSourceAndQuote).toBe(1);
  });

  it("counts verified, falsified, and partially-verified as resolved", () => {
    const summary = summarizePersistedPredictionCandidates([
      candidate({ status: "verified", due_at: "2026-08-01T00:00:00.000Z" }),
      candidate({ status: "falsified", due_at: null }),
      candidate({ status: "partially-verified", due_at: "2026-08-02T00:00:00.000Z" }),
    ]);
    expect(summary.tracked).toBe(3);
    expect(summary.open).toBe(0);
    expect(summary.resolved).toBe(3);
    expect(summary.withTargetDate).toBe(2);
  });
});

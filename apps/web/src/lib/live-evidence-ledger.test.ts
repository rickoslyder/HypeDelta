import { describe, expect, it } from "vitest";

import {
  calculateLiveLedgerCoverage,
  isAdmittedLiveEvidenceRow,
  mapLiveEvidenceRow,
  mapLiveLedgerSummary,
  normalizeLedgerCount,
  summarizeLiveLedgerCandidates,
  type LiveEvidenceRow,
  type LiveLedgerSummaryCandidate,
} from "./live-evidence-ledger";
import { agentReliabilityCoverage } from "./agent-reliability";

const NOW = new Date("2026-08-28T12:00:00.000Z");

function row(overrides: Partial<LiveEvidenceRow> = {}): LiveEvidenceRow {
  return {
    id: "claim_live_1",
    claim_text: "Agents will ship reliable long-horizon computer use this year.",
    claim_type: "prediction",
    topic: "agents",
    stance: "bullish",
    author_handle: "darioamodei",
    author_name: "Dario Amodei",
    canonical_source_url: "https://www.anthropic.com/news/agents",
    original_quote: "We will ship reliable computer use this year.",
    extracted_at: "2026-08-01T00:00:00.000Z",
    published_at: "2026-07-31T00:00:00.000Z",
    prediction_status: "pending",
    prediction_due_at: "2026-12-31T00:00:00.000Z",
    prediction_outcome_summary: null,
    prediction_evidence: null,
    prediction_evidence_url: null,
    prediction_next_observable: "A public reliability eval with a named failure rate.",
    prediction_next_question: "Did the eval land before year-end?",
    prediction_verified_at: null,
    ...overrides,
  };
}

describe("mapLiveEvidenceRow", () => {
  it("maps card.id from extracted_claims.id and keeps quote/source verbatim", () => {
    const card = mapLiveEvidenceRow(row(), NOW);
    expect(card.id).toBe("claim_live_1");
    expect(card.claimText).toBe(
      "Agents will ship reliable long-horizon computer use this year.",
    );
    expect(card.canonicalSourceUrl).toBe(
      "https://www.anthropic.com/news/agents",
    );
    expect(card.originalQuote).toBe(
      "We will ship reliable computer use this year.",
    );
    expect(card.authorHandle).toBe("darioamodei");
    expect(card.claimType).toBe("prediction");
    expect(card.topic).toBe("agents");
  });

  it("maps pending past-due predictions to overdue without inventing evidence", () => {
    const card = mapLiveEvidenceRow(
      row({
        prediction_status: "pending",
        prediction_due_at: "2026-01-01T00:00:00.000Z",
        prediction_outcome_summary: null,
        prediction_evidence: null,
        prediction_next_observable: null,
        prediction_next_question: null,
      }),
      NOW,
    );

    expect(card.presentationStatus).toBe("overdue");
    expect(card.outcomeEvidence).toBeNull();
    expect(card.targetDate).toBe("2026-01-01T00:00:00.000Z");
    expect(card.nextObservable).toBeNull();
    expect(card.nextQuestion).toBeNull();
  });

  it("maps a future pending target date to pending and retains stored next-observable", () => {
    const card = mapLiveEvidenceRow(
      row({
        prediction_status: "pending",
        prediction_due_at: "2026-12-31T00:00:00.000Z",
        prediction_next_observable: "Named eval receipt.",
        prediction_next_question: "Did it ship?",
      }),
      NOW,
    );

    expect(card.presentationStatus).toBe("pending");
    expect(card.nextObservable).toBe("Named eval receipt.");
    expect(card.nextQuestion).toBe("Did it ship?");
    expect(card.outcomeEvidence).toBeNull();
  });

  it("retains resolved prediction status and maps evidence_url separately from evidence text", () => {
    const card = mapLiveEvidenceRow(
      row({
        prediction_status: "falsified",
        prediction_due_at: "2026-01-01T00:00:00.000Z",
        prediction_outcome_summary: "The eval never shipped.",
        prediction_evidence: "legacy freeform evidence notes",
        prediction_evidence_url: "https://example.com/outcome",
      }),
      NOW,
    );

    expect(card.presentationStatus).toBe("falsified");
    expect(card.outcomeEvidence).toBe("The eval never shipped.");
    expect(card.evidenceUrl).toBe("https://example.com/outcome");
  });

  it("prefers outcome_summary then legacy evidence text, and never treats evidence text as evidenceUrl", () => {
    const withSummary = mapLiveEvidenceRow(
      row({
        prediction_status: "verified",
        prediction_outcome_summary: "  Named eval landed.  ",
        prediction_evidence: "https://example.com/should-not-become-href",
        prediction_evidence_url: null,
      }),
      NOW,
    );
    expect(withSummary.outcomeEvidence).toBe("Named eval landed.");
    expect(withSummary.evidenceUrl).toBeNull();

    const legacyOnly = mapLiveEvidenceRow(
      row({
        prediction_status: "verified",
        prediction_outcome_summary: "   ",
        prediction_evidence: "The public eval missed the date.",
        prediction_evidence_url: "javascript:alert(1)",
      }),
      NOW,
    );
    expect(legacyOnly.outcomeEvidence).toBe("The public eval missed the date.");
    expect(legacyOnly.evidenceUrl).toBeNull();
  });

  it("rejects unsafe canonical source URLs from admission and never copies them onto the card", () => {
    const unsafe = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/relative/path",
      "example.com/no-scheme",
      "https://",
      "https://user:pass@example.com/secret",
      "https://example.com/foo bar",
      "https://example.com/foo\nbar",
      "https://example.com/foo\u0000bar",
    ];

    for (const canonical_source_url of unsafe) {
      const unsafeRow = row({ canonical_source_url });
      expect(isAdmittedLiveEvidenceRow(unsafeRow), canonical_source_url).toBe(false);
      const card = mapLiveEvidenceRow(unsafeRow, NOW);
      expect(card.canonicalSourceUrl, canonical_source_url).toBe("");
    }
  });

  it("preserves legitimate http/https source URLs without rewriting hosts", () => {
    const httpsUrl = "https://www.anthropic.com/news/agents";
    expect(isAdmittedLiveEvidenceRow(row({ canonical_source_url: `  ${httpsUrl}  ` }))).toBe(
      true,
    );
    expect(mapLiveEvidenceRow(row({ canonical_source_url: `  ${httpsUrl}  ` }), NOW).canonicalSourceUrl).toBe(
      httpsUrl,
    );

    const mixedCase = "http://EXAMPLE.com/Path?Q=1#Hash";
    expect(isAdmittedLiveEvidenceRow(row({ canonical_source_url: mixedCase }))).toBe(true);
    expect(mapLiveEvidenceRow(row({ canonical_source_url: mixedCase }), NOW).canonicalSourceUrl).toBe(
      mixedCase,
    );
  });

  it("keeps too-early open (not resolved, not overdue) and counts it with pending/open coverage", () => {
    const card = mapLiveEvidenceRow(
      row({
        prediction_status: "too-early",
        prediction_due_at: "2026-01-01T00:00:00.000Z",
      }),
      NOW,
    );

    expect(card.presentationStatus).toBe("too-early");
    const coverage = calculateLiveLedgerCoverage([card]);
    expect(coverage.resolvedCount).toBe(0);
    expect(coverage.overdueCount).toBe(0);
    expect(coverage.pendingCount + coverage.tooEarlyCount).toBe(1);
    expect(coverage.tooEarlyCount).toBe(1);
  });

  it("still maps explicit pending past-due predictions to overdue", () => {
    const card = mapLiveEvidenceRow(
      row({
        prediction_status: "pending",
        prediction_due_at: "2026-01-01T00:00:00.000Z",
      }),
      NOW,
    );
    expect(card.presentationStatus).toBe("overdue");
    expect(calculateLiveLedgerCoverage([card]).overdueCount).toBe(1);
    expect(calculateLiveLedgerCoverage([card]).resolvedCount).toBe(0);
  });

  it("maps invalid or unparseable dates to null instead of echoing the untrusted string", () => {
    const card = mapLiveEvidenceRow(
      row({
        extracted_at: "not-a-date",
        published_at: "32/13/2026",
        prediction_due_at: "tomorrow",
        prediction_verified_at: "@@@",
      }),
      NOW,
    );

    expect(card.extractedAt).toBeNull();
    expect(card.publishedAt).toBeNull();
    expect(card.targetDate).toBeNull();
    expect(card.verifiedAt).toBeNull();
  });

  it("renders non-prediction claims as evidence-only with no invented outcome or next observable", () => {
    const card = mapLiveEvidenceRow(
      row({
        claim_type: "fact",
        prediction_status: null,
        prediction_due_at: null,
        prediction_outcome_summary: null,
        prediction_evidence: null,
        prediction_next_observable: null,
        prediction_next_question: null,
      }),
      NOW,
    );

    expect(card.presentationStatus).toBe("evidence-only");
    expect(card.outcomeEvidence).toBeNull();
    expect(card.targetDate).toBeNull();
    expect(card.nextObservable).toBeNull();
    expect(card.nextQuestion).toBeNull();
  });
});

describe("calculateLiveLedgerCoverage", () => {
  it("calculates coverage from the supplied live cards, not the bundled three-card JSON", () => {
    const coverage = calculateLiveLedgerCoverage([
      mapLiveEvidenceRow(row({ id: "claim_a" }), NOW),
      mapLiveEvidenceRow(
        row({
          id: "claim_b",
          claim_type: "fact",
          prediction_status: null,
          prediction_due_at: null,
          prediction_next_observable: null,
          prediction_next_question: null,
        }),
        NOW,
      ),
    ]);

    expect(coverage.admittedCount).toBe(2);
    expect(coverage.quoteBackedCount).toBe(2);
    expect(coverage.sourceBackedCount).toBe(2);
    expect(coverage.pendingCount).toBe(1);
    expect(coverage.evidenceOnlyCount).toBe(1);
    expect(coverage.admittedCount).not.toBe(agentReliabilityCoverage.totalClaims);
    expect(coverage).not.toEqual(agentReliabilityCoverage);
  });

  it("reports zero coverage for an empty live slice", () => {
    expect(calculateLiveLedgerCoverage([])).toEqual({
      admittedCount: 0,
      quoteBackedCount: 0,
      sourceBackedCount: 0,
      pendingCount: 0,
      overdueCount: 0,
      tooEarlyCount: 0,
      resolvedCount: 0,
      evidenceOnlyCount: 0,
    });
  });
});

describe("pending predictions with NULL due_at", () => {
  it("treats pending + NULL due_at as open, not overdue, and does not invent a target date", () => {
    const card = mapLiveEvidenceRow(
      row({
        prediction_status: "pending",
        prediction_due_at: null,
      }),
      NOW,
    );

    expect(card.presentationStatus).toBe("pending");
    expect(card.targetDate).toBeNull();
    const coverage = calculateLiveLedgerCoverage([card]);
    expect(coverage.overdueCount).toBe(0);
    expect(coverage.pendingCount).toBe(1);
    expect(coverage.resolvedCount).toBe(0);
  });

  it("treats too-early + NULL due_at as open, not overdue", () => {
    const card = mapLiveEvidenceRow(
      row({
        prediction_status: "too-early",
        prediction_due_at: null,
      }),
      NOW,
    );

    expect(card.presentationStatus).toBe("too-early");
    expect(card.targetDate).toBeNull();
    const coverage = calculateLiveLedgerCoverage([card]);
    expect(coverage.overdueCount).toBe(0);
    expect(coverage.tooEarlyCount).toBe(1);
    expect(coverage.resolvedCount).toBe(0);
  });

  it("requires a non-null due_at before now before calling a prediction overdue", () => {
    const durableOverdueNoDate = mapLiveEvidenceRow(
      row({
        prediction_status: "overdue",
        prediction_due_at: null,
      }),
      NOW,
    );
    expect(durableOverdueNoDate.presentationStatus).toBe("pending");
    expect(calculateLiveLedgerCoverage([durableOverdueNoDate]).overdueCount).toBe(0);

    const pendingPastDue = mapLiveEvidenceRow(
      row({
        prediction_status: "pending",
        prediction_due_at: "2026-01-01T00:00:00.000Z",
      }),
      NOW,
    );
    expect(pendingPastDue.presentationStatus).toBe("overdue");
    expect(calculateLiveLedgerCoverage([pendingPastDue]).overdueCount).toBe(1);
  });
});

describe("normalizeLedgerCount / mapLiveLedgerSummary", () => {
  it("normalizes numeric pg strings and rejects non-numeric values", () => {
    expect(normalizeLedgerCount("36")).toBe(36);
    expect(normalizeLedgerCount("238")).toBe(238);
    expect(normalizeLedgerCount(12)).toBe(12);
    expect(normalizeLedgerCount("12.9")).toBe(12);
    expect(normalizeLedgerCount("0")).toBe(0);
    expect(normalizeLedgerCount("")).toBe(0);
    expect(normalizeLedgerCount(null)).toBe(0);
    expect(normalizeLedgerCount(undefined)).toBe(0);
    expect(normalizeLedgerCount("nope")).toBe(0);
    expect(normalizeLedgerCount(-4)).toBe(0);
  });

  it("maps a whole-corpus summary row onto the admitted-ledger fields", () => {
    expect(
      mapLiveLedgerSummary({
        admitted: "40",
        quote_backed: "36",
        admitted_prediction: "36",
        open_prediction: "34",
        overdue: "2",
        resolved: "2",
        evidence_only: "4",
      }),
    ).toEqual({
      admittedCount: 40,
      quoteBackedCount: 36,
      admittedPredictionCount: 36,
      openPredictionCount: 34,
      overdueCount: 2,
      resolvedCount: 2,
      evidenceOnlyCount: 4,
    });
  });
});

function summaryCandidate(
  overrides: Partial<LiveLedgerSummaryCandidate> = {},
): LiveLedgerSummaryCandidate {
  return {
    canonical_source_url: "https://www.anthropic.com/news/agents",
    original_quote: "We will ship reliable computer use this year.",
    claim_type: "prediction",
    prediction_status: "pending",
    prediction_due_at: "2026-12-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeLiveLedgerCandidates", () => {
  it("admits only safe https/http URLs with a nonblank quote", () => {
    const summary = summarizeLiveLedgerCandidates(
      [
        summaryCandidate(),
        summaryCandidate({ canonical_source_url: "  http://EXAMPLE.com/Path?Q=1#Hash  " }),
      ],
      NOW,
    );
    expect(summary.admittedCount).toBe(2);
    expect(summary.quoteBackedCount).toBe(2);
    expect(summary.admittedPredictionCount).toBe(2);
    expect(summary.openPredictionCount).toBe(2);
  });

  it("rejects malformed, credential-bearing, whitespace, javascript, and data URLs from admitted coverage", () => {
    const rejected = [
      "https://",
      "https://user:pass@example.com/secret",
      "https://example.com/foo bar",
      "https://example.com/foo\nbar",
      "https://example.com/foo\u0000bar",
      "javascript:alert(1)",
      "data:text/html,hi",
    ];
    const summary = summarizeLiveLedgerCandidates(
      rejected.map((canonical_source_url) => summaryCandidate({ canonical_source_url })),
      NOW,
    );
    expect(summary.admittedCount).toBe(0);
    expect(summary.quoteBackedCount).toBe(0);
    expect(summary.admittedPredictionCount).toBe(0);
  });

  it("rejects a blank quote even when the URL is safe", () => {
    const summary = summarizeLiveLedgerCandidates(
      [
        summaryCandidate({ original_quote: "   " }),
        summaryCandidate({ original_quote: null }),
      ],
      NOW,
    );
    expect(summary.admittedCount).toBe(0);
    expect(summary.quoteBackedCount).toBe(0);
  });

  it("treats pending + NULL due as open, not overdue", () => {
    const summary = summarizeLiveLedgerCandidates(
      [summaryCandidate({ prediction_status: "pending", prediction_due_at: null })],
      NOW,
    );
    expect(summary.admittedCount).toBe(1);
    expect(summary.admittedPredictionCount).toBe(1);
    expect(summary.openPredictionCount).toBe(1);
    expect(summary.overdueCount).toBe(0);
    expect(summary.resolvedCount).toBe(0);
    expect(summary.evidenceOnlyCount).toBe(0);
  });

  it("counts pending past-due predictions as overdue and still open", () => {
    const summary = summarizeLiveLedgerCandidates(
      [
        summaryCandidate({
          prediction_status: "pending",
          prediction_due_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(summary.overdueCount).toBe(1);
    expect(summary.openPredictionCount).toBe(1);
    expect(summary.resolvedCount).toBe(0);
  });

  it("counts resolved prediction statuses and evidence-only non-predictions", () => {
    const summary = summarizeLiveLedgerCandidates(
      [
        summaryCandidate({ prediction_status: "verified" }),
        summaryCandidate({ prediction_status: "falsified" }),
        summaryCandidate({
          claim_type: "fact",
          prediction_status: null,
          prediction_due_at: null,
        }),
      ],
      NOW,
    );
    expect(summary.admittedCount).toBe(3);
    expect(summary.admittedPredictionCount).toBe(2);
    expect(summary.resolvedCount).toBe(2);
    expect(summary.openPredictionCount).toBe(0);
    expect(summary.evidenceOnlyCount).toBe(1);
  });
});

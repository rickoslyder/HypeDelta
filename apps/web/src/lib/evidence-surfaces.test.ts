import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { claimDetailHref, claimsTopicHref, isValidClaimId, safeDecodeURIComponent } from "./claim-href";
import { mapLiveEvidenceRow } from "./live-evidence-ledger";
import { ClaimDetailBody } from "../components/claim-detail-body";

const webSrc = path.resolve(__dirname, "..");

function read(rel: string): string {
  return readFileSync(path.join(webSrc, rel), "utf8");
}

describe("claim href helpers", () => {
  it("encodes claim detail ids", () => {
    expect(claimDetailHref("claim_a/b")).toBe("/claims/claim_a%2Fb");
    expect(claimDetailHref("claim_plain")).toBe("/claims/claim_plain");
    expect(isValidClaimId("claim_plain")).toBe(true);
    expect(isValidClaimId("bad id / injection")).toBe(false);
  });

  it("decodes valid percent-encoded claim ids and returns null for malformed encoding without throwing", () => {
    expect(safeDecodeURIComponent("claim_plain")).toBe("claim_plain");
    expect(safeDecodeURIComponent("claim%5Fplain")).toBe("claim_plain");
    expect(() => safeDecodeURIComponent("%E0%A4%A")).not.toThrow();
    expect(safeDecodeURIComponent("%E0%A4%A")).toBeNull();
    expect(safeDecodeURIComponent("%")).toBeNull();
    expect(safeDecodeURIComponent("%ZZ")).toBeNull();
  });

  it("encodes topic filters and preserves a days window", () => {
    expect(claimsTopicHref("agent reliability", 14)).toBe(
      "/claims?topic=agent+reliability&days=14",
    );
    expect(claimsTopicHref("scaling")).toBe("/claims?topic=scaling");
  });
});

describe("claim detail fixture rendering", () => {
  it("renders the verbatim quote and canonical source for a fixture with both", () => {
    const claim = mapLiveEvidenceRow({
      id: "claim_detail_fixture",
      claim_text: "Open-weight models will match closed models on reasoning.",
      claim_type: "prediction",
      topic: "reasoning",
      stance: "bullish",
      author_handle: "ylecun",
      author_name: "Yann LeCun",
      canonical_source_url: "https://example.com/lecun-reasoning",
      original_quote: "Open-weight models will match closed models on reasoning.",
      extracted_at: "2026-08-10T00:00:00.000Z",
      published_at: "2026-08-09T00:00:00.000Z",
      prediction_status: "pending",
      prediction_due_at: "2026-12-31T00:00:00.000Z",
      prediction_outcome_summary: null,
      prediction_evidence: null,
      prediction_evidence_url: null,
      prediction_next_observable: "A public reasoning leaderboard snapshot.",
      prediction_next_question: "Did open-weight catch up?",
      prediction_verified_at: null,
    });

    const html = renderToStaticMarkup(createElement(ClaimDetailBody, { claim }));
    expect(html).toContain("Open-weight models will match closed models on reasoning.");
    expect(html).toContain("https://example.com/lecun-reasoning");
    expect(html).toContain("/researchers/ylecun");
    expect(html).toContain("reasoning");
    expect(html).toContain("prediction");
  });

  it("renders an unsafe source as unavailable, never as a clickable href", () => {
    const claim = mapLiveEvidenceRow({
      id: "claim_unsafe_source",
      claim_text: "A claim with an unsafe source.",
      claim_type: "fact",
      topic: "agents",
      stance: null,
      author_handle: "ylecun",
      author_name: "Yann LeCun",
      canonical_source_url: "javascript:alert(1)",
      original_quote: "Quoted without a safe source.",
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
    expect(html).not.toMatch(/href=["']javascript:/i);
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toMatch(/unavailable/i);
  });

  it("renders a safe outcome evidence URL with noopener noreferrer and never hrefs evidence text", () => {
    const withUrl = mapLiveEvidenceRow({
      id: "claim_evidence_url",
      claim_text: "The eval shipped.",
      claim_type: "prediction",
      topic: "agents",
      stance: "bullish",
      author_handle: "darioamodei",
      author_name: "Dario Amodei",
      canonical_source_url: "https://example.com/source",
      original_quote: "The eval shipped.",
      extracted_at: "2026-08-10T00:00:00.000Z",
      published_at: "2026-08-09T00:00:00.000Z",
      prediction_status: "verified",
      prediction_due_at: "2026-08-01T00:00:00.000Z",
      prediction_outcome_summary: "Receipt published.",
      prediction_evidence: "https://evil.example/looks-like-url",
      prediction_evidence_url: "https://example.com/receipt",
      prediction_next_observable: null,
      prediction_next_question: null,
      prediction_verified_at: "2026-08-02T00:00:00.000Z",
    });

    const html = renderToStaticMarkup(createElement(ClaimDetailBody, { claim: withUrl }));
    expect(html).toMatch(/href="https:\/\/example.com\/receipt"/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).not.toMatch(/href="https:\/\/evil\.example\/looks-like-url"/);
    expect(html).toContain("Receipt published.");
  });
});

describe("evidence surfaces", () => {
  it("uses the live ledger loader on /reliability and does not default to the seed JSON", () => {
    const page = read("app/reliability/page.tsx");
    expect(page).toMatch(/getLiveEvidenceLedger/);
    expect(page).not.toMatch(/calculateLiveLedgerCoverage/);
    expect(page).not.toMatch(/agentReliabilitySlice/);
    expect(page).not.toMatch(/agentReliabilityCoverage/);
    expect(page).not.toMatch(/agent-reliability-slice\.json/);
    expect(page).toMatch(/canonical source/i);
    expect(page).toMatch(/verbatim quote|original quote/i);
    expect(page).not.toMatch(/\bfetch\s*\(/);
    expect(page).toMatch(/card\.evidenceUrl/);
  });

  it("renders global corpus counts separately from selected rows and names the page an evidence ledger", () => {
    const page = read("app/reliability/page.tsx");
    expect(page).toMatch(/title:\s*["']Evidence ledger/);
    expect(page).not.toMatch(/title:\s*["']Agent reliability/);
    expect(page).toMatch(/Evidence ledger/);
    expect(page).toMatch(/claim reliability/i);
    expect(page).not.toMatch(/Agent reliability, claim by claim/);
    expect(page).toMatch(/summary\.(admittedCount|openPredictionCount|admittedPredictionCount)/);
    expect(page).toMatch(/global (admitted )?corpus|admitted corpus/i);
    expect(page).toMatch(/selected (rows|claims|cards)/i);
    expect(page).toMatch(/prediction-first|predictions first/i);
    expect(page).toMatch(/No admitted live claims/);
  });

  it("adds a claim detail route that 404s on missing ids and does not fetch", () => {
    const page = read("app/claims/[id]/page.tsx");
    expect(page).toMatch(/getClaimDetail/);
    expect(page).toMatch(/notFound\s*\(/);
    expect(page).toMatch(/ClaimDetailBody/);
    expect(page).not.toMatch(/\bfetch\s*\(/);
    expect(page).toMatch(/safeDecodeURIComponent/);
    expect(page).not.toMatch(/const decoded = decodeURIComponent\(id\)/);
  });

  it("links every claims-list row to the encoded detail route", () => {
    const page = read("app/claims/page.tsx");
    expect(page).toMatch(/claimDetailHref/);
    expect(page).toMatch(/claims\.map/);
  });

  it("links topic and researcher claim renderers to the same detail helper", () => {
    const topic = read("app/topics/[topic]/page.tsx");
    const researcher = read("app/researchers/[handle]/page.tsx");
    expect(topic).toMatch(/claimDetailHref/);
    expect(researcher).toMatch(/claimDetailHref/);
  });

  it("links homepage hype topics to encoded /claims?topic= and surfaces quote coverage from DB fields", () => {
    const home = read("app/page.tsx");
    expect(home).toMatch(/claimsTopicHref/);
    expect(home).toMatch(/quote_backed/);
    expect(home).toMatch(/status\.claims\.total/);
    expect(home).not.toMatch(/prediction accuracy/i);
  });

  it("does not introduce unsupported public prediction-accuracy copy", () => {
    const files = [
      "app/page.tsx",
      "app/reliability/page.tsx",
      "app/claims/page.tsx",
      "app/researchers/page.tsx",
      "app/researchers/[handle]/page.tsx",
    ];
    for (const rel of files) {
      const text = read(rel).toLowerCase();
      expect(text, rel).not.toMatch(/prediction accuracy/);
      expect(text, rel).not.toMatch(/accuracy over time/);
    }
  });

  it("omits researcher prediction counts of zero and uses durable prediction rows", () => {
    const list = read("app/researchers/page.tsx");
    const detail = read("app/researchers/[handle]/page.tsx");
    expect(list).toMatch(/predictionCount > 0/);
    expect(detail).toMatch(/getResearcherPredictions/);
    expect(detail).not.toMatch(/getPredictions\(\{\s*author:/);
  });
});

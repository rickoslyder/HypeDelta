import { describe, expect, it } from "vitest";

import rawSlice from "../data/agent-reliability-slice.json";
import {
  agentReliabilityCoverage,
  agentReliabilitySlice,
  calculateReliabilityCoverage,
  parseAgentReliabilitySlice,
} from "./agent-reliability";

type SliceDraft = {
  windowEnd: string;
  cards: Array<{
    id: string;
    evidenceQuality: string;
    source: {
      url?: string;
      sha256?: string;
      publishedAt: string;
    };
  }>;
};

function cloneSlice(): SliceDraft {
  return structuredClone(rawSlice) as SliceDraft;
}

describe("agent reliability slice", () => {
  it("parses the bounded seed slice and reports full source coverage", () => {
    expect(agentReliabilitySlice.cards).toHaveLength(3);
    expect(agentReliabilityCoverage).toEqual({
      totalClaims: 3,
      sourceBackedClaims: 3,
      sourceCoveragePercent: 100,
      observedOutcomes: 2,
      observedOutcomeCoveragePercent: 67,
      openFollowUps: 3,
    });
  });

  it("keeps every displayed claim tied to a primary source and follow-up", () => {
    for (const card of agentReliabilitySlice.cards) {
      expect(card.source.url || card.source.artifactRef).toBeTruthy();
      expect(card.followUp.question.length).toBeGreaterThan(10);
      expect(card.followUp.observable.length).toBeGreaterThan(10);
      expect(card.outcome.summary.length).toBeGreaterThan(20);
    }
  });

  it("preserves the exact fleet-eval receipt identity", () => {
    const card = agentReliabilitySlice.cards.find(
      (candidate) => candidate.id === "fleet-eval-proxmox-disk-triage",
    );
    expect(card?.source).toMatchObject({
      kind: "local_eval_receipt",
      artifactRef: "hermes-fleet-evals/results/proxmox-disk-fix.json",
      sha256:
        "faca44a1bd977cc93a9c79bcf57baac33cd9cb040098dc5f5f355c1644a28080",
    });
    expect(card?.confidence).toBe(1);
    expect(card?.outcome.status).toBe("observed");
  });

  it("rejects an external source without an HTTPS primary-source URL", () => {
    const candidate = cloneSlice();
    delete candidate.cards[0].source.url;
    expect(() => parseAgentReliabilitySlice(candidate)).toThrow(
      /External primary sources require an HTTPS URL/,
    );
  });

  it("rejects a local receipt without its SHA-256", () => {
    const candidate = cloneSlice();
    const source = candidate.cards[1].source;
    delete source.sha256;
    expect(() => parseAgentReliabilitySlice(candidate)).toThrow(
      /artifact reference and SHA-256/,
    );
  });

  it("rejects evidence quality that does not match the source kind", () => {
    const candidate = cloneSlice();
    candidate.cards[0].evidenceQuality = "direct_eval_receipt";

    expect(() => parseAgentReliabilitySlice(candidate)).toThrow(
      /Evidence quality must match source kind/,
    );
  });

  it("rejects duplicate claims and sources outside the window", () => {
    const duplicate = cloneSlice();
    duplicate.cards[1].id = duplicate.cards[0].id;
    expect(() => parseAgentReliabilitySlice(duplicate)).toThrow(
      /Card IDs must be unique/,
    );

    const outside = cloneSlice();
    outside.cards[0].source.publishedAt = "2026-07-19T23:59:59Z";
    expect(() => parseAgentReliabilitySlice(outside)).toThrow(
      /outside the seven-day slice/,
    );
  });

  it("rejects a window longer than seven days", () => {
    const candidate = cloneSlice();
    candidate.windowEnd = "2026-07-28T00:00:01Z";
    expect(() => parseAgentReliabilitySlice(candidate)).toThrow(
      /no longer than seven days/,
    );
  });

  it("calculates observed-outcome coverage without counting pending claims", () => {
    const candidate = parseAgentReliabilitySlice(cloneSlice());
    const coverage = calculateReliabilityCoverage(candidate);
    expect(coverage.observedOutcomes).toBe(2);
    expect(coverage.observedOutcomeCoveragePercent).toBe(67);
  });
});

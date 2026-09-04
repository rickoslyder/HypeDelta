/**
 * Packet 11B — web mapper/API/digest consume the canonical TopicSynthesis contract.
 * Mocked pg only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("pg", () => {
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

import {
  TOPIC_SYNTHESIS_SCHEMA_VERSION,
  TopicSynthesisSchema,
  toCanonicalTopicSynthesis,
} from "../../../../src/topic-synthesis";

const { getLatestSynthesis } = await import("./db");

const disagreement = {
  point: "Whether scaling alone leads to AGI",
  labPosition: "Continued scaling yields AGI-like capabilities",
  criticPosition: "Architectural changes needed beyond scaling",
};

const prediction = {
  text: "Reasoning evals keep climbing through 2027",
  author: "fixture-lab",
  confidence: 0.7,
  timeframe: "medium-term",
};

function canonicalWriterRow(digest: unknown = "# Weekly digest") {
  const synthesis = toCanonicalTopicSynthesis({
    topic: "reasoning",
    claimCount: 4,
    labConsensus: "Labs treat test-time compute as the next lever.",
    criticConsensus: "Critics say evals are saturating.",
    agreements: ["Eval gaming is a real risk"],
    disagreements: [disagreement],
    emergingNarratives: ["test-time compute"],
    predictions: [prediction],
    evidenceQuality: 0.6,
    hypeDelta: { delta: 0.2, labSentiment: 0.7, criticSentiment: 0.5, confidence: 0.6 },
    synthesisNarrative: "Labs push compute; critics push validity.",
  });
  return {
    id: 7,
    generated_at: "2026-08-28T00:00:00.000Z",
    lookback_days: 7,
    syntheses: [synthesis],
    hype_assessment: { overallFieldSentiment: 0.5, overhypedTopics: [], underhypedTopics: [] },
    digest,
  };
}

function latestRow(overrides: Record<string, unknown> = {}) {
  mockQuery.mockResolvedValueOnce({
    rows: [{ ...canonicalWriterRow(), ...overrides }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://localhost/test";
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("packet 11B web synthesis mapper", () => {
  it("round-trips a canonical writer row through the web mapper", async () => {
    latestRow();
    const mapped = await getLatestSynthesis();
    expect(mapped).not.toBeNull();
    const topic = mapped!.syntheses![0];
    const parsed = TopicSynthesisSchema.parse(topic);
    expect(parsed.schemaVersion).toBe(TOPIC_SYNTHESIS_SCHEMA_VERSION);
    expect(parsed.agreements).toEqual(["Eval gaming is a real risk"]);
    expect(parsed.disagreements[0]).toEqual(disagreement);
    expect(parsed.synthesisNarrative).toBe("Labs push compute; critics push validity.");
    expect(parsed.summary).toBe(parsed.synthesisNarrative);
    expect(mapped!.digest_markdown).toBe("# Weekly digest");
    expect(topic).not.toHaveProperty("keyAgreements");
    expect(topic).not.toHaveProperty("keyDebates");
  });

  it.each([
    {
      name: "(a) agreements + synthesisNarrative",
      syntheses: [
        {
          topic: "reasoning",
          agreements: ["Eval gaming is a real risk"],
          disagreements: [disagreement],
          predictions: [prediction],
          synthesisNarrative: "Labs push compute; critics push validity.",
          labConsensus: "Labs treat test-time compute as the next lever.",
          criticConsensus: "Critics say evals are saturating.",
        },
      ],
      digest: "# Shape A",
    },
    {
      name: "(b) keyAgreements/keyDisagreements/notablePredictions",
      syntheses: [
        {
          topic: "reasoning",
          keyAgreements: ["Eval gaming is a real risk"],
          keyDisagreements: [disagreement],
          notablePredictions: [prediction],
          labConsensus: "Labs treat test-time compute as the next lever.",
          criticConsensus: "Critics say evals are saturating.",
        },
      ],
      digest: "# Shape B",
    },
    {
      name: "(c) web summary/keyDebates",
      syntheses: [
        {
          topic: "reasoning",
          summary: "Web-era summary of the debate.",
          keyDebates: [
            {
              summary: disagreement.point,
              labPosition: disagreement.labPosition,
              criticPosition: disagreement.criticPosition,
            },
          ],
        },
      ],
      digest: "# Shape C",
    },
  ])("table-tests historical syntheses $name", async ({ syntheses, digest }) => {
    latestRow({ syntheses, digest });
    const mapped = await getLatestSynthesis();
    const topic = mapped!.syntheses![0];
    expect(topic.topic).toBe("reasoning");
    expect(topic.agreements).toBeDefined();
    expect(topic.disagreements).toBeDefined();
    expect(topic.predictions).toBeDefined();
    expect(typeof topic.synthesisNarrative).toBe("string");
    expect(typeof topic.summary).toBe("string");
    expect(topic).not.toHaveProperty("keyAgreements");
    expect(topic).not.toHaveProperty("keyDebates");
    expect(mapped!.digest_markdown).toBe(digest);
    expect(mapped!.digest_markdown!.length).toBeGreaterThan(0);
  });

  it.each([
    { name: "string", digest: "# Digest string" },
    { name: "object markdown", digest: { markdown: "# Digest markdown key" } },
    { name: "object text", digest: { text: "# Digest text key" } },
  ])("digest $name is nonempty markdown for GET /api/digest and /digest", async ({ digest }) => {
    latestRow({ digest });
    const mapped = await getLatestSynthesis();
    expect(mapped!.digest_markdown).toMatch(/^# Digest/);
    expect(mapped!.digest_markdown!.length).toBeGreaterThan(0);
  });

  it("malformed payload fails closed without throwing or fabricating summary", async () => {
    latestRow({ syntheses: { not: "an-array" }, digest: { bogus: true } });
    await expect(getLatestSynthesis()).resolves.toMatchObject({
      digest_markdown: "",
      syntheses: [],
    });

    latestRow({ syntheses: [{ totally: "unknown" }], digest: 12 });
    const closed = await getLatestSynthesis();
    expect(closed!.digest_markdown).toBe("");
    expect(closed!.syntheses).toHaveLength(1);
    expect(closed!.syntheses![0].summary).toBe("");
    expect(closed!.syntheses![0].synthesisNarrative).toBe("");
    expect(closed!.syntheses![0].unsupported).toBe(true);
  });
});

describe("packet 11B digest surfaces", () => {
  it("GET /api/digest returns nonempty markdown for a supported stored shape", async () => {
    latestRow({ digest: "# Weekly digest" });
    const { GET } = await import("../app/api/digest/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.digest).toBe("# Weekly digest");
    expect(String(body.digest).length).toBeGreaterThan(0);
  });

  it("/digest page renders digest_markdown from the mapper", () => {
    const page = readFileSync(
      path.resolve(__dirname, "../app/digest/page.tsx"),
      "utf8",
    );
    expect(page).toMatch(/digest_markdown/);
    expect(page).toMatch(/synthesisNarrative|summary/);
  });
});

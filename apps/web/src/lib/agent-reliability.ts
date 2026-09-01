import { z } from "zod";

import rawSlice from "../data/agent-reliability-slice.json";

const isoDateTime = z.string().datetime({ offset: true });

const sourceSchema = z
  .object({
    kind: z.enum([
      "official_release",
      "official_incident_report",
      "local_eval_receipt",
    ]),
    publisher: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(220),
    publishedAt: isoDateTime,
    url: z.string().url().startsWith("https://").optional(),
    artifactRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._/-]{1,240}$/)
      .optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict()
  .superRefine((source, context) => {
    const external = source.kind !== "local_eval_receipt";
    if (external && !source.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "External primary sources require an HTTPS URL",
      });
    }
    if (!external && (!source.artifactRef || !source.sha256)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactRef"],
        message: "Local primary sources require an artifact reference and SHA-256",
      });
    }
  });

const evidenceQualityBySourceKind = {
  official_release: "official_release_claim",
  official_incident_report: "primary_incident_report",
  local_eval_receipt: "direct_eval_receipt",
} as const;

const cardSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    category: z.string().trim().min(1).max(80),
    claim: z.string().trim().min(20).max(600),
    confidence: z.number().min(0).max(1),
    evidenceQuality: z.enum([
      "official_release_claim",
      "direct_eval_receipt",
      "primary_incident_report",
    ]),
    evidenceSummary: z.string().trim().min(20).max(800),
    source: sourceSchema,
    outcome: z
      .object({
        status: z.enum(["observed", "partially_observed", "pending"]),
        summary: z.string().trim().min(20).max(800),
      })
      .strict(),
    followUp: z
      .object({
        question: z.string().trim().min(10).max(400),
        observable: z.string().trim().min(10).max(600),
        dueAt: isoDateTime,
      })
      .strict(),
  })
  .strict()
  .superRefine((card, context) => {
    const expected = evidenceQualityBySourceKind[card.source.kind];
    if (card.evidenceQuality !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceQuality"],
        message: `Evidence quality must match source kind (${expected})`,
      });
    }
  });

export const agentReliabilitySliceSchema = z
  .object({
    schemaVersion: z.literal(1),
    topic: z.literal("Agent reliability"),
    windowStart: isoDateTime,
    windowEnd: isoDateTime,
    cards: z.array(cardSchema).min(1).max(20),
  })
  .strict()
  .superRefine((slice, context) => {
    const start = Date.parse(slice.windowStart);
    const end = Date.parse(slice.windowEnd);
    if (end <= start || end - start > 7 * 24 * 60 * 60 * 1000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowEnd"],
        message: "The slice window must be positive and no longer than seven days",
      });
    }

    const ids = new Set<string>();
    slice.cards.forEach((card, index) => {
      if (ids.has(card.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cards", index, "id"],
          message: "Card IDs must be unique",
        });
      }
      ids.add(card.id);

      const publishedAt = Date.parse(card.source.publishedAt);
      if (publishedAt < start || publishedAt > end) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cards", index, "source", "publishedAt"],
          message: "Primary source falls outside the seven-day slice",
        });
      }
      if (Date.parse(card.followUp.dueAt) <= publishedAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cards", index, "followUp", "dueAt"],
          message: "Follow-up must remain observable after source publication",
        });
      }
    });
  });

export type AgentReliabilitySlice = z.infer<
  typeof agentReliabilitySliceSchema
>;
export type AgentReliabilityCard = AgentReliabilitySlice["cards"][number];

export interface ReliabilityCoverage {
  totalClaims: number;
  sourceBackedClaims: number;
  sourceCoveragePercent: number;
  observedOutcomes: number;
  observedOutcomeCoveragePercent: number;
  openFollowUps: number;
}

export function parseAgentReliabilitySlice(
  input: unknown,
): AgentReliabilitySlice {
  return agentReliabilitySliceSchema.parse(input);
}

function isSourceBacked(card: AgentReliabilityCard): boolean {
  return Boolean(
    card.source.url ||
      (card.source.artifactRef && card.source.sha256),
  );
}

export function calculateReliabilityCoverage(
  slice: AgentReliabilitySlice,
): ReliabilityCoverage {
  const totalClaims = slice.cards.length;
  const sourceBackedClaims = slice.cards.filter(isSourceBacked).length;
  const observedOutcomes = slice.cards.filter(
    (card) => card.outcome.status === "observed",
  ).length;

  return {
    totalClaims,
    sourceBackedClaims,
    sourceCoveragePercent: Math.round(
      (sourceBackedClaims / totalClaims) * 100,
    ),
    observedOutcomes,
    observedOutcomeCoveragePercent: Math.round(
      (observedOutcomes / totalClaims) * 100,
    ),
    openFollowUps: slice.cards.length,
  };
}

export const agentReliabilitySlice = parseAgentReliabilitySlice(rawSlice);
export const agentReliabilityCoverage = calculateReliabilityCoverage(
  agentReliabilitySlice,
);

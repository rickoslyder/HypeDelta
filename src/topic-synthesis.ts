/**
 * Canonical runtime-validated TopicSynthesis contract (packet 11B).
 * Writers stamp schemaVersion; readers normalize historical shapes exactly once.
 */
import { z } from 'zod';

export const TOPIC_SYNTHESIS_SCHEMA_VERSION = 1 as const;

const disagreementSchema = z.object({
  point: z.string(),
  labPosition: z.string(),
  criticPosition: z.string(),
});

const predictionSchema = z.object({
  text: z.string(),
  author: z.string(),
  confidence: z.number(),
  timeframe: z.string(),
});

const hypeDeltaSchema = z.object({
  delta: z.number(),
  labSentiment: z.number(),
  criticSentiment: z.number(),
  confidence: z.number().optional(),
});

export const TopicSynthesisSchema = z.object({
  schemaVersion: z.literal(TOPIC_SYNTHESIS_SCHEMA_VERSION),
  topic: z.string(),
  claimCount: z.number(),
  labConsensus: z.string(),
  criticConsensus: z.string(),
  agreements: z.array(z.string()),
  disagreements: z.array(disagreementSchema),
  emergingNarratives: z.array(z.string()),
  predictions: z.array(predictionSchema),
  evidenceQuality: z.number(),
  hypeDelta: hypeDeltaSchema,
  synthesisNarrative: z.string(),
  summary: z.string(),
  unsupported: z.literal(true).optional(),
});

export type TopicSynthesis = z.infer<typeof TopicSynthesisSchema>;
export type TopicSynthesisDisagreement = z.infer<typeof disagreementSchema>;
export type TopicSynthesisPrediction = z.infer<typeof predictionSchema>;

export function emptyUnsupportedTopicSynthesis(): TopicSynthesis {
  return {
    schemaVersion: TOPIC_SYNTHESIS_SCHEMA_VERSION,
    topic: '',
    claimCount: 0,
    labConsensus: '',
    criticConsensus: '',
    agreements: [],
    disagreements: [],
    emergingNarratives: [],
    predictions: [],
    evidenceQuality: 0,
    hypeDelta: { delta: 0, labSentiment: 0, criticSentiment: 0, confidence: 0 },
    synthesisNarrative: '',
    summary: '',
    unsupported: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asDisagreements(value: unknown): TopicSynthesisDisagreement[] {
  if (!Array.isArray(value)) return [];
  const out: TopicSynthesisDisagreement[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const point = asString(item.point) || asString(item.summary);
    const labPosition = asString(item.labPosition);
    const criticPosition = asString(item.criticPosition);
    if (!point && !labPosition && !criticPosition) continue;
    out.push({ point, labPosition, criticPosition });
  }
  return out;
}

function asPredictions(value: unknown): TopicSynthesisPrediction[] {
  if (!Array.isArray(value)) return [];
  const out: TopicSynthesisPrediction[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.text !== 'string' || typeof item.author !== 'string') continue;
    if (typeof item.confidence !== 'number' || typeof item.timeframe !== 'string') continue;
    out.push({
      text: item.text,
      author: item.author,
      confidence: item.confidence,
      timeframe: item.timeframe,
    });
  }
  return out;
}

function asHypeDelta(value: unknown): TopicSynthesis['hypeDelta'] {
  if (!isRecord(value)) {
    return { delta: 0, labSentiment: 0, criticSentiment: 0, confidence: 0 };
  }
  return {
    delta: asNumber(value.delta),
    labSentiment: asNumber(value.labSentiment),
    criticSentiment: asNumber(value.criticSentiment),
    confidence: asNumber(value.confidence),
  };
}

function isRecognizableSynthesis(raw: Record<string, unknown>): boolean {
  return (
    'agreements' in raw ||
    'disagreements' in raw ||
    'predictions' in raw ||
    'synthesisNarrative' in raw ||
    'keyAgreements' in raw ||
    'keyDisagreements' in raw ||
    'notablePredictions' in raw ||
    'summary' in raw ||
    'keyDebates' in raw ||
    'labConsensus' in raw ||
    'criticConsensus' in raw ||
    'emergingNarratives' in raw ||
    'hypeDelta' in raw ||
    'evidenceQuality' in raw ||
    raw.schemaVersion === TOPIC_SYNTHESIS_SCHEMA_VERSION
  );
}

export function normalizeTopicSynthesis(
  raw: unknown,
  fallbacks?: { topic?: string; claimCount?: number },
): TopicSynthesis {
  if (!isRecord(raw)) return emptyUnsupportedTopicSynthesis();
  if (raw.unsupported === true) return emptyUnsupportedTopicSynthesis();
  if ('schemaVersion' in raw && raw.schemaVersion !== TOPIC_SYNTHESIS_SCHEMA_VERSION) {
    return emptyUnsupportedTopicSynthesis();
  }
  if (!isRecognizableSynthesis(raw)) return emptyUnsupportedTopicSynthesis();

  const topic = asString(raw.topic) || asString(fallbacks?.topic);
  const narrative = asString(raw.synthesisNarrative) || asString(raw.summary);
  const normalized: TopicSynthesis = {
    schemaVersion: TOPIC_SYNTHESIS_SCHEMA_VERSION,
    topic,
    claimCount: asNumber(raw.claimCount, asNumber(fallbacks?.claimCount)),
    labConsensus: asString(raw.labConsensus),
    criticConsensus: asString(raw.criticConsensus),
    agreements: asStringArray(raw.agreements).length
      ? asStringArray(raw.agreements)
      : asStringArray(raw.keyAgreements),
    disagreements: asDisagreements(raw.disagreements).length
      ? asDisagreements(raw.disagreements)
      : asDisagreements(raw.keyDisagreements).length
        ? asDisagreements(raw.keyDisagreements)
        : asDisagreements(raw.keyDebates),
    emergingNarratives: asStringArray(raw.emergingNarratives),
    predictions: asPredictions(raw.predictions).length
      ? asPredictions(raw.predictions)
      : asPredictions(raw.notablePredictions),
    evidenceQuality: asNumber(raw.evidenceQuality),
    hypeDelta: asHypeDelta(raw.hypeDelta),
    synthesisNarrative: narrative,
    summary: narrative,
  };
  return normalized;
}

export function toCanonicalTopicSynthesis(
  raw: unknown,
  fallbacks?: { topic?: string; claimCount?: number },
): TopicSynthesis {
  try {
    const normalized = normalizeTopicSynthesis(raw, fallbacks);
    if (normalized.unsupported) return normalized;
    const { unsupported: _unused, ...rest } = normalized;
    return TopicSynthesisSchema.parse(rest);
  } catch {
    return emptyUnsupportedTopicSynthesis();
  }
}

export function normalizeDigestMarkdown(digest: unknown): {
  markdown: string;
  unsupported: boolean;
} {
  if (typeof digest === 'string' && digest.trim() !== '') {
    return { markdown: digest, unsupported: false };
  }
  if (isRecord(digest)) {
    if (typeof digest.markdown === 'string' && digest.markdown.trim() !== '') {
      return { markdown: digest.markdown, unsupported: false };
    }
    if (typeof digest.text === 'string' && digest.text.trim() !== '') {
      return { markdown: digest.text, unsupported: false };
    }
  }
  return { markdown: '', unsupported: true };
}

export function normalizeStoredSyntheses(raw: unknown): TopicSynthesis[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => normalizeTopicSynthesis(item));
}

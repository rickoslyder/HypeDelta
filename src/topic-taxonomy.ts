/**
 * Canonical topic taxonomy for claims, predictions, filter, and synthesis.
 *
 * Product contract: persisted `topic` is one of CANONICAL_TOPICS.
 * Original nonblank spelling is stored separately in `raw_topic` only when
 * it differs from the canonical value after trim. Exact canonical spellings
 * (including surrounding whitespace) do not get a misleading raw_topic.
 */
import { sqlQuoteLiteral } from './author-side';

export const CANONICAL_TOPICS = [
  'scaling',
  'reasoning',
  'agents',
  'safety',
  'interpretability',
  'multimodal',
  'rlhf',
  'robotics',
  'benchmarks',
  'infrastructure',
  'policy',
  'general',
  'other',
] as const;

export type CanonicalTopic = (typeof CANONICAL_TOPICS)[number];

const CANONICAL_SET = new Set<string>(CANONICAL_TOPICS);

/**
 * Explicit historical aliases keyed by topicKey().
 * Separator/case variants of these labels collapse to the same key.
 */
const TOPIC_ALIASES: Record<string, CanonicalTopic> = {
  meta: 'general',
  capabilities: 'general',
  'machine learning': 'general',
  models: 'general',
  business: 'other',
  'medical ai': 'other',
  'medical imaging': 'multimodal',
  'multilingual models': 'multimodal',
  'neural operators': 'other',
  'world models': 'other',
  'ai safety': 'safety',
  'graph anomaly detection': 'other',
  'graph neural networks': 'other',
  nlp: 'general',
  'online learning': 'other',
  'ai adoption': 'policy',
  'ai business': 'other',
  'continual learning': 'other',
  'deep learning theory': 'general',
  education: 'other',
  'ontology learning': 'other',
  'physical computing': 'robotics',
  'software engineering': 'other',
  '3d vision': 'multimodal',
  'ai architecture': 'infrastructure',
  'ai regulation': 'policy',
  applications: 'other',
  'commercial applications': 'other',
  'diffusion models': 'multimodal',
  'model releases': 'general',
  'openai products': 'general',
  'quantum computing': 'other',
  'quantum computing for medical imaging': 'other',
  'ai applications': 'other',
  'ai capabilities': 'general',
  'computer vision datasets': 'multimodal',
  cybersecurity: 'safety',
  industry: 'other',
  'llm engineering': 'infrastructure',
  'molecular generation': 'other',
  'neural networks': 'general',
  releases: 'general',
  'representation learning': 'other',
  'access and deployment': 'infrastructure',
  agi: 'general',
  'ai agent governance': 'policy',
  'ai companies': 'other',
  'ai impact on work': 'policy',
  'ai productivity': 'other',
  'ai products': 'other',
  'ai systems': 'general',
  'api pricing': 'infrastructure',
  architectures: 'infrastructure',
  biosecurity: 'safety',
  'chatgpt enterprise adoption': 'other',
  'chatgpt features': 'other',
  'claude code features': 'agents',
  'claude enterprise': 'other',
  'clinical ai design': 'other',
  'clinical research methodology': 'other',
  'codex capabilities': 'agents',
  'computer vision': 'multimodal',
  'computer vision limitations': 'multimodal',
  'frontier labs': 'general',
  'gaming ai': 'other',
  'generative ai applications': 'other',
  hardware: 'infrastructure',
  'healthcare ai application': 'other',
  'healthcare safety': 'safety',
  'llm deployment': 'infrastructure',
  'model capabilities': 'general',
  'model routing': 'infrastructure',
  'neuromorphic computing': 'infrastructure',
  'neurosymbolic ai': 'other',
  pricing: 'infrastructure',
  'scientific ai': 'other',
  'space computing': 'infrastructure',
  'text to speech': 'multimodal',
  timelines: 'general',
};

export function isCanonicalTopic(value: unknown): value is CanonicalTopic {
  return typeof value === 'string' && CANONICAL_SET.has(value);
}

/** Collapse trim/case/hyphen/underscore/slash/comma variants to a lookup key. */
export function topicKey(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[/_,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTopic(value: unknown): CanonicalTopic {
  const key = topicKey(value);
  if (!key) return 'other';
  if (CANONICAL_SET.has(key)) return key as CanonicalTopic;
  // 'Multi-Modal' → 'multi modal' → compact 'multimodal'
  const compact = key.replace(/ /g, '');
  if (compact !== key && CANONICAL_SET.has(compact)) return compact as CanonicalTopic;
  const aliased = TOPIC_ALIASES[key];
  if (aliased) return aliased;
  return 'other';
}

/**
 * Original nonblank spelling, or null when it is already the canonical value
 * after trim (so exact canonical rows do not grow a misleading raw_topic).
 */
export function preservedRawTopic(raw: unknown, canonical: CanonicalTopic): string | null {
  if (raw == null) return null;
  const original = String(raw).trim();
  if (original === '') return null;
  if (original === canonical) return null;
  return original;
}

export interface TopicPreservation {
  topic: CanonicalTopic;
  rawTopic: string | null;
}

export function topicPreservation(value: unknown): TopicPreservation {
  const topic = normalizeTopic(value);
  return { topic, rawTopic: preservedRawTopic(value, topic) };
}

/**
 * Storage-boundary helper: incoming topic may already be canonical while
 * rawTopic/raw_topic carries the model/source spelling.
 */
export function storedTopicFields(input: {
  topic?: unknown;
  rawTopic?: unknown;
  raw_topic?: unknown;
}): TopicPreservation {
  const canonical = normalizeTopic(input.topic);
  const explicit = input.rawTopic ?? input.raw_topic;
  const rawCandidate = explicit != null && String(explicit).trim() !== ''
    ? explicit
    : input.topic;
  return { topic: canonical, rawTopic: preservedRawTopic(rawCandidate, canonical) };
}

/** Canonicalize a requested/persisted list, merge aliases, keep CANONICAL_TOPICS order. */
export function uniqueCanonicalTopics(values: readonly unknown[] | null | undefined): CanonicalTopic[] {
  if (values == null) return [...CANONICAL_TOPICS];
  const seen = new Set<CanonicalTopic>();
  for (const value of values) {
    seen.add(normalizeTopic(value));
  }
  return CANONICAL_TOPICS.filter((topic) => seen.has(topic));
}

function sqlTopicKeyExpr(column: string): string {
  return `lower(btrim(regexp_replace(regexp_replace(COALESCE(${column}, ''), '[/_,-]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')))`;
}

function canonicalizeSqlCase(keySql: string, compactSql: string): string {
  const aliasWhens = Object.entries(TOPIC_ALIASES)
    .map(
      ([key, topic]) =>
        `WHEN ${keySql} = ${sqlQuoteLiteral(key)} THEN ${sqlQuoteLiteral(topic)}`,
    )
    .join('\n      ');
  const canonicalWhens = CANONICAL_TOPICS.map(
    (topic) =>
      `WHEN ${keySql} = ${sqlQuoteLiteral(topic)} OR ${compactSql} = ${sqlQuoteLiteral(topic)} THEN ${sqlQuoteLiteral(topic)}`,
  ).join('\n      ');
  return `CASE\n      ${canonicalWhens}\n      ${aliasWhens}\n      ELSE 'other'\n    END`;
}

export function topicCheckSql(column = 'topic'): string {
  const list = CANONICAL_TOPICS.map(sqlQuoteLiteral).join(', ');
  return `${column} IN (${list})`;
}

function preserveAndCanonicalizeUpdate(table: string, extraPredicate = ''): string {
  const compactSql = `regexp_replace(k.topic_key, '[[:space:]]+', '', 'g')`;
  const canon = canonicalizeSqlCase('k.topic_key', compactSql);
  const extra = extraPredicate ? `\n  AND ${extraPredicate}` : '';
  return `
UPDATE ${table} AS t
SET
  raw_topic = CASE
    WHEN t.raw_topic IS NOT NULL THEN t.raw_topic
    WHEN n.orig = '' THEN NULL
    WHEN n.orig = n.canon THEN NULL
    ELSE n.orig
  END,
  topic = n.canon
FROM (
  SELECT
    k.id,
    k.orig,
    ${canon} AS canon
  FROM (
    SELECT
      id,
      COALESCE(btrim(topic), '') AS orig,
      ${sqlTopicKeyExpr('topic')} AS topic_key
    FROM ${table}
  ) AS k
) AS n
WHERE t.id = n.id${extra}`.trim();
}

export function topicTaxonomySql(): string {
  const claimCheck = topicCheckSql('topic');
  const predCheck = topicCheckSql('topic');
  return `
-- 010 canonical topic taxonomy: additive raw_topic + rewrite + CHECK
ALTER TABLE extracted_claims ADD COLUMN IF NOT EXISTS raw_topic TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS raw_topic TEXT;

${preserveAndCanonicalizeUpdate('extracted_claims')};

UPDATE predictions AS p
SET
  topic = c.topic,
  raw_topic = c.raw_topic
FROM extracted_claims AS c
WHERE p.claim_id IS NOT NULL
  AND p.claim_id = c.id;

${preserveAndCanonicalizeUpdate('predictions')};

ALTER TABLE extracted_claims ALTER COLUMN topic SET NOT NULL;
ALTER TABLE predictions ALTER COLUMN topic SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'extracted_claims_topic_check'
      AND conrelid = to_regclass(format('%I.extracted_claims', current_schema()))
  ) THEN
    ALTER TABLE extracted_claims
      ADD CONSTRAINT extracted_claims_topic_check
      CHECK (${claimCheck});
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'predictions_topic_check'
      AND conrelid = to_regclass(format('%I.predictions', current_schema()))
  ) THEN
    ALTER TABLE predictions
      ADD CONSTRAINT predictions_topic_check
      CHECK (${predCheck});
  END IF;
END $$;
`.trim();
}

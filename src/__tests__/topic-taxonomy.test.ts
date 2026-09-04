/**
 * Canonical topic taxonomy: shared module, preservation, and migration 010 shape.
 * No providers, network, or live postgres.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CANONICAL_TOPICS,
  isCanonicalTopic,
  normalizeTopic,
  preservedRawTopic,
  topicPreservation,
  topicTaxonomySql,
  type CanonicalTopic,
} from '../topic-taxonomy';

const ROOT = resolve(__dirname, '../..');

const EXPECTED_CANONICAL = [
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

/** Production historical labels → canonical. Every listed token is explicit. */
const HISTORICAL_ALIASES: Record<string, CanonicalTopic> = {
  meta: 'general',
  capabilities: 'general',
  'machine-learning': 'general',
  models: 'general',
  business: 'other',
  'medical AI': 'other',
  'medical-imaging': 'multimodal',
  'multilingual models': 'multimodal',
  'neural operators': 'other',
  'world-models': 'other',
  'ai-safety': 'safety',
  'AI safety': 'safety',
  'graph-anomaly-detection': 'other',
  'graph neural networks': 'other',
  nlp: 'general',
  'online learning': 'other',
  'ai-adoption': 'policy',
  'AI business': 'other',
  'continual learning': 'other',
  'deep learning theory': 'general',
  education: 'other',
  'machine learning': 'general',
  'medical-ai': 'other',
  'ontology learning': 'other',
  'physical computing': 'robotics',
  'software engineering': 'other',
  '3d-vision': 'multimodal',
  'ai-architecture': 'infrastructure',
  'AI regulation': 'policy',
  applications: 'other',
  'commercial-applications': 'other',
  'diffusion-models': 'multimodal',
  'model-releases': 'general',
  'openai-products': 'general',
  'quantum computing': 'other',
  'quantum computing for medical imaging': 'other',
  'AI adoption': 'policy',
  'AI applications': 'other',
  'AI capabilities': 'general',
  'computer vision datasets': 'multimodal',
  cybersecurity: 'safety',
  industry: 'other',
  'llm-engineering': 'infrastructure',
  'model releases': 'general',
  'molecular generation': 'other',
  'neural-networks': 'general',
  releases: 'general',
  'representation learning': 'other',
  'access-and-deployment': 'infrastructure',
  agi: 'general',
  'AI agent governance': 'policy',
  'ai-applications': 'other',
  'ai-capabilities': 'general',
  'AI companies': 'other',
  'AI impact on work': 'policy',
  'ai-productivity': 'other',
  'ai-products': 'other',
  'AI systems': 'general',
  'API pricing': 'infrastructure',
  architectures: 'infrastructure',
  biosecurity: 'safety',
  'chatgpt-enterprise-adoption': 'other',
  'ChatGPT features': 'other',
  'Claude Code features': 'agents',
  'Claude enterprise': 'other',
  'clinical-ai-design': 'other',
  'clinical-research-methodology': 'other',
  'codex-capabilities': 'agents',
  'computer vision': 'multimodal',
  'computer vision limitations': 'multimodal',
  'frontier labs': 'general',
  'gaming-ai': 'other',
  'generative AI applications': 'other',
  hardware: 'infrastructure',
  'healthcare-ai-application': 'other',
  'healthcare-safety': 'safety',
  'llm-deployment': 'infrastructure',
  'model capabilities': 'general',
  'model-routing': 'infrastructure',
  'neuromorphic computing': 'infrastructure',
  'neurosymbolic-ai': 'other',
  pricing: 'infrastructure',
  'scientific-ai': 'other',
  'space computing': 'infrastructure',
  'text-to-speech': 'multimodal',
  timelines: 'general',
};

describe('canonical topic contract', () => {
  it('exports exactly the 13 product topics in stable order', () => {
    expect([...CANONICAL_TOPICS]).toEqual([...EXPECTED_CANONICAL]);
    expect(CANONICAL_TOPICS).toHaveLength(13);
    for (const topic of CANONICAL_TOPICS) {
      expect(isCanonicalTopic(topic)).toBe(true);
      expect(normalizeTopic(topic)).toBe(topic);
      expect(topicPreservation(topic)).toEqual({ topic, rawTopic: null });
    }
  });

  it('normalizes trim, case, and separator variants of canonical topics', () => {
    expect(normalizeTopic('  Scaling  ')).toBe('scaling');
    expect(normalizeTopic('SAFETY')).toBe('safety');
    expect(normalizeTopic('Multi-Modal')).toBe('multimodal');
    expect(normalizeTopic('multi_modal')).toBe('multimodal');
    expect(normalizeTopic('MULTI/MODAL')).toBe('multimodal');
    expect(topicPreservation('Multi-Modal')).toEqual({
      topic: 'multimodal',
      rawTopic: 'Multi-Modal',
    });
    expect(normalizeTopic('rlhf')).toBe('rlhf');
    expect(normalizeTopic('RLHF')).toBe('rlhf');
  });

  it('maps unknown nonblank values to other and preserves the raw spelling', () => {
    expect(normalizeTopic('not-a-real-topic-xyz')).toBe('other');
    expect(topicPreservation('not-a-real-topic-xyz')).toEqual({
      topic: 'other',
      rawTopic: 'not-a-real-topic-xyz',
    });
    expect(normalizeTopic('')).toBe('other');
    expect(normalizeTopic(null)).toBe('other');
    expect(normalizeTopic(undefined)).toBe('other');
    expect(topicPreservation('   ')).toEqual({ topic: 'other', rawTopic: null });
    expect(topicPreservation(null)).toEqual({ topic: 'other', rawTopic: null });
  });

  it('preserves original nonblank spelling only when it differs from canonical', () => {
    expect(preservedRawTopic('scaling', 'scaling')).toBeNull();
    expect(preservedRawTopic('  scaling  ', 'scaling')).toBeNull();
    expect(preservedRawTopic('Scaling', 'scaling')).toBe('Scaling');
    expect(preservedRawTopic('AI safety', 'safety')).toBe('AI safety');
    expect(topicPreservation('Scaling')).toEqual({ topic: 'scaling', rawTopic: 'Scaling' });
    expect(topicPreservation('  scaling  ')).toEqual({ topic: 'scaling', rawTopic: null });
    expect(topicPreservation('safety')).toEqual({ topic: 'safety', rawTopic: null });
  });

  it('maps every listed historical production label via explicit aliases', () => {
    const labels = Object.keys(HISTORICAL_ALIASES);
    expect(labels.length).toBeGreaterThanOrEqual(80);
    for (const [raw, canonical] of Object.entries(HISTORICAL_ALIASES)) {
      expect(normalizeTopic(raw), raw).toBe(canonical);
      const preserved = topicPreservation(raw);
      expect(preserved.topic, raw).toBe(canonical);
      if (raw === canonical) {
        expect(preserved.rawTopic, raw).toBeNull();
      } else {
        expect(preserved.rawTopic, raw).toBe(raw);
      }
    }
  });

  it('merges separator variants of historical aliases into the same canonical bucket', () => {
    expect(normalizeTopic('ai-safety')).toBe('safety');
    expect(normalizeTopic('AI_safety')).toBe('safety');
    expect(normalizeTopic('AI/safety')).toBe('safety');
    expect(normalizeTopic('  AI   safety  ')).toBe('safety');
    expect(normalizeTopic('machine_learning')).toBe('general');
    expect(normalizeTopic('machine learning')).toBe('general');
  });
});

describe('010 topic taxonomy migration SQL', () => {
  it('is additive, idempotent, generated from the shared module, and does not rewrite synthesis JSON', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.slice(0, 9)).toEqual([
      '001', '002', '003', '004', '005', '006', '007', '008', '009',
    ]);
    expect(versions).toEqual([...versions].sort());
    expect(versions).toContain('010');
    expect(versions.at(-1)).toBe('010');

    const m010 = MIGRATIONS.find((m) => m.version === '010');
    expect(m010).toBeDefined();
    expect(m010!.name).toMatch(/topic_taxonomy|canonical_topics/i);
    expect(m010!.sql).toBe(topicTaxonomySql());

    const sql = m010!.sql;
    expect(sql).toMatch(/ALTER TABLE extracted_claims ADD COLUMN IF NOT EXISTS raw_topic TEXT/i);
    expect(sql).toMatch(/ALTER TABLE predictions ADD COLUMN IF NOT EXISTS raw_topic TEXT/i);
    expect(sql).toMatch(/UPDATE\s+extracted_claims/i);
    expect(sql).toMatch(/UPDATE\s+predictions/i);
    expect(sql).toMatch(/extracted_claims_topic_check/);
    expect(sql).toMatch(/predictions_topic_check/);
    expect(sql).toMatch(/ALTER TABLE extracted_claims ALTER COLUMN topic SET NOT NULL/i);
    expect(sql).toMatch(/ALTER TABLE predictions ALTER COLUMN topic SET NOT NULL/i);
    expect(sql).toMatch(/IF NOT EXISTS/i);
    for (const topic of CANONICAL_TOPICS) {
      expect(sql).toContain(`'${topic}'`);
    }
    expect(sql).toMatch(/FROM extracted_claims/i);
    expect(sql).toMatch(/claim_id/i);
    expect(sql).toMatch(/\[\[:space:\]\]\+/);
    expect(sql).not.toMatch(/'\\s\+'/);
    expect(sql).toMatch(/regexp_replace\([^,]+, '\[\[:space:\]\]\+', '', 'g'\)/);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/UPDATE\s+synthesis_results/i);
  });
});

describe('consumer wiring contract', () => {
  it('derives Topic from the shared CanonicalTopic type without duplicating the union', () => {
    const typesSrc = readFileSync(resolve(ROOT, 'src/types.ts'), 'utf8');
    expect(typesSrc).toMatch(/from ['"]\.\/topic-taxonomy['"]/);
    expect(typesSrc).toMatch(/export type Topic = CanonicalTopic|export type \{ CanonicalTopic as Topic \}/);
    expect(typesSrc).not.toMatch(/export type Topic =\s*\n\s*\|\s*'scaling'/);
  });

  it('normalizes at ClaimStore/PredictionTracker writes and filter/extract/synthesis boundaries', () => {
    const storageSrc = readFileSync(resolve(ROOT, 'src/storage.ts'), 'utf8');
    expect(storageSrc).toMatch(/from ['"]\.\/topic-taxonomy['"]/);
    expect(storageSrc).toMatch(/topicPreservation|normalizeTopic/);
    expect(storageSrc).toMatch(/raw_topic/);

    const indexSrc = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    expect(indexSrc).toMatch(/from ['"]\.\/topic-taxonomy['"]/);
    expect(indexSrc).toMatch(/normalizeTopic/);
    expect(indexSrc).toMatch(/CANONICAL_TOPICS/);

    const pipelineSrc = readFileSync(resolve(ROOT, 'src/pipeline-model-agent.ts'), 'utf8');
    expect(pipelineSrc).toMatch(/from ['"]\.\/topic-taxonomy['"]/);
    expect(pipelineSrc).toMatch(/normalizeTopic/);

    const webDb = readFileSync(resolve(ROOT, 'apps/web/src/lib/db.ts'), 'utf8');
    expect(webDb).toMatch(/e\.raw_topic/);
    expect(webDb).toMatch(/export interface Claim \{[\s\S]*?\braw_topic\s*:\s*string\s*\|\s*null/);
  });
});

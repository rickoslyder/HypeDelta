/**
 * Runtime taxonomy boundaries: filter/extract typed output, storage-linked
 * predictions, and runSynthesis fan-out. No providers or network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg', () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
    connect: vi.fn().mockResolvedValue({
      query: mockQuery,
      release: vi.fn(),
    }),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

vi.mock('../embeddings', () => ({
  EmbeddingService: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
    embedBatch: vi.fn().mockResolvedValue([]),
  })),
}));

import { PipelineModelAgent } from '../pipeline-model-agent';
import { AIIntelOrchestrator } from '../index';
import { CANONICAL_TOPICS } from '../topic-taxonomy';

const hypeDelta = {
  delta: 0.2,
  labSentiment: 0.7,
  criticSentiment: 0.5,
  confidence: 0.6,
};

function synthesisPayload(topic: string) {
  return {
    labConsensus: `Labs on ${topic}`,
    criticConsensus: `Critics on ${topic}`,
    agreements: ['shared'],
    disagreements: [{
      point: 'p',
      labPosition: 'l',
      criticPosition: 'c',
    }],
    emergingNarratives: ['n'],
    predictions: [{ text: 't', author: 'a', confidence: 0.5, timeframe: 'near-term' }],
    evidenceQuality: 0.5,
    hypeDelta,
    synthesisNarrative: `Narrative for ${topic}`,
  };
}

describe('filter/extract typed-boundary normalization', () => {
  it('canonicalizes filter model output and maps unknown topics to other', async () => {
    const router = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          assessments: [
            {
              idx: 0,
              relevance: 0.9,
              topic: 'AI safety',
              contentType: 'opinion',
              authorCategory: 'lab-researcher',
              isSubstantive: true,
              brief: 'alignment',
            },
            {
              idx: 1,
              relevance: 0.8,
              topic: 'not-a-real-topic-xyz',
              contentType: 'opinion',
              authorCategory: 'critic',
              isSubstantive: true,
              brief: 'misc',
            },
          ],
        }),
      }),
    };
    const agent = new PipelineModelAgent({ router: router as never });
    const result = await agent.filterContent([
      { id: 1, author: 'a', content: 'Alignment work continues at the frontier of AI safety research today.' },
      { id: 2, author: 'b', content: 'An unrelated specialty label that should not pass through unsafely.' },
    ]);
    expect(result.assessments[0].topic).toBe('safety');
    expect(result.assessments[1].topic).toBe('other');
  });

  it('normalizes extractor claim topics before the ExtractedClaim boundary', () => {
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: false,
    });
    const claims = (orch as any).normalizeClaimResults({
      claims: [
        {
          contentId: 1,
          claimText: 'Alignment is hard',
          claimType: 'opinion',
          topic: 'AI safety',
          originalQuote: 'Alignment is hard',
        },
        {
          contentId: 1,
          claimText: 'Obscure subfield',
          claimType: 'opinion',
          topic: 'not-a-real-topic-xyz',
          originalQuote: 'Obscure subfield',
        },
      ],
    });
    expect(claims[0].topic).toBe('safety');
    expect(claims[0].rawTopic).toBe('AI safety');
    expect(claims[1].topic).toBe('other');
    expect(claims[1].rawTopic).toBe('not-a-real-topic-xyz');
  });
});

describe('runSynthesis canonical fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges aliases, ignores empty requested buckets, and never fans out past 13 topics', async () => {
    const synthesize = vi.fn(async (_claims: unknown[], topic: string) => synthesisPayload(topic));
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: true,
      agent: {
        filterContent: async () => ({ assessments: [] }),
        extractClaims: async () => ({ claims: [] }),
        synthesize,
        useSkill: async () => ({
          overhypedTopics: [],
          underhypedTopics: [],
          accuratelyAssessedTopics: [],
          overallFieldSentiment: 0.5,
          summary: 'aligned',
        }),
        generateDigest: async () => '# Weekly digest',
      } as never,
    });

    vi.spyOn((orch as any).claimStore, 'getRecent').mockResolvedValue([
      { topic: 'AI safety', claimText: 'a', authorCategory: 'lab-researcher' },
      { topic: 'safety', claimText: 'b', authorCategory: 'critic' },
      { topic: 'ai-safety', claimText: 'c', authorCategory: 'academic' },
      { topic: 'medical AI', claimText: 'd', authorCategory: 'independent' },
      { topic: 'not-a-real-topic-xyz', claimText: 'e', authorCategory: 'unknown' },
      { topic: 'scaling', claimText: 'f', authorCategory: 'lab-researcher' },
      { topic: 'hardware', claimText: 'g', authorCategory: 'lab-researcher' },
    ]);
    vi.spyOn((orch as any).synthesisStore, 'save').mockResolvedValue(1);

    await orch.runSynthesis({
      lookbackDays: 7,
      generateDigest: false,
      topics: ['AI safety', 'safety', 'robotics', 'not-a-real-topic-xyz'] as never,
    });

    const calledTopics = synthesize.mock.calls.map((c) => c[1]);
    expect(calledTopics).toEqual(['safety', 'other']);
    expect(calledTopics.length).toBeLessThanOrEqual(13);
    expect(calledTopics).not.toContain('robotics');
    expect(calledTopics).not.toContain('AI safety');
    expect(calledTopics).not.toContain('ai-safety');
  });

  it('synthesizes persisted alias claims in stable canonical order and caps at 13', async () => {
    const synthesize = vi.fn(async (_claims: unknown[], topic: string) => synthesisPayload(topic));
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: true,
      agent: {
        filterContent: async () => ({ assessments: [] }),
        extractClaims: async () => ({ claims: [] }),
        synthesize,
        useSkill: async () => ({
          overhypedTopics: [],
          underhypedTopics: [],
          accuratelyAssessedTopics: [],
          overallFieldSentiment: 0.5,
          summary: 'aligned',
        }),
        generateDigest: async () => '# Weekly digest',
      } as never,
    });

    const noisy = [
      'meta', 'capabilities', 'machine-learning', 'AI safety', 'computer vision',
      'hardware', 'rlhf', 'agents', 'benchmarks', 'policy', 'robotics',
      'interpretability', 'not-a-real-topic-xyz', 'scaling', 'world-models',
      'timelines', 'Claude Code features', 'AI regulation',
    ].map((topic, i) => ({ topic, claimText: `c${i}`, authorCategory: 'independent' }));

    vi.spyOn((orch as any).claimStore, 'getRecent').mockResolvedValue(noisy);
    vi.spyOn((orch as any).synthesisStore, 'save').mockResolvedValue(1);

    await orch.runSynthesis({ lookbackDays: 7, generateDigest: false });

    const calledTopics = synthesize.mock.calls.map((c) => c[1]);
    expect(calledTopics.length).toBeLessThanOrEqual(13);
    expect(new Set(calledTopics).size).toBe(calledTopics.length);
    const allowed = new Set(CANONICAL_TOPICS);
    for (const topic of calledTopics) {
      expect(allowed.has(topic as (typeof CANONICAL_TOPICS)[number])).toBe(true);
    }
    const ordered = CANONICAL_TOPICS.filter((t) => calledTopics.includes(t));
    expect(calledTopics).toEqual(ordered);
  });
});

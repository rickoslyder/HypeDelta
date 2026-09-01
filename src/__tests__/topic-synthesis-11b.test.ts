/**
 * Packet 11B — one canonical runtime-validated TopicSynthesis contract.
 * No providers, network, or live postgres.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg', () => {
  const MockPool = vi.fn(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn(),
    connect: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'result', subtype: 'success', result: '{}' };
  }),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}));

vi.mock('../embeddings', () => ({
  EmbeddingService: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
    embedBatch: vi.fn().mockResolvedValue([]),
  })),
}));

import {
  TOPIC_SYNTHESIS_SCHEMA_VERSION,
  TopicSynthesisSchema,
  normalizeTopicSynthesis,
  normalizeDigestMarkdown,
  toCanonicalTopicSynthesis,
} from '../topic-synthesis';
import { SynthesisStore } from '../storage';
import { AIIntelAgent } from '../agent-sdk-wrapper';
import { AIIntelOrchestrator } from '../index';

const ROOT = resolve(__dirname, '..');

const disagreement = {
  point: 'Whether scaling alone leads to AGI',
  labPosition: 'Continued scaling yields AGI-like capabilities',
  criticPosition: 'Architectural changes needed beyond scaling',
};

const prediction = {
  text: 'Reasoning evals keep climbing through 2027',
  author: 'fixture-lab',
  confidence: 0.7,
  timeframe: 'medium-term',
};

const hypeDelta = {
  delta: 0.2,
  labSentiment: 0.7,
  criticSentiment: 0.5,
  confidence: 0.6,
};

function canonicalInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: TOPIC_SYNTHESIS_SCHEMA_VERSION,
    topic: 'reasoning',
    claimCount: 4,
    labConsensus: 'Labs treat test-time compute as the next lever.',
    criticConsensus: 'Critics say evals are saturating.',
    agreements: ['Eval gaming is a real risk'],
    disagreements: [disagreement],
    emergingNarratives: ['test-time compute'],
    predictions: [prediction],
    evidenceQuality: 0.6,
    hypeDelta,
    synthesisNarrative: 'Labs push compute; critics push validity.',
    summary: 'Labs push compute; critics push validity.',
    ...overrides,
  };
}

describe('packet 11B TopicSynthesis contract', () => {
  it('validates a canonical writer payload with schemaVersion', () => {
    const parsed = TopicSynthesisSchema.parse(canonicalInput());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.agreements).toEqual(['Eval gaming is a real risk']);
    expect(parsed.disagreements[0]).toEqual(disagreement);
    expect(parsed.predictions[0].text).toBe(prediction.text);
    expect(parsed.synthesisNarrative).toBe(parsed.summary);
    expect(parsed).not.toHaveProperty('keyAgreements');
    expect(parsed).not.toHaveProperty('keyDisagreements');
    expect(parsed).not.toHaveProperty('notablePredictions');
    expect(parsed).not.toHaveProperty('keyDebates');
  });

  it.each([
    {
      name: '(a) agreements/disagreements/predictions + optional synthesisNarrative',
      raw: {
        topic: 'reasoning',
        claimCount: 4,
        labConsensus: 'Labs treat test-time compute as the next lever.',
        criticConsensus: 'Critics say evals are saturating.',
        agreements: ['Eval gaming is a real risk'],
        disagreements: [disagreement],
        emergingNarratives: ['test-time compute'],
        predictions: [prediction],
        evidenceQuality: 0.6,
        hypeDelta,
        synthesisNarrative: 'Labs push compute; critics push validity.',
      },
      expected: {
        agreements: ['Eval gaming is a real risk'],
        disagreements: [disagreement],
        predictions: [prediction],
        synthesisNarrative: 'Labs push compute; critics push validity.',
        summary: 'Labs push compute; critics push validity.',
      },
    },
    {
      name: '(b) keyAgreements/keyDisagreements/notablePredictions',
      raw: {
        topic: 'reasoning',
        claimCount: 4,
        labConsensus: 'Labs treat test-time compute as the next lever.',
        criticConsensus: 'Critics say evals are saturating.',
        keyAgreements: ['Eval gaming is a real risk'],
        keyDisagreements: [disagreement],
        notablePredictions: [prediction],
        emergingNarratives: ['test-time compute'],
        evidenceQuality: 0.6,
        hypeDelta,
      },
      expected: {
        agreements: ['Eval gaming is a real risk'],
        disagreements: [disagreement],
        predictions: [prediction],
        synthesisNarrative: '',
        summary: '',
      },
    },
    {
      name: '(c) web summary/keyDebates',
      raw: {
        topic: 'reasoning',
        summary: 'Web-era summary of the debate.',
        keyDebates: [
          {
            summary: disagreement.point,
            labPosition: disagreement.labPosition,
            criticPosition: disagreement.criticPosition,
          },
        ],
      },
      expected: {
        agreements: [],
        disagreements: [disagreement],
        predictions: [],
        synthesisNarrative: 'Web-era summary of the debate.',
        summary: 'Web-era summary of the debate.',
      },
    },
  ])('reader normalizes historical shape $name exactly once', ({ raw, expected }) => {
    const once = normalizeTopicSynthesis(raw);
    expect(once.unsupported).toBeFalsy();
    expect(once.schemaVersion).toBe(TOPIC_SYNTHESIS_SCHEMA_VERSION);
    expect(once.topic).toBe('reasoning');
    expect(once.agreements).toEqual(expected.agreements);
    expect(once.disagreements).toEqual(expected.disagreements);
    expect(once.predictions).toEqual(expected.predictions);
    expect(once.synthesisNarrative).toBe(expected.synthesisNarrative);
    expect(once.summary).toBe(expected.summary);
    expect(once).not.toHaveProperty('keyAgreements');
    expect(once).not.toHaveProperty('keyDebates');

    const twice = normalizeTopicSynthesis(once);
    expect(twice).toEqual(once);
  });

  it.each([
    { name: 'string markdown', digest: '# Weekly digest', markdown: '# Weekly digest' },
    { name: 'object markdown', digest: { markdown: '# From markdown key' }, markdown: '# From markdown key' },
    { name: 'object text', digest: { text: '# From text key' }, markdown: '# From text key' },
  ])('digest $name yields nonempty markdown', ({ digest, markdown }) => {
    const result = normalizeDigestMarkdown(digest);
    expect(result.unsupported).toBe(false);
    expect(result.markdown).toBe(markdown);
    expect(result.markdown.length).toBeGreaterThan(0);
  });

  it('malformed payload fails closed to explicit empty/unsupported without throwing or fabricating summary', () => {
    expect(() => normalizeTopicSynthesis({ foo: 1 })).not.toThrow();
    expect(() => normalizeTopicSynthesis('not-json')).not.toThrow();
    expect(() => normalizeTopicSynthesis(null)).not.toThrow();
    expect(() => normalizeDigestMarkdown({ nested: true })).not.toThrow();

    const bad = normalizeTopicSynthesis({ foo: 1, schemaVersion: 99 });
    expect(bad.unsupported).toBe(true);
    expect(bad.synthesisNarrative).toBe('');
    expect(bad.summary).toBe('');
    expect(bad.agreements).toEqual([]);
    expect(bad.topic).toBe('');

    const digest = normalizeDigestMarkdown({ nested: true });
    expect(digest.unsupported).toBe(true);
    expect(digest.markdown).toBe('');
  });

  it('prompts at write boundaries reference canonical field names only', () => {
    const prompts = readFileSync(resolve(ROOT, 'prompts.ts'), 'utf8');
    const wrapper = readFileSync(resolve(ROOT, 'agent-sdk-wrapper.ts'), 'utf8');
    const indexSrc = readFileSync(resolve(ROOT, 'index.ts'), 'utf8');

    const synthesisPrompt = prompts.slice(
      prompts.indexOf('export const TOPIC_SYNTHESIS_PROMPT'),
      prompts.indexOf('export const HYPE_ASSESSMENT_PROMPT'),
    );
    expect(synthesisPrompt).toMatch(/agreements/);
    expect(synthesisPrompt).toMatch(/disagreements/);
    expect(synthesisPrompt).toMatch(/predictions/);
    expect(synthesisPrompt).toMatch(/synthesisNarrative/);
    expect(synthesisPrompt).not.toMatch(/keyAgreements/);
    expect(synthesisPrompt).not.toMatch(/keyDisagreements/);
    expect(synthesisPrompt).not.toMatch(/notablePredictions/);
    expect(synthesisPrompt).not.toMatch(/keyDebates/);

    const digestPrompt = prompts.slice(prompts.indexOf('export const DIGEST_PROMPT'));
    expect(digestPrompt).toMatch(/s\.predictions/);
    expect(digestPrompt).toMatch(/s\.disagreements/);
    expect(digestPrompt).not.toMatch(/notablePredictions/);
    expect(digestPrompt).not.toMatch(/keyDisagreements/);
    expect(digestPrompt).not.toMatch(/keyAgreements/);

    const hypePrompt = prompts.slice(
      prompts.indexOf('export const HYPE_ASSESSMENT_PROMPT'),
      prompts.indexOf('export const DIGEST_PROMPT'),
    );
    expect(hypePrompt).toMatch(/s\.disagreements/);
    expect(hypePrompt).not.toMatch(/keyDisagreements/);

    const synthesizeFn = wrapper.slice(
      wrapper.indexOf('async synthesize'),
      wrapper.indexOf('async generateDigest'),
    );
    expect(synthesizeFn).toMatch(/agreements/);
    expect(synthesizeFn).toMatch(/disagreements/);
    expect(synthesizeFn).toMatch(/predictions/);
    expect(synthesizeFn).toMatch(/synthesisNarrative/);
    expect(synthesizeFn).not.toMatch(/keyAgreements/);
    expect(synthesizeFn).not.toMatch(/notablePredictions/);

    expect(indexSrc).not.toMatch(/interface TopicSynthesis/);
    expect(indexSrc).toMatch(/topic-synthesis/);
  });
});

describe('packet 11B write boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('live agent parse stamps canonical schema and fails closed on garbage', async () => {
    const agent = new AIIntelAgent({ projectDir: '/test' });
    const runQuery = vi.spyOn(agent as any, 'runQuery');

    runQuery.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({
        labConsensus: 'Labs treat test-time compute as the next lever.',
        criticConsensus: 'Critics say evals are saturating.',
        agreements: ['Eval gaming is a real risk'],
        disagreements: [disagreement],
        emergingNarratives: ['test-time compute'],
        predictions: [prediction],
        evidenceQuality: 0.6,
        hypeDelta,
        synthesisNarrative: 'Labs push compute; critics push validity.',
      }),
    });

    const parsed = await agent.synthesize(
      [{ claimText: 'x', authorCategory: 'lab-researcher', bullishness: 0.7 }],
      'reasoning',
    );
    expect(TopicSynthesisSchema.parse(parsed).schemaVersion).toBe(1);
    expect(parsed.summary).toBe(parsed.synthesisNarrative);
    expect(parsed.topic).toBe('reasoning');

    runQuery.mockResolvedValueOnce({ success: true, output: 'NOT JSON {{{' });
    const garbage = await agent.synthesize([{ claimText: 'x' }], 'reasoning');
    expect(garbage.unsupported).toBe(true);
    expect(garbage.synthesisNarrative).toBe('');
    expect(garbage.summary).toBe('');
  });

  it('orchestrator writer + SynthesisStore persist canonical rows only', async () => {
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: true,
      agent: {
        filterContent: async () => ({ assessments: [] }),
        extractClaims: async () => ({ claims: [] }),
        synthesize: async () => ({}),
        useSkill: async () => ({}),
        generateDigest: async () => '# Weekly digest',
      } as never,
    });

    vi.spyOn((orch as any).claimStore, 'getRecent').mockResolvedValue([
      { topic: 'reasoning', claimText: 'bounded evals', authorCategory: 'lab-researcher' },
    ]);
    vi.spyOn((orch as any).agent, 'synthesize').mockResolvedValue({
      labConsensus: 'Labs treat test-time compute as the next lever.',
      criticConsensus: 'Critics say evals are saturating.',
      agreements: ['Eval gaming is a real risk'],
      disagreements: [disagreement],
      emergingNarratives: ['test-time compute'],
      predictions: [prediction],
      evidenceQuality: 0.6,
      hypeDelta,
      synthesisNarrative: 'Labs push compute; critics push validity.',
    });
    vi.spyOn((orch as any).agent, 'useSkill').mockResolvedValue({
      overhypedTopics: [],
      underhypedTopics: [],
      accuratelyAssessedTopics: [],
      overallFieldSentiment: 0.5,
      summary: 'aligned',
    });
    vi.spyOn((orch as any).agent, 'generateDigest').mockResolvedValue('# Weekly digest');

    const saved: unknown[] = [];
    vi.spyOn((orch as any).synthesisStore, 'save').mockImplementation(async (row: unknown) => {
      saved.push(row);
      return 11;
    });

    await orch.runSynthesis({ lookbackDays: 7, generateDigest: true });
    expect(saved).toHaveLength(1);
    const row = saved[0] as { syntheses: unknown[]; digest: unknown };
    const canonical = toCanonicalTopicSynthesis(row.syntheses[0]);
    expect(canonical.schemaVersion).toBe(1);
    expect(canonical.agreements).toEqual(['Eval gaming is a real risk']);
    expect(canonical.claimCount).toBe(1);
    expect(row.digest).toBe('# Weekly digest');

    const store = new SynthesisStore('postgresql://localhost/test');
    const query = ((store as any).pool.query as ReturnType<typeof vi.fn>);
    query.mockResolvedValueOnce({ rows: [{ id: 22 }] });
    await store.save(row as any);
    const params = query.mock.calls[0][1];
    const persisted = JSON.parse(params[2]);
    expect(persisted[0].schemaVersion).toBe(1);
    expect(persisted[0].agreements).toEqual(['Eval gaming is a real risk']);
    expect(persisted[0].keyAgreements).toBeUndefined();
  });
});

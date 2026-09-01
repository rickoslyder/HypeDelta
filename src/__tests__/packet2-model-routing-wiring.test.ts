/**
 * Packet 2: rewire live inference surfaces onto StageModelRouter.
 * All provider HTTP is injected; never contacts a live model.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg', () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
  const mockEnd = vi.fn().mockResolvedValue(undefined);
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: mockEnd,
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

import pg from 'pg';
import { ModelRoutingError } from '../model-routing';
import { AIIntelOrchestrator } from '../index';

const ROOT = resolve(__dirname, '../..');
const SRC = resolve(__dirname, '..');

const REQUIRED_ENV = {
  DEEPSEEK_API_KEY: 'ds-test-key',
  KIMI_CODING_API_KEY: 'kimi-test-key',
};

const STAGES = [
  'filter',
  'extraction',
  'synthesis',
  'hype_assessment',
  'digest',
  'quote_backfill',
] as const;

function canonicalSynthesis(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    topic: 'reasoning',
    claimCount: 1,
    labConsensus: 'Labs treat test-time compute as the next lever.',
    criticConsensus: 'Critics say evals are saturating.',
    agreements: ['Eval gaming is a real risk'],
    disagreements: [
      {
        point: 'Whether scaling alone leads to AGI',
        labPosition: 'Continued scaling yields AGI-like capabilities',
        criticPosition: 'Architectural changes needed beyond scaling',
      },
    ],
    emergingNarratives: ['test-time compute'],
    predictions: [
      {
        text: 'Reasoning evals keep climbing through 2027',
        author: 'fixture-lab',
        confidence: 0.7,
        timeframe: 'medium-term',
      },
    ],
    evidenceQuality: 0.6,
    hypeDelta: { delta: 0.2, labSentiment: 0.7, criticSentiment: 0.5, confidence: 0.6 },
    synthesisNarrative: 'Labs push compute; critics push validity.',
    summary: 'Labs push compute; critics push validity.',
    ...overrides,
  };
}

function canonicalHype(overrides: Record<string, unknown> = {}) {
  return {
    overhypedTopics: [
      {
        topic: 'agents',
        score: 0.6,
        reasoning: 'Lab claims outrun evidence.',
        keyEvidence: ['unreleased agent demos'],
      },
    ],
    underhypedTopics: [],
    accuratelyAssessedTopics: [
      {
        topic: 'reasoning',
        score: 0,
        reasoning: 'Views are aligned.',
        keyEvidence: ['shared eval caveats'],
      },
    ],
    overallFieldSentiment: 0.55,
    summary: 'Mixed field, agents overextended.',
    ...overrides,
  };
}

class FakeRouter {
  calls: Array<{ stage: string; request: { messages: Array<{ content: string }>; promptTemplateId: string; promptVersion: string } }> = [];
  byStage: Record<string, string> = {};
  throwFor = new Map<string, unknown>();

  async complete(
    stage: string,
    request: { messages: Array<{ role: string; content: string }>; promptTemplateId: string; promptVersion: string },
  ) {
    this.calls.push({ stage, request });
    if (this.throwFor.has(stage)) {
      throw this.throwFor.get(stage);
    }
    const content = this.byStage[stage];
    if (content == null) {
      throw new Error(`no fake response for ${stage}`);
    }
    return { content };
  }
}

function productionSources(): Record<string, string> {
  return {
    index: readFileSync(resolve(SRC, 'index.ts'), 'utf8'),
    cli: readFileSync(resolve(SRC, 'cli.ts'), 'utf8'),
    scheduler: readFileSync(resolve(SRC, 'scheduler.ts'), 'utf8'),
    quoteBackfill: readFileSync(resolve(SRC, 'quote-backfill.ts'), 'utf8'),
    modelRuntime: readFileSync(resolve(SRC, 'model-runtime.ts'), 'utf8'),
    pipelineAgent: readFileSync(resolve(SRC, 'pipeline-model-agent.ts'), 'utf8'),
  };
}

describe('packet 2 production composition has no Claude/GLM requirement', () => {
  it('CLI, scheduler, orchestrator, and quote-backfill production paths do not import Claude Agent SDK or GLM', () => {
    const srcs = productionSources();
    for (const [name, src] of Object.entries(srcs)) {
      expect(src, name).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
      expect(src, name).not.toMatch(/from ['"]\.\/agent-sdk-wrapper['"]/);
      expect(src, name).not.toMatch(/AIIntelAgent/);
      expect(src, name).not.toMatch(/GLMClient/);
      expect(src, name).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
      expect(src, name).not.toMatch(/GLM_API_KEY/);
      expect(src, name).not.toMatch(/glmFallback/);
    }
  });

  it('createProductionModelRuntime builds exactly one store + router from the explicit env object', async () => {
    const { createProductionModelRuntime, productionModelEnv } = await import('../model-runtime');
    const { PostgresModelAttemptStore } = await import('../model-attempt-ledger');
    const { StageModelRouter } = await import('../model-routing');
    const { PipelineModelAgent } = await import('../pipeline-model-agent');

    const env = productionModelEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
      GLM_API_KEY: 'glm-key',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:4150',
      KIMI_CODING_BASE_URL: 'http://127.0.0.1:4151/coding/v1',
      UNRELATED: 'ignore-me',
    });
    expect(env).toEqual({
      DEEPSEEK_API_KEY: REQUIRED_ENV.DEEPSEEK_API_KEY,
      KIMI_CODING_API_KEY: REQUIRED_ENV.KIMI_CODING_API_KEY,
    });
    expect(Object.keys(env).sort()).toEqual(['DEEPSEEK_API_KEY', 'KIMI_CODING_API_KEY']);
    expect(env).not.toHaveProperty('DEEPSEEK_BASE_URL');
    expect(env).not.toHaveProperty('KIMI_CODING_BASE_URL');

    const runtime = createProductionModelRuntime({
      env,
      dbUrl: 'postgresql://localhost/test',
    });
    expect(runtime.store).toBeInstanceOf(PostgresModelAttemptStore);
    expect(runtime.router).toBeInstanceOf(StageModelRouter);
    expect(runtime.agent).toBeInstanceOf(PipelineModelAgent);

    const runtimeSrc = readFileSync(resolve(SRC, 'model-runtime.ts'), 'utf8');
    expect(runtimeSrc).toMatch(/new PostgresModelAttemptStore/);
    expect(runtimeSrc).toMatch(/new StageModelRouter/);
    expect(runtimeSrc).not.toMatch(/new PostgresModelAttemptStore[\s\S]*new PostgresModelAttemptStore/);
    expect(runtimeSrc).not.toMatch(/new StageModelRouter[\s\S]*new StageModelRouter/);
  });

  it('CLI and scheduler composition roots construct the runtime once and inject it', () => {
    const cli = readFileSync(resolve(SRC, 'cli.ts'), 'utf8');
    const scheduler = readFileSync(resolve(SRC, 'scheduler.ts'), 'utf8');
    expect(cli).toMatch(/createProductionModelRuntime/);
    expect(cli).toMatch(/productionModelEnv/);
    expect(cli).not.toMatch(/new AIIntelOrchestrator\(\s*config\s*\)/);
    expect(scheduler).toMatch(/createProductionModelRuntime/);
    expect(scheduler).toMatch(/productionModelEnv/);
    expect(scheduler).toMatch(/isMainModule/);
    const main = scheduler.slice(scheduler.indexOf('if (isMainModule())'));
    expect(main).toMatch(/createProductionModelRuntime/);
    expect(main).toMatch(/modelAttemptStore/);
    expect(main).not.toMatch(/new AIIntelOrchestrator\(\s*baseConfig\s*\)/);
  });
});

describe('packet 2 all six stages route through StageModelRouter', () => {
  it('PipelineModelAgent convenience methods hit the pinned stages with prompt versions', async () => {
    const { PipelineModelAgent, STAGE_PROMPT_VERSIONS } = await import('../pipeline-model-agent');
    const router = new FakeRouter();
    router.byStage.filter = JSON.stringify({
      assessments: [
        {
          idx: 0,
          relevance: 0.9,
          topic: 'reasoning',
          contentType: 'opinion',
          authorCategory: 'lab-researcher',
          isSubstantive: true,
          brief: 'ok',
        },
      ],
    });
    router.byStage.extraction = JSON.stringify({
      claims: [
        {
          contentId: 11,
          claimText: 'Eval gains remain bounded',
          originalQuote: 'Labs report bounded eval gains',
        },
      ],
    });
    router.byStage.synthesis = JSON.stringify(canonicalSynthesis());
    router.byStage.hype_assessment = JSON.stringify(canonicalHype());
    router.byStage.digest = '# Weekly digest\n\nSignal, not noise.';
    router.byStage.quote_backfill = JSON.stringify([{ claimId: 'c1', originalQuote: 'exact span' }]);

    const agent = new PipelineModelAgent({ router: router as never });

    await agent.filterContent([
      { id: 11, author: 'lab', content: 'Labs report bounded eval gains on reasoning suites. more text here.' },
    ]);
    await agent.extractClaims([
      { id: 11, author: 'lab', content: 'Labs report bounded eval gains on reasoning suites. more text here.', topic: 'reasoning' },
    ]);
    await agent.synthesize(
      [{ claimText: 'x', authorCategory: 'lab-researcher', bullishness: 0.7 }],
      'reasoning',
    );
    await agent.useSkill('hype-assessment', { syntheses: [canonicalSynthesis()] });
    await agent.generateDigest([canonicalSynthesis()], canonicalHype());

    const { createRouterQuoteRecoverer } = await import('../quote-backfill');
    const recoverer = createRouterQuoteRecoverer(router as never);
    await recoverer.recoverQuotesJson({
      contentId: 11,
      contentText: 'Labs report bounded eval gains on reasoning suites.',
      claims: [{ claimId: 'c1', claimText: 'Eval gains remain bounded' }],
    });

    const stages = router.calls.map((c) => c.stage);
    expect(stages).toEqual([...STAGES]);
    for (const call of router.calls) {
      expect(call.request.promptTemplateId).toBe(call.stage);
      expect(call.request.promptVersion).toBe(STAGE_PROMPT_VERSIONS[call.stage as keyof typeof STAGE_PROMPT_VERSIONS]);
      expect(call.request.promptVersion).toMatch(/\S/);
      expect(call.request.messages[0]?.content.length).toBeGreaterThan(0);
    }
    expect(STAGE_PROMPT_VERSIONS).toMatchObject({
      filter: expect.any(String),
      extraction: expect.any(String),
      synthesis: expect.any(String),
      hype_assessment: expect.any(String),
      digest: expect.any(String),
      quote_backfill: expect.any(String),
    });
  });
});

describe('packet 2 filter failure leaves content retryable', () => {
  it('does not call storeResults when filter model/parse/schema/provider fails', async () => {
    const router = new FakeRouter();
    router.throwFor.set('filter', new ModelRoutingError('provider'));
    const { PipelineModelAgent } = await import('../pipeline-model-agent');
    const agent = new PipelineModelAgent({ router: router as never });
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      agent,
    });
    const storeSpy = vi.spyOn(orch as never, 'storeResults');
    const markSpy = vi.spyOn(orch.contentStore, 'markProcessed');

    await expect(
      orch.processBatch([
        {
          id: 41,
          source: 'twitter',
          sourceType: 'twitter',
          author: 'fixture',
          content: 'AI reasoning capabilities are improving rapidly and substantively enough',
          publishedAt: new Date('2026-08-01T00:00:00Z'),
          sourceId: 1,
          url: 'https://example.test/post/41',
        } as never,
      ]),
    ).rejects.toMatchObject({ errorClass: 'provider' });

    expect(storeSpy).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
  });

  it('throws on filter schema failure instead of marking processed', async () => {
    const router = new FakeRouter();
    router.byStage.filter = JSON.stringify({ assessments: 'nope' });
    const { PipelineModelAgent } = await import('../pipeline-model-agent');
    const agent = new PipelineModelAgent({ router: router as never });
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      agent,
    });
    const storeSpy = vi.spyOn(orch as never, 'storeResults');

    await expect(
      orch.processBatch([
        {
          id: 42,
          source: 'twitter',
          sourceType: 'twitter',
          author: 'fixture',
          content: 'AI reasoning capabilities are improving rapidly and substantively enough',
          publishedAt: new Date('2026-08-01T00:00:00Z'),
          sourceId: 1,
        } as never,
      ]),
    ).rejects.toMatchObject({ errorClass: 'schema' });
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe('packet 2 synthesis/hype/digest fail closed', () => {
  it('does not persist coerced empty success when synthesis schema fails', async () => {
    const { PipelineModelAgent } = await import('../pipeline-model-agent');
    const router = new FakeRouter();
    router.byStage.synthesis = JSON.stringify({ garbage: true });
    const agent = new PipelineModelAgent({ router: router as never });
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      agent,
    });
    vi.spyOn(orch.claimStore, 'getRecent').mockResolvedValue([
      { topic: 'reasoning', claimText: 'bounded evals', authorCategory: 'lab-researcher' },
    ] as never);
    const save = vi.spyOn(orch.synthesisStore, 'save').mockResolvedValue(1 as never);

    await expect(orch.runSynthesis({ lookbackDays: 7, generateDigest: false })).rejects.toMatchObject({
      errorClass: 'schema',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('does not persist coerced empty success when hype schema fails', async () => {
    const { PipelineModelAgent } = await import('../pipeline-model-agent');
    const router = new FakeRouter();
    router.byStage.synthesis = JSON.stringify(canonicalSynthesis());
    router.byStage.hype_assessment = JSON.stringify({ summary: 12 });
    const agent = new PipelineModelAgent({ router: router as never });
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      agent,
    });
    vi.spyOn(orch.claimStore, 'getRecent').mockResolvedValue([
      { topic: 'reasoning', claimText: 'bounded evals', authorCategory: 'lab-researcher' },
    ] as never);
    const save = vi.spyOn(orch.synthesisStore, 'save').mockResolvedValue(1 as never);

    await expect(orch.runSynthesis({ lookbackDays: 7, generateDigest: false })).rejects.toMatchObject({
      errorClass: 'schema',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects blank digest instead of saving empty markdown', async () => {
    const { PipelineModelAgent } = await import('../pipeline-model-agent');
    const router = new FakeRouter();
    router.byStage.synthesis = JSON.stringify(canonicalSynthesis());
    router.byStage.hype_assessment = JSON.stringify(canonicalHype());
    router.byStage.digest = '   \n';
    const agent = new PipelineModelAgent({ router: router as never });
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      agent,
    });
    vi.spyOn(orch.claimStore, 'getRecent').mockResolvedValue([
      { topic: 'reasoning', claimText: 'bounded evals', authorCategory: 'lab-researcher' },
    ] as never);
    const save = vi.spyOn(orch.synthesisStore, 'save').mockResolvedValue(1 as never);

    await expect(orch.runSynthesis({ lookbackDays: 7, generateDigest: true })).rejects.toThrow(/digest|markdown|blank|empty/i);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('packet 2 quote backfill execute never constructs AIIntelAgent', () => {
  it('createRouterQuoteRecoverer routes quote_backfill and execute mode does not import the legacy agent', async () => {
    const src = readFileSync(resolve(SRC, 'quote-backfill.ts'), 'utf8');
    expect(src).toMatch(/export function createRouterQuoteRecoverer/);
    expect(src).not.toMatch(/new AIIntelAgent/);
    expect(src).not.toMatch(/createAgentQuoteRecoverer/);
    expect(src.slice(src.indexOf('export async function runQuoteBackfillCommand'))).toMatch(/createRouterQuoteRecoverer/);

    const router = new FakeRouter();
    router.byStage.quote_backfill = '[]';
    const { createRouterQuoteRecoverer } = await import('../quote-backfill');
    const recoverer = createRouterQuoteRecoverer(router as never);
    const raw = await recoverer.recoverQuotesJson({
      contentId: 1,
      contentText: 'hello',
      claims: [{ claimId: 'c1', claimText: 'hello' }],
    });
    expect(raw).toBe('[]');
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0].stage).toBe('quote_backfill');
  });
});

describe('packet 2 close lifecycle', () => {
  it('PostgresModelAttemptStore.close ends the pool', async () => {
    const { PostgresModelAttemptStore } = await import('../model-attempt-ledger');
    const store = new PostgresModelAttemptStore('postgresql://localhost/test');
    const pool = new pg.Pool({ connectionString: 'mock://test' });
    await store.close();
    expect(pool.end).toHaveBeenCalled();
  });

  it('orchestrator.close also closes an injected model attempt store', async () => {
    const { PipelineModelAgent } = await import('../pipeline-model-agent');
    const router = new FakeRouter();
    const agent = new PipelineModelAgent({ router: router as never });
    const modelAttemptStore = { close: vi.fn().mockResolvedValue(undefined) };
    const orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      agent,
      modelAttemptStore,
    });
    vi.spyOn(orch.contentStore, 'close').mockResolvedValue(undefined);
    vi.spyOn(orch.claimStore, 'close').mockResolvedValue(undefined);
    vi.spyOn(orch.synthesisStore, 'close').mockResolvedValue(undefined);
    await orch.close();
    expect(modelAttemptStore.close).toHaveBeenCalledTimes(1);
  });

  it('scheduler.stop closes the injected modelAttemptStore', async () => {
    const { AIIntelScheduler } = await import('../scheduler');
    const modelAttemptStore = { close: vi.fn().mockResolvedValue(undefined) };
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      orchestrator: {
        initialize: vi.fn(),
        processBatch: vi.fn(),
        runSynthesis: vi.fn(),
        close: vi.fn(),
      } as never,
      fetcher: { fetchSources: vi.fn(), close: vi.fn() } as never,
      sourceStore: { getByType: vi.fn(), getDueForFetch: vi.fn(), close: vi.fn() } as never,
      contentStore: { getUnprocessed: vi.fn(), close: vi.fn() } as never,
      modelAttemptStore,
      exitFn: vi.fn(),
      setIntervalFn: vi.fn(() => ({}) as NodeJS.Timeout) as unknown as typeof setInterval,
      setTimeoutFn: vi.fn(() => ({}) as NodeJS.Timeout) as unknown as typeof setTimeout,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
      clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout,
    });
    await scheduler.stop();
    expect(modelAttemptStore.close).toHaveBeenCalledTimes(1);
  });
});

describe('packet 2 bounded scope', () => {
  it('does not require web status, compose, Dockerfiles, or vault template edits', () => {
    expect(readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8')).toMatch(/PipelineModelAgent|agent:/);
  });
});

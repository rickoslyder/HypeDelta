/**
 * CLI resource-lifecycle tests.
 *
 * Bounded commands must close every store/fetcher/orchestrator they create
 * on success, early return, and thrown failure. A leftover unclosed handle
 * is the production hang (idle pg Pool).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Closeable = { close: ReturnType<typeof vi.fn> };

const created = vi.hoisted(() => ({
  fetchers: [] as Array<Closeable & { fetchSources: ReturnType<typeof vi.fn> }>,
  sourceStores: [] as Array<Closeable & {
    getByType: ReturnType<typeof vi.fn>;
    getDueForFetch: ReturnType<typeof vi.fn>;
    getActive: ReturnType<typeof vi.fn>;
  }>,
  contentStores: [] as Array<Closeable & {
    getUnprocessed: ReturnType<typeof vi.fn>;
    getRecent: ReturnType<typeof vi.fn>;
  }>,
  orchestrators: [] as Array<Closeable & {
    processBatch: ReturnType<typeof vi.fn>;
    runSynthesis: ReturnType<typeof vi.fn>;
    initialize: ReturnType<typeof vi.fn>;
  }>,
  claimStores: [] as Closeable[],
  synthesisStores: [] as Array<Closeable & { getLatest: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> }>,
  predictionTrackers: [] as Closeable[],
  attemptStores: [] as Closeable[],
  modelStores: [] as Closeable[],
}));

vi.mock('../fetcher', () => ({
  AIIntelFetcher: vi.fn().mockImplementation(() => {
    const instance = {
      fetchSources: vi.fn().mockResolvedValue({
        successful: [{ source: 'example.substack.com', count: 2 }],
        failed: [],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.fetchers.push(instance);
    return instance;
  }),
  seedSources: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../index', () => ({
  AIIntelOrchestrator: vi.fn().mockImplementation(() => {
    const instance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      processBatch: vi.fn().mockResolvedValue({
        processed: 3,
        relevant: 2,
        claimsExtracted: 4,
      }),
      runSynthesis: vi.fn().mockResolvedValue({
        syntheses: [{ topic: 'reasoning' }],
        hypeAssessment: {
          overallFieldSentiment: 0.4,
          overhypedTopics: [],
          underhypedTopics: [],
        },
        digest: null,
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.orchestrators.push(instance);
    return instance;
  }),
}));

vi.mock('../pipeline-ledger', () => ({
  SourceFetchAttemptStore: vi.fn().mockImplementation(() => {
    const instance = {
      record: vi.fn().mockResolvedValue(1),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.attemptStores.push(instance);
    return instance;
  }),
  PipelineRunStore: vi.fn().mockImplementation(() => {
    throw new Error('PipelineRunStore must not be constructed in CLI tests');
  }),
}));

vi.mock('../model-runtime', () => ({
  productionModelEnv: vi.fn((env: unknown) => env),
  createProductionModelRuntime: vi.fn(() => {
    const store = {
      close: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(1),
    };
    created.modelStores.push(store);
    return {
      store,
      router: { complete: vi.fn() },
      agent: {},
    };
  }),
}));

vi.mock('../storage', () => ({
  initializeDatabase: vi.fn().mockResolvedValue(undefined),
  SourceStore: vi.fn().mockImplementation(() => {
    const instance = {
      getByType: vi.fn().mockResolvedValue([
        { id: 1, type: 'substack', identifier: 'example.substack.com' },
      ]),
      getDueForFetch: vi.fn().mockResolvedValue([]),
      getActive: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.sourceStores.push(instance);
    return instance;
  }),
  ContentStore: vi.fn().mockImplementation(() => {
    const instance = {
      getUnprocessed: vi.fn().mockResolvedValue([]),
      getRecent: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.contentStores.push(instance);
    return instance;
  }),
  ClaimStore: vi.fn().mockImplementation(() => {
    const instance = {
      getByTopic: vi.fn().mockResolvedValue([]),
      getByAuthorCategory: vi.fn().mockResolvedValue([]),
      getRecent: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.claimStores.push(instance);
    return instance;
  }),
  SynthesisStore: vi.fn().mockImplementation(() => {
    const instance = {
      getLatest: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.synthesisStores.push(instance);
    return instance;
  }),
  PredictionTracker: vi.fn().mockImplementation(() => {
    const instance = {
      getAccuracyStats: vi.fn().mockResolvedValue({
        total: 0, verified: 0, falsified: 0, pending: 0, averageAccuracy: 0,
      }),
      getPending: vi.fn().mockResolvedValue([]),
      getByAuthor: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    created.predictionTrackers.push(instance);
    return instance;
  }),
}));

function resetCreated() {
  created.fetchers.length = 0;
  created.sourceStores.length = 0;
  created.contentStores.length = 0;
  created.orchestrators.length = 0;
  created.claimStores.length = 0;
  created.synthesisStores.length = 0;
  created.predictionTrackers.length = 0;
  created.attemptStores.length = 0;
  created.modelStores.length = 0;
}

function allCreated(): Closeable[] {
  return [
    ...created.fetchers,
    ...created.sourceStores,
    ...created.contentStores,
    ...created.orchestrators,
    ...created.claimStores,
    ...created.synthesisStores,
    ...created.predictionTrackers,
    ...created.attemptStores,
    ...created.modelStores,
  ];
}

function expectAllOwnedClosedOnce() {
  const bags = allCreated();
  expect(bags.length, 'command created no closeable resources').toBeGreaterThan(0);
  for (const inst of bags) {
    expect(
      inst.close,
      'command action left an owned store/fetcher/orchestrator unclosed',
    ).toHaveBeenCalledTimes(1);
  }
}

const argv = (...args: string[]) => ['node', 'ai-intel', ...args];

describe('CLI command resource lifecycle', () => {
  let runCli: (argv?: string[]) => Promise<void>;
  let logSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
  let errorSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
  let exitSpy: { mockRestore: () => void; mock: { calls: unknown[][] } };

  beforeEach(async () => {
    resetCreated();
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const mod = await import('../cli');
    runCli = (mod as { runCli: (argv?: string[]) => Promise<void> }).runCli;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exports runCli and does not auto-parse on import', () => {
    expect(typeof runCli).toBe('function');
    expect(created.fetchers).toHaveLength(0);
    expect(created.sourceStores).toHaveLength(0);
    expect(created.orchestrators).toHaveLength(0);
  });

  it('fetch success closes fetcher, source store, and attempt store without process.exit', async () => {
    await runCli(argv('fetch', '--source', 'substack'));

    const output = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(output).toMatch(/Fetch Results/);
    expect(output).toMatch(/success-empty|success-items|Fetched:/);
    expect(created.fetchers).toHaveLength(1);
    expect(created.sourceStores).toHaveLength(1);
    expect(created.attemptStores).toHaveLength(1);
    expect(created.fetchers[0].fetchSources).toHaveBeenCalledTimes(1);
    expectAllOwnedClosedOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fetch failure still closes owned fetcher and source store', async () => {
    // Constructor runs during the action; stub after first construction via mockImplementationOnce
    // is brittle. Instead reject from getByType on the instance created in-action.
    const sourceMod = await import('../storage');
    (sourceMod.SourceStore as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const instance = {
        getByType: vi.fn().mockRejectedValue(new Error('source lookup failed')),
        getDueForFetch: vi.fn(),
        getActive: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      created.sourceStores.push(instance);
      return instance;
    });

    await expect(runCli(argv('fetch', '--source', 'blog'))).rejects.toThrow('source lookup failed');

    expect(created.fetchers).toHaveLength(1);
    expect(created.sourceStores).toHaveLength(1);
    expect(created.attemptStores).toHaveLength(1);
    expectAllOwnedClosedOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fetch does not print raw failed errors or secrets', async () => {
    const fetcherMod = await import('../fetcher');
    (fetcherMod.AIIntelFetcher as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const instance = {
        fetchSources: vi.fn().mockResolvedValue({
          successful: [],
          failed: [{
            source: 'karpathy',
            errorClass: 'dns',
            reason: 'getaddrinfo ENOTFOUND',
          }],
          summary: {
            successEmpty: 0,
            successItems: 0,
            failed: 1,
            persistedRows: 0,
            failuresByClass: { dns: 1 },
            skippedCircuit: 0,
          },
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      created.fetchers.push(instance);
      return instance;
    });

    await runCli(argv('fetch', '--source', 'twitter'));

    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
    expect(output).toMatch(/failed/i);
    expect(output).not.toMatch(/getaddrinfo ENOTFOUND|secret-token|raw-response-body|Bearer |TWITTER_API_KEY=/);
    expect(created.attemptStores).toHaveLength(1);
    expectAllOwnedClosedOnce();
  });

  it('process early-return closes orchestrator and content store', async () => {
    await runCli(argv('process', '--days', '1', '--limit', '10'));

    const output = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(output).toMatch(/No unprocessed content found/);
    expect(created.orchestrators).toHaveLength(1);
    expect(created.contentStores).toHaveLength(1);
    expect(created.orchestrators[0].processBatch).not.toHaveBeenCalled();
    expectAllOwnedClosedOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('process success closes orchestrator and content store', async () => {
    const storageMod = await import('../storage');
    (storageMod.ContentStore as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const instance = {
        getUnprocessed: vi.fn().mockResolvedValue([
          { id: 11, content_text: 'substantive item about reasoning at length' },
        ]),
        getRecent: vi.fn().mockResolvedValue([]),
        close: vi.fn().mockResolvedValue(undefined),
      };
      created.contentStores.push(instance);
      return instance;
    });

    await runCli(argv('process', '--days', '2', '--limit', '5'));

    const output = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(output).toMatch(/Processing Results/);
    expect(created.orchestrators).toHaveLength(1);
    expect(created.contentStores).toHaveLength(1);
    expect(created.orchestrators[0].processBatch).toHaveBeenCalledTimes(1);
    expectAllOwnedClosedOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('synthesize closes orchestrator after printing results', async () => {
    await runCli(argv('synthesize', '--days', '7', '--no-digest'));

    const output = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(output).toMatch(/Synthesis Results/);
    expect(created.orchestrators).toHaveLength(1);
    expect(created.orchestrators[0].runSynthesis).toHaveBeenCalledTimes(1);
    expectAllOwnedClosedOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

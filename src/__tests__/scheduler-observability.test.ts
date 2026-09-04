/**
 * Packet 12B: scheduler heartbeat lifecycle + pipeline_runs receipts.
 * Fetch result semantics are out of scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockGetUnprocessed = vi.fn();
const mockProcessBatch = vi.fn();
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockRunSynthesis = vi.fn().mockResolvedValue({ syntheses: [], digest: null });
const mockFetchSources = vi.fn().mockResolvedValue({ successful: [], failed: [] });
const mockGetDueForFetch = vi.fn().mockResolvedValue([]);
const mockGetByType = vi.fn().mockResolvedValue([]);

vi.mock('../index', () => ({
  AIIntelOrchestrator: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    processBatch: mockProcessBatch,
    runSynthesis: mockRunSynthesis,
  })),
}));

vi.mock('../fetcher', () => ({
  AIIntelFetcher: vi.fn().mockImplementation(() => ({
    fetchSources: mockFetchSources,
  })),
}));

vi.mock('../storage', () => ({
  initializeDatabase: vi.fn().mockResolvedValue(undefined),
  SourceStore: vi.fn().mockImplementation(() => ({
    getDueForFetch: mockGetDueForFetch,
    getByType: mockGetByType,
  })),
  ContentStore: vi.fn().mockImplementation(() => ({
    getUnprocessed: mockGetUnprocessed,
    getRecent: vi.fn(),
  })),
}));

const PipelineRunStoreCtor = vi.fn();

vi.mock('../pipeline-ledger', () => ({
  PipelineRunStore: function MockPipelineRunStore(...args: unknown[]) {
    PipelineRunStoreCtor(...args);
    throw new Error('PipelineRunStore must not be constructed in tests');
  },
}));

function timerDeps() {
  type TimerCb = (...args: unknown[]) => void;
  const setIntervalFn = vi.fn((cb: TimerCb, _ms?: number) => {
    return { kind: 'interval' } as unknown as NodeJS.Timeout;
  });
  const setTimeoutFn = vi.fn((cb: TimerCb, _ms?: number) => {
    return { kind: 'timeout' } as unknown as NodeJS.Timeout;
  });
  return {
    setIntervalFn: setIntervalFn as unknown as typeof setInterval,
    setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout,
  };
}

function readHeartbeat(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function parseCompletionLines(calls: unknown[][]): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const call of calls) {
    if (call.length !== 1 || typeof call[0] !== 'string') continue;
    try {
      const parsed = JSON.parse(call[0]) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.task === 'string' &&
        typeof parsed.ok === 'boolean' &&
        'error_class' in parsed &&
        typeof parsed.duration_ms === 'number' &&
        parsed.counts &&
        typeof parsed.counts === 'object'
      ) {
        lines.push(parsed);
      }
    } catch {
      // not a completion line
    }
  }
  return lines;
}

describe('scheduler observability (12B)', () => {
  let dir: string;
  let hbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    PipelineRunStoreCtor.mockClear();
    process.env = { ...originalEnv };
    delete process.env.WORKER_RUN_INITIAL_CYCLE;
    dir = mkdtempSync(join(tmpdir(), 'hd-obs-'));
    hbPath = join(dir, 'heartbeat.json');
    mockGetUnprocessed.mockResolvedValue([]);
    mockProcessBatch.mockResolvedValue({ processed: 0, relevant: 0, claimsExtracted: 0 });
    mockGetDueForFetch.mockResolvedValue([]);
    mockGetByType.mockResolvedValue([]);
    mockFetchSources.mockResolvedValue({ successful: [], failed: [] });
    mockInitialize.mockResolvedValue(undefined);
    mockRunSynthesis.mockResolvedValue({ syntheses: [], digest: null });
    const storage = await import('../storage');
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockReset();
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not construct PipelineRunStore from the scheduler constructor', async () => {
    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({ autoStart: false, ...timerDeps() });
    expect(scheduler).toBeDefined();
    expect(PipelineRunStoreCtor).not.toHaveBeenCalled();
  });

  it('writes starting heartbeat before init and running only after DB+orchestrator init', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const storage = await import('../storage');
    const statuses: string[] = [];

    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      statuses.push(`migrate:${readHeartbeat(hbPath).status}`);
    });
    mockInitialize.mockImplementation(async () => {
      statuses.push(`orch:${readHeartbeat(hbPath).status}`);
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      runInitialCycle: false,
      pipelineRunStore: { record: vi.fn().mockResolvedValue(1) },
      ...timerDeps(),
    });
    await scheduler.start();

    expect(statuses).toEqual(['migrate:starting', 'orch:starting']);
    expect(readHeartbeat(hbPath).status).toBe('running');
    logSpy.mockRestore();
  });

  it('on init failure writes failed heartbeat, best-effort startup receipt, then throws', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const initErr = Object.assign(
      new Error('password authentication failed postgresql://secret:pass@localhost/db token=abc'),
      { code: '28P01' },
    );
    const storage = await import('../storage');
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(initErr);

    const record = vi.fn().mockResolvedValue(1);
    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      runInitialCycle: false,
      pipelineRunStore: { record },
      ...timerDeps(),
    });

    await expect(scheduler.start()).rejects.toBe(initErr);

    const hb = readHeartbeat(hbPath);
    expect(hb.status).toBe('failed');
    expect(hb.error_class).toBe('database');
    expect(record).toHaveBeenCalledTimes(1);
    const receipt = record.mock.calls[0][0] as {
      taskName: string;
      ok: boolean;
      error: unknown;
      startedAt: Date;
      finishedAt: Date;
    };
    expect(receipt.taskName).toBe('startup');
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toBe(initErr);
    expect(receipt.startedAt).toBeInstanceOf(Date);
    expect(receipt.finishedAt).toBeInstanceOf(Date);

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(logged).not.toMatch(/postgresql:\/\/secret|token=abc|password authentication/i);
    expect(mockInitialize).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('records exactly one receipt per executed runTask; overlap skip records none', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = vi.fn().mockResolvedValue(1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGetUnprocessed.mockResolvedValue([{ id: 1 }]);
    mockProcessBatch.mockImplementation(async () => {
      await gate;
      return { processed: 1, relevant: 1, claimsExtracted: 2 };
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      pipelineRunStore: { record },
      ...timerDeps(),
    });

    const first = (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    const skipped = (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    await skipped;
    expect(record).not.toHaveBeenCalled();
    release();
    await first;

    expect(mockProcessBatch).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      taskName: 'processing',
      ok: true,
      counts: { processed: 1, relevant: 1, claimsExtracted: 2 },
    });

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('success/failure update heartbeat and emit one bounded completion JSON line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = vi.fn().mockResolvedValue(1);
    mockGetDueForFetch.mockResolvedValue([]);
    mockFetchSources.mockResolvedValue({ successful: [], failed: [] });
    mockGetUnprocessed.mockResolvedValue([{ id: 1 }]);
    mockProcessBatch.mockRejectedValueOnce(
      new Error('DATABASE_URL=secret://leak prompt=SYSTEM token=abc body={"x":1}'),
    );

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      runInitialCycle: false,
      pipelineRunStore: { record },
      ...timerDeps(),
    });
    await scheduler.start();

    await (scheduler as any).runTask('fetch-all', () => (scheduler as any).runAllFetches());
    const afterFetch = readHeartbeat(hbPath);
    expect(afterFetch.last_success_at).toEqual(expect.any(String));
    expect(afterFetch.last_fetch_success_at).toEqual(afterFetch.last_success_at);
    expect(afterFetch.last_task).toBe('fetch-all');
    expect(afterFetch.consecutive_failures).toBe(0);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      taskName: 'fetch-all',
      ok: true,
      counts: { fetched: 0, failed: 0 },
    });

    await (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    const afterFail = readHeartbeat(hbPath);
    expect(afterFail.last_fetch_success_at).toEqual(afterFetch.last_fetch_success_at);
    expect(afterFail.consecutive_failures).toBe(1);
    expect(afterFail.last_task).toBe('processing');
    expect(afterFail.error_class).toBe('internal');
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1][0].ok).toBe(false);
    expect(record.mock.calls[1][0].error).toBeInstanceOf(Error);

    const completions = parseCompletionLines(logSpy.mock.calls);
    expect(completions).toHaveLength(2);
    expect(completions[0]).toMatchObject({
      task: 'fetch-all',
      ok: true,
      error_class: null,
      counts: { fetched: 0, failed: 0 },
    });
    expect(completions[1]).toMatchObject({
      task: 'processing',
      ok: false,
      error_class: 'internal',
    });
    expect(typeof completions[0].duration_ms).toBe('number');
    expect(completions[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(completions[1]).not.toHaveProperty('error');
    const dumped = JSON.stringify(completions);
    expect(dumped).not.toMatch(/secret:\/\/leak|DATABASE_URL|token=abc|prompt=SYSTEM|content body/i);

    const errLogged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errLogged).toMatch(/processing/i);
    expect(errLogged).not.toMatch(/secret:\/\/leak|DATABASE_URL|token=abc/i);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('returns bounded counts from processing/synthesis/digest without changing fetch results', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const record = vi.fn().mockResolvedValue(1);
    mockGetUnprocessed.mockResolvedValue([]);
    mockRunSynthesis
      .mockResolvedValueOnce({ syntheses: [{ topic: 'a' }, { topic: 'b' }], digest: null })
      .mockResolvedValueOnce({ syntheses: [{ topic: 'a' }], digest: '# weekly' });
    const fetchResult = { successful: [{ id: 1 }], failed: [{ source: 'x' }] };
    mockFetchSources.mockResolvedValue(fetchResult);

    const { AIIntelScheduler } = await import('../scheduler');
    const digestDir = join(dir, 'digests');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      pipelineRunStore: { record },
      digestDir,
      ...timerDeps(),
    });

    const fetchCounts = await (scheduler as any).runFetch('twitter');
    expect(fetchCounts).toMatchObject({
      ok: true,
      counts: expect.objectContaining({ fetched: 1, failed: 1 }),
    });
    expect(mockFetchSources).toHaveBeenCalledTimes(1);

    const emptyProcess = await (scheduler as any).runProcessing();
    expect(emptyProcess).toEqual({ processed: 0, relevant: 0, claimsExtracted: 0 });
    expect(mockProcessBatch).not.toHaveBeenCalled();

    const synth = await (scheduler as any).runSynthesis();
    expect(synth).toEqual({ topics: 2 });

    const digest = await (scheduler as any).runWeeklyDigest();
    expect(digest).toMatchObject({ topics: 1, digestWritten: true });
    const written = readdirSync(digestDir).filter((name) => name.endsWith('.md'));
    expect(written).toHaveLength(1);
    expect(readFileSync(join(digestDir, written[0]), 'utf8')).toBe('# weekly');
    expect(existsSync(join(process.cwd(), 'data/digests', written[0]))).toBe(false);

    logSpy.mockRestore();
  });

  it('isolates pipelineRunStore.record failures so later ticks still run', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('insert failed postgresql://secret'))
      .mockResolvedValueOnce(1);
    mockGetUnprocessed.mockResolvedValue([{ id: 1 }]);
    mockProcessBatch.mockResolvedValue({ processed: 1, relevant: 0, claimsExtracted: 0 });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      pipelineRunStore: { record },
      ...timerDeps(),
    });

    await (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    await (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());

    expect(mockProcessBatch).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toMatch(/postgresql:\/\/secret/i);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('packet 12C1 scheduler fetch outcomes', () => {
  let dir: string;
  let hbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    PipelineRunStoreCtor.mockClear();
    process.env = { ...originalEnv };
    delete process.env.WORKER_RUN_INITIAL_CYCLE;
    dir = mkdtempSync(join(tmpdir(), 'hd-12c1-'));
    hbPath = join(dir, 'heartbeat.json');
    mockGetUnprocessed.mockResolvedValue([]);
    mockGetDueForFetch.mockResolvedValue([]);
    mockGetByType.mockResolvedValue([]);
    mockFetchSources.mockResolvedValue({ successful: [], failed: [] });
    mockInitialize.mockResolvedValue(undefined);
    const storage = await import('../storage');
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockReset();
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('all-source failure is pipeline ok=false, does not update last_fetch_success_at, preserves counts/error class', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = vi.fn().mockResolvedValue(1);
    mockGetDueForFetch.mockResolvedValue([{ id: 1, type: 'twitter', identifier: 'karpathy' }]);
    mockFetchSources.mockResolvedValue({
      successful: [],
      failed: [{ source: 'karpathy', errorClass: 'dns', reason: 'getaddrinfo ENOTFOUND api.twitterapi.io' }],
      outcomes: [{
        kind: 'failure',
        source: 'karpathy',
        sourceId: 1,
        persisted: 0,
        errorClass: 'dns',
        reason: 'getaddrinfo ENOTFOUND api.twitterapi.io',
      }],
      summary: {
        successEmpty: 0,
        successItems: 0,
        failed: 1,
        persistedRows: 0,
        failuresByClass: { dns: 1 },
        skippedCircuit: 0,
      },
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      runInitialCycle: false,
      pipelineRunStore: { record },
      ...timerDeps(),
    });
    await scheduler.start();
    const before = readHeartbeat(hbPath);
    expect(before.last_fetch_success_at).toBeNull();

    await (scheduler as any).runTask('fetch-all', () => (scheduler as any).runAllFetches());

    const after = readHeartbeat(hbPath);
    expect(after.last_fetch_success_at).toBeNull();
    expect(after.last_success_at).toBeNull();
    expect(after.consecutive_failures).toBe(1);
    expect(after.error_class).toBe('dns');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      taskName: 'fetch-all',
      ok: false,
      counts: expect.objectContaining({
        fetched: 0,
        failed: 1,
        persistedRows: 0,
        successEmpty: 0,
        successItems: 0,
        skippedCircuit: 0,
        failuresByClass: { dns: 1 },
      }),
    });
    const dumped = JSON.stringify(record.mock.calls);
    expect(dumped).not.toMatch(/secret-token|raw-response-body|TWITTER_API_KEY/i);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('partial success is pipeline ok=true but reports failures', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const record = vi.fn().mockResolvedValue(1);
    mockGetByType.mockResolvedValue([
      { id: 11, type: 'twitter', identifier: 'gooduser' },
      { id: 12, type: 'twitter', identifier: 'baduser' },
    ]);
    mockFetchSources.mockResolvedValue({
      successful: [{ source: 'gooduser', count: 1 }],
      failed: [{ source: 'baduser', errorClass: 'provider', reason: 'socket hang up' }],
      outcomes: [
        { kind: 'success-items', source: 'gooduser', sourceId: 11, persisted: 1 },
        { kind: 'failure', source: 'baduser', sourceId: 12, persisted: 0, errorClass: 'provider', reason: 'socket hang up' },
      ],
      summary: {
        successEmpty: 0,
        successItems: 1,
        failed: 1,
        persistedRows: 1,
        failuresByClass: { provider: 1 },
        skippedCircuit: 0,
      },
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      runInitialCycle: false,
      pipelineRunStore: { record },
      ...timerDeps(),
    });
    await scheduler.start();

    await (scheduler as any).runTask('fetch-twitter', () => (scheduler as any).runFetch('twitter'));

    expect(record.mock.calls[0][0]).toMatchObject({
      taskName: 'fetch-twitter',
      ok: true,
      counts: expect.objectContaining({
        fetched: 1,
        failed: 1,
        persistedRows: 1,
        successItems: 1,
        skippedCircuit: 0,
      }),
    });
    const hb = readHeartbeat(hbPath);
    expect(hb.last_fetch_success_at).toEqual(expect.any(String));
    expect(hb.consecutive_failures).toBe(0);

    logSpy.mockRestore();
  });

  it('empty requested list remains ok=true', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const record = vi.fn().mockResolvedValue(1);
    mockGetDueForFetch.mockResolvedValue([]);
    mockFetchSources.mockResolvedValue({
      successful: [],
      failed: [],
      outcomes: [],
      summary: {
        successEmpty: 0,
        successItems: 0,
        failed: 0,
        persistedRows: 0,
        failuresByClass: {},
        skippedCircuit: 0,
      },
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      pipelineRunStore: { record },
      ...timerDeps(),
    });

    await (scheduler as any).runTask('fetch-all', () => (scheduler as any).runAllFetches());

    expect(record.mock.calls[0][0]).toMatchObject({
      taskName: 'fetch-all',
      ok: true,
      counts: expect.objectContaining({
        fetched: 0,
        failed: 0,
        persistedRows: 0,
        skippedCircuit: 0,
      }),
    });

    logSpy.mockRestore();
  });
});

describe('packet 12D-D scheduler ledger timeout and stop', () => {
  let dir: string;
  let hbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    PipelineRunStoreCtor.mockClear();
    process.env = { ...originalEnv };
    delete process.env.WORKER_RUN_INITIAL_CYCLE;
    dir = mkdtempSync(join(tmpdir(), 'hd-12dd-'));
    hbPath = join(dir, 'heartbeat.json');
    mockGetUnprocessed.mockResolvedValue([]);
    mockProcessBatch.mockResolvedValue({ processed: 0, relevant: 0, claimsExtracted: 0 });
    mockGetDueForFetch.mockResolvedValue([]);
    mockGetByType.mockResolvedValue([]);
    mockFetchSources.mockResolvedValue({ successful: [], failed: [] });
    mockInitialize.mockResolvedValue(undefined);
    mockRunSynthesis.mockResolvedValue({ syntheses: [], digest: null });
    const storage = await import('../storage');
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockReset();
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('hanging pipelineRunStore.record cannot wedge inFlight', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    type TimerCb = (...args: unknown[]) => void;
    const timeouts: Array<{ id: object; ms: number; cb: TimerCb }> = [];
    let seq = 0;
    const setTimeoutFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { kind: 'timeout', n: ++seq };
      timeouts.push({ id, ms: ms ?? 0, cb });
      return id as unknown as NodeJS.Timeout;
    });
    const setIntervalFn = vi.fn((cb: TimerCb, _ms?: number) => {
      return { kind: 'interval', n: ++seq } as unknown as NodeJS.Timeout;
    });
    const clearTimeoutFn = vi.fn();
    const clearIntervalFn = vi.fn();

    let rejectHang!: (reason?: unknown) => void;
    const record = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectHang = reject;
          }),
      )
      .mockResolvedValue(1);
    mockGetUnprocessed.mockResolvedValue([{ id: 1 }]);
    mockProcessBatch.mockResolvedValue({ processed: 1, relevant: 1, claimsExtracted: 2 });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      runInitialCycle: false,
      ledgerTimeoutMs: 20,
      pipelineRunStore: { record },
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });
    await scheduler.start();

    const first = (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());

    await vi.waitFor(() => {
      expect(mockProcessBatch).toHaveBeenCalledTimes(1);
      expect((scheduler as any).inFlight.has('processing')).toBe(false);
      expect(timeouts.some((t) => t.ms === 20)).toBe(true);
    });

    const hbAfterTask = readHeartbeat(hbPath);
    expect(hbAfterTask.last_task).toBe('processing');
    expect(hbAfterTask.consecutive_failures).toBe(0);
    expect(hbAfterTask.last_success_at).toEqual(expect.any(String));

    const second = (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    await second;
    expect(mockProcessBatch).toHaveBeenCalledTimes(2);

    const completionsBeforeTimeout = parseCompletionLines(logSpy.mock.calls);
    expect(completionsBeforeTimeout.some((line) => line.task === 'processing' && line.ok === true)).toBe(
      true,
    );

    const ledgerTimer = timeouts.find((t) => t.ms === 20);
    expect(ledgerTimer).toBeDefined();
    expect([...(scheduler as any).timers.values()]).not.toContain(ledgerTimer!.id);
    ledgerTimer!.cb();
    rejectHang(
      new Error('postgresql://secret:***@/db token=abc DATABASE_URL=secret://leak'),
    );
    await first;

    expect(record).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/ledger write failed/i);
    expect(logged).not.toMatch(/postgresql:\/\/secret/i);
    expect(logged).not.toMatch(/token=abc/i);
    expect(logged).not.toMatch(/DATABASE_URL/i);
    expect(logged).not.toMatch(/secret:\/\//i);

    const dumped = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(dumped).not.toMatch(/postgresql:\/\/secret/i);
    expect(dumped).not.toMatch(/token=abc/i);
    expect(dumped).not.toMatch(/DATABASE_URL/i);
    expect(dumped).not.toMatch(/secret:\/\//i);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('ledger timeout uses the injected seam and clears on successful record', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { DEFAULT_LEDGER_RECORD_TIMEOUT_MS } = await import('../scheduler');
    expect(DEFAULT_LEDGER_RECORD_TIMEOUT_MS).toBe(5000);

    type TimerCb = (...args: unknown[]) => void;
    const timeouts: Array<{ id: object; ms: number; cb: TimerCb; cleared: boolean }> = [];
    const clearedTimeoutIds: object[] = [];
    let seq = 0;
    const setTimeoutFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { kind: 'timeout', n: ++seq };
      timeouts.push({ id, ms: ms ?? 0, cb, cleared: false });
      return id as unknown as NodeJS.Timeout;
    });
    const setIntervalFn = vi.fn((_cb: TimerCb, _ms?: number) => {
      return { kind: 'interval', n: ++seq } as unknown as NodeJS.Timeout;
    });
    const clearTimeoutFn = vi.fn((id: object) => {
      clearedTimeoutIds.push(id);
      const t = timeouts.find((x) => x.id === id);
      if (t) t.cleared = true;
    });
    const clearIntervalFn = vi.fn();

    const record = vi.fn().mockResolvedValue(1);
    mockGetUnprocessed.mockResolvedValue([{ id: 1 }]);
    mockProcessBatch.mockResolvedValue({ processed: 1, relevant: 0, claimsExtracted: 0 });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      ledgerTimeoutMs: 20,
      pipelineRunStore: { record },
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    await (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());

    const ledgerTimers = timeouts.filter((t) => t.ms === 20);
    expect(ledgerTimers).toHaveLength(1);
    expect(ledgerTimers[0].cleared).toBe(true);
    expect(clearedTimeoutIds).toContain(ledgerTimers[0].id);

    ledgerTimers[0].cb();
    await (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    expect(mockProcessBatch).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/ledger write failed/i);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('stop closes optional ledger stores exactly once without leaking secrets, then exitFn once', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const pipelineClose = vi.fn().mockResolvedValue(undefined);
    const sourceClose = vi.fn().mockRejectedValue(
      new Error('postgresql://secret:***@/db token=abc'),
    );
    const exitFn = vi.fn();

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      runInitialCycle: false,
      pipelineRunStore: { record: vi.fn().mockResolvedValue(1), close: pipelineClose },
      sourceFetchAttemptStore: { record: vi.fn().mockResolvedValue(1), close: sourceClose },
      exitFn,
      ...timerDeps(),
    });
    await scheduler.start();

    await scheduler.stop();
    await scheduler.stop();

    expect(pipelineClose).toHaveBeenCalledTimes(1);
    expect(sourceClose).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/store close failed/i);
    expect(logged).not.toMatch(/postgresql:\/\//i);
    expect(logged).not.toMatch(/token=abc/i);

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('hanging store.close still calls close once and exitFn still fires once', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    type TimerCb = (...args: unknown[]) => void;
    const timeouts: Array<{ id: object; ms: number; cb: TimerCb; cleared: boolean }> = [];
    let seq = 0;
    const setTimeoutFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { kind: 'timeout', n: ++seq };
      timeouts.push({ id, ms: ms ?? 0, cb, cleared: false });
      return id as unknown as NodeJS.Timeout;
    });
    const setIntervalFn = vi.fn((_cb: TimerCb, _ms?: number) => {
      return { kind: 'interval', n: ++seq } as unknown as NodeJS.Timeout;
    });
    const clearTimeoutFn = vi.fn((id: object) => {
      const t = timeouts.find((x) => x.id === id);
      if (t) t.cleared = true;
    });
    const clearIntervalFn = vi.fn();

    const pipelineClose = vi.fn().mockImplementation(() => new Promise(() => {}));
    const sourceClose = vi.fn().mockRejectedValue(
      new Error('postgresql://secret:***@/db token=abc'),
    );
    const exitFn = vi.fn();

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      runInitialCycle: false,
      ledgerTimeoutMs: 20,
      pipelineRunStore: { record: vi.fn().mockResolvedValue(1), close: pipelineClose },
      sourceFetchAttemptStore: { record: vi.fn().mockResolvedValue(1), close: sourceClose },
      exitFn,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });
    await scheduler.start();

    const stopP = scheduler.stop();

    await vi.waitFor(() => {
      expect(pipelineClose).toHaveBeenCalledTimes(1);
      expect(sourceClose).toHaveBeenCalledTimes(1);
      expect(timeouts.some((t) => t.ms === 20 && !t.cleared)).toBe(true);
    });

    const closeTimers = timeouts.filter((t) => t.ms === 20);
    for (const t of closeTimers) {
      expect([...(scheduler as any).timers.values()]).not.toContain(t.id);
    }
    for (const t of closeTimers) {
      if (!t.cleared) t.cb();
    }

    await stopP;
    await scheduler.stop();

    expect(pipelineClose).toHaveBeenCalledTimes(1);
    expect(sourceClose).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Scheduler store close failed/);
    expect(logged).not.toMatch(/postgresql:\/\/secret/i);
    expect(logged).not.toMatch(/token=abc/i);
    expect(logged).not.toMatch(/secret:\*\*\*/i);

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('stop with missing ledger stores still calls exitFn once and does not throw', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const exitFn = vi.fn();

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      runInitialCycle: false,
      exitFn,
      ...timerDeps(),
    });
    await scheduler.start();

    await expect(scheduler.stop()).resolves.toBeUndefined();
    await expect(scheduler.stop()).resolves.toBeUndefined();
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
    expect(errorSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

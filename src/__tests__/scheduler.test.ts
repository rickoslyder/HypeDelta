/**
 * Scheduler processing correctness tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetUnprocessed = vi.fn();
const mockGetRecent = vi.fn();
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
    getRecent: mockGetRecent,
  })),
}));

describe('scheduler processing config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PROCESS_LOOKBACK_DAYS;
    delete process.env.PROCESS_BATCH_LIMIT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults lookback to 30 days and batch limit to 50', async () => {
    const { resolveProcessingConfig } = await import('../scheduler');
    expect(resolveProcessingConfig()).toEqual({ lookbackDays: 30, batchLimit: 50 });
  });

  it('falls back to defaults for malformed, zero, or negative env values', async () => {
    const { resolveProcessingConfig } = await import('../scheduler');

    process.env.PROCESS_LOOKBACK_DAYS = 'nope';
    process.env.PROCESS_BATCH_LIMIT = '0';
    expect(resolveProcessingConfig()).toEqual({ lookbackDays: 30, batchLimit: 50 });

    process.env.PROCESS_LOOKBACK_DAYS = '-5';
    process.env.PROCESS_BATCH_LIMIT = '-1';
    expect(resolveProcessingConfig()).toEqual({ lookbackDays: 30, batchLimit: 50 });
  });

  it('clamps excessive batch limit and accepts valid values', async () => {
    const { resolveProcessingConfig } = await import('../scheduler');

    process.env.PROCESS_LOOKBACK_DAYS = '14';
    process.env.PROCESS_BATCH_LIMIT = '99999';
    const cfg = resolveProcessingConfig();
    expect(cfg.lookbackDays).toBe(14);
    expect(cfg.batchLimit).toBeLessThanOrEqual(500);
    expect(cfg.batchLimit).toBeGreaterThan(0);

    process.env.PROCESS_BATCH_LIMIT = '25';
    expect(resolveProcessingConfig().batchLimit).toBe(25);
  });
});

describe('nextSundayDigestAt', () => {
  it('returns same-day Sunday 09:00 when now is Sunday before 09:00', async () => {
    const { nextSundayDigestAt } = await import('../scheduler');
    const now = new Date(2026, 6, 26, 8, 0, 0, 0);
    expect(now.getDay()).toBe(0);

    const next = nextSundayDigestAt(now);

    expect(next.getTime()).toBe(new Date(2026, 6, 26, 9, 0, 0, 0).getTime());
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns next week when now is Sunday exactly 09:00', async () => {
    const { nextSundayDigestAt } = await import('../scheduler');
    const now = new Date(2026, 6, 26, 9, 0, 0, 0);
    expect(now.getDay()).toBe(0);

    const next = nextSundayDigestAt(now);

    expect(next.getTime()).toBe(new Date(2026, 7, 2, 9, 0, 0, 0).getTime());
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns next week when now is Sunday after 09:00', async () => {
    const { nextSundayDigestAt } = await import('../scheduler');
    const now = new Date(2026, 6, 26, 10, 15, 0, 0);
    expect(now.getDay()).toBe(0);

    const next = nextSundayDigestAt(now);

    expect(next.getTime()).toBe(new Date(2026, 7, 2, 9, 0, 0, 0).getTime());
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns upcoming Sunday 09:00 from Friday', async () => {
    const { nextSundayDigestAt } = await import('../scheduler');
    const now = new Date(2026, 6, 24, 12, 0, 0, 0);
    expect(now.getDay()).toBe(5);

    const next = nextSundayDigestAt(now);

    expect(next.getTime()).toBe(new Date(2026, 6, 26, 9, 0, 0, 0).getTime());
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('scheduler processing selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetUnprocessed.mockResolvedValue([]);
    mockProcessBatch.mockResolvedValue({ processed: 0, relevant: 0, claimsExtracted: 0 });
  });

  it('calls getUnprocessed(lookbackDays, batchLimit) and never getRecent', async () => {
    const { AIIntelScheduler, resolveProcessingConfig } = await import('../scheduler');
    const cfg = resolveProcessingConfig();
    const scheduler = new AIIntelScheduler({ autoStart: false });

    await (scheduler as any).runProcessing();

    expect(mockGetUnprocessed).toHaveBeenCalledWith(cfg.lookbackDays, cfg.batchLimit);
    expect(mockGetRecent).not.toHaveBeenCalled();
  });
});

describe('scheduler import side effects', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not auto-start the worker on import', async () => {
    await import('../scheduler');
    expect(mockInitialize).not.toHaveBeenCalled();
  });
});

describe('scheduler overlap and failure isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetUnprocessed.mockResolvedValue([{ id: 1, content_text: 'x' }]);
  });

  it('skips a second tick while the same task is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    mockProcessBatch.mockImplementation(async () => {
      await gate;
      return { processed: 1, relevant: 1, claimsExtracted: 0 };
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({ autoStart: false });

    const first = (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    const second = (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());

    await second; // should skip while first is in flight
    release();
    await first;

    expect(mockProcessBatch).toHaveBeenCalledTimes(1);
  });

  it('catches scheduled task errors with a generic message and keeps later ticks alive', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProcessBatch
      .mockRejectedValueOnce(new Error('DATABASE_URL=secret://leak prompt=SYSTEM content body token=abc'))
      .mockResolvedValueOnce({ processed: 1, relevant: 1, claimsExtracted: 0 });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({ autoStart: false });

    await (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());
    await (scheduler as any).runTask('processing', () => (scheduler as any).runProcessing());

    expect(mockProcessBatch).toHaveBeenCalledTimes(2);

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/processing/i);
    expect(logged).not.toMatch(/secret:\/\//i);
    expect(logged).not.toMatch(/DATABASE_URL/i);
    expect(logged).not.toMatch(/token=abc/i);
    expect(logged).not.toMatch(/prompt=SYSTEM/i);
    expect(logged).not.toMatch(/content body/i);

    errorSpy.mockRestore();
  });
});

describe('scheduler weekly digest retry scheduling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('installs the recurring interval even when the first Sunday run rejects, and a later tick succeeds', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockRunSynthesis
      .mockRejectedValueOnce(
        new Error('digest fail token=sk-live-ABC123 url=https://api.example/secret')
      )
      .mockResolvedValueOnce({ syntheses: [{ topic: 'scaling' }], digest: null });

    type TimerCb = (...args: unknown[]) => void;
    const timeouts: Array<{ id: object; ms: number; cb: TimerCb }> = [];
    const intervals: Array<{ id: object; ms: number; cb: TimerCb }> = [];
    let seq = 0;

    const setTimeoutFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { kind: 'timeout', n: ++seq };
      timeouts.push({ id, ms: ms ?? 0, cb });
      return id as unknown as NodeJS.Timeout;
    });
    const setIntervalFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { kind: 'interval', n: ++seq };
      intervals.push({ id, ms: ms ?? 0, cb });
      return id as unknown as NodeJS.Timeout;
    });
    const clearTimeoutFn = vi.fn();
    const clearIntervalFn = vi.fn();

    // Fixed Friday so ms-until-Sunday is deterministic and non-zero.
    // Only fake Date — timers are injected; keep real timers for waitFor.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z')); // Friday

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    (scheduler as any).running = true;
    (scheduler as any).scheduleWeeklyDigest();

    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(intervals).toHaveLength(0);

    // Fire the initial Sunday timeout.
    const initial = timeouts[0];
    expect(initial.ms).toBeGreaterThan(0);
    initial.cb();

    // Allow the first runTask rejection to fully settle (incl. inFlight clear).
    await vi.waitFor(() => {
      expect(mockRunSynthesis).toHaveBeenCalledTimes(1);
      expect((scheduler as any).inFlight.has('weekly-digest')).toBe(false);
    });

    // Recurring interval must be installed despite first-run failure.
    expect(intervals.length).toBeGreaterThanOrEqual(1);
    const weekly = intervals.find((i) => i.ms === 7 * 24 * 60 * 60 * 1000);
    expect(weekly).toBeDefined();

    // Later interval tick succeeds (single-flight/error isolation preserved).
    weekly!.cb();
    await vi.waitFor(() => {
      expect(mockRunSynthesis).toHaveBeenCalledTimes(2);
      expect((scheduler as any).inFlight.has('weekly-digest')).toBe(false);
    });

    const errLogged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errLogged).toMatch(/weekly-digest/i);
    expect(errLogged).not.toMatch(/sk-live-ABC123/i);

    vi.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('retains the initial timeout handle so stop() clears it and the delayed first digest never runs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const exitFn = vi.fn();

    type TimerCb = (...args: unknown[]) => void;
    const timeouts: Array<{ id: object; ms: number; cb: TimerCb; cleared: boolean }> = [];
    const clearedTimeoutIds: object[] = [];
    let seq = 0;

    const setTimeoutFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { kind: 'timeout', n: ++seq };
      timeouts.push({ id, ms: ms ?? 0, cb, cleared: false });
      return id as unknown as NodeJS.Timeout;
    });
    const setIntervalFn = vi.fn((cb: TimerCb, ms?: number) => {
      return { kind: 'interval', n: ++seq } as unknown as NodeJS.Timeout;
    });
    const clearTimeoutFn = vi.fn((id: object) => {
      clearedTimeoutIds.push(id);
      const t = timeouts.find((x) => x.id === id);
      if (t) t.cleared = true;
    });
    const clearIntervalFn = vi.fn();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'));

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      exitFn,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    (scheduler as any).running = true;
    (scheduler as any).scheduleWeeklyDigest();

    expect(timeouts).toHaveLength(1);
    const initialId = timeouts[0].id;

    await scheduler.stop();

    expect(clearTimeoutFn).toHaveBeenCalledWith(initialId);
    expect(timeouts[0].cleared).toBe(true);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);

    // Even if something invoked the callback after stop, running=false should
    // prevent work — but the primary contract is the handle was cleared.
    expect(mockRunSynthesis).not.toHaveBeenCalled();

    vi.useRealTimers();
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('schedules the following Sunday when restarted after 09:00 on Sunday', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    type TimerCb = (...args: unknown[]) => void;
    const timeouts: Array<{ id: object; ms: number; cb: TimerCb }> = [];
    let seq = 0;

    const setTimeoutFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { kind: 'timeout', n: ++seq };
      timeouts.push({ id, ms: ms ?? 0, cb });
      return id as unknown as NodeJS.Timeout;
    });
    const setIntervalFn = vi.fn((cb: TimerCb, ms?: number) => {
      return { kind: 'interval', n: ++seq } as unknown as NodeJS.Timeout;
    });

    const now = new Date(2026, 6, 26, 10, 15, 0, 0);
    const expected = new Date(2026, 7, 2, 9, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    });

    (scheduler as any).running = true;
    (scheduler as any).scheduleWeeklyDigest();

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].ms).toBe(expected.getTime() - now.getTime());
    expect(timeouts[0].ms).toBeGreaterThan(0);

    vi.useRealTimers();
    logSpy.mockRestore();
  });
});

describe('scheduler fetch error redaction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('logs bounded failure counts without raw credential-looking error strings', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const credentialLikeError = [
      'GET https://api.twitterapi.io/v1/tweets?key=',
      ['sk-', 'fixture-', 'credential'].join(''),
      ' failed: bearer=',
      ['tok_', 'fixture'].join(''),
      ' body={"token":"',
      ['fixture', '-payload'].join(''),
      '"}',
    ].join('');

    mockGetDueForFetch.mockResolvedValueOnce([{ id: 1, name: 'lab-x', type: 'twitter' }]);
    mockFetchSources.mockResolvedValueOnce({
      successful: [],
      failed: [
        {
          source: 'lab-x',
          error: credentialLikeError,
        },
      ],
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({ autoStart: false });

    await (scheduler as any).runAllFetches();

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((c) => c.join(' '))
      .join('\n');

    expect(logged).toMatch(/Failed:\s*1/i);
    expect(logged).not.toContain(['sk-', 'fixture-', 'credential'].join(''));
    expect(logged).not.toContain(['tok_', 'fixture'].join(''));
    expect(logged).not.toMatch(/bearer=/i);
    expect(logged).not.toMatch(/api\.twitterapi\.io/i);
    expect(logged).not.toContain(['fixture', '-payload'].join(''));

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

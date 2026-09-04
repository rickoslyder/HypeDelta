/**
 * WORKER_RUN_INITIAL_CYCLE + heartbeat-before-work lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

describe('shouldRunInitialCycle', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to true when env is absent', async () => {
    const { shouldRunInitialCycle } = await import('../scheduler');
    expect(shouldRunInitialCycle({})).toBe(true);
    expect(shouldRunInitialCycle({ WORKER_RUN_INITIAL_CYCLE: undefined })).toBe(true);
  });

  it('is true when env is exactly true or other non-false values', async () => {
    const { shouldRunInitialCycle } = await import('../scheduler');
    expect(shouldRunInitialCycle({ WORKER_RUN_INITIAL_CYCLE: 'true' })).toBe(true);
    expect(shouldRunInitialCycle({ WORKER_RUN_INITIAL_CYCLE: '1' })).toBe(true);
  });

  it('is false only when env is exactly "false"', async () => {
    const { shouldRunInitialCycle } = await import('../scheduler');
    expect(shouldRunInitialCycle({ WORKER_RUN_INITIAL_CYCLE: 'false' })).toBe(false);
    expect(shouldRunInitialCycle({ WORKER_RUN_INITIAL_CYCLE: 'False' })).toBe(true);
    expect(shouldRunInitialCycle({ WORKER_RUN_INITIAL_CYCLE: '0' })).toBe(true);
  });
});

describe('scheduler initial cycle + heartbeat', () => {
  let dir: string;
  let hbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WORKER_RUN_INITIAL_CYCLE;
    dir = mkdtempSync(join(tmpdir(), 'hd-sched-'));
    hbPath = join(dir, 'heartbeat.json');
    mockGetUnprocessed.mockResolvedValue([]);
    mockProcessBatch.mockResolvedValue({ processed: 0, relevant: 0, claimsExtracted: 0 });
    mockGetDueForFetch.mockResolvedValue([]);
    mockFetchSources.mockResolvedValue({ successful: [], failed: [] });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

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

  it('default: runs initial fetch + process and heartbeat exists before those tasks', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    let sawHeartbeatBeforeFetch = false;
    mockGetDueForFetch.mockImplementation(async () => {
      sawHeartbeatBeforeFetch = existsSync(hbPath);
      return [];
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      ...timerDeps(),
    });

    await scheduler.start();

    expect(sawHeartbeatBeforeFetch).toBe(true);
    expect(existsSync(hbPath)).toBe(true);
    expect(mockGetDueForFetch).toHaveBeenCalled();
    expect(mockGetUnprocessed).toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/Scheduler running/i);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('WORKER_RUN_INITIAL_CYCLE=true runs initial fetch/process', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.WORKER_RUN_INITIAL_CYCLE = 'true';

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      ...timerDeps(),
    });
    await scheduler.start();

    expect(mockGetDueForFetch).toHaveBeenCalled();
    expect(mockGetUnprocessed).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('WORKER_RUN_INITIAL_CYCLE=false skips initial fetch/process, logs once, still schedules + reports running', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.WORKER_RUN_INITIAL_CYCLE = 'false';

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      ...timerDeps(),
    });
    await scheduler.start();

    expect(existsSync(hbPath)).toBe(true);
    expect(mockGetDueForFetch).not.toHaveBeenCalled();
    expect(mockGetUnprocessed).not.toHaveBeenCalled();
    expect(mockInitialize).toHaveBeenCalled();

    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/WORKER_RUN_INITIAL_CYCLE/i);
    expect(logged).toMatch(/Scheduler running/i);
    // Recurring schedules still installed (setInterval used for fetch/process/etc.)
    expect((scheduler as unknown as { timers: Map<string, unknown> }).timers.size).toBeGreaterThan(0);

    logSpy.mockRestore();
  });

  it('runs initializeDatabase before orchestrator.initialize and before any DB fetch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const order: string[] = [];

    const storage = await import('../storage');
    (storage.initializeDatabase as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('migrate');
    });
    mockInitialize.mockImplementation(async () => {
      order.push('orch-init');
    });
    mockGetDueForFetch.mockImplementation(async () => {
      order.push('fetch');
      return [];
    });

    const { AIIntelScheduler } = await import('../scheduler');
    const scheduler = new AIIntelScheduler({
      autoStart: false,
      heartbeatPath: hbPath,
      heartbeatIntervalMs: 60_000,
      ...timerDeps(),
    });
    await scheduler.start();

    expect(order[0]).toBe('migrate');
    expect(order).toContain('orch-init');
    expect(order).toContain('fetch');
    expect(order.indexOf('migrate')).toBeLessThan(order.indexOf('orch-init'));
    expect(order.indexOf('migrate')).toBeLessThan(order.indexOf('fetch'));
    expect(storage.initializeDatabase).toHaveBeenCalledTimes(1);
    const dbUrl = (storage.initializeDatabase as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof dbUrl).toBe('string');

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});

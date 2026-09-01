/**
 * Worker heartbeat write + healthcheck validation.
 * Temp dirs + fake timers only — no real DB/provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const V2_KEYS = [
  'status',
  'timestamp',
  'started_at',
  'last_success_at',
  'last_fetch_success_at',
  'error_class',
  'last_task',
  'consecutive_failures',
].sort();

function v2Payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ts = '2026-07-27T12:00:00.000Z';
  return {
    status: 'running',
    timestamp: ts,
    started_at: ts,
    last_success_at: ts,
    last_fetch_success_at: ts,
    error_class: null,
    last_task: 'processing',
    consecutive_failures: 0,
    ...overrides,
  };
}

describe('worker heartbeat module', () => {
  let dir: string;
  let hbPath: string;

  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), 'hd-hb-'));
    hbPath = join(dir, 'hypedelta-worker-heartbeat.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('writes atomic v2 heartbeat with starting status and required fields', async () => {
    const { writeHeartbeat, DEFAULT_HEARTBEAT_PATH, heartbeatV2Schema } = await import(
      '../worker-heartbeat'
    );
    expect(DEFAULT_HEARTBEAT_PATH).toBe('/tmp/hypedelta-worker-heartbeat.json');

    const fixed = new Date('2026-07-27T12:00:00.000Z');
    const payload = {
      status: 'starting' as const,
      timestamp: fixed.toISOString(),
      started_at: fixed.toISOString(),
      last_success_at: null,
      last_fetch_success_at: null,
      error_class: null,
      last_task: null,
      consecutive_failures: 0,
    };
    expect(heartbeatV2Schema.parse(payload)).toEqual(payload);
    writeHeartbeat(hbPath, payload);

    expect(existsSync(hbPath)).toBe(true);
    const raw = readFileSync(hbPath, 'utf8');
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(V2_KEYS);
    expect(body.status).toBe('starting');
    expect(body.timestamp).toBe(fixed.toISOString());
    expect(body.started_at).toBe(fixed.toISOString());
    expect(body.last_success_at).toBeNull();
    expect(body.last_fetch_success_at).toBeNull();
    expect(body.error_class).toBeNull();
    expect(body.last_task).toBeNull();
    expect(body.consecutive_failures).toBe(0);
    expect(raw).not.toMatch(/DATABASE_URL|password|token|postgresql/i);
  });

  it('startHeartbeat writes starting immediately; interval refreshes timestamp without clobbering state', async () => {
    type TimerCb = (...args: unknown[]) => void;
    const intervals: Array<{ id: object; ms: number; cb: TimerCb }> = [];
    let seq = 0;
    const setIntervalFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { n: ++seq };
      intervals.push({ id, ms: ms ?? 0, cb });
      return id as unknown as NodeJS.Timeout;
    });
    const clearIntervalFn = vi.fn();

    let nowMs = Date.parse('2026-07-27T12:00:00.000Z');
    const { startHeartbeat } = await import('../worker-heartbeat');
    const handle = startHeartbeat({
      path: hbPath,
      intervalMs: 30_000,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
      now: () => new Date(nowMs),
    });

    expect(existsSync(hbPath)).toBe(true);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(30_000);
    const initial = JSON.parse(readFileSync(hbPath, 'utf8')) as Record<string, unknown>;
    expect(initial.status).toBe('starting');
    expect(initial.started_at).toBe('2026-07-27T12:00:00.000Z');
    expect(initial.consecutive_failures).toBe(0);

    handle.recordSuccess('fetch-twitter');
    const afterSuccess = JSON.parse(readFileSync(hbPath, 'utf8')) as Record<string, unknown>;
    expect(afterSuccess.last_success_at).toBe('2026-07-27T12:00:00.000Z');
    expect(afterSuccess.last_fetch_success_at).toBe('2026-07-27T12:00:00.000Z');
    expect(afterSuccess.last_task).toBe('fetch-twitter');
    expect(afterSuccess.consecutive_failures).toBe(0);

    writeFileSync(hbPath, JSON.stringify({ status: 'running', timestamp: 'old' }));
    nowMs = Date.parse('2026-07-27T12:00:30.000Z');
    intervals[0].cb();
    const body = JSON.parse(readFileSync(hbPath, 'utf8')) as Record<string, unknown>;
    expect(body.timestamp).toBe('2026-07-27T12:00:30.000Z');
    expect(body.started_at).toBe('2026-07-27T12:00:00.000Z');
    expect(body.last_success_at).toBe('2026-07-27T12:00:00.000Z');
    expect(body.last_fetch_success_at).toBe('2026-07-27T12:00:00.000Z');
    expect(body.last_task).toBe('fetch-twitter');
    expect(body.status).toBe('starting');
    expect(body.consecutive_failures).toBe(0);

    handle.recordFailure('processing', 'timeout');
    nowMs = Date.parse('2026-07-27T12:01:00.000Z');
    intervals[0].cb();
    const afterFail = JSON.parse(readFileSync(hbPath, 'utf8')) as Record<string, unknown>;
    expect(afterFail.timestamp).toBe('2026-07-27T12:01:00.000Z');
    expect(afterFail.last_success_at).toBe('2026-07-27T12:00:00.000Z');
    expect(afterFail.consecutive_failures).toBe(1);
    expect(afterFail.error_class).toBe('timeout');
    expect(afterFail.last_task).toBe('processing');

    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(intervals[0].id);
  });

  it('rejects invalid v2 payloads at parse time and accepts legacy running+timestamp only', async () => {
    const { parseHeartbeatPayload, heartbeatV2Schema } = await import('../worker-heartbeat');
    expect(heartbeatV2Schema.safeParse({ status: 'running', timestamp: 'x' }).success).toBe(false);
    expect(parseHeartbeatPayload({ status: 'running', timestamp: '2026-07-27T12:00:00.000Z' })).toEqual({
      kind: 'legacy',
      status: 'running',
      timestamp: '2026-07-27T12:00:00.000Z',
    });
    expect(parseHeartbeatPayload(v2Payload({ consecutive_failures: -1 })).kind).toBe('invalid');
    expect(parseHeartbeatPayload(v2Payload({ status: 'booting' })).kind).toBe('invalid');
    expect(parseHeartbeatPayload(v2Payload()).kind).toBe('v2');
  });
});

describe('worker healthcheck', () => {
  let dir: string;
  let hbPath: string;
  let priorGrace: string | undefined;
  let priorSlo: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    priorGrace = process.env.WORKER_STARTUP_GRACE_MS;
    priorSlo = process.env.WORKER_PIPELINE_SLO_MS;
    delete process.env.WORKER_STARTUP_GRACE_MS;
    delete process.env.WORKER_PIPELINE_SLO_MS;
    dir = mkdtempSync(join(tmpdir(), 'hd-hc-'));
    hbPath = join(dir, 'heartbeat.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (priorGrace === undefined) delete process.env.WORKER_STARTUP_GRACE_MS;
    else process.env.WORKER_STARTUP_GRACE_MS = priorGrace;
    if (priorSlo === undefined) delete process.env.WORKER_PIPELINE_SLO_MS;
    else process.env.WORKER_PIPELINE_SLO_MS = priorSlo;
  });

  it('accepts a fresh heartbeat (exit-check ok)', async () => {
    const now = new Date('2026-07-27T12:06:00.000Z');
    writeFileSync(
      hbPath,
      JSON.stringify({ status: 'running', timestamp: '2026-07-27T12:00:00.000Z' }),
    );
    const { checkHeartbeat, DEFAULT_MAX_AGE_MS } = await import('../worker-healthcheck');
    expect(DEFAULT_MAX_AGE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(DEFAULT_MAX_AGE_MS).toBeLessThanOrEqual(8 * 60 * 1000);

    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => now,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a stale heartbeat', async () => {
    writeFileSync(
      hbPath,
      JSON.stringify({ status: 'running', timestamp: '2026-07-27T11:00:00.000Z' }),
    );
    const { checkHeartbeat } = await import('../worker-healthcheck');
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('heartbeat stale');
    expect(String(result.reason ?? '')).not.toMatch(/DATABASE_URL|password|token|postgresql/i);
  });

  it('rejects missing heartbeat', async () => {
    const { checkHeartbeat } = await import('../worker-healthcheck');
    const result = checkHeartbeat({
      path: join(dir, 'missing.json'),
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date(),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed heartbeat', async () => {
    writeFileSync(hbPath, '{not-json');
    const { checkHeartbeat } = await import('../worker-healthcheck');
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date(),
    });
    expect(result.ok).toBe(false);
    expect(String(result.reason ?? '')).not.toMatch(/stack|Error:|token|password/i);

    writeFileSync(hbPath, JSON.stringify({ status: 'running' })); // no timestamp
    const result2 = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date(),
    });
    expect(result2.ok).toBe(false);
  });

  it('reads path/max-age from options without shell execution', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      hbPath,
      JSON.stringify({ status: 'running', timestamp: new Date().toISOString() }),
    );
    const { checkHeartbeat } = await import('../worker-healthcheck');
    expect(checkHeartbeat({ path: hbPath, maxAgeMs: 60_000 }).ok).toBe(true);
  });

  it('fails immediately when status is failed even if process timestamp is fresh', async () => {
    writeFileSync(
      hbPath,
      JSON.stringify(
        v2Payload({
          status: 'failed',
          error_class: 'database',
          last_success_at: null,
          last_fetch_success_at: null,
        }),
      ),
    );
    const { checkHeartbeat } = await import('../worker-healthcheck');
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('heartbeat failed');
    expect(String(result.reason)).not.toMatch(/postgresql|password|stack|token/i);
  });

  it('fails after startup grace when v2 has no task success', async () => {
    writeFileSync(
      hbPath,
      JSON.stringify(
        v2Payload({
          status: 'running',
          timestamp: '2026-07-27T15:01:00.000Z',
          started_at: '2026-07-27T12:00:00.000Z',
          last_success_at: null,
          last_fetch_success_at: null,
          last_task: null,
        }),
      ),
    );
    const { checkHeartbeat, DEFAULT_STARTUP_GRACE_MS } = await import('../worker-healthcheck');
    expect(DEFAULT_STARTUP_GRACE_MS).toBe(3 * 60 * 60 * 1000);
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date('2026-07-27T15:01:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('startup grace exceeded');
  });

  it('fails when last_success_at exceeds pipeline SLO while process timestamp is fresh', async () => {
    writeFileSync(
      hbPath,
      JSON.stringify(
        v2Payload({
          timestamp: '2026-07-27T18:01:00.000Z',
          started_at: '2026-07-27T12:00:00.000Z',
          last_success_at: '2026-07-27T12:00:00.000Z',
          last_fetch_success_at: '2026-07-27T12:00:00.000Z',
        }),
      ),
    );
    const { checkHeartbeat, DEFAULT_PIPELINE_SLO_MS } = await import('../worker-healthcheck');
    expect(DEFAULT_PIPELINE_SLO_MS).toBe(6 * 60 * 60 * 1000);
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date('2026-07-27T18:01:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('pipeline stale');
  });

  it('legacy running+timestamp uses timestamp as startup baseline and fails when older than grace', async () => {
    writeFileSync(
      hbPath,
      JSON.stringify({ status: 'running', timestamp: '2026-07-27T12:00:00.000Z' }),
    );
    const { checkHeartbeat } = await import('../worker-healthcheck');
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 10 * 60 * 60 * 1000,
      now: () => new Date('2026-07-27T15:01:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('startup grace exceeded');
  });

  it('falls back fail-closed to defaults for invalid grace/SLO env and still enforces SLO', async () => {
    process.env.WORKER_STARTUP_GRACE_MS = 'nope';
    process.env.WORKER_PIPELINE_SLO_MS = '0';
    writeFileSync(
      hbPath,
      JSON.stringify(
        v2Payload({
          timestamp: '2026-07-27T18:01:00.000Z',
          started_at: '2026-07-27T12:00:00.000Z',
          last_success_at: '2026-07-27T12:00:00.000Z',
        }),
      ),
    );
    const {
      checkHeartbeat,
      resolveStartupGraceMs,
      resolvePipelineSloMs,
      DEFAULT_STARTUP_GRACE_MS,
      DEFAULT_PIPELINE_SLO_MS,
    } = await import('../worker-healthcheck');
    expect(resolveStartupGraceMs('nope')).toBe(DEFAULT_STARTUP_GRACE_MS);
    expect(resolveStartupGraceMs('')).toBe(DEFAULT_STARTUP_GRACE_MS);
    expect(resolveStartupGraceMs(undefined)).toBe(DEFAULT_STARTUP_GRACE_MS);
    expect(resolvePipelineSloMs('0')).toBe(DEFAULT_PIPELINE_SLO_MS);
    expect(resolvePipelineSloMs('-1')).toBe(DEFAULT_PIPELINE_SLO_MS);
    expect(resolvePipelineSloMs('Infinity')).toBe(DEFAULT_PIPELINE_SLO_MS);
    expect(resolvePipelineSloMs('NaN')).toBe(DEFAULT_PIPELINE_SLO_MS);
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date('2026-07-27T18:01:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('pipeline stale');
  });

  it('honors a finite in-range WORKER_PIPELINE_SLO_MS override', async () => {
    process.env.WORKER_PIPELINE_SLO_MS = '1000';
    writeFileSync(
      hbPath,
      JSON.stringify(
        v2Payload({
          timestamp: '2026-07-27T12:00:03.000Z',
          started_at: '2026-07-27T12:00:00.000Z',
          last_success_at: '2026-07-27T12:00:00.000Z',
        }),
      ),
    );
    const { checkHeartbeat, resolvePipelineSloMs } = await import('../worker-healthcheck');
    expect(resolvePipelineSloMs('1000')).toBe(1000);
    const result = checkHeartbeat({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date('2026-07-27T12:00:03.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('pipeline stale');
  });
});

describe('worker healthcheck required DNS', () => {
  let dir: string;
  let hbPath: string;
  let priorDnsHost: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    priorDnsHost = process.env.WORKER_HEALTH_DNS_HOST;
    delete process.env.WORKER_HEALTH_DNS_HOST;
    dir = mkdtempSync(join(tmpdir(), 'hd-hc-dns-'));
    hbPath = join(dir, 'heartbeat.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (priorDnsHost === undefined) delete process.env.WORKER_HEALTH_DNS_HOST;
    else process.env.WORKER_HEALTH_DNS_HOST = priorDnsHost;
  });

  function writeFreshHeartbeat(): void {
    writeFileSync(
      hbPath,
      JSON.stringify({ status: 'running', timestamp: '2026-07-27T12:00:00.000Z' }),
    );
  }

  const now = () => new Date('2026-07-27T12:00:00.000Z');

  it('fails a fresh heartbeat when injected resolver returns EAI_AGAIN', async () => {
    writeFreshHeartbeat();
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo EAI_AGAIN secret.example'), {
        code: 'EAI_AGAIN',
      });
    });
    const { checkWorkerHealth } = await import('../worker-healthcheck');
    const result = await checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now,
      lookup,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('required dns unavailable');
    expect(String(result.reason ?? '')).not.toMatch(
      /EAI_AGAIN|secret\.example|password|token|DATABASE_URL|stack|Error:/i,
    );
  });

  it('fails a fresh heartbeat when injected DNS lookup times out', async () => {
    writeFreshHeartbeat();
    const lookup = vi.fn(() => new Promise(() => {}));
    type TimerCb = (...args: unknown[]) => void;
    const timers: Array<{ id: object; ms: number; cb: TimerCb }> = [];
    let seq = 0;
    const setTimeoutFn = vi.fn((cb: TimerCb, ms?: number) => {
      const id = { n: ++seq };
      timers.push({ id, ms: ms ?? 0, cb });
      return id as unknown as NodeJS.Timeout;
    });
    const clearTimeoutFn = vi.fn();
    const { checkWorkerHealth } = await import('../worker-healthcheck');
    const pending = checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now,
      lookup,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
    });
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBeGreaterThan(0);
    expect(timers[0].ms).toBeLessThanOrEqual(5_000);
    timers[0].cb();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('required dns unavailable');
    expect(String(result.reason ?? '')).not.toMatch(
      /ETIMEDOUT|timeout|address|password|token|stack|Error:/i,
    );
  });

  it('disables only the DNS probe when dnsHost is an explicit blank', async () => {
    writeFreshHeartbeat();
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo EAI_AGAIN should-not-run'), {
        code: 'EAI_AGAIN',
      });
    });
    const { checkWorkerHealth } = await import('../worker-healthcheck');
    const result = await checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now,
      lookup,
      dnsHost: '',
    });
    expect(result.ok).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('passes a fresh heartbeat when injected DNS lookup succeeds', async () => {
    writeFreshHeartbeat();
    const lookup = vi.fn(async (_hostname: string) => ({ address: '203.0.113.10', family: 4 }));
    const { checkWorkerHealth } = await import('../worker-healthcheck');
    const result = await checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now,
      lookup,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/203\.0\.113\.10/);
    expect(lookup).toHaveBeenCalled();
  });

  it('fails a stale heartbeat without calling DNS', async () => {
    writeFileSync(
      hbPath,
      JSON.stringify({ status: 'running', timestamp: '2026-07-27T11:00:00.000Z' }),
    );
    const lookup = vi.fn(async (_hostname: string) => ({ address: '203.0.113.10', family: 4 }));
    const { checkWorkerHealth } = await import('../worker-healthcheck');
    const result = await checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      lookup,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('heartbeat stale');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('probes api.twitterapi.io by default and honors WORKER_HEALTH_DNS_HOST', async () => {
    writeFreshHeartbeat();
    const lookup = vi.fn(async (_hostname: string) => ({ address: '203.0.113.10', family: 4 }));
    const { checkWorkerHealth, DEFAULT_DNS_HOST, DEFAULT_DNS_TIMEOUT_MS } =
      await import('../worker-healthcheck');
    expect(DEFAULT_DNS_HOST).toBe('api.twitterapi.io');
    expect(DEFAULT_DNS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);

    await checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now,
      lookup,
    });
    expect(lookup.mock.calls[0]?.[0]).toBe('api.twitterapi.io');

    lookup.mockClear();
    process.env.WORKER_HEALTH_DNS_HOST = 'dns.example.test';
    await checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now,
      lookup,
    });
    expect(lookup.mock.calls[0]?.[0]).toBe('dns.example.test');

    lookup.mockClear();
    process.env.WORKER_HEALTH_DNS_HOST = '';
    const disabled = await checkWorkerHealth({
      path: hbPath,
      maxAgeMs: 6 * 60 * 1000,
      now,
      lookup,
    });
    expect(disabled.ok).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('CLI wrapper exits 1 with a generic DNS reason and never prints lookup text', async () => {
    writeFreshHeartbeat();
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo EAI_AGAIN 198.51.100.9'), {
        code: 'EAI_AGAIN',
      });
    });
    const errors: string[] = [];
    const { runWorkerHealthcheck } = await import('../worker-healthcheck');
    const code = await runWorkerHealthcheck(
      {
        path: hbPath,
        maxAgeMs: 6 * 60 * 1000,
        now,
        lookup,
      },
      { error: (msg: string) => errors.push(msg) },
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toBe('required dns unavailable');
    expect(errors.join('\n')).not.toMatch(
      /EAI_AGAIN|198\.51\.100\.9|password|token|DATABASE_URL|stack|Error:/i,
    );
  });
});

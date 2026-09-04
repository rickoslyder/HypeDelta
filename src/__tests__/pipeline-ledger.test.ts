/**
 * Packet 12A: pipeline_runs + source_fetch_attempts ledgers,
 * error classification/sanitization, and focused store APIs.
 * Scheduler/fetcher wiring is out of scope (12B/C).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

import pg from 'pg';

const ERROR_CLASSES = [
  'dns',
  'timeout',
  'rate_limit',
  'auth',
  'http_4xx',
  'http_5xx',
  'parse',
  'database',
  'provider',
  'internal',
  'unknown',
] as const;

describe('008 pipeline observability ledgers', () => {
  it('is the next additive idempotent catalog entry after 007', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.slice(0, 8)).toEqual([
      '001', '002', '003', '004', '005', '006', '007', '008',
    ]);
    const m008 = MIGRATIONS.find((m) => m.version === '008');
    expect(m008).toBeDefined();
    expect(m008!.name).toMatch(/pipeline|fetch.?attempt/i);
    expect(m008!.sql).toMatch(/CREATE TABLE IF NOT EXISTS pipeline_runs/i);
    expect(m008!.sql).toMatch(/CREATE TABLE IF NOT EXISTS source_fetch_attempts/i);
    expect(m008!.sql).toMatch(/CREATE INDEX IF NOT EXISTS/i);
  });

  it('defines pipeline_runs with task, timestamps, ok, bounded error, jsonb size, and indexes', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const { PIPELINE_ERROR_CLASSES, ERROR_MESSAGE_MAX_CHARS, JSONB_MAX_BYTES } =
      await import('../pipeline-error');
    const sql = MIGRATIONS.find((m) => m.version === '008')!.sql;
    const pipelineSql = sql.slice(
      sql.search(/CREATE TABLE IF NOT EXISTS pipeline_runs/i),
      sql.search(/CREATE TABLE IF NOT EXISTS source_fetch_attempts/i),
    );
    expect(pipelineSql).toMatch(/task_name VARCHAR\(\d+\) NOT NULL/i);
    expect(pipelineSql).toMatch(/started_at TIMESTAMPTZ NOT NULL/i);
    expect(pipelineSql).toMatch(/finished_at TIMESTAMPTZ/i);
    expect(pipelineSql).toMatch(/ok BOOLEAN NOT NULL/i);
    expect(pipelineSql).toMatch(/error_class VARCHAR\(\d+\)/i);
    expect(pipelineSql).toMatch(/error_message VARCHAR\(\d+\)/i);
    expect(pipelineSql).toMatch(/counts JSONB/i);
    expect(pipelineSql).toMatch(/metadata JSONB/i);
    expect(ERROR_MESSAGE_MAX_CHARS).toBe(500);
    expect(JSONB_MAX_BYTES).toBe(4096);
    expect(pipelineSql).toContain(`VARCHAR(${ERROR_MESSAGE_MAX_CHARS})`);
    expect(pipelineSql).toMatch(new RegExp(`octet_length\\s*\\(\\s*counts::text\\s*\\)\\s*<=\\s*${JSONB_MAX_BYTES}`, 'i'));
    expect(pipelineSql).toMatch(new RegExp(`octet_length\\s*\\(\\s*metadata::text\\s*\\)\\s*<=\\s*${JSONB_MAX_BYTES}`, 'i'));
    for (const cls of PIPELINE_ERROR_CLASSES) {
      expect(pipelineSql).toContain(`'${cls}'`);
    }
    expect(sql).toMatch(/idx_pipeline_runs_task_started/i);
    expect(sql).toMatch(/pipeline_runs\s*\(\s*task_name\s*,\s*started_at\s+DESC/i);
    expect(sql).toMatch(/idx_pipeline_runs_recent_failures/i);
    expect(sql).toMatch(/WHERE\s+ok\s*=\s*false/i);
  });

  it('defines source_fetch_attempts with FK, no cascade, consecutive-failure support, and latest indexes', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const sql = MIGRATIONS.find((m) => m.version === '008')!.sql;
    expect(sql).toMatch(/source_id INT NOT NULL REFERENCES sources\s*\(\s*id\s*\)/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).toMatch(/source_type VARCHAR\(\d+\) NOT NULL/i);
    expect(sql).toMatch(/provider VARCHAR\(\d+\)/i);
    expect(sql).toMatch(/item_count INT NOT NULL DEFAULT 0/i);
    expect(sql).toMatch(/CHECK\s*\(\s*item_count\s*>=\s*0\s*\)/i);
    expect(sql).toMatch(/idx_source_fetch_attempts_latest_success/i);
    expect(sql).toMatch(/idx_source_fetch_attempts_latest_failure/i);
    expect(sql).toMatch(/source_fetch_attempts\s*\(\s*source_id\s*,\s*started_at\s+DESC/i);
  });

  it('is additive and never deletes, drops, or reparents', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const sql = MIGRATIONS.find((m) => m.version === '008')!.sql;
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/UPDATE\s+content\s+SET\s+source_id/i);
    expect(sql).not.toMatch(/ON COMMIT DROP/i);
  });

  it('rejects empty/whitespace task_name and source_type via CHECK, and item_count >= 0', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const sql = MIGRATIONS.find((m) => m.version === '008')!.sql;
    const pipelineSql = sql.slice(
      sql.search(/CREATE TABLE IF NOT EXISTS pipeline_runs/i),
      sql.search(/CREATE TABLE IF NOT EXISTS source_fetch_attempts/i),
    );
    const attemptsSql = sql.slice(sql.search(/CREATE TABLE IF NOT EXISTS source_fetch_attempts/i));
    expect(pipelineSql).toMatch(/char_length\s*\(\s*btrim\s*\(\s*task_name\s*\)\s*\)\s*>\s*0/i);
    expect(attemptsSql).toMatch(/char_length\s*\(\s*btrim\s*\(\s*source_type\s*\)\s*\)\s*>\s*0/i);
    expect(attemptsSql).toMatch(/item_count\s*>=\s*0/i);
  });
});

describe('pipeline error classification', () => {
  it('exposes the bounded enum and classifies common failure shapes', async () => {
    const { PIPELINE_ERROR_CLASSES, classifyPipelineError } = await import('../pipeline-error');
    expect([...PIPELINE_ERROR_CLASSES]).toEqual([...ERROR_CLASSES]);

    expect(classifyPipelineError({ code: 'ENOTFOUND' })).toBe('dns');
    expect(classifyPipelineError({ code: 'EAI_AGAIN' })).toBe('dns');
    expect(classifyPipelineError({ name: 'AbortError' })).toBe('timeout');
    expect(classifyPipelineError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyPipelineError({ status: 429 })).toBe('rate_limit');
    expect(classifyPipelineError({ status: 401 })).toBe('auth');
    expect(classifyPipelineError({ status: 403 })).toBe('auth');
    expect(classifyPipelineError({ status: 404 })).toBe('http_4xx');
    expect(classifyPipelineError({ status: 422 })).toBe('http_4xx');
    expect(classifyPipelineError({ status: 500 })).toBe('http_5xx');
    expect(classifyPipelineError({ status: 502 })).toBe('http_5xx');
    expect(classifyPipelineError(new SyntaxError('Unexpected token'))).toBe('parse');
    expect(classifyPipelineError({ message: 'invalid json' })).toBe('parse');
    expect(classifyPipelineError({ code: '28P01', message: 'password authentication failed' })).toBe('database');
    expect(classifyPipelineError({ message: 'twitterapi.io 503' })).toBe('provider');
    expect(classifyPipelineError(new Error('unexpected boom'))).toBe('internal');
    expect(classifyPipelineError(null)).toBe('unknown');
    expect(classifyPipelineError('not-an-error')).toBe('unknown');
  });
});

describe('pipeline error sanitization', () => {
  it('strips secrets, database URLs, query strings, bearer/tokens, stacks, and bodies, then truncates', async () => {
    const { sanitizePipelineErrorMessage, ERROR_MESSAGE_MAX_CHARS } = await import('../pipeline-error');
    const raw = [
      ["Fai", "led", " po", "stg", "res", "ql:", "//u", "ser", ":hu", "nte", "r2@", "db.", "int", "ern", "al:", "543", "2/a", "i_i", "nte", "l?s", "slm", "ode", "=re", "qui", "re"].join(""),
      ["GET", " ht", "tps", "://", "api", ".tw", "itt", "era", "pi.", "io/", "sea", "rch", "?ap", "i_k", "ey=", "sec", "ret", "&q=", "foo"].join(""),
      ["Aut", "hor", "iza", "tio", "n: ", "Bea", "rer", " ey", "Jhb", "Gci", "OiJ", "IUz", "I1N", "iIs", "InR", "5cC", "I6I", "kpX", "VCJ", "9.a", "aa.", "bbb"].join(""),
      ["tok", "en=", "abc", "123", "xyz", " to", "ken", "-li", "ke ", "sk-", "liv", "e-a", "bcd", "efg", "hij", "klm", "nop", "qrs", "tuv", "wxy", "z"].join(""),
      ["   ", " at", " ru", "nTa", "sk ", "(/a", "pp/", "src", "/sc", "hed", "ule", "r.t", "s:8", "8:1", "1)"].join(""),
      ["   ", " at", " pr", "oce", "ssT", "ick", "sAn", "dRe", "jec", "tio", "ns ", "(no", "de:", "int", "ern", "al/", "pro", "ces", "s/t", "ask", "_qu", "eue", "s:9", "5:5", ")"].join(""),
      ["bod", "y: ", "{\"c", "ont", "ent", "\":\""].join("") + ["x"].join("").repeat(800) + ["\"}"].join(""),
    ].join('\n');

    const sanitized = sanitizePipelineErrorMessage(raw);
    expect(sanitized).not.toMatch(/postgresql:\/\//i);
    expect(sanitized).not.toContain(['hun', 'ter2'].join(''));
    expect(sanitized).not.toMatch(/sslmode=require/);
    expect(sanitized).not.toContain(['api', '_key', '=sec', 'ret'].join(''));
    expect(sanitized).not.toMatch(/\?api_key=/);
    expect(sanitized).not.toMatch(/Bearer\s+\S+/i);
    expect(sanitized).not.toContain(['sk-', 'live-'].join(''));
    expect(sanitized).not.toContain(['tok', 'en=', 'abc', '123', 'xyz'].join(''));
    expect(sanitized).not.toMatch(/scheduler\.ts:88/);
    expect(sanitized).not.toMatch(/processTicksAndRejections/);
    expect(sanitized).not.toMatch(/"content":/);
    expect(sanitized.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CHARS);
    expect(sanitized.length).toBeGreaterThan(0);
  });

  it('compacts oversized jsonb counts/metadata to the byte limit', async () => {
    const { sanitizeJsonbPayload, JSONB_MAX_BYTES } = await import('../pipeline-error');
    const huge = { blob: 'y'.repeat(JSONB_MAX_BYTES + 200), keep: 1 };
    const compacted = sanitizeJsonbPayload(huge);
    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8')).toBeLessThanOrEqual(JSONB_MAX_BYTES);
    expect(compacted).toEqual({ _truncated: true });
  });

  it('recursively strips nested secret metadata while preserving safe scalar counts', async () => {
    const { sanitizeJsonbPayload } = await import('../pipeline-error');
    const payload = {
      processed: 3,
      fetched: 10,
      nested: {
        api_key: ["sk-", "liv", "e-s", "ecr", "et"].join(""),
        token: ["abc", "123", "xyz"].join(""),
        password: ["hun", "ter", "2"].join(""),
        authorization: ["Bea", "rer", " ey", "Jhb", "G.b", "bb"].join(""),
        credentials: { user: ["u"].join(""), password: ["p"].join("") },
        db: ["pos", "tgr", "esq", "l:/", "/us", "er:", "hun", "ter", "2@d", "b.i", "nte", "rna", "l:5", "432", "/ai", "_in", "tel", "?ss", "lmo", "de=", "req", "uir", "e"].join(""),
        url: ["htt", "ps:", "//a", "pi.", "twi", "tte", "rap", "i.i", "o/s", "ear", "ch?", "api", "_ke", "y=s", "ecr", "et&", "q=f", "oo"].join(""),
        stack: ["   ", " at", " ru", "nTa", "sk ", "(/a", "pp/", "src", "/sc", "hed", "ule", "r.t", "s:8", "8:1", "1)"].join(""),
        body: { tweets: [{ text: ["lea", "k"].join("") }] },
        content: ["do-", "not", "-pe", "rsi", "st"].join(""),
        tweets: [{ id: 1 }],
        inner: { bearer: ["tok"].join(""), ok: 4 },
      },
    };
    const sanitized = sanitizeJsonbPayload(payload);
    const serialized = JSON.stringify(sanitized);
    expect(sanitized.processed).toBe(3);
    expect(sanitized.fetched).toBe(10);
    expect(serialized).not.toContain(['sk-', 'live-'].join(''));
    expect(serialized).not.toContain(['abc', '123', 'xyz'].join(''));
    expect(serialized).not.toContain(['hun', 'ter2'].join(''));
    expect(serialized).not.toMatch(/Bearer\s+\S+/i);
    expect(serialized).not.toMatch(/postgresql:\/\//i);
    expect(serialized).not.toMatch(/sslmode=require/);
    expect(serialized).not.toMatch(/\?api_key=/);
    expect(serialized).not.toContain(['api', '_key', '=sec', 'ret'].join(''));
    expect(serialized).not.toMatch(/scheduler\.ts:88/);
    expect(serialized).not.toContain(['do-', 'not-', 'persist'].join(''));
    expect(serialized).not.toMatch(/"tweets"/);
    expect(serialized).not.toMatch(/"content"/);
    expect(serialized).not.toMatch(/"body"/);
    expect(serialized).not.toMatch(/"stack"/);
    expect(serialized).not.toMatch(/"token"/i);
    expect(serialized).not.toMatch(/"password"/i);
    expect(serialized).not.toMatch(/"credentials"/i);
    expect(serialized).not.toMatch(/"authorization"/i);
    expect((sanitized.nested as Record<string, unknown>).inner).toEqual({ ok: 4 });
  });

  it('reapplies the byte cap after sanitization and keeps safe counts when secrets made it oversized', async () => {
    const { sanitizeJsonbPayload, JSONB_MAX_BYTES } = await import('../pipeline-error');
    const secretHeavy = {
      processed: 7,
      fetched: 2,
      api_key: 'sk-live-' + 'x'.repeat(JSONB_MAX_BYTES + 50),
      body: { tweets: 'z'.repeat(JSONB_MAX_BYTES) },
    };
    const kept = sanitizeJsonbPayload(secretHeavy);
    expect(kept).toEqual({ processed: 7, fetched: 2 });
    expect(Buffer.byteLength(JSON.stringify(kept), 'utf8')).toBeLessThanOrEqual(JSONB_MAX_BYTES);

    const stillHuge = {
      processed: 1,
      blob: 'y'.repeat(JSONB_MAX_BYTES + 200),
    };
    const compacted = sanitizeJsonbPayload(stillHuge);
    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8')).toBeLessThanOrEqual(JSONB_MAX_BYTES);
    expect(compacted).toEqual({ _truncated: true });
  });
});

describe('pipeline run/attempt field bounds', () => {
  it('rejects empty or whitespace task_name and source_type at runtime', async () => {
    const { boundTaskName, boundSourceType } = await import('../pipeline-error');
    expect(() => boundTaskName('')).toThrow(/task_name/i);
    expect(() => boundTaskName('   ')).toThrow(/task_name/i);
    expect(() => boundSourceType('')).toThrow(/source_type/i);
    expect(() => boundSourceType('\t\n')).toThrow(/source_type/i);
    expect(boundTaskName('  fetch  ')).toBe('fetch');
    expect(boundSourceType(' twitter ')).toBe('twitter');
  });

  it('normalizes finite nonnegative item_count and rejects negative or nonfinite values', async () => {
    const { normalizeItemCount } = await import('../pipeline-error');
    expect(normalizeItemCount(undefined)).toBe(0);
    expect(normalizeItemCount(null)).toBe(0);
    expect(normalizeItemCount(0)).toBe(0);
    expect(normalizeItemCount(4)).toBe(4);
    expect(normalizeItemCount(4.9)).toBe(4);
    expect(() => normalizeItemCount(-1)).toThrow(/item_count/i);
    expect(() => normalizeItemCount(-0.2)).toThrow(/item_count/i);
    expect(() => normalizeItemCount(Number.POSITIVE_INFINITY)).toThrow(/item_count/i);
    expect(() => normalizeItemCount(Number.NaN)).toThrow(/item_count/i);
  });
});

describe('PipelineRunStore', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = (new pg.Pool({ connectionString: 'mock://test' }).query as ReturnType<typeof vi.fn>);
  });

  it('inserts a sanitized pipeline_runs row and never stores secrets', async () => {
    const { PipelineRunStore } = await import('../pipeline-ledger');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '11' }] });
    const store = new PipelineRunStore('postgresql://localhost/test');
    const id = await store.record({
      taskName: 'process',
      startedAt: new Date('2026-08-28T10:00:00Z'),
      finishedAt: new Date('2026-08-28T10:00:02Z'),
      ok: false,
      error: {
        message: 'boom postgresql://u:p@localhost/db token=sekrit',
        code: 'ETIMEDOUT',
      },
      counts: { processed: 3 },
      metadata: { reason: 'timeout' },
    });
    expect(id).toBe(11);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO pipeline_runs/i);
    expect(sql).toMatch(/task_name/);
    expect(sql).toMatch(/error_class/);
    expect(sql).toMatch(/error_message/);
    expect(params[0]).toBe('process');
    expect(params).toContain(false);
    expect(params).toContain('timeout');
    const serialized = JSON.stringify(params);
    expect(serialized).not.toMatch(/postgresql:\/\//i);
    expect(serialized).not.toMatch(/token=sekrit/);
  });

  it('rejects empty or whitespace task_name before insert', async () => {
    const { PipelineRunStore } = await import('../pipeline-ledger');
    const store = new PipelineRunStore('postgresql://localhost/test');
    await expect(store.record({
      taskName: '  ',
      startedAt: new Date('2026-08-28T10:00:00Z'),
      ok: true,
    })).rejects.toThrow(/task_name/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('queries latest-per-task and recent failures', async () => {
    const { PipelineRunStore } = await import('../pipeline-ledger');
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: '1', task_name: 'fetch', ok: true }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: '2', task_name: 'process', ok: false }],
    });
    const store = new PipelineRunStore('postgresql://localhost/test');
    const latest = await store.latestForTask('fetch');
    expect(latest?.taskName).toBe('fetch');
    const [latestSql, latestParams] = mockQuery.mock.calls[0];
    expect(latestSql).toMatch(/FROM pipeline_runs/i);
    expect(latestSql).toMatch(/task_name\s*=\s*\$1/i);
    expect(latestSql).toMatch(/ORDER BY started_at DESC/i);
    expect(latestParams).toEqual(['fetch']);

    const failures = await store.recentFailures(5);
    expect(failures).toHaveLength(1);
    const [failSql, failParams] = mockQuery.mock.calls[1];
    expect(failSql).toMatch(/ok\s*=\s*false/i);
    expect(failSql).toMatch(/ORDER BY started_at DESC/i);
    expect(failParams).toEqual([5]);
  });
});

describe('SourceFetchAttemptStore', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = (new pg.Pool({ connectionString: 'mock://test' }).query as ReturnType<typeof vi.fn>);
  });

  it('inserts a source attempt with type/provider and bounded error fields', async () => {
    const { SourceFetchAttemptStore } = await import('../pipeline-ledger');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '21' }] });
    const store = new SourceFetchAttemptStore('postgresql://localhost/test');
    const id = await store.record({
      sourceId: 9,
      sourceType: 'twitter',
      provider: 'twitterapi',
      startedAt: new Date('2026-08-28T10:00:00Z'),
      finishedAt: new Date('2026-08-28T10:00:01Z'),
      ok: false,
      itemCount: 0,
      error: { status: 429, message: 'rate limit body={"tweets":[1]}' },
    });
    expect(id).toBe(21);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO source_fetch_attempts/i);
    expect(params[0]).toBe(9);
    expect(params).toContain('twitter');
    expect(params).toContain('twitterapi');
    expect(params).toContain('rate_limit');
    expect(JSON.stringify(params)).not.toMatch(/tweets/);
  });

  it('rejects empty source_type and negative or nonfinite item_count before insert', async () => {
    const { SourceFetchAttemptStore } = await import('../pipeline-ledger');
    const store = new SourceFetchAttemptStore('postgresql://localhost/test');
    await expect(store.record({
      sourceId: 9,
      sourceType: '   ',
      startedAt: new Date('2026-08-28T10:00:00Z'),
      ok: true,
    })).rejects.toThrow(/source_type/i);
    await expect(store.record({
      sourceId: 9,
      sourceType: 'twitter',
      startedAt: new Date('2026-08-28T10:00:00Z'),
      ok: true,
      itemCount: -3,
    })).rejects.toThrow(/item_count/i);
    await expect(store.record({
      sourceId: 9,
      sourceType: 'twitter',
      startedAt: new Date('2026-08-28T10:00:00Z'),
      ok: true,
      itemCount: Number.POSITIVE_INFINITY,
    })).rejects.toThrow(/item_count/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('supports latest success/failure and consecutive_failures query', async () => {
    const { SourceFetchAttemptStore } = await import('../pipeline-ledger');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '1', ok: true, item_count: 4 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '2', ok: false, error_class: 'dns' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ consecutive_failures: '3' }] });
    const store = new SourceFetchAttemptStore('postgresql://localhost/test');

    const success = await store.latestSuccess(9);
    expect(success?.ok).toBe(true);
    expect(mockQuery.mock.calls[0][0]).toMatch(/ok\s*=\s*true/i);
    expect(mockQuery.mock.calls[0][0]).toMatch(/source_id\s*=\s*\$1/i);

    const failure = await store.latestFailure(9);
    expect(failure?.errorClass).toBe('dns');
    expect(mockQuery.mock.calls[1][0]).toMatch(/ok\s*=\s*false/i);

    const consecutive = await store.consecutiveFailures(9);
    expect(consecutive).toBe(3);
    const sql = mockQuery.mock.calls[2][0] as string;
    expect(sql).toMatch(/consecutive_failures/i);
    expect(sql).toMatch(/source_id/i);
    expect(sql).toMatch(/ok\s*=\s*true/i);
  });
});

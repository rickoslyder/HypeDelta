/**
 * Packet 1: sanitized model_attempts ledger.
 * PostgreSQL is mocked; no live database.
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
  'schema',
  'model_mismatch',
  'provider',
  'internal',
  'unknown',
] as const;

function validReceipt(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'filter',
    requestedProvider: 'deepseek',
    requestedModel: 'deepseek-v4-flash',
    effectiveProvider: 'deepseek',
    effectiveModel: 'deepseek-v4-flash',
    credentialClass: 'deepseek_api_key',
    promptVersion: '1',
    promptHash: 'a'.repeat(64),
    startedAt: new Date('2026-08-30T12:00:00.000Z'),
    finishedAt: new Date('2026-08-30T12:00:00.040Z'),
    latencyMs: 40,
    ok: true,
    errorClass: null,
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    ...overrides,
  };
}

describe('PostgresModelAttemptStore', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = new pg.Pool({ connectionString: 'mock://test' }).query as ReturnType<typeof vi.fn>;
  });

  it('inserts only sanitized receipt columns and never binds secrets, prompts, or provider bodies', async () => {
    const { PostgresModelAttemptStore } = await import('../model-attempt-ledger');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '31' }] });
    const store = new PostgresModelAttemptStore('postgresql://localhost/test');
    const id = await store.record(
      validReceipt({
        // extra fields that must never be persisted
        apiKey: 'ds-test-key',
        prompt: 'rendered prompt with source text',
        sourceText: 'secret-source-text',
        rawResponseBody: '{"error":"upstream token=sekrit"}',
        errorMessage: 'GLM API error body={"token":"sekrit"}',
        authorization: 'Bearer ds-test-key',
      }) as never,
    );
    expect(id).toBe(31);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO model_attempts/i);
    expect(sql).toMatch(/stage/);
    expect(sql).toMatch(/requested_provider/);
    expect(sql).toMatch(/requested_model/);
    expect(sql).toMatch(/effective_provider/);
    expect(sql).toMatch(/effective_model/);
    expect(sql).toMatch(/credential_class/);
    expect(sql).toMatch(/prompt_version/);
    expect(sql).toMatch(/prompt_hash/);
    expect(sql).toMatch(/started_at/);
    expect(sql).toMatch(/finished_at/);
    expect(sql).toMatch(/latency_ms/);
    expect(sql).toMatch(/\bok\b/);
    expect(sql).toMatch(/error_class/);
    expect(sql).toMatch(/prompt_tokens/);
    expect(sql).toMatch(/completion_tokens/);
    expect(sql).toMatch(/total_tokens/);
    expect(sql).not.toMatch(/error_message/i);
    expect(sql).not.toMatch(/raw_response/i);
    expect(sql).not.toMatch(/prompt_text/i);
    expect(sql).not.toMatch(/source_text/i);
    expect(sql).not.toMatch(/\bJSONB\b/i);
    expect(params).toContain('filter');
    expect(params).toContain('deepseek');
    expect(params).toContain('deepseek-v4-flash');
    expect(params).toContain('deepseek_api_key');
    expect(params).toContain('1');
    expect(params).toContain('a'.repeat(64));
    expect(params).toContain(true);
    expect(params).toContain(10);
    expect(params).toContain(4);
    expect(params).toContain(14);
    const serialized = JSON.stringify(params);
    expect(serialized).not.toMatch(/ds-test-key/);
    expect(serialized).not.toMatch(/rendered prompt/);
    expect(serialized).not.toMatch(/secret-source-text/);
    expect(serialized).not.toMatch(/token=sekrit/);
    expect(serialized).not.toMatch(/Bearer /);
    expect(serialized).not.toMatch(/error_message/);
  });

  it('allows null effective model and usage on failure receipts', async () => {
    const { PostgresModelAttemptStore } = await import('../model-attempt-ledger');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '32' }] });
    const store = new PostgresModelAttemptStore('postgresql://localhost/test');
    await store.record(
      validReceipt({
        ok: false,
        errorClass: 'timeout',
        effectiveProvider: null,
        effectiveModel: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      }),
    );
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(false);
    expect(params).toContain('timeout');
    expect(params).toContain(null);
  });

  it('surfaces receipt insert failure to the caller', async () => {
    const { PostgresModelAttemptStore } = await import('../model-attempt-ledger');
    mockQuery.mockRejectedValueOnce(new Error('insert failed'));
    const store = new PostgresModelAttemptStore('postgresql://localhost/test');
    await expect(store.record(validReceipt())).rejects.toThrow(/insert failed/);
  });
});

describe('modelAttemptsSql', () => {
  it('emits additive model_attempts SQL with strict CHECKs and no payload columns', async () => {
    const { modelAttemptsSql, MODEL_ERROR_CLASSES } = await import('../model-attempt-ledger');
    const sql = modelAttemptsSql();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS model_attempts/i);
    expect(sql).not.toMatch(/error_message/i);
    expect(sql).not.toMatch(/\bJSONB\b/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect([...MODEL_ERROR_CLASSES]).toEqual([...ERROR_CLASSES]);
    for (const cls of ERROR_CLASSES) {
      expect(sql).toContain(`'${cls}'`);
    }
  });
});

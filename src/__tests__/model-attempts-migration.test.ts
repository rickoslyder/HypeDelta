/**
 * Packet 1: additive 009 model_attempts migration.
 */
import { describe, it, expect } from 'vitest';

describe('009 model_attempts migration', () => {
  it('is the next additive catalog entry after 008 and keeps 001..009 ordered', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.slice(0, 9)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009']);
    expect(versions).toEqual([...versions].sort());
    expect(versions).toContain('010');
    const m009 = MIGRATIONS.find((m) => m.version === '009');
    expect(m009).toBeDefined();
    expect(m009!.name).toMatch(/model_attempts/i);
  });

  it('creates model_attempts with strict CHECKs, indexes, and no error payload columns', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const { modelAttemptsSql } = await import('../model-attempt-ledger');
    const m009 = MIGRATIONS.find((m) => m.version === '009')!;
    expect(m009.sql).toBe(modelAttemptsSql());
    const sql = m009.sql;

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS model_attempts/i);
    expect(sql).toMatch(/stage VARCHAR\(32\) NOT NULL/i);
    expect(sql).toMatch(/requested_provider VARCHAR\(32\) NOT NULL/i);
    expect(sql).toMatch(/requested_model VARCHAR\(64\) NOT NULL/i);
    expect(sql).toMatch(/effective_provider VARCHAR\(32\)/i);
    expect(sql).toMatch(/effective_model VARCHAR\(64\)/i);
    expect(sql).toMatch(/credential_class VARCHAR\(32\) NOT NULL/i);
    expect(sql).toMatch(/prompt_version VARCHAR\(64\) NOT NULL/i);
    expect(sql).toMatch(/prompt_hash CHAR\(64\) NOT NULL/i);
    expect(sql).toMatch(/started_at TIMESTAMPTZ NOT NULL/i);
    expect(sql).toMatch(/finished_at TIMESTAMPTZ NOT NULL/i);
    expect(sql).toMatch(/latency_ms INT NOT NULL/i);
    expect(sql).toMatch(/ok BOOLEAN NOT NULL/i);
    expect(sql).toMatch(/error_class VARCHAR\(32\)/i);
    expect(sql).toMatch(/prompt_tokens INT/i);
    expect(sql).toMatch(/completion_tokens INT/i);
    expect(sql).toMatch(/total_tokens INT/i);

    expect(sql).toMatch(/'filter'/);
    expect(sql).toMatch(/'extraction'/);
    expect(sql).toMatch(/'quote_backfill'/);
    expect(sql).toMatch(/'synthesis'/);
    expect(sql).toMatch(/'hype_assessment'/);
    expect(sql).toMatch(/'digest'/);
    expect(sql).toMatch(/'deepseek_api_key'/);
    expect(sql).toMatch(/'kimi_code_subscription'/);

    expect(sql).toMatch(/latency_ms\s*>=\s*0/i);
    expect(sql).toMatch(/prompt_tokens IS NULL OR prompt_tokens >= 0/i);
    expect(sql).toMatch(/completion_tokens IS NULL OR completion_tokens >= 0/i);
    expect(sql).toMatch(/total_tokens IS NULL OR total_tokens >= 0/i);
    expect(sql).toMatch(/prompt_hash\s*~\s*'\[\^0-9a-f\]\{64\}'/i);
    expect(sql).toMatch(/char_length\s*\(\s*btrim\s*\(\s*prompt_version\s*\)\s*\)\s*>\s*0/i);
    expect(sql).toMatch(/char_length\s*\(\s*btrim\s*\(\s*requested_provider\s*\)\s*\)\s*>\s*0/i);
    expect(sql).toMatch(/char_length\s*\(\s*btrim\s*\(\s*requested_model\s*\)\s*\)\s*>\s*0/i);

    expect(sql).toMatch(/ok\s*=\s*true/i);
    expect(sql).toMatch(/error_class IS NULL/i);
    expect(sql).toMatch(/effective_provider IS NOT NULL/i);
    expect(sql).toMatch(/effective_model IS NOT NULL/i);
    expect(sql).toMatch(/effective_provider\s*=\s*requested_provider/i);
    expect(sql).toMatch(/effective_model\s*=\s*requested_model/i);
    expect(sql).toMatch(/ok\s*=\s*false/i);
    expect(sql).toMatch(/error_class IS NOT NULL/i);

    expect(sql).toMatch(/idx_model_attempts_started/i);
    expect(sql).toMatch(/model_attempts\s*\(\s*started_at\s+DESC\s*,\s*id\s+DESC\s*\)/i);
    expect(sql).toMatch(/idx_model_attempts_stage_started/i);
    expect(sql).toMatch(/model_attempts\s*\(\s*stage\s*,\s*started_at\s+DESC\s*\)/i);
    expect(sql).toMatch(/idx_model_attempts_failures/i);
    expect(sql).toMatch(/WHERE\s+ok\s*=\s*false/i);

    expect(sql).not.toMatch(/error_message/i);
    expect(sql).not.toMatch(/\bJSONB\b/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });
});

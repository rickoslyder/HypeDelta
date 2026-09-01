/**
 * Sanitized append-only model_attempts ledger.
 * Never persist prompts, source text, raw provider bodies, or keys.
 */
import pg from 'pg';

const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;

export const MODEL_ERROR_CLASSES = [
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

export type ModelErrorClass = (typeof MODEL_ERROR_CLASSES)[number];

export interface ModelAttemptReceipt {
  stage: string;
  requestedProvider: string;
  requestedModel: string;
  effectiveProvider: string | null;
  effectiveModel: string | null;
  credentialClass: string;
  promptVersion: string;
  promptHash: string;
  startedAt: Date;
  finishedAt: Date;
  latencyMs: number;
  ok: boolean;
  errorClass: ModelErrorClass | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  [key: string]: unknown;
}

export interface ModelAttemptStore {
  record(receipt: ModelAttemptReceipt): Promise<number>;
}

const ERROR_CLASS_SQL = MODEL_ERROR_CLASSES.map((cls) => `'${cls}'`).join(', ');

export function modelAttemptsSql(): string {
  return `
-- model_attempts ledger (009)
CREATE TABLE IF NOT EXISTS model_attempts (
  id BIGSERIAL PRIMARY KEY,
  stage VARCHAR(32) NOT NULL,
  requested_provider VARCHAR(32) NOT NULL,
  requested_model VARCHAR(64) NOT NULL,
  effective_provider VARCHAR(32),
  effective_model VARCHAR(64),
  credential_class VARCHAR(32) NOT NULL,
  prompt_version VARCHAR(64) NOT NULL,
  prompt_hash CHAR(64) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  latency_ms INT NOT NULL,
  ok BOOLEAN NOT NULL,
  error_class VARCHAR(32),
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  CONSTRAINT model_attempts_stage_check CHECK (
    stage IN ('filter', 'extraction', 'quote_backfill', 'synthesis', 'hype_assessment', 'digest')
  ),
  CONSTRAINT model_attempts_credential_class_check CHECK (
    credential_class IN ('deepseek_api_key', 'kimi_code_subscription')
  ),
  CONSTRAINT model_attempts_error_class_check CHECK (
    error_class IS NULL OR error_class IN (${ERROR_CLASS_SQL})
  ),
  CONSTRAINT model_attempts_latency_check CHECK (latency_ms >= 0),
  CONSTRAINT model_attempts_prompt_tokens_check CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  CONSTRAINT model_attempts_completion_tokens_check CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  CONSTRAINT model_attempts_total_tokens_check CHECK (total_tokens IS NULL OR total_tokens >= 0),
  CONSTRAINT model_attempts_prompt_hash_check CHECK (
    prompt_hash ~ '^[0-9a-f]{64}$'
    AND NOT (prompt_hash ~ '[^0-9a-f]{64}')
  ),
  CONSTRAINT model_attempts_prompt_version_check CHECK (
    char_length(btrim(prompt_version)) > 0
  ),
  CONSTRAINT model_attempts_requested_provider_check CHECK (
    char_length(btrim(requested_provider)) > 0
  ),
  CONSTRAINT model_attempts_requested_model_check CHECK (
    char_length(btrim(requested_model)) > 0
  ),
  CONSTRAINT model_attempts_ok_check CHECK (
    (
      ok = true
      AND error_class IS NULL
      AND effective_provider IS NOT NULL
      AND effective_model IS NOT NULL
      AND effective_provider = requested_provider
      AND effective_model = requested_model
    )
    OR
    (
      ok = false
      AND error_class IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_model_attempts_started
  ON model_attempts (started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_model_attempts_stage_started
  ON model_attempts (stage, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_attempts_failures
  ON model_attempts (started_at DESC)
  WHERE ok = false;
`.trim();
}

export class PostgresModelAttemptStore implements ModelAttemptStore {
  private pool: PoolType;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  async record(receipt: ModelAttemptReceipt): Promise<number> {
    const result = await this.pool.query(
      `
      INSERT INTO model_attempts (
        stage,
        requested_provider,
        requested_model,
        effective_provider,
        effective_model,
        credential_class,
        prompt_version,
        prompt_hash,
        started_at,
        finished_at,
        latency_ms,
        ok,
        error_class,
        prompt_tokens,
        completion_tokens,
        total_tokens
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
      RETURNING id
      `,
      [
        receipt.stage,
        receipt.requestedProvider,
        receipt.requestedModel,
        receipt.effectiveProvider,
        receipt.effectiveModel,
        receipt.credentialClass,
        receipt.promptVersion,
        receipt.promptHash,
        receipt.startedAt,
        receipt.finishedAt,
        receipt.latencyMs,
        receipt.ok,
        receipt.errorClass,
        receipt.promptTokens,
        receipt.completionTokens,
        receipt.totalTokens,
      ],
    );
    return Number(result.rows[0].id);
  }
}

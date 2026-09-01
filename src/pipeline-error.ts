/**
 * Bounded pipeline/fetch error classification and sanitization.
 * Used by observability ledgers; never store secrets, stacks, or bodies.
 */

export const PIPELINE_ERROR_CLASSES = [
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

export type PipelineErrorClass = (typeof PIPELINE_ERROR_CLASSES)[number];

export const ERROR_MESSAGE_MAX_CHARS = 500;
export const JSONB_MAX_BYTES = 4096;
export const TASK_NAME_MAX_CHARS = 128;
export const SOURCE_TYPE_MAX_CHARS = 50;
export const PROVIDER_MAX_CHARS = 64;
export const ERROR_CLASS_MAX_CHARS = 32;

const ERROR_CLASS_SQL = PIPELINE_ERROR_CLASSES.map((cls) => `'${cls}'`).join(', ');

interface ErrorShape {
  name?: string;
  message?: string;
  code?: string;
  status?: number;
}

function asErrorShape(err: unknown): ErrorShape | null {
  if (err == null || typeof err !== 'object') return null;
  const o = err as Record<string, unknown>;
  const statusRaw = o.status ?? o.statusCode;
  const status = typeof statusRaw === 'number' ? statusRaw : undefined;
  return {
    name: typeof o.name === 'string' ? o.name : undefined,
    message: typeof o.message === 'string' ? o.message : undefined,
    code: typeof o.code === 'string' || typeof o.code === 'number' ? String(o.code) : undefined,
    status,
  };
}

export function classifyPipelineError(err: unknown): PipelineErrorClass {
  if (err == null || typeof err === 'string' || typeof err === 'number' || typeof err === 'boolean') {
    return 'unknown';
  }
  const shape = asErrorShape(err);
  if (!shape) return 'unknown';

  const code = (shape.code ?? '').toUpperCase();
  const name = shape.name ?? '';
  const message = (shape.message ?? '').toLowerCase();
  const status = shape.status;

  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EAI_FAIL' ||
    code === 'EAI_NODATA' ||
    /getaddrinfo|enotfound|eai_again/.test(message)
  ) {
    return 'dns';
  }
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'ABORT_ERR' ||
    /\btimeout\b|\btimed out\b|\baborted\b/.test(message)
  ) {
    return 'timeout';
  }
  if (status === 429 || /\brate[_\s-]?limit/.test(message)) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status !== undefined && status >= 400 && status < 500) return 'http_4xx';
  if (status !== undefined && status >= 500 && status < 600) return 'http_5xx';
  if (
    name === 'SyntaxError' ||
    /\binvalid json\b|\bjson\.parse\b|\bunexpected token\b|\bparse\b/.test(message)
  ) {
    return 'parse';
  }
  if (
    /^(28P01|28P03|57P01|53300|08001|08006|08P01)$/i.test(code) ||
    /\bpassword authentication\b|\bpostgres\b|\bdatabase\b/.test(message)
  ) {
    return 'database';
  }
  if (
    /\btwitterapi\b|\bprovider\b|\bsubstack\b|\byoutube\b|\bopenai\b/.test(message)
  ) {
    return 'provider';
  }
  if (err instanceof Error) return 'internal';
  return 'unknown';
}

export function redactSensitiveText(raw: string): string {
  let s = String(raw ?? '');
  s = s.replace(/\b(?:postgresql|postgres):\/\/\S+/gi, '[redacted-db]');
  s = s.replace(/\bBearer\s+\S+/gi, '[redacted]');
  s = s.replace(/\b(?:token|api[_-]?key|secret|password)\s*=\s*\S+/gi, '[redacted]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
  s = s.replace(/\?[^\s]+/g, '');
  s = s.replace(/^\s*at\s+\S.*$/gm, '');
  s = s.replace(/\bbody\s*[:=]\s*\{[\s\S]*$/gi, '[redacted-body]');
  s = s.replace(/\{[^{}]*"(?:content|body|tweets|data)"[\s\S]*$/gi, '[redacted-body]');
  s = s.replace(/\{[^{}]*\}/g, '[redacted-json]');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function sanitizePipelineErrorMessage(raw: string): string {
  let s = redactSensitiveText(raw);
  if (s.length > ERROR_MESSAGE_MAX_CHARS) {
    s = s.slice(0, ERROR_MESSAGE_MAX_CHARS);
  }
  return s;
}

const JSONB_DROP_KEY_RE = /^(?:stack|body|content|tweets)$/i;
const JSONB_SECRET_KEY_RE =
  /api[_-]?key|token|secret|password|passwd|authorization|bearer|credential/i;
const JSONB_MAX_DEPTH = 16;

function sanitizeJsonbNode(value: unknown, depth: number): unknown {
  if (depth > JSONB_MAX_DEPTH) return undefined;
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonbNode(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (JSONB_DROP_KEY_RE.test(key) || JSONB_SECRET_KEY_RE.test(key)) continue;
      const sanitized = sanitizeJsonbNode(child, depth + 1);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  return undefined;
}

export function sanitizeJsonbPayload(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const sanitized = sanitizeJsonbNode(value, 0);
  const obj =
    sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : {};
  try {
    const encoded = JSON.stringify(obj);
    if (Buffer.byteLength(encoded, 'utf8') <= JSONB_MAX_BYTES) {
      return JSON.parse(encoded) as Record<string, unknown>;
    }
  } catch {
    return { _truncated: true };
  }
  return { _truncated: true };
}

export function boundTaskName(name: string): string {
  const bounded = String(name ?? '').trim().slice(0, TASK_NAME_MAX_CHARS);
  if (!bounded) {
    throw new Error('task_name must be non-empty');
  }
  return bounded;
}

export function boundSourceType(type: string): string {
  const bounded = String(type ?? '').trim().slice(0, SOURCE_TYPE_MAX_CHARS);
  if (!bounded) {
    throw new Error('source_type must be non-empty');
  }
  return bounded;
}

export function normalizeItemCount(value: unknown): number {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('item_count must be a finite nonnegative integer');
  }
  return Math.trunc(value);
}

export function pipelineObservabilitySql(): string {
  return `
-- pipeline_runs + source_fetch_attempts ledgers (008)
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id BIGSERIAL PRIMARY KEY,
  task_name VARCHAR(${TASK_NAME_MAX_CHARS}) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  ok BOOLEAN NOT NULL,
  error_class VARCHAR(${ERROR_CLASS_MAX_CHARS}),
  error_message VARCHAR(${ERROR_MESSAGE_MAX_CHARS}),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT pipeline_runs_error_class_check CHECK (
    error_class IS NULL OR error_class IN (${ERROR_CLASS_SQL})
  ),
  CONSTRAINT pipeline_runs_counts_size_check CHECK (
    octet_length(counts::text) <= ${JSONB_MAX_BYTES}
  ),
  CONSTRAINT pipeline_runs_metadata_size_check CHECK (
    octet_length(metadata::text) <= ${JSONB_MAX_BYTES}
  ),
  CONSTRAINT pipeline_runs_task_name_nonempty_check CHECK (
    char_length(btrim(task_name)) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task_started
  ON pipeline_runs (task_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_recent_failures
  ON pipeline_runs (started_at DESC)
  WHERE ok = false;

CREATE TABLE IF NOT EXISTS source_fetch_attempts (
  id BIGSERIAL PRIMARY KEY,
  source_id INT NOT NULL REFERENCES sources(id),
  source_type VARCHAR(${SOURCE_TYPE_MAX_CHARS}) NOT NULL,
  provider VARCHAR(${PROVIDER_MAX_CHARS}),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  ok BOOLEAN NOT NULL,
  item_count INT NOT NULL DEFAULT 0,
  error_class VARCHAR(${ERROR_CLASS_MAX_CHARS}),
  error_message VARCHAR(${ERROR_MESSAGE_MAX_CHARS}),
  CONSTRAINT source_fetch_attempts_error_class_check CHECK (
    error_class IS NULL OR error_class IN (${ERROR_CLASS_SQL})
  ),
  CONSTRAINT source_fetch_attempts_error_message_size_check CHECK (
    char_length(COALESCE(error_message, '')) <= ${ERROR_MESSAGE_MAX_CHARS}
  ),
  CONSTRAINT source_fetch_attempts_source_type_nonempty_check CHECK (
    char_length(btrim(source_type)) > 0
  ),
  CONSTRAINT source_fetch_attempts_item_count_check CHECK (item_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_fetch_attempts_latest_success
  ON source_fetch_attempts (source_id, started_at DESC)
  WHERE ok = true;

CREATE INDEX IF NOT EXISTS idx_source_fetch_attempts_latest_failure
  ON source_fetch_attempts (source_id, started_at DESC)
  WHERE ok = false;
`.trim();
}

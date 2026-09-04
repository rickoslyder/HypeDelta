/**
 * Focused store APIs for pipeline_runs and source_fetch_attempts.
 * Scheduler/fetcher wiring is out of scope for packet 12A.
 */
import pg from 'pg';
import {
  boundSourceType,
  boundTaskName,
  classifyPipelineError,
  normalizeItemCount,
  sanitizeJsonbPayload,
  sanitizePipelineErrorMessage,
  type PipelineErrorClass,
} from './pipeline-error';

const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;

export interface PipelineRunRecordInput {
  taskName: string;
  startedAt: Date;
  finishedAt?: Date | null;
  ok: boolean;
  error?: unknown;
  counts?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PipelineRunRow {
  id: number;
  taskName: string;
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean;
  errorClass: PipelineErrorClass | null;
  errorMessage: string | null;
  counts: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface SourceFetchAttemptInput {
  sourceId: number;
  sourceType: string;
  provider?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
  ok: boolean;
  itemCount?: number;
  error?: unknown;
}

export interface SourceFetchAttemptRow {
  id: number;
  sourceId: number;
  sourceType: string;
  provider: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean;
  itemCount: number;
  errorClass: PipelineErrorClass | null;
  errorMessage: string | null;
}

function classifiedFields(ok: boolean, error: unknown): {
  errorClass: PipelineErrorClass | null;
  errorMessage: string | null;
} {
  if (ok || error == null) {
    return { errorClass: null, errorMessage: null };
  }
  const errorClass = classifyPipelineError(error);
  const raw =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : String(error);
  const errorMessage = sanitizePipelineErrorMessage(raw);
  return { errorClass, errorMessage: errorMessage || null };
}

function mapPipelineRun(row: Record<string, unknown>): PipelineRunRow {
  return {
    id: Number(row.id),
    taskName: String(row.task_name),
    startedAt: row.started_at as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
    ok: Boolean(row.ok),
    errorClass: (row.error_class as PipelineErrorClass | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    counts: (row.counts as Record<string, unknown>) ?? {},
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

function mapSourceAttempt(row: Record<string, unknown>): SourceFetchAttemptRow {
  return {
    id: Number(row.id),
    sourceId: Number(row.source_id),
    sourceType: String(row.source_type),
    provider: (row.provider as string | null) ?? null,
    startedAt: row.started_at as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
    ok: Boolean(row.ok),
    itemCount: Number(row.item_count ?? 0),
    errorClass: (row.error_class as PipelineErrorClass | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
  };
}

export class PipelineRunStore {
  private pool: PoolType;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async record(input: PipelineRunRecordInput): Promise<number> {
    const { errorClass, errorMessage } = classifiedFields(input.ok, input.error);
    const counts = sanitizeJsonbPayload(input.counts ?? {});
    const metadata = sanitizeJsonbPayload(input.metadata ?? {});
    const result = await this.pool.query(
      `
      INSERT INTO pipeline_runs (
        task_name, started_at, finished_at, ok, error_class, error_message, counts, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      [
        boundTaskName(input.taskName),
        input.startedAt,
        input.finishedAt ?? null,
        input.ok,
        errorClass,
        errorMessage,
        counts,
        metadata,
      ],
    );
    return Number(result.rows[0].id);
  }

  async latestForTask(taskName: string): Promise<PipelineRunRow | null> {
    const result = await this.pool.query(
      `
      SELECT id, task_name, started_at, finished_at, ok, error_class, error_message, counts, metadata
      FROM pipeline_runs
      WHERE task_name = $1
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [taskName],
    );
    const row = result.rows[0];
    return row ? mapPipelineRun(row) : null;
  }

  async recentFailures(limit = 20): Promise<PipelineRunRow[]> {
    const result = await this.pool.query(
      `
      SELECT id, task_name, started_at, finished_at, ok, error_class, error_message, counts, metadata
      FROM pipeline_runs
      WHERE ok = false
      ORDER BY started_at DESC, id DESC
      LIMIT $1
      `,
      [limit],
    );
    return result.rows.map((row) => mapPipelineRun(row));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class SourceFetchAttemptStore {
  private pool: PoolType;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async record(input: SourceFetchAttemptInput): Promise<number> {
    const { errorClass, errorMessage } = classifiedFields(input.ok, input.error);
    const result = await this.pool.query(
      `
      INSERT INTO source_fetch_attempts (
        source_id, source_type, provider, started_at, finished_at, ok, item_count, error_class, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
      `,
      [
        input.sourceId,
        boundSourceType(input.sourceType),
        input.provider == null ? null : String(input.provider).slice(0, 64),
        input.startedAt,
        input.finishedAt ?? null,
        input.ok,
        normalizeItemCount(input.itemCount),
        errorClass,
        errorMessage,
      ],
    );
    return Number(result.rows[0].id);
  }

  async latestSuccess(sourceId: number): Promise<SourceFetchAttemptRow | null> {
    const result = await this.pool.query(
      `
      SELECT id, source_id, source_type, provider, started_at, finished_at, ok, item_count, error_class, error_message
      FROM source_fetch_attempts
      WHERE source_id = $1 AND ok = true
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [sourceId],
    );
    const row = result.rows[0];
    return row ? mapSourceAttempt(row) : null;
  }

  async latestFailure(sourceId: number): Promise<SourceFetchAttemptRow | null> {
    const result = await this.pool.query(
      `
      SELECT id, source_id, source_type, provider, started_at, finished_at, ok, item_count, error_class, error_message
      FROM source_fetch_attempts
      WHERE source_id = $1 AND ok = false
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [sourceId],
    );
    const row = result.rows[0];
    return row ? mapSourceAttempt(row) : null;
  }

  async consecutiveFailures(sourceId: number): Promise<number> {
    const result = await this.pool.query(
      `
      SELECT COUNT(*)::int AS consecutive_failures
      FROM source_fetch_attempts a
      WHERE a.source_id = $1
        AND a.ok = false
        AND a.started_at > COALESCE(
          (SELECT MAX(s.started_at)
           FROM source_fetch_attempts s
           WHERE s.source_id = $1 AND s.ok = true),
          '-infinity'::timestamptz
        )
      `,
      [sourceId],
    );
    return Number(result.rows[0]?.consecutive_failures ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

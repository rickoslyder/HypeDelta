/**
 * Worker heartbeat writer — container-local atomic v2 status file.
 * Default path: /tmp/hypedelta-worker-heartbeat.json (no volume required).
 *
 * Interval writes refresh process `timestamp` only and must not clobber
 * pipeline fields (last_success_at, consecutive_failures, ...).
 */
import {
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  PIPELINE_ERROR_CLASSES,
  TASK_NAME_MAX_CHARS,
  type PipelineErrorClass,
} from './pipeline-error';

export const DEFAULT_HEARTBEAT_PATH = '/tmp/hypedelta-worker-heartbeat.json';
/** Refresh interval for periodic heartbeat writes. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const isoTimestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)));

export const heartbeatV2Schema = z.object({
  status: z.enum(['starting', 'running', 'failed']),
  timestamp: isoTimestamp,
  started_at: isoTimestamp,
  last_success_at: isoTimestamp.nullable(),
  last_fetch_success_at: isoTimestamp.nullable(),
  error_class: z.enum(PIPELINE_ERROR_CLASSES).nullable(),
  last_task: z.string().max(TASK_NAME_MAX_CHARS).nullable(),
  consecutive_failures: z.number().int().nonnegative(),
});

const heartbeatLegacySchema = z.object({
  status: z.literal('running'),
  timestamp: isoTimestamp,
});

export type HeartbeatPayload = z.infer<typeof heartbeatV2Schema>;
export type HeartbeatStatus = HeartbeatPayload['status'];

const V2_ONLY_KEYS = [
  'started_at',
  'last_success_at',
  'last_fetch_success_at',
  'error_class',
  'last_task',
  'consecutive_failures',
] as const;

export type ParsedHeartbeat =
  | { kind: 'v2'; payload: HeartbeatPayload }
  | { kind: 'legacy'; status: 'running'; timestamp: string }
  | { kind: 'invalid' };

export function parseHeartbeatPayload(body: unknown): ParsedHeartbeat {
  if (!body || typeof body !== 'object') return { kind: 'invalid' };
  const rec = body as Record<string, unknown>;
  const hasV2Key = V2_ONLY_KEYS.some((key) => key in rec);
  if (hasV2Key) {
    const parsed = heartbeatV2Schema.safeParse(body);
    return parsed.success ? { kind: 'v2', payload: parsed.data } : { kind: 'invalid' };
  }
  const legacy = heartbeatLegacySchema.safeParse(body);
  if (legacy.success) {
    return {
      kind: 'legacy',
      status: 'running',
      timestamp: legacy.data.timestamp,
    };
  }
  const v2 = heartbeatV2Schema.safeParse(body);
  return v2.success ? { kind: 'v2', payload: v2.data } : { kind: 'invalid' };
}

export function isFetchTaskName(task: string): boolean {
  return task === 'fetch-all' || task.startsWith('fetch-');
}

function boundLastTask(task: string): string {
  const trimmed = String(task ?? '').trim().slice(0, TASK_NAME_MAX_CHARS);
  return trimmed || 'unknown';
}

export function createStartingHeartbeat(now: Date): HeartbeatPayload {
  const ts = now.toISOString();
  return {
    status: 'starting',
    timestamp: ts,
    started_at: ts,
    last_success_at: null,
    last_fetch_success_at: null,
    error_class: null,
    last_task: null,
    consecutive_failures: 0,
  };
}

export interface HeartbeatHandle {
  stop: () => void;
  getState: () => HeartbeatPayload;
  markRunning: () => void;
  markFailed: (errorClass: PipelineErrorClass) => void;
  recordSuccess: (task: string) => void;
  recordFailure: (task: string, errorClass: PipelineErrorClass) => void;
}

export interface StartHeartbeatOptions {
  path?: string;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  now?: () => Date;
}

/**
 * Atomically write a validated v2 heartbeat via temp file + rename.
 * Content is bounded schema fields only (no secrets).
 */
export function writeHeartbeat(filePath: string, payload: HeartbeatPayload): void {
  const parsed = heartbeatV2Schema.safeParse(payload);
  if (!parsed.success) {
    console.error('Heartbeat write failed');
    return;
  }
  const dir = dirname(filePath);
  const tmp = join(dir, `.hb-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(parsed.data), 'utf8');
    renameSync(tmp, filePath);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
    // Generic bounded error — never echo paths that might embed secrets.
    console.error('Heartbeat write failed');
  }
}

/**
 * Write an immediate starting heartbeat, then refresh timestamp on an interval.
 */
export function startHeartbeat(options: StartHeartbeatOptions = {}): HeartbeatHandle {
  const filePath =
    options.path ??
    process.env.WORKER_HEARTBEAT_PATH ??
    DEFAULT_HEARTBEAT_PATH;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const now = options.now ?? (() => new Date());

  let state: HeartbeatPayload = createStartingHeartbeat(now());

  const persist = (): void => {
    writeHeartbeat(filePath, state);
  };

  const touch = (): void => {
    state = { ...state, timestamp: now().toISOString() };
    persist();
  };

  persist();
  const timer = setIntervalFn(() => {
    touch();
  }, intervalMs);

  return {
    stop: () => {
      clearIntervalFn(timer);
    },
    getState: () => ({ ...state }),
    markRunning: () => {
      state = { ...state, status: 'running', timestamp: now().toISOString() };
      persist();
    },
    markFailed: (errorClass: PipelineErrorClass) => {
      state = {
        ...state,
        status: 'failed',
        timestamp: now().toISOString(),
        error_class: errorClass,
        consecutive_failures: state.consecutive_failures + 1,
      };
      persist();
    },
    recordSuccess: (task: string) => {
      const ts = now().toISOString();
      const lastTask = boundLastTask(task);
      state = {
        ...state,
        timestamp: ts,
        last_success_at: ts,
        last_task: lastTask,
        consecutive_failures: 0,
        error_class: null,
        last_fetch_success_at: isFetchTaskName(lastTask) ? ts : state.last_fetch_success_at,
      };
      persist();
    },
    recordFailure: (task: string, errorClass: PipelineErrorClass) => {
      state = {
        ...state,
        timestamp: now().toISOString(),
        last_task: boundLastTask(task),
        error_class: errorClass,
        consecutive_failures: state.consecutive_failures + 1,
      };
      persist();
    },
  };
}

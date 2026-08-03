/**
 * Worker heartbeat writer — container-local atomic status/timestamp file.
 * Default path: /tmp/hypedelta-worker-heartbeat.json (no volume required).
 */
import {
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_HEARTBEAT_PATH = '/tmp/hypedelta-worker-heartbeat.json';
/** Refresh interval for periodic heartbeat writes. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatPayload {
  status: string;
  timestamp: string;
}

export interface HeartbeatHandle {
  stop: () => void;
}

export interface StartHeartbeatOptions {
  path?: string;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  now?: () => Date;
}

/**
 * Atomically write heartbeat via temp file + rename.
 * Content is status + ISO timestamp only (no secrets).
 */
export function writeHeartbeat(
  filePath: string = DEFAULT_HEARTBEAT_PATH,
  now: () => Date = () => new Date(),
): void {
  const payload: HeartbeatPayload = {
    status: 'running',
    timestamp: now().toISOString(),
  };
  const dir = dirname(filePath);
  const tmp = join(dir, `.hb-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
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
 * Write an immediate heartbeat, then refresh on an interval.
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

  writeHeartbeat(filePath, now);
  const timer = setIntervalFn(() => {
    writeHeartbeat(filePath, now);
  }, intervalMs);

  return {
    stop: () => {
      clearIntervalFn(timer);
    },
  };
}

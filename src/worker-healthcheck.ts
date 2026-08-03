#!/usr/bin/env node
/**
 * Worker healthcheck entrypoint — validates heartbeat file age.
 * Exit 0 when fresh/parseable; exit 1 when missing/stale/malformed.
 *
 * Path/max-age injectable via options (tests) or env:
 *   WORKER_HEARTBEAT_PATH
 *   WORKER_HEARTBEAT_MAX_AGE_MS
 * No shell execution of untrusted input.
 */
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { DEFAULT_HEARTBEAT_PATH } from './worker-heartbeat';

/** Tolerate ~4 min synchronous source fetch blocks; still catch a wedged loop. */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 1000;

export interface CheckHeartbeatOptions {
  path?: string;
  maxAgeMs?: number;
  now?: () => Date;
}

export interface CheckHeartbeatResult {
  ok: boolean;
  reason?: string;
}

function resolveMaxAgeMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Validate heartbeat file: parseable JSON with status + timestamp within max age.
 */
export function checkHeartbeat(options: CheckHeartbeatOptions = {}): CheckHeartbeatResult {
  const filePath =
    options.path ??
    process.env.WORKER_HEARTBEAT_PATH ??
    DEFAULT_HEARTBEAT_PATH;
  const maxAgeMs =
    options.maxAgeMs ??
    resolveMaxAgeMs(process.env.WORKER_HEARTBEAT_MAX_AGE_MS, DEFAULT_MAX_AGE_MS);
  const now = options.now ?? (() => new Date());

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'heartbeat missing' };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'heartbeat malformed' };
  }

  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'heartbeat malformed' };
  }

  const rec = body as Record<string, unknown>;
  if (typeof rec.status !== 'string' || typeof rec.timestamp !== 'string') {
    return { ok: false, reason: 'heartbeat malformed' };
  }

  const ts = Date.parse(rec.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'heartbeat malformed' };
  }

  const age = now().getTime() - ts;
  if (age < 0) {
    // Clock skew: treat slightly-future as ok within small bound; else stale-ish.
    if (age < -60_000) {
      return { ok: false, reason: 'heartbeat stale' };
    }
  } else if (age > maxAgeMs) {
    return { ok: false, reason: 'heartbeat stale' };
  }

  return { ok: true };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

function main(): void {
  const result = checkHeartbeat();
  if (!result.ok) {
    // Generic bounded reason only.
    console.error(result.reason ?? 'unhealthy');
    process.exit(1);
  }
  process.exit(0);
}

if (isMainModule()) {
  main();
}

#!/usr/bin/env node
/**
 * Worker healthcheck entrypoint — process freshness, pipeline SLO, required-DNS.
 * Exit 0 when fresh/parseable, pipeline within SLO, and required DNS resolves; exit 1 otherwise.
 *
 * Path/max-age/DNS host/grace/SLO injectable via options (tests) or env:
 *   WORKER_HEARTBEAT_PATH
 *   WORKER_HEARTBEAT_MAX_AGE_MS
 *   WORKER_HEALTH_DNS_HOST  (default api.twitterapi.io; blank disables DNS only)
 *   WORKER_STARTUP_GRACE_MS (default 3h)
 *   WORKER_PIPELINE_SLO_MS  (default 6h)
 * No shell execution of untrusted input. Reasons are generic and bounded.
 */
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  DEFAULT_HEARTBEAT_PATH,
  parseHeartbeatPayload,
} from './worker-heartbeat';

/** Tolerate ~4 min synchronous source fetch blocks; still catch a wedged loop. */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 1000;
/** Compatible with WORKER_RUN_INITIAL_CYCLE=false + 2h processing schedule. */
export const DEFAULT_STARTUP_GRACE_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_PIPELINE_SLO_MS = 6 * 60 * 60 * 1000;
/** Upper bound so misconfig cannot disable liveness/SLO indefinitely. */
export const MAX_BOUNDED_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CheckHeartbeatOptions {
  path?: string;
  maxAgeMs?: number;
  startupGraceMs?: number;
  pipelineSloMs?: number;
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
 * Strict finite integer duration: missing/empty → default; non-finite, < min,
 * or > max → default (fail-closed against disabling SLO/grace).
 */
export function resolveBoundedDurationMs(
  raw: string | undefined,
  fallback: number,
  min = 1,
  max = MAX_BOUNDED_DURATION_MS,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min || i > max) return fallback;
  return i;
}

export function resolveStartupGraceMs(
  raw: string | undefined = process.env.WORKER_STARTUP_GRACE_MS,
): number {
  return resolveBoundedDurationMs(raw, DEFAULT_STARTUP_GRACE_MS);
}

export function resolvePipelineSloMs(
  raw: string | undefined = process.env.WORKER_PIPELINE_SLO_MS,
): number {
  return resolveBoundedDurationMs(raw, DEFAULT_PIPELINE_SLO_MS);
}

function processTimestampAgeOk(timestamp: string, nowMs: number, maxAgeMs: number): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;
  const age = nowMs - ts;
  if (age < 0) {
    return age >= -60_000;
  }
  return age <= maxAgeMs;
}

/**
 * Validate heartbeat file: process freshness plus pipeline state.
 * Internally separates process timestamp from last_success_at / startup grace.
 */
export function checkHeartbeat(options: CheckHeartbeatOptions = {}): CheckHeartbeatResult {
  const filePath =
    options.path ??
    process.env.WORKER_HEARTBEAT_PATH ??
    DEFAULT_HEARTBEAT_PATH;
  const maxAgeMs =
    options.maxAgeMs ??
    resolveMaxAgeMs(process.env.WORKER_HEARTBEAT_MAX_AGE_MS, DEFAULT_MAX_AGE_MS);
  const startupGraceMs =
    options.startupGraceMs ?? resolveStartupGraceMs(process.env.WORKER_STARTUP_GRACE_MS);
  const pipelineSloMs =
    options.pipelineSloMs ?? resolvePipelineSloMs(process.env.WORKER_PIPELINE_SLO_MS);
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();

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

  const parsed = parseHeartbeatPayload(body);
  if (parsed.kind === 'invalid') {
    return { ok: false, reason: 'heartbeat malformed' };
  }

  if (parsed.kind === 'legacy') {
    if (!processTimestampAgeOk(parsed.timestamp, nowMs, maxAgeMs)) {
      return { ok: false, reason: 'heartbeat stale' };
    }
    const started = Date.parse(parsed.timestamp);
    if (nowMs - started > startupGraceMs) {
      return { ok: false, reason: 'startup grace exceeded' };
    }
    return { ok: true };
  }

  const payload = parsed.payload;
  if (!processTimestampAgeOk(payload.timestamp, nowMs, maxAgeMs)) {
    return { ok: false, reason: 'heartbeat stale' };
  }
  if (payload.status === 'failed') {
    return { ok: false, reason: 'heartbeat failed' };
  }

  const startedAt = Date.parse(payload.started_at);
  if (!Number.isFinite(startedAt)) {
    return { ok: false, reason: 'heartbeat malformed' };
  }

  if (payload.last_success_at == null) {
    if (nowMs - startedAt > startupGraceMs) {
      return { ok: false, reason: 'startup grace exceeded' };
    }
    return { ok: true };
  }

  const lastSuccess = Date.parse(payload.last_success_at);
  if (!Number.isFinite(lastSuccess)) {
    return { ok: false, reason: 'heartbeat malformed' };
  }
  if (nowMs - lastSuccess > pipelineSloMs) {
    return { ok: false, reason: 'pipeline stale' };
  }
  return { ok: true };
}

export const DEFAULT_DNS_HOST = 'api.twitterapi.io';
/** Bound required-DNS resolution so Docker HEALTHCHECK cannot hang. */
export const DEFAULT_DNS_TIMEOUT_MS = 5_000;

export interface CheckWorkerHealthOptions extends CheckHeartbeatOptions {
  dnsHost?: string;
  dnsTimeoutMs?: number;
  lookup?: (hostname: string) => Promise<unknown>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeoutFn(() => {
      reject(new Error('timed out'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeoutFn(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeoutFn(timer);
        reject(err);
      },
    );
  });
}

/**
 * Process liveness (heartbeat age) plus pipeline SLO plus required-DNS probe.
 * Failure reason is generic — never leak addresses, resolver text, or exceptions.
 */
export async function checkWorkerHealth(
  options: CheckWorkerHealthOptions = {},
): Promise<CheckHeartbeatResult> {
  const heartbeat = checkHeartbeat(options);
  if (!heartbeat.ok) return heartbeat;

  const host =
    options.dnsHost ?? process.env.WORKER_HEALTH_DNS_HOST ?? DEFAULT_DNS_HOST;
  if (host === '') {
    return { ok: true };
  }
  const lookup = options.lookup ?? ((hostname: string) => dnsLookup(hostname));
  const timeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  try {
    await withTimeout(lookup(host), timeoutMs, setTimeoutFn, clearTimeoutFn);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'required dns unavailable' };
  }
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

export interface HealthcheckIo {
  error: (msg: string) => void;
}

/** CLI exit helper — prints a generic bounded reason, never lookup/exception text. */
export async function runWorkerHealthcheck(
  options: CheckWorkerHealthOptions = {},
  io: HealthcheckIo = { error: (msg) => console.error(msg) },
): Promise<number> {
  const result = await checkWorkerHealth(options);
  if (!result.ok) {
    io.error(result.reason ?? 'unhealthy');
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  process.exit(await runWorkerHealthcheck());
}

if (isMainModule()) {
  void main();
}

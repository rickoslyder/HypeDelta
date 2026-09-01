/**
 * Pure product/pipeline freshness policy.
 * Callers supply persisted timestamps/counts; this module does not touch the DB.
 */

export const SYNTHESIS_STALE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;
export const LARGE_BACKLOG_THRESHOLD = 100;
export const DEFAULT_FETCH_FREQUENCY_HOURS = 24;
export const PIPELINE_SUCCESS_SLO_MS = 6 * 60 * 60 * 1000;

export const PIPELINE_HEALTH_ERROR_CLASSES = [
  "dns",
  "timeout",
  "rate_limit",
  "auth",
  "http_4xx",
  "http_5xx",
  "parse",
  "database",
  "provider",
  "internal",
  "unknown",
] as const;

export type PipelineHealthErrorClass = (typeof PIPELINE_HEALTH_ERROR_CLASSES)[number];

export type FreshnessReasonCode =
  | "SYNTHESIS_MISSING"
  | "SYNTHESIS_STALE"
  | "SOURCES_OVERDUE"
  | "BACKLOG_LARGE"
  | "PIPELINE_NO_RECENT_SUCCESS"
  | "FETCH_NO_RECENT_SUCCESS"
  | "PIPELINE_FAILED";

export type ProductFreshnessLevel = "fresh" | "stale" | "degraded";

export interface ProductFreshnessSource {
  identifier: string;
  type: string;
  last_fetched: string | null;
  fetch_frequency_hours: number | null;
  is_active?: boolean;
}

export interface ProductFreshnessStatus {
  synthesisLatest: string | null;
  unprocessedCount: number;
  activeSources: ProductFreshnessSource[];
  pipelineLatestSuccessAt: string | null;
  pipelineLatestFinishedAt: string | null;
  pipelineLatestOk: boolean | null;
  pipelineLatestErrorClass: string | null;
  fetchLatestSuccessAt: string | null;
}

export interface ProductFreshnessAssessment {
  /** Pipeline liveness for /api/health/pipeline — not process / DB probes. */
  ok: boolean;
  status: ProductFreshnessLevel;
  reasons: FreshnessReasonCode[];
  lastSynthesisDate: string | null;
  pendingCount: number;
  overdueSourceCount: number;
  lastPipelineSuccessAt: string | null;
  lastFetchSuccessAt: string | null;
  errorClass: PipelineHealthErrorClass | null;
}

function cadenceHours(source: ProductFreshnessSource): number {
  const raw = source.fetch_frequency_hours;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_FETCH_FREQUENCY_HOURS;
}

function sourceOverdueGraceMs(cadenceMs: number): number {
  const sixHoursMs = 6 * 60 * 60 * 1000;
  return Math.max(cadenceMs * 2, cadenceMs + sixHoursMs);
}

function isSourceOverdue(source: ProductFreshnessSource, now: Date): boolean {
  if (source.is_active === false) return false;
  if (!source.last_fetched) return true;
  const last = Date.parse(source.last_fetched);
  if (!Number.isFinite(last)) return true;
  const cadenceMs = cadenceHours(source) * 60 * 60 * 1000;
  return now.getTime() - last > sourceOverdueGraceMs(cadenceMs);
}

function isOverdueMaterial(overdueSourceCount: number, activeSourceCount: number): boolean {
  if (overdueSourceCount <= 0) return false;
  return overdueSourceCount >= Math.max(3, Math.ceil(activeSourceCount * 0.1));
}

export function displaySafeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function allowlistedErrorClass(
  value: string | null | undefined,
): PipelineHealthErrorClass | null {
  if (!value) return null;
  return (PIPELINE_HEALTH_ERROR_CLASSES as readonly string[]).includes(value)
    ? (value as PipelineHealthErrorClass)
    : null;
}

function olderThanSlo(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > PIPELINE_SUCCESS_SLO_MS;
}

export function assessProductFreshness(
  status: ProductFreshnessStatus,
  now: Date,
): ProductFreshnessAssessment {
  const reasons: FreshnessReasonCode[] = [];
  const pendingCount = Math.max(0, Math.floor(Number(status.unprocessedCount) || 0));

  if (!status.synthesisLatest) {
    reasons.push("SYNTHESIS_MISSING");
  } else {
    const generated = Date.parse(status.synthesisLatest);
    if (!Number.isFinite(generated) || now.getTime() - generated > SYNTHESIS_STALE_AFTER_MS) {
      reasons.push("SYNTHESIS_STALE");
    }
  }

  const activeSources = (status.activeSources ?? []).filter((s) => s.is_active !== false);
  const overdueSourceCount = activeSources.filter((s) => isSourceOverdue(s, now)).length;
  if (isOverdueMaterial(overdueSourceCount, activeSources.length)) {
    reasons.push("SOURCES_OVERDUE");
  }

  if (pendingCount >= LARGE_BACKLOG_THRESHOLD) {
    reasons.push("BACKLOG_LARGE");
  }

  if (olderThanSlo(status.pipelineLatestSuccessAt, now)) {
    reasons.push("PIPELINE_NO_RECENT_SUCCESS");
  }
  if (olderThanSlo(status.fetchLatestSuccessAt, now)) {
    reasons.push("FETCH_NO_RECENT_SUCCESS");
  }
  if (status.pipelineLatestOk === false) {
    reasons.push("PIPELINE_FAILED");
  }

  const hasStale =
    reasons.includes("SYNTHESIS_MISSING") ||
    reasons.includes("SYNTHESIS_STALE") ||
    reasons.includes("PIPELINE_NO_RECENT_SUCCESS") ||
    reasons.includes("FETCH_NO_RECENT_SUCCESS");
  const hasDegraded =
    reasons.includes("SOURCES_OVERDUE") || reasons.includes("PIPELINE_FAILED");

  let level: ProductFreshnessLevel = "fresh";
  if (hasDegraded) level = "degraded";
  else if (hasStale) level = "stale";

  return {
    ok: level === "fresh",
    status: level,
    reasons,
    lastSynthesisDate: displaySafeDate(status.synthesisLatest),
    pendingCount,
    overdueSourceCount,
    lastPipelineSuccessAt: status.pipelineLatestSuccessAt ?? null,
    lastFetchSuccessAt: status.fetchLatestSuccessAt ?? null,
    errorClass: allowlistedErrorClass(status.pipelineLatestErrorClass),
  };
}

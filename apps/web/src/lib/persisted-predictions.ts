import { researcherPathSegment } from "./claim-href";
import { safeAbsoluteHttpUrl } from "./live-evidence-ledger";
import { publicAuthorLabel } from "@hypedelta/researcher-identity";

export const TARGET_DATE_NOT_NORMALIZED = "Target date not normalized";

export const PREDICTION_PAGE_SIZE_DEFAULT = 20;
export const PREDICTION_PAGE_SIZE_MAX = 50;

export interface PersistedPredictionRowInput {
  id: string;
  prediction_text: string | null;
  status: string | null;
  confidence: number | string | null;
  timeframe: string | null;
  topic: string | null;
  made_at: string | Date | null;
  due_at: string | Date | null;
  verified_at: string | Date | null;
  outcome_summary: string | null;
  evidence: string | null;
  evidence_url: string | null;
  next_observable: string | null;
  next_question: string | null;
  claim_id: string | null;
  claim_text: string | null;
  claim_type: string | null;
  canonical_source_url: string | null;
  original_quote: string | null;
  researcher_slug: string | null;
  researcher_display_name: string | null;
  source_identifier: string | null;
}

export interface PersistedPredictionItem {
  id: string;
  predictionText: string;
  status: string | null;
  confidence: number | null;
  timeframe: string | null;
  topic: string | null;
  madeAt: string | null;
  dueAt: string | null;
  verifiedAt: string | null;
  outcome: string | null;
  evidence: string | null;
  evidenceUrl: string | null;
  nextObservable: string | null;
  nextQuestion: string | null;
  claimId: string | null;
  claimText: string | null;
  claimType: string | null;
  canonicalSourceUrl: string | null;
  originalQuote: string | null;
  researcherSlug: string | null;
  researcherDisplayName: string | null;
  sourceLabel: string;
  targetDateLabel: string;
}

export interface PersistedPredictionSummary {
  tracked: number;
  open: number;
  resolved: number;
  withTargetDate: number;
  withSourceAndQuote: number;
}

export interface PersistedPredictionSummaryCandidate {
  status: string | null;
  due_at: string | Date | null;
  canonical_source_url: string | null;
  original_quote: string | null;
}

export interface PersistedPredictionsResult {
  items: PersistedPredictionItem[];
  total: number;
  page: number;
  pageSize: number;
  topicOptions: string[];
  summary: PersistedPredictionSummary;
}

function blankToNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function toConfidence(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clampPredictionPage(page: unknown): number {
  const n = Math.floor(Number(page));
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export function clampPredictionPageSize(pageSize: unknown): number {
  const n = Math.floor(Number(pageSize));
  if (!Number.isFinite(n) || n < 1) return PREDICTION_PAGE_SIZE_DEFAULT;
  return Math.min(PREDICTION_PAGE_SIZE_MAX, n);
}

const RESOLVED_PREDICTION_STATUSES = new Set(["verified", "falsified", "partially-verified"]);
const OPEN_PREDICTION_STATUSES = new Set(["pending", "too-early"]);

export function summarizePersistedPredictionCandidates(
  rows: readonly PersistedPredictionSummaryCandidate[],
): PersistedPredictionSummary {
  let tracked = 0;
  let open = 0;
  let resolved = 0;
  let withTargetDate = 0;
  let withSourceAndQuote = 0;

  for (const row of rows) {
    tracked += 1;
    const status = blankToNull(row.status);
    if (status == null || OPEN_PREDICTION_STATUSES.has(status)) open += 1;
    if (status != null && RESOLVED_PREDICTION_STATUSES.has(status)) resolved += 1;
    if (row.due_at != null && row.due_at !== "") withTargetDate += 1;
    if (safeAbsoluteHttpUrl(row.canonical_source_url) && blankToNull(row.original_quote)) {
      withSourceAndQuote += 1;
    }
  }

  return { tracked, open, resolved, withTargetDate, withSourceAndQuote };
}

export function formatPredictionTargetDate(dueAt: string | null): string {
  if (!dueAt) return TARGET_DATE_NOT_NORMALIZED;
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) return TARGET_DATE_NOT_NORMALIZED;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

export function mapPersistedPredictionRow(
  row: PersistedPredictionRowInput,
): PersistedPredictionItem {
  const dueAt = toIso(row.due_at);
  const label = publicAuthorLabel({
    displayName: row.researcher_display_name,
    identifier: row.source_identifier,
  });
  const researcherSlug = researcherPathSegment(row.researcher_slug);
  const displayName = blankToNull(row.researcher_display_name);
  const researcherDisplayName =
    displayName && researcherSlug ? displayName : blankToNull(label.displayName);

  return {
    id: String(row.id),
    predictionText: String(row.prediction_text ?? ""),
    status: blankToNull(row.status),
    confidence: toConfidence(row.confidence),
    timeframe: blankToNull(row.timeframe),
    topic: blankToNull(row.topic),
    madeAt: toIso(row.made_at),
    dueAt,
    verifiedAt: toIso(row.verified_at),
    outcome: blankToNull(row.outcome_summary),
    evidence: blankToNull(row.evidence),
    evidenceUrl: safeAbsoluteHttpUrl(row.evidence_url),
    nextObservable: blankToNull(row.next_observable),
    nextQuestion: blankToNull(row.next_question),
    claimId: blankToNull(row.claim_id),
    claimText: blankToNull(row.claim_text),
    claimType: blankToNull(row.claim_type),
    canonicalSourceUrl: safeAbsoluteHttpUrl(row.canonical_source_url),
    originalQuote: blankToNull(row.original_quote),
    researcherSlug,
    researcherDisplayName: researcherSlug ? researcherDisplayName : null,
    sourceLabel: label.displayName,
    targetDateLabel: formatPredictionTargetDate(dueAt),
  };
}

export function predictionsHref(opts: {
  status?: string | null;
  topic?: string | null;
  page?: number | string | null;
}): string {
  const parts: string[] = [];
  const status = blankToNull(opts.status);
  const topic = blankToNull(opts.topic);
  const page = opts.page == null || opts.page === "" ? null : clampPredictionPage(opts.page);
  if (status) parts.push(`status=${encodeURIComponent(status)}`);
  if (topic) parts.push(`topic=${encodeURIComponent(topic)}`);
  if (page && page > 1) parts.push(`page=${page}`);
  return parts.length ? `/predictions?${parts.join("&")}` : "/predictions";
}

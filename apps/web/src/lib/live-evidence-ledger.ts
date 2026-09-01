export interface LiveEvidenceRow {
  id: string;
  claim_text: string;
  claim_type: string | null;
  topic: string | null;
  stance: string | null;
  author_handle: string | null;
  author_name: string | null;
  researcher_slug?: string | null;
  canonical_source_url: string | null;
  original_quote: string | null;
  extracted_at: string | Date | null;
  published_at: string | Date | null;
  prediction_status: string | null;
  prediction_due_at: string | Date | null;
  prediction_outcome_summary: string | null;
  prediction_evidence: string | null;
  prediction_evidence_url: string | null;
  prediction_next_observable: string | null;
  prediction_next_question: string | null;
  prediction_verified_at: string | Date | null;
}

export type LivePresentationStatus =
  | "evidence-only"
  | "pending"
  | "overdue"
  | "verified"
  | "falsified"
  | "partially-verified"
  | "too-early";

export interface LiveEvidenceCard {
  id: string;
  claimText: string;
  claimType: string | null;
  topic: string | null;
  stance: string | null;
  authorHandle: string | null;
  authorName: string | null;
  canonicalSourceUrl: string;
  originalQuote: string;
  extractedAt: string | null;
  publishedAt: string | null;
  presentationStatus: LivePresentationStatus;
  outcomeEvidence: string | null;
  evidenceUrl: string | null;
  targetDate: string | null;
  nextObservable: string | null;
  nextQuestion: string | null;
  predictionStatus: string | null;
  verifiedAt: string | null;
}

export interface LiveLedgerCoverage {
  admittedCount: number;
  quoteBackedCount: number;
  sourceBackedCount: number;
  pendingCount: number;
  overdueCount: number;
  tooEarlyCount: number;
  resolvedCount: number;
  evidenceOnlyCount: number;
}

export interface LiveLedgerSummary {
  admittedCount: number;
  quoteBackedCount: number;
  admittedPredictionCount: number;
  openPredictionCount: number;
  overdueCount: number;
  resolvedCount: number;
  evidenceOnlyCount: number;
}

export interface LiveLedgerSummaryCandidate {
  canonical_source_url: string | null;
  original_quote: string | null;
  claim_type: string | null;
  prediction_status: string | null;
  prediction_due_at: string | Date | null;
}

const RESOLVED_STATUSES = new Set<LivePresentationStatus>([
  "verified",
  "falsified",
  "partially-verified",
]);

function blankToNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function normalizeLedgerCount(value: unknown): number {
  if (value == null || value === "") return 0;
  const n = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export function mapLiveLedgerSummary(
  row: Partial<Record<string, unknown>> | null | undefined,
): LiveLedgerSummary {
  return {
    admittedCount: normalizeLedgerCount(row?.admitted),
    quoteBackedCount: normalizeLedgerCount(row?.quote_backed),
    admittedPredictionCount: normalizeLedgerCount(row?.admitted_prediction),
    openPredictionCount: normalizeLedgerCount(row?.open_prediction),
    overdueCount: normalizeLedgerCount(row?.overdue),
    resolvedCount: normalizeLedgerCount(row?.resolved),
    evidenceOnlyCount: normalizeLedgerCount(row?.evidence_only),
  };
}

const CONTROL_OR_WHITESPACE = /[\s\u0000-\u001F\u007F]/;

export function safeAbsoluteHttpUrl(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (CONTROL_OR_WHITESPACE.test(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (!parsed.hostname) return null;
  return trimmed;
}

function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function asPresentationStatus(value: string | null): LivePresentationStatus | null {
  switch (value) {
    case "pending":
    case "overdue":
    case "verified":
    case "falsified":
    case "partially-verified":
    case "too-early":
    case "evidence-only":
      return value;
    default:
      return null;
  }
}

export function isAdmittedLiveEvidenceRow(row: LiveEvidenceRow): boolean {
  return Boolean(safeAbsoluteHttpUrl(row.canonical_source_url) && blankToNull(row.original_quote));
}

const OPEN_PRESENTATION_STATUSES = new Set<LivePresentationStatus>([
  "pending",
  "too-early",
  "overdue",
]);

function livePresentationStatus(
  claimType: string | null,
  predictionStatus: string | null,
  dueAt: string | Date | null,
  now: Date,
): LivePresentationStatus {
  if (claimType !== "prediction") return "evidence-only";
  const mappedStatus = asPresentationStatus(predictionStatus);
  const targetDate = toIso(dueAt);
  if (mappedStatus === "too-early") return "too-early";
  if (mappedStatus && RESOLVED_STATUSES.has(mappedStatus)) return mappedStatus;
  if (
    targetDate &&
    Date.parse(targetDate) < now.getTime() &&
    (mappedStatus == null || mappedStatus === "pending" || mappedStatus === "overdue")
  ) {
    return "overdue";
  }
  return "pending";
}

export function summarizeLiveLedgerCandidates(
  rows: readonly LiveLedgerSummaryCandidate[],
  now: Date = new Date(),
): LiveLedgerSummary {
  let admittedCount = 0;
  let quoteBackedCount = 0;
  let admittedPredictionCount = 0;
  let openPredictionCount = 0;
  let overdueCount = 0;
  let resolvedCount = 0;
  let evidenceOnlyCount = 0;

  for (const row of rows) {
    if (!safeAbsoluteHttpUrl(row.canonical_source_url) || !blankToNull(row.original_quote)) {
      continue;
    }
    admittedCount += 1;
    quoteBackedCount += 1;
    const claimType = blankToNull(row.claim_type);
    const status = livePresentationStatus(
      claimType,
      blankToNull(row.prediction_status),
      row.prediction_due_at,
      now,
    );
    if (claimType === "prediction") {
      admittedPredictionCount += 1;
      if (status === "overdue") overdueCount += 1;
      if (RESOLVED_STATUSES.has(status)) resolvedCount += 1;
      if (OPEN_PRESENTATION_STATUSES.has(status)) openPredictionCount += 1;
    } else {
      evidenceOnlyCount += 1;
    }
  }

  return {
    admittedCount,
    quoteBackedCount,
    admittedPredictionCount,
    openPredictionCount,
    overdueCount,
    resolvedCount,
    evidenceOnlyCount,
  };
}

export function mapLiveEvidenceRow(
  row: LiveEvidenceRow,
  now: Date = new Date(),
): LiveEvidenceCard {
  const canonicalSourceUrl = safeAbsoluteHttpUrl(row.canonical_source_url) ?? "";
  const originalQuote = blankToNull(row.original_quote) ?? "";
  const claimType = blankToNull(row.claim_type);
  const isPrediction = claimType === "prediction";
  const rawStatus = blankToNull(row.prediction_status);
  const targetDate = isPrediction ? toIso(row.prediction_due_at) : null;
  const presentationStatus = livePresentationStatus(claimType, rawStatus, row.prediction_due_at, now);

  return {
    id: String(row.id),
    claimText: String(row.claim_text ?? ""),
    claimType,
    topic: blankToNull(row.topic),
    stance: blankToNull(row.stance),
    authorHandle: blankToNull(row.researcher_slug) || (
      blankToNull(row.author_handle) && !/^https?:\/\//i.test(String(row.author_handle).trim())
        ? blankToNull(row.author_handle)
        : null
    ),
    authorName: blankToNull(row.author_name),
    canonicalSourceUrl,
    originalQuote,
    extractedAt: toIso(row.extracted_at),
    publishedAt: toIso(row.published_at),
    presentationStatus,
    outcomeEvidence: isPrediction
      ? blankToNull(row.prediction_outcome_summary) ?? blankToNull(row.prediction_evidence)
      : null,
    evidenceUrl: isPrediction ? safeAbsoluteHttpUrl(row.prediction_evidence_url) : null,
    targetDate,
    nextObservable: isPrediction ? blankToNull(row.prediction_next_observable) : null,
    nextQuestion: isPrediction ? blankToNull(row.prediction_next_question) : null,
    predictionStatus: isPrediction ? rawStatus : null,
    verifiedAt: isPrediction ? toIso(row.prediction_verified_at) : null,
  };
}

export function calculateLiveLedgerCoverage(
  cards: LiveEvidenceCard[],
): LiveLedgerCoverage {
  const admittedCount = cards.length;
  return {
    admittedCount,
    quoteBackedCount: cards.filter((card) => blankToNull(card.originalQuote)).length,
    sourceBackedCount: cards.filter((card) => blankToNull(card.canonicalSourceUrl)).length,
    pendingCount: cards.filter((card) => card.presentationStatus === "pending").length,
    overdueCount: cards.filter((card) => card.presentationStatus === "overdue").length,
    tooEarlyCount: cards.filter((card) => card.presentationStatus === "too-early").length,
    resolvedCount: cards.filter((card) => RESOLVED_STATUSES.has(card.presentationStatus)).length,
    evidenceOnlyCount: cards.filter((card) => card.presentationStatus === "evidence-only").length,
  };
}

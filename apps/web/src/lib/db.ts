/**
 * Database connection layer for the web frontend
 *
 * This module provides access to the HypeDelta database stores
 * for use in Next.js API routes and Server Components.
 */

import pg from "pg";
import { isValidClaimId } from "./claim-href";
import {
  authorSideSqlCase,
  authorSideSqlPredicate,
  type AuthorSide,
} from "@hypedelta/author-side";
import { aggregateResearcherSide, isHttpUrlIdentifier, publicAuthorLabel } from "@hypedelta/researcher-identity";
import {
  isAdmittedLiveEvidenceRow,
  mapLiveEvidenceRow,
  summarizeLiveLedgerCandidates,
  type LiveEvidenceCard,
  type LiveEvidenceRow,
  type LiveLedgerSummary,
  type LiveLedgerSummaryCandidate,
} from "./live-evidence-ledger";
import {
  clampPredictionPage,
  clampPredictionPageSize,
  mapPersistedPredictionRow,
  summarizePersistedPredictionCandidates,
  type PersistedPredictionRowInput,
  type PersistedPredictionSummaryCandidate,
  type PersistedPredictionsResult,
} from "./persisted-predictions";
import type {
  ProductFreshnessSource,
  ProductFreshnessStatus,
} from "./product-freshness";
import {
  normalizeDigestMarkdown,
  normalizeStoredSyntheses,
  type TopicSynthesis,
} from "@hypedelta/topic-synthesis";
const { Pool } = pg;

// Singleton pool instance
let pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

// Helper function to execute queries (uses the shared singleton pool)
export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const client = getPool();
  const result = await client.query(sql, params);
  return result.rows;
}

/** Default bound for readiness SELECT 1 — keep probes fast. */
const DEFAULT_READY_TIMEOUT_MS = 2_000;

/**
 * Bounded DB readiness check for /api/health/ready.
 * Returns true only when SELECT 1 succeeds within timeout.
 * Missing DATABASE_URL or any failure → false (fail-closed).
 * Never throws config/exception text to callers.
 */
export async function checkDatabaseReady(
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<boolean> {
  const ms =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : DEFAULT_READY_TIMEOUT_MS;

  // Explicit fail-closed before touching the pool singleton.
  if (!process.env.DATABASE_URL) {
    return false;
  }

  try {
    // getPool() still throws if URL disappears mid-flight — preserve that contract.
    const pool = getPool();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pool.query("SELECT 1"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("ready-timeout")), ms);
        }),
      ]);
      return true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] || null;
}

// ============================================================================
// CLAIMS
// ============================================================================

/** Public researcher list/API/detail headline window (days). */
export const RESEARCHER_PUBLIC_WINDOW_DAYS = 90;

/**
 * Canonical claim provenance projection shared by every public claim read.
 * - source_url falls back to content.url when the claim column is blank
 * - source_identifier is the joined sources.identifier (feed/account provenance)
 * - researcher_slug is the canonical person, when mapped
 */
const CLAIM_SELECT_PROJECTION = `
       e.id, e.content_id, e.claim_text, e.claim_type, e.topic, e.raw_topic, e.stance, e.bullishness, e.confidence,
       e.timeframe, e.target_entity, e.evidence_provided, e.quoteworthiness, e.related_to,
       e.original_quote as supporting_quote, e.author_category,
       COALESCE(r.slug, CASE WHEN s.identifier ~* '^https?://' THEN NULL ELSE s.identifier END) as author_handle,
       r.slug as researcher_slug,
       COALESCE(NULLIF(btrim(r.display_name), ''), NULLIF(btrim(s.author_name), '')) as researcher_display_name,
       s.identifier as source_identifier,
       COALESCE(NULLIF(e.source_url, ''), NULLIF(c.url, '')) as source_url, e.extracted_at`;

const CLAIM_FROM_JOIN = `
     FROM extracted_claims e
     JOIN content c ON e.content_id = c.id
     JOIN sources s ON c.source_id = s.id
     LEFT JOIN source_researchers sr ON sr.source_id = s.id
     LEFT JOIN researchers r ON r.id = sr.researcher_id`;

/** Shared evidence-ledger projection — explicit columns, no SELECT *. */
const LIVE_EVIDENCE_SELECT = `
       e.id,
       e.claim_text,
       e.claim_type,
       e.topic,
       e.stance,
       COALESCE(r.slug, CASE WHEN s.identifier ~* '^https?://' THEN NULL ELSE s.identifier END) as author_handle,
       s.identifier as source_identifier,
       r.slug as researcher_slug,
       s.author_name as author_name,
       COALESCE(NULLIF(btrim(e.source_url), ''), NULLIF(btrim(c.url), '')) as canonical_source_url,
       NULLIF(btrim(e.original_quote), '') as original_quote,
       e.extracted_at,
       c.published_at,
       p.status as prediction_status,
       p.due_at as prediction_due_at,
       p.outcome_summary as prediction_outcome_summary,
       p.evidence as prediction_evidence,
       p.evidence_url as prediction_evidence_url,
       p.next_observable as prediction_next_observable,
       p.next_question as prediction_next_question,
       p.verified_at as prediction_verified_at`;

/** One deterministic researcher per source — never multiply claim/prediction rows. */
const RESEARCHER_LATERAL = `
     LEFT JOIN LATERAL (
       SELECT r.slug, r.display_name
       FROM source_researchers sr
       JOIN researchers r ON r.id = sr.researcher_id
       WHERE sr.source_id = s.id
       ORDER BY r.slug ASC NULLS LAST, r.id ASC
       LIMIT 1
     ) r ON TRUE`;

const LIVE_EVIDENCE_FROM = `
     FROM extracted_claims e
     JOIN content c ON e.content_id = c.id
     JOIN sources s ON c.source_id = s.id
     ${RESEARCHER_LATERAL}
     LEFT JOIN predictions p ON p.claim_id = e.id`;

const LIVE_EVIDENCE_ADMISSION = `
       NULLIF(btrim(COALESCE(NULLIF(e.source_url, ''), NULLIF(c.url, ''))), '') IS NOT NULL
       AND NULLIF(btrim(e.original_quote), '') IS NOT NULL`;

const LIVE_LEDGER_MAX = 50;

export interface Claim {
  id: string;
  content_id: number;
  claim_text: string;
  claim_type: string;
  topic: string;
  raw_topic: string | null;
  stance: string | null;
  bullishness: number | null;
  confidence: number | null;
  timeframe: string | null;
  target_entity: string | null;
  evidence_provided: string | null;
  quoteworthiness: number | null;
  related_to: string[] | null;
  original_quote: string | null;
  supporting_quote: string | null;
  author_handle: string | null;
  researcher_slug: string | null;
  researcher_display_name: string | null;
  source_identifier: string | null;
  author_category: string | null;
  source_url: string | null;
  extracted_at: string;
}

export async function getClaims(options: {
  topic?: string;
  author?: string;
  authorCategory?: string;
  claimType?: string;
  search?: string;
  days?: number;
  limit?: number;
  offset?: number;
}): Promise<{ claims: Claim[]; total: number }> {
  const { topic, author, authorCategory, claimType, search, days = 30, limit = 50, offset = 0 } = options;

  // Input validation
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Date filter - parameterized to prevent SQL injection
  conditions.push(`e.extracted_at > NOW() - make_interval(days => $${paramIndex++})`);
  params.push(safeDays);

  if (topic) {
    conditions.push(`e.topic = $${paramIndex++}`);
    params.push(topic);
  }

  if (author) {
    conditions.push(`(r.slug = $${paramIndex} OR s.identifier = $${paramIndex})`);
    params.push(author);
    paramIndex++;
  }

  if (authorCategory) {
    conditions.push(`e.author_category = $${paramIndex++}`);
    params.push(authorCategory);
  }

  if (claimType) {
    conditions.push(`e.claim_type = $${paramIndex++}`);
    params.push(claimType);
  }

  if (search && search.trim()) {
    // Use ILIKE for case-insensitive text search
    conditions.push(`e.claim_text ILIKE $${paramIndex++}`);
    params.push(`%${search.trim()}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const fromClause = CLAIM_FROM_JOIN;

  // Get total count
  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count ${fromClause} ${whereClause}`,
    params
  );
  const total = parseInt(countResult?.count || "0", 10);

  // Get claims with canonical provenance projection
  const claims = await query<Claim>(
    `SELECT
       ${CLAIM_SELECT_PROJECTION}
     ${fromClause} ${whereClause}
     ORDER BY e.extracted_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, safeLimit, safeOffset]
  );

  return { claims, total };
}

export async function getClaimFacets(options: {
  search?: string;
  days?: number;
  author?: string;
} = {}): Promise<{ topics: string[]; types: string[] }> {
  const { search, days = 30, author } = options;
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const conditions: string[] = [`e.extracted_at > NOW() - make_interval(days => $1)`];
  const params: unknown[] = [safeDays];
  let paramIndex = 2;

  if (author) {
    conditions.push(`(r.slug = $${paramIndex} OR s.identifier = $${paramIndex})`);
    params.push(author);
    paramIndex++;
  }
  if (search && search.trim()) {
    conditions.push(`e.claim_text ILIKE $${paramIndex++}`);
    params.push(`%${search.trim()}%`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const [topicRows, typeRows] = await Promise.all([
    query<{ topic: string }>(
      `SELECT DISTINCT e.topic as topic ${CLAIM_FROM_JOIN} ${whereClause} AND e.topic IS NOT NULL ORDER BY topic`,
      params,
    ),
    query<{ claim_type: string }>(
      `SELECT DISTINCT e.claim_type as claim_type ${CLAIM_FROM_JOIN} ${whereClause} AND e.claim_type IS NOT NULL ORDER BY claim_type`,
      params,
    ),
  ]);

  return {
    topics: topicRows.map((row) => row.topic).filter(Boolean),
    types: typeRows.map((row) => row.claim_type).filter(Boolean),
  };
}

export async function getClaimsByTopic(topic: string, days = 30): Promise<Claim[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  return query<Claim>(
    `SELECT
       ${CLAIM_SELECT_PROJECTION}
     ${CLAIM_FROM_JOIN}
     WHERE e.topic = $1 AND e.extracted_at > NOW() - make_interval(days => $2)
     ORDER BY e.extracted_at DESC`,
    [topic, safeDays]
  );
}

export async function getLiveEvidenceLedger(options: {
  limit?: number;
  now?: Date;
} = {}): Promise<{ cards: LiveEvidenceCard[]; summary: LiveLedgerSummary }> {
  const safeLimit = Math.max(
    1,
    Math.min(LIVE_LEDGER_MAX, Math.floor(Number(options.limit) || 20)),
  );
  const now = options.now ?? new Date();
  const [candidateRows, rows] = await Promise.all([
    query<LiveLedgerSummaryCandidate>(
      `SELECT
         COALESCE(NULLIF(btrim(e.source_url), ''), NULLIF(btrim(c.url), '')) as canonical_source_url,
         NULLIF(btrim(e.original_quote), '') as original_quote,
         e.claim_type,
         p.status as prediction_status,
         p.due_at as prediction_due_at
       FROM extracted_claims e
       JOIN content c ON e.content_id = c.id
       JOIN sources s ON c.source_id = s.id
       LEFT JOIN predictions p ON p.claim_id = e.id`,
    ),
    query<LiveEvidenceRow>(
      `SELECT
         ${LIVE_EVIDENCE_SELECT}
       ${LIVE_EVIDENCE_FROM}
       WHERE ${LIVE_EVIDENCE_ADMISSION}
       ORDER BY
         CASE WHEN e.claim_type = 'prediction' THEN 0 ELSE 1 END,
         e.extracted_at DESC,
         e.id DESC
       LIMIT $1`,
      [safeLimit],
    ),
  ]);
  return {
    cards: rows.filter(isAdmittedLiveEvidenceRow).map((row) => mapLiveEvidenceRow(row, now)),
    summary: summarizeLiveLedgerCandidates(candidateRows, now),
  };
}

export async function getClaimDetail(id: string): Promise<LiveEvidenceCard | null> {
  if (!isValidClaimId(id)) return null;
  const row = await queryOne<LiveEvidenceRow>(
    `SELECT
       ${LIVE_EVIDENCE_SELECT}
     ${LIVE_EVIDENCE_FROM}
     WHERE e.id = $1`,
    [id],
  );
  return row ? mapLiveEvidenceRow(row) : null;
}

// ============================================================================
// TOPICS
// ============================================================================

export interface TopicStats {
  topic: string;
  claim_count: number;
  avg_bullishness: number;
  lab_count: number;
  critic_count: number;
  other_count: number;
}

export async function getTopicStats(days = 30): Promise<TopicStats[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  return query<TopicStats>(
    `SELECT
       topic,
       COUNT(*) as claim_count,
       AVG(bullishness) as avg_bullishness,
       -- ${authorSideSqlCase("author_category")}
       COUNT(*) FILTER (WHERE ${authorSideSqlPredicate("author_category", "lab")}) as lab_count,
       COUNT(*) FILTER (WHERE ${authorSideSqlPredicate("author_category", "critic")}) as critic_count,
       COUNT(*) FILTER (WHERE ${authorSideSqlPredicate("author_category", "other")}) as other_count
     FROM extracted_claims
     WHERE extracted_at > NOW() - make_interval(days => $1)
     GROUP BY topic
     ORDER BY claim_count DESC`,
    [safeDays]
  );
}

// ============================================================================
// SYNTHESIS
// ============================================================================

export interface SynthesisResult {
  id: number;
  generated_at: string;
  lookback_days: number;
  // digest is stored as a markdown string, object markdown/text, or empty/unsupported
  digest_markdown: string;
  // syntheses is an array of canonical TopicSynthesis rows
  syntheses: TopicSynthesis[];
  // hype_assessment is an object
  hype_assessment: {
    overallSentiment?: number;
    overhyped?: Array<{ topic: string; delta: number; reason: string }>;
    underhyped?: Array<{ topic: string; delta: number; reason: string }>;
  } | null;
  // Computed fields
  period_start: string;
  period_end: string;
  created_at: string;
}

interface RawSynthesisRow {
  id: number;
  generated_at: string;
  lookback_days: number;
  syntheses: unknown;
  hype_assessment: unknown;
  digest: unknown;
}

/**
 * Transform a raw synthesis_results row into the shape the UI expects:
 * digest -> digest_markdown, remapped hype_assessment fields, and computed
 * period_start/period_end/created_at.
 */
function mapSynthesisRow(result: RawSynthesisRow): SynthesisResult {
  const generatedAt = new Date(result.generated_at);
  const lookbackDays = result.lookback_days || 7;
  const periodStart = new Date(generatedAt);
  periodStart.setDate(periodStart.getDate() - lookbackDays);

  // Map the hype_assessment fields from DB format to expected format.
  // DB uses overhypedTopics/underhypedTopics, UI expects overhyped/underhyped.
  const rawHype = result.hype_assessment as Record<string, unknown> | null;
  const hypeAssessment: SynthesisResult['hype_assessment'] = rawHype ? {
    overallSentiment: rawHype.overallFieldSentiment as number | undefined,
    overhyped: (rawHype.overhypedTopics as Array<{ topic: string; score: number; reasoning: string }> | undefined)?.map(t => ({
      topic: t.topic,
      delta: t.score,
      reason: t.reasoning,
    })),
    underhyped: (rawHype.underhypedTopics as Array<{ topic: string; score: number; reasoning: string }> | undefined)?.map(t => ({
      topic: t.topic,
      delta: t.score,
      reason: t.reasoning,
    })),
  } : null;

  return {
    id: result.id,
    generated_at: result.generated_at,
    lookback_days: lookbackDays,
    digest_markdown: normalizeDigestMarkdown(result.digest).markdown,
    syntheses: normalizeStoredSyntheses(result.syntheses),
    hype_assessment: hypeAssessment,
    period_start: periodStart.toISOString(),
    period_end: result.generated_at,
    created_at: result.generated_at,
  };
}

export async function getLatestSynthesis(): Promise<SynthesisResult | null> {
  const result = await queryOne<RawSynthesisRow>(
    `SELECT * FROM synthesis_results
     ORDER BY generated_at DESC
     LIMIT 1`
  );

  return result ? mapSynthesisRow(result) : null;
}

export async function getSynthesisHistory(count = 10): Promise<SynthesisResult[]> {
  const safeCount = Math.max(1, Math.min(100, Math.floor(Number(count) || 10)));
  const rows = await query<RawSynthesisRow>(
    `SELECT * FROM synthesis_results
     ORDER BY generated_at DESC
     LIMIT $1`,
    [safeCount]
  );
  return rows.map(mapSynthesisRow);
}

// ============================================================================
// SOURCES
// ============================================================================

export interface Source {
  id: number;
  type: string;
  identifier: string;
  author_name: string | null;
  category: string | null;
  tags: string[] | null;
  last_fetched: string | null;
  fetch_frequency_hours: number | null;
  is_active: boolean;
  created_at: string;
}

export async function getSources(): Promise<Source[]> {
  return query<Source>(
    `SELECT * FROM sources ORDER BY type, identifier`
  );
}

export async function getActiveSources(): Promise<Source[]> {
  return query<Source>(
    `SELECT * FROM sources WHERE is_active = true ORDER BY type, identifier`
  );
}

// ============================================================================
// CONTENT
// ============================================================================

export interface ContentStats {
  total_content: number;
  processed_content: number;
  unprocessed_content: number;
  content_last_24h: number;
}

export async function getContentStats(): Promise<ContentStats> {
  const result = await queryOne<ContentStats>(
    `SELECT
       COUNT(*) as total_content,
       COUNT(*) FILTER (WHERE processed_at IS NOT NULL) as processed_content,
       COUNT(*) FILTER (WHERE processed_at IS NULL) as unprocessed_content,
       COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '24 hours') as content_last_24h
     FROM content`
  );
  return result || { total_content: 0, processed_content: 0, unprocessed_content: 0, content_last_24h: 0 };
}

// ============================================================================
// RESEARCHERS
// ============================================================================

export interface ResearcherStats {
  handle: string;
  name: string;
  side: AuthorSide;
  category: string | null;
  affiliation: string | null;
  claim_count: number;
  avg_bullishness: number | null;
  prediction_count: number;
  source_identifiers: string[];
}

interface ResearcherQueryRow {
  handle: string;
  name: string | null;
  lab_count: string | number;
  critic_count: string | number;
  other_count: string | number;
  claim_count: string | number;
  avg_bullishness: number | null;
  prediction_count: string | number;
  source_identifiers: string[] | null;
  source_categories: string[] | null;
}

export async function getResearchers(days = RESEARCHER_PUBLIC_WINDOW_DAYS): Promise<ResearcherStats[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || RESEARCHER_PUBLIC_WINDOW_DAYS)));
  const researchers = await query<ResearcherQueryRow>(
    `SELECT
       r.slug as handle,
       r.display_name as name,
       COUNT(DISTINCT e.id) as claim_count,
       COUNT(DISTINCT e.id) FILTER (WHERE ${authorSideSqlPredicate("e.author_category", "lab")}) as lab_count,
       COUNT(DISTINCT e.id) FILTER (WHERE ${authorSideSqlPredicate("e.author_category", "critic")}) as critic_count,
       COUNT(DISTINCT e.id) FILTER (WHERE ${authorSideSqlPredicate("e.author_category", "other")}) as other_count,
       AVG(e.bullishness) as avg_bullishness,
       COALESCE(pred.prediction_count, 0) as prediction_count,
       ARRAY_AGG(DISTINCT s.identifier) as source_identifiers,
       ARRAY_AGG(DISTINCT s.category) as source_categories
     FROM researchers r
     JOIN source_researchers sr ON sr.researcher_id = r.id
     JOIN sources s ON s.id = sr.source_id
     JOIN content c ON c.source_id = s.id
     JOIN extracted_claims e ON e.content_id = c.id
     LEFT JOIN (
       SELECT sr2.researcher_id, COUNT(DISTINCT p.id) as prediction_count
       FROM predictions p
       JOIN extracted_claims e2 ON p.claim_id = e2.id
       JOIN content c2 ON e2.content_id = c2.id
       JOIN source_researchers sr2 ON sr2.source_id = c2.source_id
       WHERE e2.extracted_at > NOW() - make_interval(days => $1)
       GROUP BY sr2.researcher_id
     ) pred ON pred.researcher_id = r.id
     WHERE e.extracted_at > NOW() - make_interval(days => $1)
       AND s.type != 'arxiv'
     GROUP BY r.id, r.slug, r.display_name, pred.prediction_count
     ORDER BY claim_count DESC
     LIMIT 100`,
    [safeDays]
  );
  return researchers.flatMap((row) => {
    if (!row.handle || isHttpUrlIdentifier(row.handle)) return [];
    const side = aggregateResearcherSide({
      lab: Number(row.lab_count),
      critic: Number(row.critic_count),
      other: Number(row.other_count),
    });
    const label = publicAuthorLabel({
      displayName: row.name,
      identifier: row.handle,
    });
    return [{
      handle: row.handle,
      name: label.displayName,
      side,
      category: side,
      affiliation: null,
      claim_count: Number(row.claim_count),
      avg_bullishness: row.avg_bullishness,
      prediction_count: Number(row.prediction_count),
      source_identifiers: row.source_identifiers || [],
    }];
  });
}

export async function getResearcherClaims(
  author: string,
  days = RESEARCHER_PUBLIC_WINDOW_DAYS
): Promise<Claim[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || RESEARCHER_PUBLIC_WINDOW_DAYS)));
  // Get claims via content->source join with canonical provenance projection
  return query<Claim>(
    `SELECT
       ${CLAIM_SELECT_PROJECTION}
     ${CLAIM_FROM_JOIN}
     WHERE (r.slug = $1 OR s.identifier = $1) AND e.extracted_at > NOW() - make_interval(days => $2)
     ORDER BY e.extracted_at DESC`,
    [author, safeDays]
  );
}

// ============================================================================
// PREDICTIONS
// ============================================================================

export interface Prediction {
  id: string;
  claim_id: string | null;
  prediction_text: string;
  author: string | null;
  confidence: number | null;
  timeframe: string | null;
  topic: string | null;
  made_at: string;
  verified_at: string | null;
  status: string | null;
  accuracy_score: number | null;
  evidence: string | null;
}

export async function getPredictions(options: {
  status?: string;
  author?: string;
  limit?: number;
}): Promise<Prediction[]> {
  const { status, author, limit = 50 } = options;

  // Input validation
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(status);
  }

  if (author) {
    conditions.push(`author = $${paramIndex++}`);
    params.push(author);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return query<Prediction>(
    `SELECT
       id, claim_id, text as prediction_text, author, confidence, timeframe,
       topic, made_at, verified_at, status, accuracy_score, evidence
     FROM predictions ${whereClause}
     ORDER BY made_at DESC
     LIMIT $${paramIndex}`,
    [...params, safeLimit]
  );
}

const PERSISTED_PREDICTION_FROM = `
     FROM predictions p
     LEFT JOIN extracted_claims e ON p.claim_id = e.id
     LEFT JOIN content c ON e.content_id = c.id
     LEFT JOIN sources s ON c.source_id = s.id
     ${RESEARCHER_LATERAL}`;

const PERSISTED_PREDICTION_SELECT = `
       p.id,
       p.text as prediction_text,
       p.status,
       p.confidence,
       p.timeframe,
       p.topic,
       p.made_at,
       p.due_at,
       p.verified_at,
       p.outcome_summary,
       p.evidence,
       p.evidence_url,
       p.next_observable,
       p.next_question,
       p.claim_id,
       e.claim_text,
       e.claim_type,
       COALESCE(NULLIF(btrim(e.source_url), ''), NULLIF(btrim(c.url), '')) as canonical_source_url,
       NULLIF(btrim(e.original_quote), '') as original_quote,
       r.slug as researcher_slug,
       COALESCE(NULLIF(btrim(r.display_name), ''), NULLIF(btrim(s.author_name), '')) as researcher_display_name,
       s.identifier as source_identifier`;

export async function getPersistedPredictions(options: {
  status?: string;
  topic?: string;
  page?: number | string;
  pageSize?: number | string;
} = {}): Promise<PersistedPredictionsResult> {
  const page = clampPredictionPage(options.page);
  const pageSize = clampPredictionPageSize(options.pageSize);
  const status = typeof options.status === "string" ? options.status.trim() : "";
  const topic = typeof options.topic === "string" ? options.topic.trim() : "";

  const filterConditions: string[] = [];
  const filterParams: unknown[] = [];
  let paramIndex = 1;

  if (status) {
    filterConditions.push(`p.status = $${paramIndex++}`);
    filterParams.push(status);
  }
  if (topic) {
    filterConditions.push(`p.topic = $${paramIndex++}`);
    filterParams.push(topic);
  }

  const whereClause =
    filterConditions.length > 0 ? `WHERE ${filterConditions.join(" AND ")}` : "";
  const limitParam = paramIndex++;
  const offsetParam = paramIndex;
  const offset = (page - 1) * pageSize;

  const [itemRows, countRow, summaryRows, topicRows] = await Promise.all([
    query<PersistedPredictionRowInput>(
      `SELECT
         ${PERSISTED_PREDICTION_SELECT}
       ${PERSISTED_PREDICTION_FROM}
       ${whereClause}
       ORDER BY p.made_at DESC, p.id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...filterParams, pageSize, offset],
    ),
    queryOne<{ count: string | number }>(
      `SELECT COUNT(*) as count ${PERSISTED_PREDICTION_FROM} ${whereClause}`,
      filterParams,
    ),
    query<PersistedPredictionSummaryCandidate>(
      `SELECT
         p.status,
         p.due_at,
         COALESCE(NULLIF(btrim(e.source_url), ''), NULLIF(btrim(c.url), '')) as canonical_source_url,
         NULLIF(btrim(e.original_quote), '') as original_quote
       FROM predictions p
       LEFT JOIN extracted_claims e ON p.claim_id = e.id
       LEFT JOIN content c ON e.content_id = c.id`,
    ),
    query<{ topic: string }>(
      `SELECT DISTINCT p.topic as topic
       FROM predictions p
       WHERE NULLIF(btrim(p.topic), '') IS NOT NULL
       ORDER BY topic`,
    ),
  ]);

  return {
    items: itemRows.map(mapPersistedPredictionRow),
    total: toCount(countRow?.count),
    page,
    pageSize,
    topicOptions: topicRows.map((row) => row.topic).filter(Boolean),
    summary: summarizePersistedPredictionCandidates(summaryRows),
  };
}

export async function getResearcherPredictions(
  handle: string,
  days = RESEARCHER_PUBLIC_WINDOW_DAYS,
): Promise<Prediction[]> {
  const safeDays = Math.max(
    1,
    Math.min(365, Math.floor(Number(days) || RESEARCHER_PUBLIC_WINDOW_DAYS)),
  );
  return query<Prediction>(
    `SELECT
       p.id, p.claim_id, p.text as prediction_text, s.identifier as author, p.confidence, p.timeframe,
       p.topic, p.made_at, p.verified_at, p.status, p.accuracy_score, p.evidence
     FROM predictions p
     JOIN extracted_claims e ON p.claim_id = e.id
     JOIN content c ON e.content_id = c.id
     JOIN sources s ON c.source_id = s.id
     LEFT JOIN source_researchers sr ON sr.source_id = s.id
     LEFT JOIN researchers r ON r.id = sr.researcher_id
     WHERE (r.slug = $1 OR s.identifier = $1)
       AND e.extracted_at > NOW() - make_interval(days => $2)
     ORDER BY p.made_at DESC`,
    [handle, safeDays],
  );
}

// ============================================================================
// SYSTEM STATUS
// ============================================================================

export interface ModelRoutingAttempt {
  stage: string;
  requestedProvider: string;
  requestedModel: string;
  effectiveProvider: string | null;
  effectiveModel: string | null;
  credentialClass: string;
  ok: boolean;
  errorClass: string | null;
  latencyMs: number;
  startedAt: string;
  promptVersion: string;
}

export interface ModelRoutingStageWindow {
  stage: string;
  attempts: number;
  successes: number;
  failures: number;
  lastSuccessAt: string | null;
  lastErrorClass: string | null;
  averageLatencyMs: number | null;
}

export interface ModelRoutingStatus {
  available: boolean;
  recent: ModelRoutingAttempt[];
  last24h: ModelRoutingStageWindow[];
}

export interface SystemStatus {
  sources: { total: number; active: number };
  content: ContentStats;
  claims: {
    total: number;
    last_24h: number;
    /** Claims with a non-empty canonical source URL (claim column or content.url). */
    url_backed: number;
    /** Claims with a non-empty verbatim original_quote. */
    quote_backed: number;
    /** Claims whose joined source identifier is non-empty. */
    author_identified: number;
    /** 0–100; 0 when total is 0. */
    url_backed_pct: number;
    /** 0–100; 0 when total is 0. */
    quote_backed_pct: number;
    /** 0–100; 0 when total is 0. */
    author_identified_pct: number;
  };
  synthesis: { latest: string | null; count: number };
  routing: ModelRoutingStatus;
}

function coveragePct(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const [[sources, content, claimsResult, synthesis], routing] = await Promise.all([
    Promise.all([
      queryOne<{ total: string; active: string }>(
        `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active FROM sources`
      ),
      getContentStats(),
      queryOne<{
        total: string;
        last_24h: string;
        url_backed: string;
        quote_backed: string;
        author_identified: string;
      }>(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE e.extracted_at > NOW() - INTERVAL '24 hours') as last_24h,
           COUNT(*) FILTER (
             WHERE COALESCE(NULLIF(e.source_url, ''), NULLIF(c.url, '')) IS NOT NULL
           ) as url_backed,
           COUNT(*) FILTER (
             WHERE NULLIF(btrim(e.original_quote), '') IS NOT NULL
           ) as quote_backed,
           COUNT(*) FILTER (
             WHERE NULLIF(s.identifier, '') IS NOT NULL
           ) as author_identified
         FROM extracted_claims e
         LEFT JOIN content c ON e.content_id = c.id
         LEFT JOIN sources s ON c.source_id = s.id`
      ),
      queryOne<{ latest: string; count: string }>(
        `SELECT MAX(generated_at) as latest, COUNT(*) as count FROM synthesis_results`
      ),
    ]),
    getModelRoutingStatus(),
  ]);

  const total = parseInt(claimsResult?.total || "0", 10);
  const urlBacked = parseInt(claimsResult?.url_backed || "0", 10);
  const quoteBacked = parseInt(claimsResult?.quote_backed || "0", 10);
  const authorIdentified = parseInt(claimsResult?.author_identified || "0", 10);

  return {
    sources: {
      total: parseInt(sources?.total || "0", 10),
      active: parseInt(sources?.active || "0", 10),
    },
    content,
    claims: {
      total,
      last_24h: parseInt(claimsResult?.last_24h || "0", 10),
      url_backed: urlBacked,
      quote_backed: quoteBacked,
      author_identified: authorIdentified,
      url_backed_pct: coveragePct(urlBacked, total),
      quote_backed_pct: coveragePct(quoteBacked, total),
      author_identified_pct: coveragePct(authorIdentified, total),
    },
    synthesis: {
      latest: synthesis?.latest || null,
      count: parseInt(synthesis?.count || "0", 10),
    },
    routing,
  };
}

function toIsoTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toFrequencyHours(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBool(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value == null || value === "") return null;
  if (value === "t" || value === "true") return true;
  if (value === "f" || value === "false") return false;
  return null;
}

function toOptionalString(value: unknown): string | null {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNonNegInt(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isMissingModelAttemptsRelation(err: unknown): boolean {
  const codes: string[] = [];
  const messages: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (!value || depth > 3) return;
    if (typeof value === "object") {
      const o = value as { code?: unknown; message?: unknown; cause?: unknown };
      if (typeof o.code === "string") codes.push(o.code);
      if (typeof o.message === "string") messages.push(o.message);
      walk(o.cause, depth + 1);
    } else if (typeof value === "string") {
      messages.push(value);
    }
  };
  walk(err, 0);
  if (codes.includes("42P01")) return true;
  return messages.some((m) => /relation ["']?model_attempts["']? does not exist/i.test(m));
}

const UNAVAILABLE_ROUTING: ModelRoutingStatus = {
  available: false,
  recent: [],
  last24h: [],
};

function mapRoutingAttempt(row: Record<string, unknown>): ModelRoutingAttempt {
  return {
    stage: String(row.stage ?? ""),
    requestedProvider: String(row.requested_provider ?? ""),
    requestedModel: String(row.requested_model ?? ""),
    effectiveProvider: toOptionalString(row.effective_provider),
    effectiveModel: toOptionalString(row.effective_model),
    credentialClass: String(row.credential_class ?? ""),
    ok: toBool(row.ok) === true,
    errorClass: toOptionalString(row.error_class),
    latencyMs: toNonNegInt(row.latency_ms),
    startedAt: toIsoTimestamp(row.started_at) ?? "",
    promptVersion: String(row.prompt_version ?? ""),
  };
}

function mapRoutingStageWindow(row: Record<string, unknown>): ModelRoutingStageWindow {
  return {
    stage: String(row.stage ?? ""),
    attempts: toNonNegInt(row.attempts),
    successes: toNonNegInt(row.successes),
    failures: toNonNegInt(row.failures),
    lastSuccessAt: toIsoTimestamp(row.last_success_at),
    lastErrorClass: toOptionalString(row.last_error_class),
    averageLatencyMs: toFiniteNumber(row.average_latency_ms),
  };
}

async function getModelRoutingStatus(): Promise<ModelRoutingStatus> {
  try {
    const [recentRows, stageRows] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT
           stage,
           requested_provider,
           requested_model,
           effective_provider,
           effective_model,
           credential_class,
           ok,
           error_class,
           latency_ms,
           started_at,
           prompt_version
         FROM model_attempts
         ORDER BY started_at DESC, id DESC
         LIMIT 20`,
      ),
      query<Record<string, unknown>>(
        `SELECT
           stage,
           COUNT(*)::int AS attempts,
           COUNT(*) FILTER (WHERE ok = true)::int AS successes,
           COUNT(*) FILTER (WHERE ok = false)::int AS failures,
           MAX(started_at) FILTER (WHERE ok = true) AS last_success_at,
           (
             ARRAY_AGG(error_class ORDER BY started_at DESC, id DESC)
             FILTER (WHERE ok = false AND error_class IS NOT NULL)
           )[1] AS last_error_class,
           AVG(latency_ms) AS average_latency_ms
         FROM model_attempts
         WHERE started_at > NOW() - INTERVAL '24 hours'
         GROUP BY stage`,
      ),
    ]);
    return {
      available: true,
      recent: recentRows.map(mapRoutingAttempt),
      last24h: stageRows.map(mapRoutingStageWindow),
    };
  } catch (err) {
    if (isMissingModelAttemptsRelation(err)) {
      return UNAVAILABLE_ROUTING;
    }
    throw err;
  }
}

/**
 * Persisted product-freshness snapshot: last synthesis, unprocessed backlog,
 * active source scheduling state, and pipeline/fetch ledger outcomes.
 * Direct web DB reads — not a SELECT 1 probe. Never copies error_message.
 */
export async function getProductFreshnessSnapshot(): Promise<ProductFreshnessStatus> {
  const [synthesis, content, sources, pipelineSuccess, pipelineLatest, fetchSuccess] =
    await Promise.all([
      queryOne<{ latest: string | Date | null }>(
        `SELECT MAX(generated_at) as latest FROM synthesis_results`,
      ),
      queryOne<{ unprocessed: string | number }>(
        `SELECT COUNT(*) FILTER (WHERE processed_at IS NULL) as unprocessed FROM content`,
      ),
      query<{
        identifier: string;
        type: string;
        last_fetched: string | Date | null;
        fetch_frequency_hours: number | string | null;
      }>(
        `SELECT identifier, type, last_fetched, fetch_frequency_hours
         FROM sources
         WHERE is_active = true
         ORDER BY type, identifier`,
      ),
      queryOne<{ latest_success: string | Date | null }>(
        `SELECT MAX(finished_at) as latest_success FROM pipeline_runs WHERE ok = true`,
      ),
      queryOne<{
        finished_at: string | Date | null;
        ok: boolean | string | null;
        error_class: string | null;
      }>(
        `SELECT finished_at, ok, error_class
         FROM pipeline_runs
         ORDER BY finished_at DESC NULLS LAST, id DESC
         LIMIT 1`,
      ),
      queryOne<{ latest_success: string | Date | null }>(
        `SELECT MAX(finished_at) as latest_success FROM source_fetch_attempts WHERE ok = true`,
      ),
    ]);

  const activeSources: ProductFreshnessSource[] = sources.map((row) => ({
    identifier: row.identifier,
    type: row.type,
    last_fetched: toIsoTimestamp(row.last_fetched),
    fetch_frequency_hours: toFrequencyHours(row.fetch_frequency_hours),
  }));

  const errorClass =
    typeof pipelineLatest?.error_class === "string" && pipelineLatest.error_class.length > 0
      ? pipelineLatest.error_class
      : null;

  return {
    synthesisLatest: toIsoTimestamp(synthesis?.latest ?? null),
    unprocessedCount: toCount(content?.unprocessed),
    activeSources,
    pipelineLatestSuccessAt: toIsoTimestamp(pipelineSuccess?.latest_success ?? null),
    pipelineLatestFinishedAt: toIsoTimestamp(pipelineLatest?.finished_at ?? null),
    pipelineLatestOk: toBool(pipelineLatest?.ok ?? null),
    pipelineLatestErrorClass: errorClass,
    fetchLatestSuccessAt: toIsoTimestamp(fetchSuccess?.latest_success ?? null),
  };
}

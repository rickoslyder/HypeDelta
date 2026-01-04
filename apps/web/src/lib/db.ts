/**
 * Database connection layer for the web frontend
 *
 * This module provides access to the HypeDelta database stores
 * for use in Next.js API routes and Server Components.
 */

import pg from "pg";
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

// Helper function to execute queries
async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const client = getPool();
  const result = await client.query(sql, params);
  return result.rows;
}

async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] || null;
}

// ============================================================================
// CLAIMS
// ============================================================================

export interface Claim {
  id: string;
  content_id: number;
  claim_text: string;
  claim_type: string;
  topic: string;
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
  conditions.push(`extracted_at > NOW() - make_interval(days => $${paramIndex++})`);
  params.push(safeDays);

  if (topic) {
    conditions.push(`topic = $${paramIndex++}`);
    params.push(topic);
  }

  if (author) {
    conditions.push(`author = $${paramIndex++}`);
    params.push(author);
  }

  if (authorCategory) {
    conditions.push(`author_category = $${paramIndex++}`);
    params.push(authorCategory);
  }

  if (claimType) {
    conditions.push(`claim_type = $${paramIndex++}`);
    params.push(claimType);
  }

  if (search && search.trim()) {
    // Use ILIKE for case-insensitive text search
    conditions.push(`claim_text ILIKE $${paramIndex++}`);
    params.push(`%${search.trim()}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get total count
  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM extracted_claims ${whereClause}`,
    params
  );
  const total = parseInt(countResult?.count || "0", 10);

  // Get claims with aliased fields
  const claims = await query<Claim>(
    `SELECT
       id, content_id, claim_text, claim_type, topic, stance, bullishness, confidence,
       timeframe, target_entity, evidence_provided, quoteworthiness, related_to,
       original_quote as supporting_quote, author as author_handle, author_category,
       source_url, extracted_at
     FROM extracted_claims ${whereClause}
     ORDER BY extracted_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, safeLimit, safeOffset]
  );

  return { claims, total };
}

export async function getClaimsByTopic(topic: string, days = 30): Promise<Claim[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  return query<Claim>(
    `SELECT
       id, content_id, claim_text, claim_type, topic, stance, bullishness, confidence,
       timeframe, target_entity, evidence_provided, quoteworthiness, related_to,
       original_quote as supporting_quote, author as author_handle, author_category,
       source_url, extracted_at
     FROM extracted_claims
     WHERE topic = $1 AND extracted_at > NOW() - make_interval(days => $2)
     ORDER BY extracted_at DESC`,
    [topic, safeDays]
  );
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
}

export async function getTopicStats(days = 30): Promise<TopicStats[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  return query<TopicStats>(
    `SELECT
       topic,
       COUNT(*) as claim_count,
       AVG(bullishness) as avg_bullishness,
       COUNT(*) FILTER (WHERE author_category IN ('anthropic', 'openai', 'deepmind', 'meta', 'google', 'xai', 'mistral', 'lab-researcher')) as lab_count,
       COUNT(*) FILTER (WHERE author_category IN ('critic', 'academic')) as critic_count
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
  // digest is stored as a markdown string
  digest_markdown: string | null;
  // syntheses is an array of topic syntheses
  syntheses: Array<{
    topic: string;
    summary?: string;
    keyDebates?: Array<{ summary: string; labPosition?: string; criticPosition?: string }>;
  }> | null;
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

export async function getLatestSynthesis(): Promise<SynthesisResult | null> {
  const result = await queryOne<{
    id: number;
    generated_at: string;
    lookback_days: number;
    syntheses: unknown;
    hype_assessment: unknown;
    digest: unknown;
  }>(
    `SELECT * FROM synthesis_results
     ORDER BY generated_at DESC
     LIMIT 1`
  );

  if (!result) return null;

  // Transform the result to match our interface
  const generatedAt = new Date(result.generated_at);
  const lookbackDays = result.lookback_days || 7;
  const periodStart = new Date(generatedAt);
  periodStart.setDate(periodStart.getDate() - lookbackDays);

  // Map the hype_assessment fields from DB format to expected format
  // DB uses overhypedTopics/underhypedTopics, UI expects overhyped/underhyped
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
    digest_markdown: typeof result.digest === 'string' ? result.digest : null,
    syntheses: Array.isArray(result.syntheses) ? result.syntheses : null,
    hype_assessment: hypeAssessment,
    period_start: periodStart.toISOString(),
    period_end: result.generated_at,
    created_at: result.generated_at,
  };
}

export async function getSynthesisHistory(count = 10): Promise<SynthesisResult[]> {
  return query<SynthesisResult>(
    `SELECT * FROM synthesis_results
     ORDER BY generated_at DESC
     LIMIT $1`,
    [count]
  );
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
  name: string | null;
  category: string | null;
  affiliation: string | null;
  claim_count: number;
  avg_bullishness: number | null;
  prediction_count: number;
}

export async function getResearchers(days = 30): Promise<ResearcherStats[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  // Get researchers with claim stats via content->source join
  // (author field in extracted_claims may be NULL, but source relationship exists)
  const researchers = await query<ResearcherStats>(
    `SELECT
       s.identifier as handle,
       s.author_name as name,
       s.category as category,
       NULL as affiliation,
       COUNT(DISTINCT e.id) as claim_count,
       AVG(e.bullishness) as avg_bullishness,
       COALESCE(p.prediction_count, 0) as prediction_count
     FROM extracted_claims e
     JOIN content c ON e.content_id = c.id
     JOIN sources s ON c.source_id = s.id
     LEFT JOIN (
       SELECT author, COUNT(*) as prediction_count
       FROM predictions
       GROUP BY author
     ) p ON s.identifier = p.author
     WHERE e.extracted_at > NOW() - make_interval(days => $1)
       AND s.type != 'arxiv'
     GROUP BY s.identifier, s.author_name, s.category, p.prediction_count
     ORDER BY claim_count DESC
     LIMIT 100`,
    [safeDays]
  );
  return researchers;
}

export async function getResearcherClaims(author: string, days = 90): Promise<Claim[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 90)));
  // Get claims via content->source join since author field may be NULL
  return query<Claim>(
    `SELECT
       e.id, e.content_id, e.claim_text, e.claim_type, e.topic, e.stance, e.bullishness, e.confidence,
       e.timeframe, e.target_entity, e.evidence_provided, e.quoteworthiness, e.related_to,
       e.original_quote as supporting_quote, s.identifier as author_handle, e.author_category,
       e.source_url, e.extracted_at
     FROM extracted_claims e
     JOIN content c ON e.content_id = c.id
     JOIN sources s ON c.source_id = s.id
     WHERE s.identifier = $1 AND e.extracted_at > NOW() - make_interval(days => $2)
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

// ============================================================================
// SYSTEM STATUS
// ============================================================================

export interface SystemStatus {
  sources: { total: number; active: number };
  content: ContentStats;
  claims: { total: number; last_24h: number };
  synthesis: { latest: string | null; count: number };
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const [sources, content, claimsResult, synthesis] = await Promise.all([
    queryOne<{ total: string; active: string }>(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active FROM sources`
    ),
    getContentStats(),
    queryOne<{ total: string; last_24h: string }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE extracted_at > NOW() - INTERVAL '24 hours') as last_24h
       FROM extracted_claims`
    ),
    queryOne<{ latest: string; count: string }>(
      `SELECT MAX(generated_at) as latest, COUNT(*) as count FROM synthesis_results`
    ),
  ]);

  return {
    sources: {
      total: parseInt(sources?.total || "0", 10),
      active: parseInt(sources?.active || "0", 10),
    },
    content,
    claims: {
      total: parseInt(claimsResult?.total || "0", 10),
      last_24h: parseInt(claimsResult?.last_24h || "0", 10),
    },
    synthesis: {
      latest: synthesis?.latest || null,
      count: parseInt(synthesis?.count || "0", 10),
    },
  };
}

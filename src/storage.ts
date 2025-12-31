/**
 * Storage Layer
 *
 * PostgreSQL with pgvector for:
 * - Content storage
 * - Claim storage with embeddings
 * - Synthesis results
 * - Prediction tracking
 */

import pg from 'pg';
const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;

import type { SourceType, ContentCategory } from './types';

// ============================================================================
// TYPES
// ============================================================================

export interface Source {
  id?: number;
  type: SourceType;
  identifier: string;
  authorName?: string;
  category?: ContentCategory;
  tags?: string[];
  lastFetched?: Date;
  fetchFrequencyHours?: number;
  isActive?: boolean;
}

export interface Content {
  id?: number;
  sourceId: number;
  externalId: string;
  url?: string;
  title?: string;
  contentText?: string;
  contentHtml?: string;
  contentType?: string;
  author?: string;
  publishedAt?: Date;
  fetchedAt?: Date;
  processedAt?: Date;  // Track when content was processed
  wordCount?: number;
  metadata?: Record<string, any>;
}

export interface FilteredContent extends Content {
  relevanceScore: number;
  primaryTopic: string;
  isSubstantive: boolean;
  authorCategory: string;
}

export interface ExtractedClaim {
  id?: string;
  contentId: number;
  claimText: string;
  claimType: string;
  topic: string;
  stance: string;
  bullishness: number;
  confidence: number;
  timeframe?: string;
  targetEntity?: string;
  evidenceProvided?: string;
  quoteworthiness?: number;
  relatedTo?: string[];
  originalQuote?: string;
  author?: string;
  authorCategory?: string;
  sourceUrl?: string;
  extractedAt?: Date;
}

export interface EnrichedClaim extends ExtractedClaim {
  embedding?: number[];
  relatedClaims?: string[];
  potentialContradictions?: string[];
}

export interface SynthesisResult {
  id?: number;
  generatedAt: Date;
  lookbackDays: number;
  syntheses: any[];
  hypeAssessment: any;
  digest?: any;
}

export interface Prediction {
  id?: string;
  claimId: string;
  text: string;
  author: string;
  confidence: number;
  timeframe: string;
  topic: string;
  madeAt: Date;
  verifiedAt?: Date;
  status?: string;
  accuracyScore?: number;
  evidence?: string;
}

// ============================================================================
// BASE STORE
// ============================================================================

class BaseStore {
  protected pool: PoolType;
  
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }
  
  async query<T>(sql: string, params?: any[]): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows;
  }
  
  async queryOne<T>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] || null;
  }
  
  async execute(sql: string, params?: any[]): Promise<void> {
    await this.pool.query(sql, params);
  }
}

// ============================================================================
// CONTENT STORE
// ============================================================================

export class ContentStore extends BaseStore {
  async upsert(content: Content): Promise<number> {
    const result = await this.queryOne<{ id: number }>(`
      INSERT INTO content (
        source_id, external_id, url, title, content_text, content_html,
        content_type, author, published_at, fetched_at, word_count, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        content_text = EXCLUDED.content_text,
        content_html = EXCLUDED.content_html,
        word_count = EXCLUDED.word_count,
        metadata = EXCLUDED.metadata,
        fetched_at = NOW()
      RETURNING id
    `, [
      content.sourceId,
      content.externalId,
      content.url,
      content.title,
      content.contentText,
      content.contentHtml,
      content.contentType,
      content.author,
      content.publishedAt,
      content.wordCount,
      JSON.stringify(content.metadata || {})
    ]);
    
    return result!.id;
  }
  
  async upsertMany(contents: Content[]): Promise<void> {
    for (const content of contents) {
      await this.upsert(content);
    }
  }
  
  async getRecent(days: number, sourceTypes?: string[]): Promise<Content[]> {
    let sql = `
      SELECT c.*, s.type as source_type, s.author_name, s.category
      FROM content c
      JOIN sources s ON c.source_id = s.id
      WHERE c.published_at > NOW() - INTERVAL '${days} days'
    `;
    
    const params: any[] = [];
    
    if (sourceTypes?.length) {
      sql += ` AND s.type = ANY($1)`;
      params.push(sourceTypes);
    }
    
    sql += ` ORDER BY c.published_at DESC`;
    
    return this.query<Content>(sql, params);
  }
  
  async getBySource(sourceId: number, limit = 100): Promise<Content[]> {
    return this.query<Content>(`
      SELECT * FROM content
      WHERE source_id = $1
      ORDER BY published_at DESC
      LIMIT $2
    `, [sourceId, limit]);
  }

  async getUnprocessed(days: number, limit = 100): Promise<Content[]> {
    return this.query<Content>(`
      SELECT c.*, s.type as source_type, s.author_name, s.category
      FROM content c
      JOIN sources s ON c.source_id = s.id
      WHERE c.published_at > NOW() - INTERVAL '${days} days'
        AND c.processed_at IS NULL
      ORDER BY c.published_at DESC
      LIMIT $1
    `, [limit]);
  }

  async markProcessed(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.execute(`
      UPDATE content SET processed_at = NOW()
      WHERE id = ANY($1)
    `, [ids]);
  }
}

// ============================================================================
// CLAIM STORE
// ============================================================================

export class ClaimStore extends BaseStore {
  async upsert(claim: EnrichedClaim): Promise<string> {
    const id = claim.id || this.generateId();
    
    await this.execute(`
      INSERT INTO extracted_claims (
        id, content_id, claim_text, claim_type, topic, stance,
        bullishness, confidence, timeframe, target_entity,
        evidence_provided, quoteworthiness, related_to, original_quote,
        author, author_category, source_url, extracted_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), $18)
      ON CONFLICT (id) DO UPDATE SET
        claim_text = EXCLUDED.claim_text,
        bullishness = EXCLUDED.bullishness,
        confidence = EXCLUDED.confidence,
        metadata = EXCLUDED.metadata
    `, [
      id,
      claim.contentId,
      claim.claimText,
      claim.claimType,
      claim.topic,
      claim.stance,
      claim.bullishness,
      claim.confidence,
      claim.timeframe,
      claim.targetEntity,
      claim.evidenceProvided,
      claim.quoteworthiness,
      claim.relatedTo,
      claim.originalQuote,
      claim.author,
      claim.authorCategory,
      claim.sourceUrl,
      JSON.stringify({
        relatedClaims: claim.relatedClaims,
        potentialContradictions: claim.potentialContradictions
      })
    ]);
    
    // Store embedding if present
    if (claim.embedding) {
      await this.storeEmbedding(id, claim.claimText, claim.embedding);
    }
    
    return id;
  }
  
  async upsertMany(claims: EnrichedClaim[]): Promise<void> {
    for (const claim of claims) {
      await this.upsert(claim);
    }
  }
  
  async getRecent(days: number): Promise<ExtractedClaim[]> {
    return this.query<ExtractedClaim>(`
      SELECT * FROM extracted_claims
      WHERE extracted_at > NOW() - INTERVAL '${days} days'
      ORDER BY extracted_at DESC
    `);
  }
  
  async getByTopic(topic: string, days?: number): Promise<ExtractedClaim[]> {
    let sql = `SELECT * FROM extracted_claims WHERE topic = $1`;
    const params: any[] = [topic];
    
    if (days) {
      sql += ` AND extracted_at > NOW() - INTERVAL '${days} days'`;
    }
    
    sql += ` ORDER BY extracted_at DESC`;
    
    return this.query<ExtractedClaim>(sql, params);
  }
  
  async getByAuthorCategory(category: string, days?: number): Promise<ExtractedClaim[]> {
    let sql = `SELECT * FROM extracted_claims WHERE author_category = $1`;
    const params: any[] = [category];
    
    if (days) {
      sql += ` AND extracted_at > NOW() - INTERVAL '${days} days'`;
    }
    
    sql += ` ORDER BY extracted_at DESC`;
    
    return this.query<ExtractedClaim>(sql, params);
  }
  
  async findSimilar(embedding: number[], options: {
    limit?: number;
    excludeId?: string;
    minSimilarity?: number;
  } = {}): Promise<{ claim: ExtractedClaim; similarity: number }[]> {
    const { limit = 5, excludeId, minSimilarity = 0.5 } = options;
    
    // Using pgvector cosine distance
    let sql = `
      SELECT 
        c.*,
        1 - (e.embedding <=> $1::vector) as similarity
      FROM content_embeddings e
      JOIN extracted_claims c ON c.id = e.content_id::text
      WHERE 1 - (e.embedding <=> $1::vector) > $2
    `;
    
    const params: any[] = [`[${embedding.join(',')}]`, minSimilarity];
    
    if (excludeId) {
      sql += ` AND c.id != $3`;
      params.push(excludeId);
    }
    
    sql += ` ORDER BY e.embedding <=> $1::vector LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const rows = await this.query<ExtractedClaim & { similarity: number }>(sql, params);
    
    return rows.map(row => ({
      claim: row,
      similarity: row.similarity
    }));
  }
  
  async storeEmbedding(claimId: string, text: string, embedding: number[]): Promise<void> {
    await this.execute(`
      INSERT INTO content_embeddings (content_id, chunk_index, chunk_text, embedding)
      VALUES ($1, 0, $2, $3::vector)
      ON CONFLICT (content_id, chunk_index) DO UPDATE SET
        chunk_text = EXCLUDED.chunk_text,
        embedding = EXCLUDED.embedding
    `, [claimId, text, `[${embedding.join(',')}]`]);
  }
  
  private generateId(): string {
    return `claim_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ============================================================================
// SYNTHESIS STORE
// ============================================================================

export class SynthesisStore extends BaseStore {
  async save(result: SynthesisResult): Promise<number> {
    const row = await this.queryOne<{ id: number }>(`
      INSERT INTO synthesis_results (
        generated_at, lookback_days, syntheses, hype_assessment, digest
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [
      result.generatedAt,
      result.lookbackDays,
      JSON.stringify(result.syntheses),
      JSON.stringify(result.hypeAssessment),
      result.digest ? JSON.stringify(result.digest) : null
    ]);
    
    return row!.id;
  }
  
  async getLatest(): Promise<SynthesisResult | null> {
    return this.queryOne<SynthesisResult>(`
      SELECT * FROM synthesis_results
      ORDER BY generated_at DESC
      LIMIT 1
    `);
  }
  
  async getRecent(count = 10): Promise<SynthesisResult[]> {
    return this.query<SynthesisResult>(`
      SELECT * FROM synthesis_results
      ORDER BY generated_at DESC
      LIMIT $1
    `, [count]);
  }
}

// ============================================================================
// PREDICTION TRACKER
// ============================================================================

export class PredictionTracker extends BaseStore {
  async record(prediction: Prediction): Promise<string> {
    const id = prediction.id || `pred_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    await this.execute(`
      INSERT INTO predictions (
        id, claim_id, text, author, confidence, timeframe,
        topic, made_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING
    `, [
      id,
      prediction.claimId,
      prediction.text,
      prediction.author,
      prediction.confidence,
      prediction.timeframe,
      prediction.topic,
      prediction.madeAt
    ]);
    
    return id;
  }
  
  async updateStatus(id: string, status: string, accuracyScore?: number, evidence?: string): Promise<void> {
    await this.execute(`
      UPDATE predictions SET
        status = $2,
        accuracy_score = $3,
        evidence = $4,
        verified_at = NOW()
      WHERE id = $1
    `, [id, status, accuracyScore, evidence]);
  }
  
  async getPending(timeframe?: string): Promise<Prediction[]> {
    let sql = `
      SELECT * FROM predictions
      WHERE status IS NULL OR status = 'too-early'
    `;
    
    const params: any[] = [];
    
    if (timeframe) {
      sql += ` AND timeframe = $1`;
      params.push(timeframe);
    }
    
    sql += ` ORDER BY made_at ASC`;
    
    return this.query<Prediction>(sql, params);
  }
  
  async getByAuthor(author: string): Promise<Prediction[]> {
    return this.query<Prediction>(`
      SELECT * FROM predictions
      WHERE author = $1
      ORDER BY made_at DESC
    `, [author]);
  }
  
  async getAccuracyStats(author?: string): Promise<{
    total: number;
    verified: number;
    falsified: number;
    partiallyVerified: number;
    pending: number;
    averageAccuracy: number;
  }> {
    let whereClause = '';
    const params: any[] = [];
    
    if (author) {
      whereClause = 'WHERE author = $1';
      params.push(author);
    }
    
    const row = await this.queryOne<any>(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'verified') as verified,
        COUNT(*) FILTER (WHERE status = 'falsified') as falsified,
        COUNT(*) FILTER (WHERE status = 'partially-verified') as partially_verified,
        COUNT(*) FILTER (WHERE status IS NULL OR status = 'too-early') as pending,
        AVG(accuracy_score) FILTER (WHERE accuracy_score IS NOT NULL) as avg_accuracy
      FROM predictions
      ${whereClause}
    `, params);
    
    return {
      total: parseInt(row.total),
      verified: parseInt(row.verified),
      falsified: parseInt(row.falsified),
      partiallyVerified: parseInt(row.partially_verified),
      pending: parseInt(row.pending),
      averageAccuracy: parseFloat(row.avg_accuracy) || 0
    };
  }
}

// ============================================================================
// SOURCE STORE
// ============================================================================

export class SourceStore extends BaseStore {
  async upsert(source: Source): Promise<number> {
    const row = await this.queryOne<{ id: number }>(`
      INSERT INTO sources (
        type, identifier, author_name, category, tags,
        fetch_frequency_hours, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (type, identifier) DO UPDATE SET
        author_name = EXCLUDED.author_name,
        category = EXCLUDED.category,
        tags = EXCLUDED.tags,
        is_active = EXCLUDED.is_active
      RETURNING id
    `, [
      source.type,
      source.identifier,
      source.authorName,
      source.category,
      source.tags,
      source.fetchFrequencyHours || 24,
      source.isActive ?? true
    ]);
    
    return row!.id;
  }
  
  async getActive(): Promise<Source[]> {
    return this.query<Source>(`
      SELECT * FROM sources
      WHERE is_active = true
      ORDER BY type, identifier
    `);
  }
  
  async getByType(type: string): Promise<Source[]> {
    return this.query<Source>(`
      SELECT * FROM sources
      WHERE type = $1 AND is_active = true
      ORDER BY identifier
    `, [type]);
  }
  
  async markFetched(id: number): Promise<void> {
    await this.execute(`
      UPDATE sources SET last_fetched = NOW()
      WHERE id = $1
    `, [id]);
  }
  
  async getDueForFetch(): Promise<Source[]> {
    return this.query<Source>(`
      SELECT * FROM sources
      WHERE is_active = true
        AND (
          last_fetched IS NULL
          OR last_fetched < NOW() - (fetch_frequency_hours || ' hours')::interval
        )
      ORDER BY last_fetched ASC NULLS FIRST
    `);
  }
}

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

export async function initializeDatabase(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  
  // Create extensions
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  
  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      identifier VARCHAR(255) NOT NULL,
      author_name VARCHAR(255),
      category VARCHAR(100),
      tags TEXT[],
      last_fetched TIMESTAMPTZ,
      fetch_frequency_hours INT DEFAULT 24,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(type, identifier)
    );
    
    CREATE TABLE IF NOT EXISTS content (
      id SERIAL PRIMARY KEY,
      source_id INT REFERENCES sources(id),
      external_id VARCHAR(255) NOT NULL,
      url TEXT,
      title TEXT,
      content_text TEXT,
      content_html TEXT,
      content_type VARCHAR(50),
      author VARCHAR(255),
      published_at TIMESTAMPTZ,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      processed_at TIMESTAMPTZ,  -- Track when content was processed
      word_count INT,
      metadata JSONB,
      UNIQUE(source_id, external_id)
    );
    
    CREATE TABLE IF NOT EXISTS extracted_claims (
      id VARCHAR(100) PRIMARY KEY,
      content_id INT REFERENCES content(id),
      claim_text TEXT NOT NULL,
      claim_type VARCHAR(50),
      topic VARCHAR(100),
      stance VARCHAR(20),
      bullishness FLOAT,
      confidence FLOAT,
      timeframe VARCHAR(50),
      target_entity VARCHAR(255),
      evidence_provided VARCHAR(50),
      quoteworthiness FLOAT,
      related_to TEXT[],
      original_quote TEXT,
      author VARCHAR(255),
      author_category VARCHAR(50),
      source_url TEXT,
      extracted_at TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB
    );
    
    CREATE TABLE IF NOT EXISTS content_embeddings (
      id SERIAL PRIMARY KEY,
      content_id VARCHAR(100) NOT NULL,
      chunk_index INT DEFAULT 0,
      chunk_text TEXT,
      embedding vector(768),  -- Matches Ollama nomic-embed-text (default provider)
      UNIQUE(content_id, chunk_index)
    );
    
    CREATE TABLE IF NOT EXISTS synthesis_results (
      id SERIAL PRIMARY KEY,
      generated_at TIMESTAMPTZ NOT NULL,
      lookback_days INT,
      syntheses JSONB,
      hype_assessment JSONB,
      digest JSONB
    );
    
    CREATE TABLE IF NOT EXISTS predictions (
      id VARCHAR(100) PRIMARY KEY,
      claim_id VARCHAR(100) REFERENCES extracted_claims(id),
      text TEXT NOT NULL,
      author VARCHAR(255),
      confidence FLOAT,
      timeframe VARCHAR(50),
      topic VARCHAR(100),
      made_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      status VARCHAR(50),
      accuracy_score FLOAT,
      evidence TEXT
    );
    
    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_content_published ON content(published_at);
    CREATE INDEX IF NOT EXISTS idx_content_source ON content(source_id, published_at);
    CREATE INDEX IF NOT EXISTS idx_claims_topic ON extracted_claims(topic);
    CREATE INDEX IF NOT EXISTS idx_claims_type ON extracted_claims(claim_type);
    CREATE INDEX IF NOT EXISTS idx_claims_author_cat ON extracted_claims(author_category);
    CREATE INDEX IF NOT EXISTS idx_claims_extracted ON extracted_claims(extracted_at);
    CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON content_embeddings USING ivfflat (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status);
    CREATE INDEX IF NOT EXISTS idx_predictions_author ON predictions(author);
  `);
  
  await pool.end();
}

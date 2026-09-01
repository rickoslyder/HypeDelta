import { randomUUID } from "node:crypto";
/**
 * AI Intelligence Extraction & Synthesis Layer
 *
 * Pipeline:
 * 1. INGEST: Raw content from fetchers → preprocessing
 * 2. FILTER: StageModelRouter (deepseek-v4-flash)
 * 3. EXTRACT: StageModelRouter (deepseek-v4-flash)
 * 4. ENRICH: Add embeddings, cross-references, topic tags
 * 5. SYNTHESIZE / HYPE: StageModelRouter (kimi-k3)
 * 6. OUTPUT: digest via StageModelRouter (kimi-k3 markdown)
 */

import { ContentStore, ClaimStore, SynthesisStore, type EnrichedClaim } from './storage';
import { EmbeddingService } from './embeddings';
import { normalizeAuthorRole } from './author-side';
import { normalizeExternalId } from './external-id';
import { CANONICAL_TOPICS, normalizeTopic, topicPreservation, uniqueCanonicalTopics } from './topic-taxonomy';
import type {
  RawContent,
  FilteredContent,
  ExtractedClaim,
} from './types';
import {
  type TopicSynthesis,
  normalizeDigestMarkdown,
  toCanonicalTopicSynthesis,
} from './topic-synthesis';
import { ModelRoutingError } from './model-routing';
import {
  HypeAssessmentSchema,
  type PipelineAgent,
} from './pipeline-model-agent';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface OrchestratorConfig {
  projectDir: string;
  dbUrl: string;
  embeddingProvider?: 'ollama' | 'openai' | 'voyage';
  useSkills?: boolean;
  agent?: PipelineAgent;
  modelAttemptStore?: { close: () => Promise<void> };
}

export interface ProcessingResult {
  processed: number;
  relevant: number;
  /** Persisted claim count (compatibility alias of persistedClaims). */
  claimsExtracted: number;
  timestamp: Date;
  agentOutputs: number;
  admittedClaims: number;
  rejectedClaims: number;
  persistedClaims: number;
}

export interface SynthesisOptions {
  lookbackDays?: number;
  topics?: string[] | null;
  generateDigest?: boolean;
}

export interface SynthesisResult {
  syntheses: TopicSynthesis[];
  hypeAssessment: HypeAssessment;
  digest: string | null;
}

interface HypeAssessment {
  overhypedTopics: TopicHypeScore[];
  underhypedTopics: TopicHypeScore[];
  accuratelyAssessedTopics: TopicHypeScore[];
  overallFieldSentiment: number;
  summary: string;
}

interface TopicHypeScore {
  topic: string;
  score: number;
  reasoning: string;
  keyEvidence: string[];
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

export class AIIntelOrchestrator {
  private agent: PipelineAgent | null;
  public contentStore: ContentStore;
  public claimStore: ClaimStore;
  public synthesisStore: SynthesisStore;
  private embeddings: EmbeddingService;
  private useSkills: boolean;
  private modelAttemptStore?: { close: () => Promise<void> };
  
  constructor(config: OrchestratorConfig) {
    this.agent = config.agent ?? null;
    
    this.contentStore = new ContentStore(config.dbUrl);
    this.claimStore = new ClaimStore(config.dbUrl);
    this.synthesisStore = new SynthesisStore(config.dbUrl);
    this.embeddings = new EmbeddingService(config.embeddingProvider || 'ollama');
    
    this.useSkills = config.useSkills !== false;
    this.modelAttemptStore = config.modelAttemptStore;
  }

  /**
   * Release owned DB pools. CLI one-shots must call this; the long-lived
   * scheduler must not, except on explicit shutdown.
   */
  async close(): Promise<void> {
    await Promise.all([
      this.contentStore.close(),
      this.claimStore.close(),
      this.synthesisStore.close(),
      this.modelAttemptStore?.close(),
    ]);
  }
  
  /**
   * Main processing pipeline
   */
  async processBatch(rawContent: RawContent[]): Promise<ProcessingResult> {
    console.log(`Processing batch of ${rawContent.length} items`);

    // Collect ALL input content database IDs so filtered-out/noise items are
    // marked processed in the same transaction as claim writes (retry-safe).
    const allContentIds = rawContent
      .map((item: any) => item.id)
      .filter((id: any) => typeof id === 'number' && id > 0);

    const filtered = await this.filterStage(rawContent);
    console.log(`Filtered to ${filtered.length} relevant items`);

    const extracted = await this.extractStage(filtered);
    const claims = extracted.claims;
    console.log(`Extracted ${claims.length} claims`);

    const enriched = await this.enrichStage(claims);

    const storedCount = await this.storeResults(filtered, enriched, allContentIds);

    return {
      processed: rawContent.length,
      relevant: filtered.length,
      claimsExtracted: storedCount,
      timestamp: new Date(),
      agentOutputs: extracted.agentOutputs,
      admittedClaims: extracted.admittedClaims,
      rejectedClaims: extracted.agentOutputs - storedCount,
      persistedClaims: storedCount,
    };
  }
  
  /**
   * Synthesis pipeline (runs separately, e.g. weekly)
   */
  async runSynthesis(options: SynthesisOptions = {}): Promise<SynthesisResult> {
    const { 
      lookbackDays = 7,
      topics = null,
      generateDigest = true 
    } = options;
    
    const recentClaims = await this.claimStore.getRecent(lookbackDays);
    const byTopic = this.groupByTopic(recentClaims);
    const requested = topics == null ? null : uniqueCanonicalTopics(topics);
    
    const syntheses: TopicSynthesis[] = [];
    
    for (const topic of CANONICAL_TOPICS) {
      const claims = byTopic[topic] ?? [];
      if (claims.length === 0) continue;
      if (requested && !requested.includes(topic)) continue;
      const synthesis = await this.synthesizeTopic(topic, claims);
      syntheses.push(synthesis);
    }
    
    const hypeAssessment = await this.generateHypeAssessment(syntheses);
    
    let digest: string | null = null;
    if (generateDigest) {
      if (!this.agent) {
        throw new Error('Pipeline agent is required for digest');
      }
      digest = await this.agent.generateDigest(syntheses, hypeAssessment);
      const normalized = normalizeDigestMarkdown(digest);
      if (normalized.unsupported) {
        throw new Error('digest must be nonblank markdown');
      }
      digest = normalized.markdown;
    }
    
    await this.synthesisStore.save({
      generatedAt: new Date(),
      lookbackDays,
      syntheses,
      hypeAssessment,
      digest
    });
    
    return { syntheses, hypeAssessment, digest };
  }
  
  // ============================================================================
  // STAGE 1: FILTER
  // ============================================================================
  
  private async filterStage(content: RawContent[]): Promise<FilteredContent[]> {
    // Pre-filter obvious noise before LLM processing
    const preFiltered = content.filter(item => {
      const text = item.content || (item as any).content_text || '';

      // Skip retweets
      if (text.startsWith('RT @')) return false;

      // Skip very short content (< 50 chars)
      if (text.length < 50) return false;

      // Skip pure link shares with no commentary
      if (text.match(/^https?:\/\/\S+$/)) return false;

      return true;
    });

    const skipped = content.length - preFiltered.length;
    if (skipped > 0) {
      console.log(`  Pre-filtered ${skipped} noise items (RTs, short, link-only)`);
    }

    if (this.agent) {
      // Process in batches of 20 (provider prompt limit)
      const BATCH_SIZE = 20;
      const allFiltered: FilteredContent[] = [];

      for (let i = 0; i < preFiltered.length; i += BATCH_SIZE) {
        const batch = preFiltered.slice(i, i + BATCH_SIZE);
        console.log(`  Filtering batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(preFiltered.length / BATCH_SIZE)} (${batch.length} items)`);

        const result = await this.agent.filterContent(batch);
        const filtered = this.applyFilterResults(batch, result);
        allFiltered.push(...filtered);
      }

      return allFiltered;
    } else if (this.useSkills) {
      throw new Error('Pipeline agent is required');
    } else {
      return preFiltered.map(c => ({
        ...c,
        relevance: 1.0,
        topic: 'general',
        contentType: 'opinion',
        authorCategory: normalizeAuthorRole('unknown'),
        isSubstantive: true,
        brief: ''
      } as FilteredContent));
    }
  }
  
  private applyFilterResults(content: RawContent[], result: any): FilteredContent[] {
    const assessments = result.assessments || [];
    
    return content
      .map((item, idx) => {
        const assessment = assessments[idx];
        if (!assessment || assessment.relevance < 0.3) return null;
        
        return {
          ...item,
          relevance: assessment.relevance,
          topic: normalizeTopic(assessment.topic),
          contentType: assessment.contentType || 'opinion',
          authorCategory: normalizeAuthorRole(assessment.authorCategory),
          isSubstantive: assessment.isSubstantive !== false,
          brief: assessment.brief || ''
        } as FilteredContent;
      })
      .filter((item): item is FilteredContent => item !== null);
  }
  
  // ============================================================================
  // STAGE 2: EXTRACT
  // ============================================================================
  
  private async extractStage(content: FilteredContent[]): Promise<{
    claims: ExtractedClaim[];
    agentOutputs: number;
    admittedClaims: number;
  }> {
    if (this.agent) {
      // Process in batches of 10 (provider prompt limit for deeper extraction)
      const BATCH_SIZE = 10;
      const allClaims: ExtractedClaim[] = [];
      let agentOutputs = 0;

      for (let i = 0; i < content.length; i += BATCH_SIZE) {
        const batch = content.slice(i, i + BATCH_SIZE);
        console.log(`  Extracting batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(content.length / BATCH_SIZE)} (${batch.length} items)`);

        const result = await this.agent.extractClaims(batch);
        const rawClaims = Array.isArray(result?.claims) ? result.claims : [];
        agentOutputs += typeof result?.agentOutputs === 'number'
          ? result.agentOutputs
          : rawClaims.length;
        const claims = this.normalizeClaimResults(result);
        allClaims.push(...claims);
      }

      return {
        claims: allClaims,
        agentOutputs,
        admittedClaims: allClaims.length,
      };
    }

    if (this.useSkills) {
      throw new Error('Pipeline agent is required');
    }

    const claims = this.extractDirect(content);
    return { claims, agentOutputs: 0, admittedClaims: claims.length };
  }
  
  private extractDirect(content: FilteredContent[]): ExtractedClaim[] {
    if (content.length === 0) return [];
    throw new Error('Claim extraction is disabled; refusing to fabricate claims');
  }
  
  private normalizeClaimResults(result: any): ExtractedClaim[] {
    const claims: ExtractedClaim[] = [];
    const claimsArray = result.claims || result.raw?.claims || [];

    for (const claim of claimsArray) {
      const preserved = topicPreservation(claim.topic);
      claims.push({
        id: randomUUID(),
        contentId: claim.contentId,  // Will be set during storage if undefined
        claimText: claim.claimText || claim.text || '',
        claimType: claim.claimType || 'opinion',
        topic: preserved.topic,
        rawTopic: preserved.rawTopic,
        stance: claim.stance || 'neutral',
        bullishness: claim.bullishness ?? 0.5,
        confidence: claim.confidence ?? 0.5,
        timeframe: claim.timeframe || null,
        evidenceProvided: claim.evidenceProvided || 'weak',
        quoteworthiness: claim.quoteworthiness ?? 0.3,
        relatedTo: claim.relatedTo || [],
        authorCategory: normalizeAuthorRole(claim.authorCategory),
        sourceUrl: claim.sourceUrl,  // Used to link back to content during storage
        extractedAt: new Date(),
        originalQuote: claim.originalQuote
      });
    }

    return claims;
  }
  
  // ============================================================================
  // STAGE 3: ENRICH
  // ============================================================================
  
  private async enrichStage(claims: ExtractedClaim[]): Promise<ExtractedClaim[]> {
    // Embed in bounded-concurrency chunks rather than one-at-a-time. Per-claim
    // failures are tolerated (the claim is simply stored without an embedding).
    const CONCURRENCY = 5;
    for (let i = 0; i < claims.length; i += CONCURRENCY) {
      const batch = claims.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (claim) => {
        try {
          const embedding = await this.embeddings.embed(claim.claimText);
          (claim as any).embedding = embedding;
        } catch (e) {
          console.warn(`Failed to embed claim: ${e}`);
        }
      }));
    }
    return claims;
  }
  
  // ============================================================================
  // STAGE 4: STORE
  // ============================================================================
  
  private async storeResults(
    filtered: FilteredContent[],
    claims: ExtractedClaim[],
    allInputContentIds: number[] = []
  ): Promise<number> {
    // Content and claims are written together in a single transaction so a
    // mid-batch failure can't leave content marked processed without its claims
    // (or orphaned claims without content).
    const client = await this.contentStore.connect();
    try {
      await client.query('BEGIN');

      // Map from content external IDs to database IDs for this transaction.
      const contentIdMap = new Map<string, number>();
      const processedIdSet = new Set<number>(allInputContentIds);
      // Authoritative provenance for each content id resolved in this txn.
      // Claims may only inherit URL/author from entries here — never invent.
      const contentProvenance = new Map<number, {
        url?: string | null;
        sourceIdentifier?: string | null;
        authorName?: string | null;
        author?: string | null;
        authorCategory?: string | null;
        contentText?: string;
      }>();

      const nonBlank = (v: unknown): string | undefined => {
        if (v == null) return undefined;
        const s = String(v).trim();
        return s === '' ? undefined : s;
      };

      const sourceTextOf = (item: any): string => {
        const v = item?.content ?? item?.content_text ?? item?.contentText ?? '';
        return typeof v === 'string' ? v : String(v ?? '');
      };

      const recordProvenance = (contentId: number, item: any) => {
        const url = nonBlank(item.url) ?? nonBlank(item.source_url);
        const sourceIdentifier =
          nonBlank(item.source_identifier) ??
          nonBlank(item.sourceIdentifier) ??
          nonBlank(item.identifier);
        const authorName =
          nonBlank(item.author_name) ?? nonBlank(item.authorName);
        const author = nonBlank(item.author);
        const authorCategory = nonBlank(item.authorCategory) ?? nonBlank(item.author_category);
        contentProvenance.set(contentId, {
          url,
          sourceIdentifier,
          authorName,
          author,
          authorCategory,
          contentText: sourceTextOf(item),
        });
      };

      // First, store all content and collect their database IDs
      for (const item of filtered) {
        const anyItem = item as any;

        // If content already has a database ID, use it directly (from getRecent/getUnprocessed)
        if (anyItem.id && typeof anyItem.id === 'number') {
          const externalId = normalizeExternalId(
            String(anyItem.external_id ?? '').trim() || `${item.source}_${item.publishedAt.getTime()}`,
          );
          contentIdMap.set(externalId, anyItem.id);
          recordProvenance(anyItem.id, { ...anyItem, url: item.url ?? anyItem.url, author: item.author ?? anyItem.author });
          processedIdSet.add(anyItem.id);
          continue;
        }

        // Handle both snake_case (from DB) and camelCase (from fetcher) sourceId
        const sourceId = anyItem.sourceId || anyItem.source_id || 0;
        if (sourceId === 0) {
          console.warn(`Skipping content with no sourceId: ${item.url || item.title}`);
          continue;
        }

        const externalId = normalizeExternalId(
          (item.id ?? '').trim() || `${item.source}_${item.publishedAt.getTime()}`,
        );
        const contentId = await this.contentStore.upsert({
          sourceId,
          externalId,
          url: item.url,
          title: item.title,
          contentText: item.content,
          contentType: item.sourceType,
          author: item.author,
          publishedAt: item.publishedAt,
          metadata: item.metadata,
        }, client);
        contentIdMap.set(externalId, contentId);
        recordProvenance(contentId, {
          ...anyItem,
          url: item.url,
          author: item.author,
          // Fresh inserts: source identity is the content author handle when
          // the join row is not present; never synthesize a URL.
          source_identifier: anyItem.source_identifier || anyItem.sourceIdentifier || anyItem.identifier || item.author,
          author_name: anyItem.author_name || anyItem.authorName,
        });
        processedIdSet.add(contentId);
      }

      // The set of content IDs actually stored in this batch. A claim may only
      // be attributed to one of these.
      const validContentIds = new Set(contentIdMap.values());

      let storedCount = 0;

      // Now store claims with proper contentId references
      for (const claim of claims) {
        // Resolve only from the server-selected numeric contentId. Model
        // sourceUrl must not reparent evidence onto another batch item.
        const contentId =
          typeof claim.contentId === 'number' ? claim.contentId : undefined;

        // Only accept a reference we actually stored. Never guess an attribution:
        // for a provenance-driven system, a claim linked to the wrong source is
        // far worse than a dropped claim.
        if (!contentId || !validContentIds.has(contentId)) {
          console.warn('Dropping claim: unresolved content record');
          continue;
        }

        const prov = contentProvenance.get(contentId);
        const originalQuote =
          typeof claim.originalQuote === 'string' ? claim.originalQuote.trim() : '';
        if (!originalQuote) {
          console.warn('Dropping claim: missing originalQuote');
          continue;
        }
        // Validate against the exact resolved batch item, never arbitrary sourceUrl.
        const sourceText = prov?.contentText ?? '';
        if (!sourceText.includes(originalQuote)) {
          console.warn('Dropping claim: originalQuote not found in source');
          continue;
        }

        // Derive source identity only from resolved selected-content provenance.
        // Model-supplied sourceUrl/author/authorCategory cannot reparent evidence.
        const sourceUrl = nonBlank(prov?.url);
        const author =
          nonBlank(prov?.sourceIdentifier) ??
          nonBlank(prov?.authorName) ??
          nonBlank(prov?.author);
        const authorCategory =
          nonBlank(prov?.authorCategory) ?? claim.authorCategory;

        await this.claimStore.upsert({
          contentId,
          claimText: claim.claimText,
          claimType: claim.claimType,
          topic: claim.topic,
          stance: claim.stance,
          bullishness: claim.bullishness,
          confidence: claim.confidence,
          timeframe: claim.timeframe,
          targetEntity: claim.targetEntity,
          evidenceProvided: claim.evidenceProvided,
          quoteworthiness: claim.quoteworthiness,
          relatedTo: claim.relatedTo,
          originalQuote,
          author,
          authorCategory,
          sourceUrl,
          extractedAt: claim.extractedAt,
          // enrichStage attaches this via `(claim as any).embedding`, and ClaimStore.upsert only
          // calls storeEmbedding when it is present. It was missing here, so every embedding was
          // computed and then dropped: 86 claims on 2026-08-01 produced 0 rows in
          // content_embeddings. The `as EnrichedClaim` cast below is what hid it from the compiler.
          embedding: (claim as any).embedding,
        } as EnrichedClaim, client);
        storedCount += 1;
      }

      // Mark ALL input content IDs (including filtered-out noise) only after
      // claim writes succeed — still inside the same transaction.
      const processedIds = [...processedIdSet];
      if (processedIds.length > 0) {
        await this.contentStore.markProcessed(processedIds, client);
      }

      await client.query('COMMIT');
      return storedCount;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  
  // ============================================================================
  // SYNTHESIS
  // ============================================================================
  
  private groupByTopic(claims: any[]): Record<string, any[]> {
    const groups: Record<string, any[]> = {};
    for (const claim of claims) {
      const topic = normalizeTopic(claim.topic);
      if (!groups[topic]) groups[topic] = [];
      groups[topic].push(claim);
    }
    return groups;
  }

  private async synthesizeTopic(topic: string, claims: any[]): Promise<TopicSynthesis> {
    if (!this.agent) {
      throw new Error('Pipeline agent is required for synthesis');
    }
    const result = await this.agent.synthesize(claims, topic);
    const canonical = toCanonicalTopicSynthesis(result, { topic, claimCount: claims.length });
    if (canonical.unsupported) {
      throw new ModelRoutingError('schema');
    }
    return canonical;
  }
  
  private async generateHypeAssessment(syntheses: TopicSynthesis[]): Promise<HypeAssessment> {
    if (!this.agent) {
      throw new Error('Pipeline agent is required for hype assessment');
    }
    const result = await this.agent.useSkill('hype-assessment', { syntheses });
    const parsed = HypeAssessmentSchema.safeParse(result);
    if (!parsed.success) {
      throw new ModelRoutingError('schema');
    }
    return parsed.data as HypeAssessment;
  }
  
  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Initialize the orchestrator (no-op, skills are loaded on demand)
   */
  async initialize(): Promise<void> {
    // Skills and agents are loaded on demand by the agent SDK
    // This method exists for API consistency with the scheduler
  }

  async listSkills(): Promise<string[]> {
    return [];
  }
  
  async listAgents(): Promise<string[]> {
    return [];
  }
  
  async useSkill(skillName: string, input: any): Promise<any> {
    if (!this.agent) {
      throw new Error('Pipeline agent is required');
    }
    return this.agent.useSkill(skillName, input);
  }
  
  async spawnSubagent(_agentName: string, _task: string): Promise<any> {
    throw new Error('Subagents are not available on the production pipeline agent');
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { ContentStore, ClaimStore, SynthesisStore } from './storage';
export { EmbeddingService } from './embeddings';
export { AIIntelFetcher, seedSources } from './fetcher';

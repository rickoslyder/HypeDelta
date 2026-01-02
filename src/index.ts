/**
 * AI Intelligence Extraction & Synthesis Layer
 * 
 * Architecture:
 * - Claude Agent SDK: Skills-based extraction via .claude/skills/
 * - GLM 4.7 (via Z.ai): Bulk filtering when haiku model is used
 * - Subagents: Isolated task execution via .claude/agents/
 * 
 * Pipeline:
 * 1. INGEST: Raw content from fetchers → preprocessing
 * 2. FILTER: content-filter skill (routes to GLM via haiku)
 * 3. EXTRACT: claim-extraction skill (nuanced Claude analysis)
 * 4. ENRICH: Add embeddings, cross-references, topic tags
 * 5. SYNTHESIZE: topic-synthesis + hype-assessment skills
 * 6. OUTPUT: digest-generation skill produces weekly digest
 */

import { AIIntelAgent, GLMClient, ZAI_CONFIG } from './agent-sdk-wrapper';
import { ContentStore, ClaimStore, SynthesisStore, type EnrichedClaim } from './storage';
import { EmbeddingService } from './embeddings';
import { FILTER_PROMPT } from './prompts';
import type {
  RawContent,
  FilteredContent,
  ExtractedClaim,
  HypeDelta,
  TopicConsensus
} from './types';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface OrchestratorConfig {
  projectDir: string;
  dbUrl: string;
  embeddingProvider?: 'ollama' | 'openai' | 'voyage';
  useSkills?: boolean;
  glmFallback?: boolean;
}

export interface ProcessingResult {
  processed: number;
  relevant: number;
  claimsExtracted: number;
  timestamp: Date;
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

interface TopicSynthesis {
  topic: string;
  claimCount: number; // For balanced digest coverage
  labConsensus: string;
  criticConsensus: string;
  agreements: string[];
  disagreements: Disagreement[];
  emergingNarratives: string[];
  predictions: Prediction[];
  evidenceQuality: number;
  hypeDelta: HypeDelta;
  synthesisNarrative: string;
}

interface Disagreement {
  point: string;
  labPosition: string;
  criticPosition: string;
}

interface Prediction {
  text: string;
  author: string;
  confidence: number;
  timeframe: string;
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
  private agent: AIIntelAgent;
  private glm: GLMClient | null = null;
  public contentStore: ContentStore;
  public claimStore: ClaimStore;
  public synthesisStore: SynthesisStore;
  private embeddings: EmbeddingService;
  private useSkills: boolean;
  private glmFallback: boolean;
  
  constructor(config: OrchestratorConfig) {
    this.agent = new AIIntelAgent({
      projectDir: config.projectDir
    });
    
    if (config.glmFallback) {
      this.glm = new GLMClient();
    }
    
    this.contentStore = new ContentStore(config.dbUrl);
    this.claimStore = new ClaimStore(config.dbUrl);
    this.synthesisStore = new SynthesisStore(config.dbUrl);
    this.embeddings = new EmbeddingService(config.embeddingProvider || 'ollama');
    
    this.useSkills = config.useSkills !== false;
    this.glmFallback = config.glmFallback || false;
  }
  
  /**
   * Main processing pipeline
   */
  async processBatch(rawContent: RawContent[]): Promise<ProcessingResult> {
    console.log(`Processing batch of ${rawContent.length} items`);

    // Mark ALL input content as processed (even if filtered out)
    const allContentIds = rawContent
      .map((item: any) => item.id)
      .filter((id: any) => typeof id === 'number' && id > 0);

    const filtered = await this.filterStage(rawContent);
    console.log(`Filtered to ${filtered.length} relevant items`);

    const claims = await this.extractStage(filtered);
    console.log(`Extracted ${claims.length} claims`);

    const enriched = await this.enrichStage(claims);

    await this.storeResults(filtered, enriched);

    // Mark all input content as processed (not just filtered)
    if (allContentIds.length > 0) {
      await this.contentStore.markProcessed(allContentIds);
    }

    return {
      processed: rawContent.length,
      relevant: filtered.length,
      claimsExtracted: claims.length,
      timestamp: new Date()
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
    
    const syntheses: TopicSynthesis[] = [];
    
    for (const [topic, claims] of Object.entries(byTopic)) {
      if (topics && !topics.includes(topic)) continue;
      const synthesis = await this.synthesizeTopic(topic, claims);
      syntheses.push(synthesis);
    }
    
    const hypeAssessment = await this.generateHypeAssessment(syntheses);
    
    let digest: string | null = null;
    if (generateDigest) {
      digest = await this.agent.generateDigest(syntheses, hypeAssessment);
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

    if (this.useSkills) {
      // Process in batches of 20 (Agent SDK prompt limit)
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
    } else if (this.glm && this.glmFallback) {
      return this.filterWithGLM(preFiltered);
    } else {
      return preFiltered.map(c => ({
        ...c,
        relevance: 1.0,
        topic: 'general',
        contentType: 'opinion',
        authorCategory: 'unknown',
        isSubstantive: true,
        brief: ''
      } as FilteredContent));
    }
  }
  
  private async filterWithGLM(content: RawContent[]): Promise<FilteredContent[]> {
    const BATCH_SIZE = 20;
    const results: FilteredContent[] = [];
    
    for (let i = 0; i < content.length; i += BATCH_SIZE) {
      const batch = content.slice(i, i + BATCH_SIZE);
      const prompt = FILTER_PROMPT(batch);
      
      const response = await this.glm!.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        responseFormat: { type: 'json_object' }
      });
      
      const parsed = JSON.parse(response.content);
      const filtered = this.applyFilterResults(batch, parsed);
      results.push(...filtered);
    }
    
    return results;
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
          topic: assessment.topic || 'general',
          contentType: assessment.contentType || 'opinion',
          authorCategory: assessment.authorCategory || 'unknown',
          isSubstantive: assessment.isSubstantive !== false,
          brief: assessment.brief || ''
        } as FilteredContent;
      })
      .filter((item): item is FilteredContent => item !== null);
  }
  
  // ============================================================================
  // STAGE 2: EXTRACT
  // ============================================================================
  
  private async extractStage(content: FilteredContent[]): Promise<ExtractedClaim[]> {
    if (this.useSkills) {
      // Process in batches of 10 (Agent SDK prompt limit for deeper extraction)
      const BATCH_SIZE = 10;
      const allClaims: ExtractedClaim[] = [];

      for (let i = 0; i < content.length; i += BATCH_SIZE) {
        const batch = content.slice(i, i + BATCH_SIZE);
        console.log(`  Extracting batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(content.length / BATCH_SIZE)} (${batch.length} items)`);

        const result = await this.agent.extractClaims(batch);
        const claims = this.normalizeClaimResults(result);
        allClaims.push(...claims);
      }

      return allClaims;
    } else {
      return this.extractDirect(content);
    }
  }
  
  private extractDirect(content: FilteredContent[]): ExtractedClaim[] {
    return content.map(item => ({
      id: crypto.randomUUID(),
      contentId: undefined,  // Will be set during storage
      claimText: item.content?.slice(0, 500) || '',
      claimType: 'opinion' as const,
      topic: item.topic || 'general',
      stance: 'neutral' as const,
      bullishness: 0.5,
      confidence: 0.5,
      timeframe: null,
      evidenceProvided: 'weak' as const,
      quoteworthiness: 0.3,
      relatedTo: [],
      authorCategory: item.authorCategory || 'unknown',
      sourceUrl: item.url,  // Used to link back to content during storage
      extractedAt: new Date()
    }));
  }
  
  private normalizeClaimResults(result: any): ExtractedClaim[] {
    const claims: ExtractedClaim[] = [];
    const claimsArray = result.claims || result.raw?.claims || [];

    for (const claim of claimsArray) {
      claims.push({
        id: crypto.randomUUID(),
        contentId: claim.contentId,  // Will be set during storage if undefined
        claimText: claim.claimText || claim.text || '',
        claimType: claim.claimType || 'opinion',
        topic: claim.topic || 'general',
        stance: claim.stance || 'neutral',
        bullishness: claim.bullishness ?? 0.5,
        confidence: claim.confidence ?? 0.5,
        timeframe: claim.timeframe || null,
        evidenceProvided: claim.evidenceProvided || 'weak',
        quoteworthiness: claim.quoteworthiness ?? 0.3,
        relatedTo: claim.relatedTo || [],
        authorCategory: claim.authorCategory || 'unknown',
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
    for (const claim of claims) {
      try {
        const embedding = await this.embeddings.embed(claim.claimText);
        (claim as any).embedding = embedding;
      } catch (e) {
        console.warn(`Failed to embed claim: ${e}`);
      }
    }
    return claims;
  }
  
  // ============================================================================
  // STAGE 4: STORE
  // ============================================================================
  
  private async storeResults(
    filtered: FilteredContent[],
    claims: ExtractedClaim[]
  ): Promise<void> {
    // Build a map of content external IDs to database IDs
    const contentIdMap = new Map<string, number>();
    const processedIds: number[] = [];

    // First, store all content and collect their database IDs
    for (const item of filtered) {
      const anyItem = item as any;

      // If content already has a database ID, use it directly (from getRecent/getUnprocessed)
      if (anyItem.id && typeof anyItem.id === 'number') {
        const externalId = anyItem.external_id || `${item.source}_${item.publishedAt.getTime()}`;
        contentIdMap.set(externalId, anyItem.id);
        processedIds.push(anyItem.id);
        continue;
      }

      // Handle both snake_case (from DB) and camelCase (from fetcher) sourceId
      const sourceId = anyItem.sourceId || anyItem.source_id || 0;
      if (sourceId === 0) {
        console.warn(`Skipping content with no sourceId: ${item.url || item.title}`);
        continue;
      }

      const externalId = item.id || `${item.source}_${item.publishedAt.getTime()}`;
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
      });
      contentIdMap.set(externalId, contentId);
      processedIds.push(contentId);
    }

    // Mark all processed content
    if (processedIds.length > 0) {
      await this.contentStore.markProcessed(processedIds);
    }

    // Build a list of all content IDs for claim assignment
    const allContentIds = Array.from(contentIdMap.values());

    // Now store claims with proper contentId references
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      // Try to find contentId: from claim, from sourceUrl lookup, by index, or skip
      let contentId = claim.contentId ||
        (claim.sourceUrl ? contentIdMap.get(claim.sourceUrl) : undefined);

      // If no direct mapping, assign to content by modulo index (claims spread across content)
      if (!contentId && allContentIds.length > 0) {
        contentId = allContentIds[i % allContentIds.length];
      }

      // Skip claims with no valid content reference
      if (!contentId || contentId === 0) {
        console.warn(`Skipping claim with no content reference: "${claim.claimText?.slice(0, 50)}..."`);
        continue;
      }

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
        originalQuote: claim.originalQuote,
        author: claim.author,
        authorCategory: claim.authorCategory,
        sourceUrl: claim.sourceUrl,
        extractedAt: claim.extractedAt,
      } as EnrichedClaim);
    }
  }
  
  // ============================================================================
  // SYNTHESIS
  // ============================================================================
  
  private groupByTopic(claims: any[]): Record<string, any[]> {
    const groups: Record<string, any[]> = {};
    for (const claim of claims) {
      const topic = claim.topic || 'general';
      if (!groups[topic]) groups[topic] = [];
      groups[topic].push(claim);
    }
    return groups;
  }

  private async synthesizeTopic(topic: string, claims: any[]): Promise<TopicSynthesis> {
    const result = await this.agent.synthesize(claims, topic);

    return {
      topic,
      claimCount: claims.length, // Include for balanced digest coverage
      labConsensus: result.labConsensus || '',
      criticConsensus: result.criticConsensus || '',
      agreements: result.agreements || [],
      disagreements: result.disagreements || [],
      emergingNarratives: result.emergingNarratives || [],
      predictions: result.predictions || [],
      evidenceQuality: result.evidenceQuality ?? 0.5,
      hypeDelta: result.hypeDelta || { delta: 0, labSentiment: 0.5, criticSentiment: 0.5 },
      synthesisNarrative: result.synthesisNarrative || ''
    };
  }
  
  private async generateHypeAssessment(syntheses: TopicSynthesis[]): Promise<HypeAssessment> {
    const result = await this.agent.useSkill('hype-assessment', { syntheses });
    
    return {
      overhypedTopics: result.overhypedTopics || [],
      underhypedTopics: result.underhypedTopics || [],
      accuratelyAssessedTopics: result.accuratelyAssessedTopics || [],
      overallFieldSentiment: result.overallFieldSentiment ?? 0.5,
      summary: result.summary || ''
    };
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
    return this.agent.listSkills();
  }
  
  async listAgents(): Promise<string[]> {
    return this.agent.listAgents();
  }
  
  async useSkill(skillName: string, input: any): Promise<any> {
    return this.agent.useSkill(skillName, input);
  }
  
  async spawnSubagent(agentName: string, task: string): Promise<any> {
    return this.agent.spawnSubagent(agentName, task);
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { AIIntelAgent, GLMClient, ZAI_CONFIG } from './agent-sdk-wrapper';
export { ContentStore, ClaimStore, SynthesisStore } from './storage';
export { EmbeddingService } from './embeddings';
export { AIIntelFetcher, seedSources } from './fetcher';

/**
 * Type Definitions for AI Intelligence Extraction System
 */

// ============================================================================
// SOURCE TYPES
// ============================================================================

export type SourceType = 
  | 'twitter'
  | 'substack'
  | 'youtube'
  | 'blog'
  | 'podcast'
  | 'lesswrong'
  | 'arxiv'
  | 'bluesky';

export type AuthorCategory = 
  | 'lab-researcher'
  | 'critic'
  | 'academic'
  | 'independent'
  | 'journalist'
  | 'unknown';

export type ContentCategory =
  | 'anthropic'
  | 'openai'
  | 'deepmind'
  | 'meta'
  | 'xai'
  | 'mistral'
  | 'cohere'
  | 'huggingface'
  | 'ai2'
  | 'nvidia'
  | 'stability'
  | 'together'
  | 'reka'
  | 'critics'
  | 'safety'
  | 'academic'
  | 'independent';

// ============================================================================
// CONTENT TYPES
// ============================================================================

export interface RawContent {
  id?: string;
  sourceId?: number;  // Database source ID (from sources table)
  source: string;
  sourceType: SourceType;
  author: string;
  content: string;
  title?: string;
  url?: string;
  publishedAt: Date;
  metadata?: Record<string, any>;
}

export interface FilteredContent extends RawContent {
  relevance: number;
  topic: Topic;
  contentType: ContentType;
  isSubstantive: boolean;
  authorCategory: AuthorCategory;
  brief?: string;
}

// ============================================================================
// TOPIC & CONTENT TYPE
// ============================================================================

export type Topic = 
  | 'scaling'
  | 'reasoning'
  | 'agents'
  | 'safety'
  | 'interpretability'
  | 'multimodal'
  | 'rlhf'
  | 'robotics'
  | 'benchmarks'
  | 'infrastructure'
  | 'policy'
  | 'general'
  | 'other';

export type ContentType = 
  | 'prediction'
  | 'research-hint'
  | 'opinion'
  | 'factual'
  | 'critique'
  | 'meta'
  | 'noise';

// ============================================================================
// CLAIM TYPES
// ============================================================================

export type ClaimType = 
  | 'fact'
  | 'prediction'
  | 'hint'
  | 'opinion'
  | 'critique'
  | 'question';

export type Stance = 'bullish' | 'bearish' | 'neutral';

export type Timeframe = 
  | 'near-term'      // < 1 year
  | 'medium-term'    // 1-3 years
  | 'long-term'      // 3-10 years
  | 'unspecified'
  | null;

export type EvidenceQuality = 
  | 'strong'
  | 'moderate'
  | 'weak'
  | 'appeal-to-authority';

export interface ExtractedClaim {
  id?: string;
  contentId?: number;  // Reference to content table (aligned with storage.ts)
  claimText: string;
  claimType: ClaimType;
  topic: Topic;
  stance: Stance;
  bullishness: number;        // 0.0 (max bearish) to 1.0 (max bullish)
  confidence: number;          // 0.0 to 1.0 - how confident the author seems
  timeframe: Timeframe;
  targetEntity?: string;
  evidenceProvided?: EvidenceQuality;
  quoteworthiness?: number;    // 0.0 to 1.0
  relatedTo?: string[];        // entities, papers, models mentioned
  originalQuote?: string;
  author?: string;
  authorCategory?: AuthorCategory;
  sourceUrl?: string;
  extractedAt?: Date;
}

export interface EnrichedClaim extends ExtractedClaim {
  embedding?: number[];
  relatedClaims?: string[];
  potentialContradictions?: string[];
}

// ============================================================================
// SYNTHESIS TYPES
// ============================================================================

export interface HypeDelta {
  delta: number;              // -1 to +1: positive = overhyped
  labSentiment: number;       // 0 to 1
  criticSentiment: number;    // 0 to 1
  confidence: number;         // based on sample size
  labSampleSize?: number;
  criticSampleSize?: number;
}

export interface Disagreement {
  point: string;
  labPosition: string;
  criticPosition: string;
}

export interface TopicSynthesis {
  topic: Topic;
  claimCount: number; // Number of claims analyzed for this topic
  labConsensus: string;
  criticConsensus: string;
  keyAgreements: string[];
  keyDisagreements: Disagreement[];
  hypeDelta: HypeDelta;
  emergingNarratives: string[];
  notablePredictions: Prediction[];
  evidenceQuality: number;
  synthesisNarrative?: string;
}

export interface TopicHypeScore {
  topic: Topic;
  score: number;              // -1 (underhyped) to +1 (overhyped)
  reasoning: string;
  keyEvidence: string[];
}

export interface HypeAssessment {
  overhypedTopics: TopicHypeScore[];
  underhypedTopics: TopicHypeScore[];
  accuratelyAssessedTopics: TopicHypeScore[];
  overallFieldSentiment: number;
  summary: string;
}

export interface TopicConsensus {
  topic: Topic;
  labView: string;
  criticView: string;
  agreementLevel: number;     // 0 to 1
}

// ============================================================================
// PREDICTION TYPES
// ============================================================================

export type PredictionStatus = 
  | 'verified'
  | 'falsified'
  | 'partially-verified'
  | 'too-early'
  | 'unfalsifiable'
  | 'ambiguous';

export interface Prediction {
  id?: string;
  claimId?: string;
  text: string;
  author: string;
  confidence: number;
  timeframe: Timeframe;
  topic: Topic;
  madeAt: Date;
  targetDate?: Date;          // derived from timeframe
  verifiedAt?: Date;
  status?: PredictionStatus;
  accuracyScore?: number;
  evidence?: string;
  source?: string;
}

// ============================================================================
// DIGEST TYPES
// ============================================================================

export interface DigestSection {
  title: string;
  content: string;
}

export interface WeeklyDigest {
  generatedAt: Date;
  markdown: string;
  sections: DigestSection[];
  metadata?: {
    claimsProcessed: number;
    topicsAnalyzed: number;
    lookbackDays: number;
  };
}

// ============================================================================
// SYNTHESIS RESULT TYPES
// ============================================================================

export interface SynthesisOptions {
  lookbackDays?: number;
  topics?: Topic[] | null;
  generateDigest?: boolean;
  includeAllSources?: boolean;
  minClaimsPerTopic?: number;
}

export interface SynthesisResult {
  syntheses: TopicSynthesis[];
  hypeAssessment: HypeAssessment;
  digest: string | null;  // Markdown string from digest generation
  metadata?: {
    generatedAt: Date;
    processingTimeMs: number;
    claimsAnalyzed: number;
  };
}

// ============================================================================
// PROCESSING TYPES
// ============================================================================

export interface ProcessingResult {
  processed: number;
  relevant: number;
  claimsExtracted: number;
  timestamp: Date;
  errors?: string[];
}

export interface BatchResult<T> {
  successful: T[];
  failed: { item: any; error: string }[];
}

// ============================================================================
// API/OUTPUT TYPES
// ============================================================================

export interface ResearcherProfile {
  name: string;
  handle?: string;
  affiliation: string;
  category: AuthorCategory;
  topics: Topic[];
  recentClaims: ExtractedClaim[];
  predictionAccuracy?: number;
  activityLevel: 'high' | 'medium' | 'low';
}

export interface TopicDashboard {
  topic: Topic;
  summary: string;
  recentClaims: ExtractedClaim[];
  labVsCtriticSplit: HypeDelta;
  trendDirection: 'heating-up' | 'cooling-down' | 'stable';
  keyPlayers: string[];
  relatedTopics: Topic[];
}

export interface ClaimQuery {
  topic?: Topic;
  authorCategory?: AuthorCategory;
  author?: string;
  claimType?: ClaimType;
  stance?: Stance;
  minConfidence?: number;
  minBullishness?: number;
  maxBullishness?: number;
  days?: number;
  limit?: number;
  offset?: number;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface OrchestratorConfig {
  projectDir: string;
  dbUrl: string;
  embeddingProvider?: 'ollama' | 'openai' | 'voyage';
  useSkills?: boolean;
  glmFallback?: boolean;
}

export interface FetcherConfig {
  sources: SourceConfig[];
  rateLimitMs?: number;
  maxRetries?: number;
  timeout?: number;
}

export interface SourceConfig {
  type: SourceType;
  identifier: string;
  authorName?: string;
  category?: ContentCategory;
  tags?: string[];
  fetchFrequencyHours?: number;
  customParser?: string;
}

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

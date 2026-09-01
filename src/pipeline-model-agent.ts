/**
 * Provider-neutral pipeline agent.
 * Convenience methods keep the existing shape; inference goes through StageModelRouter.
 * Strict stage-specific Zod parsing. No silent fallback or retries.
 */
import { z } from 'zod';
import { groupByAuthorSide } from './author-side';
import { normalizeTopic } from './topic-taxonomy';
import {
  EXTRACTION_MAX_PROVIDER_CALLS,
  buildLiveExtractPrompt,
  chunkExtractionContent,
  mergeAdmittedClaims,
  parseLiveExtractClaimsOutput,
  type LiveExtractedClaim,
} from './extraction';
import { ModelRoutingError, type CompleteRequest, type CompleteResult, type Stage } from './model-routing';
import {
  TopicSynthesisSchema,
  toCanonicalTopicSynthesis,
  type TopicSynthesis,
} from './topic-synthesis';

export const STAGE_PROMPT_VERSIONS: Record<Stage, string> = Object.freeze({
  filter: '1',
  extraction: '1',
  quote_backfill: '1',
  synthesis: '1',
  hype_assessment: '1',
  digest: '1',
});

const FilterAssessmentSchema = z.object({
  idx: z.number().int().optional(),
  relevance: z.number(),
  topic: z.string().min(1),
  contentType: z.string().min(1),
  authorCategory: z.string().min(1),
  isSubstantive: z.boolean().optional(),
  brief: z.string().optional(),
});

const FilterResultSchema = z.object({
  assessments: z.array(FilterAssessmentSchema),
});

const HypeTopicSchema = z.object({
  topic: z.string(),
  score: z.number(),
  reasoning: z.string(),
  keyEvidence: z.array(z.string()),
});

export const HypeAssessmentSchema = z.object({
  overhypedTopics: z.array(HypeTopicSchema),
  underhypedTopics: z.array(HypeTopicSchema),
  accuratelyAssessedTopics: z.array(HypeTopicSchema),
  overallFieldSentiment: z.number(),
  summary: z.string(),
});

export type HypeAssessmentResult = z.infer<typeof HypeAssessmentSchema>;

export interface PipelineRouter {
  complete(stage: Stage, request: CompleteRequest): Promise<CompleteResult>;
}

export interface PipelineAgent {
  filterContent(content: unknown[]): Promise<{ assessments: z.infer<typeof FilterAssessmentSchema>[] }>;
  extractClaims(content: unknown[]): Promise<{
    claims: LiveExtractedClaim[];
    agentOutputs: number;
    rejectedClaims: number;
  }>;
  synthesize(claims: unknown[], topic: string): Promise<TopicSynthesis>;
  useSkill(skillName: string, input: unknown): Promise<HypeAssessmentResult>;
  generateDigest(syntheses: unknown[], hypeAssessment: unknown): Promise<string>;
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ModelRoutingError('schema');
  }
}

function schemaFail(): never {
  throw new ModelRoutingError('schema');
}

export class PipelineModelAgent implements PipelineAgent {
  private readonly router: PipelineRouter;

  constructor(opts: { router: PipelineRouter }) {
    this.router = opts.router;
  }

  async filterContent(content: unknown[]): Promise<{ assessments: z.infer<typeof FilterAssessmentSchema>[] }> {
    const contentWithIds = content.slice(0, 20).map((item, idx) => {
      const rec = item as Record<string, unknown>;
      const text = typeof rec.content === 'string'
        ? rec.content
        : typeof rec.content_text === 'string'
          ? rec.content_text
          : '';
      return {
        idx,
        id: rec.id,
        author: rec.author,
        content: text.slice(0, 500),
        url: rec.url,
      };
    });

    const prompt = `You are a content filter for AI research. Assess each item and return ONLY a JSON object.

Content items:
${JSON.stringify(contentWithIds, null, 2)}

For each item, assess:
- relevance: 0.0-1.0 (how relevant to AI research)
- topic: scaling|reasoning|agents|safety|interpretability|multimodal|rlhf|robotics|benchmarks|infrastructure|policy|general
- contentType: prediction|research-hint|opinion|factual|critique|meta|noise
- authorCategory: lab-researcher|critic|academic|independent|journalist|unknown
- isSubstantive: true/false
- brief: 1-sentence summary

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation. Format:
{"assessments": [{"idx": 0, "relevance": 0.8, "topic": "agents", "contentType": "opinion", "authorCategory": "lab-researcher", "isSubstantive": true, "brief": "..."}]}`;

    const result = await this.router.complete('filter', {
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'filter',
      promptVersion: STAGE_PROMPT_VERSIONS.filter,
    });
    const parsed = FilterResultSchema.safeParse(parseJsonObject(result.content));
    if (!parsed.success) schemaFail();
    if (parsed.data.assessments.length !== contentWithIds.length) schemaFail();
    return {
      assessments: parsed.data.assessments.map((assessment) => ({
        ...assessment,
        topic: normalizeTopic(assessment.topic),
      })),
    };
  }

  async extractClaims(content: unknown[]): Promise<{
    claims: LiveExtractedClaim[];
    agentOutputs: number;
    rejectedClaims: number;
  }> {
    const selected = content.slice(0, 10);
    const allowedContentIds = new Set<number>();
    for (const item of selected) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
        allowedContentIds.add(id);
      }
    }

    type ChunkJob = {
      contentId: number;
      author?: string;
      topic?: unknown;
      authorCategory?: unknown;
      chunk: string;
    };
    const jobs: ChunkJob[] = [];
    for (const item of selected) {
      const rec = item as Record<string, unknown>;
      const id = rec.id;
      if (typeof id !== 'number' || !allowedContentIds.has(id)) continue;
      const text = String(rec.content ?? rec.content_text ?? '');
      const chunks = chunkExtractionContent(text);
      for (const chunk of chunks) {
        if (jobs.length >= EXTRACTION_MAX_PROVIDER_CALLS) break;
        jobs.push({
          contentId: id,
          author: typeof rec.author === 'string' ? rec.author : undefined,
          topic: rec.topic,
          authorCategory: rec.authorCategory,
          chunk,
        });
      }
      if (jobs.length >= EXTRACTION_MAX_PROVIDER_CALLS) break;
    }

    let agentOutputs = 0;
    let rejectedClaims = 0;
    const admitted: LiveExtractedClaim[] = [];

    for (const job of jobs) {
      const prompt = buildLiveExtractPrompt({
        contentId: job.contentId,
        author: job.author,
        content: job.chunk,
        topic: job.topic,
        authorCategory: job.authorCategory,
      });
      const result = await this.router.complete('extraction', {
        messages: [{ role: 'user', content: prompt }],
        promptTemplateId: 'extraction',
        promptVersion: STAGE_PROMPT_VERSIONS.extraction,
      });
      const parsed = parseLiveExtractClaimsOutput(result.content, new Set([job.contentId]));
      agentOutputs += parsed.agentOutputs;
      rejectedClaims += parsed.rejectedClaims;
      if (!parsed.failedClosed) {
        admitted.push(...parsed.claims);
      }
    }

    const claims = mergeAdmittedClaims(admitted);
    rejectedClaims += admitted.length - claims.length;
    return { claims, agentOutputs, rejectedClaims };
  }

  async synthesize(claims: unknown[], topic: string): Promise<TopicSynthesis> {
    const grouped = groupByAuthorSide(claims, (c) => {
      const rec = c as { authorCategory?: unknown; author_category?: unknown };
      return rec.authorCategory ?? rec.author_category;
    });
    const labClaims = grouped.lab;
    const criticClaims = grouped.critic;
    const independentClaims = grouped.other;

    const avgBullishness = (arr: unknown[]): number => {
      if (arr.length === 0) return 0.5;
      let sum = 0;
      for (const c of arr) {
        const rec = c as { bullishness?: unknown };
        sum += typeof rec.bullishness === 'number' ? rec.bullishness : 0.5;
      }
      return sum / arr.length;
    };

    const labSentiment = avgBullishness(labClaims);
    const criticSentiment = avgBullishness(criticClaims);

    const formatClaims = (arr: unknown[], limit = 30) => arr.slice(0, limit).map((c) => {
      const rec = c as Record<string, unknown>;
      return {
        text: rec.claimText || rec.claim_text,
        author: rec.author,
        stance: rec.stance,
        bullishness: rec.bullishness,
        confidence: rec.confidence,
        claimType: rec.claimType || rec.claim_type,
      };
    });

    const prompt = `Use the topic-synthesis skill to synthesize ${claims.length} claims about "${topic}".

## Claim Distribution
- Lab researcher claims: ${labClaims.length}
- Critic claims: ${criticClaims.length}
- Independent claims: ${independentClaims.length}

## Lab Researcher Claims (${labClaims.length} total, showing ${Math.min(30, labClaims.length)}):
${JSON.stringify(formatClaims(labClaims), null, 2)}

## Critic Claims (${criticClaims.length} total, showing ${Math.min(30, criticClaims.length)}):
${JSON.stringify(formatClaims(criticClaims), null, 2)}

## Independent Claims (${independentClaims.length} total, showing ${Math.min(30, independentClaims.length)}):
${JSON.stringify(formatClaims(independentClaims), null, 2)}

## Pre-calculated Sentiment
- Lab average bullishness: ${labSentiment.toFixed(2)}
- Critic average bullishness: ${criticSentiment.toFixed(2)}
- Hype delta: ${(labSentiment - criticSentiment).toFixed(2)}

IMPORTANT: Analyze the actual claim content to identify:
1. What labs are saying (labConsensus) - 2-3 sentences from the lab claims
2. What critics are saying (criticConsensus) - 2-3 sentences from critic claims
3. Where they agree (agreements array) - specific points both sides accept
4. Where they disagree (disagreements array) - structured with point/labPosition/criticPosition
5. Emerging narratives - new framings appearing in the claims
6. Notable predictions (predictions array) - {text, author, confidence, timeframe}
7. A synthesisNarrative - 2 paragraphs summarizing the topic

Return ONLY valid JSON matching the topic-synthesis skill output format.`;

    const result = await this.router.complete('synthesis', {
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'synthesis',
      promptVersion: STAGE_PROMPT_VERSIONS.synthesis,
    });
    const parsed = parseJsonObject(result.content);
    const canonical = toCanonicalTopicSynthesis(parsed, { topic, claimCount: claims.length });
    if (canonical.unsupported) schemaFail();
    const stamped = TopicSynthesisSchema.safeParse(
      (() => {
        const { unsupported: _unused, ...rest } = canonical;
        return rest;
      })(),
    );
    if (!stamped.success) schemaFail();
    return stamped.data;
  }

  async useSkill(skillName: string, input: unknown): Promise<HypeAssessmentResult> {
    if (skillName !== 'hype-assessment' && skillName !== 'hype_assessment') {
      throw new ModelRoutingError('internal');
    }
    const rec = (input ?? {}) as { syntheses?: unknown };
    const syntheses = Array.isArray(rec.syntheses) ? rec.syntheses : [];
    const prompt = `Assess the AI research hype landscape from these topic syntheses and return ONLY JSON.

Syntheses:
${JSON.stringify(syntheses, null, 2)}

Return JSON with:
- overhypedTopics: [{topic, score, reasoning, keyEvidence[]}]
- underhypedTopics: [{topic, score, reasoning, keyEvidence[]}]
- accuratelyAssessedTopics: [{topic, score, reasoning, keyEvidence[]}]
- overallFieldSentiment: number 0-1
- summary: string

IMPORTANT: Return ONLY valid JSON, no markdown.`;

    const result = await this.router.complete('hype_assessment', {
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'hype_assessment',
      promptVersion: STAGE_PROMPT_VERSIONS.hype_assessment,
    });
    const parsed = HypeAssessmentSchema.safeParse(parseJsonObject(result.content));
    if (!parsed.success) schemaFail();
    return parsed.data;
  }

  async generateDigest(syntheses: unknown[], hypeAssessment: unknown): Promise<string> {
    const claimCounts = (Array.isArray(syntheses) ? syntheses : []).map((s) => {
      const rec = s as { topic?: unknown; claimCount?: unknown; claims?: unknown };
      return {
        topic: rec.topic,
        claimCount: typeof rec.claimCount === 'number'
          ? rec.claimCount
          : Array.isArray(rec.claims) ? rec.claims.length : 0,
      };
    }).sort((a, b) => b.claimCount - a.claimCount);

    const totalClaims = claimCounts.reduce((sum, t) => sum + t.claimCount, 0);
    const distribution = claimCounts.map((t) => ({
      ...t,
      percentage: totalClaims === 0 ? 0 : Math.round((100 * t.claimCount) / totalClaims),
    }));

    const prompt = `Generate a weekly AI research digest.

CRITICAL: You MUST cover topics PROPORTIONALLY to their claim volume.
Do NOT let hype signals dominate the digest. A topic with 15% of claims
should get roughly 3x the coverage of a topic with 5% of claims.

CLAIM DISTRIBUTION (cover proportionally):
${distribution.map((t) => `- ${t.topic}: ${t.claimCount} claims (${t.percentage}%)`).join('\n')}

Topic Syntheses:
${JSON.stringify(syntheses, null, 2)}

Hype Assessment:
${JSON.stringify(hypeAssessment, null, 2)}

REQUIREMENTS:
1. Include a "Topic Breakdown" section covering EACH topic with >3% of claims
2. The TL;DR must mention topics from across the claim distribution, not just hyped ones
3. Research Signals must include insights from multimodal, reasoning, agents - not just RLHF/safety

Return the digest as markdown.`;

    const result = await this.router.complete('digest', {
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'digest',
      promptVersion: STAGE_PROMPT_VERSIONS.digest,
    });
    if (typeof result.content !== 'string' || result.content.trim() === '') {
      throw new Error('digest must be nonblank markdown');
    }
    return result.content;
  }
}

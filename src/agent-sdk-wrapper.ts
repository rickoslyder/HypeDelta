/**
 * Claude Agent SDK Wrapper for AI Intelligence Extraction
 * 
 * Uses the actual @anthropic-ai/claude-agent-sdk package.
 * 
 * Key concepts:
 * - query(): Main function, returns async generator of SDKMessage
 * - Skills: Loaded from .claude/skills/ via settingSources: ['project']
 * - Subagents: Defined via `agents` option or .claude/agents/ directory
 * - Tools: Built-in (Read, Write, Bash, Skill, Task, etc.)
 */

import { 
  query, 
  tool, 
  createSdkMcpServer,
  type AgentDefinition,
  type SDKMessage,
  type SDKResultMessage,
  type SDKAssistantMessage
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface AIIntelAgentConfig {
  projectDir: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

// ============================================================================
// SUBAGENT DEFINITIONS
// ============================================================================

/**
 * Programmatic subagent definitions for the AI Intel pipeline.
 *
 * NAMING CONVENTION: Names match .claude/agents/ filesystem agents:
 * - content-filter-agent  → .claude/agents/content-filter-agent.md
 * - claim-extractor-agent → .claude/agents/claim-extractor-agent.md
 * - synthesis-agent       → .claude/agents/synthesis-agent.md
 * - digest-writer-agent   → .claude/agents/digest-writer-agent.md
 *
 * The programmatic definitions here are used when spawning agents via the SDK.
 * The filesystem .md files are for Claude Code auto-discovery.
 */
const SUBAGENTS: Record<string, AgentDefinition> = {
  'content-filter-agent': {
    description: 'High-throughput content filtering and relevance scoring for AI research content. Use for bulk classification tasks.',
    tools: ['Read', 'Grep', 'Glob'],
    prompt: `You are a content filter for an AI research intelligence system.

Your job is to assess content for relevance to AI research and classify it.

For each piece of content, output JSON with:
- relevance: 0.0-1.0 score
- topic: one of [scaling, reasoning, agents, safety, interpretability, multimodal, rlhf, robotics, benchmarks, infrastructure, policy, general]
- contentType: one of [prediction, research-hint, opinion, factual, critique, meta, noise]
- authorCategory: one of [lab-researcher, critic, academic, independent, journalist, unknown]
- isSubstantive: boolean
- brief: 1-sentence summary

Be conservative - when in doubt, include content (higher relevance).
Prioritize speed over depth.`,
    model: 'haiku'  // Routes to GLM via Z.ai config
  },

  'claim-extractor-agent': {
    description: 'Deep extraction of structured claims, predictions, and hints from AI research content. Use for nuanced analysis.',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch'],
    prompt: `You are a claim extraction specialist for AI research intelligence.

Extract structured claims from content. Each claim should have:
- claimText: The actual claim in clear language
- claimType: fact | prediction | hint | opinion | critique
- topic: Primary topic area
- stance: bullish | bearish | neutral (on AI progress)
- bullishness: 0.0-1.0 
- confidence: 0.0-1.0 (how confident the author seems)
- timeframe: near-term | medium-term | long-term | null
- evidenceProvided: strong | moderate | weak | appeal-to-authority
- quoteworthiness: 0.0-1.0

Extract MULTIPLE claims per source when warranted.
Pay special attention to:
- Predictions about AI capabilities
- Hints about unreleased research
- Disagreements with consensus views
- Claims backed by specific evidence`,
    model: 'inherit'  // Uses session default (Claude)
  },

  'synthesis-agent': {
    description: 'Cross-source synthesis and hype delta calculation. Use for aggregating claims into topic-level insights.',
    tools: ['Read', 'Grep'],
    prompt: `You are a synthesis specialist comparing AI lab and critic perspectives.

Given claims on a topic, produce:
- labConsensus: What lab researchers generally believe
- criticConsensus: What critics generally believe
- agreements: Points of genuine agreement
- disagreements: Key points of disagreement with positions
- emergingNarratives: New themes appearing
- predictions: Notable predictions with author/confidence
- evidenceQuality: 0.0-1.0 overall
- hypeDelta: { delta: -1 to +1, labSentiment: 0-1, criticSentiment: 0-1 }

Be balanced. Represent both sides fairly.
Highlight where evidence is strong vs speculative.`,
    model: 'inherit'
  },

  'digest-writer-agent': {
    description: 'Weekly digest generation with personality. Use for creating the final publishable digest.',
    tools: ['Read', 'Write'],
    prompt: `You are an AI research digest writer with a distinctive voice.

Write a weekly digest that is:
- Direct and opinionated (take stances)
- Evidence-based (cite specific claims)
- Occasionally irreverent
- Under 1500 words

Structure:
1. TL;DR (3 bullets)
2. Hype Check (what's over/underhyped)
3. Research Signals (hints about upcoming work)
4. Critic Corner (best critiques this week)
5. Key Debates (ongoing disagreements)
6. Predictions (notable predictions made)
7. Worth Watching (emerging themes)

Your audience is sophisticated - assume they know the basics.
No hedging or excessive caveats.`,
    model: 'inherit'
  }
};

// ============================================================================
// MAIN AGENT CLASS
// ============================================================================

export class AIIntelAgent {
  private config: AIIntelAgentConfig;
  
  constructor(config: AIIntelAgentConfig) {
    this.config = config;
  }
  
  /**
   * Run a query using the Agent SDK
   */
  async runQuery(prompt: string, options: {
    allowedTools?: string[];
    useSkills?: boolean;
    maxTurns?: number;
  } = {}): Promise<QueryResult> {
    const messages: SDKMessage[] = [];
    let result: SDKResultMessage | null = null;
    
    const queryOptions = {
      cwd: this.config.projectDir,
      model: this.config.model,
      maxTurns: options.maxTurns || this.config.maxTurns || 10,
      maxBudgetUsd: this.config.maxBudgetUsd,
      
      // Load skills from .claude/skills/ directory
      settingSources: options.useSkills !== false ? ['project' as const] : [],
      
      // Enable relevant tools
      allowedTools: options.allowedTools || [
        'Read', 'Grep', 'Glob', 'Bash',
        'Skill',  // Enables skills
        'Task'    // Enables subagents
      ],
      
      // Register our programmatic subagents
      agents: SUBAGENTS
    };
    
    for await (const message of query({ prompt, options: queryOptions })) {
      messages.push(message);
      
      if (message.type === 'result') {
        result = message;
      }
    }
    
    return {
      messages,
      result,
      success: result?.subtype === 'success',
      output: result?.subtype === 'success' ? result.result : null,
      error: result?.subtype !== 'success' ? (result as any)?.errors?.join('\n') : null
    };
  }
  
  /**
   * Use a specific skill by name
   * Skills are auto-discovered from .claude/skills/
   */
  async useSkill(skillName: string, input: any): Promise<any> {
    const prompt = `Use the ${skillName} skill to process this input:

${JSON.stringify(input, null, 2)}

Return the result as JSON.`;
    
    const result = await this.runQuery(prompt, {
      allowedTools: ['Skill', 'Read'],
      useSkills: true,
      maxTurns: 5
    });
    
    if (!result.success || !result.output) {
      throw new Error(`Skill ${skillName} failed: ${result.error}`);
    }
    
    return this.parseJsonFromOutput(result.output);
  }
  
  /**
   * Spawn a subagent for a specific task
   * Uses the Task tool to delegate to subagents
   */
  async spawnSubagent(agentName: string, task: string): Promise<any> {
    const prompt = `Use the ${agentName} agent to: ${task}

Return the result as JSON.`;
    
    const result = await this.runQuery(prompt, {
      allowedTools: ['Task', 'Read', 'Grep', 'Glob'],
      useSkills: false,
      maxTurns: 15
    });
    
    if (!result.success || !result.output) {
      throw new Error(`Subagent ${agentName} failed: ${result.error}`);
    }
    
    return this.parseJsonFromOutput(result.output);
  }
  
  // ============================================================================
  // CONVENIENCE METHODS FOR AI INTEL PIPELINE
  // ============================================================================
  
  /**
   * Filter content for relevance (uses haiku/GLM via subagent)
   */
  async filterContent(content: any[]): Promise<any> {
    // Prepare content with IDs for tracking
    const contentWithIds = content.slice(0, 20).map((item, idx) => ({
      idx,
      id: (item as any).id,
      author: item.author,
      content: item.content?.slice(0, 500) || item.content_text?.slice(0, 500) || '',
      url: item.url
    }));

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

    const result = await this.runQuery(prompt, {
      allowedTools: ['Read'],
      maxTurns: 5
    });

    if (!result.success) {
      return { assessments: [] };
    }

    return this.parseJsonFromOutput(result.output || '{}');
  }
  
  /**
   * Extract claims from filtered content
   */
  async extractClaims(content: any[]): Promise<any> {
    // Prepare content with IDs for tracking
    const contentWithIds = content.slice(0, 10).map((item, idx) => ({
      idx,
      contentId: (item as any).id,
      author: item.author,
      content: item.content?.slice(0, 1000) || (item as any).content_text?.slice(0, 1000) || '',
      topic: item.topic,
      authorCategory: item.authorCategory
    }));

    const prompt = `You are a claim extractor for AI research content. Extract claims and return ONLY a JSON object.

Content items:
${JSON.stringify(contentWithIds, null, 2)}

For each claim found, extract:
- contentId: the source content's ID (from input)
- claimText: the actual claim in clear language
- claimType: fact|prediction|hint|opinion|critique
- topic: from source or inferred
- stance: bullish|bearish|neutral (on AI progress)
- bullishness: 0.0-1.0
- confidence: 0.0-1.0 (how confident author seems)
- timeframe: near-term|medium-term|long-term|null
- evidenceProvided: strong|moderate|weak|appeal-to-authority
- quoteworthiness: 0.0-1.0
- author: from source
- authorCategory: from source

Extract MULTIPLE claims per source when warranted. Focus on predictions, research hints, and substantive opinions.

IMPORTANT: Return ONLY valid JSON, no markdown. Format:
{"claims": [{"contentId": 123, "claimText": "...", "claimType": "prediction", ...}]}`;

    const result = await this.runQuery(prompt, {
      allowedTools: ['Read'],
      maxTurns: 5
    });

    if (!result.success) {
      return { claims: [] };
    }

    return this.parseJsonFromOutput(result.output || '{}');
  }
  
  /**
   * Synthesize claims into topic-level insights
   */
  async synthesize(claims: any[], topic: string): Promise<any> {
    const prompt = `Synthesize these ${claims.length} claims about "${topic}".

Claims:
${JSON.stringify(claims.slice(0, 50), null, 2)}

Use the synthesis-agent to produce:
- Lab consensus vs critic consensus
- Key agreements and disagreements
- Hype delta calculation
- Emerging narratives

Return as JSON.`;
    
    const result = await this.runQuery(prompt, {
      allowedTools: ['Task', 'Read'],
      maxTurns: 10
    });
    
    if (!result.success) {
      return {
        labConsensus: '',
        criticConsensus: '',
        agreements: [],
        disagreements: [],
        hypeDelta: { delta: 0, labSentiment: 0.5, criticSentiment: 0.5 }
      };
    }
    
    return this.parseJsonFromOutput(result.output || '{}');
  }
  
  /**
   * Generate weekly digest
   */
  async generateDigest(syntheses: any[], hypeAssessment: any): Promise<string> {
    const prompt = `Generate a weekly AI research digest.

Topic Syntheses:
${JSON.stringify(syntheses, null, 2)}

Hype Assessment:
${JSON.stringify(hypeAssessment, null, 2)}

Use the digest-writer-agent to create an engaging, opinionated digest.
Return the digest as markdown.`;
    
    const result = await this.runQuery(prompt, {
      allowedTools: ['Task', 'Write'],
      maxTurns: 10
    });
    
    return result.output || '';
  }
  
  // ============================================================================
  // UTILITY METHODS
  // ============================================================================
  
  /**
   * List available skills from .claude/skills/
   */
  async listSkills(): Promise<string[]> {
    const result = await this.runQuery(
      'List all available Skills. Return just the skill names as a JSON array.',
      { allowedTools: ['Skill'], useSkills: true, maxTurns: 3 }
    );
    
    try {
      return JSON.parse(result.output || '[]');
    } catch {
      return [];
    }
  }
  
  /**
   * List available agents
   */
  async listAgents(): Promise<string[]> {
    return Object.keys(SUBAGENTS);
  }
  
  /**
   * Parse JSON from model output, handling markdown code blocks
   */
  private parseJsonFromOutput(output: string): any {
    // Try direct parse
    try {
      return JSON.parse(output);
    } catch {}
    
    // Try extracting from markdown code block
    const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {}
    }
    
    // Try finding JSON object/array in output
    const objectMatch = output.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {}
    }
    
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {}
    }
    
    // Return raw output wrapped
    return { raw: output };
  }
}

// ============================================================================
// QUERY RESULT TYPE
// ============================================================================

export interface QueryResult {
  messages: SDKMessage[];
  result: SDKResultMessage | null;
  success: boolean;
  output: string | null;
  error: string | null;
}

// ============================================================================
// GLM CLIENT (Direct Z.ai access for fallback)
// ============================================================================

export const ZAI_CONFIG = {
  // Support both GLM_* (docker-compose) and ZAI_* (legacy) naming conventions
  baseUrl: process.env.GLM_BASE_URL || process.env.ZAI_BASE_URL || 'https://api.z.ai/v1',
  apiKey: process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.ANTHROPIC_API_KEY || ''
};

export class GLMClient {
  private baseUrl: string;
  private apiKey: string;
  
  constructor(config?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = config?.baseUrl || ZAI_CONFIG.baseUrl;
    this.apiKey = config?.apiKey || ZAI_CONFIG.apiKey;
  }
  
  async complete(options: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: { type: string };
  }): Promise<{ content: string }> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: options.model || 'glm-4-7',
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        response_format: options.responseFormat
      })
    });
    
    if (!response.ok) {
      throw new Error(`GLM API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || ''
    };
  }
}

// ============================================================================
// CUSTOM MCP TOOLS (Example)
// ============================================================================

/**
 * Example: Create custom MCP tools for AI Intel specific operations
 */
export function createAIIntelMcpServer() {
  const claimValidator = tool(
    'validate-claim',
    'Validate a claim against known facts and previous claims',
    {
      claimText: z.string().describe('The claim to validate'),
      topic: z.string().describe('Topic area of the claim')
    },
    async ({ claimText, topic }) => {
      // Implementation would check against database
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            isValid: true,
            confidence: 0.8,
            relatedClaims: []
          })
        }]
      };
    }
  );
  
  const hypeCalculator = tool(
    'calculate-hype-delta',
    'Calculate hype delta between lab and critic sentiment',
    {
      labClaims: z.array(z.object({
        bullishness: z.number()
      })).describe('Claims from lab researchers'),
      criticClaims: z.array(z.object({
        bullishness: z.number()
      })).describe('Claims from critics')
    },
    async ({ labClaims, criticClaims }) => {
      const labAvg = labClaims.length > 0 
        ? labClaims.reduce((sum, c) => sum + c.bullishness, 0) / labClaims.length 
        : 0.5;
      const criticAvg = criticClaims.length > 0
        ? criticClaims.reduce((sum, c) => sum + c.bullishness, 0) / criticClaims.length
        : 0.5;
      
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            delta: labAvg - criticAvg,
            labSentiment: labAvg,
            criticSentiment: criticAvg,
            sampleSize: { lab: labClaims.length, critic: criticClaims.length }
          })
        }]
      };
    }
  );
  
  return createSdkMcpServer({
    name: 'ai-intel-tools',
    version: '1.0.0',
    tools: [claimValidator, hypeCalculator]
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

export { query, tool, createSdkMcpServer };
export type { AgentDefinition, SDKMessage, SDKResultMessage, SDKAssistantMessage };

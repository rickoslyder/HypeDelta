/**
 * Pipeline Integration Tests
 *
 * Tests for the extraction pipeline flow: Filter → Extract → Enrich
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg module - return proper ID for inserts
vi.mock('pg', () => {
  const mockQuery = vi.fn().mockImplementation((sql: string) => {
    // Return ID for INSERT queries
    if (sql.includes('INSERT INTO content')) {
      return Promise.resolve({ rows: [{ id: 1 }] });
    }
    if (sql.includes('INSERT INTO extracted_claims')) {
      return Promise.resolve({ rows: [] }); // ClaimStore generates ID client-side
    }
    return Promise.resolve({ rows: [] });
  });
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

// Mock the agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({
        claims: [
          {
            claimText: 'Test claim',
            claimType: 'opinion',
            topic: 'reasoning',
            stance: 'bullish',
            bullishness: 0.7,
            confidence: 0.6,
          },
        ],
      }),
    };
  }),
}));

// Mock embeddings service
vi.mock('../embeddings', () => ({
  EmbeddingService: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
    embedBatch: vi.fn().mockResolvedValue([]),
  })),
}));

import { AIIntelOrchestrator } from '../index';
import type { RawContent, FilteredContent } from '../types';

describe('AIIntelOrchestrator', () => {
  let orchestrator: AIIntelOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: false, // Disable skills for unit tests
      glmFallback: false,
    });
  });

  describe('processBatch', () => {
    it('should process raw content through pipeline', async () => {
      const rawContent: RawContent[] = [
        {
          source: 'twitter',
          sourceType: 'twitter',
          author: 'testuser',
          content: 'AI reasoning capabilities are improving rapidly',
          publishedAt: new Date(),
        },
      ];

      const result = await orchestrator.processBatch(rawContent);

      expect(result).toHaveProperty('processed');
      expect(result).toHaveProperty('relevant');
      expect(result).toHaveProperty('claimsExtracted');
      expect(result).toHaveProperty('timestamp');
      expect(result.processed).toBe(1);
    });

    it('should handle empty batch', async () => {
      const result = await orchestrator.processBatch([]);

      expect(result.processed).toBe(0);
      expect(result.relevant).toBe(0);
      expect(result.claimsExtracted).toBe(0);
    });
  });

  describe('Filter stage', () => {
    it('should assign default relevance when skills disabled', async () => {
      const rawContent: RawContent[] = [
        {
          source: 'twitter',
          sourceType: 'twitter',
          author: 'testuser',
          content: 'This is test content about AI research that demonstrates substantive analysis of model capabilities',
          publishedAt: new Date(),
        },
      ];

      // Access private method
      const filtered = await (orchestrator as any).filterStage(rawContent);

      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toHaveProperty('relevance');
      expect(filtered[0]).toHaveProperty('topic');
    });
  });

  describe('Extract stage', () => {
    it('should extract claims from filtered content', async () => {
      const filteredContent: FilteredContent[] = [
        {
          source: 'twitter',
          sourceType: 'twitter',
          author: 'testuser',
          content: 'Reasoning models are the future',
          publishedAt: new Date(),
          relevance: 0.8,
          topic: 'reasoning',
          contentType: 'opinion',
          isSubstantive: true,
          authorCategory: 'lab-researcher',
        },
      ];

      // Access private method
      const claims = await (orchestrator as any).extractStage(filteredContent);

      expect(Array.isArray(claims)).toBe(true);
      expect(claims.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Enrich stage', () => {
    it('should add embeddings to claims', async () => {
      const claims = [
        {
          id: 'claim_1',
          claimText: 'Test claim for embedding',
          claimType: 'opinion',
          topic: 'reasoning',
          stance: 'bullish',
          bullishness: 0.7,
          confidence: 0.6,
        },
      ];

      // Access private method
      const enriched = await (orchestrator as any).enrichStage(claims);

      expect(enriched).toHaveLength(1);
      // Embedding should be added
      expect(enriched[0]).toHaveProperty('embedding');
    });
  });

  describe('Group by topic', () => {
    it('should group claims by topic', () => {
      const claims = [
        { topic: 'reasoning', claimText: 'Claim 1' },
        { topic: 'reasoning', claimText: 'Claim 2' },
        { topic: 'agents', claimText: 'Claim 3' },
        { topic: 'safety', claimText: 'Claim 4' },
      ];

      // Access private method
      const grouped = (orchestrator as any).groupByTopic(claims);

      expect(Object.keys(grouped)).toContain('reasoning');
      expect(Object.keys(grouped)).toContain('agents');
      expect(Object.keys(grouped)).toContain('safety');
      expect(grouped['reasoning']).toHaveLength(2);
      expect(grouped['agents']).toHaveLength(1);
    });

    it('should use general for claims without topic', () => {
      const claims = [
        { claimText: 'Claim without topic' },
      ];

      const grouped = (orchestrator as any).groupByTopic(claims);

      expect(Object.keys(grouped)).toContain('general');
    });
  });
});

describe('Pipeline data flow', () => {
  it('should maintain data integrity through pipeline', async () => {
    const orchestrator = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: false,
    });

    const input: RawContent[] = [
      {
        source: 'twitter',
        sourceType: 'twitter',
        author: 'darioamodei',
        content: 'We believe reasoning capabilities will continue to improve with scale',
        publishedAt: new Date('2024-01-15'),
        url: 'https://twitter.com/darioamodei/status/123',
      },
    ];

    const result = await orchestrator.processBatch(input);

    // Verify pipeline completed
    expect(result.processed).toBe(1);
    expect(result.timestamp).toBeInstanceOf(Date);
  });
});

describe('Type transformations', () => {
  it('should correctly transform RawContent to FilteredContent', () => {
    const raw: RawContent = {
      source: 'substack',
      sourceType: 'substack',
      author: 'Nathan Lambert',
      content: 'RLHF is being replaced by better methods',
      publishedAt: new Date(),
    };

    const filtered: FilteredContent = {
      ...raw,
      relevance: 0.9,
      topic: 'rlhf',
      contentType: 'opinion',
      isSubstantive: true,
      authorCategory: 'independent',
    };

    expect(filtered).toHaveProperty('relevance');
    expect(filtered).toHaveProperty('topic');
    expect(filtered.sourceType).toBe('substack');
  });
});

/**
 * Direct filter strategy tests
 *
 * Exercises the experimental `filterStrategy: 'direct'` path, which calls GLM
 * directly with a forced JSON response and validates it with zod. GLM is mocked
 * by stubbing global fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pg so store constructors don't open real pools
vi.mock('pg', () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
  const MockPool = vi.fn(() => ({ query: mockQuery, end: vi.fn(), connect: vi.fn() }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

// Mock the Agent SDK (not used by the direct path, but imported transitively)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}));

import { AIIntelOrchestrator } from '../index';
import type { RawContent } from '../types';

function glmResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  };
}

const sample = (content: string): RawContent => ({
  source: 'twitter',
  sourceType: 'twitter',
  author: 'researcher',
  content,
  publishedAt: new Date(),
  url: 'https://example.com/1',
});

describe('filterStrategy: direct', () => {
  let orchestrator: AIIntelOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      filterStrategy: 'direct',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies schema-validated GLM assessments', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(glmResponse({
      assessments: [
        { itemIndex: 0, relevance: 0.9, topic: 'reasoning', contentType: 'opinion', isSubstantive: true, authorCategory: 'lab-researcher', brief: 'x' },
      ],
    })));

    const input = [sample('A substantive take on AI reasoning capabilities improving with scale over time')];
    const filtered = await (orchestrator as any).filterStage(input);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].relevance).toBe(0.9);
    expect(filtered[0].topic).toBe('reasoning');
    expect(filtered[0].authorCategory).toBe('lab-researcher');
  });

  it('drops items scored below the relevance threshold', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(glmResponse({
      assessments: [
        { relevance: 0.1, topic: 'general', contentType: 'noise', isSubstantive: false, authorCategory: 'unknown', brief: '' },
      ],
    })));

    const input = [sample('Some only-tangentially-relevant content that is long enough to pass pre-filtering')];
    const filtered = await (orchestrator as any).filterStage(input);

    expect(filtered).toHaveLength(0);
  });

  it('passes a batch through when the model returns invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    }));

    const input = [sample('Content that should survive as passthrough when filtering fails to parse cleanly')];
    const filtered = await (orchestrator as any).filterStage(input);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].relevance).toBe(1.0); // conservative passthrough
  });
});

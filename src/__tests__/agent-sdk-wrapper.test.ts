/**
 * Contract tests for the live extractClaims path.
 * The live allowedTools path does not invoke Skill/Task — the prompt itself
 * must require originalQuote/contentId and must not truncate at 1,000 chars.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const captured: { prompt?: string; options?: Record<string, unknown> }[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* (args: { prompt?: string; options?: Record<string, unknown> }) {
    captured.push({ prompt: args.prompt, options: args.options });
    yield {
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({ claims: [] }),
    };
  }),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}));

import { AIIntelAgent } from '../agent-sdk-wrapper';

const WRAPPER_SRC = readFileSync(resolve(__dirname, '../agent-sdk-wrapper.ts'), 'utf8');

describe('AIIntelAgent.extractClaims live prompt contract', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('includes content after character 1,000 and requires originalQuote + contentId', async () => {
    const agent = new AIIntelAgent({ projectDir: '/test' });
    const tailToken = 'UNIQUE_TAIL_TOKEN_AFTER_1000_CHARS';
    const longContent = `${'A'.repeat(1000)}${tailToken} trailing context for extraction`;

    await agent.extractClaims([
      {
        id: 42,
        author: 'tester',
        content: longContent,
        topic: 'reasoning',
        authorCategory: 'lab-researcher',
      },
    ]);

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured[0].prompt || '';
    const options = captured[0].options || {};

    expect(prompt).toContain(tailToken);
    expect(prompt).toMatch(/originalQuote/);
    expect(prompt).toMatch(/contentId/);
    expect(prompt).toMatch(/verbatim|exact/i);
    expect(prompt).toMatch(/required/i);
    expect(prompt).toMatch(/non-empty|nonempty|must not be empty/i);

    const allowedTools = (options.allowedTools as string[]) || [];
    expect(allowedTools).not.toContain('Skill');
    expect(allowedTools).not.toContain('Task');
  });

  it('uses a named per-item extraction content limit of at least 6,000 characters', () => {
    const extractionSrc = readFileSync(resolve(__dirname, '../extraction.ts'), 'utf8');
    const match = extractionSrc.match(/EXTRACTION_CONTENT_LIMIT\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const limit = Number(match![1]);
    expect(limit).toBeGreaterThanOrEqual(6000);
    expect(limit).toBeLessThan(100_000);

    const extractFn = WRAPPER_SRC.slice(
      WRAPPER_SRC.indexOf('async extractClaims'),
      WRAPPER_SRC.indexOf('async synthesize'),
    );
    expect(extractFn).toMatch(/chunkExtractionContent/);
    expect(extractFn).not.toMatch(/slice\(\s*0\s*,\s*1000\s*\)/);
  });
});

describe('programmatic claim-extractor-agent definition', () => {
  it('requires contentId and originalQuote as an exact verbatim span', () => {
    const start = WRAPPER_SRC.indexOf("'claim-extractor-agent'");
    const end = WRAPPER_SRC.indexOf("'synthesis-agent'");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = WRAPPER_SRC.slice(start, end);

    expect(block).toMatch(/originalQuote/);
    expect(block).toMatch(/contentId/);
    expect(block).toMatch(/verbatim|exact/i);
    expect(block).toMatch(/required/i);
  });
});

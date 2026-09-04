/**
 * Packet 11A — live extractClaims ingestion.
 * Fake runQuery only (no extractClaims mock, no real providers).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg', () => {
  const MockPool = vi.fn(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn(),
    connect: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'result', subtype: 'success', result: JSON.stringify({ claims: [] }) };
  }),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}));

vi.mock('../embeddings', () => ({
  EmbeddingService: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
    embedBatch: vi.fn().mockResolvedValue([]),
  })),
}));

import { AIIntelOrchestrator } from '../index';
import {
  LiveExtractedClaimSchema,
  EXTRACTION_CHUNK_SIZE,
  EXTRACTION_CHUNK_OVERLAP,
  EXTRACTION_MAX_CHUNKS,
  EXTRACTION_MAX_TOTAL_CHARS,
  EXTRACTION_MAX_PROVIDER_CALLS,
} from '../extraction';
import { PipelineModelAgent } from '../pipeline-model-agent';

const SOURCE_HEAD = 'Labs report bounded eval gains on reasoning suites. ';
const TAIL_QUOTE = 'TAIL_QUOTE_AFTER_CHAR_6000';
const OVERLAP_QUOTE = 'OVERLAP_UNIQUE_QUOTE_SPAN';
const VALID_QUOTE = 'Labs report bounded eval gains';

function claimJson(overrides: Record<string, unknown> = {}) {
  return {
    contentId: 11,
    claimText: 'Eval gains remain bounded',
    claimType: 'opinion',
    topic: 'reasoning',
    stance: 'neutral',
    originalQuote: VALID_QUOTE,
    ...overrides,
  };
}

function okResult(claims: unknown[]) {
  return {
    success: true,
    output: JSON.stringify({ claims }),
    error: null,
    messages: [],
    result: null,
  };
}

function item(content: string, id = 11) {
  return {
    id,
    source: 'twitter',
    sourceType: 'twitter',
    author: 'fixture-author',
    content,
    publishedAt: new Date('2026-08-01T00:00:00Z'),
    sourceId: 1,
    url: `https://example.test/post/${id}`,
    external_id: `ext-${id}`,
  };
}

function longBody(tail: string, at = 6000) {
  const pad = 'x'.repeat(Math.max(0, at - SOURCE_HEAD.length));
  return `${SOURCE_HEAD}${pad}${tail} trailing.`;
}

function overlapBody() {
  const at = EXTRACTION_CHUNK_SIZE - Math.floor(EXTRACTION_CHUNK_OVERLAP / 2);
  const prefix = SOURCE_HEAD + 'y'.repeat(Math.max(0, at - SOURCE_HEAD.length));
  // Pad past one chunk so the overlap quote is present in two provider prompts.
  const tail = 'y'.repeat(EXTRACTION_CHUNK_SIZE);
  return `${prefix}${OVERLAP_QUOTE} ${tail}`;
}

describe('packet 11A live claim ingestion', () => {
  let orch: AIIntelOrchestrator;
  let clientQuery: ReturnType<typeof vi.fn>;
  let prompts: string[];
  let runQuery: any;

  beforeEach(() => {
    vi.clearAllMocks();
    prompts = [];
    runQuery = vi.fn(async (...args: unknown[]) => {
      prompts.push(String(args[0] ?? ''));
      return okResult([]);
    });
    const router = {
      complete: async (_stage: string, request: { messages: Array<{ content: string }> }) => {
        const result = await runQuery(request.messages[0].content);
        return { content: result.output ?? '{}' };
      },
    };
    const real = new PipelineModelAgent({ router: router as never });
    const agent = {
      filterContent: async (...args: unknown[]) => {
        const items = (args[0] as unknown[]) || [];
        return {
          assessments: items.map((_, idx) => ({
            idx,
            relevance: 0.9,
            topic: 'reasoning',
            contentType: 'opinion',
            authorCategory: 'lab-researcher',
            isSubstantive: true,
            brief: 'ok',
          })),
        };
      },
      extractClaims: (content: unknown[]) => real.extractClaims(content),
      synthesize: real.synthesize.bind(real),
      useSkill: real.useSkill.bind(real),
      generateDigest: real.generateDigest.bind(real),
    };
    orch = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: true,
      agent,
    });
    clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const pool = (orch as any).contentStore.pool;
    pool.connect.mockResolvedValue({ query: clientQuery, release: vi.fn() });
  });

  const inserts = () =>
    clientQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO extracted_claims'),
    );

  const logs = () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return {
      warn,
      log,
      joined: () => [...warn.mock.calls, ...log.mock.calls].map((c) => c.map(String).join(' ')).join('\n'),
      restore: () => {
        warn.mockRestore();
        log.mockRestore();
      },
    };
  };

  it('exports one Zod runtime schema requiring contentId, nonblank claimText, originalQuote', () => {
    expect(LiveExtractedClaimSchema.safeParse(claimJson()).success).toBe(true);
    expect(LiveExtractedClaimSchema.safeParse(claimJson({ claimText: '  ' })).success).toBe(false);
    expect(LiveExtractedClaimSchema.safeParse(claimJson({ originalQuote: '' })).success).toBe(false);
    expect(LiveExtractedClaimSchema.safeParse(claimJson({ contentId: '11' })).success).toBe(false);
    expect(LiveExtractedClaimSchema.safeParse({ claimText: 'x', originalQuote: 'y' }).success).toBe(false);
  });

  it('exports documented chunk/provider caps', () => {
    expect(EXTRACTION_CHUNK_SIZE).toBeGreaterThanOrEqual(6000);
    expect(EXTRACTION_CHUNK_OVERLAP).toBeGreaterThan(0);
    expect(EXTRACTION_CHUNK_OVERLAP).toBeLessThan(EXTRACTION_CHUNK_SIZE);
    expect(EXTRACTION_MAX_CHUNKS).toBeGreaterThan(1);
    expect(EXTRACTION_MAX_TOTAL_CHARS).toBeGreaterThan(EXTRACTION_CHUNK_SIZE);
    expect(EXTRACTION_MAX_PROVIDER_CALLS).toBeGreaterThan(0);
    expect(EXTRACTION_MAX_PROVIDER_CALLS).toBeLessThanOrEqual(EXTRACTION_MAX_CHUNKS * 10);
  });

  it('blank originalQuote persists zero', async () => {
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([claimJson({ originalQuote: '   ' })]);
    });
    const body = `${SOURCE_HEAD}more substantive fixture text for filtering.`;
    const spy = logs();
    const result = await orch.processBatch([item(body)] as any);
    spy.restore();
    expect(inserts()).toHaveLength(0);
    expect(result.claimsExtracted).toBe(0);
    expect(result.persistedClaims).toBe(0);
    expect(spy.joined()).not.toContain(body);
  });

  it('paraphrase originalQuote persists zero', async () => {
    const body = `${SOURCE_HEAD}more substantive fixture text for filtering.`;
    const paraphrase = 'paraphrased claim text not present in source';
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([claimJson({ originalQuote: paraphrase, claimText: 'paraphrase' })]);
    });
    const spy = logs();
    const result = await orch.processBatch([item(body)] as any);
    spy.restore();
    expect(inserts()).toHaveLength(0);
    expect(result.persistedClaims).toBe(0);
    expect(result.claimsExtracted).toBe(0);
    expect(spy.joined()).not.toContain(paraphrase);
    expect(spy.joined()).not.toContain(body);
  });

  it('unknown contentId persists zero (fail closed)', async () => {
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([claimJson({ contentId: 999, originalQuote: VALID_QUOTE })]);
    });
    const result = await orch.processBatch([
      item(`${SOURCE_HEAD}more substantive fixture text for filtering.`),
    ] as any);
    expect(inserts()).toHaveLength(0);
    expect(result.persistedClaims).toBe(0);
    expect(result.claimsExtracted).toBe(0);
  });

  it('conflicting duplicate claims persist zero (fail closed)', async () => {
    const body = `${SOURCE_HEAD}second exact span lives here too.`;
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([
        claimJson({ claimText: 'same claim', originalQuote: VALID_QUOTE }),
        claimJson({
          claimText: 'same claim',
          originalQuote: 'second exact span lives here too',
        }),
      ]);
    });
    const result = await orch.processBatch([item(body)] as any);
    expect(inserts()).toHaveLength(0);
    expect(result.persistedClaims).toBe(0);
    expect(result.claimsExtracted).toBe(0);
  });

  it('malformed model output persists zero (fail closed)', async () => {
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return { success: true, output: 'NOT_JSON', error: null, messages: [], result: null };
    });
    const result = await orch.processBatch([
      item(`${SOURCE_HEAD}more substantive fixture text for filtering.`),
    ] as any);
    expect(inserts()).toHaveLength(0);
    expect(result.persistedClaims).toBe(0);
  });

  it('valid tail quote after char 6000 persists once and is shown to the provider', async () => {
    const body = longBody(TAIL_QUOTE, 6000);
    expect(body.indexOf(TAIL_QUOTE)).toBeGreaterThanOrEqual(6000);
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      if (!prompt.includes(TAIL_QUOTE)) return okResult([]);
      return okResult([
        claimJson({
          claimText: 'tail-span claim',
          originalQuote: TAIL_QUOTE,
        }),
      ]);
    });
    const spy = logs();
    const result = await orch.processBatch([item(body)] as any);
    spy.restore();
    expect(prompts.some((p) => p.includes(TAIL_QUOTE))).toBe(true);
    expect(inserts()).toHaveLength(1);
    expect(result.persistedClaims).toBe(1);
    expect(result.claimsExtracted).toBe(1);
    expect((inserts()[0][1] as unknown[]).includes(TAIL_QUOTE)).toBe(true);
    expect(spy.joined()).not.toContain(body);
    expect(spy.joined()).not.toContain(TAIL_QUOTE);
  });

  it('provider calls obey exported caps', async () => {
    const body = 'z'.repeat(EXTRACTION_MAX_TOTAL_CHARS + EXTRACTION_CHUNK_SIZE * 5);
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([]);
    });
    await orch.processBatch([item(`Labs report ${body}`)] as any);
    expect(runQuery.mock.calls.length).toBeGreaterThan(0);
    expect(runQuery.mock.calls.length).toBeLessThanOrEqual(EXTRACTION_MAX_PROVIDER_CALLS);
    expect(runQuery.mock.calls.length).toBeLessThanOrEqual(EXTRACTION_MAX_CHUNKS);
  });

  it('dedupes identical cross-chunk overlap claims to one persist', async () => {
    const body = overlapBody();
    expect(body.includes(OVERLAP_QUOTE)).toBe(true);
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      if (!prompt.includes(OVERLAP_QUOTE)) return okResult([]);
      return okResult([
        claimJson({
          claimText: 'overlap claim',
          originalQuote: OVERLAP_QUOTE,
        }),
      ]);
    });
    const result = await orch.processBatch([item(body)] as any);
    expect(prompts.filter((p) => p.includes(OVERLAP_QUOTE)).length).toBeGreaterThan(1);
    expect(inserts()).toHaveLength(1);
    expect(result.persistedClaims).toBe(1);
    expect(result.claimsExtracted).toBe(1);
  });

  it('no-agent mode stores zero fabricated claims', async () => {
    const noAgent = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: false,
    });
    const q = vi.fn().mockResolvedValue({ rows: [] });
    (noAgent as any).contentStore.pool.connect.mockResolvedValue({ query: q, release: vi.fn() });
    await expect(
      noAgent.processBatch([
        item(`${SOURCE_HEAD}more substantive fixture text for filtering.`),
      ] as any),
    ).rejects.toThrow(/disabled|fabricat|extract/i);
    expect(
      q.mock.calls.some(
        (c: unknown[]) => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO extracted_claims'),
      ),
    ).toBe(false);
  });

  it('metrics are honest: claimsExtracted is persisted count', async () => {
    const body = `${SOURCE_HEAD}more substantive fixture text for filtering.`;
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([
        claimJson({ originalQuote: VALID_QUOTE, claimText: 'valid' }),
        claimJson({ originalQuote: 'paraphrase not in source', claimText: 'bad' }),
      ]);
    });
    const result = await orch.processBatch([item(body)] as any);
    expect(result.persistedClaims).toBe(inserts().length);
    expect(result.claimsExtracted).toBe(result.persistedClaims);
    expect(result.agentOutputs).toBeGreaterThanOrEqual(result.admittedClaims);
    expect(result.rejectedClaims).toBe(result.agentOutputs - result.persistedClaims);
    expect(result.persistedClaims).toBe(1);
    expect(result.agentOutputs).toBe(2);
    expect(result.rejectedClaims).toBe(1);
  });

  it('rejects cross-item contentId spoofing even when the quote is common to both', async () => {
    const COMMON_QUOTE = 'SHARED_QUOTE_SPAN_BOTH_ITEMS';
    const body = `${SOURCE_HEAD}${COMMON_QUOTE} more substantive fixture text for filtering.`;
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      const m = prompt.match(/"contentId":\s*(\d+)/);
      const promptId = m ? Number(m[1]) : 0;
      if (promptId === 11) {
        return okResult([
          claimJson({
            contentId: 12,
            claimText: 'spoofed onto the other selected item',
            originalQuote: COMMON_QUOTE,
          }),
        ]);
      }
      return okResult([]);
    });
    const result = await orch.processBatch([item(body, 11), item(body, 12)] as any);
    expect(inserts()).toHaveLength(0);
    expect(result.persistedClaims).toBe(0);
    expect(result.claimsExtracted).toBe(0);
  });

  it('ignores model sourceUrl/author spoof in stored params', async () => {
    const body = `${SOURCE_HEAD}more substantive fixture text for filtering.`;
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([
        claimJson({
          originalQuote: VALID_QUOTE,
          sourceUrl: 'https://evil.example/spoofed',
          author: 'spoof-author',
        }),
      ]);
    });
    const result = await orch.processBatch([item(body, 11)] as any);
    expect(result.persistedClaims).toBe(1);
    expect(inserts()).toHaveLength(1);
    const params = inserts()[0][1] as unknown[];
    expect(params).toContain('https://example.test/post/11');
    expect(params).toContain('fixture-author');
    expect(params).not.toContain('https://evil.example/spoofed');
    expect(params).not.toContain('spoof-author');
  });

  it('rejects conflicting mappings across chunk responses', async () => {
    const body = overlapBody();
    let n = 0;
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      n += 1;
      if (n === 1) {
        return okResult([
          claimJson({
            claimText: 'same mapped claim',
            originalQuote: VALID_QUOTE,
          }),
        ]);
      }
      return okResult([
        claimJson({
          claimText: 'same mapped claim',
          originalQuote: OVERLAP_QUOTE,
        }),
      ]);
    });
    const result = await orch.processBatch([item(body)] as any);
    expect(prompts.length).toBeGreaterThan(1);
    expect(inserts()).toHaveLength(0);
    expect(result.persistedClaims).toBe(0);
    expect(result.claimsExtracted).toBe(0);
  });

  it('live extract prompt requires exact nonblank verbatim contiguous source span', async () => {
    runQuery.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return okResult([]);
    });
    await orch.processBatch([
      item(`${SOURCE_HEAD}more substantive fixture text for filtering.`),
    ] as any);
    expect(prompts.length).toBeGreaterThan(0);
    const joined = prompts.join('\n');
    expect(joined).toMatch(/originalQuote/);
    expect(joined).toMatch(/contentId/);
    expect(joined).toMatch(/verbatim/i);
    expect(joined).toMatch(/contiguous/i);
    expect(joined).toMatch(/non-?blank/i);
    expect(joined).toMatch(/exact/i);
  });
});

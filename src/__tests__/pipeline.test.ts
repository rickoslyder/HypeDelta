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
    // storeResults runs inside a transaction; the client reuses mockQuery so
    // INSERT routing (and BEGIN/COMMIT/ROLLBACK) behave as expected.
    connect: vi.fn().mockResolvedValue({
      query: mockQuery,
      release: vi.fn(),
    }),
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
            contentId: 1,
            originalQuote: 'Test claim',
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
    });
  });

  const enableSkillsExtraction = (orch: AIIntelOrchestrator) => {
    (orch as any).useSkills = true;
    if (!(orch as any).agent) {
      (orch as any).agent = {
        filterContent: async () => ({ assessments: [] }),
        extractClaims: async () => ({ claims: [] }),
        synthesize: async () => ({}),
        useSkill: async () => ({}),
        generateDigest: async () => '# digest',
      };
    }
    vi.spyOn((orch as any).agent, 'filterContent').mockImplementation(async (...args: unknown[]) => {
      const items = (args[0] as any[]) || [];
      return {
        assessments: items.map((_: any, idx: number) => ({
          idx,
          relevance: 0.9,
          topic: 'reasoning',
          contentType: 'opinion',
          authorCategory: 'lab-researcher',
          isSubstantive: true,
          brief: 'ok',
        })),
      };
    });
    vi.spyOn((orch as any).agent, 'extractClaims').mockImplementation(async (...args: unknown[]) => {
      const items = (args[0] as any[]) || [];
      return {
        claims: items.map((item: any) => {
          const text = String(item.content || item.content_text || '');
          return {
            contentId: typeof item.id === 'number' ? item.id : undefined,
            claimText: text.slice(0, 80) || 'extracted claim',
            claimType: 'opinion',
            topic: item.topic || 'reasoning',
            stance: 'neutral',
            originalQuote: text.slice(0, Math.min(48, text.length)),
            sourceUrl: item.url,
            author: item.author,
            authorCategory: item.authorCategory || 'lab-researcher',
          };
        }),
      };
    });
  };

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

  describe('storeResults transaction', () => {
    const sampleContent = () => [
      {
        source: 'twitter',
        sourceType: 'twitter',
        author: 'testuser',
        content: 'AI reasoning capabilities are improving rapidly and substantively',
        publishedAt: new Date(),
        sourceId: 1,
        url: 'https://example.com/post/1',
      } as any,
    ];

    it('wraps content and claim writes in a single transaction', async () => {
      enableSkillsExtraction(orchestrator);
      const pool = (orchestrator.contentStore as any).pool;

      await orchestrator.processBatch([{
        ...sampleContent()[0],
        id: 1,
        external_id: 'ext-1',
      }]);

      expect(pool.connect).toHaveBeenCalled();
      const statements = (pool.query as any).mock.calls.map((c: any[]) => c[0]);
      expect(statements).toContain('BEGIN');
      expect(statements).toContain('COMMIT');
      // Claim is bound to the server-selected contentId, not a model sourceUrl.
      expect(statements.some((s: string) => s.includes('INSERT INTO extracted_claims'))).toBe(true);
    });

    it('rolls back and rethrows when a write fails', async () => {
      enableSkillsExtraction(orchestrator);
      const pool = (orchestrator.contentStore as any).pool;
      const client = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('INSERT INTO content')) {
            return Promise.reject(new Error('boom'));
          }
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn(),
      };
      pool.connect.mockResolvedValueOnce(client);

      await expect(orchestrator.processBatch(sampleContent())).rejects.toThrow('boom');

      const statements = client.query.mock.calls.map((c: any[]) => c[0]);
      expect(statements).toContain('BEGIN');
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
      expect(client.release).toHaveBeenCalled();
    });

    it('marks all input content IDs in the same transaction after claim writes', async () => {
      enableSkillsExtraction(orchestrator);
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO content')) {
          return Promise.resolve({ rows: [{ id: 10 }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const client = { query: clientQuery, release: vi.fn() };
      pool.connect.mockResolvedValueOnce(client);

      // One eligible item with DB id, one short noise item that is pre-filtered out
      const input = [
        {
          id: 42,
          source: 'twitter',
          sourceType: 'twitter',
          author: 'testuser',
          content: 'AI reasoning capabilities are improving rapidly and substantively enough',
          publishedAt: new Date(),
          sourceId: 1,
          url: 'https://example.com/post/42',
          external_id: 'ext-42',
        },
        {
          id: 43,
          source: 'twitter',
          sourceType: 'twitter',
          author: 'testuser',
          content: 'short',
          publishedAt: new Date(),
          sourceId: 1,
          url: 'https://example.com/post/43',
          external_id: 'ext-43',
        },
      ] as any[];

      await orchestrator.processBatch(input);

      const calls = clientQuery.mock.calls.map((c: any[]) => ({ sql: c[0] as string, params: c[1] }));
      expect(calls.map((c) => c.sql)).toContain('BEGIN');
      expect(calls.map((c) => c.sql)).toContain('COMMIT');

      const markCall = calls.find((c) => c.sql.includes('UPDATE content') && c.sql.includes('processed_at'));
      expect(markCall).toBeDefined();
      const markedIds = [...(markCall!.params[0] as number[])].sort((a, b) => a - b);
      expect(markedIds).toEqual([42, 43]);

      // Mark must happen inside the transaction (after BEGIN, before COMMIT)
      const beginIdx = calls.findIndex((c) => c.sql === 'BEGIN');
      const markIdx = calls.findIndex((c) => c.sql.includes('UPDATE content') && c.sql.includes('processed_at'));
      const claimIdx = calls.findIndex((c) => c.sql.includes('INSERT INTO extracted_claims'));
      const commitIdx = calls.findIndex((c) => c.sql === 'COMMIT');
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(markIdx).toBeGreaterThan(beginIdx);
      expect(claimIdx).toBeGreaterThan(beginIdx);
      expect(markIdx).toBeLessThan(commitIdx);
      expect(claimIdx).toBeLessThan(commitIdx);

      // No post-transaction markProcessed on the pool (outside the client txn)
      const poolMarkCalls = (pool.query as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE content') && c[0].includes('processed_at')
      );
      expect(poolMarkCalls).toHaveLength(0);
    });

    it('rolls back with no COMMIT when a claim write fails', async () => {
      enableSkillsExtraction(orchestrator);
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO extracted_claims')) {
          return Promise.reject(new Error('claim write failed'));
        }
        if (sql.includes('INSERT INTO content')) {
          return Promise.resolve({ rows: [{ id: 10 }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const client = { query: clientQuery, release: vi.fn() };
      pool.connect.mockResolvedValueOnce(client);

      await expect(
        orchestrator.processBatch([
          {
            id: 99,
            source: 'twitter',
            sourceType: 'twitter',
            author: 'testuser',
            content: 'AI reasoning capabilities are improving rapidly and substantively enough',
            publishedAt: new Date(),
            sourceId: 1,
            url: 'https://example.com/post/99',
            external_id: 'ext-99',
          } as any,
        ])
      ).rejects.toThrow('claim write failed');

      const statements = clientQuery.mock.calls.map((c: any[]) => c[0] as string);
      expect(statements).toContain('BEGIN');
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
      // Mark must not land after a failed claim write
      expect(statements.some((s) => s.includes('UPDATE content') && s.includes('processed_at'))).toBe(false);
      expect(client.release).toHaveBeenCalled();
    });

    it('rolls back with no COMMIT when markProcessed fails', async () => {
      enableSkillsExtraction(orchestrator);
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('UPDATE content') && sql.includes('processed_at')) {
          return Promise.reject(new Error('mark failed'));
        }
        if (sql.includes('INSERT INTO content')) {
          return Promise.resolve({ rows: [{ id: 10 }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const client = { query: clientQuery, release: vi.fn() };
      pool.connect.mockResolvedValueOnce(client);

      await expect(
        orchestrator.processBatch([
          {
            id: 77,
            source: 'twitter',
            sourceType: 'twitter',
            author: 'testuser',
            content: 'AI reasoning capabilities are improving rapidly and substantively enough',
            publishedAt: new Date(),
            sourceId: 1,
            url: 'https://example.com/post/77',
            external_id: 'ext-77',
          } as any,
        ])
      ).rejects.toThrow('mark failed');

      const statements = clientQuery.mock.calls.map((c: any[]) => c[0] as string);
      expect(statements).toContain('BEGIN');
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
      expect(client.release).toHaveBeenCalled();
    });

    it('fills blank claim sourceUrl/author from resolved content provenance only', async () => {
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO content')) {
          return Promise.resolve({ rows: [{ id: 55 }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const client = { query: clientQuery, release: vi.fn() };
      pool.connect.mockResolvedValueOnce(client);

      const filtered = [
        {
          id: 55,
          source: 'twitter',
          sourceType: 'twitter',
          author: 'content-author',
          content: 'AI reasoning capabilities are improving rapidly and substantively enough',
          publishedAt: new Date(),
          sourceId: 1,
          url: 'https://example.com/post/55',
          external_id: 'ext-55',
          source_identifier: 'sama',
          author_name: 'Sam Altman',
          relevance: 0.9,
          topic: 'reasoning',
          contentType: 'opinion',
          isSubstantive: true,
          authorCategory: 'lab-researcher',
        },
      ] as any[];

      // Claim omits sourceUrl and author; contentId is set so resolution succeeds
      const claims = [
        {
          contentId: 55,
          claimText: 'Reasoning will keep improving',
          claimType: 'opinion',
          topic: 'reasoning',
          stance: 'bullish',
          bullishness: 0.7,
          confidence: 0.6,
          author: '',
          sourceUrl: '',
          authorCategory: 'lab-researcher',
          originalQuote: 'AI reasoning capabilities are improving rapidly',
        },
      ];

      await (orchestrator as any).storeResults(filtered, claims, [55]);

      const claimInsert = clientQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims')
      );
      expect(claimInsert).toBeDefined();
      const params = claimInsert![1] as unknown[];
      // author and source_url are near the end of the insert param list
      // (see ClaimStore.upsert): ... original_quote, author, author_category, source_url, metadata
      expect(params).toContain('sama');
      expect(params).toContain('https://example.com/post/55');
      // Must not invent a different source handle
      expect(params).not.toContain('invented-handle');
    });

    it('ignores model-supplied sourceUrl/author in favor of canonical provenance', async () => {
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockImplementation((sql: string) => {
        return Promise.resolve({ rows: [] });
      });
      const client = { query: clientQuery, release: vi.fn() };
      pool.connect.mockResolvedValueOnce(client);

      const filtered = [
        {
          id: 66,
          source: 'twitter',
          sourceType: 'twitter',
          author: 'content-author',
          content: 'AI reasoning capabilities are improving rapidly and substantively enough',
          publishedAt: new Date(),
          sourceId: 1,
          url: 'https://example.com/content-url',
          external_id: 'ext-66',
          source_identifier: 'content-handle',
          relevance: 0.9,
          topic: 'reasoning',
          contentType: 'opinion',
          isSubstantive: true,
          authorCategory: 'lab-researcher',
        },
      ] as any[];

      const claims = [
        {
          contentId: 66,
          claimText: 'Explicit provenance wins',
          claimType: 'opinion',
          topic: 'reasoning',
          stance: 'neutral',
          bullishness: 0.5,
          confidence: 0.5,
          author: 'extract-author',
          sourceUrl: 'https://example.com/extract-url',
          authorCategory: 'critic',
          originalQuote: 'AI reasoning capabilities are improving rapidly',
        },
      ];

      await (orchestrator as any).storeResults(filtered, claims, [66]);

      const claimInsert = clientQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims')
      );
      expect(claimInsert).toBeDefined();
      const params = claimInsert![1] as unknown[];
      expect(params).toContain('content-handle');
      expect(params).toContain('https://example.com/content-url');
      expect(params).not.toContain('extract-author');
      expect(params).not.toContain('https://example.com/extract-url');
    });

    it('still drops claims whose content is not resolved in the transaction', async () => {
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
      const client = { query: clientQuery, release: vi.fn() };
      pool.connect.mockResolvedValueOnce(client);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await (orchestrator as any).storeResults(
        [
          {
            id: 1,
            source: 'twitter',
            sourceType: 'twitter',
            author: 'x',
            content: 'AI reasoning capabilities are improving rapidly and substantively enough',
            publishedAt: new Date(),
            sourceId: 1,
            url: 'https://example.com/1',
            external_id: 'e1',
            relevance: 0.9,
            topic: 'reasoning',
            contentType: 'opinion',
            isSubstantive: true,
            authorCategory: 'lab-researcher',
          },
        ],
        [
          {
            contentId: 999, // not in batch
            claimText: 'Orphan claim should drop',
            claimType: 'opinion',
            topic: 'reasoning',
            stance: 'neutral',
            bullishness: 0.5,
            confidence: 0.5,
          },
        ],
        [1]
      );

      expect(
        clientQuery.mock.calls.some(
          (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims')
        )
      ).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    const ledgerContent = (overrides: Record<string, unknown> = {}) => ({
      id: 55,
      source: 'twitter',
      sourceType: 'twitter',
      author: 'content-author',
      content: 'AI reasoning capabilities are improving rapidly and substantively enough',
      publishedAt: new Date(),
      sourceId: 1,
      url: 'https://example.com/post/55',
      external_id: 'ext-55',
      source_identifier: 'sama',
      author_name: 'Sam Altman',
      relevance: 0.9,
      topic: 'reasoning',
      contentType: 'opinion',
      isSubstantive: true,
      authorCategory: 'lab-researcher',
      ...overrides,
    });

    const ledgerClaim = (overrides: Record<string, unknown> = {}) => ({
      contentId: 55,
      claimText: 'Reasoning will keep improving',
      claimType: 'opinion',
      topic: 'reasoning',
      stance: 'bullish',
      bullishness: 0.7,
      confidence: 0.6,
      authorCategory: 'lab-researcher',
      originalQuote: 'AI reasoning capabilities are improving rapidly',
      ...overrides,
    });

    const connectClient = () => {
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
      const client = { query: clientQuery, release: vi.fn() };
      pool.connect.mockResolvedValueOnce(client);
      return { pool, clientQuery, client };
    };

    const claimInserts = (clientQuery: ReturnType<typeof vi.fn>) =>
      clientQuery.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims'),
      );

    it('stores a claim whose originalQuote is an exact substring of resolved source content', async () => {
      const { clientQuery } = connectClient();
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent()],
        [ledgerClaim()],
        [55],
      );
      expect(stored).toBe(1);
      expect(claimInserts(clientQuery)).toHaveLength(1);
      const params = claimInserts(clientQuery)[0][1] as unknown[];
      expect(params).toContain('AI reasoning capabilities are improving rapidly');
    });

    it('drops a blank originalQuote with a generic warning that does not echo quote or source', async () => {
      const { clientQuery } = connectClient();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const source = 'AI reasoning capabilities are improving rapidly and substantively enough';
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent({ content: source })],
        [ledgerClaim({ originalQuote: '   ' })],
        [55],
      );
      expect(stored).toBe(0);
      expect(claimInserts(clientQuery)).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
      const msgs = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msgs.length).toBeLessThan(200);
      expect(msgs).not.toContain(source);
      expect(msgs).not.toMatch(/AI reasoning capabilities/);
      warn.mockRestore();
    });

    it('drops a non-substring originalQuote with a generic warning that does not echo quote or source', async () => {
      const { clientQuery } = connectClient();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const invented = 'this quote does not appear in the source body at all';
      const source = 'AI reasoning capabilities are improving rapidly and substantively enough';
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent({ content: source })],
        [ledgerClaim({ originalQuote: invented })],
        [55],
      );
      expect(stored).toBe(0);
      expect(claimInserts(clientQuery)).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
      const msgs = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msgs).not.toContain(invented);
      expect(msgs).not.toContain(source);
      warn.mockRestore();
    });

    it('stores a post-1000-character originalQuote that occurs in the resolved source', async () => {
      const { clientQuery } = connectClient();
      const tailQuote = 'UNIQUE_POST_1000_QUOTE_SPAN';
      const content = `${'Z'.repeat(1000)}${tailQuote} more source after the unique span`;
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent({ content })],
        [ledgerClaim({ originalQuote: tailQuote })],
        [55],
      );
      expect(stored).toBe(1);
      expect(claimInserts(clientQuery)).toHaveLength(1);
      const params = claimInserts(clientQuery)[0][1] as unknown[];
      expect(params).toContain(tailQuote);
    });

    it('validates originalQuote against the resolved batch item, not claim.sourceUrl', async () => {
      const { clientQuery } = connectClient();
      const itemA = ledgerContent({
        id: 10,
        url: 'https://example.com/a',
        content: 'Alpha source contains the ALPHA_ONLY_QUOTE token here.',
        external_id: 'ext-a',
      });
      const itemB = ledgerContent({
        id: 20,
        url: 'https://example.com/b',
        content: 'Beta source contains the BETA_ONLY_QUOTE token here.',
        external_id: 'ext-b',
      });

      const storedValid = await (orchestrator as any).storeResults(
        [itemA, itemB],
        [
          ledgerClaim({
            contentId: 10,
            sourceUrl: 'https://example.com/b',
            originalQuote: 'ALPHA_ONLY_QUOTE',
          }),
        ],
        [10, 20],
      );
      expect(storedValid).toBe(1);

      const { clientQuery: q2 } = connectClient();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const storedInvalid = await (orchestrator as any).storeResults(
        [itemA, itemB],
        [
          ledgerClaim({
            contentId: 10,
            sourceUrl: 'https://example.com/b',
            originalQuote: 'BETA_ONLY_QUOTE',
          }),
        ],
        [10, 20],
      );
      expect(storedInvalid).toBe(0);
      expect(claimInserts(q2)).toHaveLength(0);
      const msgs = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msgs).not.toContain('BETA_ONLY_QUOTE');
      expect(msgs).not.toContain('Alpha source');
      warn.mockRestore();
      expect(claimInserts(clientQuery)).toHaveLength(1);
    });

    it('returns only the count of claims actually stored', async () => {
      const { clientQuery } = connectClient();
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent()],
        [
          ledgerClaim({ originalQuote: 'AI reasoning capabilities are improving rapidly' }),
          ledgerClaim({ originalQuote: '' }),
          ledgerClaim({ originalQuote: 'not in the source' }),
          ledgerClaim({ contentId: 999, originalQuote: 'AI reasoning capabilities are improving rapidly' }),
        ],
        [55],
      );
      expect(stored).toBe(1);
      expect(claimInserts(clientQuery)).toHaveLength(1);
    });

    it('persists a quote-backed prediction claim into predictions before COMMIT', async () => {
      const { clientQuery } = connectClient();
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent()],
        [ledgerClaim({ claimType: 'prediction', timeframe: 'near-term' })],
        [55],
      );
      expect(stored).toBe(1);
      const calls = clientQuery.mock.calls.map((c: any[]) => ({ sql: String(c[0]), params: c[1] }));
      const predIdx = calls.findIndex((c) => c.sql.includes('INSERT INTO predictions'));
      const claimIdx = calls.findIndex((c) => c.sql.includes('INSERT INTO extracted_claims'));
      const commitIdx = calls.findIndex((c) => c.sql === 'COMMIT');
      expect(claimIdx).toBeGreaterThanOrEqual(0);
      expect(predIdx).toBeGreaterThan(claimIdx);
      expect(predIdx).toBeLessThan(commitIdx);
      expect(calls[predIdx].sql).toMatch(
        /ON CONFLICT\s*\(\s*claim_id\s*\)\s*WHERE\s+claim_id\s+IS NOT NULL/i,
      );
    });

    it('does not insert predictions for a quote-backed non-prediction claim', async () => {
      const { clientQuery } = connectClient();
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent()],
        [ledgerClaim({ claimType: 'opinion' })],
        [55],
      );
      expect(stored).toBe(1);
      expect(claimInserts(clientQuery)).toHaveLength(1);
      expect(
        clientQuery.mock.calls.some(
          (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO predictions'),
        ),
      ).toBe(false);
    });

    it('does not persist a prediction that fails quote-backed admission', async () => {
      const { clientQuery } = connectClient();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stored = await (orchestrator as any).storeResults(
        [ledgerContent()],
        [ledgerClaim({ claimType: 'prediction', originalQuote: '' })],
        [55],
      );
      expect(stored).toBe(0);
      expect(claimInserts(clientQuery)).toHaveLength(0);
      expect(
        clientQuery.mock.calls.some(
          (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO predictions'),
        ),
      ).toBe(false);
      warn.mockRestore();
    });
  });

  describe('evidence-ledger processBatch', () => {
    it('reports claimsExtracted as stored count, not raw model claim length', async () => {
      const skillsAgent = {
        filterContent: async () => ({ assessments: [] }),
        extractClaims: async () => ({ claims: [] }),
        synthesize: async () => ({}),
        useSkill: async () => ({}),
        generateDigest: async () => '# digest',
      };
      const skillsOrch = new AIIntelOrchestrator({
        projectDir: '/test',
        dbUrl: 'postgresql://localhost/test',
        useSkills: true,
        agent: skillsAgent as never,
      });
      const pool = (skillsOrch.contentStore as any).pool;
      const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
      pool.connect.mockResolvedValueOnce({ query: clientQuery, release: vi.fn() });

      const source = 'AI reasoning capabilities are improving rapidly and substantively enough';
      vi.spyOn((skillsOrch as any).agent, 'filterContent').mockResolvedValue({
        assessments: [
          {
            idx: 0,
            relevance: 0.9,
            topic: 'reasoning',
            contentType: 'opinion',
            authorCategory: 'lab-researcher',
            isSubstantive: true,
            brief: 'ok',
          },
        ],
      });
      vi.spyOn((skillsOrch as any).agent, 'extractClaims').mockResolvedValue({
        claims: [
          {
            contentId: 81,
            claimText: 'valid',
            claimType: 'opinion',
            topic: 'reasoning',
            stance: 'neutral',
            originalQuote: 'AI reasoning capabilities are improving rapidly',
          },
          {
            contentId: 81,
            claimText: 'invalid',
            claimType: 'opinion',
            topic: 'reasoning',
            stance: 'neutral',
            originalQuote: 'fabricated paraphrase not in source',
          },
        ],
      });

      const result = await skillsOrch.processBatch([
        {
          id: 81,
          source: 'twitter',
          sourceType: 'twitter',
          author: 'testuser',
          content: source,
          publishedAt: new Date(),
          sourceId: 1,
          url: 'https://example.com/post/81',
          external_id: 'ext-81',
        } as any,
      ]);

      expect(result.claimsExtracted).toBe(1);
      const inserts = clientQuery.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims'),
      );
      expect(inserts).toHaveLength(1);
    });

    it('fails closed before marking processed when skills/model extraction is disabled', async () => {
      const pool = (orchestrator.contentStore as any).pool;
      const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
      pool.connect.mockResolvedValue({ query: clientQuery, release: vi.fn() });

      await expect(
        orchestrator.processBatch([
          {
            id: 90,
            source: 'twitter',
            sourceType: 'twitter',
            author: 'testuser',
            content: 'AI reasoning capabilities are improving rapidly and substantively enough',
            publishedAt: new Date(),
            sourceId: 1,
            url: 'https://example.com/post/90',
          } as any,
        ]),
      ).rejects.toThrow(/extract|disabled|fabricat|skills|model/i);

      const statements = clientQuery.mock.calls.map((c: any[]) => String(c[0]));
      expect(statements.some((s) => s.includes('processed_at'))).toBe(false);
      expect(statements.some((s) => s.includes('INSERT INTO extracted_claims'))).toBe(false);
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

      await expect((orchestrator as any).extractStage(filteredContent)).rejects.toThrow(
        /disabled|fabricat|extract/i,
      );
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

    it('should use other for claims without topic', () => {
      const claims = [
        { claimText: 'Claim without topic' },
      ];

      const grouped = (orchestrator as any).groupByTopic(claims);

      expect(Object.keys(grouped)).toContain('other');
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

    await expect(orchestrator.processBatch(input)).rejects.toThrow(/disabled|fabricat|extract/i);
  });
});

describe('AIIntelOrchestrator.close', () => {
  it('closes owned content, claim, and synthesis stores', async () => {
    const orchestrator = new AIIntelOrchestrator({
      projectDir: '/test',
      dbUrl: 'postgresql://localhost/test',
      useSkills: false,
    });
    const contentClose = vi.spyOn(orchestrator.contentStore, 'close').mockResolvedValue(undefined);
    const claimClose = vi.spyOn(orchestrator.claimStore, 'close').mockResolvedValue(undefined);
    const synthesisClose = vi.spyOn(orchestrator.synthesisStore, 'close').mockResolvedValue(undefined);

    await orchestrator.close();

    expect(contentClose).toHaveBeenCalledTimes(1);
    expect(claimClose).toHaveBeenCalledTimes(1);
    expect(synthesisClose).toHaveBeenCalledTimes(1);
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

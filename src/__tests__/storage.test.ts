/**
 * Storage Layer Tests
 *
 * Tests for ContentStore, ClaimStore, SourceStore, SynthesisStore, and PredictionTracker.
 * Uses mocked pg Pool to avoid database dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg module
vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: vi.fn(),
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

import pg from 'pg';
import { ContentStore, ClaimStore, SourceStore, SynthesisStore, PredictionTracker } from '../storage';
import type { Source, Content, EnrichedClaim } from '../storage';

const mockPool = new pg.Pool({ connectionString: 'mock://test' });
const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;

describe('ContentStore', () => {
  let store: ContentStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ContentStore('postgresql://localhost/test');
  });

  describe('upsert', () => {
    it('should insert new content and return id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const content: Content = {
        sourceId: 1,
        externalId: 'tweet_123',
        url: 'https://twitter.com/user/status/123',
        title: 'Test tweet',
        contentText: 'This is a test tweet about AI',
        author: 'testuser',
        publishedAt: new Date(),
      };

      const id = await store.upsert(content);
      expect(id).toBe(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('normalizes a Microsoft-style GUID longer than 255 before insert and reuses it on upsert', async () => {
      const { normalizeExternalId } = await import('../external-id');
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });

      const longId = `https://www.microsoft.com/en-us/research/publication/${'guid-'.repeat(60)}`;
      expect(Array.from(longId).length).toBeGreaterThan(255);
      const expected = normalizeExternalId(longId);

      const first = await store.upsert({
        sourceId: 9,
        externalId: longId,
        url: 'https://www.microsoft.com/en-us/research/blog/example',
        contentText: 'msr',
      });
      const second = await store.upsert({
        sourceId: 9,
        externalId: `  ${longId}  `,
        url: 'https://www.microsoft.com/en-us/research/blog/example',
        contentText: 'msr',
      });

      expect(first).toBe(42);
      expect(second).toBe(42);
      expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(expected.length).toBeLessThanOrEqual(255);
      expect(mockQuery.mock.calls[0][1][1]).toBe(expected);
      expect(mockQuery.mock.calls[1][1][1]).toBe(expected);
      expect(mockQuery.mock.calls[0][1][1]).not.toBe(longId);
    });

    it('preserves a normal <=255 external id exactly after trim', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });
      await store.upsert({
        sourceId: 1,
        externalId: '  post-1  ',
        contentText: 'ok',
      });
      expect(mockQuery.mock.calls[0][1][1]).toBe('post-1');
    });
  });

  describe('close', () => {
    it('ends the pool once even when close is called twice', async () => {
      const poolInst = (pg.Pool as unknown as { mock: { results: { value: { end: ReturnType<typeof vi.fn> } }[] } })
        .mock.results.at(-1)!.value;
      await store.close();
      await store.close();
      expect(poolInst.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRecent', () => {
    it('should return content from last N days', async () => {
      const mockContent = [
        { id: 1, source_id: 1, content_text: 'Test 1' },
        { id: 2, source_id: 1, content_text: 'Test 2' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockContent });

      const results = await store.getRecent(7);
      expect(results).toHaveLength(2);
      // Days are passed as a bound parameter (parameterized interval), not interpolated
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('make_interval'),
        [7]
      );
    });
  });

  describe('getUnprocessed', () => {
    it('returns oldest eligible unprocessed content first with parameterized limit', async () => {
      const mockContent = [
        { id: 1, source_id: 1, content_text: 'Older' },
        { id: 2, source_id: 1, content_text: 'Newer' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockContent });

      const results = await store.getUnprocessed(30, 50);
      expect(results).toHaveLength(2);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/processed_at\s+IS\s+NULL/i);
      expect(sql).toMatch(/ORDER BY\s+c\.published_at\s+ASC\s*,\s*c\.id\s+ASC/i);
      expect(sql).toMatch(/LIMIT\s+\$2/i);
      expect(sql).toMatch(/make_interval\(days\s*=>\s*\$1\)/i);
      expect(sql).toMatch(/s\.identifier\s+as\s+source_identifier/i);
      expect(params).toEqual([30, 50]);
    });

    it('clamps oversized limits to 500 and orders deterministically by published_at ASC, id ASC', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await store.getUnprocessed(30, 99999);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/ORDER BY\s+c\.published_at\s+ASC\s*,\s*c\.id\s+ASC/i);
      expect(sql).toMatch(/s\.identifier\s+as\s+source_identifier/i);
      expect(params[0]).toBe(30);
      expect(params[1]).toBe(500);
      expect(params[1]).toBeLessThanOrEqual(500);
    });
  });

  describe('getRecent', () => {
    it('projects source_identifier from the joined source row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await store.getRecent(7);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/s\.identifier\s+as\s+source_identifier/i);
    });
  });
});

describe('ClaimStore', () => {
  let store: ClaimStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ClaimStore('postgresql://localhost/test');
  });

  describe('upsert', () => {
    it('should insert claim and return generated id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const claim: EnrichedClaim = {
        contentId: 1,
        claimText: 'AI will achieve AGI by 2030',
        claimType: 'prediction',
        topic: 'scaling',
        stance: 'bullish',
        bullishness: 0.9,
        confidence: 0.7,
        timeframe: 'medium-term',
        author: 'testuser',
        authorCategory: 'lab-researcher',
      };

      const id = await store.upsert(claim);
      // ID is generated client-side with timestamp pattern
      expect(id).toMatch(/^claim_\d+_[a-z0-9]+$/);
    });

    it('ON CONFLICT fills original_quote/source_url/author only when existing is blank/null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await store.upsert({
        id: 'claim_repair_1',
        contentId: 1,
        claimText: 'AI will achieve AGI by 2030',
        claimType: 'prediction',
        topic: 'scaling',
        stance: 'bullish',
        bullishness: 0.9,
        confidence: 0.7,
        originalQuote: 'exact quote',
        author: 'new-author',
        sourceUrl: 'https://example.com/new',
      });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/i);
      expect(sql).toMatch(
        /original_quote\s*=\s*COALESCE\s*\(\s*NULLIF\s*\(\s*(?:btrim\s*\(\s*)?extracted_claims\.original_quote/i,
      );
      expect(sql).toMatch(
        /source_url\s*=\s*COALESCE\s*\(\s*NULLIF\s*\(\s*(?:btrim\s*\(\s*)?extracted_claims\.source_url/i,
      );
      expect(sql).toMatch(
        /author\s*=\s*COALESCE\s*\(\s*NULLIF\s*\(\s*(?:btrim\s*\(\s*)?extracted_claims\.author/i,
      );
      expect(sql).toMatch(/claim_text\s*=\s*EXCLUDED\.claim_text/i);
    });

    it('ON CONFLICT never overwrites a nonblank stored original_quote/source_url/author', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await store.upsert({
        id: 'claim_keep_1',
        contentId: 1,
        claimText: 'kept',
        claimType: 'opinion',
        topic: 'general',
        stance: 'neutral',
        bullishness: 0.5,
        confidence: 0.5,
        originalQuote: 'incoming quote',
        author: 'incoming-author',
        sourceUrl: 'https://example.com/incoming',
      });

      const [sql] = mockQuery.mock.calls[0];
      // Keep existing nonblank: COALESCE(NULLIF(existing,''), EXCLUDED.x)
      // must prefer extracted_claims.<col> when it is nonblank.
      expect(sql).toMatch(
        /original_quote\s*=\s*COALESCE\s*\(\s*NULLIF\s*\(\s*btrim\s*\(\s*extracted_claims\.original_quote\s*\)/i,
      );
      expect(sql).toMatch(/EXCLUDED\.original_quote/i);
      expect(sql).not.toMatch(/original_quote\s*=\s*EXCLUDED\.original_quote/i);
      expect(sql).not.toMatch(/source_url\s*=\s*EXCLUDED\.source_url/i);
      expect(sql).not.toMatch(/author\s*=\s*EXCLUDED\.author/i);
    });

    it('persists a prediction-type claim into predictions with a deterministic id in the same client', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const madeAt = new Date('2026-08-01T00:00:00Z');
      const client = { query: mockQuery } as never;

      await store.upsert({
        id: 'claim_pred_1',
        contentId: 1,
        claimText: 'GPT-5 ships in 2026',
        claimType: 'prediction',
        topic: 'scaling',
        stance: 'bullish',
        bullishness: 0.8,
        confidence: 0.6,
        timeframe: 'near-term',
        author: 'Sam Altman',
        extractedAt: madeAt,
      }, client);

      const predCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO predictions'),
      );
      expect(predCall).toBeDefined();
      expect(predCall![0]).toMatch(
        /ON CONFLICT\s*\(\s*claim_id\s*\)\s*WHERE\s+claim_id\s+IS NOT NULL\s+DO UPDATE SET/i,
      );
      expect(predCall![0]).not.toMatch(/status\s*=/i);
      expect(predCall![0]).not.toMatch(/accuracy_score/i);
      expect(predCall![0]).not.toMatch(/evidence_url/i);
      expect(predCall![0]).not.toMatch(/outcome_summary/i);
      const params = predCall![1] as unknown[];
      const { createHash } = await import('node:crypto');
      const expectedId = `pred_${createHash('md5').update('claim_pred_1').digest('hex')}`;
      expect(params[0]).toBe(expectedId);
      expect(params[1]).toBe('claim_pred_1');
      expect(params[2]).toBe('GPT-5 ships in 2026');
      expect(params[3]).toBe('Sam Altman');
      expect(params[4]).toBe(0.6);
      expect(params[5]).toBe('near-term');
      expect(params[6]).toBe('scaling');
      expect(params[7]).toBeNull();
      expect(params[8]).toEqual(madeAt);
      expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO extracted_claims/);
    });

    it('does not create a predictions row for a non-prediction claim', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await store.upsert({
        id: 'claim_op_1',
        contentId: 1,
        claimText: 'Reasoning is improving',
        claimType: 'opinion',
        topic: 'reasoning',
        stance: 'neutral',
        bullishness: 0.5,
        confidence: 0.5,
        author: 'tester',
      });
      expect(
        mockQuery.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO predictions'),
        ),
      ).toBe(false);
    });

    it('retries of the same prediction claim are idempotent on predictions.id', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const claim: EnrichedClaim = {
        id: 'claim_pred_retry',
        contentId: 1,
        claimText: 'Models will plateau',
        claimType: 'prediction',
        topic: 'scaling',
        stance: 'bearish',
        bullishness: 0.2,
        confidence: 0.4,
        timeframe: 'long-term',
        author: 'critic',
      };
      await store.upsert(claim);
      await store.upsert(claim);
      const predCalls = mockQuery.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO predictions'),
      );
      expect(predCalls).toHaveLength(2);
      expect(predCalls[0][1][0]).toBe(predCalls[1][1][0]);
      expect(predCalls[0][0]).toMatch(
        /ON CONFLICT\s*\(\s*claim_id\s*\)\s*WHERE\s+claim_id\s+IS NOT NULL/i,
      );
    });

    it('retries conflict on claim_id and refresh source fields without touching reviewed outcome columns', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await store.upsert({
        id: 'claim_pred_conflict',
        contentId: 1,
        claimText: 'Updated claim text',
        claimType: 'prediction',
        topic: 'agents',
        stance: 'bullish',
        bullishness: 0.8,
        confidence: 0.9,
        timeframe: 'near-term',
        author: 'retry-author',
        extractedAt: new Date('2026-08-02T00:00:00Z'),
      });

      const predCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO predictions'),
      );
      expect(predCall).toBeDefined();
      const sql = String(predCall![0]);
      expect(sql).toMatch(
        /ON CONFLICT\s*\(\s*claim_id\s*\)\s*WHERE\s+claim_id\s+IS NOT NULL\s+DO UPDATE SET/i,
      );
      expect(sql).toMatch(/text\s*=\s*EXCLUDED\.text/i);
      expect(sql).toMatch(/author\s*=\s*EXCLUDED\.author/i);
      expect(sql).toMatch(/confidence\s*=\s*EXCLUDED\.confidence/i);
      expect(sql).toMatch(/timeframe\s*=\s*EXCLUDED\.timeframe/i);
      expect(sql).toMatch(/topic\s*=\s*EXCLUDED\.topic/i);
      expect(sql).toMatch(/updated_at\s*=\s*NOW\(\)/i);
      expect(sql).not.toMatch(/\bid\s*=\s*EXCLUDED\.id/i);
      expect(sql).not.toMatch(/status\s*=/i);
      expect(sql).not.toMatch(/verified_at\s*=/i);
      expect(sql).not.toMatch(/accuracy_score\s*=/i);
      expect(sql).not.toMatch(/\bevidence\s*=/i);
      expect(sql).not.toMatch(/outcome_summary\s*=/i);
      expect(sql).not.toMatch(/evidence_url\s*=/i);
      expect(sql).not.toMatch(/due_at\s*=/i);
      expect(sql).not.toMatch(/next_observable\s*=/i);
      expect(sql).not.toMatch(/next_question\s*=/i);
      expect(sql).not.toMatch(/INSERT INTO predictions \([^)]*\bstatus\b/i);
    });

    it('normalizes alias topics at the write boundary and preserves the raw spelling', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await store.upsert({
        id: 'claim_tax_1',
        contentId: 1,
        claimText: 'Alignment is unsolved',
        claimType: 'opinion',
        topic: 'AI safety' as never,
        stance: 'bearish',
        bullishness: 0.2,
        confidence: 0.8,
        author: 'tester',
      });

      const claimCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims'),
      );
      expect(claimCall).toBeDefined();
      expect(claimCall![0]).toMatch(/raw_topic/);
      const params = claimCall![1] as unknown[];
      expect(params).toContain('safety');
      expect(params).toContain('AI safety');
      expect(params.indexOf('safety')).not.toBe(params.indexOf('AI safety'));
    });

    it('does not persist a misleading raw_topic when the incoming topic is already canonical', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await store.upsert({
        id: 'claim_tax_2',
        contentId: 1,
        claimText: 'Scaling continues',
        claimType: 'opinion',
        topic: 'scaling',
        stance: 'bullish',
        bullishness: 0.7,
        confidence: 0.6,
        author: 'tester',
      });
      const claimCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims'),
      );
      const params = claimCall![1] as unknown[];
      expect(params).toContain('scaling');
      const topicIdx = params.indexOf('scaling');
      expect(params[topicIdx + 1]).toBeNull();
    });

    it('preserves existing raw_topic on conflict when the incoming raw value is null', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await store.upsert({
        id: 'claim_tax_keep_raw',
        contentId: 1,
        claimText: 'A forecast',
        claimType: 'prediction',
        topic: 'safety',
        stance: 'bearish',
        bullishness: 0.2,
        confidence: 0.8,
        author: 'tester',
      });
      const claimCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO extracted_claims'),
      );
      expect(claimCall![0]).toMatch(
        /raw_topic\s*=\s*COALESCE\(\s*EXCLUDED\.raw_topic\s*,\s*extracted_claims\.raw_topic\s*\)/i,
      );
      const predCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO predictions'),
      );
      expect(predCall![0]).toMatch(
        /raw_topic\s*=\s*COALESCE\(\s*EXCLUDED\.raw_topic\s*,\s*predictions\.raw_topic\s*\)/i,
      );
    });
  });

  describe('getByTopic', () => {
    it('should filter claims by topic', async () => {
      const mockClaims = [
        { id: '1', claim_text: 'Reasoning is improving', topic: 'reasoning' },
        { id: '2', claim_text: 'CoT helps reasoning', topic: 'reasoning' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockClaims });

      const results = await store.getByTopic('reasoning', 30);
      expect(results).toHaveLength(2);
      // Topic and days are both bound parameters
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('topic'),
        ['reasoning', 30]
      );
    });
  });

  describe('getRecent', () => {
    it('should return claims from last N days', async () => {
      const mockClaims = [
        { id: '1', claim_text: 'Test claim', extracted_at: new Date() },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockClaims });

      const results = await store.getRecent(7);
      expect(results).toHaveLength(1);
    });
  });
});

describe('SourceStore', () => {
  let store: SourceStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SourceStore('postgresql://localhost/test');
  });

  describe('upsert', () => {
    it('should insert new source', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const source: Source = {
        type: 'twitter',
        identifier: 'testuser',
        authorName: 'Test User',
        category: 'independent',
        fetchFrequencyHours: 6,
      };

      const id = await store.upsert(source);
      expect(id).toBe(1);
    });

    it('defaults omitted isActive to true for a new row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] });

      await store.upsert({
        type: 'blog',
        identifier: 'https://www.microsoft.com/en-us/research/feed/',
        authorName: 'Microsoft Research',
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/COALESCE\(\s*\$7\s*,\s*true\s*\)/i);
      expect(params[6]).toBeNull();
    });

    it('preserves existing is_active on conflict when isActive is omitted', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] });

      await store.upsert({
        type: 'blog',
        identifier: 'https://www.microsoft.com/en-us/research/feed/',
        authorName: 'Microsoft Research',
      });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/COALESCE\(\s*\$7\s*,\s*sources\.is_active\s*\)/i);
      expect(sql).not.toMatch(/is_active\s*=\s*EXCLUDED\.is_active/i);
    });

    it('applies explicit isActive on insert and conflict', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 9 }] });

      await store.upsert({
        type: 'blog',
        identifier: 'https://ruder.io/rss/index.rss',
        authorName: 'Sebastian Ruder',
        isActive: false,
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(params[6]).toBe(false);
      expect(sql).toMatch(/COALESCE\(\s*\$7\s*,\s*true\s*\)/i);
      expect(sql).toMatch(/COALESCE\(\s*\$7\s*,\s*sources\.is_active\s*\)/i);
    });
  });

  describe('getActive', () => {
    it('should return only active sources', async () => {
      const mockSources = [
        { id: 1, type: 'twitter', identifier: 'user1', is_active: true },
        { id: 2, type: 'substack', identifier: 'blog1', is_active: true },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockSources });

      const results = await store.getActive();
      expect(results).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('is_active = true'),
        undefined
      );
    });
  });

  describe('getByType', () => {
    it('should filter sources by type', async () => {
      const mockSources = [
        { id: 1, type: 'twitter', identifier: 'user1' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockSources });

      const results = await store.getByType('twitter');
      expect(results).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('type'),
        ['twitter']
      );
    });
  });

  describe('getDueForFetch', () => {
    it('should return sources due for fetching', async () => {
      const mockSources = [
        { id: 1, type: 'twitter', identifier: 'user1', last_fetched: null },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockSources });

      const results = await store.getDueForFetch();
      expect(results).toHaveLength(1);
    });
  });
});

describe('SynthesisStore', () => {
  let store: SynthesisStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SynthesisStore('postgresql://localhost/test');
  });

  describe('save', () => {
    it('should save synthesis result', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const result = {
        generatedAt: new Date(),
        lookbackDays: 7,
        syntheses: [{ topic: 'reasoning', labConsensus: 'test' }],
        hypeAssessment: { overallFieldSentiment: 0.7 },
        digest: '# Weekly Digest',
      };

      const id = await store.save(result);
      expect(id).toBe(1);
    });
  });

  describe('getLatest', () => {
    it('should return most recent synthesis', async () => {
      const mockResult = {
        id: 1,
        generated_at: new Date(),
        syntheses: [],
        hype_assessment: {},
      };
      mockQuery.mockResolvedValueOnce({ rows: [mockResult] });

      const result = await store.getLatest();
      expect(result).toBeDefined();
      expect(result?.id).toBe(1);
    });

    it('should return null when no synthesis exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await store.getLatest();
      expect(result).toBeNull();
    });
  });
});

describe('PredictionTracker', () => {
  let tracker: PredictionTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new PredictionTracker('postgresql://localhost/test');
  });

  describe('record', () => {
    it('should record new prediction and return generated id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const prediction = {
        claimId: 'claim_1',
        text: 'GPT-5 will be released in 2025',
        author: 'Sam Altman',
        confidence: 0.8,
        timeframe: 'near-term',
        topic: 'scaling',
        madeAt: new Date(),
      };

      const id = await tracker.record(prediction);
      // ID is generated client-side with timestamp pattern
      expect(id).toMatch(/^pred_\d+_[a-z0-9]+$/);
    });

    it('normalizes unknown topics to other and preserves the source spelling', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await tracker.record({
        claimId: 'claim_tax_pred',
        text: 'A niche forecast',
        author: 'tester',
        confidence: 0.5,
        timeframe: 'near-term',
        topic: 'not-a-real-topic-xyz',
        madeAt: new Date(),
      });
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/raw_topic/);
      expect(params).toContain('other');
      expect(params).toContain('not-a-real-topic-xyz');
    });

    it('preserves existing raw_topic on conflict when the incoming raw value is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await tracker.record({
        claimId: 'claim_tax_pred_keep',
        text: 'A forecast',
        author: 'tester',
        confidence: 0.5,
        timeframe: 'near-term',
        topic: 'safety',
        madeAt: new Date(),
      });
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(
        /raw_topic\s*=\s*COALESCE\(\s*EXCLUDED\.raw_topic\s*,\s*predictions\.raw_topic\s*\)/i,
      );
    });
  });

  describe('updateStatus', () => {
    it('should update prediction status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await tracker.updateStatus('pred_123', 'verified', 0.9, 'It happened');

      // Parameter order: [id, status, accuracy_score, evidence]
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE predictions'),
        ['pred_123', 'verified', 0.9, 'It happened']
      );
    });

    it('advances updated_at when status changes', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await tracker.updateStatus('pred_123', 'verified', 0.9, 'It happened');
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/updated_at\s*=\s*NOW\(\)/i);
    });
  });

  describe('getPending', () => {
    it('should return predictions with too-early status', async () => {
      const mockPredictions = [
        { id: 'pred_1', text: 'Prediction 1', status: 'too-early' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockPredictions });

      const results = await tracker.getPending();
      expect(results).toHaveLength(1);
    });

    it('treats pending and too-early as unresolved and ignores verified', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await tracker.getPending();
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/status\s+IN\s*\(\s*'pending'\s*,\s*'too-early'\s*\)/i);
      expect(sql).not.toMatch(/status\s+IS\s+NULL\s+OR\s+status\s+=\s+'too-early'/i);
    });
  });

  describe('getAccuracyStats', () => {
    it('should return accuracy statistics for author', async () => {
      const mockStats = {
        total: '10',
        verified: '6',
        falsified: '2',
        partially_verified: '1',
        pending: '1',
        avg_accuracy: '0.75',
      };
      mockQuery.mockResolvedValueOnce({ rows: [mockStats] });

      const stats = await tracker.getAccuracyStats('Sam Altman');
      expect(stats.total).toBe(10);
      // Implementation uses camelCase: averageAccuracy
      expect(stats.averageAccuracy).toBe(0.75);
    });

    it('counts pending and too-early as pending', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          total: '0',
          verified: '0',
          falsified: '0',
          partially_verified: '0',
          pending: '0',
          avg_accuracy: null,
        }],
      });
      await tracker.getAccuracyStats();
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(
        /COUNT\(\*\) FILTER \(WHERE status IN \('pending', 'too-early'\)\) as pending/i,
      );
      expect(sql).not.toMatch(/status IS NULL OR status = 'too-early'/i);
    });
  });
});

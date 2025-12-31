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
      // The implementation embeds days directly in SQL, not as parameters
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('7 days'),
        []
      );
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
      // Days embedded in SQL, only topic as parameter
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('topic'),
        ['reasoning']
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
  });
});

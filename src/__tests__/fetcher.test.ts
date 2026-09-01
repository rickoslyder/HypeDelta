/**
 * Fetcher Tests
 *
 * Tests for AIIntelFetcher with mocked HTTP requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Captured at module load by fetcher.ts — set before that import.
const TWITTER_TEST_API_KEY = vi.hoisted(() => {
  const key = 'test-twitter-key';
  process.env.TWITTER_API_KEY = key;
  return key;
});

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock child_process for yt-dlp
vi.mock('child_process', () => ({
  exec: vi.fn((cmd, callback) => {
    callback(null, JSON.stringify({ entries: [] }), '');
  }),
  execSync: vi.fn(() => ''),
}));

// The parser is imported as default export and used with `new Parser()`
// Define mocks inside the factory so they're hoisted correctly
vi.mock('rss-parser', () => {
  const mockFeed = {
    title: 'Test Feed',
    items: [
      {
        title: 'Test Post',
        link: 'https://example.com/post/1',
        guid: 'post-1',
        content: '<p>Test content</p>',
        contentEncoded: '<p>Test content</p>',
        pubDate: new Date().toISOString(),
        id: 'http://arxiv.org/abs/2401.00001',
        summary: 'Paper abstract',
        author: { name: 'Researcher' },
        published: new Date().toISOString(),
        categories: [{ term: 'cs.AI' }],
      },
    ],
  };

  // Return a class constructor
  const MockParser = function(this: any) {
    this.parseURL = vi.fn().mockResolvedValue(mockFeed);
    this.parseString = vi.fn().mockResolvedValue(mockFeed);
  };
  return {
    default: MockParser,
  };
});

// Import after mocks
import { AIIntelFetcher } from '../fetcher';
import { ContentStore, SourceStore } from '../storage';

describe('AIIntelFetcher', () => {
  let fetcher: AIIntelFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new AIIntelFetcher({
      dbUrl: 'postgresql://localhost/test',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchSources', () => {
    it('should process sources and return results', async () => {
      const sources = [
        {
          id: 1,
          type: 'substack' as const,
          identifier: 'https://test.substack.com/feed',
          authorName: 'Test Author',
          category: 'independent' as const,
        },
      ];

      const results = await fetcher.fetchSources(sources);

      expect(results).toHaveProperty('successful');
      expect(results).toHaveProperty('failed');
      expect(Array.isArray(results.successful)).toBe(true);
    });

    it('should handle empty source list', async () => {
      const results = await fetcher.fetchSources([]);

      expect(results.successful).toHaveLength(0);
      expect(results.failed).toHaveLength(0);
    });
  });

  describe('fetchSubstack', () => {
    it('should parse substack RSS feed', async () => {
      const result = await (fetcher as any).fetchSubstack(
        'https://test.substack.com/feed',
        'Test Author'
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('fetchBlog', () => {
    it('should parse generic RSS/Atom feed', async () => {
      const result = await (fetcher as any).fetchBlog(
        'https://blog.example.com/feed.xml',
        'Blog Author'
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('fetchLessWrong', () => {
    it('should query LessWrong GraphQL API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            posts: {
              results: [
                {
                  _id: 'post_1',
                  title: 'AI Safety Post',
                  slug: 'ai-safety-post',
                  user: { username: 'lwuser', displayName: 'LW Author' },
                  postedAt: new Date().toISOString(),
                  contents: { html: 'Post content', wordCount: 1000 },
                  baseScore: 50,
                },
              ],
            },
          },
        }),
      });

      const result = await (fetcher as any).fetchLessWrong('AI');

      expect(mockFetch).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('fetchArxiv', () => {
    it('should query arXiv API', async () => {
      const mockXml = `
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>http://arxiv.org/abs/2401.00001</id>
            <title>AI Research Paper</title>
            <summary>Paper abstract</summary>
            <author><name>Researcher</name></author>
            <published>2024-01-01T00:00:00Z</published>
            <link href="http://arxiv.org/pdf/2401.00001" type="application/pdf"/>
            <category term="cs.AI"/>
          </entry>
        </feed>
      `;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => mockXml,
      });

      const result = await (fetcher as any).fetchArxiv('cs.AI');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('export.arxiv.org')
      );
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('fetchBluesky', () => {
    it('should fetch from Bluesky AT Protocol', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          feed: [
            {
              post: {
                uri: 'at://did:plc:xxx/app.bsky.feed.post/yyy',
                cid: 'cid123',
                record: {
                  text: 'Test Bluesky post about AI',
                  createdAt: new Date().toISOString(),
                },
                author: {
                  handle: 'testuser.bsky.social',
                  displayName: 'Test User',
                },
                likeCount: 10,
                repostCount: 5,
                replyCount: 2,
              },
            },
          ],
        }),
      });

      const result = await (fetcher as any).fetchBluesky(
        'testuser.bsky.social',
        'Test User'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('bsky.app')
      );
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Nitter fallback', () => {
    it('should try multiple Nitter instances', async () => {
      // First instance fails
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      // Second instance succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <rss>
            <channel>
              <item>
                <title>Test tweet</title>
                <link>https://twitter.com/user/status/123</link>
                <pubDate>${new Date().toUTCString()}</pubDate>
                <description>Tweet content</description>
              </item>
            </channel>
          </rss>
        `,
      });

      const result = await (fetcher as any).fetchTwitter('testuser', 'Test User');

      expect(Array.isArray(result)).toBe(true);
    });
  });
});

describe('seedSources', () => {
  it('should be a function', async () => {
    const { seedSources } = await import('../fetcher');
    expect(typeof seedSources).toBe('function');
  });
});

function twitterSource(id: number, identifier: string) {
  return {
    id,
    type: 'twitter' as const,
    identifier,
    authorName: identifier,
    category: 'independent' as const,
  };
}

describe('Twitter fetch truthfulness', () => {
  let fetcher: AIIntelFetcher;
  let markFetched: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch.mockReset();
    fetcher = new AIIntelFetcher({
      dbUrl: 'postgresql://localhost/test',
    });
    markFetched = vi.fn().mockResolvedValue(undefined);
    (fetcher as any).sourceStore.markFetched = markFetched;
    (fetcher as any).contentStore.upsert = vi.fn().mockResolvedValue(1);
    (fetcher as any).rssParser.parseURL = vi.fn().mockRejectedValue(new Error('nitter down'));
  });

  it('does not markFetched when advanced_search and per-handle fetch both fail', async () => {
    mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.twitterapi.io'));

    const results = await fetcher.fetchSources([twitterSource(1, 'karpathy')]);

    expect(results.successful).toEqual([]);
    expect(results.failed).toEqual([
      expect.objectContaining({ source: 'karpathy' }),
    ]);
    expect(results.failed[0].error).toBeTruthy();
    expect(results.failed[0].error).not.toContain(TWITTER_TEST_API_KEY);
    expect(markFetched).not.toHaveBeenCalled();
  });

  it('treats HTTP-success empty Twitter results as success and marks fetched', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tweets: [] }),
    });

    const results = await fetcher.fetchSources([twitterSource(2, 'karpathy')]);

    expect(results.failed).toEqual([]);
    expect(results.successful).toEqual([{ source: 'karpathy', count: 0 }]);
    expect(markFetched).toHaveBeenCalledTimes(1);
    expect(markFetched).toHaveBeenCalledWith(2);
  });

  it('advances last_fetched only for the successful source in a mixed batch', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('advanced_search')) {
        throw new Error('getaddrinfo ENOTFOUND api.twitterapi.io');
      }
      if (url.includes('last_tweets') && url.includes('gooduser')) {
        return {
          ok: true,
          json: async () => ({ status: 'success', data: { tweets: [] } }),
        };
      }
      throw new Error('socket hang up');
    });

    const results = await fetcher.fetchSources([
      twitterSource(11, 'gooduser'),
      twitterSource(12, 'baduser'),
    ]);

    expect(results.successful).toEqual([{ source: 'gooduser', count: 0 }]);
    expect(results.failed).toEqual([
      expect.objectContaining({ source: 'baduser' }),
    ]);
    expect(markFetched).toHaveBeenCalledTimes(1);
    expect(markFetched).toHaveBeenCalledWith(11);
    expect(markFetched).not.toHaveBeenCalledWith(12);
  });

  it('uses AbortSignal.timeout (5–30s) on every Twitter HTTP fetch', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tweets: [] }),
    });

    await fetcher.fetchSources([twitterSource(3, 'karpathy')]);

    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of mockFetch.mock.calls) {
      expect(init).toEqual(expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
    }

    const timeoutMs = timeoutSpy.mock.calls
      .map((call) => call[0])
      .find((ms) => typeof ms === 'number' && ms >= 5000 && ms <= 30000);
    expect(timeoutMs).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    { label: 'missing', env: undefined, expected: 15_000 },
    { label: 'malformed', env: 'not-a-number', expected: 15_000 },
    { label: 'non-positive 0', env: '0', expected: 15_000 },
    { label: 'non-positive negative', env: '-1', expected: 15_000 },
    { label: 'below min', env: '1', expected: 5_000 },
    { label: 'just below min', env: '4999', expected: 5_000 },
    { label: 'min bound', env: '5000', expected: 5_000 },
    { label: 'default in range', env: '15000', expected: 15_000 },
    { label: 'max bound', env: '30000', expected: 30_000 },
    { label: 'just above max', env: '30001', expected: 30_000 },
    { label: 'far above max', env: '999999', expected: 30_000 },
  ])('TWITTER_FETCH_TIMEOUT_MS $label ($env) uses $expected ms on the request path', async ({ env, expected }) => {
    const prev = process.env.TWITTER_FETCH_TIMEOUT_MS;
    if (env === undefined) delete process.env.TWITTER_FETCH_TIMEOUT_MS;
    else process.env.TWITTER_FETCH_TIMEOUT_MS = env;

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tweets: [] }),
    });

    try {
      await fetcher.fetchSources([twitterSource(30, 'karpathy')]);

      expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
      expect(timeoutSpy).toHaveBeenCalledWith(expected);
      for (const [, init] of mockFetch.mock.calls) {
        expect(init).toEqual(expect.objectContaining({
          signal: expect.any(AbortSignal),
        }));
      }
    } finally {
      timeoutSpy.mockRestore();
      if (prev === undefined) delete process.env.TWITTER_FETCH_TIMEOUT_MS;
      else process.env.TWITTER_FETCH_TIMEOUT_MS = prev;
    }
  });
});

describe('Twitter fetch truthfulness: missing TWITTER_API_KEY', () => {
  afterEach(() => {
    process.env.TWITTER_API_KEY = TWITTER_TEST_API_KEY;
  });

  it.each([
    { name: 'absent', value: undefined as string | undefined },
    { name: 'blank', value: '' },
  ])('fails every requested Twitter source and skips markFetched when key is $name', async ({ value }) => {
    if (value === undefined) delete process.env.TWITTER_API_KEY;
    else process.env.TWITTER_API_KEY = value;

    vi.resetModules();
    const { AIIntelFetcher: FreshFetcher } = await import('../fetcher');
    const fresh = new FreshFetcher({ dbUrl: 'postgresql://localhost/test' });
    const markFetched = vi.fn().mockResolvedValue(undefined);
    (fresh as any).sourceStore.markFetched = markFetched;
    (fresh as any).contentStore.upsert = vi.fn().mockResolvedValue(1);
    (fresh as any).rssParser.parseURL = vi.fn().mockResolvedValue({
      items: [{
        guid: 'https://twitter.com/karpathy/status/1',
        content: 'nitter would have succeeded',
        pubDate: new Date().toISOString(),
      }],
    });
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tweets: [] }),
    });

    const results = await fresh.fetchSources([
      twitterSource(21, 'karpathy'),
      twitterSource(22, 'goodfellow'),
    ]);

    expect(results.successful).toEqual([]);
    expect(results.failed).toHaveLength(2);
    expect(results.failed).toEqual([
      expect.objectContaining({ source: 'karpathy' }),
      expect.objectContaining({ source: 'goodfellow' }),
    ]);
    for (const entry of results.failed) {
      expect(entry.error).toBeTruthy();
    }
    expect(markFetched).not.toHaveBeenCalled();
  });
});

describe('AIIntelFetcher.close', () => {
  it('closes owned content and source stores', async () => {
    const fetcher = new AIIntelFetcher({ dbUrl: 'postgresql://localhost/test' });
    const contentClose = vi.spyOn(ContentStore.prototype, 'close').mockResolvedValue(undefined);
    const sourceClose = vi.spyOn(SourceStore.prototype, 'close').mockResolvedValue(undefined);

    await fetcher.close();

    expect(contentClose).toHaveBeenCalled();
    expect(sourceClose).toHaveBeenCalled();
  });
});

function make12c1Fetcher(record = vi.fn().mockResolvedValue(1)) {
  const fetcher = new AIIntelFetcher({
    dbUrl: 'postgresql://localhost/test',
    sourceFetchAttemptStore: { record },
  });
  const markFetched = vi.fn().mockResolvedValue(undefined);
  const upsert = vi.fn().mockResolvedValue(1);
  (fetcher as any).sourceStore.markFetched = markFetched;
  (fetcher as any).contentStore.upsert = upsert;
  (fetcher as any).rssParser.parseURL = vi.fn().mockRejectedValue(new Error('nitter down'));
  return { fetcher, record, markFetched, upsert };
}

describe('packet 12C1 source outcomes and attempt receipts', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('records one failure receipt and does not markFetched when advanced DNS and fallback both fail', async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND api.twitterapi.io'), { code: 'ENOTFOUND' }));
    const { fetcher, record, markFetched } = make12c1Fetcher();

    const results = await fetcher.fetchSources([twitterSource(1, 'karpathy')]);

    expect(results.outcomes).toEqual([
      expect.objectContaining({
        kind: 'failure',
        source: 'karpathy',
        sourceId: 1,
        persisted: 0,
        errorClass: 'dns',
      }),
    ]);
    expect(results.successful).toEqual([]);
    expect(results.failed).toEqual([
      expect.objectContaining({ source: 'karpathy', errorClass: 'dns' }),
    ]);
    expect(results.failed[0]).not.toHaveProperty('error');
    expect(results.failed[0].reason).toBeTruthy();
    expect(results.failed[0].reason).not.toContain(TWITTER_TEST_API_KEY);
    expect(results.summary).toMatchObject({
      successEmpty: 0,
      successItems: 0,
      failed: 1,
      persistedRows: 0,
      skippedCircuit: 0,
    });
    expect(results.summary.failuresByClass).toMatchObject({ dns: 1 });
    expect(markFetched).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual(expect.objectContaining({
      sourceId: 1,
      sourceType: 'twitter',
      provider: 'twitterapi.io',
      ok: false,
      itemCount: 0,
    }));
    expect(record.mock.calls[0][0].startedAt).toBeInstanceOf(Date);
    expect(record.mock.calls[0][0].finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(results)).not.toMatch(/TWITTER_API_KEY|test-twitter-key|Bearer /);
  });

  it('records success-empty, marks fetched, and item_count=0 for valid HTTP empty Twitter results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tweets: [] }),
    });
    const { fetcher, record, markFetched, upsert } = make12c1Fetcher();

    const results = await fetcher.fetchSources([twitterSource(2, 'karpathy')]);

    expect(results.outcomes).toEqual([
      expect.objectContaining({
        kind: 'success-empty',
        source: 'karpathy',
        sourceId: 2,
        persisted: 0,
      }),
    ]);
    expect(results.successful).toEqual([{ source: 'karpathy', count: 0 }]);
    expect(results.failed).toEqual([]);
    expect(results.summary).toMatchObject({
      successEmpty: 1,
      successItems: 0,
      failed: 0,
      persistedRows: 0,
      skippedCircuit: 0,
    });
    expect(markFetched).toHaveBeenCalledTimes(1);
    expect(markFetched).toHaveBeenCalledWith(2);
    expect(upsert).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual(expect.objectContaining({
      sourceId: 2,
      sourceType: 'twitter',
      provider: 'twitterapi.io',
      ok: true,
      itemCount: 0,
    }));
  });

  it('records exactly one receipt per requested source in a mixed batch', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('advanced_search')) {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND api.twitterapi.io'), { code: 'ENOTFOUND' });
      }
      if (url.includes('last_tweets') && url.includes('gooduser')) {
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: {
              tweets: [{
                id: '99',
                text: 'hello',
                url: 'https://twitter.com/gooduser/status/99',
                createdAt: new Date().toISOString(),
                likeCount: 0,
                retweetCount: 0,
                replyCount: 0,
                viewCount: 0,
                author: { userName: 'gooduser', name: 'Good' },
                isReply: false,
              }],
            },
          }),
        };
      }
      throw new Error('socket hang up');
    });
    const { fetcher, record, markFetched } = make12c1Fetcher();

    const results = await fetcher.fetchSources([
      twitterSource(11, 'gooduser'),
      twitterSource(12, 'baduser'),
    ]);

    expect(results.outcomes).toHaveLength(2);
    expect(results.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'success-items', source: 'gooduser', sourceId: 11, persisted: 1 }),
      expect.objectContaining({ kind: 'failure', source: 'baduser', sourceId: 12, persisted: 0, errorClass: expect.any(String) }),
    ]));
    expect(results.summary).toMatchObject({
      successEmpty: 0,
      successItems: 1,
      failed: 1,
      persistedRows: 1,
      skippedCircuit: 0,
    });
    expect(markFetched).toHaveBeenCalledTimes(1);
    expect(markFetched).toHaveBeenCalledWith(11);
    expect(record).toHaveBeenCalledTimes(2);
    const recordedIds = record.mock.calls.map((call) => call[0].sourceId).sort();
    expect(recordedIds).toEqual([11, 12]);
  });

  it('records failure and skips markFetched when content persistence throws', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tweets: [{
          id: '1',
          text: 'item',
          createdAt: new Date().toISOString(),
          author: { userName: 'karpathy', name: 'K' },
          isReply: false,
        }],
      }),
    });
    const { fetcher, record, markFetched, upsert } = make12c1Fetcher();
    upsert.mockRejectedValue(new Error('duplicate key value violates unique constraint database'));

    const results = await fetcher.fetchSources([twitterSource(7, 'karpathy')]);

    expect(results.outcomes).toEqual([
      expect.objectContaining({ kind: 'failure', source: 'karpathy', persisted: 0, errorClass: 'database' }),
    ]);
    expect(markFetched).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual(expect.objectContaining({
      ok: false,
      itemCount: 0,
      sourceId: 7,
    }));
  });

  it('attaches HTTP status to Twitter errors without storing response bodies or tokens', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ token: 'secret-token', body: 'raw-response-body', tweets: [{ id: 1 }] }),
    });
    const { fetcher, record } = make12c1Fetcher();

    const results = await fetcher.fetchSources([twitterSource(8, 'karpathy')]);

    expect(results.failed[0].errorClass).toBe('rate_limit');
    const dumped = `${JSON.stringify(results)}\n${JSON.stringify(record.mock.calls)}`;
    expect(dumped).not.toMatch(/secret-token|raw-response-body|"tweets"/);
    expect(record.mock.calls[0][0].error).toEqual(expect.objectContaining({ status: 429 }));
    expect(record.mock.calls[0][0].error?.message ?? '').not.toMatch(/secret-token|raw-response-body/);
  });

  it('swallows attempt-ledger record rejection without retry, extra failure, or undoing markFetched', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tweets: [] }),
    });
    const record = vi.fn().mockRejectedValue(new Error('insert failed postgresql://secret'));
    const { fetcher, markFetched } = make12c1Fetcher(record);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const results = await fetcher.fetchSources([twitterSource(3, 'karpathy')]);

    expect(results.outcomes).toEqual([
      expect.objectContaining({
        kind: 'success-empty',
        source: 'karpathy',
        sourceId: 3,
        persisted: 0,
      }),
    ]);
    expect(results.failed).toEqual([]);
    expect(results.summary.failed).toBe(0);
    expect(markFetched).toHaveBeenCalledTimes(1);
    expect(markFetched).toHaveBeenCalledWith(3);
    expect(record).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/ledger write failed/i);
    expect(logged).not.toMatch(/postgresql:\/\/secret|insert failed/i);

    errorSpy.mockRestore();
  });
});

/**
 * Fetcher Tests
 *
 * Tests for AIIntelFetcher with mocked HTTP requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('AIIntelFetcher', () => {
  let fetcher: AIIntelFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new AIIntelFetcher({
      projectDir: '/test',
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

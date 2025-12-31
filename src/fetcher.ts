/**
 * Content Fetcher
 * 
 * Fetches content from all source types and normalizes for processing.
 * Integrates with the storage layer.
 */

import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { execSync } from 'child_process';
import type { RawContent, SourceType, Source, ContentCategory } from './types';
import { ContentStore, SourceStore } from './storage';
import sourcesData from '../data/sources.json';

// ============================================================================
// CONFIGURATION
// ============================================================================

// TwitterAPI.io configuration (https://twitterapi.io)
// Rate limits by credit tier: https://twitterapi.io/qps-limits
// ≥50,000 credits = 20 QPS (50ms between requests)
const TWITTER_API_CONFIG = {
  baseUrl: 'https://api.twitterapi.io',
  apiKey: process.env.TWITTER_API_KEY || '',
  rateLimitMs: 50, // Paid tier (≥50k credits): 20 QPS = 50ms between requests
};

// Track last Twitter API call for rate limiting
let lastTwitterApiCall = 0;

// Legacy Nitter instances (fallback, mostly non-functional as of 2025)
const NITTER_INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
];

// ============================================================================
// FETCHER CLASS
// ============================================================================

export class AIIntelFetcher {
  private contentStore: ContentStore;
  private sourceStore: SourceStore;
  private rssParser: Parser;
  
  constructor(config: { dbUrl: string }) {
    this.contentStore = new ContentStore(config.dbUrl);
    this.sourceStore = new SourceStore(config.dbUrl);
    this.rssParser = new Parser({
      customFields: {
        item: [
          ['dc:creator', 'creator'],
          ['content:encoded', 'contentEncoded']
        ]
      }
    });
  }
  
  /**
   * Fetch content from multiple sources
   */
  async fetchSources(sources: Source[]): Promise<{
    successful: { source: string; count: number }[];
    failed: { source: string; error: string }[];
  }> {
    const successful: { source: string; count: number }[] = [];
    const failed: { source: string; error: string }[] = [];
    
    for (const source of sources) {
      try {
        const content = await this.fetchSource(source);
        
        // Store content
        for (const item of content) {
          await this.contentStore.upsert({
            sourceId: source.id!,
            externalId: item.id || `${source.identifier}_${item.publishedAt.getTime()}`,
            url: item.url,
            title: item.title,
            contentText: item.content,
            contentType: item.sourceType,
            author: item.author,
            publishedAt: item.publishedAt,
            metadata: item.metadata
          });
        }
        
        // Mark source as fetched
        await this.sourceStore.markFetched(source.id!);
        
        successful.push({ source: source.identifier, count: content.length });
        
        // Rate limit between sources
        await this.sleep(1000);
        
      } catch (error) {
        failed.push({ 
          source: source.identifier, 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }
    
    return { successful, failed };
  }
  
  /**
   * Fetch from a single source
   */
  async fetchSource(source: Source): Promise<RawContent[]> {
    switch (source.type as SourceType) {
      case 'twitter':
        return this.fetchTwitter(source.identifier, source.authorName);
      case 'substack':
        return this.fetchSubstack(source.identifier, source.authorName);
      case 'youtube':
        return this.fetchYouTube(source.identifier, source.authorName);
      case 'blog':
        return this.fetchBlog(source.identifier, source.authorName);
      case 'podcast':
        return this.fetchPodcast(source.identifier, source.authorName);
      case 'lesswrong':
        return this.fetchLessWrong(source.identifier);
      case 'arxiv':
        return this.fetchArxiv(source.identifier);
      case 'bluesky':
        return this.fetchBluesky(source.identifier, source.authorName);
      default:
        throw new Error(`Unknown source type: ${source.type}`);
    }
  }
  
  // ============================================================================
  // TWITTER (via TwitterAPI.io)
  // ============================================================================

  async fetchTwitter(handle: string, authorName?: string): Promise<RawContent[]> {
    // Primary: TwitterAPI.io
    if (TWITTER_API_CONFIG.apiKey) {
      try {
        return await this.fetchTwitterViaAPI(handle, authorName);
      } catch (e) {
        console.warn(`TwitterAPI.io failed for ${handle}: ${e}`);
        // Fall through to Nitter fallback
      }
    }

    // Fallback: Nitter (mostly non-functional as of 2025)
    return this.fetchTwitterViaNitter(handle, authorName);
  }

  private async fetchTwitterViaAPI(handle: string, authorName?: string): Promise<RawContent[]> {
    // Rate limiting for TwitterAPI.io (free tier: 1 req/5s)
    const now = Date.now();
    const timeSinceLastCall = now - lastTwitterApiCall;
    if (timeSinceLastCall < TWITTER_API_CONFIG.rateLimitMs) {
      await this.sleep(TWITTER_API_CONFIG.rateLimitMs - timeSinceLastCall);
    }
    lastTwitterApiCall = Date.now();

    const response = await fetch(
      `${TWITTER_API_CONFIG.baseUrl}/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`,
      {
        headers: {
          'X-API-Key': TWITTER_API_CONFIG.apiKey,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`TwitterAPI.io returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      status: string;
      data: {
        tweets: Array<{
          id: string;
          text: string;
          url: string;
          createdAt: string;
          likeCount: number;
          retweetCount: number;
          replyCount: number;
          viewCount: number;
          author: {
            userName: string;
            name: string;
          };
          isReply: boolean;
          quoted_tweet?: object;
          retweeted_tweet?: object;
        }>;
      };
    };

    if (data.status !== 'success' || !data.data?.tweets) {
      throw new Error(`TwitterAPI.io error: ${JSON.stringify(data)}`);
    }

    return data.data.tweets
      .filter(tweet => !tweet.isReply) // Filter out replies for cleaner signal
      .map(tweet => ({
        id: tweet.id,
        source: `twitter:${handle}`,
        sourceType: 'twitter' as SourceType,
        author: authorName || tweet.author?.name || handle,
        content: tweet.text,
        url: tweet.url || `https://twitter.com/${handle}/status/${tweet.id}`,
        publishedAt: new Date(tweet.createdAt),
        metadata: {
          likeCount: tweet.likeCount,
          retweetCount: tweet.retweetCount,
          replyCount: tweet.replyCount,
          viewCount: tweet.viewCount,
          isRetweet: !!tweet.retweeted_tweet,
          isQuote: !!tweet.quoted_tweet,
          provider: 'twitterapi.io'
        }
      }));
  }

  private async fetchTwitterViaNitter(handle: string, authorName?: string): Promise<RawContent[]> {
    for (const instance of NITTER_INSTANCES) {
      try {
        const feed = await this.rssParser.parseURL(
          `https://${instance}/${handle}/rss`
        );

        return feed.items.map(item => {
          const dom = new JSDOM(item.content || '');
          const text = dom.window.document.body.textContent?.trim() || '';
          const tweetId = item.guid?.split('/status/')[1] || item.guid || '';

          return {
            id: tweetId,
            source: `twitter:${handle}`,
            sourceType: 'twitter' as SourceType,
            author: authorName || handle,
            content: text,
            url: `https://twitter.com/${handle}/status/${tweetId}`,
            publishedAt: new Date(item.pubDate || Date.now()),
            metadata: {
              isThread: item.content?.includes('Show this thread'),
              nitterInstance: instance,
              provider: 'nitter'
            }
          };
        });
      } catch (e) {
        continue; // Try next instance
      }
    }

    throw new Error(`All Twitter fetch methods failed for ${handle}`);
  }

  /**
   * Monitor Twitter accounts for new tweets using advanced_search endpoint
   *
   * This uses time-windowed queries for real-time monitoring:
   * - Polls for tweets within a time window (e.g., last 5 minutes)
   * - More efficient than last_tweets for detecting new content
   * - Recommended polling intervals:
   *   - High priority: 1-5 minutes
   *   - Regular: 15-30 minutes
   *   - Casual: 1-2 hours
   *
   * @param handles - List of Twitter handles to monitor
   * @param sinceMinutes - How far back to search (default: 15 minutes)
   * @param persist - Whether to store tweets in the database (default: true)
   */
  async monitorTwitter(
    handles: string[],
    sinceMinutes: number = 15,
    persist: boolean = true
  ): Promise<{ handle: string; tweets: RawContent[] }[]> {
    if (!TWITTER_API_CONFIG.apiKey) {
      throw new Error('Twitter API key required for monitoring');
    }

    const results: { handle: string; tweets: RawContent[] }[] = [];
    const now = new Date();
    const since = new Date(now.getTime() - sinceMinutes * 60 * 1000);

    // Format dates for Twitter search: YYYY-MM-DD
    const sinceStr = since.toISOString().split('T')[0];
    const untilStr = now.toISOString().split('T')[0];

    for (const handle of handles) {
      // Rate limiting
      const timeSinceLastCall = Date.now() - lastTwitterApiCall;
      if (timeSinceLastCall < TWITTER_API_CONFIG.rateLimitMs) {
        await this.sleep(TWITTER_API_CONFIG.rateLimitMs - timeSinceLastCall);
      }
      lastTwitterApiCall = Date.now();

      try {
        // Build advanced search query: from:handle since:date until:date
        const query = `from:${handle} since:${sinceStr} until:${untilStr}`;

        const response = await fetch(
          `${TWITTER_API_CONFIG.baseUrl}/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`,
          {
            headers: {
              'X-API-Key': TWITTER_API_CONFIG.apiKey,
            },
          }
        );

        if (!response.ok) {
          console.warn(`Monitor ${handle}: ${response.status}`);
          results.push({ handle, tweets: [] });
          continue;
        }

        const data = await response.json() as {
          tweets?: Array<{
            id: string;
            text: string;
            url?: string;
            createdAt: string;
            likeCount?: number;
            retweetCount?: number;
            replyCount?: number;
            viewCount?: number;
            author?: { userName: string; name: string };
            isReply?: boolean;
          }>;
          has_next_page?: boolean;
          next_cursor?: string;
        };

        const tweets = (data.tweets || [])
          .filter(t => !t.isReply)
          .filter(t => new Date(t.createdAt) >= since) // Double-check time window
          .map(tweet => ({
            id: tweet.id,
            source: `twitter:${handle}`,
            sourceType: 'twitter' as SourceType,
            author: tweet.author?.name || handle,
            content: tweet.text,
            url: tweet.url || `https://twitter.com/${handle}/status/${tweet.id}`,
            publishedAt: new Date(tweet.createdAt),
            metadata: {
              likeCount: tweet.likeCount || 0,
              retweetCount: tweet.retweetCount || 0,
              replyCount: tweet.replyCount || 0,
              viewCount: tweet.viewCount || 0,
              provider: 'twitterapi.io',
              monitorMode: true
            }
          }));

        results.push({ handle, tweets });

        // Persist tweets if requested
        if (persist && tweets.length > 0) {
          const sources = await this.sourceStore.getByType('twitter');
          const source = sources.find(s => s.identifier.toLowerCase() === handle.toLowerCase());
          if (source?.id) {
            for (const tweet of tweets) {
              await this.contentStore.upsert({
                sourceId: source.id,
                externalId: tweet.id || `${handle}_${tweet.publishedAt.getTime()}`,
                url: tweet.url,
                contentText: tweet.content,
                contentType: 'twitter',
                author: tweet.author,
                publishedAt: tweet.publishedAt,
                metadata: tweet.metadata,
              });
            }
          }
        }

      } catch (error) {
        console.warn(`Monitor ${handle} failed:`, error);
        results.push({ handle, tweets: [] });
      }
    }

    return results;
  }

  // ============================================================================
  // SUBSTACK
  // ============================================================================
  
  async fetchSubstack(feedUrl: string, authorName?: string): Promise<RawContent[]> {
    const feed = await this.rssParser.parseURL(feedUrl);
    
    return feed.items.map(item => {
      // Substack includes full content in content:encoded
      const fullContent = item.contentEncoded || item.content || '';
      const dom = new JSDOM(fullContent);
      const textContent = dom.window.document.body.textContent?.trim() || '';
      
      return {
        id: item.guid || item.link || '',
        source: `substack:${new URL(feedUrl).hostname}`,
        sourceType: 'substack' as SourceType,
        author: authorName || item.creator || feed.title || '',
        title: item.title,
        content: textContent,
        url: item.link,
        publishedAt: new Date(item.pubDate || Date.now()),
        metadata: {
          htmlContent: fullContent,
          wordCount: textContent.split(/\s+/).length
        }
      };
    });
  }
  
  // ============================================================================
  // YOUTUBE
  // ============================================================================
  
  async fetchYouTube(channelId: string, authorName?: string): Promise<RawContent[]> {
    try {
      // Get recent videos
      const output = execSync(
        `yt-dlp --flat-playlist -j --playlist-end 20 "https://www.youtube.com/channel/${channelId}/videos" 2>/dev/null`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );
      
      const videos = output
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      
      // Fetch transcripts for each video
      const results: RawContent[] = [];
      
      for (const video of videos.slice(0, 10)) { // Limit to 10 for transcripts
        const transcript = await this.fetchYouTubeTranscript(video.id);
        
        results.push({
          id: video.id,
          source: `youtube:${channelId}`,
          sourceType: 'youtube' as SourceType,
          author: authorName || video.uploader || '',
          title: video.title,
          content: transcript || video.description || '',
          url: `https://youtube.com/watch?v=${video.id}`,
          publishedAt: video.timestamp ? new Date(video.timestamp * 1000) : new Date(),
          metadata: {
            duration: video.duration,
            hasTranscript: !!transcript,
            description: video.description
          }
        });
        
        await this.sleep(500); // Rate limit
      }
      
      return results;
    } catch (e) {
      throw new Error(`Failed to fetch YouTube: ${e}`);
    }
  }
  
  private async fetchYouTubeTranscript(videoId: string): Promise<string | null> {
    const tempFile = `/tmp/${videoId}.en.json3`;
    try {
      // Use yt-dlp to get subtitles
      const output = execSync(
        `yt-dlp --skip-download --write-auto-sub --sub-lang en --sub-format json3 -o "/tmp/%(id)s" "https://youtube.com/watch?v=${videoId}" 2>/dev/null && cat ${tempFile} 2>/dev/null`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
      );

      const data = JSON.parse(output.toString());
      const text = data.events
        ?.filter((e: any) => e.segs)
        .map((e: any) => e.segs.map((s: any) => s.utf8).join(''))
        .join(' ');

      return text || null;
    } catch {
      return null;
    } finally {
      // Clean up temp file
      try {
        execSync(`rm -f ${tempFile} 2>/dev/null`);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
  
  // ============================================================================
  // BLOG (RSS/Atom)
  // ============================================================================
  
  async fetchBlog(feedUrl: string, authorName?: string): Promise<RawContent[]> {
    const feed = await this.rssParser.parseURL(feedUrl);
    
    return feed.items.map(item => {
      const fullContent = item.contentEncoded || item.content || '';
      const dom = new JSDOM(fullContent);
      const textContent = dom.window.document.body.textContent?.trim() || '';
      
      return {
        id: item.guid || item.link || '',
        source: `blog:${new URL(feedUrl).hostname}`,
        sourceType: 'blog' as SourceType,
        author: authorName || item.creator || feed.title || '',
        title: item.title,
        content: textContent || item.contentSnippet || '',
        url: item.link,
        publishedAt: new Date(item.pubDate || Date.now()),
        metadata: {
          htmlContent: fullContent
        }
      };
    });
  }
  
  // ============================================================================
  // PODCAST
  // ============================================================================
  
  async fetchPodcast(feedUrl: string, authorName?: string): Promise<RawContent[]> {
    const feed = await this.rssParser.parseURL(feedUrl);
    
    return feed.items.map(item => ({
      id: item.guid || item.link || '',
      source: `podcast:${feed.title || new URL(feedUrl).hostname}`,
      sourceType: 'podcast' as SourceType,
      author: authorName || feed.title || '',
      title: item.title,
      content: item.contentSnippet || item.content || '',
      url: item.link,
      publishedAt: new Date(item.pubDate || Date.now()),
      metadata: {
        duration: item.itunes?.duration,
        audioUrl: item.enclosure?.url,
        episodeNumber: item.itunes?.episode
      }
    }));
  }
  
  // ============================================================================
  // LESSWRONG / ALIGNMENT FORUM
  // ============================================================================
  
  async fetchLessWrong(tag: string = 'ai'): Promise<RawContent[]> {
    // LessWrong API uses tag slugs (e.g., "ai-safety") not tag IDs
    // Using filterSettings for more reliable tag filtering
    const query = `
      query GetPosts($tagSlug: String) {
        posts(input: {
          terms: {
            limit: 50
            filterSettings: { tags: [{ tagSlug: $tagSlug, filterMode: "Required" }] }
            sortedBy: "new"
          }
        }) {
          results {
            _id
            title
            slug
            postedAt
            baseScore
            user { username displayName }
            contents { html wordCount }
          }
        }
      }
    `;

    const response = await fetch('https://www.lesswrong.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { tagSlug: tag }
      })
    });
    
    const data = await response.json();
    const posts = data.data?.posts?.results || [];
    
    return posts.map((post: any) => {
      const dom = new JSDOM(post.contents?.html || '');
      const textContent = dom.window.document.body.textContent?.trim() || '';
      
      return {
        id: post._id,
        source: 'lesswrong',
        sourceType: 'lesswrong' as SourceType,
        author: post.user?.displayName || post.user?.username || '',
        title: post.title,
        content: textContent,
        url: `https://www.lesswrong.com/posts/${post._id}/${post.slug}`,
        publishedAt: new Date(post.postedAt),
        metadata: {
          score: post.baseScore,
          wordCount: post.contents?.wordCount
        }
      };
    });
  }
  
  // ============================================================================
  // ARXIV
  // ============================================================================
  
  async fetchArxiv(query: string): Promise<RawContent[]> {
    // If query looks like a category (e.g., "cs.AI"), format for arXiv API
    // arXiv expects "cat:cs.AI" for category search
    const searchQuery = query.match(/^[a-z]+\.[A-Z]+$/i)
      ? `cat:${query}`
      : query;

    const params = new URLSearchParams({
      search_query: searchQuery,
      start: '0',
      max_results: '50',
      sortBy: 'submittedDate',
      sortOrder: 'descending'
    });
    
    const response = await fetch(`http://export.arxiv.org/api/query?${params}`);
    const xml = await response.text();
    
    const feed = await this.rssParser.parseString(xml);
    
    return feed.items.map(item => ({
      id: item.id?.split('/abs/')[1] || item.guid || '',
      source: 'arxiv',
      sourceType: 'arxiv' as SourceType,
      author: '', // arXiv author parsing is complex
      title: item.title?.replace(/\n/g, ' ').trim(),
      content: item.summary?.replace(/\n/g, ' ').trim() || '',
      url: item.id,
      publishedAt: new Date(item.pubDate || Date.now()),
      metadata: {
        categories: item.categories,
        pdfUrl: item.id?.replace('/abs/', '/pdf/') + '.pdf'
      }
    }));
  }
  
  // ============================================================================
  // BLUESKY
  // ============================================================================
  
  async fetchBluesky(handle: string, authorName?: string): Promise<RawContent[]> {
    // Use AT Protocol public API
    const response = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${handle}&limit=50`
    );
    
    if (!response.ok) {
      throw new Error(`Bluesky API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    return data.feed.map((item: any) => ({
      id: item.post.uri,
      source: `bluesky:${handle}`,
      sourceType: 'bluesky' as SourceType,
      author: authorName || item.post.author.displayName || handle,
      content: item.post.record.text,
      url: `https://bsky.app/profile/${item.post.author.handle}/post/${item.post.uri.split('/').pop()}`,
      publishedAt: new Date(item.post.record.createdAt),
      metadata: {
        likes: item.post.likeCount,
        reposts: item.post.repostCount,
        replies: item.post.replyCount
      }
    }));
  }
  
  // ============================================================================
  // UTILITIES
  // ============================================================================
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// SOURCE SEEDER
// ============================================================================

export async function seedSources(dbUrl: string): Promise<void> {
  const store = new SourceStore(dbUrl);
  let count = 0;

  // Twitter sources
  for (const source of sourcesData.twitter) {
    await store.upsert({
      type: 'twitter',
      identifier: source.handle,
      authorName: source.name,
      category: source.category as ContentCategory,
      fetchFrequencyHours: source.priority === 'high' ? 4 : 6
    });
    count++;
  }

  // Substack sources
  for (const source of sourcesData.substack) {
    await store.upsert({
      type: 'substack',
      identifier: source.url,
      authorName: source.author,
      category: source.category as ContentCategory,
      fetchFrequencyHours: source.tier === 1 ? 6 : 12
    });
    count++;
  }

  // YouTube channels
  for (const source of sourcesData.youtube) {
    await store.upsert({
      type: 'youtube',
      identifier: source.id,
      authorName: source.name,
      category: source.category as ContentCategory,
      fetchFrequencyHours: 24
    });
    count++;
  }

  // Blogs
  for (const source of sourcesData.blog) {
    await store.upsert({
      type: 'blog',
      identifier: source.url,
      authorName: source.author,
      category: source.category as ContentCategory,
      fetchFrequencyHours: 24
    });
    count++;
  }

  // LessWrong tags
  for (const source of sourcesData.lesswrong) {
    await store.upsert({
      type: 'lesswrong',
      identifier: source.tag,
      authorName: source.name,
      category: (source.category || 'safety') as ContentCategory,
      fetchFrequencyHours: 12
    });
    count++;
  }

  // arXiv categories
  for (const source of sourcesData.arxiv) {
    await store.upsert({
      type: 'arxiv',
      identifier: source.category,
      authorName: source.name,
      category: 'academic' as ContentCategory,
      fetchFrequencyHours: 24
    });
    count++;
  }

  // Bluesky handles
  for (const source of sourcesData.bluesky) {
    await store.upsert({
      type: 'bluesky',
      identifier: source.handle,
      authorName: source.name,
      category: source.category as ContentCategory,
      fetchFrequencyHours: 6
    });
    count++;
  }

  // Podcasts
  for (const source of sourcesData.podcast) {
    await store.upsert({
      type: 'podcast',
      identifier: source.rss,
      authorName: source.name,
      category: source.category as ContentCategory,
      fetchFrequencyHours: 48
    });
    count++;
  }

  console.log(`Sources seeded successfully: ${count} sources added`);
}

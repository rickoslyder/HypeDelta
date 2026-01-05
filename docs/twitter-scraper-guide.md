# Twitter Scraper Guide

A comprehensive guide to scraping Twitter/X using TwitterAPI.io - a reliable third-party API service that doesn't require Twitter Developer credentials.

## Overview

This guide covers the Twitter scraping implementation used in HypeDelta, which can be adapted for any project needing Twitter data.

**Key Features:**
- No Twitter Developer account required
- Built-in rate limiting
- Two fetch modes: recent tweets and time-windowed search
- Engagement metrics (likes, retweets, views)
- Nitter fallback (legacy, mostly non-functional)

## TwitterAPI.io Setup

### 1. Get an API Key

1. Visit [twitterapi.io](https://twitterapi.io)
2. Sign up for an account
3. Purchase credits (pricing varies by tier)
4. Copy your API key from the dashboard

### 2. Rate Limits by Tier

| Credit Tier | QPS Limit | Interval |
|-------------|-----------|----------|
| < 10,000    | 1 req/5s  | 5000ms   |
| 10,000+     | 5 QPS     | 200ms    |
| 50,000+     | 20 QPS    | 50ms     |

### 3. Environment Configuration

```bash
export TWITTER_API_KEY="your_api_key_here"
```

## API Endpoints

### Endpoint 1: Get Recent Tweets (`last_tweets`)

Fetches the most recent tweets from a user's timeline.

**URL:** `https://api.twitterapi.io/twitter/user/last_tweets`

**Method:** GET

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `userName` | string | Twitter handle (without @) |

**Request:**
```typescript
const response = await fetch(
  `https://api.twitterapi.io/twitter/user/last_tweets?userName=${handle}`,
  {
    headers: {
      'X-API-Key': process.env.TWITTER_API_KEY,
    },
  }
);
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "tweets": [
      {
        "id": "1234567890",
        "text": "Tweet content here...",
        "url": "https://twitter.com/user/status/1234567890",
        "createdAt": "2024-01-15T10:30:00.000Z",
        "likeCount": 150,
        "retweetCount": 25,
        "replyCount": 10,
        "viewCount": 5000,
        "author": {
          "userName": "handle",
          "name": "Display Name"
        },
        "isReply": false,
        "quoted_tweet": null,
        "retweeted_tweet": null
      }
    ]
  }
}
```

### Endpoint 2: Advanced Search (`advanced_search`)

Search tweets with filters like date range, from user, keywords, etc.

**URL:** `https://api.twitterapi.io/twitter/tweet/advanced_search`

**Method:** GET

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Twitter search query syntax |
| `queryType` | string | `Latest` or `Top` |

**Query Syntax Examples:**
```
from:elonmusk                    # Tweets from a user
from:elonmusk since:2024-01-01   # From user after date
from:elonmusk until:2024-01-31   # From user before date
"exact phrase"                   # Exact phrase match
AI OR ML                         # Either term
AI -spam                         # AI but not spam
min_replies:100                  # Minimum engagement
```

**Request:**
```typescript
const query = `from:${handle} since:${sinceDate} until:${untilDate}`;
const response = await fetch(
  `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`,
  {
    headers: {
      'X-API-Key': process.env.TWITTER_API_KEY,
    },
  }
);
```

**Response:**
```json
{
  "tweets": [...],
  "has_next_page": true,
  "next_cursor": "cursor_string"
}
```

## Implementation

### Minimal TypeScript Implementation

```typescript
// twitter-scraper.ts

interface Tweet {
  id: string;
  text: string;
  url: string;
  createdAt: Date;
  author: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    views: number;
  };
}

interface TwitterConfig {
  apiKey: string;
  rateLimitMs: number;
}

class TwitterScraper {
  private config: TwitterConfig;
  private lastApiCall = 0;

  constructor(apiKey: string, rateLimitMs = 50) {
    this.config = { apiKey, rateLimitMs };
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastApiCall;
    if (elapsed < this.config.rateLimitMs) {
      await new Promise(resolve =>
        setTimeout(resolve, this.config.rateLimitMs - elapsed)
      );
    }
    this.lastApiCall = Date.now();
  }

  async getRecentTweets(handle: string): Promise<Tweet[]> {
    await this.rateLimit();

    const response = await fetch(
      `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`,
      {
        headers: { 'X-API-Key': this.config.apiKey },
      }
    );

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== 'success' || !data.data?.tweets) {
      throw new Error(`Invalid response: ${JSON.stringify(data)}`);
    }

    return data.data.tweets
      .filter((t: any) => !t.isReply)
      .map((t: any) => ({
        id: t.id,
        text: t.text,
        url: t.url || `https://twitter.com/${handle}/status/${t.id}`,
        createdAt: new Date(t.createdAt),
        author: t.author?.name || handle,
        metrics: {
          likes: t.likeCount || 0,
          retweets: t.retweetCount || 0,
          replies: t.replyCount || 0,
          views: t.viewCount || 0,
        },
      }));
  }

  async searchTweets(query: string): Promise<Tweet[]> {
    await this.rateLimit();

    const response = await fetch(
      `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`,
      {
        headers: { 'X-API-Key': this.config.apiKey },
      }
    );

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    return (data.tweets || []).map((t: any) => ({
      id: t.id,
      text: t.text,
      url: t.url,
      createdAt: new Date(t.createdAt),
      author: t.author?.name || '',
      metrics: {
        likes: t.likeCount || 0,
        retweets: t.retweetCount || 0,
        replies: t.replyCount || 0,
        views: t.viewCount || 0,
      },
    }));
  }

  async monitor(handles: string[], sinceMinutes = 15): Promise<Map<string, Tweet[]>> {
    const results = new Map<string, Tweet[]>();
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
    const sinceStr = since.toISOString().split('T')[0];
    const untilStr = new Date().toISOString().split('T')[0];

    for (const handle of handles) {
      try {
        const query = `from:${handle} since:${sinceStr} until:${untilStr}`;
        const tweets = await this.searchTweets(query);
        results.set(handle, tweets.filter(t => t.createdAt >= since));
      } catch (error) {
        console.warn(`Failed to monitor ${handle}:`, error);
        results.set(handle, []);
      }
    }

    return results;
  }
}

export { TwitterScraper, Tweet };
```

### Usage Examples

```typescript
import { TwitterScraper } from './twitter-scraper';

const scraper = new TwitterScraper(process.env.TWITTER_API_KEY!);

// Get recent tweets from a user
const tweets = await scraper.getRecentTweets('elonmusk');
console.log(`Found ${tweets.length} tweets`);

// Search with query
const aiTweets = await scraper.searchTweets('AI from:sama');

// Monitor multiple accounts for new tweets
const newTweets = await scraper.monitor(
  ['sama', 'ylecun', 'kaborowe'],
  30 // last 30 minutes
);
```

## Rate Limiting Best Practices

### 1. Global Rate Limiter

```typescript
class RateLimiter {
  private lastCall = 0;

  constructor(private minIntervalMs: number) {}

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.lastCall;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastCall = Date.now();
  }
}

// Shared instance for all Twitter API calls
const twitterRateLimiter = new RateLimiter(50); // 20 QPS
```

### 2. Batch Processing with Delays

```typescript
async function fetchMultipleUsers(handles: string[]): Promise<Tweet[]> {
  const allTweets: Tweet[] = [];

  for (const handle of handles) {
    const tweets = await scraper.getRecentTweets(handle);
    allTweets.push(...tweets);

    // Additional delay between users for safety
    await new Promise(r => setTimeout(r, 1000));
  }

  return allTweets;
}
```

## Error Handling

```typescript
async function safeFetch(handle: string): Promise<Tweet[]> {
  try {
    return await scraper.getRecentTweets(handle);
  } catch (error) {
    if (error instanceof Error) {
      // Rate limit hit
      if (error.message.includes('429')) {
        console.warn('Rate limited, waiting 60s...');
        await new Promise(r => setTimeout(r, 60000));
        return safeFetch(handle);
      }

      // User not found or protected
      if (error.message.includes('404')) {
        console.warn(`User ${handle} not found`);
        return [];
      }
    }
    throw error;
  }
}
```

## Filtering and Processing

### Filter Replies and Retweets

```typescript
const originalTweets = tweets.filter(t =>
  !t.isReply && !t.retweeted_tweet
);
```

### Filter by Engagement

```typescript
const viralTweets = tweets.filter(t =>
  t.metrics.likes > 100 || t.metrics.retweets > 20
);
```

### Filter by Content

```typescript
const aiTweets = tweets.filter(t =>
  t.text.toLowerCase().includes('ai') ||
  t.text.toLowerCase().includes('artificial intelligence')
);
```

## Database Storage Pattern

```typescript
interface StoredTweet {
  external_id: string;
  author_handle: string;
  content: string;
  url: string;
  published_at: Date;
  fetched_at: Date;
  likes: number;
  retweets: number;
  views: number;
}

async function storeTweet(tweet: Tweet, pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO tweets (external_id, author_handle, content, url, published_at, fetched_at, likes, retweets, views)
    VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
    ON CONFLICT (external_id) DO UPDATE SET
      likes = $6,
      retweets = $7,
      views = $8,
      fetched_at = NOW()
  `, [
    tweet.id,
    tweet.author,
    tweet.text,
    tweet.url,
    tweet.createdAt,
    tweet.metrics.likes,
    tweet.metrics.retweets,
    tweet.metrics.views,
  ]);
}
```

## Monitoring Pattern

For real-time monitoring of accounts:

```typescript
async function runMonitor(
  handles: string[],
  intervalMinutes = 15,
  onNewTweets: (handle: string, tweets: Tweet[]) => Promise<void>
): Promise<void> {
  console.log(`Starting monitor for ${handles.length} accounts`);

  while (true) {
    const results = await scraper.monitor(handles, intervalMinutes);

    for (const [handle, tweets] of results) {
      if (tweets.length > 0) {
        console.log(`${handle}: ${tweets.length} new tweets`);
        await onNewTweets(handle, tweets);
      }
    }

    // Wait for next check
    await new Promise(r => setTimeout(r, intervalMinutes * 60 * 1000));
  }
}

// Usage
runMonitor(['sama', 'ylecun'], 15, async (handle, tweets) => {
  for (const tweet of tweets) {
    await storeTweet(tweet, dbPool);
  }
});
```

## Cost Estimation

TwitterAPI.io charges by API calls:

| Operation | Credits | Example Cost (at $10/100k credits) |
|-----------|---------|-----------------------------------|
| last_tweets | ~1 | $0.0001 |
| advanced_search | ~1 | $0.0001 |

**Monthly estimates:**
- 100 accounts × 4 fetches/day × 30 days = 12,000 calls = ~$1.20
- With monitoring every 15 min: 100 × 96/day × 30 = 288,000 calls = ~$28.80

## Nitter Fallback (Legacy)

Nitter instances are mostly non-functional as of 2025, but the fallback pattern is useful:

```typescript
const NITTER_INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
];

async function fetchViaNitter(handle: string): Promise<Tweet[]> {
  for (const instance of NITTER_INSTANCES) {
    try {
      const response = await fetch(`https://${instance}/${handle}/rss`);
      if (response.ok) {
        // Parse RSS feed...
        return parsedTweets;
      }
    } catch {
      continue;
    }
  }
  throw new Error('All Nitter instances failed');
}
```

## Complete Standalone Module

For easy copy-paste into other projects, here's the complete module:

```typescript
// twitter.ts - Standalone Twitter scraper module

export interface Tweet {
  id: string;
  text: string;
  url: string;
  createdAt: Date;
  author: string;
  authorHandle: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    views: number;
  };
  isRetweet: boolean;
  isQuote: boolean;
}

export class TwitterAPI {
  private apiKey: string;
  private rateLimitMs: number;
  private lastCall = 0;

  constructor(options: { apiKey: string; rateLimitMs?: number }) {
    this.apiKey = options.apiKey;
    this.rateLimitMs = options.rateLimitMs ?? 50;
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastCall;
    if (elapsed < this.rateLimitMs) {
      await new Promise(r => setTimeout(r, this.rateLimitMs - elapsed));
    }
    this.lastCall = Date.now();
  }

  async getUserTweets(handle: string): Promise<Tweet[]> {
    await this.throttle();

    const res = await fetch(
      `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`,
      { headers: { 'X-API-Key': this.apiKey } }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    const json = await res.json();
    if (json.status !== 'success') throw new Error(JSON.stringify(json));

    return (json.data?.tweets || [])
      .filter((t: any) => !t.isReply)
      .map((t: any): Tweet => ({
        id: t.id,
        text: t.text,
        url: t.url || `https://twitter.com/${handle}/status/${t.id}`,
        createdAt: new Date(t.createdAt),
        author: t.author?.name || handle,
        authorHandle: t.author?.userName || handle,
        metrics: {
          likes: t.likeCount ?? 0,
          retweets: t.retweetCount ?? 0,
          replies: t.replyCount ?? 0,
          views: t.viewCount ?? 0,
        },
        isRetweet: !!t.retweeted_tweet,
        isQuote: !!t.quoted_tweet,
      }));
  }

  async search(query: string, type: 'Latest' | 'Top' = 'Latest'): Promise<Tweet[]> {
    await this.throttle();

    const res = await fetch(
      `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=${type}`,
      { headers: { 'X-API-Key': this.apiKey } }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    const json = await res.json();

    return (json.tweets || []).map((t: any): Tweet => ({
      id: t.id,
      text: t.text,
      url: t.url,
      createdAt: new Date(t.createdAt),
      author: t.author?.name || '',
      authorHandle: t.author?.userName || '',
      metrics: {
        likes: t.likeCount ?? 0,
        retweets: t.retweetCount ?? 0,
        replies: t.replyCount ?? 0,
        views: t.viewCount ?? 0,
      },
      isRetweet: !!t.retweeted_tweet,
      isQuote: !!t.quoted_tweet,
    }));
  }
}

// Quick usage:
// const twitter = new TwitterAPI({ apiKey: process.env.TWITTER_API_KEY! });
// const tweets = await twitter.getUserTweets('sama');
```

## References

- [TwitterAPI.io Documentation](https://docs.twitterapi.io)
- [TwitterAPI.io Rate Limits](https://twitterapi.io/qps-limits)
- [Twitter Search Operators](https://developer.twitter.com/en/docs/twitter-api/tweets/search/integrate/build-a-query)

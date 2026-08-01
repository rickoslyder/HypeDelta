/**
 * Batched Twitter fetch — cost regression tests.
 *
 * Context (2026-08-01): the per-handle /twitter/user/last_tweets path always returns the newest
 * ~20 tweets and has no time or since_id filter, while billing 15 credits per tweet RETURNED.
 * A 4-hourly cycle over 73 handles bought ~1,086 tweets (16,290 credits) six times a day to
 * surface ~28 new items. These tests pin the properties that make the batched path cheap, so a
 * future refactor cannot quietly reintroduce the per-handle fan-out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadFetcher() {
  vi.resetModules();
  return await import('../fetcher');
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('batched twitter fetch', () => {
  beforeEach(() => {
    process.env.TWITTER_API_KEY = 'test-key';
    process.env.TWITTER_HANDLES_PER_QUERY = '10';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('issues ONE request per batch of handles, not one per handle', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return jsonResponse({ tweets: [], has_next_page: false, next_cursor: null });
    }));

    const { AIIntelFetcher } = await loadFetcher();
    const f: any = new AIIntelFetcher({ dbUrl: 'postgresql://localhost/test' });

    const sources = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1, type: 'twitter', identifier: `user${i}`, lastFetched: new Date(Date.now() - 3600_000),
    }));
    await f.fetchTwitterBatched(sources);

    // 20 handles / 10 per query = 2 requests. The old path would have made 20.
    expect(calls.length).toBe(2);
    expect(calls.every(u => u.includes('advanced_search'))).toBe(true);
    expect(calls.some(u => u.includes('last_tweets'))).toBe(false);
  });

  it('sends a unix-precision since_time window, never an unfiltered query', async () => {
    let captured = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      captured = decodeURIComponent(String(url));
      return jsonResponse({ tweets: [], has_next_page: false, next_cursor: null });
    }));

    const { AIIntelFetcher } = await loadFetcher();
    const f: any = new AIIntelFetcher({ dbUrl: 'postgresql://localhost/test' });
    await f.fetchTwitterBatched([
      { id: 1, type: 'twitter', identifier: 'alice', lastFetched: new Date(Date.now() - 3600_000) },
    ]);

    expect(captured).toMatch(/since_time:\d{10}/);
    expect(captured).toMatch(/until_time:\d{10}/);
    expect(captured).toContain('from:alice');
  });

  it('uses the OLDEST watermark in a batch so a lagging source is not skipped', async () => {
    let captured = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      captured = decodeURIComponent(String(url));
      return jsonResponse({ tweets: [], has_next_page: false, next_cursor: null });
    }));

    const { AIIntelFetcher } = await loadFetcher();
    const f: any = new AIIntelFetcher({ dbUrl: 'postgresql://localhost/test' });

    const recent = new Date(Date.now() - 3600_000);      // 1h ago
    const lagging = new Date(Date.now() - 10 * 3600_000); // 10h ago
    await f.fetchTwitterBatched([
      { id: 1, type: 'twitter', identifier: 'fresh', lastFetched: recent },
      { id: 2, type: 'twitter', identifier: 'lagging', lastFetched: lagging },
    ]);

    const since = Number(captured.match(/since_time:(\d+)/)![1]);
    const laggingSec = Math.floor(lagging.getTime() / 1000);
    expect(since).toBeLessThanOrEqual(laggingSec + 2);
  });

  it('clamps the window so a long outage cannot trigger an unbounded backfill', async () => {
    process.env.TWITTER_MAX_LOOKBACK_HOURS = '48';
    let captured = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      captured = decodeURIComponent(String(url));
      return jsonResponse({ tweets: [], has_next_page: false, next_cursor: null });
    }));

    const { AIIntelFetcher } = await loadFetcher();
    const f: any = new AIIntelFetcher({ dbUrl: 'postgresql://localhost/test' });
    await f.fetchTwitterBatched([
      { id: 1, type: 'twitter', identifier: 'stale', lastFetched: new Date(Date.now() - 400 * 3600_000) },
    ]);

    const now = Math.floor(Date.now() / 1000);
    const since = Number(captured.match(/since_time:(\d+)/)![1]);
    expect(now - since).toBeLessThanOrEqual(48 * 3600 + 5);
  });

  it('routes tweets back to the right handle and drops replies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      tweets: [
        { id: '1', text: 'from alice', createdAt: new Date().toISOString(), author: { userName: 'Alice', name: 'A' } },
        { id: '2', text: 'a reply',    createdAt: new Date().toISOString(), author: { userName: 'bob' }, isReply: true },
        { id: '3', text: 'from bob',   createdAt: new Date().toISOString(), author: { userName: 'bob' } },
      ],
      has_next_page: false, next_cursor: null,
    })));

    const { AIIntelFetcher } = await loadFetcher();
    const f: any = new AIIntelFetcher({ dbUrl: 'postgresql://localhost/test' });
    const out = await f.fetchTwitterBatched([
      { id: 1, type: 'twitter', identifier: 'alice', lastFetched: new Date() },
      { id: 2, type: 'twitter', identifier: 'bob', lastFetched: new Date() },
    ]);

    expect(out.get('alice').map((c: any) => c.id)).toEqual(['1']); // case-insensitive handle match
    expect(out.get('bob').map((c: any) => c.id)).toEqual(['3']);   // reply filtered out
  });

  it('falls back to the per-handle path when a batch errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })));

    const { AIIntelFetcher } = await loadFetcher();
    const f: any = new AIIntelFetcher({ dbUrl: 'postgresql://localhost/test' });
    const spy = vi.spyOn(f, 'fetchTwitter').mockResolvedValue([{ id: 'fb' }] as any);

    const out = await f.fetchTwitterBatched([
      { id: 1, type: 'twitter', identifier: 'alice', lastFetched: new Date() },
    ]);

    expect(spy).toHaveBeenCalledWith('alice', undefined);
    expect(out.get('alice')).toHaveLength(1);
  });
});

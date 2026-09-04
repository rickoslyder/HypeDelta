/**
 * 12C2: twitterapi.io paid-provider retry + circuit breaker tests.
 *
 * Shared per-AIIntelFetcher helper used by advanced_search (batched + monitor)
 * and last_tweets. All HTTP stubbed; sleep/now injected (no-op sleeps).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const TWITTER_TEST_API_KEY = vi.hoisted(() => {
  const key = 'test-twitter-key';
  process.env.TWITTER_API_KEY = key;
  return key;
});

const mockFetch = vi.fn();
global.fetch = mockFetch;

const nitterParseURL = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  exec: vi.fn((cmd, callback) => {
    callback(null, JSON.stringify({ entries: [] }), '');
  }),
  execSync: vi.fn(() => ''),
}));

vi.mock('rss-parser', () => {
  const MockParser = function (this: any) {
    this.parseURL = nitterParseURL;
    this.parseString = vi.fn().mockResolvedValue({ items: [] });
  };
  return { default: MockParser };
});

import { AIIntelFetcher } from '../fetcher';

function httpErrorResponse(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

function okLastTweets(tweets: any[] = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', data: { tweets } }),
  };
}

function dnsError() {
  return Object.assign(new Error('getaddrinfo ENOTFOUND api.twitterapi.io'), {
    code: 'ENOTFOUND',
  });
}
function timeoutError() {
  const e = new Error('The operation timed out');
  e.name = 'TimeoutError';
  return e;
}
function networkError() {
  return new TypeError('fetch failed');
}

function makeFetcher() {
  const sleeps: number[] = [];
  let now = 1_000_000;
  const attempts: any[] = [];
  const fetcher = new AIIntelFetcher({
    dbUrl: 'postgresql://localhost/test',
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => now,
    sourceFetchAttemptStore: {
      record: async (input: any) => {
        attempts.push(input);
        return attempts.length;
      },
    },
  });
  // No Postgres in unit tests: stub the persistence seams the success path hits
  // (same pattern as fetcher.test.ts) so fetchSources never opens a socket.
  (fetcher as any).sourceStore.markFetched = vi.fn().mockResolvedValue(undefined);
  (fetcher as any).contentStore.upsert = vi.fn().mockResolvedValue(1);
  return {
    fetcher,
    sleeps,
    attempts,
    advance: (ms: number) => {
      now += ms;
    },
    backoffSleeps: () => sleeps.filter((ms) => ms === 250 || ms === 500),
  };
}

const twitterSource = {
  id: 7,
  type: 'twitter' as const,
  identifier: 'somehandle',
  authorName: 'Some Handle',
  category: 'lab-researcher' as const,
};

describe('12C2 twitter paid-provider retry classes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['dns', () => Promise.reject(dnsError())],
    ['timeout', () => Promise.reject(timeoutError())],
    ['rate_limit 429', () => Promise.resolve(httpErrorResponse(429))],
    ['http_5xx', () => Promise.resolve(httpErrorResponse(503))],
    ['network fetch failure', () => Promise.reject(networkError())],
  ])('retries %s up to 3 attempts with 250/500 backoff then succeeds', async (_name, fail) => {
    const { fetcher, backoffSleeps } = makeFetcher();
    mockFetch.mockImplementationOnce(fail).mockImplementationOnce(fail).mockResolvedValueOnce(okLastTweets([]));

    const out = await (fetcher as any).fetchTwitterViaAPI('handle');
    expect(out).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(backoffSleeps()).toEqual([250, 500]);
  });

  it('caps at 3 total attempts and 750ms backoff per request, then throws', async () => {
    const { fetcher, backoffSleeps } = makeFetcher();
    mockFetch.mockResolvedValue(httpErrorResponse(500));

    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/500/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(backoffSleeps()).toEqual([250, 500]);
    expect(backoffSleeps().reduce((a, b) => a + b, 0)).toBe(750);
  });

  it.each([
    ['auth 401', () => Promise.resolve(httpErrorResponse(401))],
    ['auth 403', () => Promise.resolve(httpErrorResponse(403))],
    ['http_4xx', () => Promise.resolve(httpErrorResponse(400))],
    ['parse/provider payload', () => Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'error' }) })],
  ])('never retries %s', async (_name, fail) => {
    const { fetcher } = makeFetcher();
    mockFetch.mockImplementation(fail);

    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('non-transient failures do not increment the breaker', async () => {
    const { fetcher } = makeFetcher();
    mockFetch.mockResolvedValue(httpErrorResponse(401));

    for (let i = 0; i < 5; i++) {
      await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/401/);
    }
    // 5 exhausted non-transient requests: breaker must stay closed, fetch still called.
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

describe('12C2 circuit breaker open/suppress/probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function exhaustThreeRequests(fetcher: any) {
    mockFetch.mockResolvedValue(httpErrorResponse(500));
    for (let i = 0; i < 3; i++) {
      await expect(fetcher.fetchTwitterViaAPI('handle')).rejects.toThrow(/500/);
    }
    expect(mockFetch).toHaveBeenCalledTimes(9);
    mockFetch.mockClear();
  }

  it('opens exactly at 3 exhausted transient requests; 4th makes zero fetch calls', async () => {
    const { fetcher } = makeFetcher();
    mockFetch.mockResolvedValue(httpErrorResponse(500));

    for (let i = 0; i < 2; i++) {
      await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/500/);
    }
    expect(mockFetch).toHaveBeenCalledTimes(6);
    // still closed: a 3rd request actually fetches
    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/500/);
    expect(mockFetch).toHaveBeenCalledTimes(9);

    mockFetch.mockClear();
    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/circuit/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('while open: no paid fetch, no Nitter fallthrough', async () => {
    const { fetcher } = makeFetcher();
    await exhaustThreeRequests(fetcher as any);

    await expect(fetcher.fetchTwitter('handle')).rejects.toThrow(/circuit/i);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(nitterParseURL).not.toHaveBeenCalled();
  });

  it('while open: fetchSources yields 12C1 failure + one receipt + no mark, bumps skippedCircuit and failuresByClass.provider', async () => {
    const { fetcher, attempts } = makeFetcher();
    await exhaustThreeRequests(fetcher as any);

    const result = await fetcher.fetchSources([twitterSource as any]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(nitterParseURL).not.toHaveBeenCalled();
    expect(result.summary.skippedCircuit).toBe(1);
    expect(result.summary.failuresByClass.provider).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].errorClass).toBe('provider');
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].kind).toBe('failure');
    // exactly one receipt for the source, marked not-ok; markFetched never reached
    expect(attempts).toHaveLength(1);
    expect(attempts[0].ok).toBe(false);
    expect(attempts[0].sourceId).toBe(7);
  });

  it('monitorTwitter suppressed while open: no fetch, empty result per handle', async () => {
    const { fetcher } = makeFetcher();
    await exhaustThreeRequests(fetcher as any);

    const results = await fetcher.monitorTwitter(['handle'], 15, false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(results).toEqual([{ handle: 'handle', tweets: [] }]);
  });

  it('half-open probe after cooldown: success closes and resets', async () => {
    const { fetcher, advance } = makeFetcher();
    await exhaustThreeRequests(fetcher as any);

    advance(5 * 60 * 1000 + 1);
    mockFetch.mockResolvedValue(okLastTweets([]));
    const out = await (fetcher as any).fetchTwitterViaAPI('handle');
    expect(out).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // closed: subsequent requests flow normally
    await (fetcher as any).fetchTwitterViaAPI('handle');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('half-open probe: empty success also closes', async () => {
    const { fetcher, advance } = makeFetcher();
    await exhaustThreeRequests(fetcher as any);

    advance(5 * 60 * 1000 + 1);
    mockFetch.mockResolvedValue(okLastTweets([]));
    await (fetcher as any).fetchTwitterViaAPI('handle');
    // breaker reset: two more transient exhaustions do NOT open (needs 3 fresh)
    mockFetch.mockResolvedValue(httpErrorResponse(500));
    for (let i = 0; i < 2; i++) {
      await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/500/);
    }
    const calls = mockFetch.mock.calls.length;
    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/500/);
    expect(mockFetch.mock.calls.length).toBe(calls + 3);
  });

  it('half-open probe: transient failure reopens for 5m', async () => {
    const { fetcher, advance } = makeFetcher();
    await exhaustThreeRequests(fetcher as any);

    advance(5 * 60 * 1000 + 1);
    mockFetch.mockResolvedValue(httpErrorResponse(500));
    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/500/);
    expect(mockFetch).toHaveBeenCalledTimes(3); // probe retried to cap

    mockFetch.mockClear();
    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/circuit/i);
    expect(mockFetch).not.toHaveBeenCalled();

    // still open just before the new cooldown elapses
    advance(5 * 60 * 1000 - 2);
    await expect((fetcher as any).fetchTwitterViaAPI('handle')).rejects.toThrow(/circuit/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('batch-to-per-handle fallback preserved while closed', async () => {
    const { fetcher } = makeFetcher();
    // advanced_search batch fails non-transient (4xx): per-handle fallback runs and succeeds
    mockFetch
      .mockResolvedValueOnce(httpErrorResponse(400))
      .mockResolvedValueOnce(
        okLastTweets([
          {
            id: 't1',
            text: 'hello',
            url: 'https://twitter.com/somehandle/status/t1',
            createdAt: new Date().toISOString(),
            likeCount: 1,
            retweetCount: 0,
            replyCount: 0,
            viewCount: 10,
            author: { userName: 'somehandle', name: 'Some Handle' },
            isReply: false,
          },
        ])
      );

    const result = await fetcher.fetchSources([twitterSource as any]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.summary.failed).toBe(0);
    // single final source receipt
    const outcomes = result.outcomes.filter((o) => o.source === 'somehandle');
    expect(outcomes).toHaveLength(1);
  });
});

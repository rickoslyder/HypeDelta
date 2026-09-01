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
import { normalizeExternalId } from './external-id';
import {
  classifyPipelineError,
  sanitizePipelineErrorMessage,
  type PipelineErrorClass,
} from './pipeline-error';
import type { SourceFetchAttemptInput } from './pipeline-ledger';
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

// Batched advanced_search settings. Set TWITTER_BATCHED_FETCH=false to fall back to the
// original per-handle last_tweets path without rebuilding the image.
const TWITTER_BATCH_CONFIG = {
  enabled: (process.env.TWITTER_BATCHED_FETCH ?? 'true').toLowerCase() !== 'false',
  handlesPerQuery: Number(process.env.TWITTER_HANDLES_PER_QUERY ?? 10),
  defaultWindowHours: Number(process.env.TWITTER_DEFAULT_WINDOW_HOURS ?? 6),
  maxLookbackHours: Number(process.env.TWITTER_MAX_LOOKBACK_HOURS ?? 48),
  maxPagesPerBatch: Number(process.env.TWITTER_MAX_PAGES_PER_BATCH ?? 5),
};

const TWITTER_ERROR_MAX = 300;

function twitterFetchTimeoutMs(): number {
  const raw = Number(process.env.TWITTER_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15_000;
  return Math.min(30_000, Math.max(5_000, Math.trunc(raw)));
}

function twitterRequestInit(): RequestInit {
  return {
    headers: { 'X-API-Key': TWITTER_API_CONFIG.apiKey },
    signal: AbortSignal.timeout(twitterFetchTimeoutMs()),
  };
}

function boundTwitterError(err: unknown): string {
  const key = TWITTER_API_CONFIG.apiKey;
  let msg = err instanceof Error ? err.message : String(err);
  if (key) msg = msg.split(key).join('[redacted]');
  msg = msg.replace(/\s+/g, ' ').trim();
  if (msg.length > TWITTER_ERROR_MAX) msg = msg.slice(0, TWITTER_ERROR_MAX);
  return msg || 'Twitter fetch failed';
}

async function twitterHttpError(status: number, _response?: Response): Promise<Error> {
  const err = new Error(boundTwitterError(`Twitter API HTTP ${status}`)) as Error & { status: number };
  err.status = status;
  return err;
}

export type SourceFetchKind = 'success-empty' | 'success-items' | 'failure';

export interface SourceFetchOutcome {
  kind: SourceFetchKind;
  source: string;
  sourceId: number;
  persisted: number;
  errorClass?: PipelineErrorClass;
  reason?: string;
}

export interface FetchSourcesSummary {
  successEmpty: number;
  successItems: number;
  failed: number;
  persistedRows: number;
  skippedCircuit: number;
  failuresByClass: Partial<Record<PipelineErrorClass, number>>;
}

export interface FetchSourceFailure {
  source: string;
  error?: string;
  errorClass?: PipelineErrorClass;
  reason?: string;
}

export interface FetchSourcesResult {
  successful: { source: string; count: number }[];
  failed: FetchSourceFailure[];
  outcomes: SourceFetchOutcome[];
  summary: FetchSourcesSummary;
}

export interface FetcherConfig {
  dbUrl: string;
  sourceFetchAttemptStore?: {
    record(input: SourceFetchAttemptInput): Promise<number>;
  };
  // 12C2 injection seams: tests pass a no-op recorder for sleep and a manual clock.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function emptyFetchSummary(): FetchSourcesSummary {
  return {
    successEmpty: 0,
    successItems: 0,
    failed: 0,
    persistedRows: 0,
    skippedCircuit: 0,
    failuresByClass: {},
  };
}

function providerForSource(source: Source): string | null {
  return (source.type as SourceType) === 'twitter' ? 'twitterapi.io' : source.type ?? null;
}

function failureParts(error: unknown): { errorClass: PipelineErrorClass; reason: string } {
  const errorClass = classifyPipelineError(error);
  const reason = sanitizePipelineErrorMessage(boundTwitterError(error));
  return { errorClass, reason: reason || 'fetch failed' };
}

// ============================================================================
// 12C2: twitterapi.io paid-provider retry + circuit breaker
// ============================================================================
//
// One shared helper (twitterPaidFetch) fronts every paid twitterapi.io call:
// advanced_search (batched + monitorTwitter) and last_tweets. Bounded retries
// apply ONLY to transient classes (dns/timeout/rate_limit/http_5xx and explicit
// network/fetch failures); auth, http_4xx, parse, database, missing-key and
// circuit-open failures are never retried. Each request gets at most 3 total
// attempts with 250ms then 500ms backoff (750ms max, via injectable sleep).
//
// Each transient request that exhausts its attempts increments the breaker
// once; at exactly 3 the circuit opens for a 5-minute cooldown (injectable
// clock). While open, no paid fetch is attempted and Nitter fallthrough is
// suppressed; the first request after cooldown is a half-open probe whose
// success (including a valid empty page) closes and resets the breaker, and
// whose transient failure reopens it for another 5 minutes.

const TWITTER_RETRY_CONFIG = {
  maxAttempts: 3,
  backoffMs: [250, 500] as const, // wait before attempt 2 and 3 => 750ms max/request
  breakerOpenThreshold: 3,
  breakerCooldownMs: 5 * 60 * 1000,
};

class TwitterCircuitOpenError extends Error {
  readonly circuitOpen = true;
  constructor(openUntil: number) {
    // Message intentionally names the provider so 12C1 classification lands
    // on 'provider' without any new DB enum value.
    super(`twitterapi.io provider circuit open until ${new Date(openUntil).toISOString()}; paid fetch suppressed`);
    this.name = 'TwitterCircuitOpenError';
  }
}

function isCircuitOpenError(err: unknown): boolean {
  return (
    err instanceof TwitterCircuitOpenError ||
    (typeof err === 'object' && err !== null && (err as { circuitOpen?: unknown }).circuitOpen === true)
  );
}

function isTransientTwitterError(err: unknown): boolean {
  const cls = classifyPipelineError(err);
  if (cls === 'dns' || cls === 'timeout' || cls === 'rate_limit' || cls === 'http_5xx') {
    return true;
  }
  // Explicit provider-transient network/fetch failures from the fetch layer.
  const shape = err as { code?: unknown; message?: unknown; cause?: unknown } | null;
  const code = typeof shape?.code === 'string' ? shape.code.toUpperCase() : '';
  if (/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))$/.test(code)) {
    return true;
  }
  const msg = typeof shape?.message === 'string' ? shape.message.toLowerCase() : '';
  if (err instanceof TypeError && /fetch failed|network ?error|socket|connection (?:reset|refused|closed)/.test(msg)) {
    return true;
  }
  const cause = shape?.cause;
  if (cause != null && cause !== err) return isTransientTwitterError(cause);
  return false;
}

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
  private sourceFetchAttemptStore?: FetcherConfig['sourceFetchAttemptStore'];
  private sleepOverride?: (ms: number) => Promise<void>;
  private nowFn: () => number;
  private twitterBreaker = {
    exhausted: 0,
    openUntil: null as number | null,
    halfOpenInFlight: false,
  };

  constructor(config: FetcherConfig) {
    this.contentStore = new ContentStore(config.dbUrl);
    this.sourceStore = new SourceStore(config.dbUrl);
    this.sourceFetchAttemptStore = config.sourceFetchAttemptStore;
    this.sleepOverride = config.sleep;
    this.nowFn = config.now ?? (() => Date.now());
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
   * Release owned DB pools. CLI one-shots must call this; the long-lived
   * scheduler must not, except on explicit shutdown.
   */
  async close(): Promise<void> {
    await Promise.all([this.contentStore.close(), this.sourceStore.close()]);
  }
  
  /**
   * Fetch content from multiple sources
   */
  async fetchSources(sources: Source[]): Promise<FetchSourcesResult> {
    const successful: { source: string; count: number }[] = [];
    const failed: FetchSourceFailure[] = [];
    const outcomes: SourceFetchOutcome[] = [];
    const summary = emptyFetchSummary();

    // Twitter is fetched up front in ORed, time-windowed batches rather than one
    // last_tweets call per handle -- see fetchTwitterBatched for why (that path re-bought the
    // same ~20 tweets per handle every cycle at 15 credits each). Everything else keeps the
    // original per-source path.
    let twitterBatched: Map<string, RawContent[]> | null = null;
    let twitterBatchFailed: Map<string, unknown> | null = null;
    if (TWITTER_BATCH_CONFIG.enabled) {
      const twitterSources = sources.filter(s => (s.type as SourceType) === 'twitter');
      if (twitterSources.length > 0) {
        const batched = await this.fetchTwitterBatched(twitterSources);
        twitterBatched = batched.content;
        twitterBatchFailed = batched.failed;
      }
    }

    // Group by source type so same-provider fetches stay sequential (respecting
    // each provider's rate limits), while different providers run concurrently.
    const byType = new Map<string, Source[]>();
    for (const source of sources) {
      const group = byType.get(source.type) ?? [];
      group.push(source);
      byType.set(source.type, group);
    }

    await Promise.all(Array.from(byType.values()).map(async (group) => {
      for (const source of group) {
        const startedAt = new Date();
        try {
          if (twitterBatchFailed?.has(source.identifier)) {
            await this.finishSourceFailure(
              source,
              twitterBatchFailed.get(source.identifier),
              startedAt,
              failed,
              outcomes,
              summary,
            );
            continue;
          }

          // Batched results are already in hand for twitter; do not re-fetch (that would
          // re-incur the very cost this exists to avoid).
          const content = (twitterBatched && (source.type as SourceType) === 'twitter')
            ? (twitterBatched.get(source.identifier) ?? [])
            : await this.fetchSource(source);

          // Store content
          let persisted = 0;
          for (const item of content) {
            await this.contentStore.upsert({
              sourceId: source.id!,
              externalId: normalizeExternalId(
                (item.id ?? '').trim() || `${source.identifier}_${item.publishedAt.getTime()}`,
              ),
              url: item.url,
              title: item.title,
              contentText: item.content,
              contentType: item.sourceType,
              author: item.author,
              publishedAt: item.publishedAt,
              metadata: item.metadata
            });
            persisted += 1;
          }

          // Mark source as fetched only after persist succeeds (including valid-empty).
          await this.sourceStore.markFetched(source.id!);

          const kind: SourceFetchKind = content.length === 0 ? 'success-empty' : 'success-items';
          if (kind === 'success-empty') summary.successEmpty += 1;
          else summary.successItems += 1;
          summary.persistedRows += persisted;
          outcomes.push({
            kind,
            source: source.identifier,
            sourceId: source.id!,
            persisted,
          });
          successful.push({ source: source.identifier, count: content.length });
          await this.recordSourceAttempt({
            sourceId: source.id!,
            sourceType: source.type,
            provider: providerForSource(source),
            startedAt,
            finishedAt: new Date(),
            ok: true,
            itemCount: persisted,
          });

          // Rate limit between same-provider sources. Skipped for twitter when the batch
          // already ran -- there is no per-source request left to pace.
          if (!(twitterBatched && (source.type as SourceType) === 'twitter')) {
            await this.sleep(1000);
          }

        } catch (error) {
          await this.finishSourceFailure(
            source,
            error,
            startedAt,
            failed,
            outcomes,
            summary,
          );
        }
      }
    }));

    return { successful, failed, outcomes, summary };
  }

  private async recordSourceAttempt(input: SourceFetchAttemptInput): Promise<void> {
    if (!this.sourceFetchAttemptStore) return;
    try {
      await this.sourceFetchAttemptStore.record(input);
    } catch {
      // Ledger rejection must not retry, add a second outcome, or undo markFetched.
      console.error('Fetch attempt ledger write failed');
    }
  }

  private async finishSourceFailure(
    source: Source,
    error: unknown,
    startedAt: Date,
    failed: FetchSourceFailure[],
    outcomes: SourceFetchOutcome[],
    summary: FetchSourcesSummary,
  ): Promise<void> {
    const { errorClass, reason } = failureParts(error);
    summary.failed += 1;
    if (isCircuitOpenError(error)) {
      // 12C2: a source whose FINAL failure is the paid-provider circuit being
      // open is counted exactly once here — never for retry attempts (those do
      // not reach this path) and never for unrelated failure classes.
      summary.skippedCircuit += 1;
    }
    summary.failuresByClass[errorClass] = (summary.failuresByClass[errorClass] ?? 0) + 1;
    outcomes.push({
      kind: 'failure',
      source: source.identifier,
      sourceId: source.id!,
      persisted: 0,
      errorClass,
      reason,
    });
    if (this.sourceFetchAttemptStore) {
      failed.push({ source: source.identifier, errorClass, reason });
    } else {
      failed.push({ source: source.identifier, error: reason });
    }
    await this.recordSourceAttempt({
      sourceId: source.id!,
      sourceType: source.type,
      provider: providerForSource(source),
      startedAt,
      finishedAt: new Date(),
      ok: false,
      itemCount: 0,
      error,
    });
  }

  
  /**
   * Batched, time-windowed Twitter fetch.
   *
   * WHY THIS EXISTS (2026-08-01). The per-source path calls /twitter/user/last_tweets, which
   * always returns the newest ~20 tweets for one handle and has NO time or since_id filter --
   * TwitterAPI.io's own docs say "if you only need to fetch the latest tweets from a single
   * user very frequently, do not use this API, it will cost you a lot". Billing is 15 credits
   * per tweet RETURNED, so a 4-hourly cycle over 76 handles bought ~1,086 tweets (16,290
   * credits) six times a day -- ~97,700/day -- to surface about 28 genuinely new items. The
   * rest were the same tweets, re-bought every cycle.
   *
   * /twitter/tweet/advanced_search accepts unix-precision since_time/until_time and ORed
   * from: operators, and bills only the tweets it actually returns (measured: 225 credits for
   * 15 tweets across 8 handles = exactly 15/tweet, with no per-call surcharge). So one query
   * per batch over the window since each source was last fetched costs only what is new.
   *
   * Correctness notes:
   *  - The window start is the OLDEST last_fetched in the batch, so a source that lagged
   *    behind cannot have its tweets skipped by a batch-mate that is up to date.
   *  - It is clamped to MAX_LOOKBACK_HOURS so a long outage cannot trigger an unbounded
   *    (and expensive) backfill.
   *  - Storage upsert is keyed on external id, so an overlapping window re-stores nothing.
   *  - Any batch that errors falls back to the original per-handle path, so this degrades
   *    to the old behaviour rather than losing sources.
   */
  private async fetchTwitterBatched(
    sources: Source[]
  ): Promise<{ content: Map<string, RawContent[]>; failed: Map<string, unknown> }> {
    const out = new Map<string, RawContent[]>();
    const failed = new Map<string, unknown>();
    for (const s of sources) out.set(s.identifier, []);
    if (!TWITTER_API_CONFIG.apiKey) {
      for (const s of sources) failed.set(s.identifier, 'TWITTER_API_KEY is not configured');
      return { content: out, failed };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const maxLookbackSec = TWITTER_BATCH_CONFIG.maxLookbackHours * 3600;
    const byHandle = new Map<string, Source>();
    for (const s of sources) byHandle.set(s.identifier.toLowerCase(), s);

    // Chunk handles so each ORed query stays within a conservative length budget.
    const batches: Source[][] = [];
    for (let i = 0; i < sources.length; i += TWITTER_BATCH_CONFIG.handlesPerQuery) {
      batches.push(sources.slice(i, i + TWITTER_BATCH_CONFIG.handlesPerQuery));
    }

    for (const batch of batches) {
      // Oldest watermark in the batch -- never skip a lagging source.
      let sinceSec = nowSec - TWITTER_BATCH_CONFIG.defaultWindowHours * 3600;
      for (const s of batch) {
        if (s.lastFetched) {
          const t = Math.floor(new Date(s.lastFetched).getTime() / 1000);
          if (t < sinceSec) sinceSec = t;
        } else {
          sinceSec = nowSec - TWITTER_BATCH_CONFIG.defaultWindowHours * 3600;
          break;
        }
      }
      if (nowSec - sinceSec > maxLookbackSec) sinceSec = nowSec - maxLookbackSec;

      const froms = batch.map(s => `from:${s.identifier}`).join(' OR ');
      const query = `(${froms}) since_time:${sinceSec} until_time:${nowSec}`;

      try {
        let cursor = '';
        let pages = 0;
        while (pages < TWITTER_BATCH_CONFIG.maxPagesPerBatch) {
          const since = this.nowFn() - lastTwitterApiCall;
          if (since < TWITTER_API_CONFIG.rateLimitMs) {
            await this.sleep(TWITTER_API_CONFIG.rateLimitMs - since);
          }
          lastTwitterApiCall = this.nowFn();

          const url = `${TWITTER_API_CONFIG.baseUrl}/twitter/tweet/advanced_search`
            + `?query=${encodeURIComponent(query)}&queryType=Latest`
            + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
          const response = await this.twitterPaidFetch(url);

          const data = await response.json() as {
            tweets?: Array<{
              id: string; text: string; url?: string; createdAt: string;
              likeCount?: number; retweetCount?: number; replyCount?: number; viewCount?: number;
              author?: { userName?: string; name?: string };
              isReply?: boolean; quoted_tweet?: object; retweeted_tweet?: object;
            }>;
            has_next_page?: boolean;
            next_cursor?: string | null;
          };

          for (const tweet of data.tweets ?? []) {
            if (tweet.isReply) continue; // same signal filter as the per-handle path
            const uname = (tweet.author?.userName || '').toLowerCase();
            const src = byHandle.get(uname);
            if (!src) continue; // defensive: search can return adjacent accounts
            out.get(src.identifier)!.push({
              id: tweet.id,
              source: `twitter:${src.identifier}`,
              sourceType: 'twitter' as SourceType,
              author: src.authorName || tweet.author?.name || src.identifier,
              content: tweet.text,
              url: tweet.url || `https://twitter.com/${src.identifier}/status/${tweet.id}`,
              publishedAt: new Date(tweet.createdAt),
              metadata: {
                likeCount: tweet.likeCount,
                retweetCount: tweet.retweetCount,
                replyCount: tweet.replyCount,
                viewCount: tweet.viewCount,
                isRetweet: !!tweet.retweeted_tweet,
                isQuote: !!tweet.quoted_tweet,
                provider: 'twitterapi.io',
                fetchMode: 'advanced_search_batched'
              }
            });
          }

          pages++;
          if (!data.has_next_page || !data.next_cursor) break;
          cursor = data.next_cursor;
        }
      } catch (e) {
        if (isCircuitOpenError(e)) {
          // 12C2: circuit open — zero paid calls happened; every handle in this
          // batch (and the remaining batches) is a circuit-skip, NOT a per-handle
          // fallback (that would issue paid calls and/or Nitter fallthrough).
          for (const s of batch) failed.set(s.identifier, e);
          continue;
        }
        // Degrade to the original per-handle path for this batch only.
        console.warn(`Batched Twitter fetch failed (${batch.length} handles): ${boundTwitterError(e)}; falling back per-handle`);
        for (const s of batch) {
          try {
            out.set(s.identifier, await this.fetchTwitter(s.identifier, s.authorName));
          } catch (inner) {
            const msg = boundTwitterError(inner);
            console.warn(`Per-handle fallback failed for ${s.identifier}: ${msg}`);
            failed.set(s.identifier, inner);
          }
        }
      }
    }

    return { content: out, failed };
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
    let apiError: unknown;
    if (TWITTER_API_CONFIG.apiKey) {
      try {
        return await this.fetchTwitterViaAPI(handle, authorName);
      } catch (e) {
        if (isCircuitOpenError(e)) {
          // 12C2: paid circuit open means zero paid calls AND no Nitter fallthrough.
          throw e;
        }
        apiError = e;
        console.warn(`TwitterAPI.io failed for ${handle}: ${boundTwitterError(e)}`);
        // Fall through to Nitter fallback
      }
    }

    // Fallback: Nitter (mostly non-functional as of 2025)
    try {
      return await this.fetchTwitterViaNitter(handle, authorName);
    } catch {
      if (apiError !== undefined) throw apiError;
      throw new Error(`All Twitter fetch methods failed for ${handle}`);
    }
  }

  private async fetchTwitterViaAPI(handle: string, authorName?: string): Promise<RawContent[]> {
    // Rate limiting for TwitterAPI.io (free tier: 1 req/5s)
    const now = this.nowFn();
    const timeSinceLastCall = now - lastTwitterApiCall;
    if (timeSinceLastCall < TWITTER_API_CONFIG.rateLimitMs) {
      await this.sleep(TWITTER_API_CONFIG.rateLimitMs - timeSinceLastCall);
    }
    lastTwitterApiCall = this.nowFn();

    const response = await this.twitterPaidFetch(
      `${TWITTER_API_CONFIG.baseUrl}/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`
    );

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
      throw new Error(boundTwitterError(`TwitterAPI.io error: ${JSON.stringify(data)}`));
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
      const timeSinceLastCall = this.nowFn() - lastTwitterApiCall;
      if (timeSinceLastCall < TWITTER_API_CONFIG.rateLimitMs) {
        await this.sleep(TWITTER_API_CONFIG.rateLimitMs - timeSinceLastCall);
      }
      lastTwitterApiCall = this.nowFn();

      try {
        // Build advanced search query: from:handle since:date until:date
        const query = `from:${handle} since:${sinceStr} until:${untilStr}`;

        const response = await this.twitterPaidFetch(
          `${TWITTER_API_CONFIG.baseUrl}/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`
        );

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
                externalId: normalizeExternalId(
                  (tweet.id ?? '').trim() || `${handle}_${tweet.publishedAt.getTime()}`,
                ),
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
    if (this.sleepOverride) return this.sleepOverride(ms);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shared paid-provider request for twitterapi.io (12C2). Bounded transient
   * retry (3 attempts max, 250/500ms backoff) plus the paid-provider circuit
   * breaker. Throws TwitterCircuitOpenError without any fetch call while open.
   */
  private async twitterPaidFetch(url: string): Promise<Response> {
    if (this.twitterBreaker.openUntil !== null) {
      const now = this.nowFn();
      if (now < this.twitterBreaker.openUntil || this.twitterBreaker.halfOpenInFlight) {
        throw new TwitterCircuitOpenError(this.twitterBreaker.openUntil);
      }
      // Cooldown elapsed: this request is the single half-open probe.
      this.twitterBreaker.halfOpenInFlight = true;
    }
    try {
      let lastErr: unknown;
      for (let attempt = 0; attempt < TWITTER_RETRY_CONFIG.maxAttempts; attempt++) {
        if (attempt > 0) {
          await this.sleep(TWITTER_RETRY_CONFIG.backoffMs[attempt - 1]);
        }
        try {
          const response = await fetch(url, twitterRequestInit());
          if (!response.ok) {
            throw await twitterHttpError(response.status, response);
          }
          // Success (including a valid empty payload): close and reset.
          this.twitterBreaker.exhausted = 0;
          this.twitterBreaker.openUntil = null;
          return response;
        } catch (err) {
          lastErr = err;
          if (!isTransientTwitterError(err)) throw err;
        }
      }
      // Transient attempts exhausted: one breaker increment per request.
      this.twitterBreaker.exhausted += 1;
      if (
        this.twitterBreaker.exhausted >= TWITTER_RETRY_CONFIG.breakerOpenThreshold ||
        this.twitterBreaker.halfOpenInFlight
      ) {
        this.twitterBreaker.openUntil = this.nowFn() + TWITTER_RETRY_CONFIG.breakerCooldownMs;
      }
      throw lastErr;
    } finally {
      this.twitterBreaker.halfOpenInFlight = false;
    }
  }
}

// ============================================================================
// SOURCE SEEDER
// ============================================================================

function seedActivation(source: object): { isActive?: boolean } {
  if ('isActive' in source) {
    return { isActive: (source as { isActive?: boolean }).isActive };
  }
  return {};
}

export async function seedSources(dbUrl: string): Promise<void> {
  const store = new SourceStore(dbUrl);
  let count = 0;
  try {

  // Twitter sources
  for (const source of sourcesData.twitter) {
    await store.upsert({
      type: 'twitter',
      identifier: source.handle,
      authorName: source.name,
      category: source.category as ContentCategory,
      fetchFrequencyHours: source.priority === 'high' ? 4 : 6,
      ...seedActivation(source),
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
      fetchFrequencyHours: source.tier === 1 ? 6 : 12,
      ...seedActivation(source),
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
      fetchFrequencyHours: 24,
      ...seedActivation(source),
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
      fetchFrequencyHours: 24,
      ...seedActivation(source),
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
      fetchFrequencyHours: 12,
      ...seedActivation(source),
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
      fetchFrequencyHours: 24,
      ...seedActivation(source),
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
      fetchFrequencyHours: 6,
      ...seedActivation(source),
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
      fetchFrequencyHours: 48,
      ...seedActivation(source),
    });
    count++;
  }

  console.log(`Sources seeded successfully: ${count} sources added`);
  } finally {
    await store.close();
  }
}

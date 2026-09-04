#!/usr/bin/env node
/**
 * AI Intelligence Scheduler
 *
 * Runs the fetch → process → synthesize pipeline on a schedule.
 * Can be run as a background service or via cron.
 *
 * Import is side-effect free: the worker only starts when this file is the
 * process entrypoint (see isMainModule guard at bottom).
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AIIntelOrchestrator } from './index';
import { AIIntelFetcher } from './fetcher';
import { SourceStore, ContentStore, initializeDatabase } from './storage';
import {
  startHeartbeat,
  type HeartbeatHandle,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from './worker-heartbeat';
import { classifyPipelineError, sanitizeJsonbPayload } from './pipeline-error';
import {
  PipelineRunStore,
  SourceFetchAttemptStore,
  type PipelineRunRecordInput,
  type SourceFetchAttemptInput,
} from './pipeline-ledger';
import { createProductionModelRuntime, productionModelEnv } from './model-runtime';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 500;
const MAX_LOOKBACK_DAYS = 365;
/** Bound only ledger record/close — task fn execution stays unbounded. */
export const DEFAULT_LEDGER_RECORD_TIMEOUT_MS = 5_000;

export interface ProcessingConfig {
  lookbackDays: number;
  batchLimit: number;
}

/**
 * Conservative validated env configuration for processing selection.
 * Malformed / zero / negative values fall back to defaults; excessive values clamp.
 */
export function resolveProcessingConfig(
  env: NodeJS.ProcessEnv = process.env
): ProcessingConfig {
  const lookbackDays = parseBoundedInt(
    env.PROCESS_LOOKBACK_DAYS,
    DEFAULT_LOOKBACK_DAYS,
    1,
    MAX_LOOKBACK_DAYS
  );
  const batchLimit = parseBoundedInt(
    env.PROCESS_BATCH_LIMIT,
    DEFAULT_BATCH_LIMIT,
    1,
    MAX_BATCH_LIMIT
  );
  return { lookbackDays, batchLimit };
}

/**
 * Initial fetch/process on start.
 * Absent env → legacy default (run initial cycle).
 * Exactly "false" → skip both initial fetch and initial process.
 */
export function shouldRunInitialCycle(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.WORKER_RUN_INITIAL_CYCLE !== 'false';
}

/**
 * Next future Sunday 09:00 local. Same calendar Sunday only when `now` is
 * strictly before 09:00; at or after 09:00 on Sunday, returns seven days later.
 */
export function nextSundayDigestAt(now: Date = new Date()): Date {
  const next = new Date(now.getTime());
  const day = next.getDay();
  next.setHours(9, 0, 0, 0);
  const daysUntilSunday = (7 - day) % 7;
  if (daysUntilSunday === 0) {
    if (now.getTime() >= next.getTime()) {
      next.setDate(next.getDate() + 7);
    }
  } else {
    next.setDate(next.getDate() + daysUntilSunday);
  }
  return next;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return fallback;
  if (i > max) return max;
  return i;
}

const baseConfig = {
  projectDir: process.env.PROJECT_DIR || process.cwd(),
  dbUrl: process.env.DATABASE_URL || 'postgresql://localhost/ai_intel',
  embeddingProvider: (process.env.EMBEDDING_PROVIDER || 'ollama') as 'ollama' | 'openai' | 'voyage',
};

// Schedule configuration (in milliseconds)
const SCHEDULES = {
  // High-frequency sources (Twitter) - every 4 hours
  twitter: 4 * 60 * 60 * 1000,

  // Medium-frequency (Substacks, YouTube) - every 6 hours
  substacks: 6 * 60 * 60 * 1000,
  youtube: 6 * 60 * 60 * 1000,

  // Low-frequency (Blogs, Podcasts) - every 12 hours
  blogs: 12 * 60 * 60 * 1000,
  podcasts: 12 * 60 * 60 * 1000,

  // Processing - every 2 hours
  processing: 2 * 60 * 60 * 1000,

  // Synthesis - daily at midnight
  synthesis: 24 * 60 * 60 * 1000,

  // Weekly digest - every Sunday
  weeklyDigest: 7 * 24 * 60 * 60 * 1000
};

export interface SchedulerDeps {
  orchestrator?: AIIntelOrchestrator;
  fetcher?: AIIntelFetcher;
  sourceStore?: SourceStore;
  contentStore?: ContentStore;
  /** When false (default for constructed instances in tests), start() is not auto-invoked. */
  autoStart?: boolean;
  processingConfig?: ProcessingConfig;
  setIntervalFn?: typeof setInterval;
  setTimeoutFn?: typeof setTimeout;
  clearIntervalFn?: typeof clearInterval;
  clearTimeoutFn?: typeof clearTimeout;
  /** Override heartbeat file path (tests / non-container runs). */
  heartbeatPath?: string;
  /** Override heartbeat refresh interval. */
  heartbeatIntervalMs?: number;
  /** Override initial-cycle decision (defaults to shouldRunInitialCycle()). */
  runInitialCycle?: boolean;
  /**
   * Injected pipeline_runs writer. Never constructed in the class constructor
   * (avoids a real pg Pool in unit tests). Production entrypoint injects one.
   */
  pipelineRunStore?: {
    record(input: PipelineRunRecordInput): Promise<unknown>;
    close?: () => Promise<void>;
  };
  /**
   * Injected source_fetch_attempts writer. Production entrypoint constructs one
   * and passes it into the default fetcher. Never constructed in this class.
   */
  sourceFetchAttemptStore?: {
    record(input: SourceFetchAttemptInput): Promise<number>;
    close?: () => Promise<void>;
  };
  /**
   * Injected model_attempts writer. Production entrypoint constructs one
   * PostgresModelAttemptStore and injects it here and into the orchestrator.
   */
  modelAttemptStore?: {
    record?(input: unknown): Promise<number>;
    close?: () => Promise<void>;
  };
  /** Bound for pipelineRunStore.record and optional store.close (task fn stays unbounded). */
  ledgerTimeoutMs?: number;
  /** Injected process exit (tests); production defaults to process.exit. */
  exitFn?: (code?: number) => void;
  /** Injected clock for receipts / duration_ms. */
  now?: () => Date;
  /** Override weekly-digest write directory (tests inject a temp path). */
  digestDir?: string;
}

// ============================================================================
// SCHEDULER CLASS
// ============================================================================

export interface SchedulerTaskResult {
  ok: boolean;
  counts: Record<string, unknown>;
  error?: unknown;
}

function isSchedulerTaskResult(value: unknown): value is SchedulerTaskResult {
  if (value == null || typeof value !== 'object') return false;
  const rec = value as { ok?: unknown; counts?: unknown };
  return typeof rec.ok === 'boolean' && rec.counts != null && typeof rec.counts === 'object';
}

type FetchFailureLike = { errorClass?: string };

type FetchResultLike = {
  successful: unknown[];
  failed: FetchFailureLike[];
  summary?: {
    successEmpty: number;
    successItems: number;
    failed: number;
    persistedRows: number;
    failuresByClass: Record<string, number>;
    skippedCircuit: number;
  };
};

function representativeClassifiedError(errorClass: string | undefined): unknown {
  switch (errorClass) {
    case 'dns':
      return { code: 'ENOTFOUND' };
    case 'timeout':
      return { code: 'ETIMEDOUT' };
    case 'rate_limit':
      return { status: 429 };
    case 'auth':
      return { status: 401 };
    case 'http_4xx':
      return { status: 400 };
    case 'http_5xx':
      return { status: 500 };
    case 'parse':
      return { name: 'SyntaxError', message: 'invalid json' };
    case 'database':
      return { message: 'database' };
    case 'provider':
      return { message: 'provider' };
    case 'internal':
      return new Error('internal');
    default:
      return { message: errorClass || 'unknown' };
  }
}

function toFetchTaskResult(results: FetchResultLike): SchedulerTaskResult {
  const fetched = results.successful.length;
  const failed = results.failed.length;
  const summary = results.summary;
  const counts: Record<string, unknown> = {
    fetched,
    failed,
    persistedRows: summary?.persistedRows ?? 0,
    successEmpty: summary?.successEmpty ?? 0,
    successItems: summary?.successItems ?? 0,
    skippedCircuit: summary?.skippedCircuit ?? 0,
    failuresByClass: summary?.failuresByClass ?? {},
  };
  const ok = failed === 0 || fetched > 0;
  return {
    ok,
    counts,
    error: ok ? undefined : representativeClassifiedError(results.failed[0]?.errorClass),
  };
}

export class AIIntelScheduler {
  private orchestrator: AIIntelOrchestrator;
  private fetcher: AIIntelFetcher;
  private sourceStore: SourceStore;
  private contentStore: ContentStore;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;
  private inFlight: Set<string> = new Set();
  private processingConfig: ProcessingConfig;
  private setIntervalFn: typeof setInterval;
  private setTimeoutFn: typeof setTimeout;
  private clearIntervalFn: typeof clearInterval;
  private clearTimeoutFn: typeof clearTimeout;
  private heartbeatPath?: string;
  private heartbeatIntervalMs: number;
  private runInitialCycle: boolean;
  private heartbeat: HeartbeatHandle | null = null;
  private pipelineRunStore?: {
    record(input: PipelineRunRecordInput): Promise<unknown>;
    close?: () => Promise<void>;
  };
  private sourceFetchAttemptStore?: {
    record(input: SourceFetchAttemptInput): Promise<number>;
    close?: () => Promise<void>;
  };
  private modelAttemptStore?: {
    record?(input: unknown): Promise<number>;
    close?: () => Promise<void>;
  };
  private ledgerTimeoutMs: number;
  private exitFn: (code?: number) => void;
  private stopPromise: Promise<void> | null = null;
  private now: () => Date;
  private digestDir: string;

  constructor(deps: SchedulerDeps = {}) {
    this.orchestrator = deps.orchestrator ?? new AIIntelOrchestrator(baseConfig);
    this.fetcher = deps.fetcher ?? new AIIntelFetcher({
      ...baseConfig,
      sourceFetchAttemptStore: deps.sourceFetchAttemptStore,
    });
    this.sourceStore = deps.sourceStore ?? new SourceStore(baseConfig.dbUrl);
    this.contentStore = deps.contentStore ?? new ContentStore(baseConfig.dbUrl);
    this.processingConfig = deps.processingConfig ?? resolveProcessingConfig();
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    this.heartbeatPath = deps.heartbeatPath;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.runInitialCycle =
      deps.runInitialCycle ?? shouldRunInitialCycle();
    this.pipelineRunStore = deps.pipelineRunStore;
    this.sourceFetchAttemptStore = deps.sourceFetchAttemptStore;
    this.modelAttemptStore = deps.modelAttemptStore;
    this.ledgerTimeoutMs = deps.ledgerTimeoutMs ?? DEFAULT_LEDGER_RECORD_TIMEOUT_MS;
    this.exitFn = deps.exitFn ?? ((code?: number) => {
      process.exit(code ?? 0);
    });
    this.now = deps.now ?? (() => new Date());
    this.digestDir = deps.digestDir ?? 'data/digests';
  }

  async start(): Promise<void> {
    console.log('🚀 AI Intelligence Scheduler starting...');

    const startedAt = this.now();
    // Immediate starting heartbeat before any initial work (incl. initialize / fetch).
    this.heartbeat = startHeartbeat({
      path: this.heartbeatPath,
      intervalMs: this.heartbeatIntervalMs,
      setIntervalFn: this.setIntervalFn,
      clearIntervalFn: this.clearIntervalFn,
      now: this.now,
    });

    try {
      // Bootstrap + versioned migrations before any store query.
      await initializeDatabase(baseConfig.dbUrl);

      // Initialize orchestrator (creates skills/agents)
      await this.orchestrator.initialize();
    } catch (err) {
      this.heartbeat.markFailed(classifyPipelineError(err));
      await this.recordPipelineRun({
        taskName: 'startup',
        startedAt,
        finishedAt: this.now(),
        ok: false,
        error: err,
      });
      throw err;
    }

    this.heartbeat.markRunning();
    this.running = true;

    // Schedule all tasks
    this.scheduleFetch('twitter', SCHEDULES.twitter);
    this.scheduleFetch('substack', SCHEDULES.substacks);
    this.scheduleFetch('youtube', SCHEDULES.youtube);
    this.scheduleFetch('blog', SCHEDULES.blogs);
    this.scheduleFetch('podcast', SCHEDULES.podcasts);
    this.scheduleProcessing();
    this.scheduleSynthesis();
    this.scheduleWeeklyDigest();

    if (this.runInitialCycle) {
      // Run initial fetch and process (errors isolated — keep worker alive)
      console.log('📥 Running initial fetch cycle...');
      await this.runTask('fetch-all', () => this.runAllFetches());

      console.log('⚙️  Running initial processing...');
      await this.runTask('processing', () => this.runProcessing());
    } else {
      console.log(
        'Skipping initial fetch/process (WORKER_RUN_INITIAL_CYCLE=false)',
      );
    }

    console.log('✅ Scheduler running. Press Ctrl+C to stop.');

    // Handle shutdown gracefully
    process.on('SIGINT', () => {
      void this.stop();
    });
    process.on('SIGTERM', () => {
      void this.stop();
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    console.log('\n🛑 Stopping scheduler...');
    this.running = false;

    if (this.heartbeat) {
      this.heartbeat.stop();
      this.heartbeat = null;
    }

    for (const [name, timer] of this.timers) {
      // Timeouts and intervals both live in `timers`; clear with the matching API.
      if (name.endsWith('-initial') || name.includes('timeout')) {
        this.clearTimeoutFn(timer);
      } else {
        this.clearIntervalFn(timer);
      }
      console.log(`  ⏹  Stopped: ${name}`);
    }
    this.timers.clear();

    await Promise.all([
      this.safeCloseStore(this.pipelineRunStore),
      this.safeCloseStore(this.sourceFetchAttemptStore),
      this.safeCloseStore(this.modelAttemptStore),
    ]);
    this.exitFn(0);
  }

  private async safeCloseStore(store?: { close?: () => Promise<void> }): Promise<void> {
    if (store && typeof store.close === 'function') {
      try {
        // Bound wait only — does not cancel the underlying close/PG promise.
        await this.withLedgerTimeout(store.close());
      } catch {
        console.error('Scheduler store close failed');
      }
    }
  }

  // ============================================================================
  // TASK GUARD — overlap skip + generic error isolation
  // ============================================================================

  /**
   * Run a named scheduled task with single-flight protection and bounded errors.
   * A second tick while the same name is in flight is skipped (not queued).
   * Failures log a generic message (no env/prompt/content/token leakage) and
   * do not kill the worker. Every executed run records exactly one pipeline_runs
   * receipt and emits one bounded completion JSON line.
   */
  async runTask(
    name: string,
    fn: () => Promise<SchedulerTaskResult | Record<string, unknown> | void>,
  ): Promise<void> {
    if (this.inFlight.has(name)) {
      console.log(`  ⏭  Skipping ${name}: previous run still in flight`);
      return;
    }

    this.inFlight.add(name);
    const startedAt = this.now();
    let ok = true;
    let error: unknown;
    let counts: Record<string, unknown> = {};
    try {
      const result = await fn();
      if (isSchedulerTaskResult(result)) {
        ok = result.ok;
        counts = result.counts;
        error = result.error;
      } else if (result && typeof result === 'object') {
        counts = result;
      }
      if (ok) {
        this.heartbeat?.recordSuccess(name);
      } else {
        this.heartbeat?.recordFailure(name, classifyPipelineError(error));
        console.error(`Scheduler task failed: ${name}`);
      }
    } catch (err) {
      ok = false;
      error = err;
      this.heartbeat?.recordFailure(name, classifyPipelineError(err));
      // Generic bounded error — never echo raw exception text (may contain
      // secrets, prompts, content bodies, DB URLs, tokens).
      console.error(`Scheduler task failed: ${name}`);
    } finally {
      this.inFlight.delete(name);
    }
    const finishedAt = this.now();
    this.emitCompletionLine(name, ok, error, startedAt, finishedAt, counts);
    await this.recordPipelineRun({
      taskName: name,
      startedAt,
      finishedAt,
      ok,
      error: ok ? undefined : error,
      counts,
    });
  }

  /**
   * Bound wait for ledger record/close. Does not cancel the underlying
   * Postgres promise; late settle is ignored after timeout. Timeout handles
   * are not added to `this.timers`.
   */
  private withLedgerTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        reject(new Error('ledger timeout'));
      }, this.ledgerTimeoutMs);
      promise.then(
        (value) => {
          this.clearTimeoutFn(timer);
          resolve(value);
        },
        (err: unknown) => {
          this.clearTimeoutFn(timer);
          reject(err);
        },
      );
    });
  }

  private async recordPipelineRun(input: PipelineRunRecordInput): Promise<void> {
    if (!this.pipelineRunStore) return;
    try {
      await this.withLedgerTimeout(this.pipelineRunStore.record(input));
    } catch {
      console.error('Scheduler ledger write failed');
    }
  }

  private emitCompletionLine(
    task: string,
    ok: boolean,
    error: unknown,
    startedAt: Date,
    finishedAt: Date,
    counts: Record<string, unknown>,
  ): void {
    const payload = {
      task,
      ok,
      error_class: ok ? null : classifyPipelineError(error),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      counts: sanitizeJsonbPayload(counts),
    };
    console.log(JSON.stringify(payload));
  }

  // ============================================================================
  // SCHEDULED TASKS
  // ============================================================================

  private scheduleFetch(sourceType: string, interval: number): void {
    const timer = this.setIntervalFn(() => {
      if (!this.running) return;
      void this.runTask(`fetch-${sourceType}`, () => this.runFetch(sourceType));
    }, interval);

    this.timers.set(`fetch-${sourceType}`, timer);
    console.log(`  📅 Scheduled: ${sourceType} fetch every ${interval / 1000 / 60} minutes`);
  }

  private scheduleProcessing(): void {
    const timer = this.setIntervalFn(() => {
      if (!this.running) return;
      void this.runTask('processing', () => this.runProcessing());
    }, SCHEDULES.processing);

    this.timers.set('processing', timer);
    console.log(`  📅 Scheduled: processing every ${SCHEDULES.processing / 1000 / 60} minutes`);
  }

  private scheduleSynthesis(): void {
    const timer = this.setIntervalFn(() => {
      if (!this.running) return;
      void this.runTask('synthesis', () => this.runSynthesis());
    }, SCHEDULES.synthesis);

    this.timers.set('synthesis', timer);
    console.log(`  📅 Scheduled: synthesis every ${SCHEDULES.synthesis / 1000 / 60 / 60} hours`);
  }

  private scheduleWeeklyDigest(): void {
    const now = new Date();
    const nextSunday = nextSundayDigestAt(now);
    const msUntilNextSunday = nextSunday.getTime() - now.getTime();

    // Retain the initial timeout handle so stop() can clear it before first fire.
    const initialTimeout = this.setTimeoutFn(() => {
      // Drop the one-shot handle once it has fired.
      this.timers.delete('weekly-digest-initial');

      // Install the recurring interval regardless of the first-run outcome.
      // Previously the interval was only set after await runWeeklyDigest(), so a
      // rejected first Sunday left the worker with no later weekly ticks.
      if (!this.timers.has('weekly-digest')) {
        const timer = this.setIntervalFn(() => {
          if (!this.running) return;
          void this.runTask('weekly-digest', () => this.runWeeklyDigest());
        }, SCHEDULES.weeklyDigest);
        this.timers.set('weekly-digest', timer);
      }

      if (!this.running) return;
      void this.runTask('weekly-digest', () => this.runWeeklyDigest());
    }, msUntilNextSunday);

    this.timers.set('weekly-digest-initial', initialTimeout);

    console.log(`  📅 Scheduled: weekly digest (next: ${nextSunday.toISOString()})`);
  }

  // ============================================================================
  // TASK IMPLEMENTATIONS
  // ============================================================================

  private async runAllFetches(): Promise<SchedulerTaskResult> {
    const sources = await this.sourceStore.getDueForFetch();
    console.log(`📡 Fetching ${sources.length} due sources...`);

    const results = await this.fetcher.fetchSources(sources);

    console.log(`  ✓ Fetched: ${results.successful.length}`);
    if (results.failed.length > 0) {
      // Bounded counts + safe source id only — never raw provider/network error
      // strings (may embed URLs, tokens, or response bodies).
      console.log(`  ✗ Failed: ${results.failed.length}`);
      for (const f of results.failed) {
        const sourceId = typeof f.source === 'string' ? f.source : String((f as { source?: unknown }).source ?? 'unknown');
        // Strip anything that looks like a URL/query from the identifier itself.
        const safeSource = sourceId.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 80);
        console.log(`    - ${safeSource}`);
      }
    }
    return toFetchTaskResult(results);
  }

  private async runFetch(sourceType: string): Promise<SchedulerTaskResult> {
    console.log(`📡 [${new Date().toISOString()}] Fetching ${sourceType}...`);

    const sources = await this.sourceStore.getByType(sourceType);
    const results = await this.fetcher.fetchSources(sources);

    console.log(`  ✓ ${sourceType}: ${results.successful.length} fetched, ${results.failed.length} failed`);
    return toFetchTaskResult(results);
  }

  private async runProcessing(): Promise<Record<string, number>> {
    console.log(`⚙️  [${new Date().toISOString()}] Processing content...`);

    const { lookbackDays, batchLimit } = this.processingConfig;
    const content = await this.contentStore.getUnprocessed(lookbackDays, batchLimit);

    if (content.length === 0) {
      console.log('  ℹ️  No new content to process');
      return { processed: 0, relevant: 0, claimsExtracted: 0 };
    }

    const result = await this.orchestrator.processBatch(content as any);

    console.log(`  ✓ Processed: ${result.processed}, Relevant: ${result.relevant}, Claims: ${result.claimsExtracted}`);
    return {
      processed: result.processed,
      relevant: result.relevant,
      claimsExtracted: result.claimsExtracted,
    };
  }

  private async runSynthesis(): Promise<Record<string, number>> {
    console.log(`🔬 [${new Date().toISOString()}] Running synthesis...`);

    const result = await this.orchestrator.runSynthesis({
      lookbackDays: 7,
      generateDigest: false
    });

    console.log(`  ✓ Synthesized ${result.syntheses.length} topics`);
    return { topics: result.syntheses.length };
  }

  private async runWeeklyDigest(): Promise<Record<string, unknown>> {
    console.log(`📝 [${new Date().toISOString()}] Generating weekly digest...`);

    const result = await this.orchestrator.runSynthesis({
      lookbackDays: 7,
      generateDigest: true
    });

    if (result.digest) {
      // Save digest to file (injectable dir so tests never write into the repo)
      const fs = await import('fs/promises');
      const weekNumber = getWeekNumber(new Date());
      const filename = join(
        this.digestDir,
        `${new Date().getFullYear()}-W${weekNumber}.md`,
      );
      const digestContent =
        typeof result.digest === 'string'
          ? result.digest
          : JSON.stringify(result.digest);

      await fs.mkdir(this.digestDir, { recursive: true });
      await fs.writeFile(filename, digestContent);

      console.log(`  ✓ Digest saved to ${filename}`);
    }
    return {
      topics: result.syntheses.length,
      digestWritten: Boolean(result.digest),
    };
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

// ============================================================================
// RUN (entrypoint only — import is side-effect free)
// ============================================================================

if (isMainModule()) {
  const runtime = createProductionModelRuntime({
    env: productionModelEnv(process.env),
    dbUrl: baseConfig.dbUrl,
  });
  const attemptStore = new SourceFetchAttemptStore(baseConfig.dbUrl);
  const scheduler = new AIIntelScheduler({
    orchestrator: new AIIntelOrchestrator({
      ...baseConfig,
      agent: runtime.agent,
      modelAttemptStore: runtime.store,
    }),
    pipelineRunStore: new PipelineRunStore(baseConfig.dbUrl),
    sourceFetchAttemptStore: attemptStore,
    modelAttemptStore: runtime.store,
  });
  scheduler.start().catch(err => {
    console.error('Fatal error during scheduler startup');
    // Startup/init failure remains fatal; still avoid dumping raw secrets.
    if (err instanceof Error && err.stack) {
      // Keep stack frames only (no message that might embed config).
      const frames = err.stack.split('\n').slice(1, 8).join('\n');
      if (frames) console.error(frames);
    }
    process.exit(1);
  });
}

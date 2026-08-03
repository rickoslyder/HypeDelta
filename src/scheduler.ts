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
import { AIIntelOrchestrator } from './index';
import { AIIntelFetcher } from './fetcher';
import { SourceStore, ContentStore } from './storage';
import {
  startHeartbeat,
  type HeartbeatHandle,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from './worker-heartbeat';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 500;
const MAX_LOOKBACK_DAYS = 365;

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
  useSkills: process.env.USE_SKILLS !== 'false',
  glmFallback: process.env.GLM_FALLBACK === 'true'
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
}

// ============================================================================
// SCHEDULER CLASS
// ============================================================================

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

  constructor(deps: SchedulerDeps = {}) {
    this.orchestrator = deps.orchestrator ?? new AIIntelOrchestrator(baseConfig);
    this.fetcher = deps.fetcher ?? new AIIntelFetcher(baseConfig);
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
  }

  async start(): Promise<void> {
    console.log('🚀 AI Intelligence Scheduler starting...');

    // Immediate heartbeat before any initial work (incl. initialize / fetch).
    this.heartbeat = startHeartbeat({
      path: this.heartbeatPath,
      intervalMs: this.heartbeatIntervalMs,
      setIntervalFn: this.setIntervalFn,
      clearIntervalFn: this.clearIntervalFn,
    });

    // Initialize orchestrator (creates skills/agents)
    await this.orchestrator.initialize();

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
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  stop(): void {
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

    process.exit(0);
  }

  // ============================================================================
  // TASK GUARD — overlap skip + generic error isolation
  // ============================================================================

  /**
   * Run a named scheduled task with single-flight protection and bounded errors.
   * A second tick while the same name is in flight is skipped (not queued).
   * Failures log a generic message (no env/prompt/content/token leakage) and
   * do not kill the worker.
   */
  async runTask(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(name)) {
      console.log(`  ⏭  Skipping ${name}: previous run still in flight`);
      return;
    }

    this.inFlight.add(name);
    try {
      await fn();
    } catch {
      // Generic bounded error — never echo raw exception text (may contain
      // secrets, prompts, content bodies, DB URLs, tokens).
      console.error(`Scheduler task failed: ${name}`);
    } finally {
      this.inFlight.delete(name);
    }
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
    // Calculate time until next Sunday midnight
    const now = new Date();
    const daysUntilSunday = (7 - now.getDay()) % 7;
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + daysUntilSunday);
    nextSunday.setHours(9, 0, 0, 0); // 9 AM Sunday

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

  private async runAllFetches(): Promise<void> {
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
  }

  private async runFetch(sourceType: string): Promise<void> {
    console.log(`📡 [${new Date().toISOString()}] Fetching ${sourceType}...`);

    const sources = await this.sourceStore.getByType(sourceType);
    const results = await this.fetcher.fetchSources(sources);

    console.log(`  ✓ ${sourceType}: ${results.successful.length} fetched, ${results.failed.length} failed`);
  }

  private async runProcessing(): Promise<void> {
    console.log(`⚙️  [${new Date().toISOString()}] Processing content...`);

    const { lookbackDays, batchLimit } = this.processingConfig;
    const content = await this.contentStore.getUnprocessed(lookbackDays, batchLimit);

    if (content.length === 0) {
      console.log('  ℹ️  No new content to process');
      return;
    }

    const result = await this.orchestrator.processBatch(content as any);

    console.log(`  ✓ Processed: ${result.processed}, Relevant: ${result.relevant}, Claims: ${result.claimsExtracted}`);
  }

  private async runSynthesis(): Promise<void> {
    console.log(`🔬 [${new Date().toISOString()}] Running synthesis...`);

    const result = await this.orchestrator.runSynthesis({
      lookbackDays: 7,
      generateDigest: false
    });

    console.log(`  ✓ Synthesized ${result.syntheses.length} topics`);
  }

  private async runWeeklyDigest(): Promise<void> {
    console.log(`📝 [${new Date().toISOString()}] Generating weekly digest...`);

    const result = await this.orchestrator.runSynthesis({
      lookbackDays: 7,
      generateDigest: true
    });

    if (result.digest) {
      // Save digest to file
      const fs = await import('fs/promises');
      const weekNumber = getWeekNumber(new Date());
      const filename = `data/digests/${new Date().getFullYear()}-W${weekNumber}.md`;
      const digestContent = result.digest;

      await fs.mkdir('data/digests', { recursive: true });
      await fs.writeFile(filename, digestContent);

      console.log(`  ✓ Digest saved to ${filename}`);
    }
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
  const scheduler = new AIIntelScheduler();
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

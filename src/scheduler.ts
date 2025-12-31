#!/usr/bin/env node
/**
 * AI Intelligence Scheduler
 * 
 * Runs the fetch → process → synthesize pipeline on a schedule.
 * Can be run as a background service or via cron.
 */

import { AIIntelOrchestrator } from './index';
import { AIIntelFetcher } from './fetcher';
import { SourceStore, ContentStore } from './storage';

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
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

// ============================================================================
// SCHEDULER CLASS
// ============================================================================

class AIIntelScheduler {
  private orchestrator: AIIntelOrchestrator;
  private fetcher: AIIntelFetcher;
  private sourceStore: SourceStore;
  private contentStore: ContentStore;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;
  
  constructor() {
    this.orchestrator = new AIIntelOrchestrator(config);
    this.fetcher = new AIIntelFetcher(config);
    this.sourceStore = new SourceStore(config.dbUrl);
    this.contentStore = new ContentStore(config.dbUrl);
  }
  
  async start(): Promise<void> {
    console.log('🚀 AI Intelligence Scheduler starting...');
    
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
    
    // Run initial fetch and process
    console.log('📥 Running initial fetch cycle...');
    await this.runAllFetches();
    
    console.log('⚙️  Running initial processing...');
    await this.runProcessing();
    
    console.log('✅ Scheduler running. Press Ctrl+C to stop.');
    
    // Handle shutdown gracefully
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }
  
  stop(): void {
    console.log('\n🛑 Stopping scheduler...');
    this.running = false;
    
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      console.log(`  ⏹  Stopped: ${name}`);
    }
    
    process.exit(0);
  }
  
  // ============================================================================
  // SCHEDULED TASKS
  // ============================================================================
  
  private scheduleFetch(sourceType: string, interval: number): void {
    const timer = setInterval(async () => {
      if (!this.running) return;
      await this.runFetch(sourceType);
    }, interval);
    
    this.timers.set(`fetch-${sourceType}`, timer);
    console.log(`  📅 Scheduled: ${sourceType} fetch every ${interval / 1000 / 60} minutes`);
  }
  
  private scheduleProcessing(): void {
    const timer = setInterval(async () => {
      if (!this.running) return;
      await this.runProcessing();
    }, SCHEDULES.processing);
    
    this.timers.set('processing', timer);
    console.log(`  📅 Scheduled: processing every ${SCHEDULES.processing / 1000 / 60} minutes`);
  }
  
  private scheduleSynthesis(): void {
    const timer = setInterval(async () => {
      if (!this.running) return;
      await this.runSynthesis();
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
    
    // Run first digest at next Sunday, then weekly
    setTimeout(async () => {
      await this.runWeeklyDigest();
      
      const timer = setInterval(async () => {
        if (!this.running) return;
        await this.runWeeklyDigest();
      }, SCHEDULES.weeklyDigest);
      
      this.timers.set('weekly-digest', timer);
    }, msUntilNextSunday);
    
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
      console.log(`  ✗ Failed: ${results.failed.length}`);
      results.failed.forEach(f => console.log(`    - ${f.source}: ${f.error}`));
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
    
    // Get content from last processing window
    const content = await this.contentStore.getRecent(1);
    
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

// ============================================================================
// RUN
// ============================================================================

const scheduler = new AIIntelScheduler();
scheduler.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

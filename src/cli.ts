#!/usr/bin/env node
/**
 * AI Intelligence CLI
 * 
 * Commands:
 *   fetch [source]     - Fetch content from sources
 *   process            - Process pending content through extraction pipeline
 *   synthesize         - Run synthesis and generate digest
 *   query <topic>      - Query claims by topic
 *   status             - Show system status
 *   init               - Initialize database
 */

import { Command } from 'commander';
import { AIIntelOrchestrator } from './index';
import { initializeDatabase, SourceStore, ContentStore, ClaimStore, SynthesisStore, PredictionTracker } from './storage';
import { AIIntelFetcher } from './fetcher';
import type { SynthesisOptions, ClaimQuery, Topic } from './types';

// ============================================================================
// CLI SETUP
// ============================================================================

const program = new Command();

program
  .name('ai-intel')
  .description('AI Research Intelligence Aggregation System')
  .version('0.1.0');

// Load config
const config = {
  projectDir: process.env.PROJECT_DIR || process.cwd(),
  dbUrl: process.env.DATABASE_URL || 'postgresql://localhost/ai_intel',
  embeddingProvider: (process.env.EMBEDDING_PROVIDER || 'ollama') as 'ollama' | 'openai' | 'voyage',
  useSkills: process.env.USE_SKILLS !== 'false',
  glmFallback: process.env.GLM_FALLBACK === 'true'
};

// ============================================================================
// COMMANDS
// ============================================================================

program
  .command('init')
  .description('Initialize database schema')
  .action(async () => {
    console.log('Initializing database...');
    await initializeDatabase(config.dbUrl);
    console.log('✓ Database initialized');
  });

program
  .command('fetch')
  .description('Fetch content from sources')
  .option('-s, --source <type>', 'Specific source type to fetch')
  .option('-a, --all', 'Fetch from all sources')
  .option('--due', 'Only fetch sources due for update')
  .action(async (options) => {
    const fetcher = new AIIntelFetcher(config);
    const sourceStore = new SourceStore(config.dbUrl);
    
    let sources;
    if (options.due) {
      sources = await sourceStore.getDueForFetch();
      console.log(`Found ${sources.length} sources due for fetch`);
    } else if (options.source) {
      sources = await sourceStore.getByType(options.source);
      console.log(`Fetching ${sources.length} ${options.source} sources`);
    } else {
      sources = await sourceStore.getActive();
      console.log(`Fetching all ${sources.length} active sources`);
    }
    
    const results = await fetcher.fetchSources(sources);
    
    console.log('\n📊 Fetch Results:');
    console.log(`  ✓ Fetched: ${results.successful.length}`);
    console.log(`  ✗ Failed: ${results.failed.length}`);
    
    if (results.failed.length > 0) {
      console.log('\n❌ Failures:');
      results.failed.forEach(f => {
        console.log(`  - ${f.source}: ${f.error}`);
      });
    }
  });

program
  .command('process')
  .description('Process pending content through extraction pipeline')
  .option('-d, --days <number>', 'Process content from last N days', '1')
  .option('-l, --limit <number>', 'Limit number of items to process', '100')
  .action(async (options) => {
    const orchestrator = new AIIntelOrchestrator(config);
    const contentStore = new ContentStore(config.dbUrl);
    
    console.log(`Processing content from last ${options.days} days...`);
    
    // Get unprocessed content
    const content = await contentStore.getRecent(parseInt(options.days));
    const toProcess = content.slice(0, parseInt(options.limit));
    
    console.log(`Found ${content.length} items, processing ${toProcess.length}`);
    
    const startTime = Date.now();
    const result = await orchestrator.processBatch(toProcess as any);
    const elapsed = Date.now() - startTime;
    
    console.log('\n📊 Processing Results:');
    console.log(`  📥 Processed: ${result.processed}`);
    console.log(`  ✓ Relevant: ${result.relevant}`);
    console.log(`  📝 Claims extracted: ${result.claimsExtracted}`);
    console.log(`  ⏱  Time: ${(elapsed / 1000).toFixed(1)}s`);
  });

program
  .command('synthesize')
  .description('Run synthesis and generate digest')
  .option('-d, --days <number>', 'Lookback days', '7')
  .option('-t, --topics <topics...>', 'Specific topics to synthesize')
  .option('--no-digest', 'Skip digest generation')
  .option('-o, --output <file>', 'Output digest to file')
  .action(async (options) => {
    const orchestrator = new AIIntelOrchestrator(config);
    
    const synthOptions: SynthesisOptions = {
      lookbackDays: parseInt(options.days),
      topics: options.topics as Topic[] || null,
      generateDigest: options.digest
    };
    
    console.log(`Running synthesis (${options.days} day lookback)...`);
    const startTime = Date.now();
    
    const result = await orchestrator.runSynthesis(synthOptions);
    const elapsed = Date.now() - startTime;
    
    console.log('\n📊 Synthesis Results:');
    console.log(`  📈 Topics analyzed: ${result.syntheses.length}`);
    console.log(`  ⏱  Time: ${(elapsed / 1000).toFixed(1)}s`);
    
    // Show hype assessment summary
    console.log('\n🔥 Hype Assessment:');
    console.log(`  Overall field sentiment: ${(result.hypeAssessment.overallFieldSentiment * 100).toFixed(0)}% bullish`);
    
    if (result.hypeAssessment.overhypedTopics.length > 0) {
      console.log('\n  ⬆️  Overhyped:');
      result.hypeAssessment.overhypedTopics.forEach(t => {
        console.log(`    - ${t.topic} (${(t.score * 100).toFixed(0)}%): ${t.reasoning.slice(0, 60)}...`);
      });
    }
    
    if (result.hypeAssessment.underhypedTopics.length > 0) {
      console.log('\n  ⬇️  Underhyped:');
      result.hypeAssessment.underhypedTopics.forEach(t => {
        console.log(`    - ${t.topic} (${(Math.abs(t.score) * 100).toFixed(0)}%): ${t.reasoning.slice(0, 60)}...`);
      });
    }
    
    // Output digest
    if (result.digest) {
      const digestContent = result.digest;
      if (options.output) {
        const fs = await import('fs/promises');
        await fs.writeFile(options.output, digestContent);
        console.log(`\n📄 Digest written to ${options.output}`);
      } else {
        console.log('\n' + '='.repeat(80));
        console.log(digestContent);
        console.log('='.repeat(80));
      }
    }
  });

program
  .command('query')
  .description('Query claims')
  .argument('[topic]', 'Topic to query')
  .option('-a, --author <name>', 'Filter by author')
  .option('-c, --category <cat>', 'Filter by author category')
  .option('-t, --type <type>', 'Filter by claim type')
  .option('-d, --days <number>', 'Lookback days', '30')
  .option('-l, --limit <number>', 'Max results', '20')
  .option('--json', 'Output as JSON')
  .action(async (topic, options) => {
    const claimStore = new ClaimStore(config.dbUrl);
    
    let claims;
    if (topic) {
      claims = await claimStore.getByTopic(topic, parseInt(options.days));
    } else if (options.category) {
      claims = await claimStore.getByAuthorCategory(options.category, parseInt(options.days));
    } else {
      claims = await claimStore.getRecent(parseInt(options.days));
    }
    
    // Apply additional filters
    if (options.author) {
      claims = claims.filter(c => c.author?.toLowerCase().includes(options.author.toLowerCase()));
    }
    if (options.type) {
      claims = claims.filter(c => c.claimType === options.type);
    }
    
    claims = claims.slice(0, parseInt(options.limit));
    
    if (options.json) {
      console.log(JSON.stringify(claims, null, 2));
    } else {
      console.log(`\n📝 Found ${claims.length} claims:\n`);
      claims.forEach((c, i) => {
        const stanceEmoji = c.stance === 'bullish' ? '📈' : c.stance === 'bearish' ? '📉' : '➡️';
        console.log(`${i + 1}. [${c.topic}] ${stanceEmoji} ${c.author || 'Unknown'}`);
        console.log(`   "${c.claimText.slice(0, 100)}${c.claimText.length > 100 ? '...' : ''}"`);
        console.log(`   Type: ${c.claimType} | Confidence: ${(c.confidence * 100).toFixed(0)}% | Bullishness: ${(c.bullishness * 100).toFixed(0)}%`);
        console.log();
      });
    }
  });

program
  .command('status')
  .description('Show system status')
  .action(async () => {
    const sourceStore = new SourceStore(config.dbUrl);
    const contentStore = new ContentStore(config.dbUrl);
    const claimStore = new ClaimStore(config.dbUrl);
    const synthesisStore = new SynthesisStore(config.dbUrl);
    const predictionTracker = new PredictionTracker(config.dbUrl);
    
    const sources = await sourceStore.getActive();
    const dueForFetch = await sourceStore.getDueForFetch();
    const recentContent = await contentStore.getRecent(7);
    const recentClaims = await claimStore.getRecent(7);
    const latestSynthesis = await synthesisStore.getLatest();
    const predictionStats = await predictionTracker.getAccuracyStats();
    
    console.log('\n📊 AI Intelligence System Status\n');
    
    console.log('📡 Sources:');
    console.log(`  Active: ${sources.length}`);
    console.log(`  Due for fetch: ${dueForFetch.length}`);
    
    // Group by type
    const byType = sources.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`    - ${type}: ${count}`);
    });
    
    console.log('\n📄 Content (last 7 days):');
    console.log(`  Total items: ${recentContent.length}`);
    
    console.log('\n📝 Claims (last 7 days):');
    console.log(`  Total claims: ${recentClaims.length}`);
    
    // Group by topic
    const byTopic = recentClaims.reduce((acc, c) => {
      acc[c.topic] = (acc[c.topic] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topTopics = Object.entries(byTopic)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    console.log('  Top topics:');
    topTopics.forEach(([topic, count]) => {
      console.log(`    - ${topic}: ${count}`);
    });
    
    console.log('\n🔮 Predictions:');
    console.log(`  Total tracked: ${predictionStats.total}`);
    console.log(`  Verified: ${predictionStats.verified}`);
    console.log(`  Falsified: ${predictionStats.falsified}`);
    console.log(`  Pending: ${predictionStats.pending}`);
    if (predictionStats.averageAccuracy > 0) {
      console.log(`  Average accuracy: ${(predictionStats.averageAccuracy * 100).toFixed(1)}%`);
    }
    
    console.log('\n📊 Last Synthesis:');
    if (latestSynthesis) {
      console.log(`  Generated: ${latestSynthesis.generatedAt}`);
      console.log(`  Lookback: ${latestSynthesis.lookbackDays} days`);
    } else {
      console.log('  No synthesis run yet');
    }
  });

program
  .command('predictions')
  .description('Manage prediction tracking')
  .option('-l, --list', 'List pending predictions')
  .option('-a, --author <name>', 'Filter by author')
  .option('-s, --stats', 'Show prediction statistics')
  .option('--verify <id>', 'Mark prediction as verified')
  .option('--falsify <id>', 'Mark prediction as falsified')
  .action(async (options) => {
    const tracker = new PredictionTracker(config.dbUrl);
    
    if (options.stats) {
      const stats = options.author 
        ? await tracker.getAccuracyStats(options.author)
        : await tracker.getAccuracyStats();
      
      console.log('\n🔮 Prediction Statistics:');
      console.log(`  Total: ${stats.total}`);
      console.log(`  ✓ Verified: ${stats.verified}`);
      console.log(`  ✗ Falsified: ${stats.falsified}`);
      console.log(`  ~ Partially verified: ${stats.partiallyVerified}`);
      console.log(`  ⏳ Pending: ${stats.pending}`);
      if (stats.averageAccuracy > 0) {
        console.log(`  📈 Average accuracy: ${(stats.averageAccuracy * 100).toFixed(1)}%`);
      }
      return;
    }
    
    if (options.verify) {
      await tracker.updateStatus(options.verify, 'verified', 1.0);
      console.log(`✓ Marked prediction ${options.verify} as verified`);
      return;
    }
    
    if (options.falsify) {
      await tracker.updateStatus(options.falsify, 'falsified', 0.0);
      console.log(`✗ Marked prediction ${options.falsify} as falsified`);
      return;
    }
    
    // List predictions
    const predictions = options.author
      ? await tracker.getByAuthor(options.author)
      : await tracker.getPending();
    
    console.log(`\n🔮 ${options.author ? `Predictions by ${options.author}` : 'Pending Predictions'}:\n`);
    
    predictions.slice(0, 20).forEach((p, i) => {
      const statusEmoji = {
        'verified': '✓',
        'falsified': '✗',
        'partially-verified': '~',
        'too-early': '⏳',
        'unfalsifiable': '?',
        'ambiguous': '?'
      }[p.status || 'too-early'] || '⏳';
      
      console.log(`${i + 1}. ${statusEmoji} [${p.topic}] ${p.author}`);
      console.log(`   "${p.text.slice(0, 80)}${p.text.length > 80 ? '...' : ''}"`);
      console.log(`   Made: ${p.madeAt.toISOString().split('T')[0]} | Timeframe: ${p.timeframe} | Confidence: ${(p.confidence * 100).toFixed(0)}%`);
      console.log();
    });
  });

program
  .command('digest')
  .description('Generate or retrieve digest')
  .option('-l, --latest', 'Show latest digest')
  .option('-g, --generate', 'Generate new digest')
  .option('-d, --days <number>', 'Lookback days for new digest', '7')
  .option('-o, --output <file>', 'Output to file')
  .action(async (options) => {
    const synthesisStore = new SynthesisStore(config.dbUrl);
    
    let digest;
    
    if (options.generate) {
      const orchestrator = new AIIntelOrchestrator(config);
      console.log('Generating digest...');
      const result = await orchestrator.runSynthesis({
        lookbackDays: parseInt(options.days),
        generateDigest: true
      });
      digest = result.digest;
    } else {
      const latest = await synthesisStore.getLatest();
      digest = latest?.digest;
    }
    
    if (!digest) {
      console.log('No digest available. Run with --generate to create one.');
      return;
    }

    // Handle both string (from runSynthesis) and object (from storage JSON)
    const digestContent = typeof digest === 'string' ? digest : digest.markdown || digest;

    if (options.output) {
      const fs = await import('fs/promises');
      await fs.writeFile(options.output, digestContent);
      console.log(`Digest written to ${options.output}`);
    } else {
      console.log(digestContent);
    }
  });

// ============================================================================
// RUN
// ============================================================================

program.parse();

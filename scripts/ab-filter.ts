/**
 * A/B harness: agent (Agent SDK) vs direct (GLM + zod) filter strategies.
 *
 * Runs BOTH filter code paths on the SAME items and reports agreement, drop-rate
 * and latency, plus the disagreements to spot-check. Assessments are captured
 * index-aligned (before the relevance drop) so the two strategies compare fairly.
 *
 * Usage:
 *   pnpm run ab:filter                       # uses data/ab-sample.json
 *   pnpm run ab:filter -- --fixture path.json
 *   pnpm run ab:filter -- --db --days 7 --limit 100
 *
 * Requires (per side):
 *   - agent:  CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)
 *   - direct: GLM_API_KEY (+ optional GLM_BASE_URL)
 * If a side's credentials are missing it is skipped and the other still runs.
 */

import { readFileSync } from 'fs';
import { AIIntelAgent, GLMClient } from '../src/agent-sdk-wrapper';
import { FILTER_PROMPT } from '../src/prompts';
import { FilterResponseSchema, type FilterAssessment } from '../src/schemas';
import { ContentStore } from '../src/storage';

interface Item {
  source: string;
  sourceType: string;
  author: string;
  content: string;
  publishedAt: string | Date;
  url?: string;
}

interface Args {
  fixture: string;
  db: boolean;
  days: number;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def?: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    fixture: get('--fixture', 'data/ab-sample.json')!,
    db: argv.includes('--db'),
    days: parseInt(get('--days', '7')!, 10),
    limit: parseInt(get('--limit', '50')!, 10),
  };
}

async function loadItems(args: Args): Promise<Item[]> {
  if (args.db) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('--db requires DATABASE_URL');
    const store = new ContentStore(dbUrl);
    const rows = await store.getRecent(args.days);
    return rows.slice(0, args.limit).map((r: any) => ({
      source: r.source_type || r.source || 'unknown',
      sourceType: r.source_type || 'unknown',
      author: r.author || r.author_name || 'unknown',
      content: r.content_text || r.content || '',
      publishedAt: r.published_at || new Date(),
      url: r.url,
    }));
  }
  const items = JSON.parse(readFileSync(args.fixture, 'utf-8')) as Item[];
  return items.slice(0, args.limit);
}

const BATCH = 20;

async function runAgent(items: Item[]): Promise<(FilterAssessment | null)[]> {
  const agent = new AIIntelAgent({ projectDir: process.cwd() });
  const out: (FilterAssessment | null)[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const result = await agent.filterContent(batch);
    const assessments = (result?.assessments ?? []) as FilterAssessment[];
    batch.forEach((_, idx) => out.push(assessments[idx] ?? null));
  }
  return out;
}

async function runDirect(items: Item[]): Promise<(FilterAssessment | null)[]> {
  const glm = new GLMClient();
  const out: (FilterAssessment | null)[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const response = await glm.complete({
      messages: [{ role: 'user', content: FILTER_PROMPT(batch as any) }],
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
    });
    const parsed = FilterResponseSchema.parse(JSON.parse(response.content));
    batch.forEach((_, idx) => out.push(parsed.assessments[idx] ?? null));
  }
  return out;
}

const RELEVANCE_THRESHOLD = 0.3;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

function dropRate(assessments: (FilterAssessment | null)[]): number {
  const dropped = assessments.filter(a => !a || a.relevance < RELEVANCE_THRESHOLD).length;
  return dropped / assessments.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const items = await loadItems(args);
  console.log(`Loaded ${items.length} items (${args.db ? 'db' : args.fixture})\n`);

  const hasAgent = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  const hasDirect = !!(process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.ANTHROPIC_API_KEY);

  let agent: { value: (FilterAssessment | null)[]; ms: number } | null = null;
  let direct: { value: (FilterAssessment | null)[]; ms: number } | null = null;

  if (hasAgent) {
    try { agent = await timed(() => runAgent(items)); }
    catch (e) { console.warn(`agent strategy failed: ${e instanceof Error ? e.message : e}`); }
  } else {
    console.warn('agent strategy skipped (no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)');
  }

  if (hasDirect) {
    try { direct = await timed(() => runDirect(items)); }
    catch (e) { console.warn(`direct strategy failed: ${e instanceof Error ? e.message : e}`); }
  } else {
    console.warn('direct strategy skipped (no GLM_API_KEY)');
  }

  console.log('\n=== Per-strategy summary ===');
  if (agent) console.log(`agent : ${agent.ms} ms, drop-rate ${(dropRate(agent.value) * 100).toFixed(0)}%`);
  if (direct) console.log(`direct: ${direct.ms} ms, drop-rate ${(dropRate(direct.value) * 100).toFixed(0)}%`);

  if (!agent || !direct) {
    console.log('\nNeed both strategies for an agreement comparison. Provide both sides\' credentials.');
    return;
  }

  let relAbsSum = 0, both = 0, topicMatch = 0, catMatch = 0, typeMatch = 0;
  const disagreements: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const a = agent.value[i], d = direct.value[i];
    if (!a || !d) continue;
    both++;
    relAbsSum += Math.abs(a.relevance - d.relevance);
    if (a.topic === d.topic) topicMatch++;
    if (a.authorCategory === d.authorCategory) catMatch++;
    if (a.contentType === d.contentType) typeMatch++;
    if (Math.abs(a.relevance - d.relevance) > 0.3 || a.topic !== d.topic) {
      disagreements.push(
        `  [${i}] ${items[i].author}: rel ${a.relevance.toFixed(2)}/${d.relevance.toFixed(2)}  ` +
        `topic ${a.topic}/${d.topic}  cat ${a.authorCategory}/${d.authorCategory}`
      );
    }
  }

  const pct = (n: number) => `${((n / both) * 100).toFixed(0)}%`;
  console.log('\n=== Agreement (agent vs direct) ===');
  console.log(`items compared:        ${both}/${items.length}`);
  console.log(`relevance mean |Δ|:    ${(relAbsSum / both).toFixed(3)}`);
  console.log(`topic agreement:       ${pct(topicMatch)}`);
  console.log(`authorCategory agree:  ${pct(catMatch)}`);
  console.log(`contentType agreement: ${pct(typeMatch)}`);
  console.log(`speedup (agent/direct):${(agent.ms / direct.ms).toFixed(1)}x`);

  if (disagreements.length) {
    console.log('\n=== Disagreements to spot-check (agent/direct) ===');
    console.log(disagreements.join('\n'));
  }
}

main().catch(err => { console.error(err); process.exit(1); });

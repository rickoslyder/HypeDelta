/**
 * Operator-controlled historical quote recovery.
 *
 * Dry-run is the default. A provider-backed run requires --execute AND a
 * positive --limit of unique content items (hard max 100). Per content, at
 * most 20 missing-quote claims are sent to the model.
 *
 * Quotes are admitted only as exact nonblank substrings of stored content_text
 * (same policy as new-claim admission). Never fabricates quotes, never creates
 * claims, never overwrites a nonblank original_quote.
 */
import pg from 'pg';
import { STAGE_PROMPT_VERSIONS } from './pipeline-model-agent';
import type { CompleteRequest, CompleteResult, Stage } from './model-routing';

export const QUOTE_BACKFILL_HARD_MAX_CONTENT = 100;
export const QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX = 20;
export const QUOTE_RECOVERY_CONTENT_LIMIT = 8000;

export type QuoteBackfillAttemptResult =
  | 'updated'
  | 'no-match'
  | 'rejected'
  | 'error'
  | 'skipped-race';

export interface QuoteRecoveryClaim {
  claimId: string;
  claimText: string;
}

export interface QuoteRecoveryInput {
  contentId: number;
  contentText: string;
  claims: QuoteRecoveryClaim[];
}

export interface QuoteRecoveryMapping {
  claimId: string;
  originalQuote: string;
}

export interface QuoteRecoverer {
  recoverQuotesJson(input: QuoteRecoveryInput): Promise<string>;
}

export interface QuoteBackfillQueryResult {
  rows: unknown[];
  rowCount?: number;
}

export interface QuoteBackfillClient {
  query: (sql: string, params?: unknown[]) => Promise<QuoteBackfillQueryResult>;
  release: () => void;
}

export interface QuoteBackfillDb {
  query: (sql: string, params?: unknown[]) => Promise<QuoteBackfillQueryResult>;
  connect: () => Promise<QuoteBackfillClient>;
}

export interface QuoteBackfillSummary {
  dryRun: boolean;
  selectedContent: number;
  candidateClaims: number;
  providerCallsAttempted: number;
  updated: number;
  noMatch: number;
  rejected: number;
  errors: number;
  skippedRace: number;
  candidateIds: string[];
  contentIds: number[];
}

export interface QuoteBackfillRunOptions {
  db: QuoteBackfillDb;
  recoverer: QuoteRecoverer;
  limit?: unknown;
  execute?: boolean;
  retryFailed?: boolean;
  runId?: string;
}

interface CandidateRow {
  claim_id: string;
  content_id: number;
  claim_text: string;
  content_text: string;
}

const SELECT_CANDIDATES_SQL = `
WITH ranked AS (
  SELECT
    c.id AS claim_id,
    c.content_id,
    c.claim_text,
    ct.content_text,
    ROW_NUMBER() OVER (PARTITION BY c.content_id ORDER BY c.id ASC) AS claim_rn,
    DENSE_RANK() OVER (ORDER BY c.content_id ASC) AS content_rn
  FROM extracted_claims c
  JOIN content ct ON ct.id = c.content_id
  WHERE NULLIF(btrim(c.original_quote), '') IS NULL
    AND NULLIF(btrim(ct.content_text), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM quote_backfill_attempts a
      WHERE a.claim_id = c.id AND a.result = 'updated'
    )
    AND (
      $1::boolean
      OR NOT EXISTS (
        SELECT 1 FROM quote_backfill_attempts a
        WHERE a.claim_id = c.id AND a.result IN ('no-match', 'rejected', 'error')
      )
    )
)
SELECT claim_id, content_id, claim_text, content_text
FROM ranked
WHERE claim_rn <= $2
  AND content_rn <= $3
ORDER BY content_id ASC, claim_id ASC
`.trim();

const UPDATE_QUOTE_SQL = `
UPDATE extracted_claims
SET original_quote = $1
WHERE id = $2
  AND NULLIF(btrim(original_quote), '') IS NULL
RETURNING id
`.trim();

const INSERT_ATTEMPT_SQL = `
INSERT INTO quote_backfill_attempts (
  claim_id, content_id, run_id, attempted_at, result, reason
) VALUES ($1, $2, $3, NOW(), $4, $5)
`.trim();

export function parseQuoteBackfillLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(
      `limit is required (unique content items, 1..${QUOTE_BACKFILL_HARD_MAX_CONTENT})`,
    );
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > QUOTE_BACKFILL_HARD_MAX_CONTENT) {
    throw new Error(
      `limit must be an integer 1..${QUOTE_BACKFILL_HARD_MAX_CONTENT} (unique content items)`,
    );
  }
  return n;
}

export function buildQuoteRecoveryPrompt(input: QuoteRecoveryInput): string {
  const bounded = input.contentText.slice(0, QUOTE_RECOVERY_CONTENT_LIMIT);
  const claims = input.claims.map((c) => ({
    claimId: c.claimId,
    claimText: c.claimText,
  }));
  return `You recover exact source quotes for existing claims. Return ONLY JSON.

Source content (contentId=${input.contentId}):
${bounded}

Existing claims (map only these ids):
${JSON.stringify(claims)}

Task: for each supplied claim, if a defensible exact quote exists, return a mapping.
JSON schema: {"mappings": [{"claimId": string, "originalQuote": string}]}.

Rules:
- originalQuote must be an exact, non-blank, verbatim, contiguous span copied from the source content above.
- Do not reword, invent, or summarize. Do not invent claims. Map only the supplied claim ids.
- If no defensible span exists for a claim, omit it (no mapping).
- Return ONLY valid JSON, no markdown.`;
}

export function parseQuoteRecoveryMappings(
  raw: string,
): { ok: true; mappings: QuoteRecoveryMapping[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        parsed = JSON.parse(fenced[1].trim());
      } catch {
        return { ok: false, reason: 'malformed-json' };
      }
    } else {
      return { ok: false, reason: 'malformed-json' };
    }
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { mappings?: unknown }).mappings)
      ? (parsed as { mappings: unknown[] }).mappings
      : null;
  if (!list) {
    return { ok: false, reason: 'malformed-json' };
  }

  const mappings: QuoteRecoveryMapping[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      return { ok: false, reason: 'malformed-json' };
    }
    const rec = item as { claimId?: unknown; originalQuote?: unknown };
    if (typeof rec.claimId !== 'string' || typeof rec.originalQuote !== 'string') {
      return { ok: false, reason: 'malformed-json' };
    }
    mappings.push({ claimId: rec.claimId, originalQuote: rec.originalQuote });
  }
  return { ok: true, mappings };
}

export function sanitizeAttemptReason(reason: string): string {
  const stripped = reason
    .replace(/postgresql:\/\/\S+/gi, '[redacted]')
    .replace(/postgres:\/\/\S+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/secret=\S+/gi, 'secret=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 200);
}

function emptySummary(dryRun: boolean): QuoteBackfillSummary {
  return {
    dryRun,
    selectedContent: 0,
    candidateClaims: 0,
    providerCallsAttempted: 0,
    updated: 0,
    noMatch: 0,
    rejected: 0,
    errors: 0,
    skippedRace: 0,
    candidateIds: [],
    contentIds: [],
  };
}

function asCandidateRows(rows: unknown[]): CandidateRow[] {
  const out: CandidateRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const claimId = String(r.claim_id ?? '');
    const contentId = Number(r.content_id);
    const claimText = String(r.claim_text ?? '');
    const contentText = String(r.content_text ?? '');
    if (!claimId || !Number.isFinite(contentId)) continue;
    out.push({
      claim_id: claimId,
      content_id: contentId,
      claim_text: claimText,
      content_text: contentText,
    });
  }
  return out;
}

function groupByContent(rows: CandidateRow[]): Map<number, CandidateRow[]> {
  const grouped = new Map<number, CandidateRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.content_id) ?? [];
    if (list.length < QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX) {
      list.push(row);
      grouped.set(row.content_id, list);
    }
  }
  return grouped;
}

function bump(
  summary: QuoteBackfillSummary,
  result: QuoteBackfillAttemptResult,
): void {
  if (result === 'updated') summary.updated += 1;
  else if (result === 'no-match') summary.noMatch += 1;
  else if (result === 'rejected') summary.rejected += 1;
  else if (result === 'error') summary.errors += 1;
  else if (result === 'skipped-race') summary.skippedRace += 1;
}

async function recordAttempt(
  client: QuoteBackfillClient,
  args: {
    claimId: string;
    contentId: number;
    runId: string;
    result: QuoteBackfillAttemptResult;
    reason: string | null;
    quote?: string;
  },
): Promise<QuoteBackfillAttemptResult> {
  await client.query('BEGIN');
  try {
    let result = args.result;
    if (result === 'updated' && args.quote !== undefined) {
      const updated = await client.query(UPDATE_QUOTE_SQL, [args.quote, args.claimId]);
      if (!updated.rows.length) {
        result = 'skipped-race';
      }
    }
    await client.query(INSERT_ATTEMPT_SQL, [
      args.claimId,
      args.contentId,
      args.runId,
      result,
      args.reason ? sanitizeAttemptReason(args.reason) : null,
    ]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function receiptAll(
  db: QuoteBackfillDb,
  rows: CandidateRow[],
  runId: string,
  result: QuoteBackfillAttemptResult,
  reason: string,
  summary: QuoteBackfillSummary,
): Promise<void> {
  for (const row of rows) {
    const client = await db.connect();
    try {
      const recorded = await recordAttempt(client, {
        claimId: row.claim_id,
        contentId: row.content_id,
        runId,
        result,
        reason,
      });
      bump(summary, recorded);
    } catch {
      bump(summary, 'error');
    } finally {
      client.release();
    }
  }
}

/**
 * Admit a recovered quote with the same policy as new-claim extraction:
 * trim, require nonblank, require exact substring of stored content_text.
 */
export function admitRecoveredQuote(
  originalQuote: unknown,
  contentText: string,
): { ok: true; quote: string } | { ok: false; reason: string } {
  const quote = typeof originalQuote === 'string' ? originalQuote.trim() : '';
  if (!quote) return { ok: false, reason: 'blank-quote' };
  if (!contentText.includes(quote)) return { ok: false, reason: 'not-substring' };
  return { ok: true, quote };
}

export async function runQuoteBackfill(
  options: QuoteBackfillRunOptions,
): Promise<QuoteBackfillSummary> {
  const limit = parseQuoteBackfillLimit(options.limit);
  const execute = Boolean(options.execute);
  const retryFailed = Boolean(options.retryFailed);
  const runId = options.runId || `qb_${Date.now()}`;
  const summary = emptySummary(!execute);

  const selected = await options.db.query(SELECT_CANDIDATES_SQL, [
    retryFailed,
    QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX,
    limit,
  ]);
  const rows = asCandidateRows(selected.rows);
  const grouped = groupByContent(rows);
  const contentIds = [...grouped.keys()].sort((a, b) => a - b).slice(0, limit);
  const candidateIds: string[] = [];
  for (const contentId of contentIds) {
    for (const row of grouped.get(contentId) ?? []) {
      candidateIds.push(row.claim_id);
    }
  }

  summary.selectedContent = contentIds.length;
  summary.candidateClaims = candidateIds.length;
  summary.candidateIds = candidateIds;
  summary.contentIds = contentIds;

  if (!execute) {
    return summary;
  }

  for (const contentId of contentIds) {
    const batch = grouped.get(contentId) ?? [];
    if (batch.length === 0) continue;
    const contentText = batch[0].content_text;
    const input: QuoteRecoveryInput = {
      contentId,
      contentText,
      claims: batch.map((row) => ({
        claimId: row.claim_id,
        claimText: row.claim_text,
      })),
    };

    summary.providerCallsAttempted += 1;
    let raw: string;
    try {
      raw = await options.recoverer.recoverQuotesJson({
        ...input,
        contentText: contentText.slice(0, QUOTE_RECOVERY_CONTENT_LIMIT),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'provider-error';
      await receiptAll(options.db, batch, runId, 'error', 'provider-error', summary);
      void message;
      continue;
    }

    const parsed = parseQuoteRecoveryMappings(raw);
    if (!parsed.ok) {
      await receiptAll(options.db, batch, runId, 'error', parsed.reason, summary);
      continue;
    }

    const batchIds = new Set(batch.map((row) => row.claim_id));
    const byClaim = new Map<string, QuoteRecoveryMapping[]>();
    for (const mapping of parsed.mappings) {
      const list = byClaim.get(mapping.claimId) ?? [];
      list.push(mapping);
      byClaim.set(mapping.claimId, list);
    }

    for (const claimId of byClaim.keys()) {
      if (batchIds.has(claimId)) continue;
      const client = await options.db.connect();
      try {
        const recorded = await recordAttempt(client, {
          claimId,
          contentId,
          runId,
          result: 'rejected',
          reason: 'unknown-claim',
        });
        bump(summary, recorded);
      } catch {
        bump(summary, 'error');
      } finally {
        client.release();
      }
    }

    for (const row of batch) {
      const mappings = byClaim.get(row.claim_id) ?? [];
      let result: QuoteBackfillAttemptResult;
      let reason: string | null = null;
      let quote: string | undefined;

      if (mappings.length === 0) {
        result = 'no-match';
        reason = 'no-mapping';
      } else if (mappings.length > 1) {
        result = 'rejected';
        reason = 'duplicate-mapping';
      } else {
        const admitted = admitRecoveredQuote(mappings[0].originalQuote, row.content_text);
        if (!admitted.ok) {
          result = 'rejected';
          reason = admitted.reason;
        } else {
          result = 'updated';
          quote = admitted.quote;
        }
      }

      const client = await options.db.connect();
      try {
        const recorded = await recordAttempt(client, {
          claimId: row.claim_id,
          contentId: row.content_id,
          runId,
          result,
          reason,
          quote,
        });
        bump(summary, recorded);
      } catch {
        bump(summary, 'error');
      } finally {
        client.release();
      }
    }
  }

  return summary;
}

export function formatQuoteBackfillSummary(summary: QuoteBackfillSummary): string {
  const mode = summary.dryRun ? 'dry-run' : 'execute';
  return [
    `Quote backfill (${mode})`,
    `  selected content: ${summary.selectedContent}`,
    `  candidate claims: ${summary.candidateClaims}`,
    `  provider calls attempted: ${summary.providerCallsAttempted}`,
    `  updated: ${summary.updated}`,
    `  no-match: ${summary.noMatch}`,
    `  rejected: ${summary.rejected}`,
    `  errors: ${summary.errors}`,
    `  skipped-race: ${summary.skippedRace}`,
    `  candidate ids: ${summary.candidateIds.join(', ') || '(none)'}`,
    `  content ids: ${summary.contentIds.join(', ') || '(none)'}`,
  ].join('\n');
}

const noopRecoverer: QuoteRecoverer = {
  async recoverQuotesJson() {
    throw new Error('dry-run must not call provider');
  },
};

export function createRouterQuoteRecoverer(router: {
  complete: (stage: Stage, request: CompleteRequest) => Promise<CompleteResult>;
}): QuoteRecoverer {
  return {
    async recoverQuotesJson(input: QuoteRecoveryInput): Promise<string> {
      const prompt = buildQuoteRecoveryPrompt(input);
      const result = await router.complete('quote_backfill', {
        messages: [{ role: 'user', content: prompt }],
        promptTemplateId: 'quote_backfill',
        promptVersion: STAGE_PROMPT_VERSIONS.quote_backfill,
      });
      return result.content;
    },
  };
}

function poolAsDb(pool: InstanceType<typeof pg.Pool>): QuoteBackfillDb {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
        },
        release: () => client.release(),
      };
    },
  };
}

export async function runQuoteBackfillCommand(args: {
  connectionString: string;
  execute?: boolean;
  limit?: unknown;
  retryFailed?: boolean;
  recoverer?: QuoteRecoverer;
  router?: {
    complete: (stage: Stage, request: CompleteRequest) => Promise<CompleteResult>;
  };
}): Promise<QuoteBackfillSummary> {
  parseQuoteBackfillLimit(args.limit);
  const execute = Boolean(args.execute);
  let recoverer = args.recoverer;
  if (!recoverer && execute) {
    if (!args.router) {
      throw new Error('quote backfill execute requires a router recoverer');
    }
    recoverer = createRouterQuoteRecoverer(args.router);
  }
  const pool = new pg.Pool({ connectionString: args.connectionString });
  try {
    return await runQuoteBackfill({
      db: poolAsDb(pool),
      recoverer: recoverer ?? noopRecoverer,
      execute,
      limit: args.limit,
      retryFailed: args.retryFailed,
    });
  } finally {
    await pool.end();
  }
}

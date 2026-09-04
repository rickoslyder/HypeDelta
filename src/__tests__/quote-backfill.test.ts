/**
 * Historical quote recovery: operator-controlled, dry-run default, fail-closed.
 * All provider calls are injected fakes. Never contacts a real model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  QUOTE_BACKFILL_HARD_MAX_CONTENT,
  QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX,
  parseQuoteBackfillLimit,
  buildQuoteRecoveryPrompt,
  parseQuoteRecoveryMappings,
  runQuoteBackfill,
  type QuoteBackfillDb,
  type QuoteRecoverer,
} from '../quote-backfill';

const SOURCE_A =
  'Lab researchers said scaling will continue through 2027 and evals will ship.';
const SOURCE_B = 'Critics argue prompt injection remains unsolved in production agents.';
const SOURCE_C = 'Independent note: multimodal models still fail basic counting tasks.';

type SqlCall = { sql: string; params?: unknown[] };

function isSelectCandidates(sql: string): boolean {
  return /FROM\s+extracted_claims/i.test(sql) && /original_quote/i.test(sql);
}

function isUpdateQuote(sql: string): boolean {
  return /UPDATE\s+extracted_claims/i.test(sql) && /original_quote/i.test(sql);
}

function isInsertAttempt(sql: string): boolean {
  return /INSERT\s+INTO\s+quote_backfill_attempts/i.test(sql);
}

interface FakeCandidate {
  claim_id: string;
  content_id: number;
  claim_text: string;
  content_text: string;
}

interface FakeDbOptions {
  candidates: FakeCandidate[];
  /** Claim ids whose original_quote is already nonblank at UPDATE time (race). */
  raceFilled?: Set<string>;
  insertErrorForClaim?: string;
  /** Prior quote_backfill_attempts rows used to apply SELECT exclusion SQL. */
  priorAttempts?: Array<{ claim_id: string; result: string }>;
}

function sqlStringLiterals(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Execute the attempt-exclusion predicates from the live SELECT SQL against
 * in-memory prior receipts. Driven by the SQL text + $1 retryFailed param,
 * not by a hardcoded result list.
 */
function filterCandidatesByAttemptSql(
  sql: string,
  params: unknown[] | undefined,
  candidates: FakeCandidate[],
  priorAttempts: Array<{ claim_id: string; result: string }>,
): FakeCandidate[] {
  if (priorAttempts.length === 0) return candidates;
  const retryFailed = Boolean(params?.[0]);
  const alwaysExcluded = new Set<string>();
  for (const m of sql.matchAll(/a\.result\s*=\s*'([^']+)'/gi)) {
    alwaysExcluded.add(m[1]);
  }
  const inMatch = sql.match(/a\.result\s+IN\s*\(([^)]*)\)/i);
  const failedExcluded = inMatch ? sqlStringLiterals(inMatch[1]) : [];
  const byClaim = new Map<string, string[]>();
  for (const attempt of priorAttempts) {
    const list = byClaim.get(attempt.claim_id) ?? [];
    list.push(attempt.result);
    byClaim.set(attempt.claim_id, list);
  }
  return candidates.filter((candidate) => {
    const results = byClaim.get(candidate.claim_id) ?? [];
    if (results.some((result) => alwaysExcluded.has(result))) return false;
    if (!retryFailed && results.some((result) => failedExcluded.includes(result))) {
      return false;
    }
    return true;
  });
}

function createFakeDb(opts: FakeDbOptions) {
  const poolCalls: SqlCall[] = [];
  const clientCalls: SqlCall[] = [];
  const attempts: Array<{
    claim_id: string;
    content_id: number;
    run_id: string;
    result: string;
    reason: string | null;
  }> = [];
  const quotes = new Map<string, string>();
  const raceFilled = opts.raceFilled ?? new Set<string>();

  const handleClient = async (sql: string, params?: unknown[]) => {
    clientCalls.push({ sql, params });
    const text = String(sql);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (isUpdateQuote(text)) {
      const quote = String(params?.[0] ?? '');
      const claimId = String(params?.[1] ?? '');
      if (raceFilled.has(claimId) || quotes.has(claimId)) {
        return { rows: [], rowCount: 0 };
      }
      quotes.set(claimId, quote);
      return { rows: [{ id: claimId }], rowCount: 1 };
    }
    if (isInsertAttempt(text)) {
      const claimId = String(params?.[0] ?? '');
      if (opts.insertErrorForClaim && claimId === opts.insertErrorForClaim) {
        throw new Error('attempt insert failed');
      }
      attempts.push({
        claim_id: claimId,
        content_id: Number(params?.[1]),
        run_id: String(params?.[2] ?? ''),
        result: String(params?.[3] ?? ''),
        reason: (params?.[4] as string | null) ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const db: QuoteBackfillDb = {
    query: async (sql: string, params?: unknown[]) => {
      poolCalls.push({ sql, params });
      if (isSelectCandidates(sql)) {
        const rows = filterCandidatesByAttemptSql(
          sql,
          params,
          opts.candidates,
          opts.priorAttempts ?? [],
        );
        return { rows, rowCount: rows.length };
      }
      if (isUpdateQuote(sql) || isInsertAttempt(sql)) {
        throw new Error('mutation must use a transaction client, not the pool');
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: handleClient,
      release: vi.fn(),
    }),
  };

  return { db, poolCalls, clientCalls, attempts, quotes };
}

describe('quote-backfill safety caps', () => {
  it('documents a hard max of at most 100 unique content items and a per-content claim cap', () => {
    expect(QUOTE_BACKFILL_HARD_MAX_CONTENT).toBeLessThanOrEqual(100);
    expect(QUOTE_BACKFILL_HARD_MAX_CONTENT).toBeGreaterThan(0);
    expect(QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX).toBeGreaterThan(0);
    expect(QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX).toBeLessThanOrEqual(50);
  });

  it('accepts a positive limit at or below the hard max', () => {
    expect(parseQuoteBackfillLimit(25)).toBe(25);
    expect(parseQuoteBackfillLimit('25')).toBe(25);
    expect(parseQuoteBackfillLimit(QUOTE_BACKFILL_HARD_MAX_CONTENT)).toBe(
      QUOTE_BACKFILL_HARD_MAX_CONTENT,
    );
  });

  it('rejects missing, zero, negative, non-integer, and over-max limits before any I/O', () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () => '[]'),
    };
    const db: QuoteBackfillDb = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => {
        throw new Error('connect must not run');
      }),
    };

    for (const limit of [undefined, null, '', 0, -1, 0.5, 101, '0', '-3', '101', 'abc']) {
      expect(() => parseQuoteBackfillLimit(limit as never)).toThrow(/limit/i);
    }

    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
    expect(recoverer.recoverQuotesJson).not.toHaveBeenCalled();
  });
});

describe('quote recovery prompt/schema', () => {
  it('asks only for exact JSON mappings and never for new claims or paraphrases', () => {
    const prompt = buildQuoteRecoveryPrompt({
      contentId: 7,
      contentText: SOURCE_A,
      claims: [
        { claimId: 'claim_1', claimText: 'Scaling continues through 2027' },
        { claimId: 'claim_2', claimText: 'Evals will ship' },
      ],
    });

    expect(prompt).toContain('claim_1');
    expect(prompt).toContain('claim_2');
    expect(prompt).toContain(SOURCE_A);
    expect(prompt).toMatch(/claimId/);
    expect(prompt).toMatch(/originalQuote/);
    expect(prompt).toMatch(/exact|verbatim/i);
    expect(prompt).toMatch(/contiguous|span/i);
    expect(prompt).toMatch(/non-?blank|non-empty/i);
    expect(prompt).toMatch(/do not|never/i);
    expect(prompt).not.toMatch(/new claims/i);
    expect(prompt).not.toMatch(/paraphrase/i);
    expect(prompt).toMatch(/no mapping|omit|skip/i);
  });

  it('parses a JSON array of mappings and rejects malformed JSON', () => {
    const ok = parseQuoteRecoveryMappings(
      JSON.stringify([
        { claimId: 'claim_1', originalQuote: 'scaling will continue through 2027' },
      ]),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.mappings).toEqual([
        { claimId: 'claim_1', originalQuote: 'scaling will continue through 2027' },
      ]);
    }

    const bad = parseQuoteRecoveryMappings('not-json');
    expect(bad.ok).toBe(false);
  });
});

describe('runQuoteBackfill dry-run (A)', () => {
  it('with limit 25 performs zero provider calls and zero writes', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () => {
        throw new Error('provider must not be called on dry-run');
      }),
    };
    const { db, poolCalls, clientCalls, attempts, quotes } = createFakeDb({
      candidates: [
        {
          claim_id: 'c1',
          content_id: 1,
          claim_text: 'Scaling continues',
          content_text: SOURCE_A,
        },
      ],
    });

    const summary = await runQuoteBackfill({
      db,
      recoverer,
      limit: 25,
      execute: false,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.selectedContent).toBe(1);
    expect(summary.candidateClaims).toBe(1);
    expect(summary.providerCallsAttempted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.candidateIds).toEqual(['c1']);
    expect(recoverer.recoverQuotesJson).not.toHaveBeenCalled();
    expect(clientCalls).toHaveLength(0);
    expect(attempts).toHaveLength(0);
    expect(quotes.size).toBe(0);
    expect(poolCalls.every((c) => !isUpdateQuote(c.sql) && !isInsertAttempt(c.sql))).toBe(
      true,
    );

    const dumped = JSON.stringify(summary);
    expect(dumped).not.toContain(SOURCE_A);
  });
});

describe('runQuoteBackfill execute gates (B)', () => {
  it('fails before provider/DB side effects when execute lacks a valid limit', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () => '[]'),
    };
    const db: QuoteBackfillDb = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => {
        throw new Error('connect must not run');
      }),
    };

    await expect(
      runQuoteBackfill({ db, recoverer, execute: true }),
    ).rejects.toThrow(/limit/i);
    await expect(
      runQuoteBackfill({ db, recoverer, execute: true, limit: 0 }),
    ).rejects.toThrow(/limit/i);
    await expect(
      runQuoteBackfill({ db, recoverer, execute: true, limit: 101 }),
    ).rejects.toThrow(/limit/i);

    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
    expect(recoverer.recoverQuotesJson).not.toHaveBeenCalled();
  });
});

describe('runQuoteBackfill provider bounding (C)', () => {
  it('ten missing claims on three content rows issue at most three provider calls and cap per content', async () => {
    const claims = [
      ...[1, 2, 3, 4].map((n) => ({
        claim_id: `a${n}`,
        content_id: 10,
        claim_text: `A${n}`,
        content_text: SOURCE_A,
      })),
      ...[1, 2, 3].map((n) => ({
        claim_id: `b${n}`,
        content_id: 20,
        claim_text: `B${n}`,
        content_text: SOURCE_B,
      })),
      ...[1, 2, 3].map((n) => ({
        claim_id: `c${n}`,
        content_id: 30,
        claim_text: `C${n}`,
        content_text: SOURCE_C,
      })),
    ];
    expect(claims).toHaveLength(10);

    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async (input) =>
        JSON.stringify(
          input.claims.map((c) => ({
            claimId: c.claimId,
            originalQuote:
              input.contentId === 10
                ? 'scaling will continue through 2027'
                : input.contentId === 20
                  ? 'prompt injection remains unsolved'
                  : 'multimodal models still fail basic counting tasks',
          })),
        ),
      ),
    };
    const { db } = createFakeDb({ candidates: claims });

    const summary = await runQuoteBackfill({
      db,
      recoverer,
      execute: true,
      limit: 25,
    });

    expect(recoverer.recoverQuotesJson).toHaveBeenCalledTimes(3);
    expect(summary.providerCallsAttempted).toBe(3);
    expect(summary.selectedContent).toBe(3);
    expect(summary.candidateClaims).toBe(10);
    expect(summary.providerCallsAttempted).toBeLessThanOrEqual(summary.selectedContent);

    const oversized = Array.from({ length: QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX + 5 }, (_, i) => ({
      claim_id: `over${i}`,
      content_id: 99,
      claim_text: `Over ${i}`,
      content_text: SOURCE_A,
    }));
    const recoverer2: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async (input) =>
        JSON.stringify(
          input.claims.map((c) => ({
            claimId: c.claimId,
            originalQuote: 'scaling will continue through 2027',
          })),
        ),
      ),
    };
    const fake2 = createFakeDb({ candidates: oversized });
    await runQuoteBackfill({
      db: fake2.db,
      recoverer: recoverer2,
      execute: true,
      limit: 1,
    });
    expect(recoverer2.recoverQuotesJson).toHaveBeenCalledTimes(1);
    const sent = (recoverer2.recoverQuotesJson as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.claims.length).toBeLessThanOrEqual(QUOTE_BACKFILL_PER_CONTENT_CLAIM_MAX);
  });
});

describe('runQuoteBackfill exact substring update (D)', () => {
  it('updates only the intended blank claim and writes an updated receipt atomically', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () =>
        JSON.stringify([
          {
            claimId: 'keep_blank',
            originalQuote: 'scaling will continue through 2027',
          },
        ]),
      ),
    };
    const { db, clientCalls, attempts, quotes } = createFakeDb({
      candidates: [
        {
          claim_id: 'keep_blank',
          content_id: 1,
          claim_text: 'Scaling continues through 2027',
          content_text: SOURCE_A,
        },
      ],
    });

    const summary = await runQuoteBackfill({
      db,
      recoverer,
      execute: true,
      limit: 1,
      runId: 'run_test_d',
    });

    expect(summary.updated).toBe(1);
    expect(quotes.get('keep_blank')).toBe('scaling will continue through 2027');
    expect(attempts).toEqual([
      expect.objectContaining({
        claim_id: 'keep_blank',
        content_id: 1,
        run_id: 'run_test_d',
        result: 'updated',
      }),
    ]);

    const sqls = clientCalls.map((c) => c.sql);
    const begin = sqls.indexOf('BEGIN');
    const upd = sqls.findIndex(isUpdateQuote);
    const ins = sqls.findIndex(isInsertAttempt);
    const commit = sqls.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(upd).toBeGreaterThan(begin);
    expect(ins).toBeGreaterThan(upd);
    expect(commit).toBeGreaterThan(ins);

    const updateSql = clientCalls[upd].sql;
    expect(updateSql).toMatch(/SET\s+original_quote/i);
    expect(updateSql).not.toMatch(/claim_text\s*=/i);
    expect(updateSql).not.toMatch(/source_url\s*=/i);
    expect(updateSql).toMatch(/NULLIF\s*\(\s*btrim\s*\(\s*original_quote/i);
    expect(clientCalls[upd].params?.[0]).toBe('scaling will continue through 2027');
    expect(clientCalls[upd].params?.[1]).toBe('keep_blank');
  });
});

describe('runQuoteBackfill rejection paths (E)', () => {
  const baseCandidate = {
    claim_id: 'claim_ok',
    content_id: 1,
    claim_text: 'Scaling continues',
    content_text: SOURCE_A,
  };

  async function executeWithJson(json: string, extraCandidates: typeof baseCandidate[] = []) {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () => json),
    };
    const fake = createFakeDb({
      candidates: [baseCandidate, ...extraCandidates],
    });
    const summary = await runQuoteBackfill({
      db: fake.db,
      recoverer,
      execute: true,
      limit: 5,
    });
    return { summary, fake, recoverer };
  }

  it('paraphrase/non-substring never updates original_quote and receipts rejected', async () => {
    const { summary, fake } = await executeWithJson(
      JSON.stringify([
        { claimId: 'claim_ok', originalQuote: 'labs will dominate forever' },
      ]),
    );
    expect(summary.updated).toBe(0);
    expect(summary.rejected).toBeGreaterThanOrEqual(1);
    expect(fake.quotes.size).toBe(0);
    expect(fake.attempts.some((a) => a.result === 'rejected')).toBe(true);
    expect(JSON.stringify(fake.attempts)).not.toContain('labs will dominate forever');
    expect(JSON.stringify(summary)).not.toContain(SOURCE_A);
  });

  it('blank quote never updates and receipts rejected', async () => {
    const { summary, fake } = await executeWithJson(
      JSON.stringify([{ claimId: 'claim_ok', originalQuote: '   ' }]),
    );
    expect(summary.updated).toBe(0);
    expect(fake.quotes.size).toBe(0);
    expect(fake.attempts.some((a) => a.result === 'rejected')).toBe(true);
  });

  it('unknown claim id is receipted without mutation', async () => {
    const { summary, fake } = await executeWithJson(
      JSON.stringify([
        { claimId: 'not_in_batch', originalQuote: 'scaling will continue through 2027' },
      ]),
    );
    expect(fake.quotes.size).toBe(0);
    expect(summary.updated).toBe(0);
    expect(fake.attempts.some((a) => a.claim_id === 'not_in_batch' && a.result === 'rejected')).toBe(
      true,
    );
  });

  it('duplicate/conflicting output rejects safely without update', async () => {
    const { summary, fake } = await executeWithJson(
      JSON.stringify([
        { claimId: 'claim_ok', originalQuote: 'scaling will continue through 2027' },
        { claimId: 'claim_ok', originalQuote: 'evals will ship' },
      ]),
    );
    expect(summary.updated).toBe(0);
    expect(fake.quotes.size).toBe(0);
    expect(fake.attempts.some((a) => a.result === 'rejected')).toBe(true);
  });

  it('malformed JSON never updates and yields sanitized error receipts', async () => {
    const { summary, fake } = await executeWithJson('{"nope": true');
    expect(summary.updated).toBe(0);
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(fake.quotes.size).toBe(0);
    expect(fake.attempts.every((a) => a.result === 'error')).toBe(true);
    expect(JSON.stringify(fake.attempts)).not.toMatch(/postgresql:\/\//i);
  });

  it('provider error never updates and yields sanitized error receipts, then continues', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async (input) => {
        if (input.contentId === 1) throw new Error('boom secret=sk-live postgresql://x');
        return JSON.stringify([
          { claimId: 'claim_b', originalQuote: 'prompt injection remains unsolved' },
        ]);
      }),
    };
    const fake = createFakeDb({
      candidates: [
        baseCandidate,
        {
          claim_id: 'claim_b',
          content_id: 2,
          claim_text: 'Prompt injection unsolved',
          content_text: SOURCE_B,
        },
      ],
    });
    const summary = await runQuoteBackfill({
      db: fake.db,
      recoverer,
      execute: true,
      limit: 5,
    });
    expect(summary.providerCallsAttempted).toBe(2);
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.updated).toBe(1);
    expect(fake.quotes.has('claim_ok')).toBe(false);
    expect(fake.quotes.get('claim_b')).toBe('prompt injection remains unsolved');
    const reasons = fake.attempts.map((a) => a.reason || '').join(' ');
    expect(reasons).not.toMatch(/sk-live/);
    expect(reasons).not.toMatch(/postgresql:\/\//i);
  });
});

describe('runQuoteBackfill race (F)', () => {
  it('does not overwrite a quote filled by another worker and records skipped-race', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () =>
        JSON.stringify([
          { claimId: 'raced', originalQuote: 'scaling will continue through 2027' },
        ]),
      ),
    };
    const fake = createFakeDb({
      candidates: [
        {
          claim_id: 'raced',
          content_id: 1,
          claim_text: 'Scaling continues',
          content_text: SOURCE_A,
        },
      ],
      raceFilled: new Set(['raced']),
    });

    const summary = await runQuoteBackfill({
      db: fake.db,
      recoverer,
      execute: true,
      limit: 1,
    });

    expect(fake.quotes.size).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.skippedRace).toBe(1);
    expect(fake.attempts).toEqual([
      expect.objectContaining({ claim_id: 'raced', result: 'skipped-race' }),
    ]);
  });
});

describe('runQuoteBackfill idempotency (G)', () => {
  it('re-running successful candidates causes no provider call', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () =>
        JSON.stringify([
          { claimId: 'c1', originalQuote: 'scaling will continue through 2027' },
        ]),
      ),
    };
    const first = createFakeDb({
      candidates: [
        {
          claim_id: 'c1',
          content_id: 1,
          claim_text: 'Scaling continues',
          content_text: SOURCE_A,
        },
      ],
    });
    const firstSummary = await runQuoteBackfill({
      db: first.db,
      recoverer,
      execute: true,
      limit: 1,
    });
    expect(firstSummary.updated).toBe(1);
    expect(recoverer.recoverQuotesJson).toHaveBeenCalledTimes(1);

    const second = createFakeDb({ candidates: [] });
    const secondSummary = await runQuoteBackfill({
      db: second.db,
      recoverer,
      execute: true,
      limit: 1,
    });
    expect(secondSummary.candidateClaims).toBe(0);
    expect(secondSummary.providerCallsAttempted).toBe(0);
    expect(recoverer.recoverQuotesJson).toHaveBeenCalledTimes(1);
  });

  it('default selection excludes claims with a prior error receipt', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () => {
        throw new Error('provider must not run for excluded error receipts');
      }),
    };
    const fake = createFakeDb({
      candidates: [
        {
          claim_id: 'fresh',
          content_id: 1,
          claim_text: 'Scaling continues',
          content_text: SOURCE_A,
        },
        {
          claim_id: 'prior-error',
          content_id: 2,
          claim_text: 'Prompt injection remains unsolved',
          content_text: SOURCE_B,
        },
      ],
      priorAttempts: [{ claim_id: 'prior-error', result: 'error' }],
    });
    const summary = await runQuoteBackfill({
      db: fake.db,
      recoverer,
      execute: false,
      limit: 2,
    });
    expect(summary.candidateIds).toEqual(['fresh']);
    expect(summary.candidateIds).not.toContain('prior-error');
    expect(recoverer.recoverQuotesJson).not.toHaveBeenCalled();
  });

  it('retryFailed retries prior error/no-match/rejected but still skips updated', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () => '[]'),
    };
    const fake = createFakeDb({
      candidates: [
        {
          claim_id: 'prior-error',
          content_id: 1,
          claim_text: 'Scaling continues',
          content_text: SOURCE_A,
        },
        {
          claim_id: 'prior-nomatch',
          content_id: 2,
          claim_text: 'Prompt injection remains unsolved',
          content_text: SOURCE_B,
        },
        {
          claim_id: 'prior-rejected',
          content_id: 3,
          claim_text: 'Multimodal counting still fails',
          content_text: SOURCE_C,
        },
        {
          claim_id: 'prior-updated',
          content_id: 4,
          claim_text: 'Evals will ship',
          content_text: SOURCE_A,
        },
      ],
      priorAttempts: [
        { claim_id: 'prior-error', result: 'error' },
        { claim_id: 'prior-nomatch', result: 'no-match' },
        { claim_id: 'prior-rejected', result: 'rejected' },
        { claim_id: 'prior-updated', result: 'updated' },
      ],
    });
    const summary = await runQuoteBackfill({
      db: fake.db,
      recoverer,
      execute: false,
      limit: 4,
      retryFailed: true,
    });
    expect(summary.candidateIds).toEqual([
      'prior-error',
      'prior-nomatch',
      'prior-rejected',
    ]);
    expect(summary.candidateIds).not.toContain('prior-updated');
  });
});

describe('selection SQL contract (H)', () => {
  it('uses parameterized SQL, deterministic order, unique content limit, and skips successful attempts', async () => {
    const recoverer: QuoteRecoverer = {
      recoverQuotesJson: vi.fn(async () => '[]'),
    };
    const fake = createFakeDb({ candidates: [] });
    await runQuoteBackfill({
      db: fake.db,
      recoverer,
      execute: false,
      limit: 25,
    });

    const select = fake.poolCalls.find((c) => isSelectCandidates(c.sql));
    expect(select).toBeDefined();
    const sql = select!.sql;
    expect(sql).toMatch(/\$\d/);
    expect(sql).not.toMatch(/limit\s+25/i);
    expect(sql).toMatch(/ORDER BY/i);
    expect(sql).toMatch(/content_id/i);
    expect(sql).toMatch(/NULLIF\s*\(\s*btrim\s*\(\s*(?:c\.)?original_quote/i);
    expect(sql).toMatch(/NULLIF\s*\(\s*btrim\s*\(\s*(?:ct\.)?content_text/i);
    expect(sql).toMatch(/quote_backfill_attempts/);
    expect(sql).toMatch(/updated/);
    expect(select!.params?.length).toBeGreaterThan(0);
  });
});

describe('CLI backfill-quotes command', () => {
  it('registers a dry-run-default command that requires --execute plus --limit for real runs', () => {
    const src = readFileSync(resolve(__dirname, '../cli.ts'), 'utf8');
    expect(src).toMatch(/\.command\(\s*'backfill-quotes'\s*\)/);
    expect(src).toMatch(/--execute/);
    expect(src).toMatch(/--limit/);
    expect(src).toMatch(/--retry-failed/);
    expect(src).toMatch(/runQuoteBackfillCommand|runQuoteBackfill/);
  });
});

describe('quote_backfill_attempts migration', () => {
  it('adds an additive versioned ledger with no DELETE', async () => {
    const { MIGRATIONS } = await import('../migrations/files');
    const migration = MIGRATIONS.find((m) => m.name === 'quote_backfill_attempts');
    expect(migration).toBeDefined();
    expect(migration!.version).toMatch(/^\d+$/);
    expect(Number(migration!.version)).toBeGreaterThan(6);
    expect(migration!.sql).toMatch(/CREATE TABLE IF NOT EXISTS quote_backfill_attempts/i);
    expect(migration!.sql).toMatch(/claim_id/);
    expect(migration!.sql).toMatch(/content_id/);
    expect(migration!.sql).toMatch(/run_id/);
    expect(migration!.sql).toMatch(/attempted_at/);
    expect(migration!.sql).toMatch(/result/);
    expect(migration!.sql).toMatch(/reason/);
    expect(migration!.sql).toMatch(/updated/);
    expect(migration!.sql).toMatch(/no-match/);
    expect(migration!.sql).toMatch(/rejected/);
    expect(migration!.sql).toMatch(/error/);
    expect(migration!.sql).not.toMatch(/DROP\s+TABLE/i);
    expect(migration!.sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(migration!.sql).not.toMatch(/\bDELETE\b/i);
  });
});

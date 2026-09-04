/**
 * Real PostgreSQL integration gate.
 *
 * Skipped unless RUN_POSTGRES_INTEGRATION=1.
 * Fail-closed target guard: only hypedelta_ci / hypedelta_ci on loopback
 * or hosts beginning with hypedelta-ci-pg-. Never prints URL/password.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  initializeDatabase,
  SourceStore,
  ContentStore,
  ClaimStore,
  PredictionTracker,
} from '../storage';
import { applyMigrations, runMigrations, MIGRATIONS, migrationChecksum } from '../migrations/runner';
import { predictionIdFromClaimId } from '../migrations/prediction-id';
import { authorRoleCheckSql, authorRoleNormalizeSql } from '../author-side';

const ENABLED = process.env.RUN_POSTGRES_INTEGRATION === '1';

const ROOT = resolve(__dirname, '../..');
const BACKFILL_SQL = resolve(ROOT, 'scripts/backfill-claim-provenance.sql');

/**
 * Fail-closed guard before any mutation.
 * Returns a sanitized descriptor (no password) or throws a generic error.
 */
export function assertCiPostgresTarget(connectionString: string): {
  host: string;
  user: string;
  database: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL rejected: unparseable');
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL rejected: protocol');
  }

  const user = decodeURIComponent(url.username || '');
  // pathname is /dbname
  const database = decodeURIComponent((url.pathname || '').replace(/^\//, ''));
  const host = (url.hostname || '').toLowerCase();

  if (user !== 'hypedelta_ci') {
    throw new Error('DATABASE_URL rejected: user');
  }
  if (database !== 'hypedelta_ci') {
    throw new Error('DATABASE_URL rejected: database');
  }

  const loopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]';
  const ciHost = host.startsWith('hypedelta-ci-pg-');
  if (!loopback && !ciHost) {
    throw new Error('DATABASE_URL rejected: host');
  }

  return { host, user, database };
}

const describeIntegration = ENABLED ? describe : describe.skip;

describe('postgres target guard (always on)', () => {
  it('rejects non-ci targets without echoing secrets', () => {
    const bad = 'postgresql://prod:s3cret-password@db.example.com:5432/ai_intel';
    expect(() => assertCiPostgresTarget(bad)).toThrow(/rejected/i);
    try {
      assertCiPostgresTarget(bad);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain('s3cret-password');
      expect(msg).not.toContain('db.example.com');
      expect(msg).not.toContain(bad);
    }
  });

  it('accepts loopback hypedelta_ci', () => {
    const d = assertCiPostgresTarget(
      'postgresql://hypedelta_ci:x@127.0.0.1:5432/hypedelta_ci',
    );
    expect(d).toEqual({
      host: '127.0.0.1',
      user: 'hypedelta_ci',
      database: 'hypedelta_ci',
    });
  });

  it('accepts hypedelta-ci-pg- host prefix', () => {
    const d = assertCiPostgresTarget(
      'postgresql://hypedelta_ci:x@hypedelta-ci-pg-16:5432/hypedelta_ci',
    );
    expect(d.host).toBe('hypedelta-ci-pg-16');
  });
});

describeIntegration('postgres.integration (real pgvector)', () => {
  const connectionString = process.env.DATABASE_URL || '';
  let sourceStore: SourceStore;
  let contentStore: ContentStore;
  let claimStore: ClaimStore;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    if (!connectionString) {
      throw new Error('DATABASE_URL required when RUN_POSTGRES_INTEGRATION=1');
    }
    // Guard BEFORE any mutation
    assertCiPostgresTarget(connectionString);

    await initializeDatabase(connectionString, 768);

    sourceStore = new SourceStore(connectionString);
    contentStore = new ContentStore(connectionString);
    claimStore = new ClaimStore(connectionString);
    adminPool = new pg.Pool({ connectionString });

    // Clean tables inside the isolated CI database only
    await adminPool.query(`
      TRUNCATE predictions, content_embeddings, extracted_claims, content, source_researchers, researchers, sources, synthesis_results
      RESTART IDENTITY CASCADE
    `);
  }, 60_000);

  afterAll(async () => {
    try {
      if (adminPool) {
        await adminPool.query(`
          TRUNCATE predictions, content_embeddings, extracted_claims, content, source_researchers, researchers, sources, synthesis_results
          RESTART IDENTITY CASCADE
        `);
        await adminPool.end();
      }
    } catch {
      // ignore cleanup errors
    }
    await Promise.allSettled([
      sourceStore?.close(),
      contentStore?.close(),
      claimStore?.close(),
    ]);
  });

  it('concurrent identical source/content upserts converge to one row/one id', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'twitter',
      identifier: 'ci_concurrent_author',
      authorName: 'CI Author',
      category: 'anthropic',
    });

    const payload = {
      sourceId,
      externalId: 'ci_concurrent_ext_1',
      url: 'https://example.com/ci/concurrent-1',
      title: 'concurrent',
      contentText: 'same body',
      author: 'CI Author',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      wordCount: 2,
    };

    const ids = await Promise.all([
      contentStore.upsert(payload),
      contentStore.upsert(payload),
      contentStore.upsert(payload),
    ]);

    expect(new Set(ids).size).toBe(1);
    const id = ids[0];
    expect(typeof id).toBe('number');

    const rows = await adminPool.query(
      `SELECT id FROM content WHERE source_id = $1 AND external_id = $2`,
      [sourceId, 'ci_concurrent_ext_1'],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(id);
  });

  it('shared-client BEGIN + markProcessed + claim upsert + exception + ROLLBACK leaves neither', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'ci_tx_rollback',
      authorName: 'TX Author',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_tx_rb_ext',
      url: 'https://example.com/ci/tx-rb',
      contentText: 'rollback body',
      publishedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const client = await contentStore.connect();
    try {
      await client.query('BEGIN');
      await contentStore.markProcessed([contentId], client);
      await claimStore.upsert(
        {
          contentId,
          claimText: 'rollback claim',
          claimType: 'fact',
          topic: 'agents',
          stance: 'neutral',
          bullishness: 0.5,
          confidence: 0.5,
          sourceUrl: '',
        },
        client,
      );
      throw new Error('forced-test-exception');
    } catch (e) {
      expect(e instanceof Error && e.message).toBe('forced-test-exception');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const content = await adminPool.query(
      `SELECT processed_at FROM content WHERE id = $1`,
      [contentId],
    );
    expect(content.rows[0].processed_at).toBeNull();

    const claims = await adminPool.query(
      `SELECT id FROM extracted_claims WHERE content_id = $1`,
      [contentId],
    );
    expect(claims.rowCount).toBe(0);
  });

  it('successful transaction commits both marker and claim', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'ci_tx_commit',
      authorName: 'TX Commit',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_tx_ok_ext',
      url: 'https://example.com/ci/tx-ok',
      contentText: 'commit body',
      publishedAt: new Date('2026-01-03T00:00:00Z'),
    });

    const client = await contentStore.connect();
    let claimId = '';
    try {
      await client.query('BEGIN');
      await contentStore.markProcessed([contentId], client);
      claimId = await claimStore.upsert(
        {
          contentId,
          claimText: 'commit claim',
          claimType: 'fact',
          topic: 'scaling',
          stance: 'bullish',
          bullishness: 0.7,
          confidence: 0.8,
          sourceUrl: 'https://example.com/ci/tx-ok',
        },
        client,
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const content = await adminPool.query(
      `SELECT processed_at FROM content WHERE id = $1`,
      [contentId],
    );
    expect(content.rows[0].processed_at).not.toBeNull();

    const claims = await adminPool.query(
      `SELECT id, claim_text FROM extracted_claims WHERE id = $1`,
      [claimId],
    );
    expect(claims.rowCount).toBe(1);
    expect(claims.rows[0].claim_text).toBe('commit claim');
  });

  it('backfill-claim-provenance.sql is idempotent and fills blank source_url from content.url', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'twitter',
      identifier: 'ci_backfill_author',
      authorName: 'Backfill Author',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_backfill_ext',
      url: 'https://example.com/ci/backfill-source',
      contentText: 'backfill body',
      publishedAt: new Date('2026-01-04T00:00:00Z'),
    });

    const claimId = await claimStore.upsert({
      id: 'claim_ci_backfill_1',
      contentId,
      claimText: 'blank url claim',
      claimType: 'opinion',
      topic: 'safety',
      stance: 'bearish',
      bullishness: 0.2,
      confidence: 0.6,
      sourceUrl: '',
      author: '',
    });

    // Ensure blanks stuck (upsert may pass empty string)
    await adminPool.query(
      `UPDATE extracted_claims SET source_url = '', author = '' WHERE id = $1`,
      [claimId],
    );

    const sql = readFileSync(BACKFILL_SQL, 'utf8');

    // Run twice — must remain idempotent
    await adminPool.query(sql);
    await adminPool.query(sql);

    const row = await adminPool.query(
      `SELECT source_url, author FROM extracted_claims WHERE id = $1`,
      [claimId],
    );
    expect(row.rows[0].source_url).toBe('https://example.com/ci/backfill-source');
    // author filled from sources.identifier or author_name
    expect(row.rows[0].author).toBeTruthy();

    // Second run did not invent a second claim
    const count = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM extracted_claims WHERE content_id = $1`,
      [contentId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('re-running initializeDatabase is a no-op for schema_migrations versions', async () => {
    assertCiPostgresTarget(connectionString);
    const before = await adminPool.query(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(before.rows.map((r: { version: string }) => r.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );
    await initializeDatabase(connectionString, 768);
    const after = await adminPool.query(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('persists prediction claims, excludes non-predictions, and retries are idempotent', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'ci_pred_persist',
      authorName: 'Pred Author',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_pred_ext',
      url: 'https://example.com/ci/pred',
      contentText: 'Models will plateau by 2028',
      publishedAt: new Date('2026-01-05T00:00:00Z'),
    });

    const client = await contentStore.connect();
    let claimId = '';
    try {
      await client.query('BEGIN');
      claimId = await claimStore.upsert(
        {
          id: 'claim_ci_pred_1',
          contentId,
          claimText: 'Models will plateau by 2028',
          claimType: 'prediction',
          topic: 'scaling',
          stance: 'bearish',
          bullishness: 0.2,
          confidence: 0.55,
          timeframe: 'medium-term',
          author: 'Pred Author',
        },
        client,
      );
      await contentStore.markProcessed([contentId], client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const predId = predictionIdFromClaimId(claimId);
    const row = await adminPool.query(
      `SELECT id, claim_id, text, author, confidence, timeframe, topic, status, evidence, outcome_summary, evidence_url
       FROM predictions WHERE id = $1`,
      [predId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].claim_id).toBe(claimId);
    expect(row.rows[0].text).toBe('Models will plateau by 2028');
    expect(row.rows[0].author).toBe('Pred Author');
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].evidence).toBeNull();
    expect(row.rows[0].outcome_summary).toBeNull();
    expect(row.rows[0].evidence_url).toBeNull();

    await claimStore.upsert({
      id: claimId,
      contentId,
      claimText: 'Models will plateau by 2028',
      claimType: 'prediction',
      topic: 'scaling',
      stance: 'bearish',
      bullishness: 0.2,
      confidence: 0.55,
      timeframe: 'medium-term',
      author: 'Pred Author',
    });
    const count = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM predictions WHERE claim_id = $1`,
      [claimId],
    );
    expect(count.rows[0].n).toBe(1);

    await claimStore.upsert({
      id: 'claim_ci_opinion_1',
      contentId,
      claimText: 'Reasoning is interesting',
      claimType: 'opinion',
      topic: 'reasoning',
      stance: 'neutral',
      bullishness: 0.5,
      confidence: 0.5,
      author: 'Pred Author',
    });
    const opinionPred = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM predictions WHERE claim_id = $1`,
      ['claim_ci_opinion_1'],
    );
    expect(opinionPred.rows[0].n).toBe(0);
  });

  it('backfill does not overwrite reviewed outcome fields on conflict', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'ci_pred_backfill',
      authorName: 'Backfill Pred',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_pred_bf_ext',
      url: 'https://example.com/ci/pred-bf',
      contentText: 'AGI in 2030',
      publishedAt: new Date('2026-01-06T00:00:00Z'),
    });

    await adminPool.query(
      `INSERT INTO extracted_claims (
         id, content_id, claim_text, claim_type, topic, stance,
         bullishness, confidence, timeframe, author, extracted_at
       ) VALUES ($1, $2, $3, 'prediction', 'scaling', 'bullish', 0.9, 0.7, 'long-term', 'Backfill Pred', NOW())`,
      ['claim_ci_bf_pred', contentId, 'AGI in 2030'],
    );

    const predId = predictionIdFromClaimId('claim_ci_bf_pred');
    await adminPool.query(
      `INSERT INTO predictions (id, claim_id, text, author, confidence, timeframe, topic, made_at, status, evidence, accuracy_score, verified_at)
       VALUES ($1, $2, 'AGI in 2030', 'Backfill Pred', 0.7, 'long-term', 'scaling', NOW(), 'verified', 'it happened', 1.0, NOW())`,
      [predId, 'claim_ci_bf_pred'],
    );

    const backfill = MIGRATIONS.find((m) => m.version === '002');
    expect(backfill).toBeDefined();
    await adminPool.query(backfill!.sql);
    await adminPool.query(backfill!.sql);

    const row = await adminPool.query(
      `SELECT status, evidence, accuracy_score FROM predictions WHERE id = $1`,
      [predId],
    );
    expect(row.rows[0].status).toBe('verified');
    expect(row.rows[0].evidence).toBe('it happened');
    expect(Number(row.rows[0].accuracy_score)).toBe(1);
  });

  // Three real-PG migrators serialize on the session advisory lock.
  // Vitest's 5s default can mark this failed while Promise.all keeps running
  // and poison later tests (duplicate pg_type / lock waits). Isolated this
  // case finishes in <1s; 30s is slack for full-suite pool pressure, not a
  // deadlock workaround.
  it('failed migration rolls back and is not recorded; concurrent migrate is safe', async () => {
    assertCiPostgresTarget(connectionString);

    await expect(
      applyMigrations(adminPool, [
        ...MIGRATIONS,
        { version: '999_fail', name: 'intentional_fail', sql: 'SELECT 1/0' },
      ]),
    ).rejects.toThrow();

    const recorded = await adminPool.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      ['999_fail'],
    );
    expect(recorded.rowCount).toBe(0);

    await Promise.all([
      runMigrations(connectionString),
      runMigrations(connectionString),
      initializeDatabase(connectionString, 768),
    ]);

    const versions = await adminPool.query(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(versions.rows.map((r: { version: string }) => r.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );
  }, 30_000);

  it('fresh and upgraded schema default pending and reject invalid status', async () => {
    assertCiPostgresTarget(connectionString);
    const col = await adminPool.query(
      `SELECT column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'predictions'
         AND column_name = 'status'`,
    );
    expect(String(col.rows[0].column_default)).toMatch(/pending/);
    expect(col.rows[0].is_nullable).toBe('NO');

    await adminPool.query(
      `INSERT INTO predictions (id, text, author, made_at, topic)
       VALUES ('ci_status_default', 'default pending', 'CI', NOW(), 'other')`,
    );
    const inserted = await adminPool.query(
      `SELECT status FROM predictions WHERE id = 'ci_status_default'`,
    );
    expect(inserted.rows[0].status).toBe('pending');

    await expect(
      adminPool.query(
        `INSERT INTO predictions (id, text, author, made_at, status, topic)
         VALUES ('ci_status_bad', 'bad', 'CI', NOW(), 'nope', 'other')`,
      ),
    ).rejects.toThrow();
  });

  it('rejects duplicate non-null claim_id and still allows multiple null claim_id rows', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'ci_pred_unique',
      authorName: 'Unique Author',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_pred_unique_ext',
      url: 'https://example.com/ci/pred-unique',
      contentText: 'unique body',
      publishedAt: new Date('2026-01-07T00:00:00Z'),
    });
    await adminPool.query(
      `INSERT INTO extracted_claims (
         id, content_id, claim_text, claim_type, topic, stance, bullishness, confidence
       ) VALUES ('claim_ci_unique', $1, 'unique pred', 'prediction', 'scaling', 'neutral', 0.5, 0.5)`,
      [contentId],
    );

    await adminPool.query(
      `INSERT INTO predictions (id, claim_id, text, author, made_at, topic)
       VALUES ('pred_ci_unique_a', 'claim_ci_unique', 'row a', 'Unique Author', NOW(), 'other')`,
    );
    await expect(
      adminPool.query(
        `INSERT INTO predictions (id, claim_id, text, author, made_at, topic)
         VALUES ('pred_ci_unique_b', 'claim_ci_unique', 'row b', 'Unique Author', NOW(), 'other')`,
      ),
    ).rejects.toThrow();

    await adminPool.query(
      `INSERT INTO predictions (id, claim_id, text, author, made_at, topic)
       VALUES ('pred_ci_null_a', NULL, 'null a', 'Unique Author', NOW(), 'other'),
              ('pred_ci_null_b', NULL, 'null b', 'Unique Author', NOW(), 'other')`,
    );
    const nulls = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM predictions WHERE id IN ('pred_ci_null_a', 'pred_ci_null_b')`,
    );
    expect(nulls.rows[0].n).toBe(2);
  });

  it('migrating a duplicate-claim fixture fails closed without deleting rows or recording the version', async () => {
    assertCiPostgresTarget(connectionString);
    const m003 = MIGRATIONS.find((m) => m.version === '003');
    expect(m003).toBeDefined();

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'ci_pred_dup_mig',
      authorName: 'Dup Author',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_pred_dup_ext',
      url: 'https://example.com/ci/pred-dup',
      contentText: 'dup body',
      publishedAt: new Date('2026-01-08T00:00:00Z'),
    });
    await adminPool.query(
      `INSERT INTO extracted_claims (
         id, content_id, claim_text, claim_type, topic, stance, bullishness, confidence
       ) VALUES ('claim_ci_dup_mig', $1, 'dup pred', 'prediction', 'scaling', 'neutral', 0.5, 0.5)
       ON CONFLICT (id) DO NOTHING`,
      [contentId],
    );

    await adminPool.query(`DELETE FROM schema_migrations WHERE version = $1`, ['003']);
    await adminPool.query(`DROP INDEX IF EXISTS predictions_claim_id_unique`);

    try {
      await adminPool.query(`DELETE FROM predictions WHERE id IN ('dup_keep_a', 'dup_keep_b')`);
      await adminPool.query(
        `INSERT INTO predictions (id, claim_id, text, author, made_at, status, topic)
         VALUES ('dup_keep_a', 'claim_ci_dup_mig', 'row a', 'Dup Author', NOW(), 'too-early', 'other'),
                ('dup_keep_b', 'claim_ci_dup_mig', 'row b', 'Dup Author', NOW(), 'verified', 'other')`,
      );

      const before = await adminPool.query(
        `SELECT id, claim_id, text, status FROM predictions WHERE id IN ('dup_keep_a', 'dup_keep_b') ORDER BY id`,
      );

      await expect(applyMigrations(adminPool)).rejects.toThrow(/duplicate/i);

      const after = await adminPool.query(
        `SELECT id, claim_id, text, status FROM predictions WHERE id IN ('dup_keep_a', 'dup_keep_b') ORDER BY id`,
      );
      expect(after.rows).toEqual(before.rows);

      const recorded = await adminPool.query(
        `SELECT version FROM schema_migrations WHERE version = $1`,
        ['003'],
      );
      expect(recorded.rowCount).toBe(0);
    } finally {
      await adminPool.query(`DELETE FROM predictions WHERE id IN ('dup_keep_a', 'dup_keep_b')`);
      await applyMigrations(adminPool);
    }
  });

  it('claim retry preserves a manual prediction id and reviewed fields while refreshing source fields', async () => {
    assertCiPostgresTarget(connectionString);

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'ci_pred_manual_id',
      authorName: 'Manual Author',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'ci_pred_manual_ext',
      url: 'https://example.com/ci/pred-manual',
      contentText: 'original prediction text',
      publishedAt: new Date('2026-01-09T00:00:00Z'),
    });
    await claimStore.upsert({
      id: 'claim_ci_manual',
      contentId,
      claimText: 'original prediction text',
      claimType: 'prediction',
      topic: 'scaling',
      stance: 'bullish',
      bullishness: 0.7,
      confidence: 0.4,
      timeframe: 'long-term',
      author: 'Manual Author',
    });

    await adminPool.query(`DELETE FROM predictions WHERE claim_id = $1`, ['claim_ci_manual']);
    await adminPool.query(
      `INSERT INTO predictions (
         id, claim_id, text, author, confidence, timeframe, topic, made_at,
         status, verified_at, accuracy_score, evidence, outcome_summary, evidence_url,
         due_at, next_observable, next_question
       ) VALUES (
         'pred_manual_keep', 'claim_ci_manual', 'original prediction text', 'Manual Author',
         0.4, 'long-term', 'scaling', '2026-01-09T00:00:00Z',
         'verified', '2026-02-01T00:00:00Z', 0.95, 'reviewed-evidence',
         'reviewed-outcome', 'https://example.com/evidence',
         '2026-12-01T00:00:00Z', 'observable-keep', 'question-keep'
       )`,
    );

    const reviewedSql = `
      SELECT status, verified_at::text AS verified_at, accuracy_score::text AS accuracy_score,
             evidence, outcome_summary, evidence_url, due_at::text AS due_at,
             next_observable, next_question
      FROM predictions WHERE id = 'pred_manual_keep'`;
    const beforeReviewed = await adminPool.query(reviewedSql);

    await claimStore.upsert({
      id: 'claim_ci_manual',
      contentId,
      claimText: 'refreshed prediction text',
      claimType: 'prediction',
      topic: 'agents',
      stance: 'bullish',
      bullishness: 0.7,
      confidence: 0.88,
      timeframe: 'near-term',
      author: 'Manual Author Jr',
      extractedAt: new Date('2026-03-01T00:00:00Z'),
    });

    const after = await adminPool.query(
      `SELECT id, claim_id, text, author, confidence, timeframe, topic, made_at
       FROM predictions WHERE claim_id = $1`,
      ['claim_ci_manual'],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].id).toBe('pred_manual_keep');
    expect(after.rows[0].text).toBe('refreshed prediction text');
    expect(after.rows[0].author).toBe('Manual Author Jr');
    expect(Number(after.rows[0].confidence)).toBe(0.88);
    expect(after.rows[0].timeframe).toBe('near-term');
    expect(after.rows[0].topic).toBe('agents');

    const afterReviewed = await adminPool.query(reviewedSql);
    expect(afterReviewed.rows[0]).toEqual(beforeReviewed.rows[0]);
  });

  it('new prediction claims are pending; getPending and stats include pending and too-early', async () => {
    assertCiPostgresTarget(connectionString);
    const tracker = new PredictionTracker(connectionString);
    try {
      const sourceId = await sourceStore.upsert({
        type: 'blog',
        identifier: 'ci_pred_pending_sem',
        authorName: 'Pending Author',
      });
      const contentId = await contentStore.upsert({
        sourceId,
        externalId: 'ci_pred_pending_ext',
        url: 'https://example.com/ci/pred-pending',
        contentText: 'pending semantics',
        publishedAt: new Date('2026-01-10T00:00:00Z'),
      });
      const pendingClaimId = await claimStore.upsert({
        id: 'claim_ci_pending_sem',
        contentId,
        claimText: 'this stays pending',
        claimType: 'prediction',
        topic: 'scaling',
        stance: 'neutral',
        bullishness: 0.5,
        confidence: 0.5,
        timeframe: 'near-term',
        author: 'Pending Author',
      });
      await adminPool.query(
        `INSERT INTO predictions (id, claim_id, text, author, made_at, status, topic)
         VALUES ('pred_ci_too_early', NULL, 'too early row', 'Pending Author', NOW(), 'too-early', 'other'),
                ('pred_ci_verified_sem', NULL, 'verified row', 'Pending Author', NOW(), 'verified', 'other')`,
      );

      const row = await adminPool.query(
        `SELECT status FROM predictions WHERE claim_id = $1`,
        [pendingClaimId],
      );
      expect(row.rows[0].status).toBe('pending');

      const pending = await tracker.getPending();
      const pendingIds = pending.map((p) => p.id);
      expect(pendingIds).toContain(predictionIdFromClaimId(pendingClaimId));
      expect(pendingIds).toContain('pred_ci_too_early');
      expect(pendingIds).not.toContain('pred_ci_verified_sem');

      const stats = await tracker.getAccuracyStats('Pending Author');
      expect(stats.pending).toBeGreaterThanOrEqual(2);
      expect(stats.verified).toBeGreaterThanOrEqual(1);
    } finally {
      await tracker.close();
    }
  });

  it('updateStatus advances updated_at', async () => {
    assertCiPostgresTarget(connectionString);
    const tracker = new PredictionTracker(connectionString);
    try {
      await adminPool.query(
        `INSERT INTO predictions (id, text, author, made_at, status, updated_at, topic)
         VALUES ('pred_ci_updated_at', 'touch me', 'Clock Author', NOW(), 'pending', NOW() - INTERVAL '2 hours', 'other')`,
      );
      const before = await adminPool.query(
        `SELECT updated_at FROM predictions WHERE id = 'pred_ci_updated_at'`,
      );
      await tracker.updateStatus('pred_ci_updated_at', 'verified', 1, 'clock');
      const after = await adminPool.query(
        `SELECT updated_at, status FROM predictions WHERE id = 'pred_ci_updated_at'`,
      );
      expect(after.rows[0].status).toBe('verified');
      expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
        new Date(before.rows[0].updated_at).getTime(),
      );
    } finally {
      await tracker.close();
    }
  });

  it('004 CHECK allows only author roles and 005 maps duplicate names to one researcher', async () => {
    assertCiPostgresTarget(connectionString);

    const check = await adminPool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'extracted_claims_author_category_check'`,
    );
    expect(check.rowCount).toBeGreaterThan(0);

    const versions = await adminPool.query(`SELECT version FROM schema_migrations ORDER BY version`);
    expect(versions.rows.map((r: { version: string }) => r.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );

    const audited = [
      { name: 'Simon Willison', a: 'simonw', b: 'https://simonwillison.net/atom/everything/' },
      { name: 'Gary Marcus', a: 'GaryMarcus', b: 'https://garymarcus.substack.com/feed' },
      { name: 'Nathan Lambert', a: 'natolambert', b: 'https://www.interconnects.ai/feed' },
      { name: 'Rodney Brooks', a: 'rodneyabrooks', b: 'https://rodneybrooks.com/feed/' },
      { name: 'Jack Clark', a: 'jackclarkSF', b: 'https://importai.substack.com/feed' },
      { name: 'Melanie Mitchell', a: 'MelMitchell1', b: 'https://aiguide.substack.com/feed' },
      { name: 'Lilian Weng', a: 'lilianweng', b: 'https://lilianweng.github.io/index.xml' },
    ] as const;

    const sourceIds: Record<string, { a: number; b: number }> = {};
    for (const person of audited) {
      const a = await sourceStore.upsert({
        type: 'twitter',
        identifier: person.a,
        authorName: person.name,
        category: 'independent',
      });
      const b = await sourceStore.upsert({
        type: 'blog',
        identifier: person.b,
        authorName: person.name,
        category: 'independent',
      });
      sourceIds[person.name] = { a, b };
    }

    const fooDot = await sourceStore.upsert({
      type: 'blog',
      identifier: 'foo-dot-bar',
      authorName: 'Foo. Bar',
      category: 'independent',
    });
    const fooSpace = await sourceStore.upsert({
      type: 'blog',
      identifier: 'foo-space-bar',
      authorName: 'Foo Bar',
      category: 'independent',
    });
    const chollet = await sourceStore.upsert({
      type: 'twitter',
      identifier: 'fchollet',
      authorName: 'Francois Chollet',
      category: 'critics',
    });

    const simonTwitterContent = await contentStore.upsert({
      sourceId: sourceIds['Simon Willison'].a,
      externalId: 'sw_tw_claim',
      url: 'https://example.com/ci/sw-tw',
      contentText: 'twitter claim',
      publishedAt: new Date(),
    });
    const simonBlogContent = await contentStore.upsert({
      sourceId: sourceIds['Simon Willison'].b,
      externalId: 'sw_blog_claim',
      url: 'https://example.com/ci/sw-blog',
      contentText: 'blog claim',
      publishedAt: new Date(),
    });
    await claimStore.upsert({
      id: 'claim_ci_sw_tw',
      contentId: simonTwitterContent,
      claimText: 'sqlite remains underrated',
      claimType: 'opinion',
      topic: 'infrastructure',
      stance: 'bullish',
      bullishness: 0.7,
      confidence: 0.8,
      authorCategory: 'independent',
      sourceUrl: 'https://example.com/ci/sw-tw',
    });
    await claimStore.upsert({
      id: 'claim_ci_sw_blog',
      contentId: simonBlogContent,
      claimText: 'prompt injection is unsolved',
      claimType: 'opinion',
      topic: 'safety',
      stance: 'bearish',
      bullishness: 0.3,
      confidence: 0.8,
      authorCategory: 'independent',
      sourceUrl: 'https://example.com/ci/sw-blog',
    });

    const contentId = await contentStore.upsert({
      sourceId: chollet,
      externalId: 'fc_lab_claim',
      url: 'https://example.com/ci/fc',
      contentText: 'lab-authored claim',
      publishedAt: new Date(),
    });
    await claimStore.upsert({
      id: 'claim_ci_fc_lab',
      contentId,
      claimText: 'abstraction requires new ideas',
      claimType: 'opinion',
      topic: 'reasoning',
      stance: 'bearish',
      bullishness: 0.3,
      confidence: 0.8,
      authorCategory: 'lab-researcher',
      sourceUrl: 'https://example.com/ci/fc',
    });

    await adminPool.query(
      `ALTER TABLE extracted_claims DROP CONSTRAINT IF EXISTS extracted_claims_author_category_check`,
    );
    await adminPool.query(
      `INSERT INTO extracted_claims (id, content_id, claim_text, topic, author_category)
       VALUES
         ('claim_ci_legacy_org', $1, 'org token', 'other', 'anthropic'),
         ('claim_ci_legacy_unknown_token', $1, 'unrecognized', 'other', 'safety'),
         ('claim_ci_legacy_unknown_role', $1, 'already unknown', 'other', 'unknown')`,
      [contentId],
    );
    const beforeNormalize = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM extracted_claims
       WHERE id IN ('claim_ci_fc_lab','claim_ci_legacy_org','claim_ci_legacy_unknown_token','claim_ci_legacy_unknown_role','claim_ci_sw_tw','claim_ci_sw_blog')`,
    );
    await adminPool.query(authorRoleNormalizeSql());
    await adminPool.query(authorRoleNormalizeSql());
    const afterNormalize = await adminPool.query(
      `SELECT id, author_category FROM extracted_claims
       WHERE id IN ('claim_ci_legacy_org','claim_ci_legacy_unknown_token','claim_ci_legacy_unknown_role','claim_ci_fc_lab')
       ORDER BY id`,
    );
    const byId = Object.fromEntries(
      afterNormalize.rows.map((row: { id: string; author_category: string }) => [
        row.id,
        row.author_category,
      ]),
    );
    expect(byId.claim_ci_legacy_org).toBe('lab-researcher');
    expect(byId.claim_ci_legacy_unknown_token).toBe('unknown');
    expect(byId.claim_ci_legacy_unknown_role).toBe('unknown');
    expect(byId.claim_ci_fc_lab).toBe('lab-researcher');
    const afterCount = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM extracted_claims
       WHERE id IN ('claim_ci_fc_lab','claim_ci_legacy_org','claim_ci_legacy_unknown_token','claim_ci_legacy_unknown_role','claim_ci_sw_tw','claim_ci_sw_blog')`,
    );
    expect(afterCount.rows[0].n).toBe(beforeNormalize.rows[0].n);

    await adminPool.query(`
      ALTER TABLE extracted_claims
        ADD CONSTRAINT extracted_claims_author_category_check
        CHECK (${authorRoleCheckSql()})
    `);

    const m005 = MIGRATIONS.find((m) => m.version === '005');
    expect(m005).toBeDefined();
    await adminPool.query(m005!.sql);
    await adminPool.query(m005!.sql);

    for (const person of audited) {
      const people = await adminPool.query(
        `SELECT r.slug, r.display_name, COUNT(sr.source_id)::int AS n
         FROM researchers r
         JOIN source_researchers sr ON sr.researcher_id = r.id
         WHERE r.display_name = $1
         GROUP BY r.slug, r.display_name`,
        [person.name],
      );
      expect(people.rowCount, person.name).toBe(1);
      expect(people.rows[0].n, person.name).toBe(2);
      expect(people.rows[0].slug).toMatch(/^[a-z0-9-]+$/);
    }

    const collision = await adminPool.query(
      `SELECT display_name, slug FROM researchers WHERE display_name IN ('Foo. Bar', 'Foo Bar')`,
    );
    expect(collision.rowCount).toBe(2);
    expect(new Set(collision.rows.map((row: { slug: string }) => row.slug)).size).toBe(2);

    const simonClaims = await adminPool.query(
      `SELECT COUNT(DISTINCT e.id)::int AS n
       FROM extracted_claims e
       JOIN content c ON e.content_id = c.id
       JOIN source_researchers sr ON sr.source_id = c.source_id
       JOIN researchers r ON r.id = sr.researcher_id
       WHERE r.display_name = 'Simon Willison'`,
    );
    expect(simonClaims.rows[0].n).toBe(2);

    await expect(
      adminPool.query(
        `INSERT INTO extracted_claims (id, content_id, claim_text, topic, author_category)
         VALUES ('claim_ci_org_role', $1, 'should fail', 'other', 'anthropic')`,
        [contentId],
      ),
    ).rejects.toThrow();

    const preserved = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM extracted_claims WHERE id = 'claim_ci_fc_lab'`,
    );
    expect(preserved.rows[0].n).toBe(1);

    void fooDot;
    void fooSpace;
  });

  it('006 rewrites identifiers, deactivates only the five dead rows, is idempotent, and keeps duplicate replacements', async () => {
    assertCiPostgresTarget(connectionString);
    const m006 = MIGRATIONS.find((m) => m.version === '006');
    expect(m006).toBeDefined();

    const oldGoogle = 'https://ai.googleblog.com/feeds/posts/default';
    const newGoogle = 'https://research.google/blog/rss/';
    const oldOpenAi = 'https://openai.com/blog/rss/';
    const newOpenAi = 'https://openai.com/news/rss.xml';
    const ruder = 'https://ruder.io/rss/index.rss';
    const anthropic = 'https://www.anthropic.com/research/rss.xml';
    const meta = 'https://ai.meta.com/blog/rss/';
    const batch = 'https://www.deeplearning.ai/the-batch/feed/';
    const bair = 'https://bair.berkeley.edu/blog/feed.xml';
    const microsoft = 'https://www.microsoft.com/en-us/research/feed/';
    const yannicOld = 'UCZHmQk67mN31hHzLZcVbrqQ';
    const yannicNew = 'UCZHmQk67mSJgfCCTn7xBfew';

    const insert = async (type: string, identifier: string, category: string, author: string) => {
      const row = await adminPool.query(
        `INSERT INTO sources (type, identifier, author_name, category, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (type, identifier) DO UPDATE SET category = EXCLUDED.category, is_active = true
         RETURNING id`,
        [type, identifier, author, category],
      );
      return row.rows[0].id as number;
    };

    const googleId = await insert('blog', oldGoogle, 'deepmind', 'Google AI Blog');
    const openAiOldId = await insert('blog', oldOpenAi, 'openai', 'OpenAI Blog');
    const openAiNewId = await insert('blog', newOpenAi, 'openai', 'OpenAI News');
    await insert('blog', ruder, 'deepmind', 'Sebastian Ruder');
    await insert('blog', anthropic, 'anthropic', 'Anthropic Research');
    await insert('blog', meta, 'meta', 'Meta AI Blog');
    await insert('substack', batch, 'academic', 'Andrew Ng');
    await insert('blog', bair, 'academic', 'BAIR Blog');
    const microsoftId = await insert('blog', microsoft, 'independent', 'Microsoft Research');
    await insert('youtube', yannicOld, 'independent', 'Yannic Kilcher');
    await insert('blog', 'https://deepmind.google/discover/blog/rss.xml', 'deepmind', 'DeepMind Blog');
    await insert('substack', 'https://bensbites.beehiiv.com/feed', 'independent', 'Ben Tossell');
    await insert('podcast', 'https://feeds.megaphone.fm/dwarkeshpatel', 'independent', 'Dwarkesh Podcast');
    await insert('podcast', 'https://therobotbrains.libsyn.com/rss', 'academic', 'The Robot Brains');
    await insert('podcast', 'https://www.cognitiverevolution.ai/feed', 'independent', 'The Cognitive Revolution');
    await insert('podcast', 'https://feeds.simplecast.com/o8HFE2Nm', 'independent', 'Gradient Dissent');
    await insert('youtube', 'UCxVqU5e5uIp8K9DkJv7HXGA', 'independent', 'AI Explained');
    await insert('youtube', 'UCpZ2V6tS0Rq2G5WlxfRpqpQ', 'independent', 'The AI Epiphany');
    await insert('youtube', 'UC1hJ-Mhdb8fXkHMsKNWkVOw', 'independent', 'Dwarkesh Patel');

    const googleContent = await contentStore.upsert({
      sourceId: googleId,
      externalId: 'google-old-post',
      contentText: 'owned by old google row',
      publishedAt: new Date(),
    });
    const openAiOldContent = await contentStore.upsert({
      sourceId: openAiOldId,
      externalId: 'openai-old-post',
      contentText: 'owned by old openai row',
      publishedAt: new Date(),
    });
    const openAiNewContent = await contentStore.upsert({
      sourceId: openAiNewId,
      externalId: 'openai-new-post',
      contentText: 'owned by replacement openai row',
      publishedAt: new Date(),
    });

    const beforeCount = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM sources WHERE identifier IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [oldGoogle, newGoogle, oldOpenAi, newOpenAi, ruder, anthropic, meta, batch, bair, microsoft],
    );

    await adminPool.query(m006!.sql);
    await adminPool.query(m006!.sql);

    const google = await adminPool.query(`SELECT id, identifier, category, is_active FROM sources WHERE id = $1`, [googleId]);
    expect(google.rows[0].identifier).toBe(newGoogle);
    expect(google.rows[0].category).toBe('google');
    expect(google.rows[0].is_active).toBe(true);

    const yannic = await adminPool.query(
      `SELECT identifier FROM sources WHERE type = 'youtube' AND identifier IN ($1, $2)`,
      [yannicOld, yannicNew],
    );
    expect(yannic.rows.map((r: { identifier: string }) => r.identifier)).toEqual([yannicNew]);

    const openAiRows = await adminPool.query(
      `SELECT id, identifier, is_active FROM sources WHERE id IN ($1, $2) ORDER BY id`,
      [openAiOldId, openAiNewId],
    );
    expect(openAiRows.rowCount).toBe(2);
    expect(openAiRows.rows.map((r: { identifier: string }) => r.identifier).sort()).toEqual(
      [oldOpenAi, newOpenAi].sort(),
    );

    const dead = await adminPool.query(
      `SELECT identifier, is_active FROM sources WHERE identifier IN ($1,$2,$3,$4,$5) ORDER BY identifier`,
      [ruder, anthropic, meta, batch, bair],
    );
    expect(dead.rowCount).toBe(5);
    expect(dead.rows.every((r: { is_active: boolean }) => r.is_active === false)).toBe(true);

    const ms = await adminPool.query(`SELECT is_active FROM sources WHERE id = $1`, [microsoftId]);
    expect(ms.rows[0].is_active).toBe(true);

    const afterCount = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM sources WHERE identifier IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [oldGoogle, newGoogle, oldOpenAi, newOpenAi, ruder, anthropic, meta, batch, bair, microsoft],
    );
    expect(afterCount.rows[0].n).toBe(beforeCount.rows[0].n);

    const owned = await adminPool.query(
      `SELECT id, source_id FROM content WHERE id IN ($1,$2,$3) ORDER BY id`,
      [googleContent, openAiOldContent, openAiNewContent],
    );
    expect(owned.rows.find((r: { id: number }) => r.id === googleContent).source_id).toBe(googleId);
    expect(owned.rows.find((r: { id: number }) => r.id === openAiOldContent).source_id).toBe(openAiOldId);
    expect(owned.rows.find((r: { id: number }) => r.id === openAiNewContent).source_id).toBe(openAiNewId);
  });

  it('ContentStore.upsert stores a digest for oversized GUIDs and converges on re-fetch', async () => {
    assertCiPostgresTarget(connectionString);
    const { normalizeExternalId } = await import('../external-id');
    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'https://www.microsoft.com/en-us/research/feed/',
      authorName: 'Microsoft Research',
      category: 'independent',
    });
    const longId = `https://www.microsoft.com/en-us/research/publication/${'guid-'.repeat(60)}`;
    expect(Array.from(longId).length).toBeGreaterThan(255);
    const digest = normalizeExternalId(longId);

    const first = await contentStore.upsert({
      sourceId,
      externalId: longId,
      url: 'https://www.microsoft.com/en-us/research/blog/example',
      contentText: 'first fetch',
      publishedAt: new Date(),
    });
    const second = await contentStore.upsert({
      sourceId,
      externalId: `  ${longId}  `,
      url: 'https://www.microsoft.com/en-us/research/blog/example',
      contentText: 'second fetch',
      publishedAt: new Date(),
    });
    expect(second).toBe(first);

    const row = await adminPool.query(
      `SELECT external_id, content_text FROM content WHERE id = $1`,
      [first],
    );
    expect(row.rows[0].external_id).toBe(digest);
    expect(row.rows[0].external_id.length).toBeLessThanOrEqual(255);
    expect(row.rows[0].content_text).toBe('second fetch');

    const short = await contentStore.upsert({
      sourceId,
      externalId: '  msr-short  ',
      contentText: 'fits',
      publishedAt: new Date(),
    });
    const shortRow = await adminPool.query(`SELECT external_id FROM content WHERE id = $1`, [short]);
    expect(shortRow.rows[0].external_id).toBe('msr-short');
  });

  it('010 rewrites topics to the canonical 13, preserves raw spelling, and aligns linked predictions', async () => {
    assertCiPostgresTarget(connectionString);
    const m010 = MIGRATIONS.find((m) => m.version === '010');
    expect(m010).toBeDefined();

    await adminPool.query(`ALTER TABLE extracted_claims DROP CONSTRAINT IF EXISTS extracted_claims_topic_check`);
    await adminPool.query(`ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_topic_check`);

    const sourceId = await sourceStore.upsert({
      type: 'blog',
      identifier: 'https://example.com/ci/taxonomy',
      authorName: 'Taxonomy Fixture',
      category: 'independent',
    });
    const contentId = await contentStore.upsert({
      sourceId,
      externalId: 'tax-content-1',
      url: 'https://example.com/ci/taxonomy/1',
      contentText: 'taxonomy fixture body',
      publishedAt: new Date(),
    });

    await adminPool.query(
      `INSERT INTO extracted_claims (id, content_id, claim_text, topic, author_category)
       VALUES
         ('claim_tax_alias', $1, 'alignment is hard', 'AI safety', 'unknown'),
         ('claim_tax_canonical', $1, 'scaling continues', 'scaling', 'unknown'),
         ('claim_tax_unknown', $1, 'obscure subfield', 'not-a-real-topic-xyz', 'unknown')`,
      [contentId],
    );
    await adminPool.query(
      `INSERT INTO predictions (id, claim_id, text, author, confidence, timeframe, topic, made_at)
       VALUES
         ('pred_tax_linked', 'claim_tax_alias', 'linked', 'Tax', 0.5, 'near-term', 'mismatch-label', NOW()),
         ('pred_tax_standalone', NULL, 'standalone', 'Tax', 0.5, 'near-term', 'computer vision', NOW())`,
    );
    const synth = await adminPool.query(
      `INSERT INTO synthesis_results (generated_at, lookback_days, syntheses, hype_assessment)
       VALUES (NOW(), 7, $1::jsonb, '{}'::jsonb)
       RETURNING id, syntheses`,
      [JSON.stringify([{ topic: 'AI safety', summary: 'leave me' }])],
    );
    const synthId = synth.rows[0].id;
    const synthBefore = JSON.stringify(synth.rows[0].syntheses);
    const claimCountBefore = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM extracted_claims WHERE id LIKE 'claim_tax_%'`,
    );

    await adminPool.query(m010!.sql);
    await adminPool.query(m010!.sql);

    const claims = await adminPool.query(
      `SELECT id, topic, raw_topic FROM extracted_claims
       WHERE id IN ('claim_tax_alias','claim_tax_canonical','claim_tax_unknown')
       ORDER BY id`,
    );
    const byId = Object.fromEntries(
      claims.rows.map((row: { id: string; topic: string; raw_topic: string | null }) => [row.id, row]),
    );
    expect(byId.claim_tax_alias).toMatchObject({ topic: 'safety', raw_topic: 'AI safety' });
    expect(byId.claim_tax_canonical).toMatchObject({ topic: 'scaling', raw_topic: null });
    expect(byId.claim_tax_unknown).toMatchObject({ topic: 'other', raw_topic: 'not-a-real-topic-xyz' });

    const linked = await adminPool.query(
      `SELECT topic, raw_topic FROM predictions WHERE id = 'pred_tax_linked'`,
    );
    expect(linked.rows[0]).toMatchObject({ topic: 'safety', raw_topic: 'AI safety' });
    const standalone = await adminPool.query(
      `SELECT topic, raw_topic FROM predictions WHERE id = 'pred_tax_standalone'`,
    );
    expect(standalone.rows[0]).toMatchObject({ topic: 'multimodal', raw_topic: 'computer vision' });

    const claimCountAfter = await adminPool.query(
      `SELECT COUNT(*)::int AS n FROM extracted_claims WHERE id LIKE 'claim_tax_%'`,
    );
    expect(claimCountAfter.rows[0].n).toBe(claimCountBefore.rows[0].n);

    const synthAfter = await adminPool.query(
      `SELECT syntheses FROM synthesis_results WHERE id = $1`,
      [synthId],
    );
    expect(JSON.stringify(synthAfter.rows[0].syntheses)).toBe(synthBefore);

    await claimStore.upsert({
      id: 'claim_tax_newwrite',
      contentId,
      claimText: 'new write alias',
      claimType: 'opinion',
      topic: 'machine-learning' as never,
      stance: 'neutral',
      bullishness: 0.5,
      confidence: 0.5,
      authorCategory: 'unknown',
    });
    const written = await adminPool.query(
      `SELECT topic, raw_topic FROM extracted_claims WHERE id = 'claim_tax_newwrite'`,
    );
    expect(written.rows[0]).toMatchObject({ topic: 'general', raw_topic: 'machine-learning' });

    await expect(
      adminPool.query(
        `INSERT INTO extracted_claims (id, content_id, claim_text, topic, author_category)
         VALUES ('claim_tax_reject', $1, 'should fail', 'not-canonical', 'unknown')`,
        [contentId],
      ),
    ).rejects.toThrow();

    await expect(
      adminPool.query(
        `INSERT INTO extracted_claims (id, content_id, claim_text, topic, author_category)
         VALUES ('claim_tax_null', $1, 'null topic', NULL, 'unknown')`,
        [contentId],
      ),
    ).rejects.toThrow();

    await expect(
      adminPool.query(
        `INSERT INTO predictions (id, claim_id, text, author, confidence, timeframe, topic, made_at)
         VALUES ('pred_tax_null', NULL, 'null topic', 'Tax', 0.5, 'near-term', NULL, NOW())`,
      ),
    ).rejects.toThrow();
  });
});

/** Recovered 693c808 predictions DDL: VARCHAR status nullable, no default, no check, no claim_id unique. */
const RECOVERED_693C808_PREDICTIONS_DDL = `
CREATE TABLE predictions (
  id VARCHAR(100) PRIMARY KEY,
  claim_id VARCHAR(100) REFERENCES extracted_claims(id),
  text TEXT NOT NULL,
  author VARCHAR(255),
  confidence FLOAT,
  timeframe VARCHAR(50),
  topic VARCHAR(100),
  made_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  status VARCHAR(50),
  accuracy_score FLOAT,
  evidence TEXT
);
CREATE INDEX idx_predictions_status ON predictions(status);
CREATE INDEX idx_predictions_author ON predictions(author);
`.trim();

const RECOVERED_FIXTURE_PREDICTION_IDS = [
  'rec_null_status',
  'rec_dup_a',
  'rec_dup_b',
  'rec_clean_null',
  'rec_partial_null',
  'rec_partial_too_early',
  'rec_partial_pending_probe',
] as const;

const RECOVERED_FIXTURE_CLAIM_IDS = ['claim_rec_dup'] as const;

async function schemaMigrationsTableExists(pool: pg.Pool): Promise<boolean> {
  const row = await pool.query(
    `SELECT 1
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = 'schema_migrations'
       AND c.relkind = 'r'`,
  );
  return (row.rowCount ?? 0) > 0;
}

async function extractedClaimsHasClaimType(pool: pg.Pool): Promise<boolean> {
  const col = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'extracted_claims'
       AND column_name = 'claim_type'`,
  );
  return (col.rowCount ?? 0) > 0;
}

async function cleanupRecoveredFixtures(pool: pg.Pool): Promise<void> {
  const predictionsExist = await pool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'predictions'`,
  );
  if ((predictionsExist.rowCount ?? 0) > 0) {
    await pool.query(`DELETE FROM predictions WHERE id = ANY($1::text[])`, [
      [...RECOVERED_FIXTURE_PREDICTION_IDS],
    ]);
  }
  const claimsExist = await pool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'extracted_claims'`,
  );
  if ((claimsExist.rowCount ?? 0) > 0) {
    await pool.query(`DELETE FROM extracted_claims WHERE id = ANY($1::text[])`, [
      [...RECOVERED_FIXTURE_CLAIM_IDS],
    ]);
  }
}

async function restoreFullyMigratedCatalog(
  pool: pg.Pool,
  connectionString: string,
): Promise<void> {
  assertCiPostgresTarget(connectionString);
  await cleanupRecoveredFixtures(pool);
  // The partial-upgrade test pre-registers 001 without applying it, so the
  // recovered table can lack 001-owned columns (updated_at, due_at, ...) while
  // schema_migrations claims they exist. initializeDatabase alone cannot heal
  // that drift (CREATE TABLE IF NOT EXISTS no-ops; recorded migrations skip),
  // so restore must rebuild predictions from the current bootstrap DDL and
  // replay every migration from an empty schema_migrations.
  await pool.query(`DROP TABLE IF EXISTS schema_migrations`);
  await pool.query(`DROP TABLE IF EXISTS predictions CASCADE`);
  await initializeDatabase(connectionString, 768);
}

async function installRecovered693c808Predictions(pool: pg.Pool): Promise<void> {
  await cleanupRecoveredFixtures(pool);
  await pool.query(`DROP TABLE IF EXISTS schema_migrations`);
  await pool.query(`DROP TABLE IF EXISTS predictions CASCADE`);
  await pool.query(RECOVERED_693C808_PREDICTIONS_DDL);
}

async function predictionsStatusColumn(pool: pg.Pool): Promise<{
  column_default: string | null;
  is_nullable: string;
}> {
  const col = await pool.query(
    `SELECT column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'predictions'
       AND column_name = 'status'`,
  );
  return col.rows[0];
}

async function predictionsStatusCheckDef(pool: pg.Pool): Promise<string | null> {
  const row = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conname = 'predictions_status_check'
       AND conrelid = to_regclass(format('%I.predictions', current_schema()))`,
  );
  return row.rows[0]?.def ?? null;
}

async function predictionsClaimUniqueExists(pool: pg.Pool): Promise<boolean> {
  const row = await pool.query(
    `SELECT 1
     FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'predictions'
       AND indexname = 'predictions_claim_id_unique'`,
  );
  return (row.rowCount ?? 0) > 0;
}

describeIntegration('postgres.integration recovered 693c808 upgrade', () => {
  const connectionString = process.env.DATABASE_URL || '';
  let adminPool: pg.Pool;

  beforeAll(async () => {
    if (!connectionString) {
      throw new Error('DATABASE_URL required when RUN_POSTGRES_INTEGRATION=1');
    }
    assertCiPostgresTarget(connectionString);
    adminPool = new pg.Pool({ connectionString });
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await initializeDatabase(connectionString, 768);
    expect(await extractedClaimsHasClaimType(adminPool)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    try {
      if (adminPool) {
        await restoreFullyMigratedCatalog(adminPool, connectionString);
      }
    } finally {
      try {
        if (adminPool) await adminPool.end();
      } catch {
        // ignore pool close errors
      }
    }
  });

  it('upgrades a recovered 693c808 predictions table with a NULL status row through 001-003+', async () => {
    assertCiPostgresTarget(connectionString);
    expect(await extractedClaimsHasClaimType(adminPool)).toBe(true);
    await installRecovered693c808Predictions(adminPool);

    const preCol = await predictionsStatusColumn(adminPool);
    expect(preCol.column_default).toBeNull();
    expect(preCol.is_nullable).toBe('YES');
    expect(await predictionsStatusCheckDef(adminPool)).toBeNull();
    expect(await predictionsClaimUniqueExists(adminPool)).toBe(false);
    expect(await schemaMigrationsTableExists(adminPool)).toBe(false);

    await adminPool.query(
      `INSERT INTO predictions (id, text, author, made_at, status)
       VALUES ('rec_null_status', 'legacy recovered row', 'Recovered', NOW(), NULL)`,
    );

    await initializeDatabase(connectionString, 768);

    const versions = await adminPool.query(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    const applied = versions.rows.map((r: { version: string }) => r.version);
    expect(applied.slice(0, 3)).toEqual(['001', '002', '003']);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));

    const row = await adminPool.query(
      `SELECT status FROM predictions WHERE id = 'rec_null_status'`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].status).toBe('pending');

    const postCol = await predictionsStatusColumn(adminPool);
    expect(String(postCol.column_default)).toMatch(/pending/);
    expect(postCol.is_nullable).toBe('NO');

    const checkDef = await predictionsStatusCheckDef(adminPool);
    expect(checkDef).toBeTruthy();
    expect(checkDef).toMatch(/pending/);
    expect(checkDef).not.toMatch(/IS NULL/i);
    expect(await predictionsClaimUniqueExists(adminPool)).toBe(true);
  });

  it('fails closed on recovered duplicate claim_id, then restores a duplicate-free catalog', async () => {
    assertCiPostgresTarget(connectionString);
    expect(await extractedClaimsHasClaimType(adminPool)).toBe(true);
    await installRecovered693c808Predictions(adminPool);

    await adminPool.query(`DELETE FROM extracted_claims WHERE id = $1`, ['claim_rec_dup']);
    await adminPool.query(
      `INSERT INTO extracted_claims (id, claim_text, topic)
       VALUES ('claim_rec_dup', 'recovered duplicate claim', 'other')`,
    );
    await adminPool.query(
      `INSERT INTO predictions (id, claim_id, text, author, made_at, status)
       VALUES
         ('rec_dup_a', 'claim_rec_dup', 'row a', 'Recovered', NOW(), NULL),
         ('rec_dup_b', 'claim_rec_dup', 'row b', 'Recovered', NOW(), NULL)`,
    );

    const before = await adminPool.query(
      `SELECT id, claim_id, text, status FROM predictions WHERE id IN ('rec_dup_a', 'rec_dup_b') ORDER BY id`,
    );
    expect(before.rowCount).toBe(2);
    expect(await predictionsClaimUniqueExists(adminPool)).toBe(false);

    await expect(initializeDatabase(connectionString, 768)).rejects.toThrow(
      /duplicate non-null predictions\.claim_id/i,
    );

    const after = await adminPool.query(
      `SELECT id, claim_id, text, status FROM predictions WHERE id IN ('rec_dup_a', 'rec_dup_b') ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);

    const recorded003 = await adminPool.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      ['003'],
    );
    expect(recorded003.rowCount).toBe(0);
    expect(await predictionsClaimUniqueExists(adminPool)).toBe(false);

    await adminPool.query(`DELETE FROM predictions WHERE id IN ('rec_dup_a', 'rec_dup_b')`);
    await adminPool.query(
      `INSERT INTO predictions (id, text, author, made_at, status)
       VALUES ('rec_clean_null', 'duplicate-free recovered row', 'Recovered', NOW(), NULL)`,
    );
    await initializeDatabase(connectionString, 768);

    const versions = await adminPool.query(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(versions.rows.map((r: { version: string }) => r.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );
    const clean = await adminPool.query(
      `SELECT status FROM predictions WHERE id = 'rec_clean_null'`,
    );
    expect(clean.rows[0].status).toBe('pending');
    const checkDef = await predictionsStatusCheckDef(adminPool);
    expect(checkDef).toMatch(/pending/);
    expect(checkDef).not.toMatch(/IS NULL/i);
    expect(await predictionsClaimUniqueExists(adminPool)).toBe(true);
  });

  it('recovers when 001 is already recorded with the old status check that excludes pending', async () => {
    assertCiPostgresTarget(connectionString);
    expect(await extractedClaimsHasClaimType(adminPool)).toBe(true);
    await installRecovered693c808Predictions(adminPool);

    await adminPool.query(`
      ALTER TABLE predictions
        ADD CONSTRAINT predictions_status_check
        CHECK (
          status IS NULL OR status IN (
            'too-early',
            'verified',
            'falsified',
            'partially-verified'
          )
        )
    `);
    await adminPool.query(`
      CREATE TABLE schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await adminPool.query(
      `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
      ['001', 'predictions_ledger'],
    );

    const oldCheck = await predictionsStatusCheckDef(adminPool);
    expect(oldCheck).toMatch(/IS NULL/i);
    expect(oldCheck).not.toMatch(/pending/i);

    await expect(
      adminPool.query(
        `INSERT INTO predictions (id, text, author, made_at, status)
         VALUES ('rec_partial_pending_probe', 'pending illegal under old 001', 'Recovered', NOW(), 'pending')`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await adminPool.query(
      `INSERT INTO predictions (id, text, author, made_at, status)
       VALUES
         ('rec_partial_null', 'legacy null under old 001', 'Recovered', NOW(), NULL),
         ('rec_partial_too_early', 'legacy too-early under old 001', 'Recovered', NOW(), 'too-early')`,
    );

    await initializeDatabase(connectionString, 768);

    const versions = await adminPool.query(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    const applied = versions.rows.map((r: { version: string }) => r.version);
    expect(applied).toContain('001');
    expect(applied).toContain('003');
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));

    const rows = await adminPool.query(
      `SELECT id, status FROM predictions
       WHERE id IN ('rec_partial_null', 'rec_partial_too_early')
       ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: 'rec_partial_null', status: 'pending' },
      { id: 'rec_partial_too_early', status: 'too-early' },
    ]);

    const checkDef = await predictionsStatusCheckDef(adminPool);
    expect(checkDef).toMatch(/pending/);
    expect(checkDef).not.toMatch(/IS NULL/i);
    expect(await predictionsClaimUniqueExists(adminPool)).toBe(true);

    const postCol = await predictionsStatusColumn(adminPool);
    expect(String(postCol.column_default)).toMatch(/pending/);
    expect(postCol.is_nullable).toBe('NO');

    await adminPool.query(
      `INSERT INTO predictions (id, text, author, made_at, status, topic)
       VALUES ('rec_partial_pending_probe', 'pending allowed after 003', 'Recovered', NOW(), 'pending', 'other')`,
    );
  });
});

describeIntegration('postgres.integration migration checksums', () => {
  const connectionString = process.env.DATABASE_URL || '';
  let adminPool: pg.Pool;

  beforeAll(async () => {
    if (!connectionString) {
      throw new Error('DATABASE_URL required when RUN_POSTGRES_INTEGRATION=1');
    }
    assertCiPostgresTarget(connectionString);
    adminPool = new pg.Pool({ connectionString });
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await initializeDatabase(connectionString, 768);
  }, 60_000);

  afterAll(async () => {
    try {
      if (adminPool) {
        await restoreFullyMigratedCatalog(adminPool, connectionString);
      }
    } finally {
      try {
        if (adminPool) await adminPool.end();
      } catch {
        // ignore pool close errors
      }
    }
  }, 60_000);

  async function installLegacyCatalog(
    rows: Array<{ version: string; name: string }>,
  ): Promise<void> {
    await adminPool.query(`DROP TABLE IF EXISTS schema_migrations`);
    await adminPool.query(`
      CREATE TABLE schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const row of rows) {
      await adminPool.query(
        `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
        [row.version, row.name],
      );
    }
  }

  it('backfills checksums for recovered 001-009 rows and applies pending 010', async () => {
    assertCiPostgresTarget(connectionString);
    const recovered = MIGRATIONS.filter((migration) => migration.version <= '009');
    expect(recovered.map((m) => m.version)).toEqual([
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
    ]);
    expect(MIGRATIONS.at(-1)?.version).toBe('010');
    await installLegacyCatalog(recovered.map((m) => ({ version: m.version, name: m.name })));

    await applyMigrations(adminPool);

    const col = await adminPool.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'schema_migrations'
         AND column_name = 'checksum'`,
    );
    expect(col.rowCount).toBe(1);
    expect(col.rows[0].is_nullable).toBe('YES');

    const rows = await adminPool.query(
      `SELECT version, name, checksum FROM schema_migrations ORDER BY version`,
    );
    expect(rows.rows.map((r: { version: string }) => r.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );
    for (const migration of MIGRATIONS) {
      const row = rows.rows.find((r: { version: string }) => r.version === migration.version);
      expect(row).toEqual({
        version: migration.version,
        name: migration.name,
        checksum: migrationChecksum(migration.sql),
      });
    }
  });

  it('fails closed on recovered name mismatch without overwriting the recorded name', async () => {
    assertCiPostgresTarget(connectionString);
    const first = MIGRATIONS[0];
    await installLegacyCatalog([
      { version: first.version, name: 'not_the_manifest_name' },
      ...MIGRATIONS.slice(1).map((m) => ({ version: m.version, name: m.name })),
    ]);

    await expect(applyMigrations(adminPool)).rejects.toThrow(/name mismatch/i);

    const rows = await adminPool.query(
      `SELECT version, name, checksum FROM schema_migrations WHERE version = $1`,
      [first.version],
    );
    expect(rows.rows).toEqual([
      { version: first.version, name: 'not_the_manifest_name', checksum: null },
    ]);
  });

  it('fails closed on checksum mismatch before pending migration SQL', async () => {
    assertCiPostgresTarget(connectionString);
    await adminPool.query(`DROP TABLE IF EXISTS schema_migrations`);
    await adminPool.query(`DROP TABLE IF EXISTS checksum_probe_should_not_exist`);
    await adminPool.query(`
      CREATE TABLE schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum VARCHAR(64)
      )
    `);
    await adminPool.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
      ['001', 'one', '0'.repeat(64)],
    );

    await expect(
      applyMigrations(adminPool, [
        { version: '001', name: 'one', sql: 'SELECT 1' },
        {
          version: '002',
          name: 'two',
          sql: 'CREATE TABLE checksum_probe_should_not_exist (id INT)',
        },
      ]),
    ).rejects.toThrow(/checksum mismatch/i);

    const probe = await adminPool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'checksum_probe_should_not_exist'`,
    );
    expect(probe.rowCount).toBe(0);
  });

  it('fails closed when the database has an applied version absent from the manifest', async () => {
    assertCiPostgresTarget(connectionString);
    await installLegacyCatalog([
      ...MIGRATIONS.map((m) => ({ version: m.version, name: m.name })),
      { version: '099', name: 'orphan' },
    ]);

    await expect(applyMigrations(adminPool)).rejects.toThrow(
      /unknown applied migration version/i,
    );

    const orphan = await adminPool.query(
      `SELECT version, name FROM schema_migrations WHERE version = $1`,
      ['099'],
    );
    expect(orphan.rows).toEqual([{ version: '099', name: 'orphan' }]);
  });

  it('stores checksum with newly applied migrations', async () => {
    assertCiPostgresTarget(connectionString);
    await restoreFullyMigratedCatalog(adminPool, connectionString);
    const rows = await adminPool.query(
      `SELECT version, name, checksum FROM schema_migrations ORDER BY version`,
    );
    expect(rows.rows).toEqual(
      MIGRATIONS.map((m) => ({
        version: m.version,
        name: m.name,
        checksum: migrationChecksum(m.sql),
      })),
    );
  });
});

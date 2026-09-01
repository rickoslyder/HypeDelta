/**
 * Versioned PostgreSQL migration runner.
 *
 * Unit tests mock pg. Real concurrent/rollback gates live in
 * postgres.integration.test.ts (RUN_POSTGRES_INTEGRATION=1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryLog: string[] = [];
const clientQuery = vi.fn();
const clientRelease = vi.fn();
const poolEnd = vi.fn();
const poolQuery = vi.fn();
const poolConnect = vi.fn();

vi.mock('pg', () => {
  const MockPool = vi.fn(() => ({
    query: poolQuery,
    connect: poolConnect,
    end: poolEnd,
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

describe('runMigrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryLog.length = 0;
    poolEnd.mockResolvedValue(undefined);
    clientRelease.mockReturnValue(undefined);
    poolConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    });
  });

  it('applies pending migrations in version order and records each in schema_migrations once', async () => {
    const applied = new Set<string>();
    clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      queryLog.push(typeof sql === 'string' ? sql : String(sql));
      const text = String(sql);
      if (/SELECT version FROM schema_migrations/i.test(text)) {
        return { rows: [...applied].map((version) => ({ version })) };
      }
      if (/INSERT INTO schema_migrations/i.test(text)) {
        applied.add(String(params?.[0]));
        return { rows: [] };
      }
      return { rows: [] };
    });

    const { runMigrations, MIGRATIONS } = await import('../migrations/runner');
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort());

    await runMigrations('postgresql://localhost/test');

    const recorded = queryLog.filter((s) => /INSERT INTO schema_migrations/i.test(s));
    expect(recorded).toHaveLength(MIGRATIONS.length);
    for (const migration of MIGRATIONS) {
      expect(queryLog.some((s) => s.includes(migration.sql.trim().slice(0, 24)))).toBe(true);
    }
    expect(clientRelease).toHaveBeenCalledTimes(1);
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it('re-running migrations is a no-op when every version is already recorded', async () => {
    const { runMigrations, MIGRATIONS, migrationChecksum } = await import('../migrations/runner');
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(String(sql));
      if (/SELECT version.*FROM schema_migrations/i.test(String(sql))) {
        return {
          rows: MIGRATIONS.map((m) => ({
            version: m.version,
            name: m.name,
            checksum: migrationChecksum(m.sql),
          })),
        };
      }
      return { rows: [] };
    });

    await runMigrations('postgresql://localhost/test');

    expect(queryLog.some((s) => /INSERT INTO schema_migrations/i.test(s))).toBe(false);
    for (const migration of MIGRATIONS) {
      expect(queryLog.some((s) => s.includes(migration.sql.trim().slice(0, 24)))).toBe(false);
    }
  });

  it('rolls back a failed migration and does not record it as applied', async () => {
    const { runMigrations, MIGRATIONS } = await import('../migrations/runner');
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(String(sql));
      const text = String(sql);
      if (/SELECT version FROM schema_migrations/i.test(text)) {
        return { rows: [] };
      }
      if (text.includes(MIGRATIONS[0].sql.trim().slice(0, 24))) {
        throw new Error('migration boom');
      }
      return { rows: [] };
    });

    await expect(runMigrations('postgresql://localhost/test')).rejects.toThrow('migration boom');

    expect(queryLog).toContain('BEGIN');
    expect(queryLog).toContain('ROLLBACK');
    expect(queryLog).not.toContain('COMMIT');
    expect(queryLog.some((s) => /INSERT INTO schema_migrations/i.test(s))).toBe(false);
    expect(clientRelease).toHaveBeenCalledTimes(1);
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it('holds a session advisory lock for the duration of apply and unlocks after', async () => {
    const { runMigrations, MIGRATION_LOCK_KEY } = await import('../migrations/runner');
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(String(sql));
      if (/SELECT version FROM schema_migrations/i.test(String(sql))) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await runMigrations('postgresql://localhost/test');

    const lockIdx = queryLog.findIndex((s) => /pg_advisory_lock/i.test(s));
    const unlockIdx = queryLog.findIndex((s) => /pg_advisory_unlock/i.test(s));
    const beginIdx = queryLog.findIndex((s) => s === 'BEGIN');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(unlockIdx).toBeGreaterThan(lockIdx);
    expect(beginIdx).toBeGreaterThan(lockIdx);
    expect(clientQuery.mock.calls[lockIdx][1]).toEqual([MIGRATION_LOCK_KEY]);
    expect(clientQuery.mock.calls[unlockIdx][1]).toEqual([MIGRATION_LOCK_KEY]);
  });

  it('catalog SQL is additive (no DROP TABLE / DROP COLUMN)', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    for (const migration of MIGRATIONS) {
      expect(migration.sql).not.toMatch(/DROP\s+TABLE/i);
      expect(migration.sql).not.toMatch(/DROP\s+COLUMN/i);
    }
  });

  it('backfill inserts prediction claims without fabricating or overwriting outcomes', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const backfill = MIGRATIONS.find((m) => m.version === '002');
    expect(backfill).toBeDefined();
    expect(backfill!.sql).toMatch(/claim_type\s*=\s*'prediction'/i);
    expect(backfill!.sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
    expect(backfill!.sql).not.toMatch(/\bstatus\b/);
    expect(backfill!.sql).not.toMatch(/accuracy_score/);
    expect(backfill!.sql).not.toMatch(/verified_at/);
    expect(backfill!.sql).not.toMatch(/outcome_summary/);
    expect(backfill!.sql).not.toMatch(/evidence_url/);
    expect(backfill!.sql).toMatch(/pred_' \|\| md5\(/);
  });
});

describe('initializeDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryLog.length = 0;
    poolEnd.mockResolvedValue(undefined);
    poolQuery.mockImplementation(async (sql: string) => {
      queryLog.push(`pool:${String(sql)}`);
      return { rows: [] };
    });
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(`client:${String(sql)}`);
      if (/SELECT version FROM schema_migrations/i.test(String(sql))) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    clientRelease.mockReturnValue(undefined);
    poolConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    });
  });

  it('bootstraps with CREATE TABLE IF NOT EXISTS then applies migrations on the same pool', async () => {
    const { initializeDatabase } = await import('../storage');
    await initializeDatabase('postgresql://localhost/test', 768);

    const bootstrap = queryLog.filter((s) => s.startsWith('pool:')).join('\n');
    expect(bootstrap).toMatch(/CREATE TABLE IF NOT EXISTS predictions/i);
    expect(bootstrap).not.toMatch(/DROP TABLE/i);
    expect(queryLog.some((s) => /pg_advisory_lock/i.test(s))).toBe(true);
    expect(queryLog.some((s) => /INSERT INTO schema_migrations/i.test(s))).toBe(true);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('ends the bootstrap pool when migrations fail', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(`client:${String(sql)}`);
      const text = String(sql);
      if (/pg_advisory_(un)?lock/i.test(text)) return { rows: [] };
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(text)) return { rows: [] };
      if (text === 'ROLLBACK' || text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
      throw new Error('migrate fail');
    });
    const { initializeDatabase } = await import('../storage');
    await expect(initializeDatabase('postgresql://localhost/test', 768)).rejects.toThrow('migrate fail');
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('fresh-install bootstrap defaults status to pending and allows the closed status set', async () => {
    const { initializeDatabase } = await import('../storage');
    await initializeDatabase('postgresql://localhost/test', 768);

    const bootstrap = queryLog.filter((s) => s.startsWith('pool:')).join('\n');
    expect(bootstrap).toMatch(/status\s+VARCHAR\(50\)\s+NOT NULL\s+DEFAULT\s+'pending'/i);
    expect(bootstrap).toMatch(/CONSTRAINT\s+predictions_status_check\s+CHECK\s*\(/i);
    expect(bootstrap).toMatch(/'pending'/);
    expect(bootstrap).toMatch(/'too-early'/);
    expect(bootstrap).toMatch(/'verified'/);
    expect(bootstrap).toMatch(/'falsified'/);
    expect(bootstrap).toMatch(/'partially-verified'/);
    expect(bootstrap).not.toMatch(/status\s+IS\s+NULL\s+OR\s+status\s+IN/i);
    expect(bootstrap).not.toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS \S+\s+ON predictions\s*\(\s*claim_id\s*\)\s*WHERE\s+claim_id\s+IS NOT NULL/i,
    );
    expect(bootstrap).not.toMatch(/predictions_claim_id_unique/i);
    expect(bootstrap).not.toMatch(/idx_predictions_due_at/i);
  });
});

describe('migration manifest validation', () => {
  const fakePool = () =>
    ({
      connect: poolConnect,
      query: poolQuery,
      end: poolEnd,
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    queryLog.length = 0;
    poolEnd.mockResolvedValue(undefined);
    clientRelease.mockReturnValue(undefined);
    poolConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    });
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(typeof sql === 'string' ? sql : String(sql));
      return { rows: [] };
    });
  });

  it('rejects duplicate versions before connecting or applying SQL', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    const bad = [
      { version: '010', name: 'one', sql: 'SELECT 101' },
      { version: '010', name: 'two', sql: 'SELECT 102' },
    ];

    await expect(applyMigrations(fakePool(), bad)).rejects.toThrow(/duplicate/i);

    expect(poolConnect).not.toHaveBeenCalled();
    expect(queryLog.some((s) => /SELECT 101|SELECT 102/.test(s))).toBe(false);
    expect(queryLog).not.toContain('BEGIN');
  });

  it('rejects out-of-order versions before connecting or applying SQL', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    const bad = [
      { version: '002', name: 'later', sql: 'SELECT 99' },
      { version: '001', name: 'earlier', sql: 'SELECT 88' },
    ];

    await expect(applyMigrations(fakePool(), bad)).rejects.toThrow(/order/i);

    expect(poolConnect).not.toHaveBeenCalled();
    expect(queryLog.some((s) => /SELECT 99|SELECT 88/.test(s))).toBe(false);
    expect(queryLog).not.toContain('BEGIN');
  });

  it('rejects blank versions before connecting or applying SQL', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    const bad = [
      { version: '   ', name: 'blank', sql: 'SELECT 77' },
    ];

    await expect(applyMigrations(fakePool(), bad)).rejects.toThrow(/blank|nonblank|empty/i);

    expect(poolConnect).not.toHaveBeenCalled();
    expect(queryLog.some((s) => s.includes('SELECT 77'))).toBe(false);
  });

  it('rejects blank names before connecting or applying SQL', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    const bad = [{ version: '001', name: '   ', sql: 'SELECT 66' }];

    await expect(applyMigrations(fakePool(), bad)).rejects.toThrow(/name.*blank|nonblank|empty/i);

    expect(poolConnect).not.toHaveBeenCalled();
    expect(queryLog.some((s) => s.includes('SELECT 66'))).toBe(false);
  });
});

describe('migration checksum integrity', () => {
  const fakePool = () =>
    ({
      connect: poolConnect,
      query: poolQuery,
      end: poolEnd,
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    queryLog.length = 0;
    poolEnd.mockResolvedValue(undefined);
    clientRelease.mockReturnValue(undefined);
    poolConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    });
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(typeof sql === 'string' ? sql : String(sql));
      return { rows: [] };
    });
  });

  it('hashes exact SQL bytes as 64 lowercase hex SHA-256', async () => {
    const { createHash } = await import('node:crypto');
    const { migrationChecksum } = await import('../migrations/runner');
    const sql = 'SELECT 1;\n-- café';
    const expected = createHash('sha256').update(sql, 'utf8').digest('hex');
    expect(migrationChecksum(sql)).toBe(expected);
    expect(migrationChecksum(sql)).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum(`${sql} `)).not.toBe(migrationChecksum(sql));
  });

  it('adds a nullable checksum column for recovered schema_migrations tables', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    await applyMigrations(fakePool(), [{ version: '001', name: 'one', sql: 'SELECT 1' }]);

    const create = queryLog.find((s) => /CREATE TABLE IF NOT EXISTS schema_migrations/i.test(s));
    expect(create).toBeDefined();
    expect(create).toMatch(/checksum\s+VARCHAR\(64\)/i);
    expect(create).not.toMatch(/checksum\s+VARCHAR\(64\)\s+NOT NULL/i);
    expect(queryLog.some((s) => /ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum/i.test(s))).toBe(
      true,
    );
  });

  it('inserts version, name, and checksum in the same transaction as the migration SQL', async () => {
    const { applyMigrations, migrationChecksum } = await import('../migrations/runner');
    const migration = { version: '001', name: 'one', sql: 'SELECT 42' };
    await applyMigrations(fakePool(), [migration]);

    const beginIdx = queryLog.findIndex((s) => s === 'BEGIN');
    const sqlIdx = queryLog.findIndex((s) => s === migration.sql);
    const insertIdx = queryLog.findIndex((s) => /INSERT INTO schema_migrations/i.test(s));
    const commitIdx = queryLog.findIndex((s) => s === 'COMMIT');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(sqlIdx).toBeGreaterThan(beginIdx);
    expect(insertIdx).toBeGreaterThan(sqlIdx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
    expect(clientQuery.mock.calls[insertIdx][1]).toEqual([
      '001',
      'one',
      migrationChecksum(migration.sql),
    ]);
  });

  it('backfills NULL checksums when recorded names match the manifest', async () => {
    const { applyMigrations, migrationChecksum } = await import('../migrations/runner');
    const migration = { version: '001', name: 'one', sql: 'SELECT 7' };
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(typeof sql === 'string' ? sql : String(sql));
      if (/SELECT version.*FROM schema_migrations/i.test(String(sql))) {
        return { rows: [{ version: '001', name: 'one', checksum: null }] };
      }
      return { rows: [] };
    });

    await applyMigrations(fakePool(), [migration]);

    expect(queryLog.some((s) => s === migration.sql)).toBe(false);
    expect(queryLog.some((s) => /INSERT INTO schema_migrations/i.test(s))).toBe(false);
    const updateIdx = queryLog.findIndex((s) => /UPDATE schema_migrations SET checksum/i.test(s));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(clientQuery.mock.calls[updateIdx][1]).toEqual([migrationChecksum(migration.sql), '001']);
  });

  it('fails closed on NULL checksum name mismatch without overwriting evidence', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    const catalog = [
      { version: '001', name: 'one', sql: 'SELECT 7' },
      { version: '002', name: 'two', sql: 'SELECT 8' },
    ];
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(typeof sql === 'string' ? sql : String(sql));
      if (/SELECT version.*FROM schema_migrations/i.test(String(sql))) {
        return { rows: [{ version: '001', name: 'other', checksum: null }] };
      }
      return { rows: [] };
    });

    await expect(applyMigrations(fakePool(), catalog)).rejects.toThrow(/name mismatch/i);

    expect(queryLog.some((s) => /UPDATE schema_migrations/i.test(s))).toBe(false);
    expect(queryLog.some((s) => s === 'SELECT 7' || s === 'SELECT 8')).toBe(false);
    expect(queryLog.some((s) => /INSERT INTO schema_migrations/i.test(s))).toBe(false);
    expect(queryLog).not.toContain('BEGIN');
  });

  it('fails closed on checksum mismatch before applying pending migrations', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    const catalog = [
      { version: '001', name: 'one', sql: 'SELECT 7' },
      { version: '002', name: 'two', sql: 'SELECT 8' },
    ];
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(typeof sql === 'string' ? sql : String(sql));
      if (/SELECT version.*FROM schema_migrations/i.test(String(sql))) {
        return {
          rows: [{ version: '001', name: 'one', checksum: '0'.repeat(64) }],
        };
      }
      return { rows: [] };
    });

    await expect(applyMigrations(fakePool(), catalog)).rejects.toThrow(/checksum mismatch/i);

    expect(queryLog.some((s) => s === 'SELECT 7' || s === 'SELECT 8')).toBe(false);
    expect(queryLog.some((s) => /INSERT INTO schema_migrations/i.test(s))).toBe(false);
    expect(queryLog).not.toContain('BEGIN');
  });

  it('fails closed when an applied version is absent from the manifest', async () => {
    const { applyMigrations } = await import('../migrations/runner');
    const catalog = [{ version: '001', name: 'one', sql: 'SELECT 7' }];
    clientQuery.mockImplementation(async (sql: string) => {
      queryLog.push(typeof sql === 'string' ? sql : String(sql));
      if (/SELECT version.*FROM schema_migrations/i.test(String(sql))) {
        return { rows: [{ version: '099', name: 'ghost', checksum: null }] };
      }
      return { rows: [] };
    });

    await expect(applyMigrations(fakePool(), catalog)).rejects.toThrow(
      /unknown applied migration version|orphan/i,
    );

    expect(queryLog.some((s) => s === 'SELECT 7')).toBe(false);
    expect(queryLog.some((s) => /INSERT INTO schema_migrations/i.test(s))).toBe(false);
    expect(queryLog).not.toContain('BEGIN');
  });
});

describe('003 predictions ledger integrity', () => {
  it('is the next numbered additive migration after 002', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    expect(MIGRATIONS.map((m) => m.version).slice(0, 3)).toEqual(['001', '002', '003']);
    expect(MIGRATIONS[0].sql).toMatch(/status IS NULL OR status IN/);
    expect(MIGRATIONS[1].sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
  });

  it('001 fresh/recovered path allows pending and NULL with a table-scoped check', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const sql = MIGRATIONS[0].sql;
    expect(sql).toMatch(/status IS NULL OR status IN/i);
    expect(sql).toMatch(/'pending'/);
    expect(sql).toMatch(/'too-early'/);
    expect(sql).toMatch(/'verified'/);
    expect(sql).toMatch(/'falsified'/);
    expect(sql).toMatch(/'partially-verified'/);
    expect(sql).toMatch(/conrelid\s*=\s*to_regclass\(format\('%I\.predictions',\s*current_schema\(\)\)\)/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+predictions/i);
  });

  it('fails closed on duplicate non-null claim_id without deleting rows', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const m003 = MIGRATIONS.find((m) => m.version === '003');
    expect(m003).toBeDefined();
    expect(m003!.sql).toMatch(/RAISE EXCEPTION/i);
    expect(m003!.sql).toMatch(/claim_id\s+IS\s+NOT\s+NULL/i);
    expect(m003!.sql).toMatch(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
    expect(m003!.sql).not.toMatch(/DELETE\s+FROM\s+predictions/i);
    expect(m003!.sql).not.toMatch(/DISTINCT\s+ON\s*\(\s*claim_id\s*\)/i);
  });

  it('creates a partial unique index on non-null claim_id', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const m003 = MIGRATIONS.find((m) => m.version === '003');
    expect(m003).toBeDefined();
    expect(m003!.sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS \S+\s+ON predictions\s*\(\s*claim_id\s*\)\s*WHERE\s+claim_id\s+IS NOT NULL/i,
    );
    expect(m003!.sql).toMatch(/predictions_claim_id_unique/);
    const m001 = MIGRATIONS.find((m) => m.version === '001');
    expect(m001!.sql).toMatch(/idx_predictions_due_at/);
    expect(m001!.sql).not.toMatch(/predictions_claim_id_unique/);
  });

  it('makes pending explicit and replaces the status check with a table-scoped closed set', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const m003 = MIGRATIONS.find((m) => m.version === '003');
    expect(m003).toBeDefined();
    const sql = m003!.sql;
    const dropIdx = sql.search(/DROP CONSTRAINT\s+predictions_status_check/i);
    const updateIdx = sql.search(
      /UPDATE\s+predictions\s+SET\s+status\s*=\s*'pending'\s+WHERE\s+status\s+IS\s+NULL/i,
    );
    const defaultIdx = sql.search(/ALTER COLUMN status SET DEFAULT 'pending'/i);
    const notNullIdx = sql.search(/ALTER COLUMN status SET NOT NULL/i);
    const addIdx = sql.search(/ADD CONSTRAINT\s+predictions_status_check/i);
    expect(dropIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(dropIdx);
    expect(defaultIdx).toBeGreaterThan(updateIdx);
    expect(notNullIdx).toBeGreaterThan(defaultIdx);
    expect(addIdx).toBeGreaterThan(notNullIdx);
    expect(sql).toMatch(/conrelid\s*=\s*to_regclass\(format\('%I\.predictions',\s*current_schema\(\)\)\)/i);
    expect(sql).toMatch(/'pending'/);
    expect(sql).toMatch(/'too-early'/);
    expect(sql).toMatch(/'verified'/);
    expect(sql).toMatch(/'falsified'/);
    expect(sql).toMatch(/'partially-verified'/);
    expect(sql).not.toMatch(/status IS NULL OR status IN/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+predictions/i);
    expect(sql).toMatch(/pg_constraint/i);
  });
});

describe('004 author-role vocabulary', () => {
  it('is additive, idempotent, and generated from the shared author-side module', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const { authorRoleCheckSql, authorRoleNormalizeSql, AUTHOR_ROLES } = await import('../author-side');
    expect(MIGRATIONS.map((m) => m.version).slice(0, 5)).toEqual(['001', '002', '003', '004', '005']);
    const m004 = MIGRATIONS.find((m) => m.version === '004');
    expect(m004).toBeDefined();
    const sql = m004!.sql;
    expect(sql).toContain(authorRoleNormalizeSql());
    expect(sql).toContain(authorRoleCheckSql());
    for (const role of AUTHOR_ROLES) {
      expect(sql).toContain(`'${role}'`);
    }
    expect(sql).toMatch(/extracted_claims_author_category_check/);
    expect(sql).toMatch(/IF NOT EXISTS/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+extracted_claims/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/author_category\s*=\s*'lab-researcher'\s+WHERE\s+author_category\s*=\s*'unknown'/i);
  });

  it('maps unambiguous org tokens and sends unrecognized tokens to unknown', async () => {
    const { normalizeLegacyStoredRole } = await import('../author-side');
    expect(normalizeLegacyStoredRole('anthropic')).toBe('lab-researcher');
    expect(normalizeLegacyStoredRole('openai')).toBe('lab-researcher');
    expect(normalizeLegacyStoredRole('critics')).toBe('critic');
    expect(normalizeLegacyStoredRole('lab-researcher')).toBe('lab-researcher');
    expect(normalizeLegacyStoredRole('unknown')).toBe('unknown');
    expect(normalizeLegacyStoredRole('safety')).toBe('unknown');
    expect(normalizeLegacyStoredRole('not-a-real-role')).toBe('unknown');
    expect(normalizeLegacyStoredRole(null)).toBeNull();
  });
});

describe('005 canonical researchers', () => {
  it('creates additive mapping tables without deleting or reparenting content', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const m005 = MIGRATIONS.find((m) => m.version === '005');
    expect(m005).toBeDefined();
    const sql = m005!.sql;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS researchers/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS source_researchers/i);
    expect(sql).toMatch(/slug VARCHAR\(128\) NOT NULL UNIQUE/i);
    expect(sql).toMatch(/display_name VARCHAR\(255\) NOT NULL/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/INSERT INTO researchers/i);
    expect(sql).toMatch(/INSERT INTO source_researchers/i);
    expect(sql).not.toMatch(/ON COMMIT DROP/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/UPDATE\s+content\s+SET\s+source_id/i);
  });
});

const SOURCE_REPLACEMENTS = [
  {
    type: 'blog',
    oldIdentifier: 'https://ai.googleblog.com/feeds/posts/default',
    newIdentifier: 'https://research.google/blog/rss/',
    category: 'google',
  },
  {
    type: 'blog',
    oldIdentifier: 'https://deepmind.google/discover/blog/rss.xml',
    newIdentifier: 'https://deepmind.google/blog/rss.xml',
  },
  {
    type: 'blog',
    oldIdentifier: 'https://openai.com/blog/rss/',
    newIdentifier: 'https://openai.com/news/rss.xml',
  },
  {
    type: 'substack',
    oldIdentifier: 'https://bensbites.beehiiv.com/feed',
    newIdentifier: 'https://www.bensbites.com/feed',
  },
  {
    type: 'podcast',
    oldIdentifier: 'https://feeds.megaphone.fm/dwarkeshpatel',
    newIdentifier: 'https://www.dwarkesh.com/feed',
  },
  {
    type: 'podcast',
    oldIdentifier: 'https://therobotbrains.libsyn.com/rss',
    newIdentifier: 'https://feeds.acast.com/public/shows/the-robot-brains',
  },
  {
    type: 'podcast',
    oldIdentifier: 'https://www.cognitiverevolution.ai/feed',
    newIdentifier: 'https://feeds.megaphone.fm/RINTP3108857801',
  },
  {
    type: 'podcast',
    oldIdentifier: 'https://feeds.simplecast.com/o8HFE2Nm',
    newIdentifier: 'https://feeds.captivate.fm/gradient-dissent/',
  },
  {
    type: 'youtube',
    oldIdentifier: 'UCZHmQk67mN31hHzLZcVbrqQ',
    newIdentifier: 'UCZHmQk67mSJgfCCTn7xBfew',
  },
  {
    type: 'youtube',
    oldIdentifier: 'UCxVqU5e5uIp8K9DkJv7HXGA',
    newIdentifier: 'UCNJ1Ymd5yFuUPtn21xtRbbw',
  },
  {
    type: 'youtube',
    oldIdentifier: 'UCpZ2V6tS0Rq2G5WlxfRpqpQ',
    newIdentifier: 'UCj8shE7aIn4Yawwbo2FceCQ',
  },
  {
    type: 'youtube',
    oldIdentifier: 'UC1hJ-Mhdb8fXkHMsKNWkVOw',
    newIdentifier: 'UCXl4i9dYBrFOabk0xGmbkRA',
  },
] as const;

const SOURCE_DEACTIVATIONS = [
  { type: 'blog', identifier: 'https://ruder.io/rss/index.rss' },
  { type: 'blog', identifier: 'https://www.anthropic.com/research/rss.xml' },
  { type: 'blog', identifier: 'https://ai.meta.com/blog/rss/' },
  { type: 'substack', identifier: 'https://www.deeplearning.ai/the-batch/feed/' },
  { type: 'blog', identifier: 'https://bair.berkeley.edu/blog/feed.xml' },
] as const;

const MICROSOFT_RESEARCH = 'https://www.microsoft.com/en-us/research/feed/';

describe('006 source reliability repair', () => {
  it('is the next numbered additive migration after 005', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.slice(0, 6)).toEqual(['001', '002', '003', '004', '005', '006']);
    expect(versions).toContain('007');
    const m006 = MIGRATIONS.find((m) => m.version === '006');
    expect(m006).toBeDefined();
    expect(m006!.name).toMatch(/source.?reliab/i);
  });

  it('rewrites each verified (type, old identifier) and sets Google Research category to google', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const sql = MIGRATIONS.find((m) => m.version === '006')!.sql;
    expect(sql).toMatch(/UPDATE\s+sources/i);
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).not.toMatch(/WHERE\s+id\s*=\s*\d+/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    for (const row of SOURCE_REPLACEMENTS) {
      expect(sql).toContain(row.type);
      expect(sql).toContain(row.oldIdentifier);
      expect(sql).toContain(row.newIdentifier);
    }
    expect(sql).toMatch(/category\s*=\s*'google'/i);
    expect(sql).toContain('https://research.google/blog/rss/');
  });

  it('deactivates exactly the five non-viable rows, leaves Microsoft active, and never deletes', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const sql = MIGRATIONS.find((m) => m.version === '006')!.sql;
    expect(sql).toMatch(/is_active\s*=\s*false/i);
    for (const row of SOURCE_DEACTIVATIONS) {
      expect(sql).toContain(row.type);
      expect(sql).toContain(row.identifier);
    }
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(new RegExp(`is_active\\s*=\\s*false[\\s\\S]{0,200}${MICROSOFT_RESEARCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    const microsoftActiveFalse = sql.includes(MICROSOFT_RESEARCH) && /is_active\s*=\s*false/i.test(sql)
      ? sql.indexOf(MICROSOFT_RESEARCH) > sql.lastIndexOf('is_active')
      : false;
    expect(microsoftActiveFalse).toBe(false);
    expect(sql).not.toContain(MICROSOFT_RESEARCH);
  });

  it('skips identifier rewrite when the replacement (type, identifier) already exists and does not reparent content', async () => {
    const { MIGRATIONS } = await import('../migrations/runner');
    const sql = MIGRATIONS.find((m) => m.version === '006')!.sql;
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).not.toMatch(/UPDATE\s+content\s+SET\s+source_id/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+sources/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+content/i);
  });
});

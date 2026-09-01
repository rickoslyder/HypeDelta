/**
 * Deterministic, transaction-safe versioned migrations.
 *
 * SQL is applied in version order, once, and recorded in schema_migrations
 * with a SHA-256 checksum of the exact SQL bytes. Recovered catalogs that
 * already have versions recorded without checksums get a nullable checksum
 * column and a name-matched backfill; name/checksum/orphan drift fails closed
 * before any unapplied migration executes.
 * A failed migration rolls back and is not marked applied.
 * Concurrent startups serialize on a PostgreSQL session advisory lock.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { MIGRATIONS } from './files';
import type { Migration } from './files';

const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;

export { MIGRATIONS };
export type { Migration } from './files';

/** Session-level advisory lock key for hypedelta schema migrations. */
export const MIGRATION_LOCK_KEY = 87245001;

/** SHA-256 of exact migration SQL bytes as 64 lowercase hex characters. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Fail closed on a malformed catalog before touching the database. */
export function validateMigrationManifest(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const migration of migrations) {
    const version = migration.version;
    if (typeof version !== 'string' || version.trim() === '') {
      throw new Error('migration version must be nonblank');
    }
    if (typeof migration.name !== 'string' || migration.name.trim() === '') {
      throw new Error('migration name must be nonblank');
    }
    if (seen.has(version)) {
      throw new Error(`duplicate migration version: ${version}`);
    }
    seen.add(version);
    if (previous !== undefined && !(previous < version)) {
      throw new Error('migration versions must be strictly ordered');
    }
    previous = version;
  }
}

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}

export async function applyMigrations(
  pool: PoolType,
  migrations: typeof MIGRATIONS = MIGRATIONS,
): Promise<void> {
  validateMigrationManifest(migrations);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          checksum VARCHAR(64)
        )
      `);
      await client.query(
        'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64)',
      );
      const appliedRows = await client.query<{
        version: string;
        name: string;
        checksum: string | null;
      }>('SELECT version, name, checksum FROM schema_migrations');
      const applied = new Set(appliedRows.rows.map((row) => row.version));
      const catalog = new Map(migrations.map((migration) => [migration.version, migration]));

      for (const row of appliedRows.rows) {
        const manifest = catalog.get(row.version);
        if (!manifest) {
          throw new Error(`unknown applied migration version: ${row.version}`);
        }
        const expected = migrationChecksum(manifest.sql);
        if (row.checksum != null && row.checksum !== expected) {
          throw new Error(`migration checksum mismatch: ${row.version}`);
        }
        if (row.checksum == null && row.name !== manifest.name) {
          throw new Error(`migration name mismatch: ${row.version}`);
        }
      }
      for (const row of appliedRows.rows) {
        const manifest = catalog.get(row.version);
        if (!manifest || row.checksum != null) continue;
        await client.query(
          'UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum IS NULL',
          [migrationChecksum(manifest.sql), row.version],
        );
      }

      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migrationChecksum(migration.sql)],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

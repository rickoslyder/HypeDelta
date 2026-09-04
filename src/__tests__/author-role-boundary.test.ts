/**
 * Extractor/application-boundary author-role normalization.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AUTHOR_ROLES, normalizeAuthorRole } from '../author-side';

const ROOT = resolve(__dirname, '../..');

describe('extractor boundary normalizes unknown/org tokens to unknown', () => {
  it('normalizeAuthorRole is the single write-path gate', () => {
    expect(normalizeAuthorRole('anthropic')).toBe('unknown');
    expect(normalizeAuthorRole('lab-researcher')).toBe('lab-researcher');
    expect(AUTHOR_ROLES).toContain(normalizeAuthorRole('journalist'));
  });

  it('pipeline normalizeClaimResults and applyFilterResults call normalizeAuthorRole', () => {
    const indexSrc = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    expect(indexSrc).toMatch(/from ['"].\/author-side['"]/);
    expect(indexSrc).toMatch(/normalizeAuthorRole/);
    expect(indexSrc).toMatch(/authorCategory:\s*normalizeAuthorRole\(/);
  });

  it('ClaimStore.upsert persists a normalized role', () => {
    const storageSrc = readFileSync(resolve(ROOT, 'src/storage.ts'), 'utf8');
    expect(storageSrc).toMatch(/normalizeAuthorRole/);
  });
});

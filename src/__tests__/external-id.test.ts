/**
 * Shared content.external_id normalization.
 * VARCHAR(255) is a character bound; oversized IDs become a versioned digest.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeExternalId } from '../external-id';

function sha256Prefixed(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

describe('normalizeExternalId', () => {
  it('trims surrounding whitespace and preserves a nonblank id that fits 255 characters', () => {
    expect(normalizeExternalId('  tweet_123  ')).toBe('tweet_123');
    expect(normalizeExternalId('a'.repeat(255))).toBe('a'.repeat(255));
    expect(normalizeExternalId('é'.repeat(255))).toBe('é'.repeat(255));
  });

  it('emits a deterministic sha256 digest for identifiers longer than 255 characters', () => {
    const longId = `https://www.microsoft.com/en-us/research/publication/${'x'.repeat(220)}`;
    expect(Array.from(longId).length).toBeGreaterThan(255);
    const normalized = normalizeExternalId(longId);
    expect(normalized).toBe(sha256Prefixed(longId));
    expect(normalized).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(normalized.length).toBeLessThanOrEqual(255);
    expect(normalizeExternalId(longId)).toBe(normalized);
  });

  it('hashes the complete trimmed identifier, not a prefix, and distinguishes distinct long ids', () => {
    const a = `${'a'.repeat(256)}`;
    const b = `${'b'.repeat(256)}`;
    expect(normalizeExternalId(a)).not.toBe(normalizeExternalId(b));
    expect(normalizeExternalId(`  ${a}  `)).toBe(normalizeExternalId(a));
    expect(normalizeExternalId(a)).not.toBe(a.slice(0, 255));
  });

  it('leaves blank identifiers unchanged so callers can apply their existing fallback first', () => {
    expect(normalizeExternalId('')).toBe('');
    expect(normalizeExternalId('   ')).toBe('');
  });
});

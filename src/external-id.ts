/**
 * Bounded content.external_id normalization.
 *
 * PostgreSQL content.external_id is VARCHAR(255) (characters, not bytes).
 * Callers with a blank identifier must apply their existing deterministic
 * fallback before this function. This helper never invents a fallback and
 * never logs the raw identifier.
 */
import { createHash } from 'node:crypto';

export const EXTERNAL_ID_MAX_CHARS = 255;
export const EXTERNAL_ID_DIGEST_PREFIX = 'sha256:';

export function normalizeExternalId(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return trimmed;
  if (Array.from(trimmed).length <= EXTERNAL_ID_MAX_CHARS) return trimmed;
  const digest = createHash('sha256').update(trimmed, 'utf8').digest('hex');
  return `${EXTERNAL_ID_DIGEST_PREFIX}${digest}`;
}

import { createHash } from 'node:crypto';

/** Deterministic predictions.id derived from extracted_claims.id. */
export function predictionIdFromClaimId(claimId: string): string {
  return `pred_${createHash('md5').update(claimId, 'utf8').digest('hex')}`;
}

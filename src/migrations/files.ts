/**
 * Ordered, additive SQL migrations.
 * Versions are zero-padded strings so lexicographic order matches apply order.
 */
import { authorRoleCheckSql, authorRoleNormalizeSql } from '../author-side';
import { researcherBackfillSql } from '../researcher-identity';
import { sourceReliabilitySql } from '../source-reliability';
import { pipelineObservabilitySql } from '../pipeline-error';
import { modelAttemptsSql } from '../model-attempt-ledger';
import { topicTaxonomySql } from '../topic-taxonomy';

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: '001',
    name: 'predictions_ledger',
    sql: `
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS next_observable TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS next_question TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS outcome_summary TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS evidence_url TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_predictions_claim_id ON predictions(claim_id);
CREATE INDEX IF NOT EXISTS idx_predictions_due_at ON predictions(due_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'predictions_status_check'
      AND conrelid = to_regclass(format('%I.predictions', current_schema()))
  ) THEN
    ALTER TABLE predictions
      ADD CONSTRAINT predictions_status_check
      CHECK (
        status IS NULL OR status IN (
          'pending',
          'too-early',
          'verified',
          'falsified',
          'partially-verified'
        )
      );
  END IF;
END $$;
`.trim(),
  },
  {
    version: '002',
    name: 'backfill_prediction_claims',
    sql: `
INSERT INTO predictions (
  id, claim_id, text, author, confidence, timeframe, topic, made_at
)
SELECT
  'pred_' || md5(c.id),
  c.id,
  c.claim_text,
  COALESCE(c.author, ''),
  COALESCE(c.confidence, 0),
  COALESCE(c.timeframe, ''),
  COALESCE(c.topic, ''),
  COALESCE(c.extracted_at, NOW())
FROM extracted_claims c
WHERE c.claim_type = 'prediction'
ON CONFLICT (id) DO NOTHING;
`.trim(),
  },
  {
    version: '003',
    name: 'predictions_claim_unique_pending',
    sql: `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM predictions
    WHERE claim_id IS NOT NULL
    GROUP BY claim_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate non-null predictions.claim_id values exist; resolve duplicates before migrating';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS predictions_claim_id_unique
  ON predictions (claim_id)
  WHERE claim_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'predictions_status_check'
      AND conrelid = to_regclass(format('%I.predictions', current_schema()))
  ) THEN
    ALTER TABLE predictions DROP CONSTRAINT predictions_status_check;
  END IF;
END $$;

UPDATE predictions SET status = 'pending' WHERE status IS NULL;

ALTER TABLE predictions ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE predictions ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'predictions_status_check'
      AND conrelid = to_regclass(format('%I.predictions', current_schema()))
  ) THEN
    ALTER TABLE predictions
      ADD CONSTRAINT predictions_status_check
      CHECK (
        status IN (
          'pending',
          'too-early',
          'verified',
          'falsified',
          'partially-verified'
        )
      );
  END IF;
END $$;
`.trim(),
  },
  {
    version: '004',
    name: 'author_role_vocabulary',
    sql: `
${authorRoleNormalizeSql()}

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'extracted_claims_author_category_check'
      AND conrelid = to_regclass(format('%I.extracted_claims', current_schema()))
  ) THEN
    ALTER TABLE extracted_claims
      ADD CONSTRAINT extracted_claims_author_category_check
      CHECK (${authorRoleCheckSql()});
  END IF;
END $$;
`.trim(),
  },
  {
    version: '005',
    name: 'canonical_researchers',
    sql: researcherBackfillSql(),
  },
  {
    version: '006',
    name: 'source_reliability',
    sql: sourceReliabilitySql(),
  },
  {
    version: '007',
    name: 'quote_backfill_attempts',
    sql: `
-- quote_backfill_attempts ledger (007)
CREATE TABLE IF NOT EXISTS quote_backfill_attempts (
  id BIGSERIAL PRIMARY KEY,
  claim_id VARCHAR(100) NOT NULL,
  content_id INT NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result VARCHAR(32) NOT NULL,
  reason VARCHAR(200),
  CONSTRAINT quote_backfill_attempts_result_check CHECK (
    result IN ('updated', 'no-match', 'rejected', 'error', 'skipped-race')
  )
);

CREATE INDEX IF NOT EXISTS idx_quote_backfill_attempts_claim
  ON quote_backfill_attempts (claim_id);

CREATE INDEX IF NOT EXISTS idx_quote_backfill_attempts_run
  ON quote_backfill_attempts (run_id);
`.trim(),
  },
  {
    version: '008',
    name: 'pipeline_observability_ledgers',
    sql: pipelineObservabilitySql(),
  },
  {
    version: '009',
    name: 'model_attempts',
    sql: modelAttemptsSql(),
  },
  {
    version: '010',
    name: 'canonical_topic_taxonomy',
    sql: topicTaxonomySql(),
  },
];

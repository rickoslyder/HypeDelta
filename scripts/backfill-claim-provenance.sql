-- backfill-claim-provenance.sql
-- Additive, idempotent fill of blank extracted_claims.source_url / author
-- from joined content + sources. Never overwrites nonblank existing values.
-- Safe to re-run. Does not create/drop/delete tables or rows.

BEGIN;

-- ---------------------------------------------------------------------------
-- BEFORE coverage (canonical fallback contract, same as public reads)
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*) AS total_claims,
  COUNT(*) FILTER (
    WHERE COALESCE(NULLIF(e.source_url, ''), NULLIF(c.url, '')) IS NOT NULL
  ) AS url_backed_claims,
  COUNT(*) FILTER (
    WHERE COALESCE(NULLIF(e.author, ''), NULLIF(s.identifier, ''), NULLIF(s.author_name, '')) IS NOT NULL
  ) AS author_identified_claims,
  COUNT(*) FILTER (
    WHERE NULLIF(e.source_url, '') IS NULL AND NULLIF(c.url, '') IS NOT NULL
  ) AS source_url_fillable,
  COUNT(*) FILTER (
    WHERE NULLIF(e.author, '') IS NULL
      AND COALESCE(NULLIF(s.identifier, ''), NULLIF(s.author_name, '')) IS NOT NULL
  ) AS author_fillable
FROM extracted_claims e
LEFT JOIN content c ON e.content_id = c.id
LEFT JOIN sources s ON c.source_id = s.id;

-- ---------------------------------------------------------------------------
-- Fill only missing/blank source_url and author from joined content/source.
-- COALESCE keeps any existing nonblank value; NULLIF treats '' as missing.
-- ---------------------------------------------------------------------------
UPDATE extracted_claims e
SET
  source_url = COALESCE(
    NULLIF(e.source_url, ''),
    NULLIF(c.url, '')
  ),
  author = COALESCE(
    NULLIF(e.author, ''),
    NULLIF(s.identifier, ''),
    NULLIF(s.author_name, '')
  )
FROM content c
JOIN sources s ON c.source_id = s.id
WHERE e.content_id = c.id
  AND (
    NULLIF(e.source_url, '') IS NULL
    OR NULLIF(e.author, '') IS NULL
  );

-- ---------------------------------------------------------------------------
-- AFTER coverage
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*) AS total_claims,
  COUNT(*) FILTER (
    WHERE COALESCE(NULLIF(e.source_url, ''), NULLIF(c.url, '')) IS NOT NULL
  ) AS url_backed_claims,
  COUNT(*) FILTER (
    WHERE COALESCE(NULLIF(e.author, ''), NULLIF(s.identifier, ''), NULLIF(s.author_name, '')) IS NOT NULL
  ) AS author_identified_claims,
  COUNT(*) FILTER (
    WHERE NULLIF(e.source_url, '') IS NOT NULL
  ) AS stored_source_url_nonempty,
  COUNT(*) FILTER (
    WHERE NULLIF(e.author, '') IS NOT NULL
  ) AS stored_author_nonempty
FROM extracted_claims e
LEFT JOIN content c ON e.content_id = c.id
LEFT JOIN sources s ON c.source_id = s.id;

COMMIT;

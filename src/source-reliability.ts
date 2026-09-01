/**
 * Verified first-party source identifier repairs.
 *
 * Duplicate replacement behavior: if a row already exists at
 * (type, new_identifier), skip rewriting the old identifier. Keep both
 * rows. Do not DELETE. Do not reparent content.source_id. Historical
 * content stays on the source_id that already owns it.
 */
export interface SourceReplacement {
  type: 'blog' | 'substack' | 'youtube' | 'podcast';
  oldIdentifier: string;
  newIdentifier: string;
  category?: string;
}

export interface SourceDeactivation {
  type: 'blog' | 'substack' | 'youtube' | 'podcast';
  identifier: string;
}

export const SOURCE_REPLACEMENTS: readonly SourceReplacement[] = [
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
];

export const SOURCE_DEACTIVATIONS: readonly SourceDeactivation[] = [
  { type: 'blog', identifier: 'https://ruder.io/rss/index.rss' },
  { type: 'blog', identifier: 'https://www.anthropic.com/research/rss.xml' },
  { type: 'blog', identifier: 'https://ai.meta.com/blog/rss/' },
  { type: 'substack', identifier: 'https://www.deeplearning.ai/the-batch/feed/' },
  { type: 'blog', identifier: 'https://bair.berkeley.edu/blog/feed.xml' },
];

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sourceReliabilitySql(): string {
  const values = SOURCE_REPLACEMENTS.map((row, index) => {
    const typeCast = index === 0 ? '::varchar' : '';
    const category =
      row.category == null ? 'NULL' : `${sqlString(row.category)}${index === 0 ? '::varchar' : ''}`;
    return `    (${sqlString(row.type)}${typeCast}, ${sqlString(row.oldIdentifier)}, ${sqlString(row.newIdentifier)}, ${category})`;
  }).join(',\n');

  const deactivations = SOURCE_DEACTIVATIONS.map(
    (row) => `  (${sqlString(row.type)}, ${sqlString(row.identifier)})`,
  ).join(',\n');

  return `
-- 006 source reliability: rewrite verified first-party identifiers in place.
-- Match by exact (type, old identifier), never by production numeric ids.
-- If (type, new_identifier) already exists, skip the rewrite so UNIQUE(type, identifier)
-- is preserved. Both rows are kept. Content is not deleted or reparented.
UPDATE sources AS s
SET
  identifier = m.new_identifier,
  category = COALESCE(m.new_category, s.category)
FROM (
  VALUES
${values}
) AS m(type, old_identifier, new_identifier, new_category)
WHERE s.type = m.type
  AND s.identifier = m.old_identifier
  AND NOT EXISTS (
    SELECT 1
    FROM sources existing
    WHERE existing.type = m.type
      AND existing.identifier = m.new_identifier
  );

UPDATE sources
SET category = 'google'
WHERE type = 'blog'
  AND identifier IN (
    'https://ai.googleblog.com/feeds/posts/default',
    'https://research.google/blog/rss/'
  );

UPDATE sources
SET is_active = false
WHERE (type, identifier) IN (
${deactivations}
);
`.trim();
}

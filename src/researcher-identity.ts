/**
 * Canonical researcher identity helpers.
 *
 * Matching key keeps punctuation so "Foo. Bar" and "Foo Bar" stay distinct.
 * Slugs are URL-safe and collision-suffixed. Source feed URLs are provenance,
 * never display handles.
 */
import type { AuthorSide } from './author-side';

export interface SourceIdentityInput {
  id: number;
  authorName?: string | null;
  identifier: string;
  type?: string | null;
  category?: string | null;
}

export interface CanonicalPersonPlan {
  slug: string;
  displayName: string;
  matchKey: string | null;
  sourceIds: number[];
  claimSourceCount: number;
}

export interface CanonicalResearcherPlan {
  people: CanonicalPersonPlan[];
  sourceToSlug: Map<number, string>;
}

const HTTP_URL = /^https?:\/\//i;

export function isHttpUrlIdentifier(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return HTTP_URL.test(value.trim());
}

export function normalizePersonMatchKey(name: unknown): string {
  if (name == null) return '';
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function researcherSlugFromDisplayName(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'unnamed';
}

function fallbackDisplayName(source: SourceIdentityInput): string {
  const named = String(source.authorName ?? '').trim();
  if (named && !isHttpUrlIdentifier(named)) return named;
  const ident = String(source.identifier ?? '').trim();
  if (ident && !isHttpUrlIdentifier(ident)) return ident;
  return `Unnamed source ${source.id}`;
}

export function publicAuthorLabel(input: {
  displayName?: string | null;
  identifier?: string | null;
}): { displayName: string; handle: string | null } {
  const ident = String(input.identifier ?? '').trim();
  const handle = ident && !isHttpUrlIdentifier(ident) ? ident.replace(/^@/, '') : null;
  const rawName = String(input.displayName ?? '').trim();
  const displayName =
    rawName && !isHttpUrlIdentifier(rawName)
      ? rawName
      : handle || 'Unknown researcher';
  return { displayName, handle };
}

export function planCanonicalResearchers(sources: SourceIdentityInput[]): CanonicalResearcherPlan {
  const groups = new Map<string, SourceIdentityInput[]>();
  const blanks: SourceIdentityInput[] = [];

  for (const source of sources) {
    const key = normalizePersonMatchKey(source.authorName);
    if (!key) {
      blanks.push(source);
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(source);
    groups.set(key, list);
  }

  const people: CanonicalPersonPlan[] = [];
  const usedSlugs = new Set<string>();

  const takeSlug = (base: string, disambiguator: string | number): string => {
    let slug = base;
    if (!slug || usedSlugs.has(slug)) {
      slug = `${base || 'unnamed'}-${disambiguator}`;
    }
    let n = 2;
    while (usedSlugs.has(slug)) {
      slug = `${base || 'unnamed'}-${disambiguator}-${n++}`;
    }
    usedSlugs.add(slug);
    return slug;
  };

  const namedEntries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [matchKey, members] of namedEntries) {
    members.sort((a, b) => a.id - b.id);
    const preferred = [...members].sort((a, b) => {
      const aLen = String(a.authorName ?? '').trim().length;
      const bLen = String(b.authorName ?? '').trim().length;
      if (bLen !== aLen) return bLen - aLen;
      return a.id - b.id;
    })[0];
    const displayName = String(preferred.authorName ?? '').trim() || fallbackDisplayName(preferred);
    const slug = takeSlug(researcherSlugFromDisplayName(displayName), members[0].id);
    people.push({
      slug,
      displayName,
      matchKey,
      sourceIds: members.map((m) => m.id),
      claimSourceCount: members.length,
    });
  }

  blanks.sort((a, b) => a.id - b.id);
  for (const source of blanks) {
    const displayName = fallbackDisplayName(source);
    const slug = takeSlug(researcherSlugFromDisplayName(displayName), source.id);
    people.push({
      slug,
      displayName,
      matchKey: null,
      sourceIds: [source.id],
      claimSourceCount: 1,
    });
  }

  const sourceToSlug = new Map<number, string>();
  for (const person of people) {
    for (const id of person.sourceIds) sourceToSlug.set(id, person.slug);
  }

  return { people, sourceToSlug };
}

/**
 * Deterministic public-window side:
 * - lab if only lab, or lab is a unique majority (>= half and strictly greatest)
 * - critic if only critic, or critic is a unique majority
 * - otherwise other
 *
 * Source organization category is ignored.
 */
export function aggregateResearcherSide(input: {
  lab: number;
  critic: number;
  other: number;
  sourceCategory?: string | null;
}): AuthorSide {
  const lab = Math.max(0, Number(input.lab) || 0);
  const critic = Math.max(0, Number(input.critic) || 0);
  const other = Math.max(0, Number(input.other) || 0);
  const total = lab + critic + other;
  if (total === 0) return 'other';
  if (lab > 0 && critic === 0 && other === 0) return 'lab';
  if (critic > 0 && lab === 0 && other === 0) return 'critic';
  if (lab > critic && lab > other && lab * 2 >= total) return 'lab';
  if (critic > lab && critic > other && critic * 2 >= total) return 'critic';
  return 'other';
}

function researcherPlanCte(): string {
  return `
WITH named AS (
  SELECT
    s.id,
    s.identifier,
    s.author_name,
    lower(btrim(regexp_replace(COALESCE(s.author_name, ''), '\\s+', ' ', 'g'))) AS match_key
  FROM sources s
),
named_groups AS (
  SELECT
    match_key,
    MIN(id) AS seed_id,
    (ARRAY_AGG(btrim(author_name) ORDER BY char_length(btrim(author_name)) DESC, id))[1] AS display_name
  FROM named
  WHERE match_key <> ''
  GROUP BY match_key
),
blank_groups AS (
  SELECT
    id AS seed_id,
    CASE
      WHEN identifier ~* '^https?://' THEN 'Unnamed source ' || id::text
      WHEN NULLIF(btrim(identifier), '') IS NOT NULL THEN btrim(identifier)
      ELSE 'Unnamed source ' || id::text
    END AS display_name,
    'blank:' || id::text AS match_key
  FROM named
  WHERE match_key = ''
),
all_groups AS (
  SELECT match_key, seed_id, display_name FROM named_groups
  UNION ALL
  SELECT match_key, seed_id, display_name FROM blank_groups
),
slugged AS (
  SELECT
    match_key,
    seed_id,
    display_name,
    COALESCE(
      NULLIF(trim(both '-' FROM regexp_replace(lower(display_name), '[^a-z0-9]+', '-', 'g')), ''),
      'unnamed'
    ) AS base_slug
  FROM all_groups
),
ranked AS (
  SELECT
    match_key,
    seed_id,
    display_name,
    base_slug,
    ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY seed_id) AS rn
  FROM slugged
),
final_people AS (
  SELECT
    match_key,
    seed_id,
    display_name,
    CASE WHEN rn = 1 THEN base_slug ELSE base_slug || '-' || seed_id::text END AS slug
  FROM ranked
),
mapped AS (
  SELECT n.id AS source_id, f.slug, f.display_name
  FROM named n
  JOIN final_people f
    ON (n.match_key <> '' AND f.match_key = n.match_key)
    OR (n.match_key = '' AND f.match_key = 'blank:' || n.id::text)
)
`.trim();
}

export function researcherBackfillSql(): string {
  const plan = researcherPlanCte();
  return `
-- 005 canonical researchers additive identity mapping
CREATE TABLE IF NOT EXISTS researchers (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(128) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_researchers (
  source_id INT NOT NULL REFERENCES sources(id),
  researcher_id INT NOT NULL REFERENCES researchers(id),
  PRIMARY KEY (source_id)
);

CREATE INDEX IF NOT EXISTS idx_source_researchers_researcher
  ON source_researchers(researcher_id);

INSERT INTO researchers (slug, display_name)
${plan}
SELECT DISTINCT ON (mapped.slug) mapped.slug, mapped.display_name
FROM mapped
ORDER BY mapped.slug, mapped.source_id
ON CONFLICT (slug) DO NOTHING;

INSERT INTO source_researchers (source_id, researcher_id)
${plan}
SELECT mapped.source_id, r.id
FROM mapped
JOIN researchers r ON r.slug = mapped.slug
ON CONFLICT (source_id) DO NOTHING;
`.trim();
}

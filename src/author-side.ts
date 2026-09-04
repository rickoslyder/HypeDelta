/**
 * Canonical lab | critic | other product taxonomy.
 *
 * Claim author roles stay on extracted_claims.author_category.
 * Source organization categories stay on sources.category and are never
 * treated as claim roles or used to infer claim side.
 */

export const AUTHOR_ROLES = [
  'lab-researcher',
  'critic',
  'academic',
  'independent',
  'journalist',
  'unknown',
] as const;

export type AuthorRole = (typeof AUTHOR_ROLES)[number];
export type AuthorSide = 'lab' | 'critic' | 'other';

export const AUTHOR_ROLE_SIDES: Record<AuthorRole, AuthorSide> = {
  'lab-researcher': 'lab',
  critic: 'critic',
  academic: 'critic',
  independent: 'other',
  journalist: 'other',
  unknown: 'other',
};

/** Unambiguous legacy claim-role tokens observed in older extractors. */
export const UNAMBIGUOUS_LEGACY_AUTHOR_ROLES: Record<string, AuthorRole> = {
  anthropic: 'lab-researcher',
  openai: 'lab-researcher',
  deepmind: 'lab-researcher',
  meta: 'lab-researcher',
  google: 'lab-researcher',
  xai: 'lab-researcher',
  mistral: 'lab-researcher',
  critics: 'critic',
};

const ROLE_SET = new Set<string>(AUTHOR_ROLES);

export function isAllowedAuthorRole(value: unknown): value is AuthorRole {
  return typeof value === 'string' && ROLE_SET.has(value);
}

function normalizeToken(value: unknown): string {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

export function normalizeAuthorRole(value: unknown): AuthorRole {
  const token = normalizeToken(value);
  if (isAllowedAuthorRole(token)) return token;
  return 'unknown';
}

/** Migration-only remap of currently stored claim roles. Null stays null. */
export function normalizeLegacyStoredRole(value: unknown): AuthorRole | null {
  if (value == null) return null;
  const token = String(value).trim();
  if (token === '') return null;
  const lowered = token.toLowerCase();
  if (isAllowedAuthorRole(lowered)) return lowered;
  if (lowered in UNAMBIGUOUS_LEGACY_AUTHOR_ROLES) {
    return UNAMBIGUOUS_LEGACY_AUTHOR_ROLES[lowered];
  }
  return 'unknown';
}

export function authorRoleToSide(value: unknown): AuthorSide {
  const token = normalizeToken(value);
  if (isAllowedAuthorRole(token)) return AUTHOR_ROLE_SIDES[token];
  return 'other';
}

export function sqlQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rolesForSide(side: AuthorSide): AuthorRole[] {
  return AUTHOR_ROLES.filter((role) => AUTHOR_ROLE_SIDES[role] === side);
}

/**
 * CASE expression generated from AUTHOR_ROLE_SIDES.
 * Unrecognized / NULL / organization tokens fall through to other.
 */
export function authorSideSqlCase(column = 'author_category'): string {
  const labList = rolesForSide('lab').map(sqlQuoteLiteral).join(', ');
  const criticList = rolesForSide('critic').map(sqlQuoteLiteral).join(', ');
  return (
    `CASE WHEN ${column} IN (${labList}) THEN 'lab'` +
    ` WHEN ${column} IN (${criticList}) THEN 'critic'` +
    ` ELSE 'other' END`
  );
}

export function authorSideSqlPredicate(column: string, side: AuthorSide): string {
  if (side === 'other') {
    const known = [...rolesForSide('lab'), ...rolesForSide('critic')]
      .map(sqlQuoteLiteral)
      .join(', ');
    return `(${column} IS NULL OR ${column} NOT IN (${known}))`;
  }
  const list = rolesForSide(side).map(sqlQuoteLiteral).join(', ');
  return `${column} IN (${list})`;
}

/** Interpreter used by contract tests to prove SQL CASE parity without a live DB. */
export function evaluateAuthorSideSqlCase(value: unknown): AuthorSide {
  return authorRoleToSide(value);
}

export function groupByAuthorSide<T>(
  rows: T[],
  getRole: (row: T) => unknown,
): Record<AuthorSide, T[]> {
  const grouped: Record<AuthorSide, T[]> = { lab: [], critic: [], other: [] };
  for (const row of rows) {
    grouped[authorRoleToSide(getRole(row))].push(row);
  }
  return grouped;
}

export interface TopicSideCounts {
  claim_count: number;
  lab_count: number;
  critic_count: number;
  other_count: number;
}

export function summarizeTopicSides<T extends { topic?: string | null; author_category?: unknown }>(
  rows: T[],
): Record<string, TopicSideCounts> {
  const out: Record<string, TopicSideCounts> = {};
  for (const row of rows) {
    const topic = row.topic || 'other';
    if (!out[topic]) {
      out[topic] = { claim_count: 0, lab_count: 0, critic_count: 0, other_count: 0 };
    }
    const bucket = out[topic];
    bucket.claim_count += 1;
    const side = authorRoleToSide(row.author_category);
    if (side === 'lab') bucket.lab_count += 1;
    else if (side === 'critic') bucket.critic_count += 1;
    else bucket.other_count += 1;
  }
  return out;
}

export function authorRoleCheckSql(column = 'author_category'): string {
  const list = AUTHOR_ROLES.map(sqlQuoteLiteral).join(', ');
  return `${column} IS NULL OR ${column} IN (${list})`;
}

/**
 * SQL that remaps unambiguous legacy organization tokens onto allowed roles
 * and maps any remaining unrecognized token to unknown. Does not rewrite
 * already-allowed roles (including unknown).
 */
export function authorRoleNormalizeSql(column = 'author_category'): string {
  const whenClauses = Object.entries(UNAMBIGUOUS_LEGACY_AUTHOR_ROLES)
    .map(
      ([legacy, role]) =>
        `WHEN lower(btrim(${column})) = ${sqlQuoteLiteral(legacy)} THEN ${sqlQuoteLiteral(role)}`,
    )
    .join('\n    ');
  const allowed = AUTHOR_ROLES.map(sqlQuoteLiteral).join(', ');
  return `
UPDATE extracted_claims
SET author_category = CASE
    ${whenClauses}
    WHEN ${column} IN (${allowed}) THEN ${column}
    WHEN ${column} IS NULL THEN ${column}
    ELSE 'unknown'
END
WHERE ${column} IS NOT NULL
  AND ${column} NOT IN (${allowed});
`.trim();
}

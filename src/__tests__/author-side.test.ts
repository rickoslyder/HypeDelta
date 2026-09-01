/**
 * Shared lab|critic|other product taxonomy.
 * Tests the canonical module before any consumer is allowed to diverge.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AUTHOR_ROLES,
  AUTHOR_ROLE_SIDES,
  authorRoleToSide,
  authorRoleNormalizeSql,
  authorSideSqlCase,
  evaluateAuthorSideSqlCase,
  groupByAuthorSide,
  isAllowedAuthorRole,
  normalizeAuthorRole,
  summarizeTopicSides,
  type AuthorRole,
  type AuthorSide,
} from '../author-side';

const ROOT = resolve(__dirname, '../..');

const ALLOWED: AuthorRole[] = [
  'lab-researcher',
  'critic',
  'academic',
  'independent',
  'journalist',
  'unknown',
];

const EXPECTED_SIDES: Record<AuthorRole, AuthorSide> = {
  'lab-researcher': 'lab',
  critic: 'critic',
  academic: 'critic',
  independent: 'other',
  journalist: 'other',
  unknown: 'other',
};

const ORG_TOKENS = [
  'anthropic',
  'openai',
  'deepmind',
  'meta',
  'google',
  'xai',
  'mistral',
  'nvidia',
  'huggingface',
  'critics',
  'safety',
];

describe('AuthorSide contract', () => {
  it('maps every allowed author role exactly onto lab|critic|other', () => {
    expect([...AUTHOR_ROLES].sort()).toEqual([...ALLOWED].sort());
    for (const role of ALLOWED) {
      expect(isAllowedAuthorRole(role)).toBe(true);
      expect(authorRoleToSide(role)).toBe(EXPECTED_SIDES[role]);
      expect(AUTHOR_ROLE_SIDES[role]).toBe(EXPECTED_SIDES[role]);
    }
  });

  it('does not accept organization tokens as claim author roles', () => {
    for (const token of ORG_TOKENS) {
      expect(isAllowedAuthorRole(token)).toBe(false);
      expect(authorRoleToSide(token)).toBe('other');
      expect(normalizeAuthorRole(token)).toBe('unknown');
    }
  });

  it('normalizes missing and unrecognized extractor tokens to unknown', () => {
    expect(normalizeAuthorRole(null)).toBe('unknown');
    expect(normalizeAuthorRole(undefined)).toBe('unknown');
    expect(normalizeAuthorRole('')).toBe('unknown');
    expect(normalizeAuthorRole('  Lab-Researcher  ')).toBe('lab-researcher');
    expect(normalizeAuthorRole('not-a-role')).toBe('unknown');
  });
});

describe('topic side counts and grouping stay aligned', () => {
  const mixed = [
    { id: 'l1', topic: 'scaling', author_category: 'lab-researcher' },
    { id: 'c1', topic: 'scaling', author_category: 'critic' },
    { id: 'a1', topic: 'scaling', author_category: 'academic' },
    { id: 'i1', topic: 'scaling', author_category: 'independent' },
    { id: 'j1', topic: 'scaling', author_category: 'journalist' },
    { id: 'u1', topic: 'scaling', author_category: 'unknown' },
    { id: 'm1', topic: 'scaling', author_category: null },
  ];

  const allOther = [
    { id: 'o1', topic: 'agents', author_category: 'independent' },
    { id: 'o2', topic: 'agents', author_category: 'journalist' },
    { id: 'o3', topic: 'agents', author_category: 'unknown' },
    { id: 'o4', topic: 'agents', author_category: null },
  ];

  it('lab+critic+other equals claim_count including an all-other topic', () => {
    const stats = summarizeTopicSides([...mixed, ...allOther]);
    expect(stats.scaling.lab_count + stats.scaling.critic_count + stats.scaling.other_count).toBe(
      stats.scaling.claim_count,
    );
    expect(stats.scaling).toMatchObject({
      claim_count: 7,
      lab_count: 1,
      critic_count: 2,
      other_count: 4,
    });
    expect(stats.agents).toMatchObject({
      claim_count: 4,
      lab_count: 0,
      critic_count: 0,
      other_count: 4,
    });
    expect(stats.agents.lab_count + stats.agents.critic_count + stats.agents.other_count).toBe(
      stats.agents.claim_count,
    );
  });

  it('detail grouping lists the same rows the counts used', () => {
    const grouped = groupByAuthorSide(mixed, (row) => row.author_category);
    expect(grouped.lab.map((r) => r.id)).toEqual(['l1']);
    expect(grouped.critic.map((r) => r.id).sort()).toEqual(['a1', 'c1']);
    expect(grouped.other.map((r) => r.id).sort()).toEqual(['i1', 'j1', 'm1', 'u1']);
    expect(grouped.lab.length + grouped.critic.length + grouped.other.length).toBe(mixed.length);

    const otherGrouped = groupByAuthorSide(allOther, (row) => row.author_category);
    expect(otherGrouped.lab).toEqual([]);
    expect(otherGrouped.critic).toEqual([]);
    expect(otherGrouped.other.map((r) => r.id).sort()).toEqual(['o1', 'o2', 'o3', 'o4']);
  });

  it('does not classify Francois-style lab claims as critic from sources.category', () => {
    const row = {
      id: 'fc1',
      topic: 'reasoning',
      author_category: 'lab-researcher',
      source_category: 'critics',
    };
    expect(authorRoleToSide(row.author_category)).toBe('lab');
    const stats = summarizeTopicSides([row]);
    expect(stats.reasoning.lab_count).toBe(1);
    expect(stats.reasoning.critic_count).toBe(0);
    const grouped = groupByAuthorSide([row], (r) => r.author_category);
    expect(grouped.lab).toHaveLength(1);
    expect(grouped.critic).toHaveLength(0);
  });
});

describe('SQL CASE is generated from the same mapping', () => {
  it('emits a complete migration statement before the following DO block', () => {
    expect(authorRoleNormalizeSql().trimEnd()).toMatch(/;$/);
  });

  it('evaluates every allowed role and unknown token identically to authorRoleToSide', () => {
    const sql = authorSideSqlCase('author_category');
    expect(sql).toMatch(/CASE/i);
    expect(sql).toMatch(/ELSE 'other'/i);
    for (const role of ALLOWED) {
      expect(evaluateAuthorSideSqlCase(role)).toBe(authorRoleToSide(role));
    }
    for (const token of [...ORG_TOKENS, null, '', 'weird']) {
      expect(evaluateAuthorSideSqlCase(token)).toBe('other');
    }
  });
});

describe('root synthesis and prompts cannot diverge from the contract', () => {
  it('agent-sdk-wrapper synthesize grouping imports the shared helper', () => {
    const src = readFileSync(resolve(ROOT, 'src/agent-sdk-wrapper.ts'), 'utf8');
    expect(src).toMatch(/from ['"].\/author-side['"]/);
    expect(src).toMatch(/groupByAuthorSide/);
    expect(src).not.toMatch(/authorCategory === 'lab-researcher'/);
    expect(src).not.toMatch(/\['anthropic',\s*'openai',\s*'deepmind'/);
  });

  it('prompt, skill, and wrapper vocabularies list only allowed author roles', () => {
    const files = [
      readFileSync(resolve(ROOT, 'src/prompts.ts'), 'utf8'),
      readFileSync(resolve(ROOT, 'src/agent-sdk-wrapper.ts'), 'utf8'),
      readFileSync(resolve(ROOT, 'SKILL.md'), 'utf8'),
      readFileSync(resolve(ROOT, 'src/types.ts'), 'utf8'),
    ];
    for (const text of files) {
      for (const role of ALLOWED) {
        expect(text).toContain(role);
      }
      expect(text).not.toMatch(/authorCategory:\s*anthropic/);
    }
  });
});

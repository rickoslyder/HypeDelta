/**
 * Canonical researcher identity: many sources → one person.
 * Source identifiers stay provenance; they are not people.
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateResearcherSide,
  isHttpUrlIdentifier,
  normalizePersonMatchKey,
  planCanonicalResearchers,
  publicAuthorLabel,
  researcherSlugFromDisplayName,
  type SourceIdentityInput,
} from '../researcher-identity';

const AUDITED_DUPES = [
  'Simon Willison',
  'Gary Marcus',
  'Nathan Lambert',
  'Rodney Brooks',
  'Jack Clark',
  'Melanie Mitchell',
  'Lilian Weng',
] as const;

function fixtureSources(): SourceIdentityInput[] {
  const rows: SourceIdentityInput[] = [];
  let id = 1;
  const add = (authorName: string | null, identifier: string, extra?: Partial<SourceIdentityInput>) => {
    rows.push({
      id: id++,
      authorName,
      identifier,
      type: extra?.type ?? 'blog',
      category: extra?.category ?? 'independent',
    });
  };

  add('Simon Willison', 'simonw', { type: 'twitter' });
  add('Simon Willison', 'https://simonw.substack.com/feed', { type: 'substack' });
  add('Simon Willison', 'https://simonwillison.net/atom/everything/', { type: 'blog' });

  add('Gary Marcus', 'GaryMarcus', { type: 'twitter', category: 'critics' });
  add('Gary Marcus', 'https://garymarcus.substack.com/feed', { type: 'substack', category: 'critics' });

  add('Nathan Lambert', 'natolambert', { type: 'twitter', category: 'ai2' });
  add('Nathan Lambert', 'https://www.interconnects.ai/feed', { type: 'substack', category: 'ai2' });

  add('Rodney Brooks', 'rodneyabrooks', { type: 'twitter', category: 'critics' });
  add('Rodney Brooks', 'https://rodneybrooks.com/feed/', { type: 'blog', category: 'critics' });

  add('Jack Clark', 'jackclarkSF', { type: 'twitter', category: 'anthropic' });
  add('Jack Clark', 'https://importai.substack.com/feed', { type: 'substack', category: 'anthropic' });

  add('Melanie Mitchell', 'MelMitchell1', { type: 'twitter', category: 'critics' });
  add('Melanie Mitchell', 'https://aiguide.substack.com/feed', { type: 'substack', category: 'critics' });

  add('Lilian Weng', 'lilianweng', { type: 'twitter', category: 'openai' });
  add('Lilian Weng', 'https://lilianweng.github.io/index.xml', { type: 'blog', category: 'openai' });

  add('Francois Chollet', 'fchollet', { type: 'twitter', category: 'critics' });

  add('Foo. Bar', 'foo-dot-bar');
  add('Foo Bar', 'foo-space-bar');

  add(null, 'https://example.com/blank-feed.xml', { type: 'blog' });
  add('', 'orphan-handle', { type: 'twitter' });

  return rows;
}

describe('canonical researcher planning', () => {
  it('converges each audited duplicate display name onto exactly one person', () => {
    const plan = planCanonicalResearchers(fixtureSources());
    for (const name of AUDITED_DUPES) {
      const people = plan.people.filter((p) => p.displayName === name);
      expect(people, name).toHaveLength(1);
      const person = people[0];
      const sources = fixtureSources().filter(
        (s) => normalizePersonMatchKey(s.authorName) === normalizePersonMatchKey(name),
      );
      expect(person.sourceIds.sort()).toEqual(sources.map((s) => s.id).sort());
      expect(person.claimSourceCount).toBe(sources.length);
    }
  });

  it('does not merge distinct nonblank people whose slugs collide after punctuation stripping', () => {
    const plan = planCanonicalResearchers(fixtureSources());
    const fooDot = plan.people.find((p) => p.displayName === 'Foo. Bar');
    const fooSpace = plan.people.find((p) => p.displayName === 'Foo Bar');
    expect(fooDot).toBeDefined();
    expect(fooSpace).toBeDefined();
    expect(fooDot!.slug).not.toBe(fooSpace!.slug);
    expect(new Set(plan.people.map((p) => p.slug)).size).toBe(plan.people.length);
  });

  it('gives blank names collision-safe unique people instead of a silent bucket', () => {
    const plan = planCanonicalResearchers(fixtureSources());
    const blanks = plan.people.filter((p) =>
      p.sourceIds.some((id) => {
        const src = fixtureSources().find((s) => s.id === id);
        return !normalizePersonMatchKey(src?.authorName);
      }),
    );
    expect(blanks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(blanks.map((p) => p.slug)).size).toBe(blanks.length);
    for (const person of blanks) {
      expect(person.displayName).toBeTruthy();
      expect(person.displayName).not.toMatch(/^https?:/i);
    }
  });
});

describe('public researcher labels', () => {
  it('never treats an http(s) feed identifier as an @handle', () => {
    expect(isHttpUrlIdentifier('https://simonwillison.net/atom/everything/')).toBe(true);
    expect(isHttpUrlIdentifier('http://example.com/x')).toBe(true);
    expect(isHttpUrlIdentifier('simonw')).toBe(false);
    expect(publicAuthorLabel({ displayName: 'Simon Willison', identifier: 'https://simonwillison.net/x' })).toEqual({
      displayName: 'Simon Willison',
      handle: null,
    });
    expect(publicAuthorLabel({ displayName: 'Simon Willison', identifier: 'simonw' }).handle).toBe('simonw');
    const labeled = publicAuthorLabel({
      displayName: '',
      identifier: 'https://example.com/feed.xml',
    });
    expect(labeled.displayName).toBeTruthy();
    expect(labeled.displayName).not.toMatch(/^https?:/i);
    expect(labeled.handle).toBeNull();
  });

  it('slugifies display names to URL-safe tokens', () => {
    expect(researcherSlugFromDisplayName('Simon Willison')).toBe('simon-willison');
    expect(researcherSlugFromDisplayName('Francois Chollet')).toMatch(/^francois-chollet/);
  });
});

describe('researcher side from claim sides, never source org category', () => {
  it('is lab when claims are only/decisively lab even if sources.category is critics', () => {
    expect(
      aggregateResearcherSide({
        lab: 4,
        critic: 0,
        other: 0,
        sourceCategory: 'critics',
      }),
    ).toBe('lab');
    expect(
      aggregateResearcherSide({
        lab: 5,
        critic: 1,
        other: 0,
        sourceCategory: 'critics',
      }),
    ).toBe('lab');
  });

  it('is critic when claims are only/decisively critic', () => {
    expect(aggregateResearcherSide({ lab: 0, critic: 3, other: 0 })).toBe('critic');
  });

  it('is other on ties, missing claims, or mixed non-decisive sets', () => {
    expect(aggregateResearcherSide({ lab: 0, critic: 0, other: 0 })).toBe('other');
    expect(aggregateResearcherSide({ lab: 2, critic: 2, other: 0 })).toBe('other');
    expect(aggregateResearcherSide({ lab: 1, critic: 1, other: 1 })).toBe('other');
    expect(aggregateResearcherSide({ lab: 0, critic: 0, other: 4 })).toBe('other');
  });
});

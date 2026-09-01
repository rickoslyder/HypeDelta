/**
 * Seed-catalog activation must keep audited-dead endpoints inactive
 * across fresh seed and routine reseed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SOURCE_DEACTIVATIONS } from '../source-reliability';

const { upsert, close } = vi.hoisted(() => ({
  upsert: vi.fn().mockResolvedValue(1),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../storage', () => ({
  SourceStore: class {
    upsert = upsert;
    close = close;
  },
  ContentStore: class {},
}));

type CatalogRow = {
  type: string;
  identifier: string;
  isActive?: boolean;
};

function catalogRows(data: {
  twitter: Array<{ handle: string; isActive?: boolean }>;
  substack: Array<{ url: string; isActive?: boolean }>;
  youtube: Array<{ id: string; isActive?: boolean }>;
  blog: Array<{ url: string; isActive?: boolean }>;
  lesswrong: Array<{ tag: string; isActive?: boolean }>;
  arxiv: Array<{ category: string; isActive?: boolean }>;
  bluesky: Array<{ handle: string; isActive?: boolean }>;
  podcast: Array<{ rss: string; isActive?: boolean }>;
}): CatalogRow[] {
  return [
    ...data.twitter.map((s) => ({ type: 'twitter', identifier: s.handle, isActive: s.isActive })),
    ...data.substack.map((s) => ({ type: 'substack', identifier: s.url, isActive: s.isActive })),
    ...data.youtube.map((s) => ({ type: 'youtube', identifier: s.id, isActive: s.isActive })),
    ...data.blog.map((s) => ({ type: 'blog', identifier: s.url, isActive: s.isActive })),
    ...data.lesswrong.map((s) => ({ type: 'lesswrong', identifier: s.tag, isActive: s.isActive })),
    ...data.arxiv.map((s) => ({ type: 'arxiv', identifier: s.category, isActive: s.isActive })),
    ...data.bluesky.map((s) => ({ type: 'bluesky', identifier: s.handle, isActive: s.isActive })),
    ...data.podcast.map((s) => ({ type: 'podcast', identifier: s.rss, isActive: s.isActive })),
  ];
}

describe('source seed activation', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../data/sources.json'), 'utf8'),
  ) as Parameters<typeof catalogRows>[0];
  const rows = catalogRows(catalog);

  it('keeps the five audited dead endpoints in seed data as explicitly inactive', () => {
    expect(SOURCE_DEACTIVATIONS).toHaveLength(5);
    for (const dead of SOURCE_DEACTIVATIONS) {
      const row = rows.find((r) => r.type === dead.type && r.identifier === dead.identifier);
      expect(row, `${dead.type} ${dead.identifier}`).toBeDefined();
      expect(row!.isActive).toBe(false);
    }
  });

  it('does not mark Microsoft Research inactive', () => {
    const microsoft = rows.find(
      (r) => r.identifier === 'https://www.microsoft.com/en-us/research/feed/',
    );
    expect(microsoft).toBeDefined();
    expect(microsoft!.isActive).not.toBe(false);
  });
});

describe('seedSources activation pass-through', () => {
  beforeEach(() => {
    upsert.mockClear();
    close.mockClear();
  });

  it('passes explicit isActive from seed data and omits it when absent', async () => {
    const { seedSources } = await import('../fetcher');
    await seedSources('postgresql://localhost/test');

    expect(upsert).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    for (const dead of SOURCE_DEACTIVATIONS) {
      const call = upsert.mock.calls.find(
        (args) => args[0].type === dead.type && args[0].identifier === dead.identifier,
      );
      expect(call, `${dead.type} ${dead.identifier}`).toBeDefined();
      expect(call![0].isActive).toBe(false);
    }

    const microsoft = upsert.mock.calls.find(
      (args) => args[0].identifier === 'https://www.microsoft.com/en-us/research/feed/',
    );
    expect(microsoft).toBeDefined();
    expect(microsoft![0].isActive).toBeUndefined();
  });
});

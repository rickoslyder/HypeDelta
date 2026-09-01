/**
 * Unit tests for scripts/verify-production-compose.mjs
 * No Docker dependency — fixtures mimic `docker compose config --format json`.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// Verifier ships as plain ESM for CI CLI use; cast exports for the typechecker.
import * as composeVerifier from '../../scripts/verify-production-compose.mjs';

const verifyProductionCompose = composeVerifier.verifyProductionCompose as (
  model: unknown,
) => { ok: boolean; errors: string[] };
const isImmutableLookingImage = composeVerifier.isImmutableLookingImage as (
  image: string,
) => boolean;

const ROOT = resolve(__dirname, '../..');
const CLI = resolve(ROOT, 'scripts/verify-production-compose.mjs');

function validModel(overrides = {}) {
  const base = {
    name: 'hypedelta',
    services: {
      postgres: {
        image: 'pgvector/pgvector:pg16',
        environment: {
          POSTGRES_USER: 'aiintel',
          POSTGRES_PASSWORD: 'ci-only-secret-value',
          POSTGRES_DB: 'ai_intel',
        },
        volumes: [
          {
            type: 'volume',
            source: 'hypedelta_pgdata',
            target: '/var/lib/postgresql/data',
            volume: {},
          },
        ],
        networks: { 'ai-intel-network': null },
      },
      worker: {
        image: 'ghcr.io/example/hypedelta-worker:sha-deadbeef',
        environment: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:***@postgres:5432/ai_intel',
          TWITTER_API_KEY: 'ci-twitter',
          DEEPSEEK_API_KEY: 'ci-deepseek',
          KIMI_CODING_API_KEY: 'ci-kimi',
          WORKER_RUN_INITIAL_CYCLE: 'false',
          OLLAMA_URL: 'http://ollama:11434',
        },
        volumes: [
          {
            type: 'volume',
            source: 'worker_digests',
            target: '/app/data/digests',
            volume: {},
          },
        ],
        networks: { 'ai-intel-network': null },
      },
      web: {
        image: 'ghcr.io/example/hypedelta-web:sha-cafebabe',
        environment: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@postgres:5432/ai_intel',
          ADMIN_PASSWORD: 'ci-admin',
          ADMIN_SESSION_SECRET: 'ci-session',
        },
        networks: {
          'ai-intel-network': null,
          traefik_proxy: null,
        },
        labels: {
          'traefik.enable': 'true',
          'traefik.docker.network': 'traefik_proxy',
          'traefik.http.services.hypedelta.loadbalancer.server.port': '3000',
        },
      },
    },
    networks: {
      'ai-intel-network': { name: 'ai-intel-network', external: true },
      traefik_proxy: { name: 'traefik_proxy', external: true },
    },
    volumes: {
      hypedelta_pgdata: { name: 'hypedelta_pgdata', external: true },
      worker_digests: { name: 'hypedelta_worker_digests', external: true },
    },
  };

  return deepMerge(base, overrides);
}

function deepMerge(a: any, b: any): any {
  if (b === null || b === undefined) return a;
  if (Array.isArray(b)) return b.slice();
  if (typeof b !== 'object') return b;
  const out: any = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      a &&
      typeof a[k] === 'object' &&
      !Array.isArray(a[k])
    ) {
      out[k] = deepMerge(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function clone(m: unknown): any {
  return JSON.parse(JSON.stringify(m));
}

describe('isImmutableLookingImage', () => {
  it('accepts tagged and digest refs; rejects latest and untagged', () => {
    expect(isImmutableLookingImage('ghcr.io/x/y:sha-abc')).toBe(true);
    expect(isImmutableLookingImage('x/y:1.2.3')).toBe(true);
    expect(
      isImmutableLookingImage(
        'ghcr.io/x/y@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toBe(true);
    expect(isImmutableLookingImage('ghcr.io/x/y:latest')).toBe(false);
    expect(isImmutableLookingImage('ghcr.io/x/y')).toBe(false);
    expect(isImmutableLookingImage('')).toBe(false);
  });
});

describe('verifyProductionCompose — valid model', () => {
  it('accepts a canonical rendered-like model', () => {
    const result = verifyProductionCompose(validModel());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('verifyProductionCompose — independent fail cases', () => {
  it('fails wrong/missing Traefik network pin', () => {
    const m = clone(validModel());
    m.services.web.labels['traefik.docker.network'] = 'wrong_net';
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /traefik\.docker\.network/i.test(e))).toBe(true);
    // bounded: never dump secret values
    expect(r.errors.join('\n')).not.toMatch(/ci-only-secret-value|ci-twitter|ci-admin/);
  });

  it('fails missing Traefik network pin', () => {
    const m = clone(validModel());
    delete m.services.web.labels['traefik.docker.network'];
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /traefik\.docker\.network/i.test(e))).toBe(true);
  });

  it('fails extra network on worker', () => {
    const m = clone(validModel());
    m.services.worker.networks = {
      'ai-intel-network': null,
      traefik_proxy: null,
    };
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /worker:.*ai-intel-network/i.test(e))).toBe(true);
  });

  it('fails published port', () => {
    const m = clone(validModel());
    m.services.web.ports = [{ target: 3000, published: '3000', protocol: 'tcp' }];
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /published ports/i.test(e))).toBe(true);
  });

  it('fails bind mount', () => {
    const m = clone(validModel());
    m.services.worker.volumes.push({
      type: 'bind',
      source: './data',
      target: '/app/data',
    });
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /bind mounts/i.test(e))).toBe(true);
  });

  it('fails build key', () => {
    const m = clone(validModel());
    m.services.web.build = { context: '.' };
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /build key/i.test(e))).toBe(true);
  });

  it('fails nonexternal volume', () => {
    const m = clone(validModel());
    m.volumes.hypedelta_pgdata = { name: 'hypedelta_pgdata', external: false };
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /hypedelta_pgdata.*external/i.test(e))).toBe(true);
  });

  it('fails latest image', () => {
    const m = clone(validModel());
    m.services.web.image = 'ghcr.io/example/hypedelta-web:latest';
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /immutable-looking/i.test(e))).toBe(true);
  });

  it('fails unversioned image', () => {
    const m = clone(validModel());
    m.services.worker.image = 'ghcr.io/example/hypedelta-worker';
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /immutable-looking/i.test(e))).toBe(true);
  });

  it('fails startup initial-cycle true', () => {
    const m = clone(validModel());
    m.services.worker.environment.WORKER_RUN_INITIAL_CYCLE = 'true';
    const r = verifyProductionCompose(m);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e: string) => /WORKER_RUN_INITIAL_CYCLE must resolve to false/i.test(e)),
    ).toBe(true);
    expect(r.errors.join('\n')).not.toContain('ci-twitter');
  });

  it('fails missing DEEPSEEK_API_KEY or KIMI_CODING_API_KEY on worker', () => {
    const missingDs = clone(validModel());
    delete missingDs.services.worker.environment.DEEPSEEK_API_KEY;
    const ds = verifyProductionCompose(missingDs);
    expect(ds.ok).toBe(false);
    expect(ds.errors.some((e: string) => /DEEPSEEK_API_KEY/i.test(e))).toBe(true);

    const missingKimi = clone(validModel());
    delete missingKimi.services.worker.environment.KIMI_CODING_API_KEY;
    const kimi = verifyProductionCompose(missingKimi);
    expect(kimi.ok).toBe(false);
    expect(kimi.errors.some((e: string) => /KIMI_CODING_API_KEY/i.test(e))).toBe(true);
  });

  it('fails missing or wrong worker OLLAMA_URL', () => {
    const missing = clone(validModel());
    delete missing.services.worker.environment.OLLAMA_URL;
    const missingResult = verifyProductionCompose(missing);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.some((e: string) => /OLLAMA_URL/i.test(e))).toBe(true);

    const wrong = clone(validModel());
    wrong.services.worker.environment.OLLAMA_URL = 'http://localhost:11434';
    const wrongResult = verifyProductionCompose(wrong);
    expect(wrongResult.ok).toBe(false);
    expect(wrongResult.errors.some((e: string) => /OLLAMA_URL/i.test(e))).toBe(true);
    expect(wrongResult.errors.join('\n')).not.toContain('http://localhost:11434');
  });

  it('fails when worker passes Claude/GLM/Anthropic keys or provider URL overrides', () => {
    for (const key of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'GLM_API_KEY',
      'ANTHROPIC_API_KEY',
      'DEEPSEEK_BASE_URL',
      'KIMI_CODING_BASE_URL',
    ]) {
      const m = clone(validModel());
      m.services.worker.environment[key] = 'should-not-pass';
      const r = verifyProductionCompose(m);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e: string) => new RegExp(key, 'i').test(e))).toBe(true);
      expect(r.errors.join('\n')).not.toContain('should-not-pass');
      expect(r.errors.join('\n')).not.toContain('ci-deepseek');
    }
  });
});

describe('verify-production-compose CLI', () => {
  it('exits 0 on valid fixture and 1 on malformed without dumping secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hd-compose-'));
    try {
      const good = join(dir, 'good.json');
      const bad = join(dir, 'bad.json');
      writeFileSync(good, JSON.stringify(validModel()), 'utf8');
      const badModel = clone(validModel());
      badModel.services.web.ports = [{ published: '80', target: 3000 }];
      badModel.services.postgres.environment.POSTGRES_PASSWORD = 'super-secret-password-xyz';
      writeFileSync(bad, JSON.stringify(badModel), 'utf8');

      const okRun = spawnSync(process.execPath, [CLI, good], { encoding: 'utf8' });
      expect(okRun.status).toBe(0);
      expect(okRun.stdout.trim()).toBe('ok');

      const badRun = spawnSync(process.execPath, [CLI, bad], { encoding: 'utf8' });
      expect(badRun.status).toBe(1);
      expect(badRun.stderr).toMatch(/published ports/i);
      expect(badRun.stderr + badRun.stdout).not.toContain('super-secret-password-xyz');
      // no full model dump
      expect(badRun.stderr).not.toMatch(/"services"\s*:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

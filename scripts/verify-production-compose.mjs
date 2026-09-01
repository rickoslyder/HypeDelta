#!/usr/bin/env node
/**
 * Deterministic verifier for `docker compose config --format json`
 * rendered from deploy/docker-compose.production.yml.
 *
 * Pure export: verifyProductionCompose(model) -> { ok, errors }
 * CLI: node scripts/verify-production-compose.mjs <path-to-json>
 *
 * Failures are bounded (short codes/messages). Never dumps the model or secret values.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_SERVICES = ['postgres', 'worker', 'web'];
const PRIVATE_NETWORK = 'ai-intel-network';
const EDGE_NETWORK = 'traefik_proxy';
const PG_VOLUME_NAME = 'hypedelta_pgdata';
const WORKER_DIGEST_VOLUME_NAME = 'hypedelta_worker_digests';
const PG_IMAGE_ALLOWED = 'pgvector/pgvector:pg16';

/** Secret env keys that must exist after render (values never printed). */
const REQUIRED_SECRET_ENV = {
  postgres: ['POSTGRES_PASSWORD'],
  worker: ['DATABASE_URL', 'TWITTER_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_CODING_API_KEY'],
  web: ['DATABASE_URL', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'],
};

/** Worker must not receive retired model credentials or URL/model overrides. */
const FORBIDDEN_WORKER_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GLM_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_BASE_URL',
  'KIMI_CODING_BASE_URL',
];

/**
 * @param {unknown} model
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyProductionCompose(model) {
  const errors = [];
  const fail = (msg) => {
    errors.push(msg);
  };

  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return { ok: false, errors: ['invalid-model: expected object'] };
  }

  /** @type {Record<string, any>} */
  const root = model;
  const services = root.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    fail('services: missing or invalid');
    return { ok: false, errors };
  }

  const serviceNames = Object.keys(services).sort();
  const expected = [...REQUIRED_SERVICES].sort();
  if (
    serviceNames.length !== expected.length ||
    serviceNames.some((n, i) => n !== expected[i])
  ) {
    fail(
      `services: expected exactly ${REQUIRED_SERVICES.join(',')} (got ${serviceNames.join(',') || 'none'})`,
    );
  }

  const networks = root.networks;
  if (!networks || typeof networks !== 'object') {
    fail('networks: missing');
  } else {
    assertExternalNamed(networks, PRIVATE_NETWORK, PRIVATE_NETWORK, fail);
    assertExternalNamed(networks, EDGE_NETWORK, EDGE_NETWORK, fail);
  }

  const volumes = root.volumes;
  if (!volumes || typeof volumes !== 'object') {
    fail('volumes: missing');
  } else {
    assertExternalVolume(volumes, PG_VOLUME_NAME, fail, {
      alsoAcceptKeys: [PG_VOLUME_NAME],
    });
    assertExternalVolume(volumes, WORKER_DIGEST_VOLUME_NAME, fail, {
      alsoAcceptKeys: ['worker_digests', WORKER_DIGEST_VOLUME_NAME],
    });
  }

  for (const name of REQUIRED_SERVICES) {
    if (!(name in services)) continue;
    checkService(name, services[name], volumes, fail);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Image is nonempty, not :latest, and has a tag or digest.
 * @param {string} image
 */
export function isImmutableLookingImage(image) {
  if (!image || typeof image !== 'string') return false;
  const s = image.trim();
  if (!s) return false;
  if (/@sha256:[a-f0-9]{32,}$/i.test(s)) {
    // still reject explicit :latest@sha256 (rare)
    if (/:latest@/i.test(s)) return false;
    return true;
  }
  if (/:latest$/i.test(s)) return false;
  const lastSlash = s.lastIndexOf('/');
  const namePart = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  if (!namePart.includes(':')) return false;
  const tag = namePart.slice(namePart.indexOf(':') + 1);
  if (!tag || tag.toLowerCase() === 'latest') return false;
  return true;
}

/**
 * @param {string} name
 * @param {any} svc
 * @param {any} volumes
 * @param {(m: string) => void} fail
 */
function checkService(name, svc, volumes, fail) {
  if (!svc || typeof svc !== 'object') {
    fail(`${name}: invalid service`);
    return;
  }

  if ('build' in svc && svc.build != null) {
    fail(`${name}: build key forbidden (image-only)`);
  }

  const image = typeof svc.image === 'string' ? svc.image.trim() : '';
  if (!image) {
    fail(`${name}: image missing`);
  } else if (name === 'postgres') {
    if (image !== PG_IMAGE_ALLOWED && !isImmutableLookingImage(image)) {
      fail(`${name}: image not immutable-looking`);
    }
  } else if (!isImmutableLookingImage(image)) {
    fail(`${name}: image not immutable-looking`);
  }

  if (Array.isArray(svc.ports) && svc.ports.length > 0) {
    fail(`${name}: published ports forbidden`);
  } else if (svc.ports && !Array.isArray(svc.ports) && typeof svc.ports === 'object') {
    if (Object.keys(svc.ports).length > 0) {
      fail(`${name}: published ports forbidden`);
    }
  }

  const mounts = normalizeMounts(svc.volumes);
  for (const m of mounts) {
    if (m.type === 'bind' || m.bind) {
      fail(`${name}: bind mounts forbidden`);
      break;
    }
  }

  const nets = networkNames(svc.networks);
  if (name === 'postgres' || name === 'worker') {
    if (nets.length !== 1 || nets[0] !== PRIVATE_NETWORK) {
      fail(`${name}: must be only on ${PRIVATE_NETWORK}`);
    }
  } else if (name === 'web') {
    const set = new Set(nets);
    if (
      nets.length !== 2 ||
      !set.has(PRIVATE_NETWORK) ||
      !set.has(EDGE_NETWORK)
    ) {
      fail(`web: must be exactly on ${PRIVATE_NETWORK}+${EDGE_NETWORK}`);
    }
  }

  if (name === 'web') {
    const labels = normalizeLabels(svc.labels);
    if (labels['traefik.enable'] !== 'true') {
      fail('web: traefik.enable must be true');
    }
    if (labels['traefik.docker.network'] !== EDGE_NETWORK) {
      fail('web: traefik.docker.network pin missing or wrong');
    }
    const port =
      labels['traefik.http.services.hypedelta.loadbalancer.server.port'];
    if (port !== '3000') {
      fail('web: traefik router service port must be 3000');
    }
  }

  if (name === 'postgres') {
    assertServiceUsesExternalVolume(name, mounts, volumes, PG_VOLUME_NAME, fail);
  }
  if (name === 'worker') {
    assertServiceUsesExternalVolume(
      name,
      mounts,
      volumes,
      WORKER_DIGEST_VOLUME_NAME,
      fail,
    );
  }

  const env = normalizeEnv(svc.environment);
  const requiredKeys = REQUIRED_SECRET_ENV[name] || [];
  for (const key of requiredKeys) {
    if (!(key in env) || env[key] === undefined || env[key] === null || env[key] === '') {
      fail(`${name}: required env ${key} missing`);
    }
  }

  if (name === 'worker') {
    for (const key of FORBIDDEN_WORKER_ENV) {
      if (key in env) {
        fail(`${name}: must not pass ${key}`);
      }
    }
    const v = env.WORKER_RUN_INITIAL_CYCLE;
    if (v !== 'false') {
      fail('worker: WORKER_RUN_INITIAL_CYCLE must resolve to false');
    }
    if (env.OLLAMA_URL !== 'http://ollama:11434') {
      fail('worker: OLLAMA_URL must be http://ollama:11434');
    }
  }
}

/**
 * @param {any} networks
 * @param {string} keyOrName
 * @param {string} expectedName
 * @param {(m: string) => void} fail
 */
function assertExternalNamed(networks, keyOrName, expectedName, fail) {
  let entry = networks[keyOrName];
  let foundKey = keyOrName;
  if (!entry) {
    for (const [k, v] of Object.entries(networks)) {
      if (v && typeof v === 'object' && v.name === expectedName) {
        entry = v;
        foundKey = k;
        break;
      }
    }
  }
  if (!entry || typeof entry !== 'object') {
    fail(`networks: ${expectedName} missing`);
    return;
  }
  const resolvedName = typeof entry.name === 'string' ? entry.name : foundKey;
  if (resolvedName !== expectedName) {
    fail(`networks: ${expectedName} name mismatch`);
  }
  if (!isExternalTrue(entry.external)) {
    fail(`networks: ${expectedName} must be external`);
  }
}

/**
 * @param {any} volumes
 * @param {string} exactName
 * @param {(m: string) => void} fail
 * @param {{ alsoAcceptKeys?: string[] }} [opts]
 */
function assertExternalVolume(volumes, exactName, fail, opts = {}) {
  const keys = opts.alsoAcceptKeys || [exactName];
  let entry = null;
  for (const k of keys) {
    if (volumes[k]) {
      entry = volumes[k];
      break;
    }
  }
  if (!entry) {
    for (const v of Object.values(volumes)) {
      if (v && typeof v === 'object' && v.name === exactName) {
        entry = v;
        break;
      }
    }
  }
  if (!entry || typeof entry !== 'object') {
    fail(`volumes: ${exactName} missing`);
    return;
  }
  const resolved = typeof entry.name === 'string' ? entry.name : exactName;
  if (resolved !== exactName) {
    fail(`volumes: ${exactName} name mismatch`);
  }
  if (!isExternalTrue(entry.external)) {
    fail(`volumes: ${exactName} must be external`);
  }
}

/**
 * @param {string} serviceName
 * @param {any[]} mounts
 * @param {any} volumes
 * @param {string} exactExternalName
 * @param {(m: string) => void} fail
 */
function assertServiceUsesExternalVolume(
  serviceName,
  mounts,
  volumes,
  exactExternalName,
  fail,
) {
  const volMounts = mounts.filter(
    (m) =>
      m &&
      typeof m === 'object' &&
      m.type !== 'bind' &&
      (m.type === 'volume' || m.source),
  );
  if (volMounts.length === 0) {
    fail(`${serviceName}: missing volume mount for ${exactExternalName}`);
    return;
  }

  const ok = volMounts.some((m) => {
    const source = m.source;
    if (typeof source !== 'string') return false;
    if (source === exactExternalName) return true;
    if (volumes && volumes[source]) {
      const def = volumes[source];
      const name = typeof def?.name === 'string' ? def.name : source;
      return name === exactExternalName && isExternalTrue(def.external);
    }
    return false;
  });
  if (!ok) {
    fail(`${serviceName}: volume must be external ${exactExternalName}`);
  }
}

/** @param {any} external */
function isExternalTrue(external) {
  if (external === true) return true;
  if (external && typeof external === 'object') return true;
  return false;
}

/** @param {any} networks */
function networkNames(networks) {
  if (!networks) return [];
  if (Array.isArray(networks)) return networks.map(String).sort();
  if (typeof networks === 'object') return Object.keys(networks).sort();
  return [];
}

/** @param {any} labels */
function normalizeLabels(labels) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!labels) return out;
  if (Array.isArray(labels)) {
    for (const item of labels) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq === -1) out[item] = 'true';
      else out[item.slice(0, eq)] = item.slice(eq + 1);
    }
    return out;
  }
  if (typeof labels === 'object') {
    for (const [k, v] of Object.entries(labels)) {
      out[k] = v == null ? '' : String(v);
    }
  }
  return out;
}

/** @param {any} environment */
function normalizeEnv(environment) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!environment) return out;
  if (Array.isArray(environment)) {
    for (const item of environment) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq === -1) out[item] = '';
      else out[item.slice(0, eq)] = item.slice(eq + 1);
    }
    return out;
  }
  if (typeof environment === 'object') {
    for (const [k, v] of Object.entries(environment)) {
      out[k] = v == null ? '' : String(v);
    }
  }
  return out;
}

/** @param {any} volumes */
function normalizeMounts(volumes) {
  if (!volumes) return [];
  if (!Array.isArray(volumes)) return [];
  return volumes.map((v) => {
    if (typeof v === 'string') {
      const parts = v.split(':');
      const src = parts[0] ?? '';
      if (
        src.startsWith('./') ||
        src.startsWith('../') ||
        src.startsWith('/') ||
        src.startsWith('~/') ||
        src === '.' ||
        src.startsWith('.')
      ) {
        return { type: 'bind', source: src, raw: v };
      }
      return { type: 'volume', source: src, raw: v };
    }
    return v && typeof v === 'object' ? v : { raw: v };
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '-h' || args[0] === '--help') {
    console.error('usage: node scripts/verify-production-compose.mjs <compose.json>');
    process.exit(2);
  }
  const filePath = resolve(args[0]);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    console.error('error: cannot read input file');
    process.exit(2);
  }
  let model;
  try {
    model = JSON.parse(raw);
  } catch {
    console.error('error: invalid JSON');
    process.exit(2);
  }
  const result = verifyProductionCompose(model);
  if (!result.ok) {
    for (const e of result.errors) {
      console.error(e);
    }
    process.exit(1);
  }
  console.log('ok');
  process.exit(0);
}

const entry = process.argv[1];
if (
  entry &&
  (import.meta.url === pathToFileURL(resolve(entry)).href ||
    entry.endsWith('verify-production-compose.mjs'))
) {
  main();
}

/**
 * Release contract tests for the immutable worker image and
 * canonical production Compose stack.
 *
 * These tests intentionally read Dockerfile / Compose as source text so
 * regressions in the deploy contract fail in CI before shipping.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

function stripCommentsAndStrings(src: string): string {
  // Rough strip so comment examples do not satisfy / fail contract checks.
  return src
    .replace(/^\s*#.*$/gm, '')
    .replace(/"[^"\n]*"/g, '""')
    .replace(/'[^'\n]*'/g, "''");
}

/** Extract a named Dockerfile stage body (FROM ... AS name → next FROM / EOF). */
function stageBody(df: string, name: string): string {
  const start = df.search(new RegExp(`FROM\\s+\\S+\\s+AS\\s+${name}\\b`, 'i'));
  expect(start).toBeGreaterThanOrEqual(0);
  const after = df.slice(start + 1);
  const nextFromRel = after.search(/\nFROM\s+/i);
  return nextFromRel >= 0
    ? df.slice(start, start + 1 + nextFromRel)
    : df.slice(start);
}

describe('worker Dockerfile release contract', () => {
  const dockerfilePath = resolve(ROOT, 'Dockerfile');

  it('exists at repository root', () => {
    expect(existsSync(dockerfilePath)).toBe(true);
  });

  it('is a multi-stage node:20-bookworm-slim image with exact pnpm + frozen install', () => {
    const df = read('Dockerfile');

    expect(df).toMatch(/FROM\s+node:20-bookworm-slim\s+AS\s+\w+/i);
    expect(df.match(/FROM\s+node:20-bookworm-slim/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);

    expect(df).toMatch(/corepack\s+prepare\s+pnpm@10\.33\.0\b/);
    expect(df).toMatch(/pnpm\s+install\s+--frozen-lockfile/);

    // Never npm install/ci for dependency install
    expect(df).not.toMatch(/\bnpm\s+ci\b/);
    expect(df).not.toMatch(/\bnpm\s+install\b/);
  });

  it('builds a bundled Node-runnable worker entrypoint (no raw tsc scheduler / tsx / npx)', () => {
    const df = read('Dockerfile');
    const runtime = stripCommentsAndStrings(df);

    // Builder must produce the esbuild worker bundle, not only raw tsc output.
    expect(df).toMatch(/\bpnpm\s+run\s+build:worker\b/);
    expect(df).toMatch(/CMD\s*\[\s*"node"\s*,\s*"dist\/worker\.js"\s*\]/);

    // Never ship extensionless tsc ESM as the process entrypoint.
    expect(df).not.toMatch(/CMD\s*\[\s*"node"\s*,\s*"dist\/scheduler\.js"\s*\]/);
    expect(df).not.toMatch(/CMD\s*\[\s*"node"\s*,\s*"dist\/index(?:\.js)?"\s*\]/);
    // Operational CLI stays an exec target, never the process CMD.
    expect(df).not.toMatch(/CMD\s*\[\s*"node"\s*,\s*"dist\/cli(?:-worker)?\.js"\s*\]/);

    // Runtime must not invoke tsx / npx
    expect(runtime).not.toMatch(/\bnpx\b/);
    expect(runtime).not.toMatch(/\btsx\b/);
    expect(df).not.toMatch(/CMD\s*\[.*tsx/);
    expect(df).not.toMatch(/CMD\s*\[.*npx/);
  });

  it('declares JSON-form HEALTHCHECK invoking only node dist/worker-healthcheck.js', () => {
    const df = read('Dockerfile');
    // Exec/JSON form only — no shell secret expansion, no tsx/npx.
    expect(df).toMatch(
      /HEALTHCHECK\b[\s\S]*?CMD\s*\[\s*"node"\s*,\s*"dist\/worker-healthcheck\.js"\s*\]/,
    );
    expect(df).not.toMatch(/HEALTHCHECK\b[^\n]*CMD-SHELL/);
    const hcBlock = df.match(/HEALTHCHECK\b[\s\S]*?(?=\n[A-Z]|\n*$)/)?.[0] ?? '';
    expect(hcBlock).toMatch(/HEALTHCHECK/);
    expect(hcBlock).not.toMatch(/\btsx\b|\bnpx\b|\/bin\/sh|bash\s+-c/);
    // Compatible with immediate heartbeat + ~6 minute max age.
    expect(hcBlock).toMatch(/--interval=/);
    expect(hcBlock).toMatch(/--timeout=/);
    expect(hcBlock).toMatch(/--start-period=/);
    expect(hcBlock).toMatch(/--retries=/);
  });

  it('runtime includes full builder dist (bundled CLI via existing dist copy)', () => {
    // build:worker emits dist/worker.js + dist/cli-worker.js; runner must copy
    // the whole dist tree so ops can exec `node dist/cli-worker.js status|fetch`.
    const runner = stageBody(read('Dockerfile'), 'runner');
    const distCopy = runner.match(/COPY\s+[^\n]*\bdist\b[^\n]*/i)?.[0];
    expect(distCopy).toBeTruthy();
    // Full tree copy — not a single-file worker-only path.
    expect(distCopy).toMatch(/\/app\/dist\b|\.\/dist\b/);
    expect(distCopy).not.toMatch(/dist\/worker\.js\b/);
    // CMD remains the scheduler worker, not the operational CLI.
    expect(runner).toMatch(/CMD\s*\[\s*"node"\s*,\s*"dist\/worker\.js"\s*\]/);
  });

  it('pins yt-dlp and includes ffmpeg + python3 runtime deps', () => {
    const df = read('Dockerfile');
    expect(df).toMatch(/\bffmpeg\b/);
    expect(df).toMatch(/\bpython3\b/);
    // Proven pin: 2026.07.04 / PyPI 2026.7.4
    expect(df).toMatch(/yt-dlp==2026\.7\.4/);
  });

  it('copies immutable sources.json and .claude skills/agents; writable digests; non-root', () => {
    const df = read('Dockerfile');

    expect(df).toMatch(/COPY\s+.*data\/sources\.json/);
    expect(df).toMatch(/COPY\s+.*\.claude/);
    expect(df).toMatch(/\/app\/data\/digests/);
    expect(df).toMatch(/^\s*USER\s+node\s*$/m);

    // No secrets baked in
    expect(df).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|TWITTER_API_KEY|GLM_API_KEY|ADMIN_PASSWORD|POSTGRES_PASSWORD|DEEPSEEK_API_KEY|KIMI_CODING_API_KEY|ANTHROPIC_API_KEY/);
    expect(df).not.toMatch(/API_KEY\s*=\s*\S+/);
  });

  it('copies data/sources.json into the builder stage before RUN pnpm run build:worker', () => {
    // fetcher.ts imports ../data/sources.json; tsc/bundle fails if the catalog is
    // missing from the builder stage (runtime COPY alone is not enough).
    const df = read('Dockerfile');
    const builderStage = stageBody(df, 'builder');

    const sourcesCopyIdx = builderStage.search(
      /COPY\s+(?:--from=\S+\s+)*\S*data\/sources\.json\b/,
    );
    const buildIdx = builderStage.search(/RUN\s+pnpm\s+run\s+build:worker\b/);

    expect(sourcesCopyIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(sourcesCopyIdx).toBeLessThan(buildIdx);
  });

  it('runner never recursively chowns /app (avoids duplicate ~490MB layer)', () => {
    const runner = stageBody(read('Dockerfile'), 'runner');
    // Recursive ownership rewrite of the whole tree rewrites every layer payload.
    expect(runner).not.toMatch(/\bchown\s+(-R|--recursive)\s+\S+\s+\/app\b/);
    expect(runner).not.toMatch(/\bchown\s+(-R|--recursive)\s+\S+\s+\/app\//);
  });

  it('runner payload COPY for dist, sources.json, and .claude uses --chown=node:node', () => {
    const runner = stageBody(read('Dockerfile'), 'runner');

    const distCopy = runner.match(
      /COPY\s+[^\n]*\bdist\b[^\n]*/i,
    )?.[0];
    const sourcesCopy = runner.match(
      /COPY\s+[^\n]*data\/sources\.json[^\n]*/i,
    )?.[0];
    const claudeCopy = runner.match(
      /COPY\s+[^\n]*\.claude[^\n]*/i,
    )?.[0];

    expect(distCopy).toBeTruthy();
    expect(sourcesCopy).toBeTruthy();
    expect(claudeCopy).toBeTruthy();

    for (const line of [distCopy!, sourcesCopy!, claudeCopy!]) {
      expect(line).toMatch(/--chown=node:node\b/);
    }
  });

  it('runner creates /app/data/digests with node ownership without rewriting /app', () => {
    const runner = stageBody(read('Dockerfile'), 'runner');

    // Digest dir must be created for the non-root runtime user.
    expect(runner).toMatch(/\/app\/data\/digests/);

    // Accept either: install -d -o node -g node, or mkdir + non-recursive chown
    // scoped to the digests path (or its immediate parent data dir only).
    const installOwned = /install\s+-d\b[^\n]*-o\s+node\b[^\n]*-g\s+node\b[^\n]*\/app\/data\/digests/;
    const installOwnedAlt = /install\s+-d\b[^\n]*\/app\/data\/digests[^\n]*-o\s+node\b/;
    const mkdirPlusScopedChown =
      /mkdir\s+-p\s+\/app\/data\/digests[\s\S]{0,120}?chown\s+(?!-R\b)(?!--recursive\b)node:node\s+\/app\/data(?:\/digests)?\b/;

    const owned =
      installOwned.test(runner) ||
      installOwnedAlt.test(runner) ||
      mkdirPlusScopedChown.test(runner);
    expect(owned).toBe(true);

    // Explicit ban on recursive rewrite of the whole app tree.
    expect(runner).not.toMatch(/\bchown\s+(-R|--recursive)\s+\S+\s+\/app\s*$/m);
  });

  it('runner prod install is root-package only (no workspace manifest / web package.json)', () => {
    const runner = stageBody(read('Dockerfile'), 'runner');

    // Production install must be present and frozen.
    const prodInstallIdx = runner.search(
      /pnpm\s+install\s+[^\n]*--frozen-lockfile[^\n]*--prod|--prod[^\n]*--frozen-lockfile/,
    );
    expect(prodInstallIdx).toBeGreaterThanOrEqual(0);

    const beforeInstall = runner.slice(0, prodInstallIdx);

    // Only root package.json + lockfile may be copied into runner before prod install.
    expect(beforeInstall).toMatch(
      /COPY\s+(?:--[^\s=]+=\S+\s+)*package\.json\s+pnpm-lock\.yaml\b/,
    );

    // Workspace files inflate the prod graph to "all 2 workspace projects".
    expect(beforeInstall).not.toMatch(/pnpm-workspace\.yaml/);
    expect(beforeInstall).not.toMatch(/apps\/web\/package\.json/);

    // Entire runner stage must not carry workspace layout for the worker image.
    expect(runner).not.toMatch(/pnpm-workspace\.yaml/);
    expect(runner).not.toMatch(/apps\/web\/package\.json/);
  });
});

describe('production Compose release contract', () => {
  const composeRel = 'deploy/docker-compose.production.yml';
  const composePath = resolve(ROOT, composeRel);

  it('exists at deploy/docker-compose.production.yml', () => {
    expect(existsSync(composePath)).toBe(true);
  });

  it('defines exactly postgres, worker, and web with preserved container names', () => {
    const c = read(composeRel);

    expect(c).toMatch(/^\s*postgres\s*:/m);
    expect(c).toMatch(/^\s*worker\s*:/m);
    expect(c).toMatch(/^\s*web\s*:/m);

    expect(c).toMatch(/container_name:\s*ai-intel-postgres/);
    expect(c).toMatch(/container_name:\s*ai-intel-worker/);
    expect(c).toMatch(/container_name:\s*hypedelta\b/);

    // No Redis / Ollama in the production contract
    expect(c).not.toMatch(/^\s*redis\s*:/m);
    expect(c).not.toMatch(/^\s*ollama\s*:/m);
    expect(c).not.toMatch(/image:\s*redis/i);
    expect(c).not.toMatch(/image:\s*ollama/i);
  });

  it('uses immutable image interpolation only (no build blocks)', () => {
    const c = read(composeRel);

    expect(c).toMatch(/image:\s*\$\{WEB_IMAGE[^}]*\}/);
    expect(c).toMatch(/image:\s*\$\{WORKER_IMAGE[^}]*\}/);
    expect(c).toMatch(/image:\s*pgvector\/pgvector:pg16/);

    // Required interpolation without defaults (:- forbidden for secrets/images)
    // Compose required form: ${VAR:?message}
    expect(c).toMatch(/\$\{WEB_IMAGE:\?/);
    expect(c).toMatch(/\$\{WORKER_IMAGE:\?/);

    expect(c).not.toMatch(/^\s*build\s*:/m);
  });

  it('uses external hypedelta_pgdata and has no host ports or source binds', () => {
    const c = read(composeRel);

    expect(c).toMatch(/hypedelta_pgdata/);
    expect(c).toMatch(/external:\s*true/);

    // No host port publications
    expect(c).not.toMatch(/^\s*ports\s*:/m);
    expect(c).not.toMatch(/:\d+:\d+/);

    // No source-code bind mounts (./src, ., ./data, ./.claude, etc.)
    expect(c).not.toMatch(/^\s*-\s*\.\/src:/m);
    expect(c).not.toMatch(/^\s*-\s*\.\/data:/m);
    expect(c).not.toMatch(/^\s*-\s*\.\/\.claude:/m);
    expect(c).not.toMatch(/^\s*-\s*\.:/m);

    // Digest volume may only mount at /app/data/digests (not shadowing sources.json parent wrongly as whole data/)
    if (c.includes('/app/data')) {
      expect(c).toMatch(/\/app\/data\/digests/);
      expect(c).not.toMatch(/:\s*\/app\/data\s*$/m);
      expect(c).not.toMatch(/:\s*\/app\/data:ro/m);
    }
  });

  it('declares worker_digests as the external named volume hypedelta_worker_digests', () => {
    // Volume was first created under an earlier Compose project name; canonical
    // stack must adopt it as external (same pattern as hypedelta_pgdata).
    const c = read(composeRel);
    const volumesBlock = c.split(/^volumes\s*:/m)[1]?.split(/^networks\s*:/m)[0] ?? '';
    expect(volumesBlock.length).toBeGreaterThan(20);

    // Volume keys are 2-space indent; nested keys are deeper — do not split on name:/external:.
    const digestsBlock =
      volumesBlock
        .split(/^ {2}worker_digests\s*:/m)[1]
        ?.split(/^ {2}\w[\w-]*\s*:/m)[0] ?? '';
    expect(digestsBlock.length).toBeGreaterThan(5);
    expect(digestsBlock).toMatch(/^\s*name:\s*hypedelta_worker_digests\s*$/m);
    expect(digestsBlock).toMatch(/^\s*external:\s*true\s*$/m);

    // Still no host bind mounts for digests — named volume only.
    expect(c).toMatch(/worker_digests:\/app\/data\/digests/);
    // Host binds: ./rel, /abs, ~/home, or any left-side path containing /
    expect(c).not.toMatch(/^\s*-\s*(?:\.\/|\/|~)[^:]*:\/app\/data\/digests/m);
    expect(c).not.toMatch(/^\s*-\s*[^:\s]+\/[^:]*:\/app\/data\/digests/m);
  });

  it('requires secrets via interpolation without defaults', () => {
    const c = read(composeRel);

    const required = [
      'POSTGRES_PASSWORD',
      'DATABASE_URL',
      'TWITTER_API_KEY',
      'DEEPSEEK_API_KEY',
      'KIMI_CODING_API_KEY',
      'ADMIN_PASSWORD',
      'ADMIN_SESSION_SECRET',
    ];

    for (const key of required) {
      // Compose required form: ${VAR:?message}
      expect(c).toMatch(new RegExp(`\\$\\{${key}:\\?`));
      // No ${KEY:-default} form
      expect(c).not.toMatch(new RegExp(`\\$\\{${key}:-`));
    }

    const workerBlock = c.split(/^\s*worker\s*:/m)[1]?.split(/^\s*web\s*:/m)[0] ?? '';
    expect(workerBlock.length).toBeGreaterThan(20);
    expect(workerBlock).toMatch(/\$\{DEEPSEEK_API_KEY:\?/);
    expect(workerBlock).toMatch(/\$\{KIMI_CODING_API_KEY:\?/);
    expect(workerBlock).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(workerBlock).not.toMatch(/GLM_API_KEY/);
    expect(workerBlock).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(workerBlock).not.toMatch(/DEEPSEEK_BASE_URL|KIMI_CODING_BASE_URL/);
    expect(workerBlock).not.toMatch(/deepseek-v4-flash|kimi-k3/);
    expect(workerBlock).toMatch(/OLLAMA_URL:\s*http:\/\/ollama:11434/);
    expect(workerBlock).not.toMatch(/\$\{OLLAMA_URL/);
    expect(workerBlock.replace(/OLLAMA_URL:\s*http:\/\/ollama:11434/, '')).not.toMatch(
      /https?:\/\//,
    );

    expect(c).not.toMatch(/\$\{CLAUDE_CODE_OAUTH_TOKEN/);
    expect(c).not.toMatch(/\$\{GLM_API_KEY/);
    expect(c).not.toMatch(/\$\{ANTHROPIC_API_KEY/);
    expect(c).not.toMatch(/^\s*GLM_API_KEY\s*:/m);
    expect(c).not.toMatch(/^\s*ANTHROPIC_API_KEY\s*:/m);
    expect(c).not.toMatch(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*:/m);
  });

  it('wires networks, Traefik labels, restart policy, and postgres health deps', () => {
    const c = read(composeRel);

    expect(c).toMatch(/ai-intel-network/);
    expect(c).toMatch(/traefik_proxy/);
    expect(c).toMatch(/external:\s*true/);

    // Web dual-network + Traefik pin
    expect(c).toMatch(/traefik\.docker\.network=traefik_proxy/);
    expect(c).toMatch(/traefik\.enable=true/);
    expect(c).toMatch(/Host\(`hypedelta\.rbnk\.uk`\)/);
    expect(c).toMatch(/tls\.certresolver=cf/);
    expect(c).toMatch(/loadbalancer\.server\.port=3000/);

    expect(c).toMatch(/restart:\s*unless-stopped/);
    expect(c).toMatch(/condition:\s*service_healthy/);
  });

  it('keeps worker and postgres on private network only (not traefik_proxy)', () => {
    const c = read(composeRel);

    // Split rough service blocks by top-level keys under services is brittle;
    // assert worker/postgres blocks do not list traefik_proxy membership.
    const workerBlock = c.split(/^\s*worker\s*:/m)[1]?.split(/^\s*web\s*:/m)[0] ?? '';
    const postgresBlock = c.split(/^\s*postgres\s*:/m)[1]?.split(/^\s*worker\s*:/m)[0] ?? '';
    const webBlock = c.split(/^\s*web\s*:/m)[1]?.split(/^volumes\s*:/m)[0] ?? '';

    expect(workerBlock.length).toBeGreaterThan(20);
    expect(postgresBlock.length).toBeGreaterThan(20);
    expect(webBlock.length).toBeGreaterThan(20);

    expect(workerBlock).toMatch(/ai-intel-network/);
    expect(workerBlock).not.toMatch(/traefik_proxy/);
    expect(postgresBlock).toMatch(/ai-intel-network/);
    expect(postgresBlock).not.toMatch(/traefik_proxy/);

    expect(webBlock).toMatch(/ai-intel-network/);
    expect(webBlock).toMatch(/traefik_proxy/);
  });

  it('defaults worker WORKER_RUN_INITIAL_CYCLE to false via compose interpolation', () => {
    const c = read(composeRel);
    const workerBlock = c.split(/^\s*worker\s*:/m)[1]?.split(/^\s*web\s*:/m)[0] ?? '';
    expect(workerBlock).toMatch(
      /WORKER_RUN_INITIAL_CYCLE:\s*"?\$\{WORKER_RUN_INITIAL_CYCLE:-false\}"?/,
    );
  });

  it('preserves Traefik network pin, no source bind mounts, and external volumes', () => {
    const c = read(composeRel);
    expect(c).toMatch(/traefik\.docker\.network=traefik_proxy/);
    expect(c).not.toMatch(/^\s*-\s*\.\/src:/m);
    expect(c).not.toMatch(/^\s*-\s*\.\/data:/m);
    expect(c).not.toMatch(/^\s*-\s*\.:/m);
    expect(c).toMatch(/hypedelta_pgdata/);
    expect(c).toMatch(/hypedelta_worker_digests/);
    expect(c).toMatch(/external:\s*true/);
  });

  // 12D-C: production web/worker must not define compose healthcheck overrides.
  // Probes stay on the image contracts (/ready and dist/worker-healthcheck.js).
  it('does not define web/worker healthcheck overrides; image contracts own probes', () => {
    const c = read(composeRel);
    const workerBlock = c.split(/^\s*worker\s*:/m)[1]?.split(/^\s*web\s*:/m)[0] ?? '';
    const webBlock = c.split(/^\s*web\s*:/m)[1]?.split(/^volumes\s*:/m)[0] ?? '';
    expect(workerBlock.length).toBeGreaterThan(20);
    expect(webBlock.length).toBeGreaterThan(20);

    expect(webBlock).not.toMatch(/healthcheck\s*:/i);
    expect(workerBlock).not.toMatch(/healthcheck\s*:/i);
    expect(webBlock).not.toMatch(/\/api\/health\/pipeline/);
    expect(workerBlock).not.toMatch(/\/api\/health\/pipeline/);
  });
});

describe('worker package release contract', () => {
  function rootPackage(): {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } {
    return JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  }

  it('pins esbuild as an exact root devDependency (lockfile-compatible 0.21.5)', () => {
    const pkg = rootPackage();
    const version = pkg.devDependencies?.esbuild;
    expect(version).toBe('0.21.5');
    // Exact pin only — no ^/~ ranges that drift the worker bundle toolchain.
    expect(version).not.toMatch(/^[\^~]/);
  });

  it('defines build:worker that typechecks then esbuilds scheduler → dist/worker.js', () => {
    const pkg = rootPackage();
    const script = pkg.scripts?.['build:worker'];
    expect(script).toBeTruthy();

    // Preserve standalone tsc build for non-worker consumers.
    expect(pkg.scripts?.build).toMatch(/\btsc\b/);

    // Worker path must typecheck/build and emit a Node ESM bundle.
    expect(script).toMatch(/\btsc\b/);
    expect(script).toMatch(/\besbuild\b/);
    expect(script).toMatch(/src\/scheduler\.ts/);
    expect(script).toMatch(/--platform=node\b/);
    expect(script).toMatch(/--format=esm\b/);
    expect(script).toMatch(/--packages=external\b/);
    expect(script).toMatch(/(?:--outfile=| --outfile )dist\/worker\.js\b/);
    // Bundle flag required so internal extensionless imports are rewritten.
    expect(script).toMatch(/--bundle\b/);
  });

  it('build:worker also esbuilds the operational CLI → dist/cli-worker.js', () => {
    const pkg = rootPackage();
    const script = pkg.scripts?.['build:worker'] ?? '';
    expect(script).toBeTruthy();

    // Explicit second entry: CLI bundle for node-runnable status/fetch diagnosis.
    // Raw tsc dist/cli.js keeps extensionless ESM imports and cannot be node'd.
    expect(script).toMatch(/src\/cli\.ts\b/);
    expect(script).toMatch(/(?:--outfile=| --outfile )dist\/cli-worker\.js\b/);

    // Split into esbuild invocations so each entry gets the full Node ESM contract.
    const esbuildInvocations = script
      .split(/&&/)
      .map((s) => s.trim())
      .filter((s) => /\besbuild\b/.test(s));
    expect(esbuildInvocations.length).toBeGreaterThanOrEqual(2);

    const schedulerBuild = esbuildInvocations.find((s) => /src\/scheduler\.ts\b/.test(s));
    const cliBuild = esbuildInvocations.find((s) => /src\/cli\.ts\b/.test(s));
    expect(schedulerBuild).toBeTruthy();
    expect(cliBuild).toBeTruthy();

    for (const inv of [schedulerBuild!, cliBuild!]) {
      expect(inv).toMatch(/--bundle\b/);
      expect(inv).toMatch(/--platform=node\b/);
      expect(inv).toMatch(/--format=esm\b/);
      expect(inv).toMatch(/--packages=external\b/);
    }

    expect(schedulerBuild).toMatch(/(?:--outfile=| --outfile )dist\/worker\.js\b/);
    expect(cliBuild).toMatch(/(?:--outfile=| --outfile )dist\/cli-worker\.js\b/);
  });

  it('build:worker also esbuilds worker-healthcheck → dist/worker-healthcheck.js', () => {
    const pkg = rootPackage();
    const script = pkg.scripts?.['build:worker'] ?? '';
    expect(script).toMatch(/src\/worker-healthcheck\.ts\b/);
    expect(script).toMatch(/(?:--outfile=| --outfile )dist\/worker-healthcheck\.js\b/);

    const esbuildInvocations = script
      .split(/&&/)
      .map((s) => s.trim())
      .filter((s) => /\besbuild\b/.test(s));
    expect(esbuildInvocations.length).toBeGreaterThanOrEqual(3);

    const hcBuild = esbuildInvocations.find((s) => /src\/worker-healthcheck\.ts\b/.test(s));
    expect(hcBuild).toBeTruthy();
    expect(hcBuild).toMatch(/--bundle\b/);
    expect(hcBuild).toMatch(/--platform=node\b/);
    expect(hcBuild).toMatch(/--format=esm\b/);
    expect(hcBuild).toMatch(/--packages=external\b/);
    expect(hcBuild).toMatch(/(?:--outfile=| --outfile )dist\/worker-healthcheck\.js\b/);

    // Preserve scheduler + CLI bundles.
    expect(esbuildInvocations.some((s) => /src\/scheduler\.ts\b/.test(s))).toBe(true);
    expect(esbuildInvocations.some((s) => /src\/cli\.ts\b/.test(s))).toBe(true);
  });
});

describe('web Dockerfile release contract', () => {
  it('declares JSON-form HEALTHCHECK against ready endpoint via node fetch + AbortSignal', () => {
    const df = read('apps/web/Dockerfile');
    expect(df).toMatch(/HEALTHCHECK\b/);
    // Exec form array — no curl install, no shell secret expansion.
    expect(df).toMatch(/HEALTHCHECK\b[\s\S]*?CMD\s*\[/);
    expect(df).not.toMatch(/HEALTHCHECK\b[^\n]*CMD-SHELL/);
    expect(df).not.toMatch(/\bcurl\b/);
    expect(df).toMatch(/127\.0\.0\.1:3000\/api\/health\/ready/);
    expect(df).toMatch(/AbortSignal/);
    expect(df).toMatch(/fetch\s*\(/);
    const hcBlock = df.match(/HEALTHCHECK\b[\s\S]*?(?=\n[A-Z]|\n*$)/)?.[0] ?? '';
    expect(hcBlock).toMatch(/--interval=/);
    expect(hcBlock).toMatch(/--timeout=/);
    expect(hcBlock).toMatch(/--start-period=/);
    expect(hcBlock).toMatch(/--retries=/);
    // Characterization: web image probe stays /ready, never /pipeline (stale data ≠ crash).
    expect(hcBlock).toMatch(/\/api\/health\/ready/);
    expect(hcBlock).not.toMatch(/\/api\/health\/pipeline/);
  });
});

describe('.env.example production keys', () => {
  it('lists secret-free key names needed to render production Compose', () => {
    const env = read('.env.example');

    for (const key of [
      'WEB_IMAGE',
      'WORKER_IMAGE',
      'DATABASE_URL',
      'POSTGRES_PASSWORD',
      'TWITTER_API_KEY',
      'DEEPSEEK_API_KEY',
      'KIMI_CODING_API_KEY',
      'ADMIN_PASSWORD',
      'ADMIN_SESSION_SECRET',
    ]) {
      expect(env).toMatch(new RegExp(`^#?\\s*${key}=`, 'm'));
    }

    // Active worker routing keys only — Claude is legacy/disconnected if documented.
    expect(env).toMatch(/^#?\s*DEEPSEEK_API_KEY=/m);
    expect(env).toMatch(/^#?\s*KIMI_CODING_API_KEY=/m);
    expect(env).not.toMatch(/^\s*CLAUDE_CODE_OAUTH_TOKEN=/m);
    expect(env).not.toMatch(/^\s*ANTHROPIC_API_KEY=/m);
    expect(env).not.toMatch(/^\s*DEEPSEEK_BASE_URL=/m);
    expect(env).not.toMatch(/^\s*KIMI_CODING_BASE_URL=/m);

    // Optional/legacy GLM lane remains documented; wording must not claim production-mandatory.
    expect(env).not.toMatch(/GLM_API_KEY[^\n]*(required|mandatory)/i);
    expect(env).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN[^\n]*(required|mandatory)/i);

    // No token/password-shaped assignments (long hex/base64-ish or sk- keys).
    // Same-line only — do not let \\s match across blank values into the next key.
    expect(env).not.toMatch(/=sk-[A-Za-z0-9]{10,}/);
    expect(env).not.toMatch(/=\s*eyJ[A-Za-z0-9_-]{20,}/);
    expect(env).not.toMatch(/PASSWORD=[^\s#\n]{12,}/);
  });
});

describe('CI workflow release gate contract', () => {
  const wfRel = '.github/workflows/ci.yml';

  it('pins official actions by full commit SHA (no mutable tags)', () => {
    const wf = read(wfRel);

    const pins = [
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'pnpm/action-setup@b0f76dfb45f55f8421693e4803ac7bb65143bd34',
    ];
    for (const pin of pins) {
      expect(wf).toContain(pin);
    }

    // No mutable action tags like @v4 / @main / @master on uses:
    const uses = [...wf.matchAll(/^\s*-\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const u of uses) {
      // require full 40-char sha after @
      expect(u).toMatch(/@[0-9a-f]{40}$/i);
      expect(u).not.toMatch(/@(v\d+|main|master|latest)\b/i);
    }
  });

  it('declares permissions contents:read, concurrency cancel, three parallel jobs', () => {
    const wf = read(wfRel);
    expect(wf).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(wf).toMatch(/concurrency:/);
    expect(wf).toMatch(/cancel-in-progress:\s*true/);

    // Job ids
    expect(wf).toMatch(/^\s*quality\s*:/m);
    expect(wf).toMatch(/^\s*postgres-integration\s*:/m);
    expect(wf).toMatch(/^\s*release-images\s*:/m);

    // Parallel (no needs: between the three)
    const qualityBlock =
      wf.split(/^\s*quality\s*:/m)[1]?.split(/^\s*postgres-integration\s*:/m)[0] ?? '';
    const pgBlock =
      wf.split(/^\s*postgres-integration\s*:/m)[1]?.split(/^\s*release-images\s*:/m)[0] ?? '';
    const relBlock = wf.split(/^\s*release-images\s*:/m)[1] ?? '';
    for (const b of [qualityBlock, pgBlock, relBlock]) {
      expect(b).not.toMatch(/^\s*needs\s*:/m);
    }
  });

  it('quality job runs lint, typecheck, vitest, builds, worker smoke, web build', () => {
    const wf = read(wfRel);
    const qualityBlock =
      wf.split(/^\s*quality\s*:/m)[1]?.split(/^\s*postgres-integration\s*:/m)[0] ?? '';
    expect(qualityBlock.length).toBeGreaterThan(100);
    expect(qualityBlock).toMatch(/pnpm install --frozen-lockfile/);
    expect(qualityBlock).toMatch(/pnpm run lint/);
    expect(qualityBlock).toMatch(/pnpm run typecheck/);
    expect(qualityBlock).toMatch(/pnpm exec vitest run/);
    expect(qualityBlock).toMatch(/pnpm run build\b/);
    expect(qualityBlock).toMatch(/pnpm run build:worker/);
    expect(qualityBlock).toMatch(/node dist\/cli-worker\.js --help/);
    expect(qualityBlock).toMatch(/WORKER_RUN_INITIAL_CYCLE=false/);
    expect(qualityBlock).toMatch(/node dist\/worker\.js/);
    expect(qualityBlock).toMatch(/node dist\/worker-healthcheck\.js/);
    expect(qualityBlock).toMatch(/pnpm --filter @hypedelta\/web build/);
    expect(qualityBlock).toMatch(/timeout-minutes:/);
    expect(qualityBlock).toMatch(/node-version:/);
    // Node 20 is pinned at workflow env and referenced by jobs
    expect(wf).toMatch(/NODE_VERSION:\s*["']?20["']?/);
    expect(qualityBlock).toMatch(/env\.NODE_VERSION|node-version:\s*["']?20["']?/);
  });

  it('postgres-integration uses pgvector service and only the integration test', () => {
    const wf = read(wfRel);
    const pgBlock =
      wf.split(/^\s*postgres-integration\s*:/m)[1]?.split(/^\s*release-images\s*:/m)[0] ?? '';
    expect(pgBlock).toMatch(/image:\s*pgvector\/pgvector:pg16/);
    expect(pgBlock).toMatch(/hypedelta-ci-pg-/);
    expect(pgBlock).toMatch(/POSTGRES_USER:\s*hypedelta_ci/);
    expect(pgBlock).toMatch(/POSTGRES_DB:\s*hypedelta_ci/);
    expect(pgBlock).toMatch(/RUN_POSTGRES_INTEGRATION:\s*["']?1["']?/);
    expect(pgBlock).toMatch(/pnpm install --frozen-lockfile/);
    expect(pgBlock).toMatch(
      /pnpm exec vitest run src\/__tests__\/postgres\.integration\.test\.ts/,
    );
    // The disposable service uses trust auth and carries no password secret.
    expect(pgBlock).not.toMatch(/secrets\./);
    expect(pgBlock).toMatch(/POSTGRES_HOST_AUTH_METHOD:\s*trust/);
    expect(pgBlock).not.toMatch(/POSTGRES_PASSWORD:/);
    expect(pgBlock).toMatch(/postgresql:\/\/hypedelta_ci@/);
    // Host is loopback (mapped service port) or hypedelta-ci-pg-* DNS name
    expect(pgBlock).toMatch(/@(127\.0\.0\.1|localhost|hypedelta-ci-pg-)/);
  });

  it('release-images renders compose, runs verifier, builds images, no push/deploy', () => {
    const wf = read(wfRel);
    const relBlock = wf.split(/^\s*release-images\s*:/m)[1] ?? '';
    expect(relBlock).toMatch(/pnpm install --frozen-lockfile/);
    expect(relBlock).toMatch(
      /docker compose -f deploy\/docker-compose\.production\.yml config --format json/,
    );
    expect(relBlock).toMatch(
      /node scripts\/verify-production-compose\.mjs/,
    );
    expect(relBlock).toMatch(/docker build/);
    expect(relBlock).toMatch(/org\.opencontainers\.image\.revision/);
    expect(relBlock).toMatch(/Config\.Healthcheck/);
    expect(relBlock).toMatch(/WORKER_RUN_INITIAL_CYCLE=false/);
    // No registry push / deploy job steps
    expect(relBlock).not.toMatch(/\bdocker\s+push\b/);
    expect(relBlock).not.toMatch(/\b(helm|kubectl|terraform)\b/i);
    expect(relBlock).not.toMatch(/^\s*deploy\s*:/m);
    expect(relBlock).not.toMatch(/secrets\./);
  });

  it('quality worker artifact smoke is fail-closed against unreachable DB', () => {
    const wf = read(wfRel);
    const qualityBlock =
      wf.split(/^\s*quality\s*:/m)[1]?.split(/^\s*postgres-integration\s*:/m)[0] ?? '';
    const smoke =
      qualityBlock.split(/name:\s*Worker artifact smoke/)[1]?.split(/^\s+- name:/m)[0] ?? '';
    expect(smoke.length).toBeGreaterThan(80);

    expect(smoke).toMatch(/node dist\/cli-worker\.js --help/);
    expect(smoke).toMatch(/WORKER_HEARTBEAT_PATH/);
    expect(smoke).toMatch(/WORKER_RUN_INITIAL_CYCLE=false/);
    expect(smoke).toMatch(/DATABASE_URL=.*127\.0\.0\.1:1/);
    expect(smoke).toMatch(/DEEPSEEK_API_KEY=.*github\.run_id/);
    expect(smoke).toMatch(/KIMI_CODING_API_KEY=.*github\.run_id/);
    expect(smoke).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(smoke).not.toMatch(/secrets\./);

    // Foreground worker against unreachable DB; capture non-zero exit.
    expect(smoke).toMatch(/node dist\/worker\.js/);
    expect(smoke).not.toMatch(/node dist\/worker\.js[^\n]*&\s*$/m);
    expect(smoke).not.toMatch(/\bWPID=/);
    expect(smoke).not.toMatch(/\bseq 1 30\b/);

    expect(smoke).toMatch(
      /node dist\/worker\.js[\s\S]*?test\s+"\$[^"]+"\s+-ne\s+0[\s\S]*?node dist\/worker-healthcheck\.js[\s\S]*?test\s+"\$[^"]+"\s+-ne\s+0/,
    );
    expect(smoke).toMatch(/status\s*!==\s*["']failed["']/);
    expect(smoke).toMatch(/error_class/);
    expect(smoke).toMatch(/error_class[\s\S]{0,120}length\s*<\s*1/);
  });

  it('release-images worker smoke is fail-closed against unreachable DB', () => {
    const wf = read(wfRel);
    const relBlock = wf.split(/^\s*release-images\s*:/m)[1] ?? '';
    const smoke =
      relBlock.split(/name:\s*Worker image heartbeat smoke/)[1]?.split(/^\s+- name:/m)[0] ?? '';
    expect(smoke.length).toBeGreaterThan(80);

    // Reject the stale healthy-background / docker-exec-loop pattern.
    expect(smoke).not.toMatch(/docker run\s+-d\b/);
    expect(smoke).not.toMatch(/\bdocker exec\b/);
    expect(smoke).not.toMatch(/\bseq 1 40\b/);
    expect(smoke).not.toMatch(/test\s+"\$ok"\s+-eq\s+1/);

    expect(smoke).toMatch(/WORKER_RUN_INITIAL_CYCLE=false/);
    expect(smoke).toMatch(/DATABASE_URL=.*127\.0\.0\.1:1/);
    expect(smoke).toMatch(/DEEPSEEK_API_KEY=.*github\.run_id/);
    expect(smoke).toMatch(/KIMI_CODING_API_KEY=.*github\.run_id/);
    expect(smoke).toMatch(/WORKER_HEARTBEAT_PATH/);
    expect(smoke).toMatch(/mktemp\s+-d/);
    expect(smoke).toMatch(/-v\s+"\$HB_DIR:/);
    expect(smoke).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(smoke).not.toMatch(/secrets\./);

    const firstRunIdx = smoke.search(/\bdocker run\b/);
    const entryIdx = smoke.search(/--entrypoint\b/);
    expect(firstRunIdx).toBeGreaterThanOrEqual(0);
    expect(entryIdx).toBeGreaterThan(firstRunIdx);
    const firstRun = smoke.slice(firstRunIdx, entryIdx);
    expect(firstRun).toMatch(/docker run --rm\b/);
    expect(firstRun).not.toMatch(/\s-d\b/);
    expect(firstRun).not.toMatch(/--entrypoint\b/);
    expect(firstRun).toMatch(/WORKER_RUN_INITIAL_CYCLE=false/);
    expect(firstRun).toMatch(/DEEPSEEK_API_KEY/);
    expect(firstRun).toMatch(/KIMI_CODING_API_KEY/);
    expect(firstRun).toMatch(/WORKER_HEARTBEAT_PATH/);
    expect(firstRun).toMatch(/-v\s+"\$HB_DIR:/);

    expect(smoke).toMatch(
      /docker run --rm[\s\S]*?test\s+"\$[^"]+"\s+-ne\s+0[\s\S]*?--entrypoint[\s\S]*?worker-healthcheck\.js[\s\S]*?test\s+"\$[^"]+"\s+-ne\s+0/,
    );
    expect(smoke).toMatch(/status\s*!==\s*["']failed["']/);
    expect(smoke).toMatch(/error_class/);
    expect(smoke).toMatch(/error_class[\s\S]{0,120}length\s*<\s*1/);
  });

  it('workflow never references repository secrets and stays contents:read only', () => {
    const wf = read(wfRel);
    expect(wf).not.toMatch(/secrets\./);
    expect(wf).not.toMatch(/permissions:\s*\n(?:.*\n)*?\s*(write|deploy)/i);
  });
});

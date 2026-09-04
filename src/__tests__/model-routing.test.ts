/**
 * Packet 1: fail-closed per-stage model router.
 * All provider HTTP is injected; never contacts a live model.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const DEEPSEEK_STAGES = ['filter', 'extraction', 'quote_backfill'] as const;
const KIMI_STAGES = ['synthesis', 'hype_assessment', 'digest'] as const;
const ALL_STAGES = [...DEEPSEEK_STAGES, ...KIMI_STAGES] as const;

const DS_KEY = 'ds-test-key';
const KIMI_KEY = 'kimi-test-key';

const REQUIRED_ENV = {
  DEEPSEEK_API_KEY: DS_KEY,
  KIMI_CODING_API_KEY: KIMI_KEY,
};

class RecordingStore {
  receipts: Array<Record<string, unknown>> = [];
  failNext = false;

  async record(receipt: Record<string, unknown>): Promise<number> {
    if (this.failNext) {
      throw new Error('ledger write failed');
    }
    this.receipts.push(receipt);
    return this.receipts.length;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatPayload(model: string, content: string, usage?: Record<string, number>) {
  return {
    model,
    choices: [{ message: { role: 'assistant', content } }],
    ...(usage ? { usage } : {}),
  };
}

function requestCall(fetchMock: { mock: { calls: unknown[][] } }): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0];
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

async function loadRouter() {
  return import('../model-routing');
}

function makeRouter(
  mod: Awaited<ReturnType<typeof loadRouter>>,
  opts: {
    fetch: typeof fetch;
    store?: RecordingStore;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    maxResponseBytes?: number;
    now?: () => Date;
  },
) {
  const store = opts.store ?? new RecordingStore();
  const router = new mod.StageModelRouter({
    env: { ...REQUIRED_ENV, ...opts.env },
    store,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs ?? 50,
    maxResponseBytes: opts.maxResponseBytes ?? 2048,
    now: opts.now,
  });
  return { router, store };
}

describe('stage lane pins', () => {
  it('pins DeepSeek flash and Kimi k3 lanes immutably', async () => {
    const { STAGE_LANES, STAGES } = await loadRouter();
    expect([...STAGES]).toEqual([...ALL_STAGES]);
    expect(Object.isFrozen(STAGE_LANES)).toBe(true);
    expect(Object.isFrozen(STAGES)).toBe(true);

    for (const stage of DEEPSEEK_STAGES) {
      expect(Object.isFrozen(STAGE_LANES[stage])).toBe(true);
      expect(STAGE_LANES[stage]).toEqual({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        credentialClass: 'deepseek_api_key',
        json: true,
      });
    }

    expect(STAGE_LANES.synthesis).toMatchObject({
      provider: 'kimi-coding',
      model: 'kimi-k3',
      credentialClass: 'kimi_code_subscription',
      json: true,
    });
    expect(STAGE_LANES.hype_assessment).toMatchObject({
      provider: 'kimi-coding',
      model: 'kimi-k3',
      credentialClass: 'kimi_code_subscription',
      json: true,
    });
    expect(STAGE_LANES.digest).toEqual({
      provider: 'kimi-coding',
      model: 'kimi-k3',
      credentialClass: 'kimi_code_subscription',
      json: false,
    });

    expect(() => {
      (STAGE_LANES as { filter: { model: string } }).filter.model = 'other';
    }).toThrow();
    expect(STAGE_LANES.filter.model).toBe('deepseek-v4-flash');
  });
});

describe('loadModelRoutingConfig', () => {
  it('requires only DEEPSEEK_API_KEY and KIMI_CODING_API_KEY from the given env object', async () => {
    const { loadModelRoutingConfig, DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_KIMI_CODING_BASE_URL } =
      await loadRouter();

    expect(() => loadModelRoutingConfig({})).toThrow(/DEEPSEEK_API_KEY/i);
    expect(() => loadModelRoutingConfig({ DEEPSEEK_API_KEY: DS_KEY })).toThrow(/KIMI_CODING_API_KEY/i);
    expect(() => loadModelRoutingConfig({ KIMI_CODING_API_KEY: KIMI_KEY })).toThrow(/DEEPSEEK_API_KEY/i);
    expect(() => loadModelRoutingConfig({ DEEPSEEK_API_KEY: '  ', KIMI_CODING_API_KEY: KIMI_KEY })).toThrow(
      /DEEPSEEK_API_KEY/i,
    );

    const cfg = loadModelRoutingConfig({
      ...REQUIRED_ENV,
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
      GLM_API_KEY: 'glm-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
    });
    expect(cfg.deepseekBaseUrl).toBe(DEFAULT_DEEPSEEK_BASE_URL);
    expect(cfg.kimiCodingBaseUrl).toBe(DEFAULT_KIMI_CODING_BASE_URL);
    expect(DEFAULT_DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com');
    expect(DEFAULT_KIMI_CODING_BASE_URL).toBe('https://api.kimi.com/coding/v1');

    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toMatch(/ds-test-key/);
    expect(serialized).not.toMatch(/kimi-test-key/);
    expect(serialized).not.toMatch(/claude-token/);
    expect(serialized).not.toMatch(/glm-key/);
    expect(serialized).not.toMatch(/anthropic-key/);
    expect(cfg).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(cfg).not.toHaveProperty('KIMI_CODING_API_KEY');
  });

  it('does not read process.env and ignores env base URL overrides', async () => {
    const { loadModelRoutingConfig, DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_KIMI_CODING_BASE_URL } =
      await loadRouter();
    const previousDs = process.env.DEEPSEEK_API_KEY;
    const previousKimi = process.env.KIMI_CODING_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'from-process-ds';
    process.env.KIMI_CODING_API_KEY = 'from-process-kimi';
    try {
      expect(() => loadModelRoutingConfig({})).toThrow(/DEEPSEEK_API_KEY/i);
      const cfg = loadModelRoutingConfig({
        ...REQUIRED_ENV,
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:4150',
        KIMI_CODING_BASE_URL: 'http://127.0.0.1:4151/coding/v1',
      });
      expect(cfg.deepseekBaseUrl).toBe(DEFAULT_DEEPSEEK_BASE_URL);
      expect(cfg.kimiCodingBaseUrl).toBe(DEFAULT_KIMI_CODING_BASE_URL);
      expect(JSON.stringify(cfg)).not.toMatch(/127\.0\.0\.1/);
      expect(JSON.stringify(cfg)).not.toMatch(/from-process/);
    } finally {
      process.env.DEEPSEEK_API_KEY = previousDs;
      process.env.KIMI_CODING_API_KEY = previousKimi;
    }
  });
});

describe('hashPromptTemplate', () => {
  it('hashes template id and version, not rendered source', async () => {
    const { hashPromptTemplate } = await loadRouter();
    const hash = hashPromptTemplate('filter', '1');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashPromptTemplate('filter', '1'));
    expect(hash).not.toBe(hashPromptTemplate('filter', '2'));
    expect(hash).not.toBe(hashPromptTemplate('extraction', '1'));
    expect(hash).not.toBe(
      createHash('sha256').update('rendered prompt with source text').digest('hex'),
    );
  });
});

describe('StageModelRouter request contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends filter to DeepSeek /chat/completions with json_object and the pinned model', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        chatPayload('deepseek-v4-flash', '{"relevant":true}', {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
      ),
    );
    const { router, store } = makeRouter(mod, { fetch: fetchMock });

    const result = await router.complete('filter', {
      messages: [{ role: 'user', content: 'classify this' }],
      promptTemplateId: 'filter',
      promptVersion: '1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = requestCall(fetchMock);
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toMatch(/application\/json/i);
    expect(headers.get('authorization')).toBe(`Bearer ${DS_KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.messages).toEqual([{ role: 'user', content: 'classify this' }]);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(result.content).toBe('{"relevant":true}');
    expect(JSON.stringify(result)).not.toMatch(/ds-test-key/);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({
      stage: 'filter',
      requestedProvider: 'deepseek',
      requestedModel: 'deepseek-v4-flash',
      effectiveProvider: 'deepseek',
      effectiveModel: 'deepseek-v4-flash',
      credentialClass: 'deepseek_api_key',
      promptVersion: '1',
      promptHash: mod.hashPromptTemplate('filter', '1'),
      ok: true,
      errorClass: null,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/classify this/);
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/ds-test-key/);
  });

  it('sends synthesis to Kimi coding /chat/completions as kimi-k3 with json_object and no temperature', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () => jsonResponse(chatPayload('kimi-k3', '{"delta":1}')));
    const { router } = makeRouter(mod, { fetch: fetchMock });

    await router.complete('synthesis', {
      messages: [{ role: 'user', content: 'synthesize' }],
      promptTemplateId: 'synthesis',
      promptVersion: '2',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = requestCall(fetchMock);
    expect(url).toBe('https://api.kimi.com/coding/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('kimi-k3');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KIMI_KEY}`);
  });

  it('omits temperature and response_format for digest markdown', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () => jsonResponse(chatPayload('kimi-k3', '# Weekly digest\n\nHello')));
    const { router, store } = makeRouter(mod, { fetch: fetchMock });

    const result = await router.complete('digest', {
      messages: [{ role: 'user', content: 'write digest' }],
      promptTemplateId: 'digest',
      promptVersion: '1',
    });

    const body = JSON.parse(String(requestCall(fetchMock).init.body));
    expect(body.model).toBe('kimi-k3');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('response_format');
    expect(result.content).toBe('# Weekly digest\n\nHello');
    expect(store.receipts[0]).toMatchObject({
      stage: 'digest',
      requestedProvider: 'kimi-coding',
      credentialClass: 'kimi_code_subscription',
      ok: true,
    });
  });

  it('never sends credentials to env-supplied base URLs', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () => jsonResponse(chatPayload('deepseek-v4-flash', '{}')));
    const { router } = makeRouter(mod, {
      fetch: fetchMock,
      env: {
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:4150/',
        KIMI_CODING_BASE_URL: 'http://127.0.0.1:4151/coding/v1',
      },
    });

    await router.complete('extraction', {
      messages: [{ role: 'user', content: '{}' }],
      promptTemplateId: 'extraction',
      promptVersion: '1',
    });

    const { url, init } = requestCall(fetchMock);
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(url).not.toMatch(/127\.0\.0\.1/);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${DS_KEY}`);
  });
});

describe('StageModelRouter fail-closed behavior', () => {
  it('rejects effective-model mismatch, persists one failed receipt with echoed model, and does not retry', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () => jsonResponse(chatPayload('kimi-k2', '{}')));
    const { router, store } = makeRouter(mod, { fetch: fetchMock });

    await expect(
      router.complete('synthesis', {
        messages: [{ role: 'user', content: 'x' }],
        promptTemplateId: 'synthesis',
        promptVersion: '1',
      }),
    ).rejects.toMatchObject({ errorClass: 'model_mismatch' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({
      ok: false,
      errorClass: 'model_mismatch',
      requestedModel: 'kimi-k3',
      effectiveModel: 'kimi-k2',
      effectiveProvider: 'kimi-coding',
    });
  });

  it('makes exactly one attempt on HTTP 5xx with no provider fallback', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'upstream exploded token=sekrit' }, 503),
    );
    const { router, store } = makeRouter(mod, { fetch: fetchMock });

    const thrown = await router
      .complete('filter', {
        messages: [{ role: 'user', content: 'source text that must not leak' }],
        promptTemplateId: 'filter',
        promptVersion: '1',
      })
      .catch((err: unknown) => err as Error & { errorClass?: string });

    expect(thrown).toMatchObject({ errorClass: 'http_5xx' });
    expect(String(thrown)).not.toMatch(/sekrit/);
    expect(String(thrown)).not.toMatch(/source text that must not leak/);
    expect(JSON.stringify(thrown)).not.toMatch(/ds-test-key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls).toEqual(['https://api.deepseek.com/chat/completions']);
    expect(urls.some((url) => url.includes('kimi.com'))).toBe(false);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({
      ok: false,
      errorClass: 'http_5xx',
      stage: 'filter',
    });
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/sekrit/);
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/source text/);
  });

  it('makes exactly one attempt on timeout', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        if (signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const { router, store } = makeRouter(mod, { fetch: fetchMock as unknown as typeof fetch, timeoutMs: 20 });

    await expect(
      router.complete('quote_backfill', {
        messages: [{ role: 'user', content: 'quote' }],
        promptTemplateId: 'quote_backfill',
        promptVersion: '1',
      }),
    ).rejects.toMatchObject({ errorClass: 'timeout' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({
      ok: false,
      errorClass: 'timeout',
      effectiveProvider: null,
      effectiveModel: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  it('normalizes unclassified post-fetch body-read failures to one sanitized receipt', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('failed to read body token=sekrit'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const { router, store } = makeRouter(mod, { fetch: fetchMock });

    const thrown = await router
      .complete('extraction', {
        messages: [{ role: 'user', content: 'source text that must not leak' }],
        promptTemplateId: 'extraction',
        promptVersion: '1',
      })
      .then(
        () => {
          throw new Error('expected ModelRoutingError');
        },
        (err: unknown) => err as Error & { errorClass?: string },
      );

    expect(thrown).toBeInstanceOf(mod.ModelRoutingError);
    expect(['provider', 'internal']).toContain(thrown.errorClass);
    expect(String(thrown)).not.toMatch(/sekrit/);
    expect(String(thrown)).not.toMatch(/failed to read body/);
    expect(String(thrown)).not.toMatch(/source text that must not leak/);
    expect(JSON.stringify(thrown)).not.toMatch(/ds-test-key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({
      ok: false,
      errorClass: thrown.errorClass,
      stage: 'extraction',
      requestedProvider: 'deepseek',
      requestedModel: 'deepseek-v4-flash',
      effectiveProvider: null,
      effectiveModel: null,
    });
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/sekrit/);
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/failed to read body/);
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/source text/);
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/ds-test-key/);
  });

  it('rejects non-JSON HTTP bodies and oversize responses as parse failures', async () => {
    const mod = await loadRouter();
    const nonJsonFetch = vi.fn(async () => new Response('not-json <html>', { status: 200 }));
    const { router: nonJsonRouter, store: nonJsonStore } = makeRouter(mod, { fetch: nonJsonFetch });

    await expect(
      nonJsonRouter.complete('filter', {
        messages: [{ role: 'user', content: 'x' }],
        promptTemplateId: 'filter',
        promptVersion: '1',
      }),
    ).rejects.toMatchObject({ errorClass: 'parse' });
    expect(nonJsonFetch).toHaveBeenCalledTimes(1);
    expect(nonJsonStore.receipts).toHaveLength(1);
    expect(JSON.stringify(nonJsonStore.receipts[0])).not.toMatch(/not-json/);

    const hugeFetch = vi.fn(
      async () =>
        new Response('{"model":"deepseek-v4-flash","choices":[{"message":{"content":"{}"}}]}' + 'x'.repeat(3000), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { router: hugeRouter, store: hugeStore } = makeRouter(mod, {
      fetch: hugeFetch,
      maxResponseBytes: 64,
    });
    await expect(
      hugeRouter.complete('filter', {
        messages: [{ role: 'user', content: 'x' }],
        promptTemplateId: 'filter',
        promptVersion: '1',
      }),
    ).rejects.toMatchObject({ errorClass: 'parse' });
    expect(hugeFetch).toHaveBeenCalledTimes(1);
    expect(hugeStore.receipts).toHaveLength(1);
  });

  it('rejects non-object content when json_object was requested', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () => jsonResponse(chatPayload('deepseek-v4-flash', 'not an object')));
    const { router, store } = makeRouter(mod, { fetch: fetchMock });

    await expect(
      router.complete('filter', {
        messages: [{ role: 'user', content: 'x' }],
        promptTemplateId: 'filter',
        promptVersion: '1',
      }),
    ).rejects.toMatchObject({ errorClass: 'parse' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.receipts[0].ok).toBe(false);
    expect(JSON.stringify(store.receipts[0])).not.toMatch(/not an object/);
  });

  it('fails the model call when the sanitized receipt cannot be persisted', async () => {
    const mod = await loadRouter();
    const fetchMock = vi.fn(async () => jsonResponse(chatPayload('deepseek-v4-flash', '{}')));
    const store = new RecordingStore();
    store.failNext = true;
    const { router } = makeRouter(mod, { fetch: fetchMock, store });

    await expect(
      router.complete('filter', {
        messages: [{ role: 'user', content: 'x' }],
        promptTemplateId: 'filter',
        promptVersion: '1',
      }),
    ).rejects.toThrow(/ledger write failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not log keys, rendered prompts, source text, or raw provider bodies', async () => {
    const mod = await loadRouter();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'provider-raw-body token=sekrit' }, 500),
    );
    const { router } = makeRouter(mod, { fetch: fetchMock });

    await router
      .complete('filter', {
        messages: [{ role: 'user', content: 'secret-source-text' }],
        promptTemplateId: 'filter',
        promptVersion: '1',
      })
      .catch(() => undefined);

    const dumped = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls, ...info.mock.calls]
      .flat()
      .map((value) => String(value))
      .join('\n');
    expect(dumped).not.toMatch(/ds-test-key/);
    expect(dumped).not.toMatch(/kimi-test-key/);
    expect(dumped).not.toMatch(/secret-source-text/);
    expect(dumped).not.toMatch(/provider-raw-body/);
    expect(dumped).not.toMatch(/token=sekrit/);
  });
});

const STAGE_TIMEOUT_DEFAULTS = [
  ['filter', 30_000],
  ['extraction', 90_000],
  ['quote_backfill', 90_000],
  ['synthesis', 120_000],
  ['hype_assessment', 120_000],
  ['digest', 120_000],
] as const;

function hangingFetch() {
  return vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      if (signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

describe('per-stage timeout policy', () => {
  it('owns bounded per-stage defaults in code, covering every stage', async () => {
    const { STAGE_TIMEOUT_MS, STAGES, resolveStageTimeoutMs } = await loadRouter();
    expect(Object.isFrozen(STAGE_TIMEOUT_MS)).toBe(true);
    expect(Object.keys(STAGE_TIMEOUT_MS).sort()).toEqual([...STAGES].sort());
    for (const [stage, expected] of STAGE_TIMEOUT_DEFAULTS) {
      expect(STAGE_TIMEOUT_MS[stage]).toBe(expected);
      expect(resolveStageTimeoutMs(stage)).toBe(expected);
    }
    const values = Object.values(STAGE_TIMEOUT_MS);
    expect(values.every((ms) => Number.isInteger(ms) && Number.isFinite(ms))).toBe(true);
    expect(Math.min(...values)).toBe(30_000);
    expect(Math.max(...values)).toBe(120_000);
  });

  it('lets a constructor timeoutMs override every stage default', async () => {
    const { resolveStageTimeoutMs } = await loadRouter();
    for (const [stage] of STAGE_TIMEOUT_DEFAULTS) {
      expect(resolveStageTimeoutMs(stage, 15)).toBe(15);
    }
  });

  it('does not read timeout knobs from env', async () => {
    const { resolveStageTimeoutMs } = await loadRouter();
    const previous = process.env.MODEL_TIMEOUT_MS;
    process.env.MODEL_TIMEOUT_MS = '1';
    process.env.STAGE_TIMEOUT_MS = '1';
    process.env.FILTER_TIMEOUT_MS = '1';
    try {
      expect(resolveStageTimeoutMs('filter')).toBe(30_000);
      expect(resolveStageTimeoutMs('extraction')).toBe(90_000);
      expect(resolveStageTimeoutMs('synthesis')).toBe(120_000);
    } finally {
      process.env.MODEL_TIMEOUT_MS = previous;
      delete process.env.STAGE_TIMEOUT_MS;
      delete process.env.FILTER_TIMEOUT_MS;
    }
  });
});

describe('StageModelRouter per-stage abort budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(STAGE_TIMEOUT_DEFAULTS)(
    'aborts %s at the code-owned %ims default when timeoutMs is omitted',
    async (stage, expectedMs) => {
      vi.useFakeTimers();
      const mod = await loadRouter();
      const fetchMock = hangingFetch();
      const store = new RecordingStore();
      const router = new mod.StageModelRouter({
        env: REQUIRED_ENV,
        store,
        fetch: fetchMock as unknown as typeof fetch,
      });

      const promise = router.complete(stage, {
        messages: [{ role: 'user', content: 'x' }],
        promptTemplateId: stage,
        promptVersion: '1',
      });
      const rejected = expect(promise).rejects.toMatchObject({ errorClass: 'timeout' });

      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(store.receipts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.receipts).toHaveLength(1);
      expect(store.receipts[0]).toMatchObject({
        ok: false,
        errorClass: 'timeout',
        stage,
        effectiveProvider: null,
        effectiveModel: null,
      });
    },
  );

  it('applies constructor timeoutMs instead of the stage default', async () => {
    vi.useFakeTimers();
    const mod = await loadRouter();
    const fetchMock = hangingFetch();
    const store = new RecordingStore();
    const router = new mod.StageModelRouter({
      env: REQUIRED_ENV,
      store,
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 15,
    });

    const promise = router.complete('synthesis', {
      messages: [{ role: 'user', content: 'x' }],
      promptTemplateId: 'synthesis',
      promptVersion: '1',
    });
    const rejected = expect(promise).rejects.toMatchObject({ errorClass: 'timeout' });

    await vi.advanceTimersByTimeAsync(14);
    expect(store.receipts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.receipts).toHaveLength(1);
  });

  it('ignores env timeout knobs on the production constructor path', async () => {
    vi.useFakeTimers();
    const mod = await loadRouter();
    const fetchMock = hangingFetch();
    const store = new RecordingStore();
    const router = new mod.StageModelRouter({
      env: {
        ...REQUIRED_ENV,
        MODEL_TIMEOUT_MS: '1',
        STAGE_TIMEOUT_MS: '1',
        TIMEOUT_MS: '1',
      },
      store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const promise = router.complete('extraction', {
      messages: [{ role: 'user', content: 'x' }],
      promptTemplateId: 'extraction',
      promptVersion: '1',
    });
    const rejected = expect(promise).rejects.toMatchObject({ errorClass: 'timeout' });

    await vi.advanceTimersByTimeAsync(89_999);
    expect(store.receipts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

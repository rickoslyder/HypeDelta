/**
 * Fail-closed per-stage model router.
 * Exact lane pins, one raw fetch attempt, no retry/fallback.
 * Never log or return keys, rendered prompts, source text, or raw bodies.
 */
import { createHash } from 'node:crypto';
import type { ModelAttemptReceipt, ModelErrorClass } from './model-attempt-ledger';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding/v1';

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export const STAGES = Object.freeze([
  'filter',
  'extraction',
  'quote_backfill',
  'synthesis',
  'hype_assessment',
  'digest',
] as const);

export type Stage = (typeof STAGES)[number];

export interface StageLane {
  readonly provider: 'deepseek' | 'kimi-coding';
  readonly model: string;
  readonly credentialClass: 'deepseek_api_key' | 'kimi_code_subscription';
  readonly json: boolean;
}

const DEEPSEEK_JSON_LANE: StageLane = Object.freeze({
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  credentialClass: 'deepseek_api_key',
  json: true,
});

const KIMI_JSON_LANE: StageLane = Object.freeze({
  provider: 'kimi-coding',
  model: 'kimi-k3',
  credentialClass: 'kimi_code_subscription',
  json: true,
});

const KIMI_TEXT_LANE: StageLane = Object.freeze({
  provider: 'kimi-coding',
  model: 'kimi-k3',
  credentialClass: 'kimi_code_subscription',
  json: false,
});

export const STAGE_LANES: Readonly<Record<Stage, StageLane>> = Object.freeze({
  filter: DEEPSEEK_JSON_LANE,
  extraction: DEEPSEEK_JSON_LANE,
  quote_backfill: DEEPSEEK_JSON_LANE,
  synthesis: KIMI_JSON_LANE,
  hype_assessment: KIMI_JSON_LANE,
  digest: KIMI_TEXT_LANE,
});

/**
 * Code-owned abort budgets. No env override.
 * Filter stays short (high-volume classify). Extraction/quote_backfill allow
 * longer JSON generation. Kimi synthesis/hype/digest need the longest bounded
 * window. Cap is 120s so a hung provider occupies one attempt, not an unbounded
 * worker slot (one attempt, no retry/fallback).
 */
export const STAGE_TIMEOUT_MS: Readonly<Record<Stage, number>> = Object.freeze({
  filter: 30_000,
  extraction: 90_000,
  quote_backfill: 90_000,
  synthesis: 120_000,
  hype_assessment: 120_000,
  digest: 120_000,
});

export function resolveStageTimeoutMs(stage: Stage, overrideMs?: number): number {
  return overrideMs ?? STAGE_TIMEOUT_MS[stage];
}

export interface ModelRoutingConfig {
  deepseekBaseUrl: string;
  kimiCodingBaseUrl: string;
}

const configSecrets = new WeakMap<
  ModelRoutingConfig,
  { deepseekApiKey: string; kimiCodingApiKey: string }
>();

export interface ChatMessage {
  role: string;
  content: string;
}

export interface CompleteRequest {
  messages: ChatMessage[];
  promptTemplateId: string;
  promptVersion: string;
}

export interface CompleteResult {
  content: string;
}

export class ModelRoutingError extends Error {
  readonly errorClass: ModelErrorClass;

  constructor(errorClass: ModelErrorClass) {
    super(errorClass);
    this.name = 'ModelRoutingError';
    this.errorClass = errorClass;
  }
}

export interface StageModelRouterOptions {
  env: Record<string, string | undefined>;
  store: {
    record(receipt: ModelAttemptReceipt): Promise<number>;
  };
  fetch?: typeof fetch;
  /** Test/operator abort override for every stage. Production omits this. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

function requireKey(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadModelRoutingConfig(
  env: Record<string, string | undefined>,
): ModelRoutingConfig {
  const deepseekApiKey = requireKey(env, 'DEEPSEEK_API_KEY');
  const kimiCodingApiKey = requireKey(env, 'KIMI_CODING_API_KEY');
  const cfg: ModelRoutingConfig = {
    deepseekBaseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    kimiCodingBaseUrl: DEFAULT_KIMI_CODING_BASE_URL,
  };
  configSecrets.set(cfg, { deepseekApiKey, kimiCodingApiKey });
  return cfg;
}

export function hashPromptTemplate(templateId: string, version: string): string {
  return createHash('sha256').update(`${templateId}\n${version}`).digest('hex');
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function isJsonObjectText(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function classifyHttpStatus(status: number): ModelErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'unknown';
}

function classifyFetchFailure(err: unknown): ModelErrorClass {
  const shape = err as { name?: string; code?: string; cause?: { code?: string } };
  const name = shape?.name;
  const code = shape?.code ?? shape?.cause?.code;
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'ENETUNREACH') {
    return 'dns';
  }
  return 'provider';
}

function readUsage(payload: Record<string, unknown>): {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
} {
  const usage = payload.usage;
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  const u = usage as Record<string, unknown>;
  const asInt = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
  return {
    promptTokens: asInt(u.prompt_tokens),
    completionTokens: asInt(u.completion_tokens),
    totalTokens: asInt(u.total_tokens),
  };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ oversize: boolean; text: string }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) return { oversize: true, text: '' };
    return { oversize: false, text: new TextDecoder().decode(buf) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { oversize: true, text: '' };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { oversize: false, text: new TextDecoder().decode(buf) };
}

export class StageModelRouter {
  private readonly config: ModelRoutingConfig;
  private readonly store: { record(receipt: ModelAttemptReceipt): Promise<number> };
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutOverrideMs: number | undefined;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;

  constructor(opts: StageModelRouterOptions) {
    this.config = loadModelRoutingConfig(opts.env);
    this.store = opts.store;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutOverrideMs = opts.timeoutMs;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  async complete(stage: Stage, request: CompleteRequest): Promise<CompleteResult> {
    const lane = STAGE_LANES[stage];
    if (!lane) {
      throw new ModelRoutingError('internal');
    }
    const secrets = configSecrets.get(this.config);
    if (!secrets) {
      throw new ModelRoutingError('internal');
    }
    const apiKey =
      lane.provider === 'deepseek' ? secrets.deepseekApiKey : secrets.kimiCodingApiKey;
    const baseUrl =
      lane.provider === 'deepseek' ? this.config.deepseekBaseUrl : this.config.kimiCodingBaseUrl;
    const url = chatCompletionsUrl(baseUrl);
    const body: Record<string, unknown> = {
      model: lane.model,
      messages: request.messages,
    };
    if (lane.json) {
      body.response_format = { type: 'json_object' };
    }

    const startedAt = this.now();
    const controller = new AbortController();
    const timeoutMs = resolveStageTimeoutMs(stage, this.timeoutOverrideMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let errorClass: ModelErrorClass | null = null;
    let effectiveProvider: string | null = null;
    let effectiveModel: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let totalTokens: number | null = null;
    let content: string | null = null;

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        errorClass = classifyFetchFailure(err);
        throw new ModelRoutingError(errorClass);
      }

      const bounded = await readBoundedBody(response, this.maxResponseBytes);
      if (response.status >= 400) {
        errorClass = classifyHttpStatus(response.status);
        throw new ModelRoutingError(errorClass);
      }
      if (bounded.oversize) {
        errorClass = 'parse';
        throw new ModelRoutingError(errorClass);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bounded.text) as unknown;
      } catch {
        errorClass = 'parse';
        throw new ModelRoutingError(errorClass);
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        errorClass = 'parse';
        throw new ModelRoutingError(errorClass);
      }
      const obj = payload as Record<string, unknown>;
      const echoedModel = obj.model;
      const choices = obj.choices;
      const message =
        Array.isArray(choices) && choices[0] != null && typeof choices[0] === 'object'
          ? (choices[0] as Record<string, unknown>).message
          : undefined;
      const rawContent =
        message != null && typeof message === 'object'
          ? (message as Record<string, unknown>).content
          : undefined;

      if (typeof echoedModel === 'string') {
        effectiveProvider = lane.provider;
        effectiveModel = echoedModel;
      }
      const usage = readUsage(obj);
      promptTokens = usage.promptTokens;
      completionTokens = usage.completionTokens;
      totalTokens = usage.totalTokens;

      if (typeof echoedModel !== 'string' || typeof rawContent !== 'string') {
        errorClass = 'parse';
        throw new ModelRoutingError(errorClass);
      }
      if (echoedModel !== lane.model) {
        errorClass = 'model_mismatch';
        throw new ModelRoutingError(errorClass);
      }
      if (lane.json && !isJsonObjectText(rawContent)) {
        errorClass = 'parse';
        throw new ModelRoutingError(errorClass);
      }
      content = rawContent;
    } catch (err) {
      if (err instanceof ModelRoutingError) {
        errorClass = err.errorClass;
        throw err;
      }
      errorClass = classifyFetchFailure(err);
      throw new ModelRoutingError(errorClass);
    } finally {
      clearTimeout(timer);
      if (content == null && errorClass == null) {
        errorClass = 'internal';
      }
      const finishedAt = this.now();
      const receipt: ModelAttemptReceipt = {
        stage,
        requestedProvider: lane.provider,
        requestedModel: lane.model,
        effectiveProvider,
        effectiveModel,
        credentialClass: lane.credentialClass,
        promptVersion: request.promptVersion,
        promptHash: hashPromptTemplate(request.promptTemplateId, request.promptVersion),
        startedAt,
        finishedAt,
        latencyMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        ok: errorClass == null && content != null,
        errorClass,
        promptTokens,
        completionTokens,
        totalTokens,
      };
      await this.store.record(receipt);
    }

    if (content == null) {
      throw new ModelRoutingError('internal');
    }
    return { content };
  }
}

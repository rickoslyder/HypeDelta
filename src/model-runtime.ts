/**
 * Production composition root for per-stage model routing.
 * Constructs exactly one PostgresModelAttemptStore + StageModelRouter from an
 * explicit env object and a provider-neutral PipelineModelAgent.
 */
import { PostgresModelAttemptStore } from './model-attempt-ledger';
import { StageModelRouter } from './model-routing';
import { PipelineModelAgent } from './pipeline-model-agent';

export function productionModelEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    KIMI_CODING_API_KEY: env.KIMI_CODING_API_KEY,
  };
}

export function createProductionModelRuntime(opts: {
  env: Record<string, string | undefined>;
  dbUrl: string;
}): {
  store: PostgresModelAttemptStore;
  router: StageModelRouter;
  agent: PipelineModelAgent;
} {
  const env = productionModelEnv(opts.env);
  const store = new PostgresModelAttemptStore(opts.dbUrl);
  const router = new StageModelRouter({ env, store });
  const agent = new PipelineModelAgent({ router });
  return { store, router, agent };
}

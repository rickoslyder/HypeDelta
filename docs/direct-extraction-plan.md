# Direct (non-agentic) filter/extract — plan & spike

## Motivation

The pipeline's high-volume **filter** and **extract** stages currently run through
the Claude Agent SDK `query()` harness (`AIIntelAgent.runQuery`): each batch spins
up a full agent session (loads `.claude/skills`, registers subagents, enables
`Skill`/`Task`/`Bash`, runs a multi-turn loop), then the free-form text reply is
scraped for JSON via regex (`parseJsonFromOutput`, with a `{ raw }` fallback).

For "classify N items, return JSON" that harness is heavyweight, non-deterministic,
and can silently degrade. Synthesis/digest legitimately need the agentic harness;
filter/extract do not.

## Goal

Offer a **direct** strategy for filter (and later extract): call a model API
directly with a forced JSON response and validate it against a zod schema — no
harness, no regex scraping. Cheaper, faster, deterministic.

## What shipped in this spike (filter only, flag-gated, default off)

- `src/schemas.ts` — zod `FilterAssessmentSchema` / `FilterResponseSchema`.
- `OrchestratorConfig.filterStrategy: 'agent' | 'direct'` (default `'agent'`).
  Wired from `FILTER_STRATEGY` env in `cli.ts` and `scheduler.ts`.
- `AIIntelOrchestrator.filterDirect()` — batches of 20, `GLMClient.complete`
  with `response_format: json_object`, zod-validated, reuses `applyFilterResults`.
  **Conservative on failure**: an unparseable batch is passed through, not dropped.
- Tests in `src/__tests__/direct-filter.test.ts` (GLM mocked via stubbed fetch):
  valid assessments, sub-threshold drop, and invalid-JSON passthrough.

Default behavior is unchanged (`filterStrategy` defaults to `'agent'`).

## How to try it

```bash
FILTER_STRATEGY=direct GLM_API_KEY=... pnpm run process
```

## How to validate before making it the default (needs real APIs)

This is the part that can't be done in CI/sandbox and gates promotion. An A/B
harness is provided — `scripts/ab-filter.ts` — that runs **both** filter paths on
the **same** items and reports agreement, drop-rate, latency and the
disagreements to spot-check:

```bash
# Against the bundled sample (data/ab-sample.json)
CLAUDE_CODE_OAUTH_TOKEN=... GLM_API_KEY=... pnpm run ab:filter

# Against your own exported content
pnpm run ab:filter -- --fixture path/to/items.json

# Against the database directly
DATABASE_URL=... pnpm run ab:filter -- --db --days 7 --limit 200
```

It captures assessments index-aligned (before the relevance drop) so the two
strategies compare fairly, and skips a side gracefully if its credentials are
missing. Then:

1. Run it over a representative sample (a few hundred items across sources/authors).
2. Read the agreement metrics: relevance mean |Δ|, topic / authorCategory /
   contentType agreement, and the per-strategy drop-rate.
3. Hand-check the printed disagreements.
4. Measure cost and wall-clock (the harness reports latency + a speedup ratio).
5. Promote `direct` to default only if quality is comparable at materially lower
   cost/latency. Keep the flag for rollback.

## Extending to extraction (next step, not in this spike)

- Add `ExtractedClaimSchema` (+ `ClaimsResponseSchema`) to `src/schemas.ts`.
- Add `extractStrategy: 'agent' | 'direct'` and an `extractDirect()` that calls
  **Claude** (extraction needs nuance) with tool-use / forced-schema output,
  validated with zod, replacing `parseJsonFromOutput` for that path.
- Validate with the same A/B methodology, focusing on recall (are real claims
  still captured?) and attribution correctness.

## Out of scope / keep agentic

Synthesis, hype-assessment, and digest stay on the Agent SDK — multi-step
reasoning and the skills/voice are where the harness earns its cost.

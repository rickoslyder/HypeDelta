# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AI research intelligence aggregation and synthesis system. Monitors AI lab researchers and critics, extracts claims/predictions, synthesizes views to identify hype vs reality.

## Commands

### Development
```bash
npm run build          # Compile TypeScript to dist/
npm run typecheck      # Type check without emitting
npm run lint           # ESLint on src/
npm run test           # Run vitest tests
npx vitest <file>      # Run single test file
npm run dev            # Watch mode for CLI development
```

### Operations
```bash
npm run init-db        # Initialize PostgreSQL schema
npm run seed           # Seed source data
npm run fetch          # Fetch due sources (--source twitter, --all, --due)
npm run process        # Run extraction pipeline (-d days, -l limit)
npm run synthesize     # Generate synthesis (-d lookback, -t topics, --no-digest)
npm run digest         # Generate weekly digest
npm run status         # System status overview
```

### CLI Direct
```bash
tsx src/cli.ts query reasoning         # Query claims by topic
tsx src/cli.ts query -c lab-researcher # Filter by author category
tsx src/cli.ts predictions --list      # List pending predictions
```

## Architecture

```
Fetch → Filter (GLM) → Extract (Claude) → Enrich (embeddings) → Synthesize (Claude) → Digest
```

### Key Files

| File | Purpose |
|------|---------|
| `index.ts` | `AIIntelOrchestrator` - main pipeline coordinator |
| `agent-sdk-wrapper.ts` | `AIIntelAgent` + `GLMClient` - Claude Agent SDK integration |
| `cli.ts` | Commander-based CLI, all user commands |
| `fetcher.ts` | `AIIntelFetcher` - source fetching (Twitter via TwitterAPI.io, Substack, YouTube, Bluesky, blogs, arXiv, LessWrong) |
| `storage.ts` | Database stores: `ContentStore`, `ClaimStore`, `SynthesisStore`, `SourceStore`, `PredictionTracker` |
| `embeddings.ts` | `EmbeddingService` - Ollama/OpenAI/Voyage embeddings |
| `types.ts` | All TypeScript interfaces and type definitions |
| `prompts.ts` | Prompt templates for filtering, extraction, synthesis |

### Model Strategy

- **GLM 4.7** (via Z.ai): Bulk filtering/classification - fast, cheap. Used when `model: 'haiku'` in agent defs.
- **Claude Opus/Sonnet**: Nuanced extraction, synthesis, digest writing. Used when `model: 'inherit'`.

### Subagents (in agent-sdk-wrapper.ts)

Programmatic agents invoked via Task tool:
- `content-filter`: High-throughput relevance scoring (routes to GLM)
- `claim-extractor`: Deep claim/prediction extraction
- `synthesis`: Cross-source synthesis and hype delta calculation
- `digest-writer`: Weekly digest generation with distinctive voice

## Environment Variables

```bash
# Required
DATABASE_URL="postgresql://user:pass@localhost:5432/ai_intel"
CLAUDE_CODE_OAUTH_TOKEN="your-claude-oauth-token"
TWITTER_API_KEY="your-twitterapi-io-key"  # From https://twitterapi.io

# For GLM routing via Z.ai
GLM_API_KEY="your-glm-api-key"
GLM_BASE_URL="https://api.z.ai/v1"  # Default

# Optional
EMBEDDING_PROVIDER="ollama"  # or "openai", "voyage"
OPENAI_API_KEY="sk-..."      # If using OpenAI embeddings
VOYAGE_API_KEY="..."         # If using Voyage embeddings
USE_SKILLS="true"            # Enable .claude/skills/
GLM_FALLBACK="false"         # Use GLM for filtering fallback
```

### Twitter API (TwitterAPI.io)

Uses [TwitterAPI.io](https://twitterapi.io) for Twitter data (Nitter is dead as of 2025).
- Cost: ~$0.15 per 1,000 tweets
- Free tier rate limit: 1 request per 5 seconds
- Get API key at: https://twitterapi.io

## Database (PostgreSQL + pgvector)

Tables: `sources`, `content`, `extracted_claims` (with embeddings), `synthesis_results`, `predictions`

Init: `docker-compose up -d postgres && npm run init-db && npm run seed`

## Agent SDK Usage

Uses `@anthropic-ai/claude-agent-sdk`. Key pattern:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: "...",
  options: {
    allowedTools: ['Read', 'Grep', 'Skill', 'Task'],
    settingSources: ['project'],  // Loads .claude/skills/
    agents: SUBAGENTS
  }
})) {
  if (message.type === 'result' && message.subtype === 'success') {
    // Handle result
  }
}
```

## Types to Know

- `RawContent` → `FilteredContent` → `ExtractedClaim` (pipeline flow)
- `ClaimType`: fact | prediction | hint | opinion | critique
- `Stance`: bullish | bearish | neutral
- `AuthorCategory`: lab-researcher | critic | academic | independent
- `Topic`: scaling | reasoning | agents | safety | interpretability | multimodal | ...

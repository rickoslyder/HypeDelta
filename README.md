# AI Intelligence Extraction & Synthesis System

A comprehensive system for aggregating, extracting, and synthesizing AI research intelligence from researchers, critics, and thought leaders across the AI ecosystem.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FETCH LAYER                                     │
│  Twitter (Nitter RSS) │ Substacks │ YouTube │ Blogs │ Podcasts │ arXiv     │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FILTER LAYER (GLM 4.7)                            │
│  • Relevance scoring (0-1)                                                  │
│  • Topic classification                                                     │
│  • Author categorization (lab-researcher, critic, independent)              │
│  • Noise filtering                                                          │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EXTRACTION LAYER (Claude Opus 4.5)                   │
│  • Claim extraction (facts, predictions, hints, opinions, critiques)        │
│  • Stance classification (bullish/bearish/neutral)                          │
│  • Confidence assessment                                                    │
│  • Timeframe parsing                                                        │
│  • Evidence quality rating                                                  │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            ENRICH LAYER                                      │
│  • Embedding generation (Ollama/OpenAI/Voyage)                              │
│  • Semantic similarity matching                                              │
│  • Contradiction detection                                                   │
│  • Cross-reference linking                                                   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SYNTHESIS LAYER (Claude Opus 4.5)                      │
│  • Topic synthesis (lab consensus vs critic consensus)                       │
│  • Hype delta calculation (overhyped/underhyped assessment)                 │
│  • Prediction tracking                                                       │
│  • Weekly digest generation                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Claude Agent SDK Integration

This system leverages the **Claude Agent SDK** for orchestration. The SDK provides:

### Skills (Filesystem-based)
Skills are SKILL.md files in `.claude/skills/` that Claude automatically discovers and uses based on context.

```
.claude/skills/
├── claim-extraction/
│   └── SKILL.md          # Instructions for extracting claims
├── hype-assessment/
│   └── SKILL.md          # Instructions for assessing hype
└── topic-synthesis/
    └── SKILL.md          # Instructions for synthesizing topics
```

**SKILL.md format:**
```markdown
---
name: claim-extraction
description: Extract structured claims, predictions, and hints from AI research content
---

# Claim Extraction

## Claim Types
- **fact**: Assertion about current state
- **prediction**: Forward-looking statement
- **hint**: Implies unreleased work
...
```

Skills are **NOT** programmatically created - they must be filesystem artifacts. The SDK loads them when `setting_sources=["user", "project"]` is set and `"Skill"` is in `allowed_tools`.

### Subagents (Programmatic + Filesystem)
Subagents can be defined either:

1. **Programmatically** via `agents` parameter:
```typescript
const client = new ClaudeAgentClient({
  agents: {
    'claim-extractor': {
      description: 'Extracts structured claims from AI research content',
      prompt: 'You are a claim extraction specialist...',
      tools: ['Read', 'Grep', 'Skill'],
      model: 'opus'
    }
  }
});
```

2. **As markdown files** in `.claude/agents/`:
```markdown
---
name: claim-extractor
description: Extracts structured claims from AI research content
tools: Read, Grep, Skill
skills: claim-extraction
model: opus
---

You are a claim extraction specialist...
```

Subagents are invoked via the **Task tool**. They maintain isolated context and can run in parallel.

### SDK Usage Pattern
```typescript
import { ClaudeAgentClient, AIIntelAgentFactory } from './agent-sdk-wrapper';

// Initialize factory (creates skills + agents on filesystem)
const factory = new AIIntelAgentFactory(process.cwd());
await factory.initialize();

// Get configured client
const client = factory.getClient({
  model: 'claude-opus-4-5-20250514'
});

// Run queries
const result = await client.run('Analyze this content...');

// Or parse JSON responses
const claims = await client.runJson<ClaimResponse>('Extract claims from...');

// Invoke specific subagent
const synthesis = await client.invokeSubagent('synthesizer', 'Synthesize views on reasoning...');
```

## Model Strategy

| Task | Model | Rationale |
|------|-------|-----------|
| Bulk filtering & classification | GLM 4.7 | Fast, cheap, good at classification |
| Nuanced claim extraction | Claude Opus 4.5 | High reasoning, catches subtle hints |
| Topic synthesis | Claude Opus 4.5 | Complex reasoning across multiple sources |
| Hype assessment | Claude Opus 4.5 | Requires balanced judgment |
| Embeddings | Ollama (local) | Free, fast, good enough for similarity |

## Prerequisites

- Node.js 20+
- PostgreSQL 15+ with pgvector extension
- Claude Code CLI with OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`)
- GLM API key (`GLM_API_KEY`) from Z.ai
- yt-dlp installed (`pip install yt-dlp`)
- Ollama running locally (optional, for embeddings)

## Quick Start

### 1. Clone and Install

```bash
cd ai-intel-extraction
npm install
```

### 2. Set Environment Variables

```bash
# Required
export DATABASE_URL="postgresql://user:pass@localhost:5432/ai_intel"
export CLAUDE_CODE_OAUTH_TOKEN="your-claude-oauth-token"
export GLM_API_KEY="your-glm-api-key"

# Optional
export GLM_BASE_URL="https://api.z.ai/v1"  # Default
export OPENAI_API_KEY="sk-..."  # If using OpenAI embeddings
export VOYAGE_API_KEY="..."     # If using Voyage embeddings
```

### 3. Initialize Database

```bash
# Start PostgreSQL with pgvector
docker-compose up -d postgres

# Initialize schema
npm run init-db

# Seed sources (Twitter handles, Substacks, blogs, etc.)
npm run seed
```

### 4. Run the Pipeline

```bash
# Fetch content from all sources due for update
npm run fetch

# Process fetched content (filter + extract)
npm run process

# Run synthesis and generate digest
npm run synthesize

# Or generate just the digest
npm run digest
```

## CLI Commands

```bash
# Fetch
ai-intel fetch                    # Fetch all active sources
ai-intel fetch --source twitter   # Fetch only Twitter sources
ai-intel fetch --due              # Fetch only sources due for update

# Process
ai-intel process                  # Process content from last 1 day
ai-intel process -d 7 -l 500      # Last 7 days, max 500 items

# Synthesize
ai-intel synthesize               # Run full synthesis (7 day lookback)
ai-intel synthesize -d 14         # 14 day lookback
ai-intel synthesize -t reasoning agents  # Specific topics only
ai-intel synthesize --no-digest   # Skip digest generation

# Query
ai-intel query reasoning          # Query claims about reasoning
ai-intel query -c lab-researcher  # Claims from lab researchers
ai-intel query -a "Yann LeCun"    # Claims by specific author
ai-intel query --json             # Output as JSON

# Predictions
ai-intel predictions --list       # List pending predictions
ai-intel predictions --stats      # Show accuracy statistics
ai-intel predictions -a "Sam Altman"  # By author
ai-intel predictions --verify <id>    # Mark as verified

# Status
ai-intel status                   # System overview

# Digest
ai-intel digest --latest          # Show latest digest
ai-intel digest --generate -o weekly.md  # Generate and save
```

## Cron Setup

```bash
# /etc/cron.d/ai-intel

# Fetch Twitter every 4 hours
0 */4 * * * aiuser cd /opt/ai-intel && npm run fetch -- --source twitter

# Fetch other sources twice daily
0 8,20 * * * aiuser cd /opt/ai-intel && npm run fetch -- --due

# Process content hourly
0 * * * * aiuser cd /opt/ai-intel && npm run process -- -d 1

# Generate weekly digest every Sunday at 9am
0 9 * * 0 aiuser cd /opt/ai-intel && npm run digest -- -o /var/www/digests/$(date +\%Y-\%W).md
```

## Docker Compose

```yaml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: aiintel
      POSTGRES_PASSWORD: aiintel
      POSTGRES_DB: ai_intel
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  ollama:
    image: ollama/ollama
    volumes:
      - ollama:/root/.ollama
    ports:
      - "11434:11434"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

volumes:
  pgdata:
  ollama:
```

## Configuration

### Adding Sources

```typescript
import { SourceStore } from './storage';

const store = new SourceStore(process.env.DATABASE_URL);

// Add a Twitter source
await store.upsert({
  type: 'twitter',
  identifier: 'newresearcher',
  authorName: 'New Researcher',
  category: 'openai',
  fetchFrequencyHours: 6
});

// Add a Substack
await store.upsert({
  type: 'substack',
  identifier: 'https://example.substack.com/feed',
  authorName: 'Example Author',
  category: 'independent',
  fetchFrequencyHours: 12
});
```

### Custom Extraction

Modify prompts in `src/prompts.ts` to adjust extraction behavior:

- `FILTER_PROMPT`: GLM filtering/classification
- `CLAIM_EXTRACTION_PROMPT`: Claude claim extraction
- `TOPIC_SYNTHESIS_PROMPT`: Cross-source synthesis
- `HYPE_ASSESSMENT_PROMPT`: Over/underhyped assessment
- `DIGEST_PROMPT`: Weekly digest format

### Embedding Providers

```typescript
import { EmbeddingService } from './embeddings';

// Local (free, requires Ollama)
const embeddings = new EmbeddingService({ provider: 'ollama' });

// OpenAI (paid, high quality)
const embeddings = new EmbeddingService({ 
  provider: 'openai',
  model: 'text-embedding-3-small',
  apiKey: process.env.OPENAI_API_KEY
});

// Voyage AI (specialized for retrieval)
const embeddings = new EmbeddingService({
  provider: 'voyage',
  model: 'voyage-3',
  apiKey: process.env.VOYAGE_API_KEY
});
```

## Output Examples

### Weekly Digest

```markdown
## 🎯 TL;DR
- Reasoning capabilities remain the hottest debate topic
- Lab researchers increasingly bullish on agent architectures
- Critics skeptical of benchmark gaming on MMLU/GSM8K
- Notable prediction: o3 successor expected Q2 2025

## 📊 Hype Check
**Overhyped**: Agents (+0.4 hype delta) - Lab enthusiasm outpaces demonstrable reliability
**Underhyped**: Interpretability (-0.3) - Real progress on mechanistic understanding underappreciated

## 🔬 Research Signals
Chris Olah hinted at "interesting results" on feature steering...
Noam Brown's poker AI work being applied to reasoning...

## 🤔 Critic Corner
François Chollet: "Scaling alone won't solve abstraction"
Gary Marcus: Reliability concerns for agentic deployment...

...
```

### Claim Query

```json
{
  "id": "claim_1703847293_abc123",
  "claimText": "Chain-of-thought prompting shows diminishing returns beyond 8 reasoning steps",
  "claimType": "opinion",
  "topic": "reasoning",
  "stance": "bearish",
  "bullishness": 0.3,
  "confidence": 0.7,
  "author": "François Chollet",
  "authorCategory": "critic",
  "evidenceProvided": "moderate"
}
```

## Extending the System

### Adding a New Source Type

1. Add type to `src/types.ts`
2. Implement fetcher in `src/fetcher.ts`
3. Add parsing logic
4. Update CLI if needed

### Custom Synthesis Logic

```typescript
// src/custom-synthesis.ts
import { AIIntelOrchestrator } from './index';

const orchestrator = new AIIntelOrchestrator(config);

// Custom topic comparison
const reasoning = await orchestrator.claimStore.getByTopic('reasoning', 30);
const scaling = await orchestrator.claimStore.getByTopic('scaling', 30);

// Your custom analysis...
```

### MCP Server Integration

The system can be exposed as an MCP server:

```typescript
// Future: src/mcp-server.ts
export const tools = {
  get_topic_consensus: async (topic: string) => {...},
  get_researcher_views: async (name: string) => {...},
  get_hype_assessment: async () => {...},
  search_claims: async (query: string) => {...}
};
```

## Troubleshooting

### Nitter instances failing
Instances rotate frequently. Update `NITTER_INSTANCES` in `fetcher.ts` or fall back to yt-dlp.

### Claude rate limits
The system uses Claude Max via OAuth token. If hitting limits, reduce batch sizes or add delays.

### pgvector not found
Ensure you're using the `pgvector/pgvector` Docker image or have installed the extension manually.

## License

MIT

# Claude Agent SDK Usage Guide

This project uses the **actual** `@anthropic-ai/claude-agent-sdk` package - the official TypeScript SDK for building AI agents with Claude Code's capabilities.

## Installation

```bash
npm install @anthropic-ai/claude-agent-sdk zod
```

## Core API

### `query()` - Main Function

The primary function for interacting with Claude. Returns an async generator of `SDKMessage` objects.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: "Analyze this code for bugs",
  options: {
    cwd: process.cwd(),
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    settingSources: ['project'], // Load .claude/skills/ and CLAUDE.md
    maxTurns: 10
  }
})) {
  if (message.type === 'result' && message.subtype === 'success') {
    console.log(message.result);
  }
}
```

### Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `cwd` | `string` | Working directory |
| `model` | `string` | Model to use (sonnet, opus, haiku) |
| `allowedTools` | `string[]` | Tools the agent can use |
| `settingSources` | `('user' \| 'project' \| 'local')[]` | Which settings to load |
| `agents` | `Record<string, AgentDefinition>` | Programmatic subagent definitions |
| `maxTurns` | `number` | Maximum conversation turns |
| `maxBudgetUsd` | `number` | Maximum budget in USD |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions'` | Permission handling |

### Built-in Tools

- `Read` - Read files
- `Write` - Write files  
- `Edit` - Edit files with find/replace
- `Bash` - Execute shell commands
- `Grep` - Search file contents
- `Glob` - Find files by pattern
- `WebFetch` - Fetch web content
- `WebSearch` - Search the web
- `Task` - Spawn subagents
- `Skill` - Use skills from `.claude/skills/`

## Skills

Skills are specialized capabilities defined as markdown files in `.claude/skills/*/SKILL.md`.

To enable skills:
```typescript
const result = query({
  prompt: "Use the content-filter skill",
  options: {
    settingSources: ['project'], // Required to load skills
    allowedTools: ['Skill', 'Read']
  }
});
```

## Subagents

### Programmatic Definition

```typescript
import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

const agents: Record<string, AgentDefinition> = {
  'code-reviewer': {
    description: 'Reviews code for bugs and style issues',
    tools: ['Read', 'Grep', 'Glob'],
    prompt: 'You are a code review specialist...',
    model: 'inherit' // or 'sonnet', 'opus', 'haiku'
  }
};

for await (const msg of query({
  prompt: "Use the code-reviewer agent to analyze src/",
  options: {
    agents,
    allowedTools: ['Task', 'Read']
  }
})) {
  // ...
}
```

### Filesystem Definition

Create `.claude/agents/agent-name.md`:

```markdown
---
name: code-reviewer
description: Reviews code for bugs and style issues
tools: Read, Grep, Glob
model: sonnet
---

You are a code review specialist...
```

## Custom MCP Tools

```typescript
import { tool, createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const myTool = tool(
  'calculate',
  'Perform calculations',
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: `Result: ${a + b}` }]
  })
);

const server = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [myTool]
});

for await (const msg of query({
  prompt: "Calculate 5 + 3",
  options: {
    mcpServers: { 'my-tools': server }
  }
})) {
  // ...
}
```

## Message Types

```typescript
type SDKMessage = 
  | SDKAssistantMessage  // Claude's response
  | SDKUserMessage       // User input
  | SDKResultMessage     // Final result
  | SDKSystemMessage     // System info
  | SDKPartialAssistantMessage  // Streaming (if enabled)
```

### Result Message

```typescript
if (message.type === 'result') {
  if (message.subtype === 'success') {
    console.log(message.result);
    console.log(message.total_cost_usd);
    console.log(message.usage);
  } else {
    console.error(message.errors);
  }
}
```

## Z.ai / GLM Integration

For routing haiku requests to GLM via Z.ai, set environment variables:

```bash
export ANTHROPIC_API_KEY="your_zai_key"
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
```

Or in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_zai_key",
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"
  }
}
```

Then use `model: 'haiku'` in subagent definitions - it will route through Z.ai to GLM.

## This Project's Architecture

```
src/
├── agent-sdk-wrapper.ts   # SDK wrapper with subagent definitions
├── index.ts               # Orchestrator using the wrapper
├── cli.ts                 # CLI interface
└── ...

.claude/
├── skills/                # Skill definitions (SKILL.md files)
│   ├── claim-extraction/
│   ├── content-filter/
│   └── ...
└── agents/                # Filesystem-based agent definitions
    ├── claim-extractor-agent.md
    └── ...
```

## References

- [Official Documentation](https://docs.claude.com/en/api/agent-sdk/typescript)
- [GitHub Repository](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Migration Guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide)
- [NPM Package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

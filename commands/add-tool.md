---
description: Add a client-side tool (or toolset) to an existing Diva agent
argument-hint: [tool name and what it should do]
---

Add a client-side `tool()` to an existing Diva agent in this project.
`$ARGUMENTS` is the tool name and/or a description of what it should do.

## 1. Locate the agent

Find the existing `new Agent(` / `Agent(` construction with `Grep`/`Read`.
Detect the language from `package.json` (`@diva-ai/sdk`) vs `pyproject.toml` /
`requirements.txt` (`diva-ai`). If more than one agent exists in the project, ask
which one gets the new tool. If none exists, suggest `/diva:new-agent` first.

## 2. Interview (skip what's already given)

- **Name**: unique across this agent's `tools` + `toolsets` — a duplicate throws
  `DivaError` at construction, naming both sources.
- **Description**: one line, written **for the model** — this is literally what
  the model reads to decide whether to call the tool, so make it specific about
  what it does and when to call it (e.g. "Get the current temperature for a
  city. Call this for any weather question.").
- **Input fields**: map to a `zod` schema (TS, `z.object({...})`) or a
  `pydantic.BaseModel` (Python) — whichever the agent's language uses.
- **What `execute` actually does**: which internal API/DB/file/service does it
  call? It runs **in your own process** — the platform sandboxes nothing here,
  so treat the model's arguments as untrusted input and validate them yourself
  beyond the schema if they drive anything sensitive.
- **Slow?** If the tool can take a while (a slow API, or a `handoff` running a
  full sub-agent turn), raise `executeTimeoutMs` (TS) / the tool's timeout above
  the default **60 000 ms** ceiling.

## 3. Write the tool

**TypeScript**
```ts
import { tool, z } from "@diva-ai/sdk";

const myTool = tool({
  name: "…",
  description: "…",
  inputSchema: z.object({ /* … */ }),
  execute: async (input, ctx) => {
    // runs in-process; input is already validated against inputSchema
    return { /* plain object/string/number — coerced to text for the model */ };
  },
  // executeTimeoutMs: 120_000, // only if this tool is slow
});
```

**Python**
```python
from pydantic import BaseModel
from diva_ai import tool

class MyToolInput(BaseModel):
    ...

async def my_tool_execute(inp: MyToolInput):
    ...

my_tool = tool(
    name="…",
    description="…",
    input_schema=MyToolInput,
    execute=my_tool_execute,
)
```

## 4. Wire it in

Add it to the agent's `tools: [...]` array. If there are already 2+ related
tools, prefer grouping them with `toolset(name, tools)` (TS) /
`toolset(name, tools)` (Python) instead of a flat list — it's purely
organizational (same runtime behavior) but keeps the agent's capability surface
readable.

**Owns-host check (TypeScript only)**: if this agent passes an explicit
`client:` alongside `tools`/`toolsets`, construction throws `DivaError` — move
the client's config into `clientOptions` instead of a shared `client`, or ask
the user which they'd rather change. Python has no shared-client concept, so
this never applies there.

## 5. Gotchas to call out while editing

- `permissions.deny` (TS) does **not** gate client tools — it only strips engine
  built-ins by exact name and is a silent no-op against the MCP-prefixed
  `diva-tools__<name>` client tools. To gate your own tool, use `guard.tool` (see
  the `guards` skill) or the interactive `permissions.canUseTool` /
  `Permissions.can_use_tool` callback instead.
- A thrown error inside `execute` is **never silent** — it surfaces to the model
  as an `isError` tool result (`Tool error: <message>`); it does not by itself
  abort the turn. Don't add a try/except that swallows it into a generic string
  unless that's genuinely what you want the model to see.
- Return values are coerced to text for the model (a string passes through; any
  other value becomes `JSON.stringify(...)` / its JSON dump) — return exactly
  what you want the model to read, not an internal object graph.

## 6. Verify

Run the agent with a prompt designed to trigger the new tool (via
`/diva:run-example`-style manual run, or the project's own entry point) and
confirm the model actually calls it and the reply reflects the tool's result.

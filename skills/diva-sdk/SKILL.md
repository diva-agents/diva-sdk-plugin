---
name: diva-sdk
description: Use when building or managing AI agents with the Diva SDK — the `diva-ai` (Python) or `@diva-ai/sdk` (TypeScript) thin clients — including creating agents, tools/toolsets, sessions & memory, MCP servers, sub-agents, flow, permissions/hooks/guards, or deploying and managing agents on the Diva platform.
---

# Diva SDK

The Diva SDK lets you build AI agents in a few lines and run them on Diva's hosted
platform. This is the umbrella skill — read it first, then use the specialist
skills (tools, mcp, sessions-memory, guards-permissions, flow, subagents,
deployment, error-handling) for depth.

Full docs (always the source of truth, kept in sync with the code):
**https://front.dev.diva-ai.ru/ux/sdk-docs** (Python & TypeScript, EN/RU).

For exact signatures offline, this plugin bundles the generated API reference at
`${CLAUDE_PLUGIN_ROOT}/references/typescript/` and `.../python/` (English,
version-pinned; refreshed by `scripts/sync-docs.mjs`). See `references/manifest.json`
for the pinned SDK versions.

## Operating principles (read before writing code)

1. **Thin client, engine runs server-side.** The SDK never runs an agent engine
   locally. `run` / `stream` / `generate` open a WebSocket to the Diva gateway;
   all model traffic and tool orchestration happen on the platform.
2. **Traffic-lock.** The gateway URL defaults to `wss://api.diva.ai/gateway` and
   auth is a **bearer `sk-diva-…` key only** — there is no bring-your-own-provider
   and no local model. Don't try to point the SDK at OpenAI/Anthropic directly.
3. **Fail-loud, never silent.** Unwired/planned features raise a typed
   `DivaNotImplementedError` — `permissions.mode`/`deny` and hosted `builtinTools`
   throw at construction (TS); `knowledge=` throws at construction in Python but at
   the first `run()` in TS. If you hit one, the feature isn't available yet — don't
   work around it silently. Read the message before concluding a capability is
   missing: `knowledge=` refuses the ARGUMENT and points at the knowledge-base
   HTTP API, which works today (`/api/v1/agi/sdk/kb/collections` + `/chunks`, and
   the agent gets a search tool on its next turn).
4. **Model refs are namespaced** `diva/<family>/<model>` — the platform routes
   them to the real backend. A per-turn override is `run(..., model=...)`.
5. **Python ↔ TypeScript parity.** Both clients speak the same gateway protocol
   with byte-identical session keys, so a Python and a TS client can resume the
   same server-side conversation. APIs mirror each other (snake_case vs camelCase).

## Quick start

Python (`pip install diva-ai`):
```python
import asyncio
from diva_ai import Agent

async def main():
    agent = Agent(model="diva/deepseek/deepseek-v4-flash")  # needs env DIVA_API_KEY=sk-diva-…
    reply = await agent.run("Summarize what an MCP server is in one sentence.")
    print(reply.text)

asyncio.run(main())
```

TypeScript (`npm i @diva-ai/sdk`):
```ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/deepseek/deepseek-v4-flash"); // needs DIVA_API_KEY=sk-diva-…
const reply = await agent.run("Summarize what an MCP server is in one sentence.");
console.log(reply.text);
```

## Managing agents on the platform

This plugin bundles the **Diva platform MCP** (`platform` server in `.mcp.json`).
Once you set your `diva_api_key`, its 12 tools let you confirm identity
(`whoami`), list/get/create/update agents, set an agent's operating mode, inspect
sessions & runs, watch usage, and list channels — all scoped to your org by the
key. See the **platform-admin** skill for the full tool reference. Use those tools
to operate what you build with the SDK.

## Agent options & lifecycle (one-stop map)

`new Agent(model, {...})` (TS) / `Agent(model, ...=)` (Python) — each option is covered
in depth by a specialist skill:

| Option | Skill |
| --- | --- |
| `tools`, `toolset` | **tools-and-toolsets** |
| `mcp` (external servers) | **mcp** |
| `hooks`, `flow` | **hooks-flow** |
| `guards`, `permissions` | **guards-permissions** |
| `skills` (+ TS `skillsMode`) | **agent-skills** |
| `builtinTools` (self-host only) | **code-execution** |
| `instructions`, `thinking`, model params, `compaction` (TS) | **deployment-and-errors** |
| `apiKey`/`api_key`, sessions & `store` | **sessions-memory** |
| operate/inspect agents on the platform | **platform-admin** |

Per-call override: `run(prompt, { model, timeoutMs })` / `run(prompt, model=, timeout_ms=)`.

**Host lifecycle:**
- **TypeScript** — an `Agent` owns a local host. `await agent.start()` pre-warms it
  (optional; the first turn boots it otherwise); `await agent.close()` tears it down and
  does **not** cascade to handoff sub-agents (close each yourself); `agent.session(key)`
  returns a keyed handle. To share one host across agents, pass `clientOptions` / a shared
  `DivaClient` — but `mcp`/`hooks`/`flow` conflict with an explicit shared `client` and throw
  at construction (use `clientOptions` instead).
- **Python** — `diva_ai` is a pure thin client: **no `start()`**, no shared-client concept;
  every `run()` opens/closes a gateway WebSocket; `await agent.close()` releases pooled
  resources; `agent.session(key)` mirrors TS.

## Footgun checklist

- Set `DIVA_API_KEY` (env) or pass `api_key=`/`apiKey`. **Validation timing differs
  by language:** Python validates lazily (a missing key surfaces as `DivaAuthError`
  on the first `run()`), while **TypeScript validates eagerly** — `new Agent(...)`
  throws `DivaAuthError` at construction when no key and no `remoteHost` is set.
- Client `tool()`s execute **in your process**; the platform sandboxes nothing on
  your side — treat tool inputs as untrusted and validate them yourself.
- `params` (Python) / `params` (TS) is a **raw wire passthrough** — its keys stay
  camelCase (`maxTokens`, not `max_tokens`) even in Python.
- Don't hardcode a gateway URL unless self-hosting; the default is correct for the
  hosted platform.

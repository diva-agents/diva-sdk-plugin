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

## Operating principles (read before writing code)

1. **Thin client, engine runs server-side.** The SDK never runs an agent engine
   locally. `run` / `stream` / `generate` open a WebSocket to the Diva gateway;
   all model traffic and tool orchestration happen on the platform.
2. **Traffic-lock.** The gateway URL defaults to `wss://api.diva.ai/gateway` and
   auth is a **bearer `sk-diva-…` key only** — there is no bring-your-own-provider
   and no local model. Don't try to point the SDK at OpenAI/Anthropic directly.
3. **Fail-loud, never silent.** Unwired/planned features raise a typed
   `DivaNotImplementedError` at construction (e.g. `knowledge=`, `permissions.mode`,
   hosted `builtinTools`). If you hit one, the feature isn't available yet — don't
   work around it silently.
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
Once you set your `diva_api_key`, its tools let you list/create agents, wire
channels, inspect sessions & runs, manage the knowledge base and CRM, and watch
usage — all scoped to your org by the key. Use those tools to operate what you
build with the SDK.

## Footgun checklist

- Set `DIVA_API_KEY` (env) or pass `api_key=` — the key is validated lazily (on the
  first turn), so a missing key surfaces as `DivaAuthError` when you run, not at
  construction.
- Client `tool()`s execute **in your process**; the platform sandboxes nothing on
  your side — treat tool inputs as untrusted and validate them yourself.
- `params` (Python) / `params` (TS) is a **raw wire passthrough** — its keys stay
  camelCase (`maxTokens`, not `max_tokens`) even in Python.
- Don't hardcode a gateway URL unless self-hosting; the default is correct for the
  hosted platform.

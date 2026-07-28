# Overview

`diva-ai` is the Python SDK for the **Diva platform**. It is a thin client: the
agent engine runs **server-side** on Diva's hosted gateway. You connect with a
bearer token (`sk-diva-…`), the engine never runs locally, and all model traffic
goes through the platform.

It is the Python sibling of the TypeScript `@diva-ai/sdk` and speaks the same
gateway wire protocol — session keys are byte-identical, so a Python and a TS
client can resume the same server-side conversation.

## Install

```bash
pip install diva-ai            # core
pip install 'diva-ai[mcp]'     # + external MCP servers
```

Requires Python ≥ 3.10. Depends only on `websockets` and `pydantic`.

## Model refs

Models are namespaced `diva/<family>/<model>`. The SDK splits this into a
`provider` and `model` on the wire and the platform routes it to the real
backend. A per-turn override is available via `run(..., model=...)`.

## What you get

- `run` / `stream` / `generate` — one-shot, streaming, and schema-validated turns.
- Client tools + toolsets, MCP servers, sub-agents, and parallel fan-out.
- Sessions + memory (server-side, or client-owned stores).
- Permissions (`can_use_tool`), hooks, guards, skills, and slot-filling flows.
- Reasoning levels, token/usage observability, and resumable streaming.
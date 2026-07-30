---
description: Scaffold a new Diva agent project (Python or TypeScript), interviewing you for details and grounding the code in the live SDK docs
argument-hint: [agent name]
---

Scaffold a new Diva SDK agent project. `$ARGUMENTS` is the suggested project/agent
name (e.g. `support-triage`) — if empty, ask for one.

## 1. Interview (skip anything the user already told you)

- **Language**: Python (`diva-ai`, `pip install diva-ai`, needs Python ≥ 3.10) or
  TypeScript (`@diva-ai/sdk`, `npm i @diva-ai/sdk`, needs Node ≥ 22.14)?
- **Where**: a new subdirectory `./<name>/`, or a single file dropped into the
  current project?
- **Model ref**: a namespaced `diva/<family>/<model>` ref, e.g.
  `diva/deepseek/deepseek-v4-flash` or `diva/deepseek/deepseek-v4-flash`. If the user doesn't
  know, say the authoritative live list is `GET /v1/models` on the platform (the
  bundled `platform` MCP can list agents/usage but model listing is a plain API
  call) and default to `diva/deepseek/deepseek-v4-flash` unless told otherwise.
- **Instructions**: one paragraph — the agent's persona/system prompt.
- **Capabilities now**: any client-side tools, external MCP servers, sub-agents
  (`handoff`), a multi-turn session/store, or local skills? (If yes to any, still
  scaffold the base agent here — hand tools/MCP off to `/diva:add-tool` /
  `/diva:add-mcp` once the base agent runs, unless the user wants it all in one
  pass.)

## 2. Verify against live docs before writing code

The umbrella skill (`skills/diva-sdk/SKILL.md` in this plugin) says the docs are
"always the source of truth, kept in sync with the code." Before generating
anything, `WebFetch` **https://front.dev.diva-ai.ru/ux/sdk-docs** (and the
language-specific getting-started/quickstart section under it) to confirm the
package name, install command, and `Agent` constructor shape below haven't
drifted. If the fetch fails, fall back to the bundled skill doc and say so
explicitly in your summary — don't silently proceed on stale assumptions.

Ground truth as of this plugin's authoring (cross-check, don't blindly trust):

**TypeScript**
```ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "…",
});

try {
  const { text, runId } = await agent.run("…");
  console.log(text);
} finally {
  await agent.close(); // always close in a finally
}
```

**Python**
```python
import asyncio
from diva_ai import Agent

async def main() -> None:
    agent = Agent("diva/deepseek/deepseek-v4-flash", instructions="…")  # needs DIVA_API_KEY
    try:
        result = await agent.run("…")
        print(result.text)
    finally:
        await agent.close()

asyncio.run(main())
```

Both read the key from `DIVA_API_KEY`; there is no bring-your-own-provider — the
gateway is traffic-locked to Diva's `/v1`. Never hardcode any other provider URL.

## 3. Plan, then scaffold

Show the file list you're about to create and proceed (stop only if the target
directory already has conflicting files — ask before overwriting).

**TypeScript layout**
```
<name>/
  package.json        # type: module, engines.node >= 22.14, dep @diva-ai/sdk, devDep tsx
  <name>.ts            # the Agent + run()/close() from step 2, tailored to the interview
  .env.example          # DIVA_API_KEY=sk-diva-...
  .gitignore             # .env, node_modules
```

**Python layout**
```
<name>/
  pyproject.toml       # dependency diva-ai, requires-python >= 3.10 (add diva-ai[mcp] if MCP was requested)
  <name>.py             # the Agent + run()/close() from step 2, tailored to the interview
  .env.example
  .gitignore             # .env, __pycache__/, .venv
```

Write the source file with:
- The `Agent(...)` construction using exactly the options requested in the
  interview — never add an option (e.g. `tools`, `mcp`, `permissions`) the user
  didn't ask for; keep the first scaffold minimal.
- A `try/finally` calling `close()`.
- Imports of the `DivaError` family (`DivaError`, `DivaAuthError`,
  `DivaRequestError`, at minimum) and a `catch`/`except` block that distinguishes
  at least a missing-key failure from a request failure — see the SDK's error
  hierarchy (mirrored in the `diva-sdk-verifier` subagent) rather than a bare
  `catch (err) {}` / `except Exception:`.

## 4. Install and verify

Run the install command (`npm i` / `pip install -e .` or `pip install diva-ai`)
via Bash. Then:

- If `DIVA_API_KEY` is set in the environment, offer to run the new agent's
  first turn as a smoke test and show the output.
- If it isn't set, print the exact run command
  (`DIVA_API_KEY=sk-diva-… node --import tsx <name>.ts` /
  `DIVA_API_KEY=sk-diva-... python <name>.py`) and stop — never fabricate a key.

## 5. Next steps

Point the user at `/diva:add-tool` (client-side tools), `/diva:add-mcp` (external
MCP servers), `/diva:run-example` (pull a runnable doc example instead of
hand-writing one), and `/diva:deploy` (register the finished agent on the
platform, confirmation-gated).

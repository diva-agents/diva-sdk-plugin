# diva-sdk (Claude Code plugin)

Build and manage AI agents on the [Diva](https://front.dev.diva-ai.ru/ux/sdk-docs)
platform with the Diva SDK — `diva-ai` (Python) or `@diva-ai/sdk` (TypeScript) —
without leaving Claude Code. This plugin bundles the SDK skill, seven slash
commands, three specialist subagents, and the hosted Diva platform MCP server.

Diva SDK agents are a **thin client**: `Agent(model, ...)` opens a WebSocket to
a remote Diva gateway and the model loop, tool orchestration, and compaction
all run **server-side**. Auth is a single bearer `sk-diva-…` key — there's no
bring-your-own-provider and no local engine to run. Model refs are namespaced
`diva/<family>/<model>` (e.g. `diva/gpt/gpt-4o-mini`), and the Python and
TypeScript clients speak the same gateway protocol with byte-identical session
keys, so a conversation can be resumed from either.

## Install

```
/plugin marketplace add /path/to/diva-sdk-plugin
/plugin install diva-sdk@diva
```

(Once this plugin is published to a git remote, use that URL instead of a
local path with `/plugin marketplace add`.)

Then enable it — it ships `"defaultEnabled": false`, so it won't activate on
install alone:

```
/plugin enable diva-sdk
```

### Set your API key

The plugin needs one setting, `diva_api_key` — your Diva platform key
(`sk-diva-…`), marked sensitive in the manifest. It's the bearer token for
**both** the bundled platform MCP server and (via `DIVA_API_KEY` in your own
shell/`.env`) the SDK itself when you run agents locally. Get it from your Diva
workspace → **Developers → SDK**, then set it through Claude Code's plugin
settings for `diva-sdk` (you'll be prompted for it when you enable the plugin,
or set it any time via `/plugin`).

## What's inside

- **Skill** — `skills/diva-sdk/SKILL.md`: the umbrella skill covering the SDK's
  operating principles (thin client, traffic-lock, fail-loud, namespaced
  models, Python/TypeScript parity), a quick start for both languages, and the
  footgun checklist. Loads automatically whenever you're working with Diva
  agents, tools, MCP, sessions, guards/permissions/hooks, flow, or deployment.

- **Commands** (`/diva:<name>`):
  | Command | What it does |
  | --- | --- |
  | `/diva:new-agent` | Scaffold a new Diva agent project (Python or TypeScript) — interviews you, verifies the API against live docs, writes a runnable agent. |
  | `/diva:add-tool` | Add a client-side `tool()`/`toolset()` to an existing agent. |
  | `/diva:add-mcp` | Wire an external MCP server (`MCP.stdio`/`MCP.http`) into an agent. |
  | `/diva:run-example` | Pull a real, documented example (quickstart, tools, mcp, subagents, streaming, …) and run it. |
  | `/diva:deploy` | Register/update an agent on the platform via the platform MCP — **confirmation-gated**: preflight → plan → ask → execute → verify. |
  | `/diva:debug-session` | Inspect a session/run via the platform MCP and diagnose failures against the SDK's `DivaError` hierarchy. |

- **Subagents** (delegate automatically, or invoke by name):
  | Agent | What it does |
  | --- | --- |
  | `diva-agent-builder` | Builds a complete agent from a spec — scaffolding, `Agent` construction, tools/MCP/sub-agents/skills — verified against live docs. |
  | `diva-mcp-integrator` | Wires MCP servers into an agent, including the platform/external distinction and each SDK's owns-host and secrets rules. |
  | `diva-sdk-verifier` | Read-only review of Diva SDK code for correctness — traffic-lock, fail-loud vs. silent fallback, snake_case/camelCase, owns-host conflicts — split-aware of Python vs. TypeScript. |

- **MCP** — the `platform` server (`.mcp.json`, `https://mcp.diva-ai.ru/mcp`),
  authenticated with your `diva_api_key`. Once set, its tools let you
  list/create agents, wire channels, inspect sessions & runs, manage the
  knowledge base and CRM, and watch usage — all scoped to your org by the key.
  `/diva:deploy` and `/diva:debug-session` drive it directly.

## Docs

Full SDK docs (Python & TypeScript, EN/RU) — always the source of truth, kept
in sync with the code:

**https://front.dev.diva-ai.ru/ux/sdk-docs**

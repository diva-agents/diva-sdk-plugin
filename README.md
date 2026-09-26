# diva-sdk (Claude Code plugin)

Build and manage AI agents on the [Diva](https://diva-ai.ru)
platform with the Diva SDK — `diva-ai` (Python) or `@diva-ai/sdk` (TypeScript) —
without leaving Claude Code. This plugin bundles a set of SDK skills, seven slash
commands, three specialist subagents, and the hosted Diva platform MCP server.

Diva SDK agents are a **thin client**: `Agent(model, ...)` opens a WebSocket to
a remote Diva gateway and the model loop, tool orchestration, and compaction
all run **server-side**. Auth is a single bearer `sk-diva-…` key — there's no
bring-your-own-provider and no local engine to run. Model refs are namespaced
`diva/<family>/<model>` (e.g. `diva/deepseek/deepseek-v4-flash`), and the Python and
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

### Set your keys

The plugin and the SDK use **two different `sk-diva-…` keys** — they are not
interchangeable:

- **`diva_mcp_key`** (plugin setting, marked sensitive) — the bearer for the
  bundled platform MCP. Issue it from your Diva workspace → **Developers → MCP
  keys**; it carries MCP scope. An ordinary SDK/inference key here is rejected
  with `401`. You're prompted for it when you enable the plugin, or set it any
  time via `/plugin`.
- **`DIVA_API_KEY`** (your own shell/`.env`) — the SDK/inference key the agents
  you run read at runtime. There is no separate "SDK" page: this is the key
  issued on **Разработчикам → API** (Developers → API access, `/ux/api-keys`,
  the page for the OpenAI-compatible `/v1` keys) — then
  `export DIVA_API_KEY=sk-diva-…`. The plugin config does **not** export it, so
  SDK runs throw `DivaAuthError` without it.

By default both the MCP and the SDK target production. To test against the dev
stand, point both at it — a dev key is rejected by production:

- plugin setting **`diva_mcp_url`** = `https://api.dev.diva-soft.ru/mcp/platform-admin/mcp`;
- SDK: `export DIVA_GATEWAY_URL=wss://api.dev.diva-soft.ru/gateway`
  (the default is `wss://api.diva-ai.ru/gateway`).

## What's inside

- **Skill** — `skills/diva-sdk/SKILL.md`: the umbrella skill covering the SDK's
  operating principles (thin client, traffic-lock, fail-loud, namespaced
  models, Python/TypeScript parity), a quick start for both languages, and the
  footgun checklist. Loads automatically whenever you're working with Diva
  agents, tools, MCP, sessions, guards/permissions/hooks, flow, or deployment.

- **Commands** (`/diva-sdk:<name>`):
  | Command | What it does |
  | --- | --- |
  | `/diva-sdk:new-agent` | Scaffold a new Diva agent project (Python or TypeScript) — interviews you, verifies the API against live docs, writes a runnable agent. |
  | `/diva-sdk:add-tool` | Add a client-side `tool()`/`toolset()` to an existing agent. |
  | `/diva-sdk:add-mcp` | Wire an external MCP server (`MCP.stdio`/`MCP.http`) into an agent. |
  | `/diva-sdk:run-example` | Pull a real, documented example (quickstart, tools, mcp, subagents, streaming, …) and run it. |
  | `/diva-sdk:deploy` | Register/update an agent on the platform via the platform MCP — **confirmation-gated**: preflight → plan → ask → execute → verify. |
  | `/diva-sdk:debug-session` | Inspect a session/run via the platform MCP and diagnose failures against the SDK's `DivaError` hierarchy. |
  | `/diva-sdk:verify-flow` | Validate a funnel / frame-flow JSON against the current grammar + save-time invariants before you save. |

- **Subagents** (delegate automatically, or invoke by name):
  | Agent | What it does |
  | --- | --- |
  | `diva-agent-builder` | Builds a complete agent from a spec — scaffolding, `Agent` construction, tools/MCP/sub-agents/skills — verified against live docs. |
  | `diva-mcp-integrator` | Wires MCP servers into an agent, including the platform/external distinction and each SDK's owns-host and secrets rules. |
  | `diva-sdk-verifier` | Read-only review of Diva SDK code for correctness — traffic-lock, fail-loud vs. silent fallback, snake_case/camelCase, owns-host conflicts — split-aware of Python vs. TypeScript. |

- **MCP** — the `platform` server (`.mcp.json`, at `diva_mcp_url` — default
  `https://api.diva-ai.ru/mcp/platform-admin/mcp`), authenticated with your
  `diva_mcp_key`. Its 12 tools let you confirm your identity (`whoami`),
  list/get/create/update agents, set an agent's operating mode, inspect
  sessions & runs, watch usage, and list channels — all scoped to your org by
  the key (no cross-org access). The **`platform-admin`** skill documents every
  tool; `/diva-sdk:deploy` and `/diva-sdk:debug-session` drive them.

- **References** (`references/`) — the full SDK API reference (TypeScript & Python,
  English), generated from the live docs pipeline and pinned per version; refresh
  with `node scripts/sync-docs.mjs` on each release (it pulls the latest bundles from
  the docs endpoint). Skills point here for exact signatures.

## Docs

Full SDK docs (Python & TypeScript, EN/RU) — always the source of truth, kept
in sync with the code:

**https://diva-ai.ru/ux/sdk-docs** (in your Diva workspace, after login; dev
stand: `https://dev.diva-soft.ru/ux/sdk-docs`). Without login the same content is
served as JSON at `https://api.diva-ai.ru/v1/docs/{python|typescript}/latest?language=en`.

## Contributing

Branch off `main`. Specs (`TZ.md`) and acceptance notes (`ACCEPTANCE.md`) live in
`research/<date>-<name>/`, and a PR links to its spec.

Nothing here compiles, so verification is an install and a live run: reinstall the
plugin from scratch, then exercise the command, skill, or agent you touched **in a
clean session** — the session you edited in already knows what you meant, and a
user's session will not. Refresh `references/` with `node scripts/sync-docs.mjs`
when the SDK API moves.

The full team process — taking a task, shipping it with evidence, reviewing,
filing work — is in [`PROCESS.md`](./PROCESS.md) (in Russian).

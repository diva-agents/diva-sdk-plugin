# diva-sdk (Claude Code plugin)

Build and manage AI agents on the [Diva](https://diva-ai.ru)
platform with the Diva SDK — `diva-ai` (Python) or `@diva-ai/sdk` (TypeScript) —
without leaving Claude Code. This plugin bundles a set of SDK skills, seven slash
commands, three specialist subagents, and the hosted Diva platform MCP server.

Diva SDK agents are a **thin client**: `Agent(model, ...)` opens a WebSocket to
a remote Diva gateway and the model loop, tool orchestration, and compaction
all run **server-side**. SDK auth is a single bearer `sk-diva-…` key — there's no
bring-your-own-provider and no local engine to run. Model refs are namespaced
`diva/<family>/<model>` (e.g. `diva/deepseek/deepseek-v4-flash`), and the Python and
TypeScript clients speak the same gateway protocol with byte-identical session
keys, so a conversation can be resumed from either.

## Install

In Claude Code:

```
/plugin marketplace add diva-agents/diva-sdk-plugin
/plugin install diva-sdk@diva
```

The plugin is enabled on install. Then connect the platform MCP with your Diva
account — no key to copy:

```
/mcp
```

pick **`plugin:diva-sdk:platform`** → **Authenticate**. The browser opens Diva: sign
in (if you aren't already) and press **Allow**. Back in Claude Code the server shows
as connected; ask *"which Diva workspace am I in?"* to check. Claude Code keeps and
refreshes the token; you act as that user in their current organization.

### The SDK key (only for SDK code)

Agents you write with the SDK and run from your machine need their own key:
**`DIVA_API_KEY`**, issued in your Diva workspace → **Developers → API**
(`/ux/api-keys`, the page for the OpenAI-compatible `/v1` keys) —
`export DIVA_API_KEY=sk-diva-…`. Signing in to the MCP does not provide it; without
it SDK runs throw `DivaAuthError`. `/diva-sdk:new-agent` tells you where to get it
if it's missing.

### Dev stand

Both the MCP and the SDK target production by default. To work against the dev
stand, set two variables before starting Claude Code (a dev account and dev key are
rejected by production):

```
export DIVA_MCP_URL=https://api.dev.diva-soft.ru/mcp/platform-admin/mcp
export DIVA_GATEWAY_URL=wss://api.dev.diva-soft.ru/gateway   # for SDK runs
claude
```

`/mcp` then signs you in to `dev.diva-soft.ru`.

### Headless / CI (MCP key instead of sign-in)

Where no browser can sign in, add the platform MCP yourself with an MCP key from
**Developers → MCP** (it carries MCP scope; an SDK key is rejected with `401`):

```
claude mcp add --transport http diva https://api.diva-ai.ru/mcp/platform-admin/mcp \
  --header "Authorization: Bearer sk-diva-…"
```

A server you add this way at the same URL **replaces** the plugin's `platform` server
(Claude Code keeps one server per URL), and with an `Authorization` header there is no
sign-in fallback: a wrong key shows as *Failed to connect … HTTP 401*. To go back to
signing in, `claude mcp remove diva`.

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

- **MCP** — the `platform` server (`.mcp.json`, at `DIVA_MCP_URL` — default
  `https://api.diva-ai.ru/mcp/platform-admin/mcp`), signed in with your Diva account
  over OAuth. Its tools let you confirm your identity (`whoami`),
  list/get/create/update agents, set an agent's operating mode, inspect
  sessions & runs, watch usage, and list channels — all scoped to the org you
  signed in to (no cross-org access). The **`platform-admin`** skill documents the
  tools; `/diva-sdk:deploy` and `/diva-sdk:debug-session` drive them.

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

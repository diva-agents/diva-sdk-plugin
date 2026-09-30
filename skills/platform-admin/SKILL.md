---
name: platform-admin
description: Use when managing or inspecting your own Diva-platform resources — agents, sessions, runs, token usage, channels — through the bundled `platform` MCP (the org-scoped platform-admin server this plugin ships). This is administering the Diva platform itself; it is NOT the `mcp` skill, which attaches EXTERNAL MCP servers as tools inside an agent's own code.
---

# Diva platform-admin MCP

The plugin bundles the **`platform`** MCP server (the `platform` entry in
`.mcp.json`, served at path `/mcp/platform-admin`; its tools appear as
`mcp__plugin_diva-sdk_platform__*`) — read/write tools to operate the agents you build with the
SDK: list/create/
configure agents, inspect their sessions and runs, watch token spend, and see
which channels are bound. It is called **directly by you** (or your tooling — Claude
Code, a CI script). In Claude Code you sign in with your Diva account over OAuth
(`/mcp` → Authenticate → Allow) — no key to copy; headless tooling can instead send
an org-scoped MCP key (`sk-diva-…`) as a static bearer.

**Not the `mcp` skill.** That skill wires an *external* program/service into an
agent as callable tools (`MCP.stdio` / `MCP.http`). This skill *administers Diva*.
Orthogonal systems — reach for the right one.

## Org-scoping — the one thing to internalize

Every tool derives its `org_id` **server-side from the credential** — the OAuth
token you got by signing in, or the MCP key. There is **no
`org_id` parameter on any tool**, and there is no way to reach another org's data —
tenant isolation is structural, not a filter you could forget. A `system_admin`
(non-org-scoped) key is rejected outright.

**Call `whoami` first.** It confirms which organization a key maps to before you
create or mutate anything — every other tool is scoped to exactly that org.

## Identity

- **`whoami()`** — resolve the caller's org (id, name, slug, status) + API-key
  summary (prefix, owner_kind, purpose, tier/limits, expiry). WHEN: always first, to
  confirm the key's org and see its limits.

## Agents

- **`list_agents(limit=20, offset=0)`** — agents in the org, paginated (`limit`
  1–100). Excludes archived + platform-managed singletons. WHEN: find agent ids to
  act on.
- **`get_agent(agent_id)`** — full record: persona, model, status, axes, `agi_config`.
  WHEN: inspect one agent's live configuration.
- **`create_agent(name, type="manager", runtime_version="v2_agi", description=None,
  system_prompt=None, llm_model_id=None)`** — create an agent. `type` is `"manager"`
  (customer-facing, default) or `"voice"`; `assistant`/`meta`/`engine_self`/
  `onboarding` are platform-managed and rejected. `system_prompt` is baked into the
  agent's workspace AGENTS.md; `llm_model_id` is a model UUID (omit for the org
  default). WHEN: stand up a new agent for what you built with the SDK.
- **`update_agent(agent_id, name=None, description=None, system_prompt=None,
  status=None, llm_model_id=None)`** — patch config; **only the fields you pass
  change**. `status` is `"active"|"inactive"|"archived"`; `system_prompt=""` clears
  the prompt. WHEN: rename, re-point the model, or archive an agent.
- **`set_operating_mode(agent_id, mode)`** — set the flagship operating-mode axis.
  `mode` is `"reactive"` (classic ReAct loop, LLM decides termination) or
  `"pipeline"` (runs the agent's authored task-flow). WHEN: switch an agent between
  reactive Q&A and running its flow. **A flow only executes end-to-end in
  `pipeline`.** This is a distinct settings axis — NOT a field on `update_agent`.

### `create_agent`: the `v2_agi` runtime dependency (read this)

`runtime_version` defaults to **`"v2_agi"`** and you almost always want it there.
`v2_agi` seeds the agent's runtime workspace and rebuilds the sidecar config —
and it is **required** for `list_sessions` / `get_session` / `list_runs` / `get_run`
/ `set_operating_mode` to do anything. `"v1_langgraph"` is **legacy**: an agent
created on it has no runtime sidecar, so the session/run/operating-mode tools
have nothing to read or set. If you plan to observe or flow-drive an agent, keep
`v2_agi`.

## Observability

- **`list_sessions(agent_id, limit=20, offset=0, channel=None)`** — an agent's
  conversation sessions, newest first (`limit` 1–200). `channel` filters e.g.
  `"telegram"`, `"webchat"`. WHEN: find session ids for a transcript.
- **`get_session(agent_id, session_id, limit=100)`** — normalized message transcript
  (`limit` 1–500 trailing messages). WHEN: read what was actually said in a session.
- **`list_runs(agent_id, session_key=None, limit=20, offset=0)`** — runs (one run =
  one agent turn/loop) for a session; `session_key` defaults to the agent's main
  session (`agent:<slug>:main`). WHEN: enumerate turns to drill into. **Backed by
  Langfuse** (see footgun).
- **`get_run(run_id)`** — per-run metrics + observations (a Langfuse trace, `run_id`
  from `list_runs`). WHEN: inspect latency/token/cost of one turn.
- **`get_usage(days=30, agent_id=None)`** — token usage + cost, aggregated from the
  billing worker (`days` 1–365). Omit `agent_id` for the whole org; pass it to scope
  to one agent. WHEN: watch spend across the org or per agent.

## Channels

- **`list_channels(limit=20, offset=0, type=None)`** — communication channels bound
  to the org (`limit` 1–100): config + bot info + connected agent + live status
  (`active`/`stopped`) per row. `type` filters e.g. `"telegram"`, `"avito"`, `"max"`,
  `"sip"`, `"vk_teams"`, `"whatsapp"`, `"wazzap"`, `"bitrix"`. WHEN: see what's wired
  and whether it's running.

## Footgun — deployment-conditional failures

The observability tools depend on how the target deployment is provisioned. These
are **not bugs** — they mean a feature isn't configured on that deployment:

- **`get_run` raises "Langfuse observability is disabled on this deployment"** when
  Langfuse isn't wired. `get_run` also 404s (`Run … not found`) for a run outside
  your org — same structural isolation as everything else.
- **`list_runs` returns `source: "disabled"`** (with an empty `items`) instead of
  raising, when Langfuse is off. Check the `source` field before trusting an empty
  list as "no runs".
- **`get_session` raises `TranscriptDecryptUnavailableError`** when a transcript
  exists but the deployment has no decrypt key configured. A missing session is a
  plain not-found instead.
- **Session/run reads vary by `ISKARIOT_AGI_STORAGE_BACKEND`** — a `postgres`/`dual`
  deployment reads from Postgres; otherwise from the filesystem state dir. Same tool,
  different source, occasionally different availability.

## Sign-in — and the separate SDK key

The `platform` MCP needs no key. The first time you use it, run `/mcp`, pick
`plugin:diva-sdk:platform` → **Authenticate**: the browser opens Diva, you sign in and
press **Allow** on the consent screen, and Claude Code keeps (and refreshes) the token.
You act as that user in their current organization. Until then `/mcp` shows the server
as *needs authentication* and no `platform` tools are available.

The plugin points at production (`https://api.diva-ai.ru/mcp/platform-admin/mcp`).
For another stand, start Claude Code with `DIVA_MCP_URL` set, e.g.
`DIVA_MCP_URL=https://api.dev.diva-soft.ru/mcp/platform-admin/mcp`.

**Headless / CI** (no browser to sign in): add the server yourself with an MCP key from
**Developers → MCP** — `claude mcp add --transport http diva <url> --header
"Authorization: Bearer sk-diva-…"`. An SDK/inference key is rejected there with `401`.

**Signing in does not give your code a key.** If you *also* run Diva SDK code in the
same project, the SDK reads **`DIVA_API_KEY`** from the shell / `.env` (see the
`diva-sdk` skill) — issue it on **Developers → API** (`/ux/api-keys`). Without it the
MCP tools work while your SDK `run()` fails with `DivaAuthError`.

## Scope — the live tool list wins

This skill details the core tools above. The server has grown past them (knowledge
base, channel binding, integrations, cron jobs, skills, voice and more — ~70 tools on
the current platform), so **list the `platform` tools you actually have and read
their descriptions** rather than assuming a tool is missing. Tools that change your
organization are refused with *"granted read-only access"* if the sign-in did not
grant write access — reconnect via `/mcp` and approve both rights.

Full SDK reference: https://diva-ai.ru/ux/sdk-docs

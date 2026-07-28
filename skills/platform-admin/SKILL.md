---
name: platform-admin
description: Use when managing or inspecting your own Diva-platform resources — agents, sessions, runs, token usage, channels — through the bundled `platform` MCP (the org-scoped platform-admin server this plugin ships). This is administering the Diva platform itself; it is NOT the `mcp` skill, which attaches EXTERNAL MCP servers as tools inside an agent's own code.
---

# Diva platform-admin MCP

The plugin bundles the **`platform`** MCP server (the `platform` entry in
`.mcp.json`, served at path `/mcp/platform-admin`; its tools appear as
`mcp__platform__*`) — 12 read/write tools to operate the agents you build with the
SDK: list/create/
configure agents, inspect their sessions and runs, watch token spend, and see
which channels are bound. It is called **directly by you** (or your tooling — Claude
Code, a CI script) holding an org-scoped `sk-diva-…` key, the same key primitive
`POST /v1/chat/completions` authenticates.

**Not the `mcp` skill.** That skill wires an *external* program/service into an
agent as callable tools (`MCP.stdio` / `MCP.http`). This skill *administers Diva*.
Orthogonal systems — reach for the right one.

## Org-scoping — the one thing to internalize

Every tool derives its `org_id` **server-side from the bearer key**. There is **no
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
`v2_agi` seeds the agent's IskariotAGI workspace and rebuilds the sidecar config —
and it is **required** for `list_sessions` / `get_session` / `list_runs` / `get_run`
/ `set_operating_mode` to do anything. `"v1_langgraph"` is **legacy**: an agent
created on it has no IskariotAGI sidecar, so the session/run/operating-mode tools
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

## Key setup — and the DUAL-KEY reality

The `platform` MCP authenticates with the plugin's **`diva_api_key`** user-config
value, sent as `Authorization: Bearer sk-diva-…`. Set it once in the plugin config
and the MCP tools work.

**But that config feeds the MCP header ONLY.** If you *also* run Diva SDK code in the
same project, the SDK reads its key from **`DIVA_API_KEY`** in the shell / `.env`
(see the `diva-sdk` skill) — the plugin's `diva_api_key` does not populate it. Two
places, same `sk-diva-…` value: set both, or the MCP tools work while your SDK `run()`
fails with `DivaAuthError` (or vice-versa).

## Scope — what this surface does NOT include

The shipped v1 surface is exactly the 12 tools above. Do not assume more:

- **No knowledge-base tools** and **no CRM tools** — not in this MCP.
- **No channel-connect / disconnect tool.** `list_channels` is **read-only**; binding
  or connecting a channel is done elsewhere (CRM UI), not here.
- Writes are only `create_agent`, `update_agent`, `set_operating_mode`. Everything
  else (`list_*`, `get_*`, `whoami`) is a safe read.

Full SDK reference: https://front.dev.diva-ai.ru/ux/sdk-docs

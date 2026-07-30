---
description: Deploy or register a Diva agent on the platform via the platform MCP (confirmation-gated)
argument-hint: [agent name]
---

Register/update an agent on the Diva platform using this plugin's bundled
platform MCP (server `platform` in `.mcp.json`, authenticated with the
`diva_mcp_key` plugin setting). This is a **state-mutating, confirmation-gated**
command — never skip the ASK step.

## 1. Preflight

- Confirm the platform MCP is actually reachable: look for tools named
  `mcp__platform__*` in the currently available toolset (use `ToolSearch` with a
  query like `"platform"` if they're deferred). If none are visible, stop and
  tell the user to set `diva_mcp_key` for this plugin (Diva workspace →
  Developers → SDK → `sk-diva-…`) before continuing.
- Confirm the agent's own source exists in this project (from `/diva:new-agent`
  or hand-written) and that it constructs cleanly — read it. If the user
  consents, run one local smoke turn first (same as `/diva:run-example`'s
  preflight: `DIVA_API_KEY` must be set) — deploying code that doesn't even run
  locally wastes a platform call and makes debugging harder later.
- **Discover the real tool surface — do not assume names.** List the available
  `mcp__platform__*` tools and read their descriptions to find the ones for
  listing/creating/updating agents (and, if relevant, wiring a channel). Use
  exactly those tools with exactly their documented parameters; never invent a
  tool name or field that isn't actually there.
- Using the list/search tool you found, check whether an agent with this name
  already exists on the platform, to tell a fresh create from an update.

## 2. Plan

Summarize in plain language, before touching anything remote:

- Agent name, model ref (`diva/<family>/<model>`), and a one-line summary of its
  `instructions`.
- Whether this is a **create** or an **update** (and, if update, what's changing).
- Any channels being wired in the same pass.
- The exact platform MCP tool call(s) — name + arguments — that will perform it.

## 3. ASK for explicit confirmation

Show the plan from step 2 and explicitly ask the human to confirm before making
any mutating call. Do not proceed on an assumed "yes," a prior unrelated
approval, or the mere fact that the user ran this command — the command starts
the flow, it doesn't pre-approve the plan.

## 4. Execute

Only after explicit confirmation: call the confirmed platform MCP tool(s)
exactly as planned. Do not add or change parameters beyond what was confirmed.

## 5. Verify

Read the result back with a list/get platform MCP tool — confirm the created or
updated record matches the plan (name, model, instructions), and surface any
id/URL the platform returned.

## 6. Next steps

Point the user at `/diva:debug-session` to inspect the agent's first run once
it's live, and mention that channel/CRM/knowledge-base operations go through
the same platform MCP tools.

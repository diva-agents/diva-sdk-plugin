---
description: Inspect a Diva session or run via the platform MCP tools
argument-hint: [session id or run id]
---

Inspect a Diva session/run on the platform using the bundled platform MCP.
`$ARGUMENTS` may be a session id or run id.

## 1. Preflight

Confirm the platform MCP is reachable — look for `mcp__platform__*` tools
(`ToolSearch` with `"platform"` if they're deferred). If none are visible, stop
and tell the user to set `diva_mcp_key` for this plugin first.

## 2. Discover the real tools — do not assume names

List the available `mcp__platform__*` tools and read their descriptions to find
the ones for sessions, runs, agents, and usage. Use exactly what's there.

## 3. Fetch

If `$ARGUMENTS` gives an id, fetch that session's/run's detail with the matching
tool. If not, list recent sessions/runs (scoped to the org by the key) and ask
the user which agent/session to inspect, or offer the most recent one.

## 4. Summarize

Report: turns, model ref, `stop_reason`/`stopReason`, token usage
(`inputTokens`/`outputTokens`/`totalTokens`, cache read/write if present),
wall-clock `durationMs`, and any error captured on the run.

## 5. If there's an error, diagnose against the SDK's own error model

Map whatever the platform reports to the `DivaError` hierarchy documented in
the SDK guides:

| Class | Typical cause |
| --- | --- |
| `DivaAuthError` | Missing/invalid key, or a blank/unnamespaced model ref. |
| `DivaHostError` | Gateway unreachable, or a call made after `close()`. |
| `DivaRequestError` | The turn errored on the platform, timed out, or a stream drop couldn't be recovered. |
| `DivaNotImplementedError` | An unwired feature was used (`knowledge`, `permissions.mode`/`deny` on the hosted client, a `platform:<name>` skill ref, etc.). |
| `DivaHookError` | A hook's own code threw, or returned a malformed `replace`. |
| `DivaGuardTripped` | A turn-level guard (or a hook `block`) deliberately blocked the turn — check `detail.guard` / `detail.reason`. |

Then check the agent's **own source in this project** (`Grep`/`Read`) for the
named guard/hook/tool/permission implicated — most failures reported by the
platform trace back to a client-side `tool()`, `guard.*`, or
`permissions.canUseTool` in the agent's own code, not the platform itself.

## 6. Suggest next actions

Depending on the diagnosis: retry the turn, loosen/tighten a `guard`, raise a
tool's `executeTimeoutMs` (client tools) or a `handoff`'s `timeoutMs` (sub-agent
turns default to 180 000 ms), fix a `can_use_tool`/`canUseTool` callback, or
re-deploy the fix via `/diva:deploy`.

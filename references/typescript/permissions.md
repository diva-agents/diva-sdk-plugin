# Permissions

The permission and Human-In-The-Loop (HITL) layer. Where [`builtinTools`](./code-execution.md)
decides which built-ins are *available*, `permissions` tunes *how* tools may be used — a mode
preset, static allow/deny rules, and an interactive per-call approval gate that layers on top of
the engine's secure-by-default tool policy. It is Diva's parity with the Claude Agent SDK's
permission model.

> **Which knobs work where.** `permissions.canUseTool` and `permissions.allow` work on the
> **hosted client** — they gate tool calls client-side and need no host built-ins. But
> `permissions.mode` and `permissions.deny` govern the engine's **host built-ins**, so they are
> **self-host only — they throw `DivaNotImplementedError` in the hosted client** (see
> [Deployment](./deployment.md)). The mode-preset and deny sections below apply when you self-host;
> the `canUseTool` / HITL sections apply everywhere.

## When to use

- Restrict what an agent's tools can do beyond the availability opt-in — e.g. read-only
  exploration (`mode: "plan"`), or workspace-confined edits (`mode: "acceptEdits"`).
- Put a human (or a content policy) in front of *every* tool call the model makes, with
  `canUseTool` — the engine gate that inspects the real, structured tool arguments and blocks
  anything you don't approve.
- Strip a specific engine built-in or MCP-server tool out of the model's context entirely with
  `deny`.
- Avoid it when a client-side business rule over *your own* `tool()`s is enough — use
  [`guard.*`](./guards.md) instead (lighter, client-side, no engine round-trip).

## How it works

`permissions` configures the agent's own engine session: `mode` maps to engine tool-policy
presets, `deny` removes tools by exact name, and setting `canUseTool` enables the interactive gate.
Because it configures the engine session, **an agent with `permissions` owns its host** — it cannot
share an explicit `client`. Passing both throws at construction:

```
Agent `permissions` require the agent to own its host: pass `permissions` without a shared
`client` (configure the implicit client via `clientOptions`).
```

`permissions` is validated synchronously at `Agent` / `DivaClient` construction (see
[API](#api-validatepermissions)) so a bad mode, a scoped rule, or a Claude-name deny fails with a
clean `DivaError` instead of an opaque engine error.

### The mode presets

`mode` selects a tool-policy preset. It is *orthogonal* to `builtinTools`: a preset never makes a
tool available on its own — it gates the built-ins you opted into. `PERMISSION_MODES` is the exact
set of accepted values:

| Mode | What it does |
| --- | --- |
| `default` | Secure default: only the opted-in built-ins are available; no extra gating. |
| `acceptEdits` | Confine file writes to the workspace; non-allowlisted `exec` is **denied** (mode-level interactive approval lands in a later increment — this mode alone cannot prompt yet). Enables nothing on its own: pair with `builtinTools.fileOps` to make the edit tools available. |
| `plan` | Read-only exploration: denies `write`/`edit`/`apply_patch`/`exec`/`process`. Gates **engine built-ins only** — an attached mutating client `tool()` or filesystem MCP server keeps its (MCP-prefixed) name and is **not** blocked. Pair with `builtinTools` to have anything to read. |
| `bypassPermissions` | Developer owns the risk: runs the opted-in `exec` with no approval gate. Enables nothing on its own — pair with `builtinTools.codeExec`. Matches Claude's `bypassPermissions`. |

### The interactive gate — `canUseTool`

Setting `permissions.canUseTool` enables the host's gate plugin with `gateAll` on: **the engine
routes every tool call — built-ins and MCP tools alike — that is not matched by an `allow` rule to
your callback before the tool runs.** The callback runs on the *developer's* side (client-side); it
is the HITL gate.

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal },
) => Promise<PermissionResult>;
```

- **`input` is the tool's full structured arguments.** The request payload delivered to the gate is
  already structured — a content policy like "deny if the command matches `rm -rf`" or "deny writes
  to `/etc/**`" sees the real input, not a lossy summary.
- **Fail-closed.** The gate blocks the tool on *any* callback error, a `deny` result, a missing
  tool name, or a decision that doesn't arrive within `approvalTimeoutMs`. The resolve rides a
  second short-lived connection while the turn RPC is pending.
- **Oversized / non-object input is auto-denied.** The engine flags arguments it could not deliver
  faithfully (a non-object arg shape, or an oversized arg — >16 KB serialized). The gate must not
  inspect-and-allow on empty input in that case, so it fails closed (deny) *without* calling your
  callback. Statically `allow` such a tool to bypass inspection.
- **`allow` is the skip-list.** Bare engine tool names in `permissions.allow` are auto-approved
  *without* calling `canUseTool`. Only meaningful alongside `canUseTool`.
- **`ctx.signal`** aborts when the turn settles, so a slow approval callback can't outlive its run.

`PermissionResult` is the decision:

```ts
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string };
```

Return `{ behavior: "allow" }` to run the tool, or `{ behavior: "deny", message }` to block it.

> **Two documented divergences from Claude** (the approval *resolve* round-trip currently carries
> only a decision string): `updatedInput` is **accepted but not applied** — the tool runs with its
> *original* input; and a deny `message` is **accepted but not surfaced to the model** — the engine
> blocks with a generic `"Denied by user"`. Both become expressible when the resolve payload carries
> structured data (a later increment). Note the *request* payload is already structured (full args
> reach `canUseTool`); this limitation is on the resolve side only.

### Static removal — `deny`

`deny` removes engine built-in / MCP-server tools from the model's context by exact name (the
engine's `tools.deny`, the analog of Claude's `disallowedTools`). It uses **engine tool names, not
Claude's**:

- ✅ `exec`, `write`, `read`, `edit`, `web_fetch`, `web_search`, `subagents`
- ⚠️ Not `Bash`, `Write`, `Read`, `Edit`, `WebFetch`, `Task`, …

A Claude-muscle-memory name is caught at construction with a pointer (see the hint table under
[Notes & caveats](#notes--caveats)), because a bare `deny` of the wrong name would otherwise be a
silent no-op. To gate *your own* client `tool()`s, use [`guard.tool`](./guards.md) instead — a bare
`deny` never matches the MCP-prefixed `diva-tools__*` client tools. Argument-scoped rules such as
`exec(rm *)` need the approval layer (a later increment) and are **rejected at construction**.

## Example

### Gate a built-in `exec` with a content policy + human approval

`canUseTool` sees every gated call. Here it auto-allows read-only shell, hard-denies destructive
commands by inspecting the real `command` argument, and routes anything else to a human. A live
`sk-diva-…` key is required (env `DIVA_API_KEY`).

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx canuse.ts
import { Agent, type PermissionResult } from "@diva-ai/sdk";

// In a real app, askHuman awaits a UI/Slack/CLI decision.
async function askHuman(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  console.log(`approve ${toolName}?`, input);
  return false; // auto-deny in this demo
}

async function canUseTool(
  toolName: string,
  input: Record<string, unknown>,
  _ctx: { signal: AbortSignal },
): Promise<PermissionResult> {
  if (toolName === "exec") {
    const cmd = String(input.command ?? "");
    if (/\brm\s+-rf\b|:\(\)\s*\{|\bmkfs\b/.test(cmd)) {
      return { behavior: "deny", message: "destructive command blocked" };
    }
    if (/^(ls|cat|pwd|git status)\b/.test(cmd)) {
      return { behavior: "allow" }; // read-only shell, auto-approved
    }
    return (await askHuman(toolName, input))
      ? { behavior: "allow" }
      : { behavior: "deny", message: "not approved by a human" };
  }
  return { behavior: "allow" };
}

async function main(): Promise<void> {
  const agent = new Agent("diva/gpt/gpt-4o-mini", {
    instructions: "You are a shell operator. Use exec to run commands.",
    builtinTools: { codeExec: "sandbox" }, // makes `exec` available
    permissions: {
      canUseTool,
      allow: ["read"],       // `read` is auto-approved without calling canUseTool
      approvalTimeoutMs: 300_000, // a human needs longer than the 120s default
    },
  });

  try {
    const { text } = await agent.run("Delete every file under /data.");
    console.log(text); // the destructive exec is denied; the model is told and adapts
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Static mode + deny (no callback)

```ts
import { Agent } from "@diva-ai/sdk";

// Read-only explorer: engine built-ins that mutate are denied by the `plan` preset,
// and web_fetch is stripped from the model's context entirely.
const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "Explore the workspace and summarize it. Do not modify anything.",
  builtinTools: { fileOps: "workspace" },
  permissions: {
    mode: "plan",
    deny: ["web_fetch"], // engine name, not `WebFetch`
  },
});
```

For gating *your own* client `tool()`s with an approval prompt, see
[`guard.approval`](./guards.md) — `examples/hitl.ts` uses that path for a refund tool.

## API

### `Permissions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `PermissionMode` | — | Permission mode preset (see `PERMISSION_MODES`). Orthogonal to `builtinTools` (which sets availability). |
| `allow` | `string[]` | — | Bare engine tool names auto-approved **without** calling `canUseTool` (Claude `allowedTools`). Only meaningful alongside `canUseTool` — it is the skip-list. |
| `deny` | `string[]` | — | Engine built-in / MCP-server tool names to remove from the model's context (Claude `disallowedTools`). Bare engine names only; scoped rules like `exec(rm *)` are rejected. |
| `canUseTool` | `CanUseTool` | — | Interactive per-call approval callback. When set, every call not matched by `allow`/`deny` is routed to it before the tool runs. Baking it in makes the agent own its host. |
| `approvalTimeoutMs` | `number` | `120000` | How long `canUseTool` may take before the gate fail-closes to deny (ms). Raise it for a human-in-the-loop callback; the SDK extends the turn RPC timeout to outlast it. Hard cap `600000` (rejected above). |

### `PermissionMode` / `PERMISSION_MODES`

```ts
type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
const PERMISSION_MODES: readonly PermissionMode[] =
  ["default", "acceptEdits", "plan", "bypassPermissions"];
```

See [the mode table](#the-mode-presets) for the semantics of each value.

### `CanUseTool`

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,   // the tool's FULL structured arguments
  ctx: { signal: AbortSignal },     // aborts when the turn settles
) => Promise<PermissionResult>;
```

### `PermissionResult`

```ts
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> } // updatedInput NOT yet applied
  | { behavior: "deny"; message?: string };                       // message NOT yet surfaced
```

### `validatePermissions(permissions: Permissions): void`

Runs at `Agent` / `DivaClient` construction. Throws `DivaError` on the first problem:

| Condition | Error message (verbatim) |
| --- | --- |
| Unknown `mode` | `permissions.mode must be one of default, acceptEdits, plan, bypassPermissions (got …).` |
| `approvalTimeoutMs` not a positive finite number | `permissions.approvalTimeoutMs must be a positive number of milliseconds (got …); 0 or negative would deny every gated tool instantly.` |
| `approvalTimeoutMs > 600000` | `permissions.approvalTimeoutMs must not exceed 600000ms (the engine's hard cap); a larger value is silently clamped engine-side while the client waits longer, discarding a late decision.` |
| `deny` not an array | `permissions.deny must be an array of engine tool names.` |
| `deny` entry not a string | `permissions.deny entries must be strings (engine tool names).` |
| Scoped `deny` rule (contains `(`) | `permissions.deny scoped rule "…" is not supported yet — argument-scoped rules need the approval layer (a later increment). Use a bare tool name.` |
| Claude-name `deny` | `permissions.deny uses ENGINE tool names, not Claude's: "Bash" → did you mean "exec"?` |

## Notes & caveats

- **Owns its host.** `permissions` configures the agent's own engine session, so an agent using it
  cannot share an explicit `client`. Configure the implicit client via `clientOptions` instead. This
  matches `builtinTools`, `params`, `compaction`, `flow`, and invocable `skills`.
- **`canUseTool` is fail-closed.** A callback that throws, a `deny`, a missing tool name, an
  oversized/non-object arg the engine couldn't deliver, or a decision slower than
  `approvalTimeoutMs` all block the tool. The gate never inspects empty input and allows.
- **Two Claude divergences on the resolve side.** `updatedInput` is not applied (the tool runs with
  its original input) and a deny `message` is not surfaced to the model (blocked with a generic
  `"Denied by user"`). Both are later increments.
- **`deny` uses engine names.** The construction check maps common Claude names to their engine
  equivalent: `Bash`/`Shell` → `exec`, `Write` → `write`, `Read`/`Glob`/`Grep` → `read`,
  `Edit`/`NotebookEdit` → `edit`, `WebFetch` → `web_fetch`, `WebSearch` → `web_search`,
  `Task` → `subagents`. Anything else Claude-shaped is a silent no-op if not caught.
- **Scoped rules aren't wired.** `exec(rm *)`-style argument scoping is rejected at construction;
  use `canUseTool` to inspect arguments instead.
- **`mode: "acceptEdits"` cannot prompt yet.** Its non-allowlisted `exec` is denied outright;
  mode-level interactive approval is a later increment. Use `canUseTool` for interactive `exec`
  gating today.
- **`plan` gates engine built-ins only.** A mutating client `tool()` or filesystem MCP server keeps
  its MCP-prefixed name and is not blocked by `plan` — gate those with [`guard.tool`](./guards.md)
  or `canUseTool`.
- **Approval timeout extends the turn.** With `canUseTool` set, the SDK extends the turn RPC timeout
  to outlast the approval budget so the agent RPC doesn't expire mid-decision.
- **Concurrency caveat (fails safe).** Under multiple concurrent turns on one client, a sibling turn
  settling first can abort a still-pending approval → the tool is denied (never wrongly allowed).
  Single-turn use is unaffected.

## See also

- [Code Execution](./code-execution.md) — `builtinTools` availability opt-in that `permissions` gates.
- [Tools](./tools.md) — defining client `tool()`s the gate and guards can act on.
- [Guards](./guards.md) — client-side business-rule guards, including `guard.approval` (HITL for
  your own tools) and `guard.tool`.
- [Error Handling](./error-handling.md) — `DivaError` at construction, gate failure modes.
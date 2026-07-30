---
name: guards-permissions
description: Use when gating tool calls or replies with policy or human-in-the-loop approval in the Diva SDK — permissions.canUseTool/can_use_tool for a fail-closed choke point over every tool call, or guard.* for lighter client-side rules on your own tools; covers real Python vs TypeScript divergences (Python permissions.mode/deny always raise DivaNotImplementedError, not just self-host).
---

# Guards & Permissions

Two layers, same underlying hook machinery: **`permissions`** is the fail-closed security gate;
**`guard.*`** is best-effort business-rule sugar. Rule of thumb: `guard.tool` for your own tools,
`canUseTool`/`can_use_tool` for a hard, universal, auditable gate.

## When to reach for which

- **`permissions.canUseTool` (TS) / `can_use_tool` (Python)** — a single choke point that sees
  *every* gated tool call's full structured input before it runs. Fail-closed: a throw, a `deny`,
  a missing tool name, or a slow decision all block.
- **`guard.*`** — declarative tripwires (blocklist/predicate) scoped to your own reply or one
  client `tool()`. Lighter, no engine round-trip, **not a security boundary**.
- Guards can never reach engine built-ins (`exec`/`read`/`write`/`web_*`) — those live behind the
  MCP boundary and only `permissions` gates them.

## `permissions` — the fail-closed gate

Both SDKs validate `Permissions` synchronously at construction (`DivaError` on a bad value, never
an opaque mid-turn failure).

```ts
// TypeScript
import { Agent, type PermissionResult } from "@diva-ai/sdk";

async function canUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
  if (toolName === "exec" && /\brm\s+-rf\b/.test(String(input.command))) {
    return { behavior: "deny", message: "destructive command blocked" };
  }
  return { behavior: "allow" };
}

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  builtinTools: { codeExec: "sandbox" },   // self-host only — makes `exec` available
  permissions: { canUseTool, allow: ["read"], approvalTimeoutMs: 300_000 },
});
```

```python
# Python
from diva_ai import Agent, Permissions

async def can_use_tool(tool_name: str, params: dict) -> dict:
    if tool_name == "exec" and "rm -rf" in params.get("command", ""):
        return {"behavior": "deny", "message": "destructive command blocked"}
    return {"behavior": "allow"}

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    tools=[exec_tool, weather_tool],
    permissions=Permissions(can_use_tool=can_use_tool, allow=["get_weather"]),
)
```

`allow` is a skip-list: a bare tool name there is auto-approved **without** ever calling the
callback. Only meaningful alongside `canUseTool`/`can_use_tool`.

### Python vs TypeScript — real divergences

- **`mode` / `deny` scope differs entirely.** TS: these govern the **engine's** built-in tools and
  are *self-host only* — they throw `DivaNotImplementedError` on the **hosted** client. Python:
  `diva_ai` is a thin client with **no engine built-ins at all, ever** — a syntactically valid
  `mode`, or any non-empty `deny`, **always** raises `DivaNotImplementedError` at `Agent.__init__`,
  regardless of which gateway you point at (self-hosting the gateway does not unlock it).
  ```
  permissions.mode/deny target ENGINE built-ins, which the thin/hosted client does not expose.
  Use can_use_tool (+ allow) to gate your own client tools.
  ```
- **Deny `message` surfacing is flipped.** Python `can_use_tool`'s `{"behavior": "deny", "message": ...}`
  **is** surfaced to the model verbatim (`tool '<name>' blocked: <message>`). TS's `canUseTool`
  deny `message` is accepted but **not yet surfaced** — the engine blocks with a generic
  `"Denied by user"`.
- **`updatedInput`/`editedInput` on allow is accepted but never applied in either SDK** — the tool
  always runs with its original input. Deny and let the model retry instead of trying to sanitize.
- **No abort signal in Python.** TS's callback gets `ctx: { signal: AbortSignal }` that aborts when
  the turn settles. Python's `can_use_tool(tool_name, params)` takes only two positional args —
  nothing cancels a slow callback; `approval_timeout_ms` is bounds-checked but not wired to a
  deadline anywhere.
- **Fail-closed contract:** a callback must return a `dict`/object with `"behavior": "allow"` —
  `None`, a bare string, or any other shape is treated as **not-allow** in both SDKs.

## `guard.*` — declarative sugar over hooks

| Guard | Effect | Fires when |
| --- | --- | --- |
| `guard.output` | hard abort | final reply matches a blocklist term (TS also: exceeds `maxChars`) |
| `guard.custom` | hard abort (or replace in Python) | your predicate trips |
| `guard.input` | hard abort | outgoing message matches (TS: arbitrary `when` predicate) |
| `guard.tool` | soft block | a tool's input matches |
| `guard.toolOutput` / `guard.tool_output` | soft block, hides output | a tool's output matches |
| `guard.approval` | soft block, awaits human | **TS only** — see below |

```ts
// TypeScript
import { Agent, DivaGuardTripped, guard } from "@diva-ai/sdk";

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  guards: [
    guard.output({ maxChars: 500, blocklist: ["password", "secret key"] }),
    guard.tool("refund", { when: (i) => (i as { amount: number }).amount > 100 }),
  ],
});
```

```python
# Python — blocklist-only (str substring or compiled re.Pattern), no maxChars/when predicate
from diva_ai import Agent, DivaGuardTripped, guard
import re

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    guards=[
        guard.output("password", "secret key"),
        guard.tool(re.compile(r"rm\s+-rf")),          # matches json.dumps(input) for any tool
        guard.tool("4212", tool="get_balance"),        # scoped to one tool
    ],
)
```

### More Python vs TypeScript divergences (guards)

- **No `guard.approval` in Python.** TS ships synchronous HITL tool approval
  (`guard.approval(name, { approve })`). Python doesn't have it — use `permissions.can_use_tool`
  for HITL today (await your human inside the callback).
- **Match surface differs.** TS `guard.tool({ when })` takes an arbitrary predicate over the input.
  Python `guard.tool(*terms, tool=None)` is blocklist-only: it JSON-serializes the *entire* input
  and does a substring/regex `.search()`. `guard.tool_output` matches `str(output)` — a different
  (unserialized) surface, so a rule ported between the two needs re-checking.
  TS's `guard.output` supports `maxChars`; Python's does not — use `guard.custom` for a length cap.
- **Empty-guard validation differs.** TS throws `DivaError` for an empty `guard.output({})` or a
  `guard.input` with no `when`. Python's zero-term `guard.output()`/`guard.tool()` silently never
  trips — no construction-time error.
- **`guard.custom` contract differs.** TS: `fn(reply) => string | null` (return a reason to trip).
  Python: `predicate(event_dict) => {"block": "..."} | {"replace": "..."} | None` — a bare string
  return does **not** trip in Python, since the outcome is passed straight through.
- **Not-yet-wired TS options fail loud:** `guard.tool({ requireApprovalOver })` and
  `guard.input({ noPii })` both throw `DivaNotImplementedError` — neither exists in Python's API at
  all (not even as a rejected keyword).

## Gotchas

- Tool-hook guards (`guard.tool`, `guard.toolOutput`, `guard.approval`) and `permissions` both
  require the agent to **own its host** in TS — passing them alongside a shared `client` throws at
  construction. Python has no shared-client concept, so this never applies there.
- Soft blocks (`guard.tool`, `before_tool_call`) never reach your `catch`/`except` — they become a
  tool result the model sees. Pair with a reply guard (`guard.output`/`guard.custom`) for a
  caller-visible hard stop.
- `deny` (where it works) uses **engine tool names** (`exec`, `write`, `read`), not Claude's
  (`Bash`, `Write`, `Read`) — a Claude-shaped name is caught at construction with a hint.

Full docs: https://front.dev.diva-ai.ru/ux/sdk-docs

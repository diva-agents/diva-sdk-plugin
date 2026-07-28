# Permissions

The interactive per-call approval gate for the model's tool calls. `permissions.can_use_tool`
is a callback that runs **client-side, in your own process** — the SDK calls it with the tool's
real name and structured input before the tool executes, and fails closed on anything but an
explicit allow. It is Diva Python's counterpart to the Claude Agent SDK's `canUseTool` and the
TypeScript `@diva-ai/sdk`'s `permissions.canUseTool`.

> **What actually works today.** `diva-ai` is a **thin client**: it only speaks the gateway's
> wire protocol and never runs the agent engine itself. `can_use_tool` and `allow` gate **your
> own client `tool()`s** and work today. `mode` and `deny` target the **engine's** built-in tools
> (`exec`/`read`/`write`/…) — a concept the engine-hosting TypeScript SDK exposes but this thin
> client does not. Setting either **always fails at `Agent()` construction**: an invalid `mode`
> value raises `DivaError` from `validate_permissions`, and a *valid* `mode` (or any non-empty
> `deny`) still raises `DivaNotImplementedError` — never a silent no-op.

## When to use

- Put a human (or a content policy) in front of *every* client tool call the model makes, with
  `can_use_tool` — it inspects the real, structured tool arguments and blocks anything you don't
  approve.
- Skip the callback for specific tools you always trust, with `allow` — a tool name in `allow` is
  auto-approved without ever calling `can_use_tool`.
- Reach for `permissions` when you need a single fail-closed choke point over *every* tool the
  agent can call. For a narrower rule scoped to one tool or to the final reply,
  [`guard.*`](./guards.md) is lighter and needs no separate object.

## How it works

`Permissions` is a plain `@dataclass`; pass it as `Agent(..., permissions=Permissions(...))`. It
is validated synchronously by `validate_permissions()` inside `Agent.__init__` — a bad value
fails construction with a clean `DivaError` instead of a confusing failure mid-turn.

When a client tool call comes in from the gateway (`plugin.tool.requested`), the SDK resolves it
in this order, entirely before the tool's `execute` runs:

1. **`can_use_tool` (if set and the tool name is not in `allow`).** The callback is awaited (it
   may be sync or async) with `(tool_name, params)`. Its return value is only honored if it is a
   `dict` — anything else (`None`, a bare string, a shape without `"behavior": "allow"`) is not
   treated as an allow. This is the fail-closed contract: a malformed or missing decision denies.
2. **`allow` skip-list.** A tool name present in `permissions.allow` skips `can_use_tool`
   entirely and goes straight to step 3 — it is *not* asked, not merely auto-answered.
3. **`before_tool_call` hook/guard chain** (see [Hooks](./hooks.md)) — runs whether or not
   `can_use_tool`/`allow` applied, as long as step 1/2 didn't already deny.
4. `tool.execute(...)`, with the input re-validated against the tool's pydantic `input_schema`.
5. **`after_tool_call` hook/guard chain**, then the result (or the block/deny reason) is sent
   back on `plugin.tool.result`.

A denial from `can_use_tool` is delivered to the model as tool-result content — the turn is
**not** aborted for the caller (the same "soft block" shape as a `before_tool_call` hook block;
see [Hooks — blocks: hard vs. soft](./hooks.md#blocks-hard-vs-soft)). The model sees the denial and
can adapt (apologize, try another tool, ask the user).

### The `CanUseTool` callback

```python
CanUseTool = Callable[[str, dict[str, Any]], "Awaitable[PermissionResult] | PermissionResult"]
```

- Called with `(tool_name, params)` — `params` is the tool's **full structured input**, the same
  dict `tool.execute` would receive before pydantic validation, not a lossy summary.
- May be a regular `def` or an `async def` — the SDK checks `inspect.isawaitable(...)` and awaits
  either way.
- Return `{"behavior": "allow"}` to run the tool, or `{"behavior": "deny", "message": "..."}` to
  block it. `message` is not optional in practice: it becomes the reason the model sees
  (`tool '<name>' blocked: <message>`); omit it and the model sees `(no reason given)`.

```python
from pydantic import BaseModel
from diva_ai import Agent, Permissions, tool

class ExecInput(BaseModel):
    command: str

class CityInput(BaseModel):
    city: str

async def can_use_tool(tool_name: str, params: dict) -> dict:
    if tool_name == "exec" and "rm -rf" in params.get("command", ""):
        return {"behavior": "deny", "message": "destructive command blocked"}
    return {"behavior": "allow"}

exec_tool = tool(name="exec", description="Run a shell command.",
                  input_schema=ExecInput, execute=lambda i: run_shell(i.command))
weather_tool = tool(name="get_weather", description="Get weather for a city.",
                     input_schema=CityInput, execute=lambda i: {"tempC": 20})

agent = Agent(
    "diva/gpt/gpt-4o-mini",
    instructions="You are a shell operator with a weather tool.",
    tools=[exec_tool, weather_tool],
    permissions=Permissions(
        can_use_tool=can_use_tool,
        allow=["get_weather"],  # skips can_use_tool entirely for this tool
    ),
)
```

> **A note on `PermissionResult["message"]`.** Diva Python **does** surface it to the model
> verbatim (`tool '<name>' blocked: <message>`) — unlike the TypeScript SDK, which currently
> blocks with a generic `"Denied by user"` and holds the callback's `message` back for a later
> increment. Write a `message` your model should actually read.

### `updatedInput` is accepted, never applied

`PermissionResult` accepts an `updatedInput` key (kept **camelCase** to match the wire shape,
unlike the rest of this snake_case API) for editing the tool's arguments on allow. It is **not
read anywhere** in the current client — the tool always runs with its original `params`, exactly
like the TypeScript SDK's documented divergence. Don't rely on it to sanitize input; deny and let
the model retry with corrected arguments instead.

## Example

Mirrors `examples/permissions_hooks_guards.py`:

```python
"""Control surface: can_use_tool gate, lifecycle hooks, and guards."""
import asyncio
from pydantic import BaseModel
from diva_ai import Agent, DivaGuardTripped, Hooks, Permissions, guard, tool

class CityInput(BaseModel):
    city: str

async def main() -> None:
    async def can_use_tool(name, args):
        return (
            {"behavior": "deny", "message": "blocked by policy"}
            if name == "danger"
            else {"behavior": "allow"}
        )

    weather = tool(
        name="get_weather",
        description="Get weather.",
        input_schema=CityInput,
        execute=lambda i: {"tempC": 20},
    )
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="Use get_weather.",
        tools=[weather],
        permissions=Permissions(can_use_tool=can_use_tool),
        hooks=Hooks(agent_end=lambda ev: print("[audit] reply:", ev["reply"][:40])),
        guards=[guard.output("password")],  # hard-block the reply on a match
    )
    try:
        result = await agent.run("Weather in Paris?")
        print("reply:", result.text[:60])
    except DivaGuardTripped as e:
        print("guard tripped:", e)
    await agent.close()

asyncio.run(main())
```

## API

### `Permissions`

```python
@dataclass(slots=True)
class Permissions:
    mode: PermissionMode | None = None
    allow: list[str] = field(default_factory=list)
    can_use_tool: CanUseTool | None = None
    approval_timeout_ms: int | None = None
    deny: list[str] = field(default_factory=list)
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `PermissionMode \| None` | `None` | Engine tool-policy preset. **Always raises at construction** in this thin client (see the callout above) — kept for TS parity and forward compatibility, not usable yet. |
| `allow` | `list[str]` | `[]` | Tool names auto-approved **without** calling `can_use_tool`. Only meaningful alongside `can_use_tool` — it is the skip-list. |
| `can_use_tool` | `CanUseTool \| None` | `None` | Interactive per-call approval callback over your client tools. The one knob that works today. |
| `approval_timeout_ms` | `int \| None` | `None` | Bounds-checked at construction (`0 < ms <= 600000`) but **not yet wired** to a deadline anywhere in the client — no signal is passed to `can_use_tool`, and no turn timeout is auto-extended for it. Pass a generous `timeout=` to `agent.run()`/`agent.stream()` yourself if your callback can take a while (e.g. awaiting a human). |
| `deny` | `list[str]` | `[]` | Engine tool names to strip from the model's context. **Always raises at construction** (see the callout above). |

### `PermissionMode` / `PERMISSION_MODES`

```python
PermissionMode = Literal["default", "acceptEdits", "plan", "bypassPermissions"]
PERMISSION_MODES: tuple[PermissionMode, ...] = ("default", "acceptEdits", "plan", "bypassPermissions")
```

Exported for parity with the TypeScript SDK's mode table and for `validate_permissions()` to
check against; none of the four presets currently change client behavior, because setting `mode`
at all raises before a specific value could matter.

### `CanUseTool`

```python
CanUseTool = Callable[[str, dict[str, Any]], "Awaitable[PermissionResult] | PermissionResult"]
```

Two positional arguments only — `(tool_name, params)`. Unlike the TypeScript SDK there is no
third `ctx: { signal }` argument; nothing currently cancels a slow callback.

### `PermissionResult`

```python
class PermissionResult(TypedDict, total=False):
    behavior: Literal["allow", "deny"]
    message: str
    updatedInput: dict[str, Any]
```

`behavior` is documented as required (the gate treats anything without an explicit
`{"behavior": "allow", ...}` as not-allow), though `total=False` means the type checker won't
enforce it — always set it explicitly.

### `validate_permissions(permissions: Permissions) -> None`

Runs inside `Agent.__init__`. Raises `DivaError` on the first problem:

| Condition | Error message (verbatim, `…` interpolated) |
| --- | --- |
| Unknown `mode` | `permissions.mode must be one of default, acceptEdits, plan, bypassPermissions (got …).` |
| `approval_timeout_ms` not a positive number | `permissions.approval_timeout_ms must be a positive number of ms (got …); 0 or negative would deny every gated tool instantly.` |
| `approval_timeout_ms > 600000` | `permissions.approval_timeout_ms must not exceed 600000ms (the engine's hard cap).` |
| `deny` entry not a `str` | `permissions.deny entries must be strings (engine tool names).` |
| Scoped `deny` rule (contains `(`) | `permissions.deny scoped rule '…' is not supported yet — use a bare tool name.` |
| Claude-name `deny` | `permissions.deny uses ENGINE tool names, not Claude's: '…' → did you mean '…'?` |

Then, back in `Agent.__init__`, a syntactically valid `mode` or a non-empty `deny` still raises
`DivaNotImplementedError`:

```
permissions.mode/deny target ENGINE built-ins, which the thin/hosted client does not expose.
Use can_use_tool (+ allow) to gate your own client tools.
```

`MAX_APPROVAL_TIMEOUT_MS = 600_000` is exported alongside the above for the bound check.

## Notes & caveats

- **Only `can_use_tool` + `allow` work.** `mode` and `deny` are present on `Permissions` for
  wire/TS parity but always fail construction — see the callout above.
- **Fail-closed on a malformed decision.** A `can_use_tool` callback must return a `dict`;
  `None` or any other shape is not honored as `{"behavior": "allow"}`.
- **`message` IS surfaced to the model**, unlike the TypeScript SDK's current divergence — a
  deny reason reaches the model verbatim.
- **`updatedInput` is accepted but never applied** — the tool always runs with its original
  arguments.
- **No abort signal, no enforced timeout.** `approval_timeout_ms` is validated but not wired to
  anything; a slow `can_use_tool` callback blocks the tool call for as long as it takes (bounded
  only by whatever `timeout=` you pass to `run()`/`stream()`, or the gateway's own request
  timeout).
- **This client has no engine built-in tools at all.** There is no `builtinTools` option and no
  `exec`/`read`/`write` concept in `diva_ai` — everything gated by `permissions` is a client
  `tool()` you defined (or an MCP-bridged tool).

## See also

- [Hooks](./hooks.md) — `before_tool_call`/`after_tool_call`, the lower-level chain
  `can_use_tool` sits in front of.
- [Guards](./guards.md) — `guard.tool`/`guard.tool_output` for a lighter, declarative rule
  scoped to one tool.
- [Tools & toolsets](./tools.md) — defining the client `tool()`s that `can_use_tool` and guards
  act on.
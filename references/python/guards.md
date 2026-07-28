# Guards

`guard.*` are small builder functions that return a `Hooks` object (see [Hooks](./hooks.md))
preconfigured with one tripwire. They're sugar over hooks: instead of writing a
`Hooks(final_reply_guard=...)` handler by hand, `guard.output("password")` builds one for you.
Pass any number of them as `Agent(..., guards=[...])`; they merge with your own `hooks=` and with
each other into the same per-hook-name chains `compose_hooks` builds.

## Guards are not the security gate

This is the most important thing to understand before using guards:

> **Guards gate *your own* client `tool()`s** — the ones you pass via `tools=`/`toolsets=`. They
> are client-side and input-inspecting. `diva_ai` has no concept of engine built-in tools at all
> (no `exec`/`read`/`write`, no `builtinTools`) for guards to reach even if they wanted to —
> everything a guard can act on is code you wrote. For a fail-closed, single choke point over
> *every* client tool call, use [`permissions.can_use_tool`](./permissions.md) instead.

Rule of thumb: **`guard.tool`/`guard.tool_output` for your own tools' business rules,
`can_use_tool` for a hard, universal gate.** Every guard here is *blocklist-style* (a literal
substring or a compiled regex) or a raw predicate (`guard.custom`) — none of them enforce
anything by construction; they're best-effort convenience, not a security boundary.

## How guards work

Every `guard.*` call returns a `Hooks` instance directly — there is no separate opaque `Guard`
type in the Python SDK. Because it's a plain `Hooks`, `compose_hooks` merges it with everything
else the same way; see [Hooks — chain composition](./hooks.md#chain-composition) for the exact
order (`hooks=` first, then `guards=[...]` in list order, then a `flow=`'s slot-filling hooks
last).

A tripped guard raises `DivaGuardTripped`:

```python
class DivaGuardTripped(DivaError):
    def __init__(self, guard: str, reason: str) -> None:
        ...
        self.detail = {"guard": guard, "reason": reason}
```

For the reply/input guards (`guard.output`, `guard.input`, `guard.custom`), `detail["guard"]` is
the **hook slot name** (`"final_reply_guard"` or `"before_agent_start"`) — not the guard's own
`name=`. The guard's own `name` (default `"output-guard"`, `"input-guard"`, `"custom-guard"`) is
instead baked into `detail["reason"]`, e.g. `"output-guard: reply matched 'password'"`. See
[Hooks](./hooks.md) for the full explanation.

### Hard abort vs. soft block

- **`guard.output` / `guard.input` / `guard.custom` compile to turn-level hooks**
  (`final_reply_guard` / `before_agent_start`) → a trip **hard-aborts the turn**:
  `DivaGuardTripped` propagates out of `agent.run()`/the `done` step of `agent.stream()`. In
  `stream()` it acts on the final text only — deltas already yielded can't be recalled.
- **`guard.tool` / `guard.tool_output` compile to tool-level hooks** (`before_tool_call` /
  `after_tool_call`) → a **soft block**: the tool doesn't run (or its output is withheld), and
  the model is told via tool-result content, but the block never reaches your `except` — the
  turn continues. Pair with a reply guard for a caller-visible stop.

### There is no `guard.approval` yet

The TypeScript SDK has a `guard.approval(name, { approve })` builder for synchronous
human-in-the-loop tool approval. **Python doesn't have it yet.** For
human-in-the-loop today, gate the tool with
[`permissions.can_use_tool`](./permissions.md), which the module's own docstring calls "the
working, valuable layer" for an interactive per-call decision — await your human/UI/Slack inside
the callback:

```python
async def can_use_tool(tool_name: str, params: dict) -> dict:
    if tool_name != "refund":
        return {"behavior": "allow"}
    approved = await ask_human(params)  # your UI/Slack/CLI approval
    return (
        {"behavior": "allow"}
        if approved
        else {"behavior": "deny", "message": "not approved by a human"}
    )
```

## Guard kinds at a glance

| Guard | Hook | Trip effect | Fires when |
| --- | --- | --- | --- |
| `guard.output` | `final_reply_guard` | hard abort | final reply text matches a term |
| `guard.input` | `before_agent_start` | hard abort | outgoing message matches a term |
| `guard.tool` | `before_tool_call` | soft block | a (optionally named) tool's JSON-serialized input matches a term |
| `guard.tool_output` | `after_tool_call` | soft block (hides output) | a (optionally named) tool's output matches a term |
| `guard.custom` | `final_reply_guard` | hard abort (or replace) | your predicate over the full reply event returns a block/replace outcome |

Every builder's positional `*terms` accept the same `BlockTerm`: a `str` (case-insensitive
substring match) or a compiled `re.Pattern` (matched with `.search()` against the raw,
non-lowercased text — use `re.compile(r"\d{3}-\d{2}-\d{4}")` for an SSN *shape*, since a literal
string can't match a value).

### `guard.output`

Reject a final reply that matches any of `terms` (hard abort).

```python
def output(self, *terms: str | re.Pattern[str], name: str = "output-guard") -> Hooks
```

```python
from diva_ai import guard
import re

g = guard.output("password", "secret key")
g2 = guard.output(re.compile(r"\bSSN\b", re.I))
```

- Trip reason: `f"{name}: reply matched {hit!r}"`, where `hit` is the matched term/pattern.
- Unlike the TypeScript SDK's `guard.output({ maxChars, blocklist })`, there is **no `maxChars`
  option** — this builder is blocklist-only. Enforce a length cap with `guard.custom` instead
  (see below).
- No empty-guard check: `guard.output()` with zero terms builds a guard whose predicate never
  matches anything — a silent no-op, unlike the TypeScript SDK, which raises `DivaError` for an
  empty `guard.output({})`.

### `guard.input`

A client-side blocklist check on the outgoing message, before the turn is sent (hard abort).

```python
def input(self, *terms: str | re.Pattern[str], name: str = "input-guard") -> Hooks
```

- Trip reason: `f"{name}: message matched {hit!r}"`.
- No `when` predicate option (unlike the TypeScript SDK's `guard.input({ when })`) — matching is
  always term-based here. For an arbitrary predicate on the message, write a raw
  `Hooks(before_agent_start=...)` handler yourself (see [Hooks](./hooks.md)).
- No `noPii` option either — the TypeScript SDK's server-side PII gateway stub doesn't exist in
  `diva_ai.guards` at all.

### `guard.tool`

Soft-block a client tool call whose input matches a term.

```python
def tool(self, *terms: str | re.Pattern[str], tool: str | None = None, name: str = "tool-guard") -> Hooks
```

```python
g = guard.tool(re.compile(r"rm\s+-rf"))                             # any tool
g = guard.tool("4212", tool="get_balance", name="balance-guard")    # scoped to one tool
```

- If `tool=` is given, the guard only inspects calls to that tool name; otherwise it inspects
  every client tool call.
- Matching runs against `json.dumps(input, default=str)` — the tool's **entire** structured input
  serialized to JSON, so a term can match any field, not one specific argument.
- Trip reason: `f"{name}: {tool_name} input matched {hit!r}"`.
- Unlike the TypeScript SDK's `guard.tool(name, { when })`, there is no arbitrary
  `when(input) -> bool` predicate and no `requireApprovalOver` threshold-routing option — this is
  blocklist matching only.

### `guard.tool_output`

Soft-block (withhold) a client tool's **output** when it matches a term. The side effect already
happened; this only hides the result from the model.

```python
def tool_output(self, *terms: str | re.Pattern[str], tool: str | None = None, name: str = "tool-output-guard") -> Hooks
```

- Matching runs against `str(output)` — note the asymmetry with `guard.tool`, which
  JSON-serializes the input; here the output is stringified as-is.
- Trip reason: `f"{name}: {tool_name} output matched {hit!r}"`.
- To *redact/rewrite* rather than withhold, write a raw `Hooks(after_tool_call=...)` handler
  returning `{"replace": ...}` instead.

### `guard.custom`

Run your own predicate over the final reply event (hard abort or replace).

```python
def custom(self, predicate: Callable[[dict[str, Any]], Any], *, name: str = "custom-guard") -> Hooks
```

Unlike the TypeScript SDK's `guard.custom(fn)`, where `fn` receives just the reply and returns a
bare reason string (or `None`), the Python `predicate` receives the **full event dict**
`{"text": str, "run_id": str | None}` and must return a full hook outcome — `None`,
`{"block": "<reason>"}`, or `{"replace": "<new text>"}` — since the compiled handler returns
`predicate(ev)` unmodified:

```python
def no_links(ev: dict) -> dict | None:
    return {"block": "insecure link in reply"} if "http://" in ev["text"] else None

guard.custom(no_links)

# Enforcing a length cap (guard.output has no maxChars):
def max_chars(limit: int):
    def check(ev: dict) -> dict | None:
        text = ev["text"]
        return {"block": f"reply exceeds {limit} chars ({len(text)})"} if len(text) > limit else None
    return check

guard.custom(max_chars(500))
```

- A predicate that raises is **not** a trip — it surfaces as `DivaHookError`, same as any other
  hook. Return a `{"block": ...}` dict to trip.

## Example

Mirrors `examples/permissions_hooks_guards.py`:

```python
import asyncio
from diva_ai import Agent, DivaGuardTripped, guard

async def main() -> None:
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="Answer briefly.",
        guards=[
            guard.output("password", "secret key"),          # hard abort on a blocked term
            guard.custom(
                lambda ev: {"block": "insecure link in reply"} if "http://" in ev["text"] else None
            ),
        ],
    )
    try:
        result = await agent.run("Give me a one-line tip for strong passwords.")
        print("reply:", result.text)
    except DivaGuardTripped as e:
        print(f"guard tripped: {e.detail['guard']} — {e.detail['reason']}")
    await agent.close()

asyncio.run(main())
```

## API

### `guard`

A singleton namespace (`guard = _Guard()`); each method returns a `Hooks` you drop into
`Agent(guards=[...])`.

| Method | Signature | Trip |
| --- | --- | --- |
| `guard.output` | `(*terms, name="output-guard") -> Hooks` | hard abort |
| `guard.input` | `(*terms, name="input-guard") -> Hooks` | hard abort |
| `guard.tool` | `(*terms, tool=None, name="tool-guard") -> Hooks` | soft block |
| `guard.tool_output` | `(*terms, tool=None, name="tool-output-guard") -> Hooks` | soft block (hides output) |
| `guard.custom` | `(predicate, *, name="custom-guard") -> Hooks` | hard abort (or replace), per your predicate |

### `BlockTerm`

```python
BlockTerm = "str | re.Pattern[str]"
```

Documentation-only — like `HookOutcome` in `hooks.py`, this is a plain string constant, not an
importable/enforced type alias. It documents what every `*terms` argument accepts: a
case-insensitive substring (`str`) or a compiled regex (`re.Pattern`, matched via `.search()`).

### No `Guard` type

Unlike the TypeScript SDK's `type Guard = CompiledHooks`, `diva_ai.guards` doesn't export a
`Guard` alias — `guard.*` builders return `Hooks` directly, and `Agent(guards=...)` is typed
`list[Hooks] | None`.

## Notes & caveats

- **Not a security boundary.** Guards are client-side blocklist matching (or your own
  `guard.custom` predicate) over your own tools and text. For a fail-closed, auditable gate, use
  [`permissions.can_use_tool`](./permissions.md).
- **No `guard.approval`.** Human-in-the-loop tool approval isn't ported yet; use
  `permissions.can_use_tool` today (see above).
- **No empty-guard validation.** `guard.output()` / `guard.input()` / `guard.tool()` /
  `guard.tool_output()` called with zero terms silently never trips — unlike the TypeScript SDK,
  which raises `DivaError` for an empty guard.
- **`guard.tool` matches the whole serialized input; `guard.tool_output` matches the stringified
  output.** Different match surfaces — check both if you're porting a rule from one to the other.
- **A raise in `guard.custom`'s predicate is a `DivaHookError`, not a trip.** Return
  `{"block": "<reason>"}` to trip; anything else (including a bare string) does not block, since
  the return value is passed straight through as the hook outcome.
- **`detail["guard"]` on a tripped reply/input guard is the hook slot name**, not your guard's
  `name=` — see [Hooks](./hooks.md) for why, and where to find the guard's own name.
- **Composition order.** `Agent(hooks=..., guards=[g1, g2])` runs `hooks=` first, then `g1`, then
  `g2`, per hook name — see [Hooks](./hooks.md#chain-composition).

## See also

- [Permissions](./permissions.md) — `can_use_tool`, the real fail-closed gate; also the current
  path for HITL tool approval.
- [Hooks](./hooks.md) — the `Hooks` object every guard compiles to, and the chain-composition
  rules.
- [Tools & toolsets](./tools.md) — defining the client `tool()`s that `guard.tool`/
  `guard.tool_output` act on.
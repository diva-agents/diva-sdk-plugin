# Hooks

Lifecycle hooks let you intercept an agent's turn **in your own process** — observe it, rewrite
the values flowing through it, or block it. You pass a `Hooks` object to `Agent(..., hooks=...)`;
each field fires at a defined point in the turn and returns a `HookOutcome` that tells the SDK
whether to continue, substitute a value, or reject.

Hooks are the low-level primitive. [Guards](./guards.md) are sugar on top of the same
machinery (blocklist/predicate tripwires), and both compile into the same per-hook-name chains
via `compose_hooks`.

## When to use

- **Redact / rewrite** a client tool's input or output, or the final reply (PII scrubbing,
  normalization).
- **Block** a turn or a client tool call on a policy decision (content rules, human-in-the-loop
  approval).
- **Observe** the turn for logging, audit, or metrics (`agent_end`, and the read side of every
  other hook).

For declarative blocklist rules, prefer [Guards](./guards.md) — they're less code for the common
case. To gate a client tool with a fail-closed interactive callback, use
[`permissions.can_use_tool`](./permissions.md) — it runs *before* `before_tool_call` in the same
gate order.

## How it works

`diva_ai` enforces exactly six hook points, all client-side, in its own process — the same six
the TypeScript SDK calls "wired":

| Hook | Fires | Event dict | Can do |
| --- | --- | --- | --- |
| `before_agent_start` | before a turn is sent | `{"message", "provider", "model"}` | Observe the outgoing message; `replace` (str) rewrites it; `block` aborts the turn. |
| `before_tool_call` | before a client tool's `execute` runs | `{"tool", "input"}` | Observe a tool call's input; `replace` rewrites it (re-validated by the tool's pydantic schema at execute time); `block` prevents the tool from running (**soft** — see below). |
| `after_tool_call` | after a client tool's `execute` returns | `{"tool", "input", "output"}` | Observe the output (side effect already happened); `replace` redacts/rewrites it; `block` only hides the result from the model. |
| `before_reply` | on the reply text | `{"text", "run_id"}` | Observe; `replace` (str) rewrites it; `block` rejects the turn. |
| `final_reply_guard` | on the reply text, **after** `before_reply` | `{"text", "run_id"}` | Last gate on the reply; `replace` (str) / `block`. |
| `agent_end` | after the reply is produced | `{"message", "reply", "run_id"}` | Observational only — cannot block or replace. Fires even when a reply guard blocked, so audit sees blocked turns. |

`Hooks` is a `@dataclass(slots=True)` with exactly these six optional fields — there is no field,
and no runtime fallback, for the other ~15 RFC hook names the TypeScript SDK declares as
"not wired yet" (host-internal: model calls, compaction, sessions, subagents, channels, flow).
Passing one of those as a keyword argument to `Hooks(...)` is a plain Python
`TypeError: unexpected keyword argument`, not a `DivaNotImplementedError` — the dataclass rejects
it structurally, before any SDK code runs.

### Blocks: hard vs. soft

- **Turn-level blocks are hard.** A `block` from `before_agent_start`, `before_reply`, or
  `final_reply_guard` raises `DivaGuardTripped` out of `run()`/`stream()`/`generate()`.
- **Tool-call blocks are soft.** A `before_tool_call` block runs inside the client-tool dispatch
  path, so it cannot raise to you or abort the turn. The tool does not run, and the block reason
  is delivered to the model as ordinary tool-result content
  (`"tool '<name>' blocked: <reason>"`), which the model then adapts to. An `after_tool_call`
  block cannot undo a side effect that already happened — it only hides the result
  (`"tool '<name>' output withheld: <reason>"`) from the model.
- **A `before_tool_call` replace is re-validated indirectly.** The (possibly replaced) input
  flows straight into `tool.input_schema.model_validate(...)` right before `execute` runs — a
  replace that doesn't fit the tool's pydantic schema fails there, and that failure is caught and
  surfaced as ordinary tool-result error content (`"tool '<name>' failed: <exc>"`), **not** as a
  `DivaHookError` the way the TypeScript SDK's zod re-validation raises.

### Chain composition

`Agent(hooks=..., guards=[...], flow=...)` merges everything into one `Hooks` per turn via:

```python
compose_hooks(hooks, *(guards or []), flow_hooks)
```

Per hook name, the handlers run **in that order**: your own `hooks=` first, then each entry of
`guards=[...]` in list order, then any slot-filling hooks a `flow=` contributes. A handler's
outcome:

- `{"block": "<reason>"}` — the chain stops immediately and the block wins.
- `{"replace": <value>}` — the value threads forward to the *next* handler in the same pass (for
  message/reply/tool-input event dicts, the relevant key — `text`, `message`, or `input` — is
  updated before the next handler runs).
- anything else (including `None`) — the current value is unchanged; the chain continues.

Unlike the TypeScript SDK, Python's chain is a **single left-to-right pass** — there is no bound
on "replace passes" because there is nothing to re-run: no handler is re-invoked, and there is no
interactive `once`-marked handler concept (Python's `guard.*` has no HITL-approval builder yet;
see [Guards](./guards.md)).

### Where hooks fire in a turn

```
run() / stream() / generate()
  └─ before_agent_start        (rewrite the outgoing message)
       └─ [ per client tool call: before_tool_call → tool.execute → after_tool_call ]
            └─ before_reply    (rewrite the reply)
                 └─ final_reply_guard   (last gate)
                      └─ agent_end      (observe; fires even if a reply guard blocked)
```

In `stream()`, reply hooks apply to the final `DoneChunk.text` only — **not** to the `DeltaChunk`s
already yielded, which streamed the raw text as it arrived. A block at the `done` step raises
`DivaGuardTripped` out of the async generator but cannot un-deliver deltas already yielded.

`generate()` is a thin wrapper around `run()`: it calls `Agent.run()` once with the
schema-augmented prompt, and — only on a validation failure — again with a repair prompt, in a
disjoint `generate:<uuid>` session. **Every hook fires on each underlying `run()` call**,
observing the JSON-schema-augmented text, not the bare user message. A guard trip on either
attempt propagates immediately as `DivaGuardTripped`; it is not treated as a validation failure
and is not retried.

## Example

Adapted from the TypeScript guide's banking-assistant example:

```python
import asyncio
from pydantic import BaseModel
from diva_ai import Agent, DivaGuardTripped, Hooks, tool

class BalanceInput(BaseModel):
    user_id: str

get_balance = tool(
    name="get_balance",
    description="Return the account balance for a user id.",
    input_schema=BalanceInput,
    execute=lambda i: {"userId": i.user_id, "balance": 4212},
)

def before_agent_start(ev):
    print("[hook] turn starting:", ev["message"])
    # return {"replace": ev["message"].strip()}    # rewrite (must be a str)

def before_tool_call(ev):
    print("[hook] tool call:", ev["tool"], ev["input"])
    # return {"block": "balances are restricted"}   # SOFT — the model is told, the turn continues

def after_tool_call(ev):
    out = dict(ev["output"])
    out["balance"] = "***"
    return {"replace": out}   # redact before the model sees it

def final_reply_guard(ev):
    return {"block": "reply too long"} if len(ev["text"]) > 2000 else None

def agent_end(ev):
    print("[hook] done:", ev["reply"])

async def main() -> None:
    agent = Agent(
        "diva/gpt/gpt-4o-mini",
        instructions="You are a terse banking assistant. Use tools for balances.",
        tools=[get_balance],
        hooks=Hooks(
            before_agent_start=before_agent_start,
            before_tool_call=before_tool_call,
            after_tool_call=after_tool_call,
            final_reply_guard=final_reply_guard,
            agent_end=agent_end,
        ),
    )
    try:
        result = await agent.run("What's the balance for user u_42?")
        print("reply:", result.text)
    except DivaGuardTripped as e:
        # detail["guard"] is the HOOK SLOT name here ("final_reply_guard"), not a guard's own
        # name — see the caveat below.
        print("guard tripped:", e.detail["guard"], "-", e.detail["reason"])
    await agent.close()

asyncio.run(main())
```

### Human-in-the-loop in a `before_tool_call` hook

`before_tool_call`'s event dict is only `{"tool", "input"}` — there is no abort signal to race
(unlike the TypeScript SDK's `AbortSignal`). An `await`-based approval simply blocks until it
resolves:

```python
async def before_tool_call(ev):
    if ev["tool"] != "refund":
        return None
    approved = await ask_human(ev["input"])  # your UI/Slack/CLI approval
    return None if approved else {"block": "refund not approved by a human"}
```

If a bounded HITL gate is what you need — one that can also *deny outright* rather than merely
block a single tool call softly — [`permissions.can_use_tool`](./permissions.md) runs earlier in
the same dispatch and is the better fit; see its guide for the pattern.

## API

### `Hooks`

Passed as `Agent(..., hooks=...)`. Every field is optional.

```python
@dataclass(slots=True)
class Hooks:
    before_agent_start: HookFn | None = None
    before_tool_call: HookFn | None = None
    after_tool_call: HookFn | None = None
    before_reply: HookFn | None = None
    final_reply_guard: HookFn | None = None
    agent_end: HookFn | None = None
```

### `HookFn` / `HookOutcome`

```python
HookFn = Callable[[dict[str, Any]], "Awaitable[Any] | Any"]
```

A hook may be a sync `def` or an `async def` — the SDK checks `inspect.isawaitable(...)` and
awaits when needed. It receives the event dict and returns one of:

| Outcome (Python value) | Meaning |
| --- | --- |
| `None` (or any non-`dict`) | Continue — the value is unchanged. |
| `{"block": "<reason>"}` | Reject. Raises `DivaGuardTripped` (turn-level) or surfaces to the model (tool-level). |
| `{"replace": <value>}` | Substitute. For message/reply slots it **must** be a `str`, else `DivaHookError`. For a tool input/output it passes through as-is (a tool-input replace is validated indirectly at execute time — see above). |

`HookOutcome` is exported as the literal string `"dict[str, Any] | None"` — purely documentation,
not an importable/enforced type. Use the table above as the real contract.

### Event dict shapes

| Hook | Event dict | Notes |
| --- | --- | --- |
| `before_agent_start` | `{"message": str, "provider": str, "model": str}` | `replace` (str) rewrites `message`. |
| `before_tool_call` | `{"tool": str, "input": Any}` | No abort signal — see caveats. |
| `after_tool_call` | `{"tool": str, "input": Any, "output": Any}` | `input` is the (possibly replaced) effective input. |
| `before_reply` / `final_reply_guard` | `{"text": str, "run_id": str \| None}` | Shared shape for both hooks. |
| `agent_end` | `{"message": str, "reply": str, "run_id": str \| None}` | `message` is the (possibly rewritten) outgoing message; `reply` is the final text. |

### Module functions

These are mostly internal plumbing `Agent`/`DivaClient` call for you; you'll rarely reach for
them directly except `compose_hooks`, if you're pre-composing reusable hook bundles the way
`guard.*` does.

| Function | Signature | Used for |
| --- | --- | --- |
| `compose_hooks` | `(*hooks: Hooks \| None) -> Hooks` | Merge N `Hooks` objects into one, chained per name, in argument order (`None` entries skipped). |
| `apply_value_hook` | `(fn, ev, current, guard_name) -> str` | Run one already-composed message/reply hook; raises `DivaGuardTripped(guard_name, reason)` on block, `DivaHookError` on a non-str replace, else returns `current`. |
| `run_observer` | `(fn, ev) -> None` | Run `agent_end`; wraps any raise into `DivaHookError`. |
| `has_tool_hooks` | `(hooks) -> bool` | `True` if `before_tool_call`/`after_tool_call` is set. Defined but currently unused by `Agent` — see caveats. |
| `run_before_tool_hook` | `(fn, tool_name, tool_input) -> tuple[Any, str \| None]` | Applies `before_tool_call`; `(effective_input, None)` to proceed or `(None, block_reason)` to withhold. |
| `run_after_tool_hook` | `(fn, tool_name, tool_input, output) -> tuple[Any, str \| None]` | Applies `after_tool_call`; `(effective_output, None)` or `(None, hide_reason)`. |

## Notes & caveats

- **Chain composition order.** `Agent(hooks=..., guards=[...])` composes as
  `compose_hooks(hooks, *guards, flow_hooks)` — your own `hooks=` handlers run first, then each
  `guards=[...]` entry in list order, then any slot-filling hooks from a `flow=` you passed.
  Per name, all of them merge into a single chain.
- **No 8-pass reconvergence bound, no `once`.** Unlike the TypeScript SDK, Python's chain is a
  single left-to-right pass through the composed handlers per hook name — a `replace` threads its
  value to the next handler in the *same* pass, but earlier handlers are never re-run.
- **`DivaGuardTripped.detail["guard"]` is the hook SLOT name**, not a guard's own name/label —
  `"before_agent_start"`, `"before_reply"`, or `"final_reply_guard"`. A `guard.*` builder's own
  `name=` (default e.g. `"output-guard"`) shows up inside `detail["reason"]` instead, because
  it's baked into the block-reason string. See the example above.
- **No abort signal anywhere.** `before_tool_call` events carry only `{"tool", "input"}` — there
  is no `signal`/deadline passed to the hook, and nothing currently cancels a hook that awaits
  forever (e.g. a human approval). Bound your own hook logic if that matters.
- **Tool hooks and a shared client.** The TypeScript SDK forbids `before_tool_call`/
  `after_tool_call` together with an explicit shared `client`. `diva_ai.Agent` has no shared-
  `client` constructor option at all yet, so this restriction is currently moot — every `Agent`
  owns its own connection (`has_tool_hooks` is defined for this check but not called anywhere
  today).
- **Hook errors are loud.** An `agent_end` handler that raises is wrapped and re-raised as
  `DivaHookError`. A message/reply `replace` that is not a `str` also raises `DivaHookError`.
- **Soft vs. hard blocks matter.** A `before_tool_call`/`after_tool_call` block never reaches
  your `try`/`except` around `agent.run(...)` — it becomes tool-result content the model sees.
  For a hard, caller-visible stop on tool behavior, pair it with a reply guard, or gate the tool
  with [`permissions.can_use_tool`](./permissions.md).
- **`generate()` runs hooks up to twice** — once per underlying `run()` call (initial attempt +
  at most one JSON-repair retry) — on the schema-augmented prompt text, not the bare user message.

## See also

- [Permissions](./permissions.md) — `can_use_tool`, the fail-closed gate that runs before
  `before_tool_call` for the tools it covers.
- [Guards](./guards.md) — declarative builders that compile to these same `Hooks` objects.
- [Tools & toolsets](./tools.md) — the client `tool()`s that tool hooks wrap.
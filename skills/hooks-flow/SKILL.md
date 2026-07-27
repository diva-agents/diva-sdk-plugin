---
name: hooks-flow
description: Use when intercepting an agent turn with lifecycle hooks (observe/rewrite/block before_agent_start, before_tool_call, after_tool_call, before_reply, final_reply_guard, agent_end) or when building a slot-filling flow() funnel that hard-blocks a terminal action until required info is collected — in the Diva SDK, Python or TypeScript.
---

# Hooks & Flow

Two related primitives. **Hooks** are the low-level interception point every other
control-surface feature (guards, flow) compiles down to. **Flow** is a declarative
slot-filling funnel built as a compiled `Hooks` object.

## Hooks

Intercept a turn **in your own process**: observe it, rewrite a value, or block it. Six hook
names are wired in both SDKs (everything else the RFC defines is host-internal and not runnable
client-side):

| Hook | Fires | Outcome |
| --- | --- | --- |
| `before_agent_start` | before the turn is sent | observe/`replace` the outgoing message (str) / `block` (hard abort) |
| `before_tool_call` | before a client tool executes | observe/`replace` its input / `block` (**soft** — see below) |
| `after_tool_call` | after a client tool returns | observe/`replace` its output / `block` hides it from the model (soft) |
| `before_reply` | on the reply text | observe/`replace` (str) / `block` (hard abort) |
| `final_reply_guard` | after `before_reply`, last gate | same as above |
| `agent_end` | after the reply | observational only — cannot block or replace; fires even on a blocked turn |

```ts
// TypeScript
import { Agent, DivaGuardTripped } from "@diva-ai/sdk";

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  tools: [getBalance],
  hooks: {
    before_tool_call: (e) => console.log("[hook] tool call:", e.tool, e.input),
    after_tool_call: (e) => ({ replace: { ...(e.output as object), balance: "***" } }),
    final_reply_guard: (e) => (e.text.length > 2000 ? { block: "reply too long" } : undefined),
  },
});
```

```python
# Python
from diva_ai import Agent, DivaGuardTripped, Hooks

def after_tool_call(ev):
    out = dict(ev["output"]); out["balance"] = "***"
    return {"replace": out}

def final_reply_guard(ev):
    return {"block": "reply too long"} if len(ev["text"]) > 2000 else None

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    tools=[get_balance],
    hooks=Hooks(after_tool_call=after_tool_call, final_reply_guard=final_reply_guard),
)
```

### Hard vs soft blocks (same in both languages)

- **Turn-level blocks are hard**: `before_agent_start` / `before_reply` / `final_reply_guard`
  throw/raise `DivaGuardTripped` straight out of `run()`/`stream()`/`generate()`.
- **Tool-call blocks are soft**: `before_tool_call`/`after_tool_call` run behind the tool
  dispatch — a block never reaches your `catch`/`except`; it's delivered to the *model* as
  tool-result content, and the model adapts. `after_tool_call` can't undo a side effect that
  already ran, only hide the result.

### Python vs TypeScript — real divergences

- **Chain composition differs structurally.** TS: `hooks` + `guards` compose into a chain that
  can **re-run up to 8 `replace` passes** (bounded — a non-converging chain throws
  `DivaHookError`), and interactive handlers can be marked `once` so they don't re-fire on a
  re-run. Python: `compose_hooks(hooks, *guards, flow_hooks)` is a **single left-to-right pass** —
  no reconvergence bound because nothing is ever re-run, and there is no `once` concept at all
  (Python has no HITL-approval guard to need one).
- **Unwired hook names fail differently.** TS: the other ~15 RFC hook names (`before_model_call`,
  `subagent_spawning`, `flow_slot_filled`, …) throw `DivaNotImplementedError` if you bypass the
  types and pass one. Python: `Hooks` is a `@dataclass(slots=True)` with **exactly six fields** —
  passing any other name is a plain `TypeError: unexpected keyword argument`, not a
  `DivaNotImplementedError`; the dataclass rejects it structurally before any SDK code runs.
- **`before_tool_call` abort signal is TS-only.** TS's `BeforeToolCallEvent` carries a `signal`
  that fires at the tool's execute deadline — race it in an `await`-based approval so a late
  decision cancels instead of running the tool. Python's event dict is only `{"tool", "input"}` —
  no signal, nothing cancels a hook that awaits forever; bound your own logic.
- **`DivaGuardTripped.detail["guard"]` identity differs.** Python: for reply/input guards this is
  always the **hook slot name** (`"final_reply_guard"`, `"before_agent_start"`) — a `guard.*`
  builder's own `name=` is folded into `detail["reason"]` instead. TS: a guard can set `label` to
  control its own identity in `detail.guard`.
- **Tool-input `replace` re-validation differs.** TS: a `before_tool_call` `replace` that fails
  the tool's zod schema throws `DivaHookError` directly. Python: the replaced input flows into
  `input_schema.model_validate(...)` at execute time — a failure there is caught and surfaced as
  ordinary tool-result **error content** (`"tool '<name>' failed: <exc>"`), not a `DivaHookError`.
- **Owning the host.** TS: declaring `before_tool_call`/`after_tool_call` (or `guard.tool`/
  `guard.toolOutput`) together with an explicit shared `client` throws at construction. Python has
  no shared-`client` construct at all — every `Agent` owns its own connection, so this never
  applies.

## Flow

A **slot-filling funnel**: `flow(name)` + a chained builder that hard-blocks a terminal
action/tool until required facts are collected. It compiles to a `Hooks` object under the hood —
same chain, same composition rules as above. Not a control-flow graph — it gates completion, it
never forces the model's tool choice.

```ts
// TypeScript
import { Agent, flow } from "@diva-ai/sdk";

const orderFunnel = flow("order")
  .slot("address", { label: "delivery address", ask: "Where should we deliver?",
                     tools: ["set_address"], fillWhen: { toolCalled: ["set_address"] } })
  .completion("create_order", { requires: ["address"] })
  .narrationGuard(["order placed"])
  .build();

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  tools: [setAddress, createOrder],
  flow: orderFunnel, // create_order is blocked until set_address fills `address`
});
```

```python
# Python
from diva_ai import Agent, flow

order_funnel = (
    flow("order")
    .slot("address", label="delivery address", ask="Where should we deliver?",
          tools=["set_address"], fill_when={"tool_called": ["set_address"]})
    .completion("create_order", requires=["address"])
    .build()
)

agent = Agent("diva/gpt/gpt-4o-mini", tools=[set_address_tool, create_order_tool], flow=order_funnel)
```

`FlowBuilder` surface (same shape, snake_case in Python): `.slot(fillWhen/fill_when)`,
`.gate(requirePrior/require_prior, whenArg/when_arg, blockReason/block_reason, maxBlocks/max_blocks)`,
`.injection`, `.rule`, `.narrationGuard`/`.narration_guard`, `.completion(requires)`,
`.finalized`, `.build()`. `build()` validates structurally in both (`DivaError` on: no slots, a
duplicate slot name, no `completion()`, an unknown slot in `requires`, or a gate with neither
`requirePrior`/`whenArg`).

### Python vs TypeScript — real divergences

- **The Python bundled interpreter enforces less than it compiles.** `.injection()`,
  `.narration_guard()`, and `.finalized()` are accepted by the Python builder and compiled
  correctly into `Flow.frame` (the frame is byte-identical to the platform's flow grammar — same
  as TS), **but the bundled `FlowInterpreter` only enforces `slots`, `gates`, `completion`, and
  `rules`.** Don't rely on per-tool text injection, narration guarding, or finalized-result
  detection actually happening in Python until you verify whatever interpreter/endpoint you
  target implements them. TS's client-side interpreter enforces the full builder surface,
  including narration guarding against a model that falsely claims completion.
- **Gate coverage differs by architecture, not by design.** TS: the gate is complete only in
  specific modes — the thin/hosted client (every tool is a client tool) or self-host with the
  `diva-flow` plugin. Python: the gate is **unconditionally complete**, because `diva_ai` has no
  engine-side tool surface at all — every tool the model can call is a client tool the SDK's hook
  chain already intercepts.
- **"Owns its host" applies only to TS.** TS: passing `flow` alongside an explicit shared `client`
  throws `DivaError` (a shared client's engine session can't receive a per-agent frame). Python
  has no shared-client construct, so `flow=` never conflicts with anything at construction.
- **Guidance delivery mechanism differs.** Python's interpreter surfaces unmet-slot `ask` hints
  and `rule` text by *replacing* the outgoing user message at `before_agent_start` every turn. The
  TS guide describes injections appending text *after* a specific tool result — a different
  delivery point (only relevant if you lean on `.injection()` in Python, which — per above — the
  local interpreter doesn't act on anyway).
- **`gate` `maxBlocks`/`max_blocks` range differs.** TS clamps to **1..10** (default 2). Python
  accepts any positive integer, unclamped (default 2).

## Gotchas

- `tools` on a slot and `ask` are **guidance, not guarantees** — only `fillWhen`/`fill_when` (via
  `completion`/`gate`) is enforced. `tools` is explicitly **not an ACL**; use
  [Permissions](../guards-permissions/SKILL.md) to actually restrict tool access.
- In `stream()`, reply hooks (and a flow's reply-side effects) act on the final `done` text only —
  deltas already streamed can't be recalled.
- `generate()` runs every hook up to twice (initial attempt + one JSON-repair retry) on the
  schema-augmented prompt text, not the bare user message, in both SDKs.

Full docs: https://front.dev.diva-ai.ru/ux/sdk-docs

# Flow

A flow is a **slot-filling funnel**: a declarative frame that hard-blocks a
terminal tool until the conversation has collected the required information.
Build one with `flow(name)` and its chained `FlowBuilder`, then attach the
compiled `Flow` to an `Agent` via the `flow=` argument.

`diva_ai` is a thin client — there is no self-hosted engine (see
[Overview](./overview.md)) — so the gate always runs the same way: **client-side**,
inside your own process, via the SDK's hook system (`FlowInterpreter`). Every
tool the model can call through this SDK is a client tool — there is no
engine-side built-in-tool surface at all (see
[Code execution & built-in tools](./code-execution.md)) — so the gate is
complete: nothing the model calls can slip past it.

A flow is dialogue management, **not** a control-flow step graph. It separates
the **guarantee** (a terminal tool is hard-blocked until its slots are filled)
from **guidance** (soft prompt hints); it never narrows or forces the model's
tool choice.

## When to use

- **Use** when a conversation must gather specific facts before a
  consequence — collect the delivery address before `create_order`, verify
  identity before `issue_refund`.
- **Use** when you need this guarantee enforced **outside the model's own
  discretion** — a model that "forgets" cannot bypass a filled-slot gate,
  because the gate runs as a hook around every client tool call, not as a
  prompt instruction.
- **Avoid** for free-form chat with no required-information invariant.
- **Avoid** modeling branching business logic as a graph here; a flow gates
  completion, it does not sequence steps.

## How it works

You describe the funnel with a `FlowBuilder`:

- **Slots** are the facts to collect. A slot becomes *filled* by exactly one
  source (`fill_when`): a truthy dotted path in a tool result, any of a set of
  tools succeeding, or all of a set succeeding this session.
- **Completion** names the terminal tool and which slots must be filled before
  it is allowed. This is the hard block.
- **Gates** add per-tool preconditions (require prior tools, or block on an
  argument value), each returning a reason so the model self-corrects.
- **Rules** are free-text guidance lines, surfaced together with any unmet
  slot `ask` hints at the start of every turn.

The builder also accepts `.injection(...)`, `.narration_guard(...)`, and
`.finalized(...)` — they compile correctly into the emitted `FlowFrame` (the
same platform-grammar JSON the TS SDK emits), but **the bundled
`FlowInterpreter` does not act on them**; it only enforces `slots`, `gates`,
`completion`, and `rules`. See [Notes & caveats](#notes--caveats) below before
relying on them.

`.build()` structurally validates the frame and returns a `Flow` — a `name`
plus a `FlowFrame` dict (snake_case keys, `None` values dropped). Because the
emitted JSON matches the platform's flow grammar byte-for-byte, the same frame
could later be POSTed verbatim to the platform's `/v1/flows` endpoint for
server-side enforcement of the full grammar (including the parts the local
interpreter doesn't execute).

When you attach `flow=` to an `Agent`, its interpreter is compiled to a
`Hooks` object and composed alongside any `hooks=`/`guards=` you also pass —
the same hook chain every other hook-based feature in this SDK uses.

## Example

### Order funnel

Collect the delivery `address`, then allow the terminal `create_order`. The
model cannot finalize until `set_address` fills the slot — enforced by the
flow gate running client-side as a `before_tool_call` hook.

```python
# Run:  DIVA_API_KEY=sk-diva-... python examples/flow_example.py
import asyncio

from pydantic import BaseModel

from diva_ai import Agent, flow, tool


class SetAddressInput(BaseModel):
    address: str


class CreateOrderInput(BaseModel):
    pass


def set_address(inp: SetAddressInput) -> dict:
    return {"saved": inp.address}


def create_order(_: CreateOrderInput) -> dict:
    return {"orderId": "A-1001"}


set_address_tool = tool(
    name="set_address",
    description="Save the customer's delivery address.",
    input_schema=SetAddressInput,
    execute=set_address,
)

create_order_tool = tool(
    name="create_order",
    description="Place the order. Only valid once the address is known.",
    input_schema=CreateOrderInput,
    execute=create_order,
)

# A funnel: collect `address`, then allow the terminal `create_order`.
order_funnel = (
    flow("order")
    .slot(
        "address",
        label="delivery address",
        ask="Where should we deliver?",
        tools=["set_address"],
        fill_when={"tool_called": ["set_address"]},
    )
    .completion("create_order", requires=["address"])
    .build()
)


async def main() -> None:
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="You take customer orders. Be brief.",
        tools=[set_address_tool, create_order_tool],
        flow=order_funnel,  # enforced client-side by the flow gate
    )

    try:
        # create_order is blocked by the flow gate until set_address fills
        # the `address` slot.
        result = await agent.run("I'd like to order. Deliver to 5 Main St.")
        print(result.text)
    finally:
        await agent.close()


asyncio.run(main())
```

### Multi-slot funnel with gates

Exercises the fuller builder surface: two slots and a `gate` that blocks a
tool until prior tools have succeeded, plus a value-conditioned gate and a
rule. `.injection`, `.finalized`, and `.narration_guard` are included here to
show the full builder API — they compile into `refund_funnel.frame`, but (per
[Notes & caveats](#notes--caveats)) the bundled interpreter does not currently
act on them.

```python
from diva_ai import flow

refund_funnel = (
    flow("refund")
    .slot(
        "order",
        label="order id",
        ask="What's the order number?",
        fill_when={"result_path": "lookup_order.orderId"},
    )
    .slot(
        "identity",
        label="verified identity",
        required=True,
        fill_when={"tools_all": ["verify_email", "verify_zip"]},
    )
    # Don't let the model issue a refund before the order is looked up and identity verified.
    .gate(
        "issue_refund",
        require_prior=["lookup_order", "verify_email", "verify_zip"],
        block_reason="Look up the order and verify the customer before issuing a refund.",
        max_blocks=3,
    )
    # Block a high-value refund path unless the reason is an approved code.
    .gate(
        "approve_large_refund",
        when_arg={"field": "reason", "operator": "not_in", "values": ["defective", "not_delivered"]},
        block_reason="Large refunds are only auto-approved for defective / not-delivered orders.",
    )
    .injection("lookup_order", "Order details:", from_result=["order", "status"])
    .rule("Never promise a refund timeline you cannot guarantee.")
    .completion("issue_refund", requires=["order", "identity"])
    .finalized(tool="issue_refund", result_path="refundId")
    .narration_guard(["refund issued", "money back"])
    .build()
)
```

## API

### `flow(name)`

```python
def flow(name: str) -> FlowBuilder
```

Start a builder. `name` is stripped; an empty name raises `DivaError` —
`"flow: a non-empty name is required."`.

### `FlowBuilder`

Chain the methods below, then `.build()`. Every mutator returns `self`.

| Method | Signature | Description |
| --- | --- | --- |
| `.slot` | `slot(name: str, *, fill_when: dict, label: str \| None = None, required: bool = True, ask: str \| None = None, tools: list[str] \| None = None) -> FlowBuilder` | Declare a slot to collect. See [`fill_when`](#fill_when). |
| `.gate` | `gate(tool: str, *, block_reason: str, require_prior: list[str] \| None = None, when_arg: dict \| None = None, max_blocks: int = 2) -> FlowBuilder` | Add a per-tool precondition. See [`GateOptions`](#gateoptions). |
| `.injection` | `injection(tool: str, append: str, *, from_result: list[str] \| None = None) -> FlowBuilder` | Compiles an `injections` entry into the frame. **Not read by the bundled interpreter** — see caveats. |
| `.rule` | `rule(text: str) -> FlowBuilder` | Add a free-text guidance line, surfaced at the start of every turn. |
| `.narration_guard` | `narration_guard(claim_patterns: list[str]) -> FlowBuilder` | Compiles a `narration_guard` entry into the frame. **Not read by the bundled interpreter** — see caveats. |
| `.completion` | `completion(action: str, *, requires: list[str] \| None = None) -> FlowBuilder` | **Required.** The terminal tool the completion invariant gates. `requires` lists the slots that must be filled first; omitting it means **all required slots**. |
| `.finalized` | `finalized(*, tool: str \| None = None, result_path: str \| None = None) -> FlowBuilder` | Compiles a `finalized` entry into the frame. **Not read by the bundled interpreter** — see caveats. |
| `.build` | `build() -> Flow` | Validate and compile. See below. |

**`.build()` validation** — raises `DivaError` if:

- there are **no slots** (`"at least one slot is required"`);
- two slots share a `name` (`"duplicate slot name '<name>'"`);
- no `completion(action)` was set (`"a completion(action) is required"`);
- `completion(requires=...)` references an unknown slot;
- a `gate` has neither `require_prior` nor `when_arg` (each gate needs at
  least one).

### `fill_when`

The `fill_when=` argument to `.slot(...)` is a plain `dict` — exactly one of
these three shapes (a Python stand-in for the TS discriminated union):

| Key | Value type | Meaning |
| --- | --- | --- |
| `result_path` | `str` | A truthy value at this dotted path over a tool result fills the slot. |
| `tool_called` | `list[str]` | Any of the listed tools succeeding fills the slot. |
| `tools_all` | `list[str]` | **All** listed tools succeeding this session fills the slot. |

`.build()` raises `DivaError` — `"slot fill_when must be one of: result_path,
tool_called, tools_all."` — if none of the three keys is present.

### `GateOptions`

Keyword arguments to `.gate(...)`:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `require_prior` | `list[str] \| None` | `None` | Block the gated tool until **all** these tools have succeeded this session. |
| `when_arg` | `dict \| None` | `None` | `{"field": str, "operator": "in" \| "not_in" \| "eq" \| "ne", "values": list[str]}`. Block when the gated tool's own argument at `field` matches the condition against `values`. |
| `block_reason` | `str` | — (required) | The reason returned to the model when blocked, so it self-corrects. |
| `max_blocks` | `int` | `2` | Anti-livelock: stop blocking after N consecutive blocks. Unlike the TS SDK, the Python builder does not clamp this to a fixed range — pass any positive integer. |

A gate must specify at least one of `require_prior` / `when_arg` (enforced at
`build()`).

### `FlowFrame`

`FlowFrame = dict[str, Any]` — the compiled, platform-compatible frame
(snake_case keys, `None` values excluded):

```python
{
    "slots": [...],
    "completion": {...},
    "finalized": {...} | None,
    "narration_guard": {...} | None,
    "rules": [...] | None,
    "gates": [...] | None,
    "injections": [...] | None,
}
```

You normally do not construct this directly — `build()` emits it. It is
exposed on `Flow.frame` so you can inspect or serialize the compiled frame.

### `Flow`

```python
@dataclass(frozen=True, slots=True)
class Flow:
    name: str
    frame: FlowFrame
```

The SDK-level flow name plus the platform frame. Pass the whole `Flow` to an
`Agent`'s `flow=` argument.

## Agent option

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `flow` | `Flow \| None` | `None` | The compiled funnel. Compiles to a `Hooks` object (`FlowInterpreter(flow).hooks()`) composed alongside `hooks=`/`guards=`. Gates tools until required slots are filled and injects `ask`/`rule` guidance at the start of every turn by rewriting the outgoing user message. |

## Notes & caveats

- **No "owns its host" restriction.** The TS SDK's `flow` option bakes a frame
  into the agent's engine host config, so an agent with `flow` there cannot
  also share an explicit `client`. `diva_ai`'s `Agent` has no equivalent
  shared-`client` construct — each `Agent` always manages its own connection —
  so `flow=` never conflicts with anything at construction time.
- **The gate is complete because there is no other tool surface.** In the TS
  SDK the flow gate is complete only in specific modes (thin client, or
  self-hosted with the `diva-flow` plugin). In `diva_ai` it is complete
  unconditionally: every tool the model can call is a client tool this SDK's
  hook chain intercepts, because this SDK has no engine-side built-in tools at
  all (see [Code execution & built-in tools](./code-execution.md)).
- **Only `slots`, `gates`, `completion`, and `rules` are enforced.**
  `.injection()`, `.finalized()`, and `.narration_guard()` are accepted by the
  builder and compiled correctly into `Flow.frame` — the frame really is
  byte-compatible with the platform's flow grammar, so it could be POSTed to a
  platform `/v1/flows` endpoint for full server-side enforcement — but the
  bundled `FlowInterpreter` (what actually runs when you pass `flow=` to
  `Agent`) does not read those three keys. Don't rely on per-tool text
  injection, narration guarding, or finalized-result detection happening
  automatically until you verify whatever interpreter or endpoint you target
  implements them.
- **Guidance timing differs from "inject after a tool runs."** The
  interpreter surfaces unmet-slot `ask` hints and `rule` text by *replacing*
  the outgoing user message at the start of every turn (`before_agent_start`),
  not by appending text after a specific tool result the way `.injection()`
  describes.
- **Slot hints are guidance, not guarantees.** `ask` and a slot's `tools` list
  are informational only; only `fill_when` (via `completion`/`gate`) is
  enforced. `tools` is not an ACL — use `Permissions` /
  `can_use_tool` (see [Tools & toolsets](./tools.md)) to restrict tool access.
- **Anti-livelock is built in.** A gate stops blocking after `max_blocks`
  consecutive blocks (default `2`) so a confused model can't be trapped
  forever.
- **The frame is platform-grammar-compatible.** `build()` emits snake_case,
  `None`-excluded JSON matching the platform's schema.

## See also

- [Tools & toolsets](./tools.md) — the tools a flow gates and references by name.
- [External MCP servers](./mcp.md) — MCP-bridged tools are client tools too, and are gated by a flow the same way.
- [Code execution & built-in tools](./code-execution.md) — why this SDK has no engine-side tool surface, and what that means for a flow's gate coverage.
- [Overview](./overview.md) — the thin-client architecture behind these guarantees.
# Sub-agents

A sub-agent is a specialized `Agent` (see [Quickstart](./quickstart.md)) that a parent agent
can delegate to. `handoff()` turns a sub-agent into a client tool — named `transfer_to_<name>`
— that the parent model calls when a task matches the sub-agent's role. There is no graph or
orchestration DSL: a sub-agent is a normal `Agent` you construct and own, and delegation is
"just a typed tool transfer."

## When to use

- **Use** to route a distinct sub-task to a focused agent — a lead qualifier, a code reviewer,
  a translator — with its own `instructions`, model, and tools.
- **Use** when you want the sub-agent's work to run in an **isolated session** so the parent
  conversation stays uncluttered.
- **Avoid** for tasks the parent can do inline; each handoff pays a full sub-agent turn (a
  fresh gateway connection plus a full model turn).
- **Avoid** wiring handoffs into cycles (A → B → A) — see the backstop in
  [Notes & caveats](#notes--caveats).

## How it works

`handoff(sub_agent, *, name, description, ...)` returns a `ToolDefinition`. Pass it in the
parent's `tools`. When the parent model calls `transfer_to_<name>`, the tool:

1. Validates the tool input against a pydantic schema and renders it into a single **message
   string** (the default schema has one field, `message: str`; a custom `input_schema`
   requires a `render` function).
2. Runs **one turn** of the sub-agent with that message — `await sub_agent.run(message)`, with
   no `session_id`, so it always starts a fresh session.
3. Returns the sub-agent's reply **text** (`result.text`) as the tool result the parent sees.

Each handoff is an **independent, stateless sub-agent turn**. The sub-agent does not remember
earlier handoffs within the same parent conversation — this is a deliberate isolated-context
design. If you need continuity across delegations, thread it yourself (e.g. include prior
context in the rendered message).

`diva-ai` is a thin client: every `run()` call — including the one a handoff makes — opens its
own WebSocket connection to the gateway and closes it when the turn ends; there is no local
host process to warm up, and no `start()` method to pre-warm one. The handoff tool's
`timeout_ms` (default 180 000 ms) is the execute ceiling for that whole round trip, so keep it
comfortably generous.

## Example

Adapted from `examples/subagents_parallel.py` (`python examples/subagents_parallel.py`, with
`DIVA_API_KEY` set): a triage agent that delegates lead-qualification to a focused sub-agent.

```python
import asyncio

from diva_ai import Agent, handoff


async def main() -> None:
    # A focused sub-agent. It is a fully independent Agent with its own turn.
    qualifier = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="You score sales leads. Reply with a one-line score and reason.",
    )

    # The parent can delegate by calling transfer_to_qualifier.
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions=(
            "You triage inbound messages. For anything about a sales lead, call "
            "transfer_to_qualifier and relay its score. Otherwise answer directly."
        ),
        tools=[
            handoff(
                qualifier,
                name="qualifier",
                description="Qualify an inbound sales lead and return a score.",
            ),
        ],
    )

    try:
        result = await agent.run("New lead: Acme Corp wants 100 seats, budget approved.")
        print(result.text)
    finally:
        # Sub-agents are independent — the parent's close() does not cascade.
        await agent.close()
        await qualifier.close()


asyncio.run(main())
```

### Structured hand-off with a custom schema

When one string isn't enough, supply an `input_schema` (a pydantic model) and a `render`
function that maps the validated input to the sub-agent's message. This avoids stuffing
everything into one opaque string.

```python
from pydantic import BaseModel

from diva_ai import Agent, handoff


class TranslateInput(BaseModel):
    text: str
    target_lang: str


translator = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="You translate text. Reply with only the translation.",
)

translate_tool = handoff(
    translator,
    name="translator",
    description="Translate a snippet into a target language.",
    input_schema=TranslateInput,
    render=lambda inp: f"Translate to {inp.target_lang}:\n{inp.text}",
    timeout_ms=120_000,
)

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="Delegate any translation request to transfer_to_translator.",
    tools=[translate_tool],
)
```

## API

### `handoff(sub_agent, *, name, description, input_schema=None, render=None, timeout_ms=180000, on_result=None)`

```python
def handoff(
    sub_agent: Agent,
    *,
    name: str,
    description: str,
    input_schema: type[BaseModel] | None = None,
    render: Callable[[Any], str] | None = None,
    timeout_ms: int = DEFAULT_HANDOFF_TIMEOUT_MS,  # 180_000
    on_result: Callable[[AgentResult], None] | None = None,
) -> ToolDefinition: ...
```

Turns a sub-agent into a `transfer_to_<name>` tool for the parent's `tools`. Raises
`DivaError` when:

- `name` (after `.strip()`) does not match `^[a-zA-Z][a-zA-Z0-9_]*$` — a letter-led identifier
  (letters, digits, `_`; **no hyphen** — the tool is exposed as `transfer_to_<name>`).
- `description` is empty (after `.strip()`).
- `input_schema` is set but `render` is `None`.

### Parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `sub_agent` | `Agent` | — (required) | The delegate. It runs with its own `instructions`, model, and tools — never the parent's. |
| `name` | `str` | — (required) | The sub-agent's role. Exposed to the parent model as a tool named `transfer_to_<name>`. Must be a letter-led identifier and unique among the parent's tools. Trimmed. |
| `description` | `str` | — (required) | When the parent should hand off — this is what the model reads to decide. Be specific (e.g. `"Qualify an inbound sales lead"`) so routing is accurate. |
| `input_schema` | `type[BaseModel] \| None` | `None` | Custom input schema for a structured hand-off. When set, `render` is **required**. The default (unset) schema has a single `message: str` field. |
| `render` | `Callable[[Any], str] \| None` | `None` | Maps the validated structured input (an instance of `input_schema`) to the sub-agent's message string. Required whenever `input_schema` is set; ignored with the default schema (which passes the input's `.message` through). |
| `timeout_ms` | `int` | `180000` (180 s) | Execute ceiling for the handoff tool, in milliseconds. A handoff runs a full sub-agent turn (its own WebSocket connect plus a model turn), so keep this generous. |
| `on_result` | `Callable[[AgentResult], None] \| None` | `None` | Observe each delegation: called **synchronously** (not awaited) with the sub-agent's **full** `AgentResult` — `text`, `reasoning`, `run_id`, `usage`, `duration_ms`, `stop_reason` — after every hand-off. The parent model only ever sees the returned `text`, so this is the side channel for an audit trail or cost accounting of sub-agent turns. A callback that raises is caught and ignored — it never breaks the delegation. |

Each hand-off runs a **distinct persona**: `handoff(sub_agent, ...)` calls `sub_agent.run()`,
so the sub-agent uses its own `instructions`, model, and tools — not the parent's.

## Notes & caveats

- **Sub-agents are independent `Agent`s.** The parent's `close()` does **not** cascade — call
  `close()` on each sub-agent yourself.
- **No pre-warming needed, but no free lunch either.** `diva-ai` never keeps a local engine
  process to boot — each `run()` (including one made by a handoff) opens a fresh gateway
  WebSocket connection for the turn. The cost of a handoff is simply "one more turn,"
  accounted for by `timeout_ms`.
- **Errors are surfaced tagged.** If the sub-agent turn fails (bad key, dead session, request
  error), the tool raises `DivaError` — `'handoff to "<name>" failed: <cause>'` — so the parent
  model sees a clear, attributed failure instead of an opaque tool error it would hallucinate
  around.
- **Concurrency backstop.** A process-wide counter caps in-flight handoffs at **64**
  (`MAX_INFLIGHT_HANDOFFS` in `diva_ai.subagents`, not re-exported from the top-level package).
  Past the cap the tool raises `DivaError` — *"handoff backstop tripped: 64 concurrent
  in-flight handoffs — check for a delegation cycle."* **Avoid wiring handoff cycles** — a
  genuine cycle grows unbounded and trips this. Normal concurrency never does.
- **Isolation is by design.** Each handoff calls `sub_agent.run(message)` with no
  `session_id`, so it always starts a brand-new session — there is no shared memory between
  handoffs. If you need the sub-agent to see prior turns, fold that context into the rendered
  message, or drive it yourself through `sub_agent.session(...)` (see
  [Sessions & memory](../README.md) in the README).

## Running sub-agents in parallel

When the parent model emits **parallel tool calls** in one turn, multiple `handoff()`
sub-agents execute **concurrently** in your process (bounded by the same 64-in-flight backstop
above) — model-driven parallelism, no extra code.

For **explicit, code-orchestrated** batches, see the dedicated page:

> **→ [Parallel agents](./parallel-agents.md)** — `parallel()`, bounded concurrency, and why
> there is no host-side sub-agent spawning in this thin client.

## See also

- [Tools & toolsets](./tools.md) — `handoff()` returns a `ToolDefinition` like any other tool.
- [Parallel agents](./parallel-agents.md) — the full concurrency surface.
- [Quickstart](./quickstart.md) — constructing and closing an `Agent`.
- The project [README](../README.md) — Permissions, Hooks & guards, Sessions & memory, and the
  full `DivaError` taxonomy.
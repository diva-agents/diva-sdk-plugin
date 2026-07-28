# Toolsets

A **toolset** is a named, reusable group of client-side [`tool()`](./tools.md)s.
Build it once as a plain value and share it across agents — the toolset way to
organize and compose related tools, mirroring how `mcp=[...]` attaches
external servers.

## When to use

- **Group related tools** — e.g. a `crm` set and an `ops` set — so an agent's
  capabilities read as a short list of domains rather than a flat pile of
  tools.
- **Reuse across agents** — a `Toolset` is an immutable value; the same set can
  be handed to several agents.
- **Skip it** for a one-off agent with a couple of tools — just pass
  `tools=[...]`.

For a single tool or ad-hoc list, use the top-level `tools` option directly
(see [Tools & toolsets](./tools.md)). Toolsets and top-level `tools` compose
together on one agent.

## How it works

`toolset(name, tools)` returns a `Toolset` — a frozen dataclass with `name` and
`tools`. Two checks run eagerly so mistakes fail loud, early:

- `name` must be non-empty after trimming, else it raises `DivaError`:
  `"toolset: a non-empty name is required."`
- Tool names must be **unique within the set**; a duplicate raises `DivaError`:
  `"toolset '<name>': duplicate tool name '<tool>' within the set."` (a
  duplicate would otherwise shadow its sibling).

The `tools` sequence is **copied into an immutable tuple**, so mutating your
original list afterwards can't smuggle a duplicate past the check.

When you attach toolsets to an agent (`Agent(model, toolsets=[crm, ops])`), the
agent flattens the top-level `tools` plus every toolset into one list at
**construction**. A name collision **across** the two — `tools`↔`tools`,
`tools`↔toolset, or toolset↔toolset — raises `DivaError` up front, naming both
offending sources, e.g.:

```
tool 'deploy' from toolset 'ops' collides with toolset 'infra' —
tool names must be unique across `tools` and all `toolsets`.
```

Order is preserved: earlier source, earlier tool first. The flattened list is
exactly what the agent offers to the model, so a collision surfaces as a clean
error before the first turn — not as a late host-side failure. Everything else
about how these tools execute is identical to [Tools & toolsets](./tools.md):
they run in your process, `execute` may be sync or async, and their input is
validated against the pydantic `input_schema` before your code runs.

Because there's no `client=` sharing feature in this SDK yet (see the "Owning
the host" section in [Core concepts](./core-concepts.md)), `toolsets` never
conflicts with anything — it composes with `tools` at construction, that's the
whole story.

## Example

Two reusable, named sets composed onto one agent.

```python
import asyncio
from pydantic import BaseModel
from diva_ai import Agent, tool, toolset

class CreateLeadInput(BaseModel):
    company: str

class DeployInput(BaseModel):
    service: str

async def create_lead(inp: CreateLeadInput) -> dict:
    return {"id": f"lead_{inp.company.lower()}", "company": inp.company}

async def deploy(inp: DeployInput) -> dict:
    return {"deployed": inp.service, "status": "ok"}

async def main() -> None:
    create_lead_tool = tool(
        name="create_lead",
        description="Create a CRM lead for a company.",
        input_schema=CreateLeadInput,
        execute=create_lead,
    )
    deploy_tool = tool(
        name="deploy",
        description="Deploy the given service to production.",
        input_schema=DeployInput,
        execute=deploy,
    )

    # Two reusable, named sets — share them across agents.
    crm = toolset("crm", [create_lead_tool])
    ops = toolset("ops", [deploy_tool])

    agent = Agent(
        "diva/gpt/gpt-4o-mini",
        instructions="Use the available tools to fulfil the request. Report what you did.",
        toolsets=[crm, ops],
    )

    try:
        result = await agent.run("Create a lead for Acme Corp.")
        print(result.text)
    finally:
        await agent.close()

asyncio.run(main())
```

### Composing toolsets ahead of the agent

`compose_toolsets()` flattens several toolsets into a single tool list
(raising loud on a cross-set collision, naming both toolsets) — useful when
you want the merged `tools` list yourself before constructing the agent:

```python
from diva_ai import Agent, compose_toolsets, toolset

crm = toolset("crm", [create_lead_tool])
ops = toolset("ops", [deploy_tool])

# One flat, collision-checked list — order preserved (crm's tools, then ops').
all_tools = compose_toolsets([crm, ops])

agent = Agent("diva/gpt/gpt-4o-mini", tools=all_tools)
```

## API

### `toolset(name, tools)`

```python
def toolset(name: str, tools: Sequence[ToolDefinition]) -> Toolset
```

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | `str` | Human-readable set name (required, trimmed). Used in collision messages. Empty → `DivaError`. |
| `tools` | `Sequence[ToolDefinition]` | The tools in this set. Copied into the toolset as a tuple. Names must be unique within the set. |

Returns a `Toolset`. Raises `DivaError` on an empty name or an intra-set
duplicate.

### `Toolset`

```python
@dataclass(frozen=True, slots=True)
class Toolset:
    name: str
    tools: tuple[ToolDefinition, ...]
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | `str` | The set's name. |
| `tools` | `tuple[ToolDefinition, ...]` | The tools in the set (an immutable copy of the input sequence). |

### `compose_toolsets(toolsets)`

```python
def compose_toolsets(toolsets: Sequence[Toolset]) -> list[ToolDefinition]
```

Flattens toolsets into one `list[ToolDefinition]`, preserving order (earlier
toolset, earlier tool first). Raises `DivaError` on a cross-set name
collision, naming both toolsets.

## Notes & caveats

- **Two levels of uniqueness.** `toolset()` catches duplicates *within* one
  set; the agent's constructor (and `compose_toolsets()`) catches duplicates
  *across* sets and against top-level `tools`. Both raise `DivaError`.
- **Immutable by construction.** `toolset()` copies the tool sequence into a
  `tuple`, so later mutation of your source list can't change what the
  toolset contains.
- **No client-sharing conflict.** Unlike the TypeScript SDK, `toolsets`
  can never conflict with a shared client — this SDK doesn't expose client
  sharing at all yet (see [Core concepts](./core-concepts.md)).
- **No behavioral difference at runtime.** Grouping is purely organizational;
  a tool inside a toolset executes exactly like a top-level `tool()`.

## See also

- [Tools & toolsets](./tools.md) — defining individual client-side tools and
  how they execute.
- [Agents](./agents.md) — the `tools` / `toolsets` constructor options.
- [Core concepts](./core-concepts.md) — the hosted-first client model.
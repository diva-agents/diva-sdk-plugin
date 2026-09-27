# Tools & toolsets

Define a tool with a pydantic input schema; the engine calls it and the SDK
executes it locally, then returns the result — the model loops until done.

```python
from pydantic import BaseModel
from diva_ai import Agent, tool

class WeatherInput(BaseModel):
    city: str

def get_weather(inp: WeatherInput):
    return {"city": inp.city, "tempC": 21, "sky": "clear"}

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="Answer weather questions by calling get_weather.",
    tools=[tool(name="get_weather", description="Get weather for a city.",
                input_schema=WeatherInput, execute=get_weather)],
)
await agent.run("What is the weather in Lisbon?")
```

`execute` may be sync or async. Group related tools with **toolsets**:

```python
from diva_ai import toolset
agent = Agent(model, toolsets=[toolset("weather", [get_weather_tool])])
```

## Display metadata

A tool name is written for the model (`get_weather`), which makes it a poor label
for a human reading the dashboard. `display=` gives the platform a better one
without changing anything the model sees:

```python
tool(
    name="check_order",
    description="Order status from the ERP",
    input_schema=OrderInput,
    execute=check_order,
    display={"label": "Check order", "icon": "📦", "category": "ERP"},
)
```

| Key | Type | Description |
| --- | --- | --- |
| `label` | `str` (optional) | Human title for the tool, e.g. `"Check order"`. |
| `icon` | `str` (optional) | An emoji, or a key the dashboard's icon set understands. |
| `category` | `str` (optional) | **Reserved.** Travels to the platform and is stored, but nothing renders it yet — it is the intended grouping key for the dashboard's tool list, e.g. `"CRM"`. |

The whole block is optional, and every key inside it is optional individually
(`ToolDisplay` is a `total=False` `TypedDict`). Omit a key and the platform falls
back to the tool's `name`/`description`; omit the block and the frame the SDK
sends is byte-identical to what it sent before `display` existed — which is what
keeps an older platform working with a newer SDK, and the reverse. Values are
trimmed, and an all-blank block is treated as no block at all.

`display` is **not** sent to the model. The model reads `name` and `description`;
naming a tool "Check order" in `display` does not make the model call it that.

> The platform reads `label` and `icon` today — those are the two the dashboard
> actually shows. Set `category` if you want the grouping to be right the day it
> lands; nothing depends on it until then.

## Approval-gated tools (`requires_approval`)

Some tools should not run because a model decided to run them. Mark one, and the
platform holds the call and asks a human first:

```python
tool(
    name="wire_money",
    description="Send a payment from the company account",
    input_schema=TransferInput,
    execute=wire_money,
    requires_approval=True,
)
```

What happens when the model calls it:

1. The call stops at the Diva proxy — **before** it reaches your process. Your
   `execute` has not been entered and will not be unless the answer is yes.
2. An approval card appears in the organisation's dashboard, naming the agent,
   the run and the tool. The operator opens the run to see the arguments.
3. **Approve** — the call is handed to your process and runs normally.
   **Deny** — the agent receives a refusal carrying the operator's reason, and the
   model continues the turn knowing it was refused.
   **No answer** — the card expires (300 s by default, set per deployment) and the
   agent receives an explicit "not approved in time".
4. Whatever happened is written into the run's trace: which tool, who decided, when.

Only the literal `True` arms the gate. `False`, `None`, `1`, `"true"` and anything
else are "not marked" — a flag that switched on for any truthy value would switch
on for a typo.

**This is a different gate from `can_use_tool` below, and they stack.** The
operator decides first, on the platform, while the call is still on the wire; your
own `can_use_tool` decides second, in your process, after the call arrives. An
approval does not skip your check. If you mark a tool here, do **not** also prompt
a human inside `can_use_tool` — that is the one way to get asked twice for the
same call.

Two limits worth knowing before you rely on it:

- **The card outlives the turn, not the other way round.** The approval window is
  the platform's (300 s by default), but your turn has its own `timeout`. If
  nobody answers before the turn times out, the turn fails on your side while the
  decision is still recorded on the platform's. Raise `timeout` if you want a
  genuinely long approval window.
- **The gate is the platform's, not the SDK's.** A deployment with the feature
  switched off passes the call straight through. The mark still travels and is
  still shown on the tool in the dashboard.

## Permissions (`can_use_tool`)

An interactive per-call gate applied client-side before a tool runs (fail-closed):

```python
from diva_ai import Permissions

async def can_use_tool(name, args):
    return {"behavior": "deny", "message": "no"} if name == "danger" else {"behavior": "allow"}

agent = Agent(model, tools=[...], permissions=Permissions(can_use_tool=can_use_tool))
```

## MCP servers

Bridge external [MCP](https://modelcontextprotocol.io) servers as client tools
named `<server>__<tool>` (needs `diva-ai[mcp]`):

```python
from diva_ai import MCP
agent = Agent(model, mcp=[MCP.stdio("filesystem", "npx",
              args=["-y", "@modelcontextprotocol/server-filesystem", "/data"])])
```
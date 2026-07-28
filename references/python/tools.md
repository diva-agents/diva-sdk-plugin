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
---
name: tools-and-toolsets
description: Use when giving a Diva SDK agent a function it can call — client-side tool() definitions, grouping them into reusable toolset()s, or debugging tool errors/timeouts/collisions/duplicate names in Python (diva-ai) or TypeScript (@diva-ai/sdk) agents.
---

# Tools & toolsets

A `tool()` runs **in your own process** — your DB, your internal API, your files —
not on the Diva platform. You define `name` / `description` / `inputSchema` (TS,
zod) or `input_schema` (Python, pydantic `BaseModel`) / `execute`; the model decides
when to call it and your `execute` runs locally and returns the result.

## When to reach for this

- The work needs your process's state, credentials, or DB handle → client `tool()`.
- The tool is a separate program or remote service speaking MCP → use the
  **mcp** skill instead (`MCP.stdio` / `MCP.http`), not a client `tool()`.
- You have more than a couple of related tools → group them with `toolset()` so
  the agent's capabilities read as named domains instead of a flat pile.

## Key API

TypeScript (`@diva-ai/sdk`):
```ts
import { Agent, tool, toolset, z } from "@diva-ai/sdk";

const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city. Call this for any weather question.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21, sky: "clear" }), // input is typed, zero casts
  // executeTimeoutMs: 120_000,  // default 60_000; raise for slow calls (ERP, handoff sub-agent)
});

const weather = toolset("weather", [getWeather]);

// Tool-bearing agents own their host — configure the implicit client via clientOptions,
// never pass a shared `client` alongside `tools`/`toolsets`.
const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "Answer weather questions by calling get_weather.",
  toolsets: [weather],
});
const { text } = await agent.run("What's the weather in Lisbon?");
await agent.close();
```

Python (`diva-ai`):
```python
from pydantic import BaseModel
from diva_ai import Agent, tool, toolset

class WeatherInput(BaseModel):
    city: str

def get_weather(inp: WeatherInput):
    return {"city": inp.city, "tempC": 21, "sky": "clear"}

weather = toolset("weather", [
    tool(name="get_weather", description="Get weather for a city.",
         input_schema=WeatherInput, execute=get_weather),
])

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="Answer weather questions by calling get_weather.",
    toolsets=[weather],
)
result = await agent.run("What is the weather in Lisbon?")
await agent.close()
```

`execute` may be sync or async in both languages. Compose several toolsets ahead
of construction with `composeToolsets([...])` (TS) / `compose_toolsets([...])`
(Python) if you want the merged, collision-checked list yourself.

## Gotchas

- **Duplicate names fail loud, at construction** — across `tools` + all
  `toolsets`, naming both colliding sources. `toolset()` itself also rejects a
  duplicate *within* one set.
- **Tools own the host (TS only).** In TypeScript, an agent with `tools` or
  `toolsets` cannot also take a shared `client` — configure the implicit client
  via `clientOptions`. Python's `diva-ai` has no shared-client construct, so
  `toolsets=` never conflicts with anything there.
- **Return values become text.** Whatever `execute` returns is coerced to a
  string for the model (TS: string passthrough or `JSON.stringify`; Python:
  similarly serialized) — the model never sees your object graph, only its
  text form.
- **Errors surface to the model, not to you.** A thrown/raised error inside
  `execute` becomes a visible tool error the model can react to; it does not
  by itself abort the turn. Raise specific errors — don't swallow them.
- **`permissions.deny` won't gate a client tool in TS** — it matches engine
  tool names, not the MCP-prefixed `diva-tools__<name>` client tools. Use a
  `guard.tool` to gate a client `tool()`.
- **Timeouts:** default per-call ceiling is 60s (TS: `executeTimeoutMs`).
  Raise it for slow backends or a tool that runs a full sub-agent turn
  (`handoff`).

Full reference: https://front.dev.diva-ai.ru/ux/sdk-docs

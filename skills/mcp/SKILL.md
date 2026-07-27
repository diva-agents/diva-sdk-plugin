---
name: mcp
description: Use when wiring an external MCP server (a separate program or remote service, e.g. @modelcontextprotocol/server-filesystem) into a Diva SDK agent — MCP.stdio()/MCP.http() setup, transport choice, secrets, or debugging duplicate/reserved server names in Python (diva-ai) or TypeScript (@diva-ai/sdk).
---

# External MCP servers

Attach an external [Model Context Protocol](https://modelcontextprotocol.io) server —
a separate local program or a remote service — so its tools join the agent, namespaced
as `<server>__<tool>`. Use `MCP.stdio(...)` for a local subprocess or `MCP.http(...)`
for a remote HTTP service.

## When to reach for this

- The tool is packaged as a command you'd normally run with `npx`/similar → `MCP.stdio`.
- The tool is a remote MCP-speaking HTTP service → `MCP.http`.
- The logic is **yours** and needs your own process's APIs/DB/files → use the
  **tools-and-toolsets** skill (`tool()`) instead; no subprocess or protocol hop needed.

## Key API

TypeScript (`@diva-ai/sdk`):
```ts
import { Agent, MCP } from "@diva-ai/sdk";

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "Prefer the filesystem tools for file questions.",
  mcp: [
    MCP.stdio("filesystem", "npx", {
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    }),
    // MCP.http("weather", "https://mcp.example.com/mcp", {
    //   headers: { Authorization: `Bearer ${process.env.WEATHER_TOKEN!}` },
    //   sse: true, // opt into legacy SSE; default transport is streamable-http
    // }),
  ],
});
const { text } = await agent.run("List the files in the current directory.");
await agent.close();
```

Python (`diva-ai[mcp]` extra required: `pip install 'diva-ai[mcp]'`):
```python
from diva_ai import Agent, MCP

agent = Agent(
    "diva/gpt/gpt-4o-mini",
    instructions="Prefer the filesystem tools for file questions.",
    mcp=[
        MCP.stdio("filesystem", "npx",
                   args=["-y", "@modelcontextprotocol/server-filesystem", "."]),
        # MCP.http("weather", "https://mcp.example.com/mcp",
        #          headers={"Authorization": f"Bearer {os.environ['WEATHER_TOKEN']}"},
        #          sse=True),
    ],
)
result = await agent.run("List the files in the current directory.")
await agent.close()
```

Server names must be letter-led identifiers (`^[a-zA-Z][a-zA-Z0-9_-]*$`) and unique;
`diva-tools` is reserved by the SDK in both languages.

## Where it runs — the one real cross-language difference

- **TypeScript**: `mcp` is attached to the agent's **engine session** on the Diva
  platform, so an agent with `mcp` **owns its host** — it cannot also take a shared
  `client` (configure the implicit client via `clientOptions` instead). Secret
  `env`/`headers` values travel to the host as `${DIVA_MCP_*}` placeholders — never
  persisted to disk, but sent over the wire.
- **Python**: `diva-ai` has no engine and no shared-client construct at all — the
  MCP connection happens entirely **in your own process**, lazily on the first
  `run()`/`stream()` and cached on the `Agent` instance until `close()`. `mcp=` never
  conflicts with anything at construction, and `env`/`headers` never leave your
  process or reach the Diva gateway.

## Gotchas

- **Trust boundary.** An external server runs with the privileges of whatever
  process launches it — a `stdio` server can do anything that local program can do
  on the machine; an `http` server sees whatever you put in `headers`. Only attach
  servers you trust; scope filesystem servers to a specific directory.
- **Duplicate/invalid names fail loud at construction** (`DivaError`), not at
  first use.
- **A name collision with an existing tool also fails loud** — an MCP server's
  tools are namespaced `<server>__<tool>`, but if that collides with another
  client tool the agent raises rather than silently shadowing it.
- Python only: **tool results are flattened to plain text**, prefixed
  `[tool error] ` when the MCP call reports `isError`.

Full reference: https://front.dev.diva-ai.ru/ux/sdk-docs

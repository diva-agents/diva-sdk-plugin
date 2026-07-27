---
description: Wire an external MCP server into a Diva agent
argument-hint: [server name] [stdio command, or http url]
---

Wire an external MCP server into an existing Diva agent in this project.
`$ARGUMENTS` may give the server name and either a stdio command or an http URL.

## 1. Locate the agent and confirm the target

Find the existing `Agent(...)` construction (same detection as `/diva:add-tool`).
If none exists, suggest `/diva:new-agent` first.

If what's being wired is actually this **plugin's own bundled platform MCP**
(the `platform` server in this plugin's `.mcp.json`, auth'd via the
`diva_api_key` plugin setting) rather than a new server for the *agent's own*
code — stop here and redirect: that MCP is already available to *you* (the
assistant) once `diva_api_key` is set; it's for operating what you build
(agents/channels/CRM/sessions), not something you attach inside agent code with
`MCP.stdio`/`MCP.http`. Use `/diva:deploy` or `/diva:debug-session` instead.

## 2. Interview (skip what's already given)

- **Server name**: must match `^[a-zA-Z][a-zA-Z0-9_-]*$` (letter-led) and must
  **not** be `diva-tools` — that name is reserved by the SDK's own loopback/client
  tool path in both languages.
- **Transport**:
  - **stdio** — a local command spawned as a subprocess, e.g.
    `npx -y @modelcontextprotocol/server-filesystem <dir>`. Ask for `command`,
    `args`, optional `env`, optional `cwd`.
  - **http** — a remote MCP service. Ask for the `http(s)://` URL, optional
    `headers` (e.g. `Authorization: Bearer …`), and whether it needs the legacy
    `sse` transport (`sse: true` / `sse=True`) instead of the streamable-http
    default.

## 3. Security gate — before writing anything

External MCP servers run with the privileges of the process that launches them
(your own process for stdio in both SDKs, or the platform's engine session for
TS's attached servers). Before wiring:

- Only attach servers the user actually trusts.
- Scope a filesystem `stdio` server to a specific directory (never the whole
  filesystem) — e.g. pass `process.cwd()` / `"."`, not `/`.
- Put secrets in `env` (stdio) / `headers` (http) — never hardcode them in the
  command/args/URL.

## 4. Write the declaration

**TypeScript**
```ts
import { Agent, MCP } from "@diva-ai/sdk";

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  mcp: [
    MCP.stdio("filesystem", "npx", { args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()] }),
    // MCP.http("weather", "https://mcp.example.com/mcp", { headers: { Authorization: `Bearer ${token}` } }),
  ],
});
```

**Python** (needs the `diva-ai[mcp]` extra: `pip install 'diva-ai[mcp]'`)
```python
from diva_ai import Agent, MCP

agent = Agent(
    "diva/gpt/gpt-4o-mini",
    mcp=[
        MCP.stdio("filesystem", "npx", args=["-y", "@modelcontextprotocol/server-filesystem", "."]),
        # MCP.http("weather", "https://mcp.example.com/mcp", headers={"Authorization": f"Bearer {token}"}),
    ],
)
```

## 5. Language-specific caveats

- **TypeScript**: `mcp` configures the agent's own engine session, so it **owns
  the host** — an explicit `client:` alongside `mcp` throws `DivaError` at
  construction; configure the implicit client via `clientOptions` instead.
  Secret `env`/`headers` values are sent to the engine as `${DIVA_MCP_*}`
  placeholders (never persisted to disk, but they do travel over the wire to
  the host).
- **Python**: no owns-host conflict — `diva_ai` has no shared-`client` construct
  at all, so `mcp=` never conflicts with anything. Connections happen entirely
  **locally**, opened lazily on the agent's first `run()`/`stream()` call and
  cached until `close()`; `env`/`headers` never leave your process or reach the
  Diva gateway.

Both SDKs bridge each server's tools as ordinary client tools namespaced
`<server>__<tool>`, and both reject a duplicate server name with `DivaError`
(`assertUniqueMcp` / `assert_unique_mcp`, which the `Agent` constructor already
calls for you).

## 6. Verify

Run the agent with a prompt that should trigger the new server's tools, confirm
they show up in the model's toolset (`<server>__<tool>` namespacing) and the
model gets a sane result back.

# External MCP servers

Attach external [Model Context Protocol](https://modelcontextprotocol.io) servers to
an agent so their tools join the agent's toolset. Declare them with `MCP.stdio(...)`
(a local program spawned over stdio) or `MCP.http(...)` (a remote server connected to
over HTTP). The SDK attaches them to the agent's engine session, connects to each, and
namespaces each server's tools under its name.

This page is about **external** MCP servers — separate programs or remote services.
For a function that runs **in your own process**, use a client-side
[`tool()`](./tools.md) instead; that path uses the SDK's own loopback MCP server and
never spawns anything.

## When to use

- **`MCP.stdio`** — a tool packaged as a local command (e.g.
  `@modelcontextprotocol/server-filesystem` via `npx`). It is spawned as a local
  subprocess and speaks MCP over its stdio.
- **`MCP.http`** — a remote MCP service reachable over HTTP. Streamable-HTTP by
  default; opt into the SSE transport with `{ sse: true }`.
- **Prefer a client-side [`tool()`](./tools.md)** when the logic is yours and needs
  your process's APIs, DB handles, or memory — no separate process required.

## How it works

`MCP.stdio` / `MCP.http` are validating constructors that return an `McpServer` value.
They don't connect to anything themselves — they describe a server. When you build an
agent with `mcp: [...]`:

1. The names are validated and checked for duplicates (`assertUniqueMcp`).
2. The SDK attaches the declared servers to the agent's engine session.
3. The agent connects to each declared server and exposes its tools to the model,
   **namespaced by the server's `name`**.

Secret fields (HTTP `headers` values, stdio `env` values) are never persisted to disk:
they're passed as `${DIVA_MCP_*}` placeholders whose real values are substituted at
request time.

### Owns its host

Like [`tools`](./tools.md), `mcp` configures the agent's own engine session, so an agent
with `mcp` **owns its host** and cannot share an explicit `client`. Passing both throws
a `DivaError` at construction:

```
Agent `mcp` servers require the agent to own its host: pass `mcp` without a shared
`client` (configure the implicit client via `clientOptions`).
```

Configure the implicit client via `clientOptions` instead.

### Security

External MCP servers run with the **privileges of the process that launches them**. A
`stdio` server is a real local process spawned with the `command`/`args`/`env`/`cwd` you
give it — it can do whatever that program can do on the machine, with the filesystem and
network access it inherits. An `http` server receives whatever you put in `headers` (e.g. a
bearer token) and returns tool results the model will act on. Only attach servers you
trust, scope filesystem servers to a specific directory (the example passes
`process.cwd()`), and keep secrets in `env`/`headers` rather than hard-coded.

## Example

Mirrors `examples/mcp.ts`. A local filesystem MCP server spawned as a subprocess, plus a
commented remote HTTP server.

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/mcp.ts
import { Agent, MCP } from "@diva-ai/sdk";

async function main(): Promise<void> {
  const agent = new Agent("diva/gpt/gpt-4o-mini", {
    instructions: "Use the available tools to answer. Prefer the filesystem tools for file questions.",
    mcp: [
      // A stdio MCP server spawned as a local subprocess.
      MCP.stdio("filesystem", "npx", {
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      }),
      // A remote HTTP MCP server (uncomment + set a real URL/token):
      // MCP.http("weather", "https://mcp.example.com/mcp", {
      //   headers: { Authorization: `Bearer ${token}` },
      // }),
    ],
  });

  try {
    const { text } = await agent.run("List the files in the current directory.");
    console.log(text);
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Remote HTTP server (SSE transport)

Streamable-HTTP is the default; pass `{ sse: true }` for the legacy SSE transport.
`headers` carry auth:

```ts
MCP.http("weather", "https://mcp.example.com/mcp", {
  headers: { Authorization: `Bearer ${process.env.WEATHER_TOKEN!}` },
  sse: true, // use the SSE transport instead of streamable-http
});
```

## API

### `MCP.stdio(name, command, opts?)`

```ts
MCP.stdio(
  name: string,
  command: string,
  opts?: { args?: string[]; env?: Record<string, string>; cwd?: string },
): McpServer
```

Declares a stdio server spawned as a local subprocess. Throws `DivaError` if `command` is empty
(`MCP.stdio(<name>): a command is required.`) or the name is invalid/reserved.

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | `string` | Unique server name; the config key and the tool namespace. Must match `^[a-zA-Z][a-zA-Z0-9_-]*$` and not be reserved. |
| `command` | `string` | The command to spawn (required, trimmed). |
| `opts.args` | `string[]` (optional) | Arguments passed to `command`. |
| `opts.env` | `Record<string, string>` (optional) | Environment for the spawned process. Values are treated as secret (never persisted to disk). |
| `opts.cwd` | `string` (optional) | Working directory for the spawned process. |

### `MCP.http(name, url, opts?)`

```ts
MCP.http(
  name: string,
  url: string,
  opts?: { headers?: Record<string, string>; sse?: boolean },
): McpServer
```

Declares a remote HTTP server. Throws `DivaError` if `url` is not an `http(s)://` URL
(`MCP.http(<name>): url must be an http(s) URL (got "<url>").`) or the name is
invalid/reserved.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Unique server name; the config key and the tool namespace. Must match `^[a-zA-Z][a-zA-Z0-9_-]*$` and not be reserved. |
| `url` | `string` | — | The server URL. Must start with `http://` or `https://`. |
| `opts.headers` | `Record<string, string>` (optional) | — | Request headers (e.g. `Authorization`). Values are treated as secret (never persisted to disk). |
| `opts.sse` | `boolean` (optional) | `false` | `true` selects the `sse` transport; otherwise `streamable-http`. |

### `McpServer`

The value returned by the constructors (and the shape of each entry in the `mcp`
option). A discriminated union on `transport`:

| Field | Type | Applies to | Description |
| --- | --- | --- | --- |
| `name` | `readonly string` | all | Unique name — the config key and how the server's tools are namespaced. |
| `transport` | `readonly "stdio" \| "streamable-http" \| "sse"` | all | Transport discriminant. `MCP.stdio` → `"stdio"`; `MCP.http` → `"streamable-http"` (or `"sse"` with `{ sse: true }`). |
| `command` | `readonly string` (optional) | stdio | The command to spawn. |
| `args` | `readonly string[]` (optional) | stdio | Arguments for `command`. |
| `env` | `Readonly<Record<string, string>>` (optional) | stdio | Environment for the spawned process. |
| `cwd` | `readonly string` (optional) | stdio | Working directory. |
| `url` | `readonly string` (optional) | http | The server URL. |
| `headers` | `Readonly<Record<string, string>>` (optional) | http | Request headers. |

### `assertUniqueMcp(servers)`

```ts
function assertUniqueMcp(servers: McpServer[]): void
```

Validates a server list, throwing `DivaError` on a duplicate name
(`duplicate MCP server name "<name>" — each server needs a unique name.`). The agent
calls this for you when you pass `mcp`; it's exported for pre-validation.

## Notes & caveats

- **Name rules.** A server name must be a letter-led identifier matching
  `^[a-zA-Z][a-zA-Z0-9_-]*$`; otherwise `MCP: name "<name>" is invalid — use a
  letter-led identifier (e.g. "filesystem").`.
- **`diva-tools` is reserved.** The SDK's own loopback tool server owns that config
  key (and its `${DIVA_TOOLS_MCP_TOKEN}` auth); using it throws
  `MCP: name "diva-tools" is reserved by the SDK — choose another.`.
- **Duplicate names fail loud** at construction via `assertUniqueMcp`.
- **`mcp` owns the host.** An agent with `mcp` can't share a `client` — use
  `clientOptions`.
- **Secrets stay in env.** `env` and `headers` values are passed as `${DIVA_MCP_*}`
  placeholders and never persisted to disk.
- **Server privileges.** External servers run with the privileges of the process that
  launches them. Trust the server, scope filesystem access, and pass secrets via
  `env`/`headers`.

## See also

- [Tools](./tools.md) — client-side `tool()`s that run in your process (the loopback path).
- [Toolsets](./toolsets.md) — group client-side tools.
- [Agents](./agents.md) — the `mcp` option and the "owns its host" rule.
- [Permissions](./permissions.md) — gating engine/MCP tools by name (`deny`) and `canUseTool`.
- [Core concepts](./core-concepts.md) — the hosted client and engine model.
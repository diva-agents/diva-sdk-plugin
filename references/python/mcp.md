# External MCP servers

Attach external [Model Context Protocol](https://modelcontextprotocol.io)
servers to an agent so their tools join the agent's toolset. Declare them with
`MCP.stdio(...)` (a local program spawned over stdio) or `MCP.http(...)` (a
remote server connected to over HTTP), then pass them to `Agent(mcp=[...])`.
Requires the `diva-ai[mcp]` extra:

```bash
pip install 'diva-ai[mcp]'
```

This page is about **external** MCP servers — separate programs or remote
services. For logic that is yours and needs your own process's APIs, DB
handles, or memory, use a plain [`tool()`](./tools.md) instead.

## When to use

- **`MCP.stdio`** — a tool packaged as a local command (e.g.
  `@modelcontextprotocol/server-filesystem` via `npx`). It is spawned as a
  local subprocess and speaks MCP over its stdio.
- **`MCP.http`** — a remote MCP service reachable over HTTP.
  Streamable-HTTP by default; opt into the SSE transport with `sse=True`.
- **Prefer a client-side [`tool()`](./tools.md)** when the logic is yours —
  no separate process or protocol round trip required.

## How it works

`MCP.stdio` / `MCP.http` are validating constructors that return an
`McpServer` dataclass. They don't connect to anything themselves — they
describe a server. When you build an `Agent` with `mcp=[...]`:

1. At **construction**, server names are validated (letter-led identifier,
   not reserved) and checked for duplicates via `assert_unique_mcp`.
2. On the **first** `agent.run()` / `agent.stream()` call, `Agent` connects to
   every declared server **locally, in your own process** (`McpConnection`),
   lists its tools, and wraps each as an ordinary client `ToolDefinition`
   named `<server>__<tool>`. A name collision with an existing tool raises
   `DivaError`.
3. Every later turn on the same `Agent` reuses the already-open connections;
   `agent.close()` tears them down.

Because connection is lazy and cached on the `Agent` instance, it is a
one-time cost per agent, not a per-turn cost.

### Runs locally — not on an engine

The TS SDK attaches declared servers to the agent's **engine session**, so an
agent with `mcp` there "owns its host" and can't share an explicit `client`.
`diva_ai` has no self-hosted engine and no shared-`client` construct at all
(see [Overview](./overview.md)) — the connection happens entirely inside your
own Python process, and `mcp=` never conflicts with anything at construction
time. There is nothing to configure a "shared client" around.

This also changes the secrecy story: in the TS SDK, `env`/`headers` values
travel to the engine as `${DIVA_MCP_*}` placeholders substituted at request
time, so they're never persisted to disk but are still sent over the wire to
the host. In `diva_ai`, `env`/`headers` never leave your process — they're
used directly to spawn the subprocess or set the HTTP client's headers
locally, and are never transmitted to the Diva gateway at all.

### Security

External MCP servers run with the **privileges of the process that launches
them** — your own Python process. A `stdio` server is a real local process
spawned with the `command`/`args`/`env`/`cwd` you give it — it can do whatever
that program can do on your machine, with the filesystem and network access
it inherits from your process. An `http` server receives whatever you put in
`headers` (e.g. a bearer token) and returns tool results the model will act
on. Only attach servers you trust, scope filesystem servers to a specific
directory, and keep secrets in `env`/`headers` rather than hard-coded.

## Example

A local filesystem MCP server spawned as a subprocess, plus a commented
remote HTTP server.

```python
# Run:  DIVA_API_KEY=sk-diva-... python examples/mcp_example.py
import asyncio

from diva_ai import Agent, MCP


async def main() -> None:
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="Use the available tools to answer. Prefer the filesystem tools for file questions.",
        mcp=[
            # A stdio MCP server spawned as a local subprocess.
            MCP.stdio(
                "filesystem",
                "npx",
                args=["-y", "@modelcontextprotocol/server-filesystem", "."],
            ),
            # A remote HTTP MCP server (uncomment + set a real URL/token):
            # MCP.http("weather", "https://mcp.example.com/mcp",
            #          headers={"Authorization": f"Bearer {token}"}),
        ],
    )

    try:
        result = await agent.run("List the files in the current directory.")
        print(result.text)
    finally:
        await agent.close()


asyncio.run(main())
```

### Remote HTTP server (SSE transport)

Streamable-HTTP is the default; pass `sse=True` for the legacy SSE transport.
`headers` carries auth:

```python
import os

from diva_ai import MCP

MCP.http(
    "weather",
    "https://mcp.example.com/mcp",
    headers={"Authorization": f"Bearer {os.environ['WEATHER_TOKEN']}"},
    sse=True,  # use the SSE transport instead of streamable-http
)
```

## API

### `MCP.stdio(name, command, *, args=None, env=None, cwd=None)`

```python
def stdio(
    self,
    name: str,
    command: str,
    *,
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> McpServer
```

Declares a stdio server spawned as a local subprocess. Raises `DivaError` if
`command` is empty (`"MCP.stdio(<name>): a command is required."`) or the
name is invalid/reserved.

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | `str` | Unique server name; the tool namespace. Must match `^[a-zA-Z][a-zA-Z0-9_-]*$` and not be reserved. |
| `command` | `str` | The command to spawn (required, stripped). |
| `args` | `list[str] \| None` | Arguments passed to `command`. |
| `env` | `dict[str, str] \| None` | Environment for the spawned process. Stays local — never sent to the gateway. |
| `cwd` | `str \| None` | Working directory for the spawned process. |

### `MCP.http(name, url, *, headers=None, sse=False)`

```python
def http(
    self,
    name: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    sse: bool = False,
) -> McpServer
```

Declares a remote HTTP server. Raises `DivaError` if `url` is not an
`http(s)://` URL (`"MCP.http(<name>): url must be an http(s) URL (got
'<url>')."`) or the name is invalid/reserved.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `str` | — | Unique server name; the tool namespace. Must match `^[a-zA-Z][a-zA-Z0-9_-]*$` and not be reserved. |
| `url` | `str` | — | The server URL. Must start with `http://` or `https://`. |
| `headers` | `dict[str, str] \| None` | `None` | Request headers (e.g. `Authorization`). Stays local — never sent to the gateway. |
| `sse` | `bool` | `False` | `True` selects the `sse` transport; otherwise `streamable-http`. |

### `McpServer`

```python
@dataclass(frozen=True, slots=True)
class McpServer:
    name: str
    transport: str  # "stdio" | "streamable-http" | "sse"
    command: str | None = None
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    cwd: str | None = None
    url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
```

The value returned by the constructors (and the shape of each entry in
`mcp=`). `transport` is `"stdio"` for `MCP.stdio`, `"streamable-http"` for
`MCP.http` (or `"sse"` with `sse=True`). The `command`/`args`/`cwd` fields
apply to stdio servers; `url`/`headers` apply to HTTP servers.

### `assert_unique_mcp(servers)`

```python
def assert_unique_mcp(servers: list[McpServer]) -> None
```

Validates a server list, raising `DivaError` on a duplicate name
(`"duplicate MCP server name '<name>' — each server needs a unique
name."`). `Agent.__init__` calls this for you when you pass `mcp=`; it's
exported for pre-validation.

## Notes & caveats

- **Name rules.** A server name must be a letter-led identifier matching
  `^[a-zA-Z][a-zA-Z0-9_-]*$`; otherwise `"MCP: name '<name>' is invalid — use
  a letter-led identifier (e.g. 'filesystem')."`.
- **`diva-tools` is reserved,** matching the TS SDK's naming, even though this
  SDK's own client tools don't route through an MCP loopback server the way
  the TS SDK's do — they use the gateway's native `plugin.tool.requested` /
  `plugin.tool.result` protocol directly (see
  [Code execution & built-in tools](./code-execution.md)). Using the name
  raises `"MCP: name 'diva-tools' is reserved by the SDK — choose
  another."`.
- **Duplicate names fail loud** at construction via `assert_unique_mcp`.
- **No "owns the host" restriction.** Unlike the TS SDK, `mcp=` never
  conflicts with a shared client — `diva_ai` has no such construct.
- **Secrets stay local.** `env` and `headers` values are used directly to
  spawn the subprocess / set request headers in your own process and are
  never transmitted to the Diva gateway.
- **Connections are cached per `Agent`.** They open lazily on the first
  `run()`/`stream()` call and stay open (reused across turns) until
  `agent.close()`.
- **Server privileges.** External servers run with the privileges of the
  process that launches them — your Python process. Trust the server, scope
  filesystem access, and pass secrets via `env`/`headers`.
- **Tool results are flattened to text.** A wrapped MCP tool's `execute`
  joins the MCP result's content blocks into one string, prefixed with
  `[tool error] ` when the MCP call reports `isError`.

## See also

- [Tools & toolsets](./tools.md) — client-side `tool()`s that run in your process.
- [Flow](./flow.md) — MCP-bridged tools are client tools too, so a flow gates them the same way.
- [Code execution & built-in tools](./code-execution.md) — why this SDK has no engine-side tool surface, and how its own client tools are actually served.
- [Overview](./overview.md) — the thin-client architecture and why the engine never runs locally.
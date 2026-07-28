# MCP (constant)

Factory helpers for declaring external MCP servers — either a `stdio` process the
host spawns or an `http` endpoint — whose tools become callable by the agent.

```ts
MCP
```

## stdio — method

```ts
stdio(name: string, command: string, opts?: { args?: string[] | undefined; env?: Record<string, string> | undefined; cwd?: string | undefined; } | undefined): McpServer
```

A stdio MCP server the host spawns (`command` + `args`). Its tools become
available to the agent.

```ts
MCP.stdio("filesystem", "npx", { args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] })
```

| param | type | required |
|---|---|---|
| `name` | `string` | yes |
| `command` | `string` | yes |
| `opts` | `{ args?: string[] \| undefined; env?: Record<string, string> \| undefined; cwd?: string \| undefined; } \| undefined` | no |

Returns: `McpServer`

## http — method

```ts
http(name: string, url: string, opts?: { headers?: Record<string, string> | undefined; sse?: boolean | undefined; } | undefined): McpServer
```

A remote HTTP MCP server (streamable-http by default; pass `{ sse: true }`
for the SSE transport). `headers` carry any auth.

```ts
MCP.http("weather", "https://mcp.example.com/mcp", { headers: { Authorization: `Bearer ${token}` } })
```

| param | type | required |
|---|---|---|
| `name` | `string` | yes |
| `url` | `string` | yes |
| `opts` | `{ headers?: Record<string, string> \| undefined; sse?: boolean \| undefined; } \| undefined` | no |

Returns: `McpServer`


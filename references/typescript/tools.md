# Tools

Client-side tools let the model call a TypeScript function that runs **in your own
process** — reaching your real APIs, databases, files, or in-memory state. You define
a tool with `tool({ name, description, inputSchema, execute })`; the SDK exposes it to
the host's agent, the model decides when to call it, and your `execute` closure runs
locally and returns a result the model reads back.

## When to use

- **Use a client-side `tool()`** when the work must run in your process — hitting an
  internal service, a DB connection you already hold, local files, or app state.
- **Use an [external MCP server](./mcp.md)** (`MCP.stdio` / `MCP.http`) when the tool
  is a separate program or a remote service that speaks MCP.
- **Group** related tools with a [`toolset`](./toolsets.md) to reuse and compose them
  across agents.

## How it works

`tool()` is just a typed constructor: it validates that `name` and `description` are
non-empty and returns a `ToolDefinition`. The interesting part is how that in-process
closure becomes callable by an agent running inside a **separate** headless host
process (see [Core concepts](./core-concepts.md)).

The SDK bridges the two with a **loopback MCP server**:

1. When you build an agent with `tools` (or `toolsets`), the client starts an
   in-process HTTP MCP server (`startToolServer`) bound to `127.0.0.1` on a random
   port, protected by a one-time bearer token. Your `execute` closures live in this
   process, so the transport **must** be HTTP over loopback — a stdio server is a
   separate process that could never reach them.
2. The host is told where to find it via env only: `DIVA_TOOLS_MCP_URL` and
   `DIVA_TOOLS_MCP_TOKEN` (the token is never written to the host's on-disk config).
   The server is registered under the reserved name **`diva-tools`**.
3. To the model, each tool is therefore namespaced as **`diva-tools__<name>`**. When
   the model calls it, the host issues an MCP `tools/call` back over loopback to your
   process.
4. The tool server validates the model's arguments against your zod `inputSchema`,
   runs your `execute` closure (bounded by a timeout), and returns the result as MCP
   text content. That result flows back to the host's agent and into the model's
   context.

`tools/list` advertises each tool's JSON Schema (converted from the zod `inputSchema`);
`tools/call` does the validate → execute → return cycle above.

### Result coercion

Your `execute` may return anything (`unknown`). The server coerces it to MCP text:

- a `string` is passed through unchanged;
- anything else is `JSON.stringify(result ?? null)` (so `undefined` becomes `null`);
- a value `JSON.stringify` can't render (a function/symbol) falls back to `String(result)`.

Return plain objects, strings, or numbers — they arrive at the model as text.

### Owns its host

Because `tools` configure the agent's own engine session (the loopback MCP server that
exposes them is wired per session), an agent with `tools` **owns its host** and cannot
share an explicit `client`. Passing both throws a `DivaError` at construction:

```
Agent tools require the agent to own its host: pass `tools` without a shared
`client` (configure the implicit client via `clientOptions`).
```

Configure the implicit client through `clientOptions` instead (see the example). The
same rule applies to `toolsets`, [`mcp`](./mcp.md), `params`, `permissions`, and the
other host-config options.

### Error behavior

Errors are **never swallowed** — a failing tool surfaces to the model as an MCP tool
error (`isError: true`), so the model can see it failed and react. How it's rendered
depends on what was thrown inside the call:

| Condition | Rendered text |
| --- | --- |
| `execute` throws (any `Error`) | `Tool error: <message>` |
| Execution exceeds the ceiling | `Tool error: tool "<name>" timed out after <ms>ms` |
| A [guard](./guards.md) trips (`DivaGuardTripped`) | `Blocked by policy (<guard>): <reason>` |
| A [hook](./hooks.md) errors (`DivaHookError`) | `Hook error (<hook>): <message>` |
| Model calls an unknown tool | `Unknown tool: <name>` |

A `before_tool_call`/`after_tool_call` block is a **soft** block: the tool did not run
and the model is told, but it can't abort the turn from behind the MCP boundary. For a
hard, caller-visible abort use a reply guard. See [Guards](./guards.md) and
[Hooks](./hooks.md).

### Timeouts and cancellation

Each call is bounded by a per-tool ceiling (`executeTimeoutMs`, default **60 000 ms**).
When it elapses, the `AbortSignal` on `ToolExecuteContext` is aborted and the call
rejects. Respect `ctx.signal` to stop work promptly — and to cancel an `execute` that
is awaiting something that never arrives (e.g. a human approval that came too late),
so its side effect doesn't fire after the turn already timed out. A tool that runs a
full sub-agent turn (see [Subagents / `handoff`](./subagents.md)) should raise
`executeTimeoutMs` above the default.

## Example

Mirrors `examples/tools.ts`. A weather tool whose `execute` runs in your process.

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/tools.ts
import { Agent, tool, z } from "@diva-ai/sdk";

const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city. Call this for any weather question.",
  inputSchema: z.object({ city: z.string() }),
  // Runs in-process — reach real APIs, DBs, files, anything.
  execute: async ({ city }) => ({ city, tempC: 21, sky: "clear" }),
});

async function main(): Promise<void> {
  // A tool-bearing agent owns its host, so configure via clientOptions (not a
  // shared `client`).
  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "Answer weather questions by calling get_weather. Be concise.",
    tools: [getWeather],
  });

  try {
    const { text } = await agent.run("What's the weather in Lisbon?");
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

### Typed input, no casts

The `execute` argument type is **inferred** from the zod `inputSchema`, so the tool
body is fully type-safe with zero casts:

```ts
const checkOrder = tool({
  name: "check_order",
  description: "Order status from the ERP.",
  inputSchema: z.object({ orderId: z.string(), includeLines: z.boolean().optional() }),
  // `input` is { orderId: string; includeLines?: boolean } — inferred.
  execute: async ({ orderId, includeLines }, ctx) => {
    const order = await erp.lookup(orderId, { signal: ctx?.signal });
    return includeLines ? order : { id: order.id, status: order.status };
  },
  // This tool talks to a slow ERP — raise the 60s ceiling.
  executeTimeoutMs: 120_000,
});
```

## API

### `tool(def)`

```ts
function tool<TSchema extends z.ZodType>(def: ToolInput<TSchema>): ToolDefinition<TSchema>
```

Validates and returns a tool definition. Throws a plain `Error` if `name` is empty
after trimming (`tool(): name is required`) or `description` is empty/whitespace
(`tool(<name>): description is required`).

### `ToolInput<TSchema>` / `ToolDefinition<TSchema>`

The argument to `tool()` (`ToolInput`) and its return value (`ToolDefinition`) share
the same shape:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Unique tool name (required, trimmed). Exposed to the model as `diva-tools__<name>`. Must be unique across all `tools` and `toolsets`. |
| `description` | `string` | — | What the tool does and when to call it (required). Sent to the model — write it for the model to read. |
| `inputSchema` | `TSchema extends z.ZodType` | — | A zod schema. Drives the static type of `execute`'s argument, runtime argument validation, and the JSON Schema advertised to the model. |
| `execute` | `(input: z.infer<TSchema>, ctx?: ToolExecuteContext) => unknown` | — | Your in-process function. May be sync or async. `input` is validated against `inputSchema` before it runs. The return value is coerced to text (see Result coercion). |
| `executeTimeoutMs` | `number` (optional) | `60000` | Per-tool execute ceiling in ms. Overrides the tool-server's 60 s default. Raise it for long-running tools (e.g. a `handoff` running a full sub-agent turn). |

### `ToolExecuteContext`

The optional 2nd argument to `execute`.

| Field | Type | Description |
| --- | --- | --- |
| `signal` | `AbortSignal` | Aborts when the tool's execute deadline (`executeTimeoutMs`, default 60 s) elapses. Respect it to stop work and to cancel an approval/await that arrived too late. |

### `toWireDefinition(def)` / `ToolWireDefinition`

```ts
function toWireDefinition(def: ToolDefinition): ToolWireDefinition
```

Converts a tool definition into the engine/model-facing wire shape. Mostly internal
(the tool server calls it for `tools/list`), but exported for advanced use.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | The tool name. |
| `description` | `string` | The tool description. |
| `parameters` | `Record<string, unknown>` | The JSON Schema derived from `inputSchema` via `z.toJSONSchema`. |

## Notes & caveats

- **Duplicate names fail loud.** A duplicate tool name (across `tools` + all
  `toolsets`) throws a `DivaError` at agent construction, naming both sources. The
  tool server also rejects duplicates on its own (`duplicate tool name "<name>" — each
  tool (and each handoff) needs a unique name.`) — a `Map` would silently keep only
  the last, leaving an unreachable tool the model still sees advertised.
- **`tools` owns the host.** An agent with `tools` (or `toolsets`) can't be passed a
  shared `client` — configure the implicit client via `clientOptions`. See
  [Agents](./agents.md).
- **Loopback + token only.** The tool server binds to `127.0.0.1` with a one-time
  bearer token and a loopback-only Host-header allowlist (defense-in-depth vs DNS
  rebinding). Request bodies over **4 MiB** are rejected before buffering.
- **`deny` won't gate your tools.** [`permissions.deny`](./permissions.md) uses engine
  tool names and never matches the MCP-prefixed `diva-tools__*` client tools — it's a
  silent no-op there. To gate a client `tool()`, use `guard.tool` (see
  [Guards](./guards.md)).
- **Return values become text.** The model never sees your object graph — only its
  coerced text form. Return exactly what you want the model to read.
- **Errors are visible, not fatal.** A thrown error becomes an `isError` tool result
  the model can react to; it does not, by itself, abort the turn.

## See also

- [Toolsets](./toolsets.md) — group and compose related tools.
- [External MCP servers](./mcp.md) — connect tools that are separate programs/services.
- [Permissions](./permissions.md) — tool policy, `canUseTool`, and why `deny` doesn't gate client tools.
- [Guards](./guards.md) & [Hooks](./hooks.md) — `before_tool_call`/`after_tool_call`, policy blocks.
- [Subagents](./subagents.md) — `handoff` tools that run a full sub-agent turn.
- [Core concepts](./core-concepts.md) — the harness-as-library host model.
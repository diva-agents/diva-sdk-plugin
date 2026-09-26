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
| `display` | `ToolDisplay` (optional) | — | Presentation metadata for the Diva dashboard — see [Display metadata](#display-metadata). Never sent to the model. |
| `requiresApproval` | `true` (optional) | — | Hold the call until an operator approves it in the Diva dashboard — see [Approval-gated tools](#approval-gated-tools). Never sent to the model. |

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
| `display` | `ToolDisplay` (optional) | The normalized display block, present only when the tool declared one. On the wire it sits inside the `function` object, alongside `name`/`description`. |
| `requiresApproval` | `true` (optional) | Present only when the tool asked for approval. On the wire it sits inside the `function` object, alongside `display`. |

## Display metadata

A tool name is written for the model (`check_order`), which makes it a poor label
for a human reading the dashboard. `display` lets you give the platform a better
one without changing anything the model sees:

```ts
const checkOrder = tool({
  name: "check_order",
  description: "Order status from the ERP",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => erp.lookup(orderId),
  display: { label: "Check order", icon: "📦", category: "ERP" },
});
```

| Field | Type | Description |
| --- | --- | --- |
| `label` | `string` (optional) | Human title for the tool, e.g. `"Check order"`. |
| `icon` | `string` (optional) | An emoji, or a key the dashboard's icon set understands. |
| `category` | `string` (optional) | **Reserved.** Travels to the platform and is stored, but nothing renders it yet — it is the intended grouping key for the dashboard's tool list, e.g. `"CRM"`. |

Everything about it is optional, and every part of it is optional individually.
Omit a field and the platform falls back to the tool's `name` and `description`;
omit the whole block and the frame the SDK sends is byte-identical to what it sent
before `display` existed — which is what keeps an older platform working with a
newer SDK (and the reverse). Values are trimmed, and an all-blank block is treated
as no block at all.

`display` is **not** sent to the model. The model reads `name` and `description`;
naming a tool "Check order" in `display` does not make the model call it that.

> The platform reads `label` and `icon` today — those are the two the dashboard
> actually shows. Set `category` if you want the grouping to be right the day it
> lands; nothing depends on it until then.

## Approval-gated tools

Some tools should not run because a model decided to run them. Mark one, and the
platform holds the call and asks a human first:

```ts
const wireMoney = tool({
  name: "wire_money",
  description: "Send a payment from the company account",
  inputSchema: z.object({ amount: z.number(), to: z.string() }),
  execute: async ({ amount, to }) => bank.transfer(amount, to),
  requiresApproval: true,
});
```

What happens when the model calls it:

1. The call stops at the Diva proxy — **before** it reaches your process. Your
   `execute` has not been entered and will not be unless the answer is yes.
2. An approval card appears in the organisation's dashboard, naming the agent,
   the run and the tool. The operator opens the run to see the arguments.
3. **Approve** — the call is handed to your process and runs normally.
   **Deny** — the agent receives a refusal carrying the operator's reason, and
   the model continues the turn knowing it was refused.
   **No answer** — the card expires (300 s by default, set per deployment) and
   the agent receives an explicit "not approved in time".
4. Whatever happened is written into the run's trace: which tool, who decided,
   when.

Only the literal `true` arms the gate. `false`, `undefined`, and anything else are
"not marked" — a flag that switched on for any truthy value would switch on for a
typo.

**This is a different gate from `permissions.canUseTool`, and they stack.** The
operator decides first, on the platform, while the call is still on the wire; your
own `canUseTool` decides second, in your process, after the call arrives. An
approval does not skip your check. If you mark a tool here, do **not** also prompt
a human inside `canUseTool` — that is the one way to get asked twice for the same
call.

Two limits worth knowing before you rely on it:

- **The card outlives the turn, not the other way round.** The approval window is
  the platform's (300 s by default), but your turn has its own timeout. If nobody
  answers before your turn times out, the turn fails on your side while the
  decision is still recorded on the platform's. Raise your turn timeout if you
  want a genuinely long approval window.
- **The gate is the platform's, not the SDK's.** A deployment with the feature
  switched off passes the call straight through. The mark still travels and is
  still shown on the tool in the dashboard.

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
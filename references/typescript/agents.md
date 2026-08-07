# Agents

`Agent` is the top-level entry point of `@diva-ai/sdk`. You construct one with a
model ref and a set of options, then call `run()`, `stream()`, or `generate()` to
take a turn. Under the hood the agent connects to the Diva engine over a typed
WebSocket RPC and drives it; the agent loop, tool routing, and compaction run in
that engine, server-side. Where it runs — the Diva platform (default) or your own
self-hosted gateway — is a deployment choice with an identical API. See
[Deployment](./deployment.md) and [Core concepts](./core-concepts.md).

Every LLM call is routed through the Diva `/v1` gateway on your `sk-diva-…` key
(env `DIVA_API_KEY`). There is no bring-your-own-provider — the model ref names a
platform-namespaced model and the turn can never escape the gateway.

## Constructing an agent

```ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You are a terse, friendly assistant.",
});
```

`new Agent(model, options?)`:

- `model` (`string`, required) — the platform model ref, e.g.
  `"diva/deepseek/deepseek-v4-flash"`. An empty/blank model throws
  `Agent: a model id is required (e.g. "diva/deepseek/deepseek-v4-flash")` at construction.
- `options` (`AgentOptions`, default `{}`) — see the table below.

The constructor validates eagerly: bad `compaction`, `thinkingDefault`, or
`permissions` values, a duplicate tool name across `tools` + `toolsets`, duplicate
MCP servers, and every owns-host conflict (below) all throw a `DivaError` at
construction rather than crashing the host on boot.

### The model ref: provider + model

A Diva model ref names the platform provider in its first segment. `splitModelRef`
splits on the **first** `/`:

| Ref | provider | model (engine-relative id) |
| --- | --- | --- |
| `"diva/deepseek/deepseek-v4-flash"` | `diva` | `deepseek/deepseek-v4-flash` |
| `"gpt-4o-mini"` (no namespace) | — | — |

The leading provider segment routes the turn through the Diva provider; the engine
addresses the model by the stripped, provider-relative id under it. Before each
turn, `resolveSelector()` re-checks the split: a ref **without** a platform
namespace (e.g. `"gpt-4o-mini"`) is rejected with a `DivaError`:

```
Agent model "gpt-4o-mini" is missing its platform namespace. Use the full
platform ref from GET /v1/models (e.g. "diva/deepseek/deepseek-v4-flash").
```

Always use the full ref from `GET /v1/models`. See
[Model configuration](./model-configuration.md).

## `AgentOptions` reference

Every field is optional. "Owns host" marks options that configure the agent's own
engine session: passing any of them **together with an explicit `client`** throws a
`DivaError` at construction (a shared client's session config can't be reconfigured
per agent). Configure the implicit client via `clientOptions` instead. Options
without the mark are pure client-side and compose with a shared `client`.

| Option | Type | Default | Owns host? | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | `string` | `DIVA_API_KEY` | — | Your `sk-diva-…` key. In the thin client this selects the platform engine; forwarded to the implicit client. To reach your own engine, pass `clientOptions.remoteHost` instead. See [Deployment](./deployment.md). |
| `instructions` | `string` | — | — | System prompt: the agent's persona / task framing. |
| `tools` | `ToolDefinition[]` | — | ✅ | Client-side tools the agent can call (built with `tool(...)`). Names must be unique across `tools` + `toolsets`; a duplicate throws at construction. See [Tools](./tools.md). |
| `toolsets` | `Toolset[]` | — | ✅ | Named groups of client-side tools (via `toolset(name, tools)`), composed alongside `tools`. See [Toolsets](./toolsets.md). |
| `mcp` | `McpServer[]` | — | ✅ | External MCP servers (`MCP.stdio` / `MCP.http`) whose tools join the agent. Duplicates rejected. See [MCP](./mcp.md). |
| `store` | `SessionStore` | — | — | Client-side conversation storage (`MemoryStore`, `FileStore`, or your own). Moves history into YOUR store instead of Diva's server-side sessions. See [Sessions & memory](./sessions-and-memory.md). |
| `params` | `Record<string, unknown>` | — | ✅ | Generation params applied to every turn, e.g. `{ maxTokens: 500, temperature: 0.2 }`. Keys mirror the platform's stream params (`maxTokens`, `temperature`, `top_p`, …); unknown keys pass through to the provider. See [Model configuration](./model-configuration.md). |
| `compaction` | `CompactionConfig` | — | ✅ | Tunes the always-on context-compaction scheme (mode, summary instructions, cheaper summary model, recent-turns to preserve). Out-of-range values throw at construction. |
| `thinkingDefault` | `ThinkingLevel` | — | ✅ | Default reasoning ("thinking") level, mapped to each provider's native reasoning control. Validated at construction. |
| `onCompaction` | `(event: CompactionEvent) => void` | — | see note | Observe-only callback fired at `phase:"before"`/`"after"` when the engine compacts this agent's history. Pure client-side, but it **cannot** be injected into a shared `client` — set it on that `DivaClient` instead, or drop the shared client. |
| `builtinTools` | `BuiltinToolsConfig` | — | ✅ | Opts into the engine's built-in tools (denied by default): sandboxed code execution, workspace file ops, web search/fetch. Without it the agent gets ONLY your `tools`/`mcp`. See [Code execution](./code-execution.md). |
| `permissions` | `Permissions` | — | ✅ | Claude-parity permission control (mode preset + deny rules) layered onto the tool policy. Bad mode / scoped rule / Claude-name deny throws at construction. See [Permissions](./permissions.md). |
| `flow` | `Flow` | — | ✅ | A slot-filling funnel built with `flow(...)`. The gate runs client-side in the thin client (every tool is a client tool → complete) or host-side via the `diva-flow` plugin when self-hosted, gating tools until required slots are filled. See [Flow](./flow.md). |
| `skills` | `SkillRef[]` | — | ✅ (invocable) | Named instruction/knowledge blocks. Local skills only (`skill()` / `skillFromDir()`); a `"platform:<name>"` ref fails loud until the platform skill base is wired. Owns-host only in the default `"invocable"` mode. See [Skills](./skills.md). |
| `skillsMode` | `"invocable" \| "prepend"` | `"invocable"` | — | How skills reach the model. `"invocable"` bakes each skill into the host as `SKILL.md` + a workspace-confined `read` tool (token-efficient, owns host); `"prepend"` inlines every body into the system prompt each turn (works with a shared client, token-heavy). |
| `hooks` | `Hooks` | — | see note | Client-side hooks intercepting the turn and tool calls (block/modify input/output). Turn- and reply-level hooks are pure client-side; **tool-level** hooks (`before_tool_call` / `after_tool_call`) own the host. See [Hooks](./hooks.md). |
| `guards` | `Guard[]` | — | see note | Sugar over hooks (`guard.output` / `guard.tool` / `guard.custom` / `guard.input`). A tripped guard raises `DivaGuardTripped` naming it. `guard.tool` / `guard.toolOutput` own the host (same rule as tool-level hooks). See [Guards](./guards.md). |
| `knowledge` | `string` | — | — | Server-side knowledge-base handle (platform RAG). **Not yet wired** — throws `DivaNotImplementedError` when a turn runs (see Notes). |
| `client` | `DivaClient` | — | — | Explicit client (DI / shared host). Omit to create one from the environment. Incompatible with every owns-host option above. |
| `clientOptions` | `DivaClientOptions` | — | — | Options for the implicitly-created client (ignored when `client` is passed). `tools`, `mcp`, `params`, `thinkingDefault`, `compaction`, `flow`, `builtinTools`, `permissions`, and `onCompaction` may be supplied here instead of top-level; a top-level value wins. |

> Note on "owns host": the guard fires whenever an owns-host option is present
> **and** you also pass `options.client`. Each conflict throws its own message,
> e.g. `Agent tools require the agent to own its host: pass 'tools' without a
> shared 'client' (configure the implicit client via 'clientOptions').`

## `RunOptions`

Per-turn options accepted by `run()`, `stream()`, and `generate()`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionId` | `string` | — | Conversation id for multi-turn continuity: successive turns with the same id share history. Omit for a stateless turn. `generate()` reads it only to keep its own retry in one session — it never joins run/stream history (see [Structured output](./structured-output.md)). |
| `timeoutMs` | `number` | client's `requestTimeoutMs` | Per-turn timeout for THIS call only — e.g. a short bound on one item in a batch. |
| `model` | `string` | the Agent's model | Per-turn model override (a full platform ref, e.g. `"diva/deepseek/deepseek-v4-flash"`); the namespace is still required. |

## Call methods

### `run(message, opts?): Promise<AgentResult>`

Runs one turn and returns the assistant's reply.

```ts
const { text, runId } = await agent.run("Give me one commit-message tip.");
```

`AgentResult`:

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string` | The assistant's text reply (final answer only — reasoning and compaction notices are stripped). |
| `runId` | `string \| undefined` | The run id assigned by the engine. |
| `usage` | `Usage \| undefined` | Token usage for the turn when the engine reports it: `{ inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens? }`. Prices are not computed — multiply by your own per-model rates. |
| `durationMs` | `number \| undefined` | Wall-clock duration of the turn in ms. |
| `stopReason` | `string \| undefined` | Why the turn stopped (e.g. `"stop"`, `"length"`). |

`usage`/`durationMs`/`stopReason` ride on `AgentResult`, the `stream()` `done`
chunk, and `StructuredResult` — so cost/latency accounting needs no extra call.

If the turn returns no result payloads, or an error payload, `run()` throws a
`DivaRequestError` (`agent turn returned no result payloads (unexpected shape)` /
`agent turn errored: …`) rather than returning empty text.

### `stream(message, opts?): AsyncGenerator<AgentStreamChunk>`

Streams one turn: yields incremental `delta` chunks, then a single terminal `done`
chunk. Same turn semantics as `run()`. Breaking the loop early aborts the
server-side run. Full detail and the exact chunk shape are in
[Streaming](./streaming.md).

```ts
for await (const chunk of agent.stream("List three uses for a paperclip.")) {
  if (chunk.type === "delta") process.stdout.write(chunk.delta);
  else console.log(`\n[done] runId=${chunk.runId}`);
}
```

### `generate(message, schema, opts?): Promise<StructuredResult<T>>`

Runs one turn and returns a typed, schema-validated result. The model is
instructed to reply with only JSON matching a zod `schema`; the reply is parsed,
validated, and re-asked once on failure. Full detail in
[Structured output](./structured-output.md).

```ts
import { z } from "@diva-ai/sdk";

const { output } = await agent.generate(
  "Extract the lead from: 'Hi, I'm Ada (ada@example.com), want to buy 10 seats.'",
  z.object({ name: z.string(), email: z.string() }),
);
output.email; // typed
```

Signature: `generate<TSchema extends z.ZodType>(message, schema, opts?)` →
`StructuredResult<z.infer<TSchema>>`.

## Sessions

### `session(sessionId?): AgentSession`

Opens a multi-turn conversation. Successive `run()` / `stream()` on the returned
[`AgentSession`](./sessions-and-memory.md) share history (server-side by default,
or in the agent's `store`). Omit `sessionId` for a fresh conversation (a random
UUID is minted); pass one to resume.

```ts
const chat = agent.session();          // fresh conversation
await chat.run("My name is Ada.");
(await chat.run("What's my name?")).text; // → "…Ada…"

const resumed = agent.session("user-42"); // resume by stable id
```

Internally the caller `sessionId` is **hashed** into the wire session key (never
interpolated verbatim), and the key is scoped by the agent's identity digest
(`sessionScope` = model + raw instructions + skill names). Two logically-distinct
agents sharing one client therefore never interleave into one conversation, while
the same agent config resumes deterministically across process restarts. See
[Sessions & memory](./sessions-and-memory.md).

## Host lifecycle

### `start(): Promise<void>`

Pre-warms the underlying host so the first `run()` / `stream()` is not a cold boot.
Idempotent while the agent is open; throws after `close()` (make a new `Agent` to
run again). Especially useful for a sub-agent used in a `handoff()`: warm it before
the parent handles traffic, or the first delegated turn pays the full host boot
inside the parent's tool-call timeout. See [Subagents](./subagents.md).

### `close(): Promise<void>`

Stops the underlying client — and thus closes its gateway connection — **only if
this agent created it** (i.e. no explicit `client` was passed). Always call it in a
`finally` block so the connection closes cleanly:

```ts
const agent = new Agent("diva/deepseek/deepseek-v4-flash");
try {
  const { text } = await agent.run("Hello!");
  console.log(text);
} finally {
  await agent.close();
}
```

When you pass a shared `client`, `close()` is a no-op for that client — you own its
lifecycle. See [Core concepts](./core-concepts.md).

## Example: an agent that owns its host with tools

Owns-host options (here `tools`) require the agent to create its own client, so
they are passed **without** a `client`. Configure the implicit client through
`clientOptions` if needed.

```ts
import { Agent, tool, z } from "@diva-ai/sdk";

const getWeather = tool({
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: z.object({ city: z.string() }),
  async execute({ city }) {
    return `It is 21°C and clear in ${city}.`;
  },
});

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You are a travel assistant. Use tools when asked about weather.",
  tools: [getWeather],
  params: { temperature: 0.2, maxTokens: 400 },
});

try {
  const { text } = await agent.run("What's the weather in Lisbon?");
  console.log(text);
} finally {
  await agent.close();
}
```

## Notes & caveats

- **Owns-host vs shared client.** `tools`, `toolsets`, `mcp`, `params`,
  `compaction`, `thinkingDefault`, `flow`, `builtinTools`, `permissions`,
  invocable `skills`, and tool-level hooks/guards each throw a `DivaError` at
  construction if combined with an explicit `client`. `onCompaction` throws with
  its own message directing you to set it on the shared client instead.
- **`knowledge` fails loud, and the refusal is a signpost.** Setting `knowledge`
  and then running a turn throws `DivaNotImplementedError` naming the endpoints
  that work today (`POST /api/v1/agi/sdk/kb/collections`, then
  `/collections/{id}/chunks`) and the fact that a `byo` corpus reaches the agent
  too — the platform indexes its text with its own embedder while your vectors
  stay untouched. The option is not yet functional; the knowledge base is.
- **Platform namespace required.** A model ref missing its provider segment is
  rejected at turn time — the SDK will not let a turn run outside the Diva gateway.
- **Invocable-skills conflicts.** Because invocable skills pin the host workspace
  to a skills-only dir and un-gate a confined `read` tool, combining them with
  `builtinTools.fileOps`, or with `permissions.deny` including `"read"`, throws a
  `DivaError` at construction. Use `skillsMode: "prepend"` to mix skills with file
  ops, or drop one.
- **Built-in tools are off by default.** Without `builtinTools`, a remotely-driven
  model cannot touch the host shell or filesystem — it only sees your `tools` /
  `mcp`. Opt in deliberately.
- **Requires Node ≥ 22.14.**

## See also

- [Core concepts](./core-concepts.md) — the harness-as-library host model
- [Streaming](./streaming.md) — `agent.stream()`
- [Structured output](./structured-output.md) — `agent.generate()`
- [Tools](./tools.md) · [Toolsets](./toolsets.md) · [MCP](./mcp.md)
- [Permissions](./permissions.md) · [Code execution](./code-execution.md)
- [Model configuration](./model-configuration.md)
- [Sessions & memory](./sessions-and-memory.md)
- [Skills](./skills.md) · [Flow](./flow.md) · [Hooks](./hooks.md) · [Guards](./guards.md)
- [Subagents](./subagents.md) · [Error handling](./error-handling.md)
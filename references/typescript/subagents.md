# Sub-agents

A sub-agent is a specialized [Agent](./agents.md) that a parent agent can delegate
to. `handoff()` turns a sub-agent into a client-side [tool](./tools.md) — named
`transfer_to_<name>` — that the parent model calls when a task matches the
sub-agent's role. This is the RFC's "handoff is just a typed tool transfer": there
are no graphs or orchestration DSL; a sub-agent is a normal `Agent` you construct
and own.

## When to use

- **Use** to route a distinct sub-task to a focused agent — a lead qualifier, a
  code reviewer, a translator — with its own `instructions`, model, and tools.
- **Use** when you want the sub-agent's work to run in an **isolated context** so
  the parent conversation stays uncluttered.
- **Avoid** for tasks the parent can do inline; each handoff pays a full sub-agent
  turn.
- **Avoid** wiring handoffs into cycles (A → B → A) — see the backstop in
  [Notes & caveats](#notes--caveats).

## How it works

`handoff(subAgent, options)` returns a `ToolDefinition`. You pass it in the
parent's `tools`. When the parent model calls `transfer_to_<name>`, the tool:

1. Renders the tool input into a single **message string** (the default schema is
   `{ message: string }`; a custom `inputSchema` requires a `render` mapper).
2. Runs **one turn** of the sub-agent with that message.
3. Returns the sub-agent's reply **text** as the tool result the parent sees.

Each handoff is an **independent, stateless sub-agent turn** — a fresh session.
The sub-agent does not remember earlier handoffs within the same parent
conversation; this is the RFC's isolated-context choice. If you need continuity
across delegations, thread it yourself (e.g. include prior context in the rendered
message).

Because a handoff wraps a sub-agent that runs a full turn (host boot + generation),
its execute ceiling defaults generously to **180 s** — the tool-server's usual
60 s default would falsely time it out. The sub-agent's own `requestTimeoutMs` is
the real bound and should fire first (keep it **below** `timeoutMs`), cancelling
the turn cleanly.

## Example

Mirrors `examples/subagents.ts`: a triage agent that delegates lead-qualification
to a focused sub-agent.

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/subagents.ts
import { Agent, handoff } from "@diva-ai/sdk";

async function main(): Promise<void> {
  // A focused sub-agent. It owns its own host and gets an isolated context.
  const qualifier = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "You score sales leads. Reply with a one-line score and reason.",
  });

  // The parent can delegate by calling transfer_to_qualifier.
  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions:
      "You triage inbound messages. For anything about a sales lead, call " +
      "transfer_to_qualifier and relay its score. Otherwise answer directly.",
    tools: [
      handoff(qualifier, {
        name: "qualifier",
        description: "Qualify an inbound sales lead and return a score.",
      }),
    ],
  });

  try {
    await qualifier.start(); // pre-warm so the first handoff isn't a cold boot
    const { text } = await agent.run("New lead: Acme Corp wants 100 seats, budget approved.");
    console.log(text);
  } finally {
    // Sub-agents are independent — the parent's close() does not cascade.
    await agent.close();
    await qualifier.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Structured hand-off with a custom schema

When one string isn't enough, supply an `inputSchema` and a `render` that maps the
validated input to the sub-agent's message. This avoids stuffing everything into
one opaque string.

```ts
import { Agent, handoff, z } from "@diva-ai/sdk";

const translator = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You translate text. Reply with only the translation.",
});

const translateTool = handoff(translator, {
  name: "translator",
  description: "Translate a snippet into a target language.",
  inputSchema: z.object({
    text: z.string(),
    targetLang: z.string(),
  }),
  render: ({ text, targetLang }) => `Translate to ${targetLang}:\n${text}`,
  timeoutMs: 120_000, // keep translator.requestTimeoutMs below this
});

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "Delegate any translation request to transfer_to_translator.",
  tools: [translateTool],
});
```

## API

### `handoff(subAgent, options)`

```ts
function handoff<TSchema extends z.ZodType>(
  subAgent: Agent,
  options: HandoffOptions<TSchema>,
): ToolDefinition;
```

Turn a sub-agent into a `transfer_to_<name>` tool for the parent's `tools`.
Validates `options` and throws `DivaError` when:

- `name` is not a letter-led identifier matching `/^[a-zA-Z][a-zA-Z0-9_]*$/`
  (letters, digits, `_`; **no hyphen** — the tool is exposed as
  `transfer_to_<name>`).
- `description` is empty.
- `inputSchema` is set but `render` is missing.

### `HandoffOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — (required) | The sub-agent's role. Exposed to the parent model as a tool named `transfer_to_<name>`. Must be a letter-led identifier (`/^[a-zA-Z][a-zA-Z0-9_]*$/`) and unique among the parent's tools. Trimmed. |
| `description` | `string` | — (required) | When the parent should hand off — this is what the model reads to decide. Be specific (e.g. `"Qualify an inbound sales lead"`) so routing is accurate. |
| `inputSchema` | `z.ZodType` | `z.object({ message: z.string() })` | Custom input schema for a structured hand-off. When set, `render` is **required**. |
| `render` | `(input: z.infer<TSchema>) => string` | — | Maps the validated structured input to the sub-agent's message string. Required whenever `inputSchema` is set; ignored with the default schema (which passes `input.message` through). |
| `timeoutMs` | `number` | `180000` (180 s) | Execute ceiling for the handoff tool, in milliseconds. A handoff runs a full sub-agent turn, so keep this **above** the sub-agent's `requestTimeoutMs`. |
| `onResult` | `(result: AgentResult) => void` | — | Observe each delegation: called with the sub-agent's **full** result (`text` + `usage` + `durationMs` + `runId`) after every hand-off. The parent model only ever sees the returned `text`, so this is the side channel for an audit trail / cost accounting of sub-agent turns — record it here instead of hand-wiring hooks. A throwing observer is ignored (it never breaks the delegation). |

Each hand-off runs a **distinct persona**: `handoff(subAgent, …)` invokes
`subAgent.run()`, so the sub-agent uses its own `instructions`, model, and tools —
not the parent's.

## Notes & caveats

- **Sub-agents are independent Agents.** The parent's `close()` does **not**
  cascade — you must `close()` each sub-agent yourself. Calling `close()` on a
  sub-agent that shares an explicit `client` is a no-op (the client owner closes
  the host).
- **Pre-warm to avoid a cold boot inside a tool call.** The first delegated turn
  pays the sub-agent's host boot. Call `subAgent.start()` before the parent
  handles traffic, or that boot happens **inside** the parent's tool-call timeout.
- **Errors are surfaced tagged.** If the sub-agent turn fails (bad key, dead
  instance, host death), the tool throws `DivaError` — `handoff to "<name>"
  failed: <cause>` — so the parent model sees a clear, attributed failure instead
  of an opaque tool error it would hallucinate around. See
  [Error handling](./error-handling.md).
- **Concurrency backstop.** A process-wide counter caps in-flight handoffs at
  **64**. Past the cap the tool throws `DivaError` — *"handoff backstop tripped:
  64 concurrent in-flight handoffs — check for a delegation cycle …"*. Handoff
  executions run in the tool-server's request context, disconnected from the
  parent run's async context, so precise per-chain depth is not observable across
  that boundary; the counter is the safety net. **Avoid wiring handoff cycles** —
  a genuine cycle grows unbounded and trips this. Normal concurrency never does.
- **Isolation is by design.** No shared memory between handoffs. If you need the
  sub-agent to see prior turns, fold that context into the rendered message.

## Running sub-agents in parallel

When the parent model emits **parallel tool calls** in one turn, multiple `handoff()` sub-agents
execute **concurrently** in your process (bounded by the process-wide `MAX_INFLIGHT_HANDOFFS` = 64
backstop) — model-driven parallelism, no extra code.

For **explicit, code-orchestrated** batches (`parallel()`) and for **host-side** parallel sub-agents
that run on the engine's per-tenant fair-scheduled lanes (`builtinTools.subagents`), see the
dedicated page:

> **→ [Parallel agents](./parallel-agents.md)** — the full concurrency surface (`parallel()`,
> parallel handoffs, and `builtinTools.subagents`), when to use each, and the roadmap.

## See also

- [Agents](./agents.md) — constructing the parent and sub-agents; `start()` / `close()`.
- [Tools](./tools.md) — `handoff()` returns a `ToolDefinition` like any other tool.
- [Code execution](./code-execution.md) — `builtinTools` opt-ins and the secure-default model.
- [Flow](./flow.md) — structured, slot-filling conversation control within one agent.
- [Error handling](./error-handling.md) — `DivaError` and the handoff-failure wrapper.
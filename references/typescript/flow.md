# Flow

A flow is a **slot-filling funnel**: a declarative frame that hard-blocks a
terminal action until the conversation has collected the required information.
Build one with `flow(name)` and its chained builder, then attach the compiled
`Flow` to an [Agent](./agents.md) via the `flow` option. The gate runs **wherever
the tools run**:

- **Thin client (platform).** The interpreter runs **client-side**; since every
  tool is a client tool in this mode, the gate covers **every** call the model can
  make — it is complete, nothing can slip past it.
- **Self-host.** The agent's own Diva engine runs the `diva-flow` plugin and gates
  **every** tool (client, backend, and MCP alike), including tools that execute
  inside the engine.

A flow is dialogue management, **not** a control-flow step graph. It separates the
**guarantee** (a terminal action is hard-blocked until its slots are filled) from
**guidance** (soft prompt hints); it never narrows or forces the model's tool
choice.

## When to use

- **Use** when a conversation must gather specific facts before a
  consequence — collect the delivery address before `create_order`, verify
  identity before `issue_refund`.
- **Use** when you need this guarantee enforced **server-side of the model** (in
  the host), not merely asked for in the prompt — a model that "forgets" cannot
  bypass a filled-slot gate.
- **Avoid** for free-form chat with no required-information invariant.
- **Avoid** modeling branching business logic as a graph here; a flow gates
  completion, it does not sequence steps.

## How it works

You describe the funnel with a `FlowBuilder`:

- **Slots** are the facts to collect. A slot becomes *filled* by exactly one
  source (`fillWhen`): a truthy dotted path in a tool result, any of a set of
  tools succeeding, or all of a set succeeding this session.
- **Completion** names the terminal action and which slots must be filled before
  it is allowed. This is the hard block.
- **Gates** add per-tool preconditions (require prior tools, or block on an
  argument value), each returning a reason so the model self-corrects.
- **Injections** append text (optionally pulled from a tool result) into the
  context after a tool runs — the funnel roadmap the model reads each turn.
- **Rules** are free-text guidance lines; a **narration guard** catches the model
  claiming completion before the terminal action actually succeeded.

`.build()` structurally validates the frame and emits a `Flow` — a name plus a
platform-compatible `FlowFrame` (snake_case keys, `undefined` values dropped). The
emitted JSON is **byte-compatible with the platform's flow grammar**, so the same
frame could later be POSTed verbatim to the platform's `/v1/flows` endpoint.

When you attach the `Flow` to an Agent, its tool references are cross-checked
against the agent's real tools, and the frame is baked into the host config. An
agent with a `flow` therefore **owns its host** and cannot share an explicit
`client`.

## Example

### Order funnel

Mirrors `examples/flow.ts`: collect the delivery `address`, then allow the
terminal `create_order`. The model cannot finalize until `set_address` fills the
slot — enforced by the flow gate (client-side in thin mode, host-side when self-hosted).

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/flow.ts
import { Agent, flow, tool, z } from "@diva-ai/sdk";

const setAddress = tool({
  name: "set_address",
  description: "Save the customer's delivery address.",
  inputSchema: z.object({ address: z.string() }),
  execute: async ({ address }) => ({ saved: address }),
});

const createOrder = tool({
  name: "create_order",
  description: "Place the order. Only valid once the address is known.",
  inputSchema: z.object({}),
  execute: async () => ({ orderId: "A-1001" }),
});

// A funnel: collect `address`, then allow the terminal `create_order`.
const orderFunnel = flow("order")
  .slot("address", {
    label: "delivery address",
    ask: "Where should we deliver?",
    tools: ["set_address"],
    fillWhen: { toolCalled: ["set_address"] },
  })
  .completion("create_order", { requires: ["address"] })
  // If the model says "order placed" before create_order actually succeeds, retry.
  .narrationGuard(["order placed", "заказ оформлен"])
  .build();

async function main(): Promise<void> {
  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "You take customer orders. Be brief.",
    tools: [setAddress, createOrder],
    flow: orderFunnel, // enforced by the flow gate (client-side in thin mode)
  });

  try {
    // create_order is blocked by the flow gate until set_address fills the `address` slot.
    const { text } = await agent.run("I'd like to order. Deliver to 5 Main St.");
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

### Multi-slot funnel with a gate and an injection

Exercises the fuller builder surface: two slots, a `gate` that blocks a tool until
a prior one succeeded, an `injection` that surfaces a result value, a `rule`, and
`finalized` to detect the terminal result.

```ts
import { flow } from "@diva-ai/sdk";

const refundFunnel = flow("refund")
  .slot("order", {
    label: "order id",
    ask: "What's the order number?",
    fillWhen: { resultPath: "lookup_order.orderId" },
  })
  .slot("identity", {
    label: "verified identity",
    required: true,
    fillWhen: { toolsAll: ["verify_email", "verify_zip"] },
  })
  // Don't let the model issue a refund before the order is looked up and identity verified.
  .gate("issue_refund", {
    requirePrior: ["lookup_order", "verify_email", "verify_zip"],
    blockReason: "Look up the order and verify the customer before issuing a refund.",
    maxBlocks: 3,
  })
  // Block a high-value refund path unless the reason is an approved code.
  .gate("approve_large_refund", {
    whenArg: { field: "reason", operator: "not_in", values: ["defective", "not_delivered"] },
    blockReason: "Large refunds are only auto-approved for defective / not-delivered orders.",
  })
  .injection("lookup_order", "Order details:", { fromResult: ["order", "status"] })
  .rule("Never promise a refund timeline you cannot guarantee.")
  .completion("issue_refund", { requires: ["order", "identity"] })
  .finalized({ tool: "issue_refund", resultPath: "refundId" })
  .narrationGuard(["refund issued", "money back"])
  .build();
```

## API

### `flow(name)`

```ts
function flow(name: string): FlowBuilder;
```

Start a builder. The `name` is trimmed; an empty name throws `DivaError` —
`"flow: a non-empty name is required."`.

### `FlowBuilder`

Chain the methods below, then `.build()`. Every mutator returns `this`.

| Method | Signature | Description |
| --- | --- | --- |
| `.slot` | `slot(name: string, opts: SlotOptions): this` | Declare a slot to collect. See [`SlotOptions`](#slotoptions). |
| `.gate` | `gate(tool: string, opts: GateOptions): this` | Add a per-tool precondition. See [`GateOptions`](#gateoptions). |
| `.injection` | `injection(tool: string, append: string, opts?: { fromResult?: readonly string[] }): this` | After `tool` runs, append `append` (plus optional values pulled from the result at `fromResult` dotted paths) into the context. |
| `.rule` | `rule(text: string): this` | Add a free-text guidance line to the frame. |
| `.narrationGuard` | `narrationGuard(claimPatterns: readonly string[]): this` | Patterns that, if the model utters them before the terminal action actually succeeds, mark completion as *faked* and force a retry. |
| `.completion` | `completion(action: string, opts?: { requires?: readonly string[] }): this` | **Required.** The terminal action the completion invariant gates. `requires` lists the slots that must be filled first; omitting it means **all required slots**. |
| `.finalized` | `finalized(spec: { tool?: string; resultPath?: string }): this` | How the terminal result is detected — the finalizing `tool` and/or a `resultPath` dotted path in its result. |
| `.build` | `build(): Flow` | Validate and compile. See below. |

**`.build()` validation** — throws `DivaError` if:

- there are **no slots** (`"at least one slot is required"`);
- two slots share a `name` (`"duplicate slot name \"<name>\""`);
- no `completion(action)` was set (`"a completion(action) is required"`);
- `completion.requires` references an unknown slot;
- a `gate` has neither `requirePrior` nor `whenArg` (each gate needs at least one).

### `SlotOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `label` | `string` | — | Human-readable slot label (roadmap display). |
| `required` | `boolean` | `true` | Whether the completion invariant requires this slot. |
| `ask` | `string` | — | Soft hint prompting the model to collect this slot. **Guidance only** — not enforced. |
| `tools` | `readonly string[]` | — | Bare tool names relevant to this slot. A **roadmap hint, not an ACL** — it does not restrict tool access. |
| `fillWhen` | `SlotFill` | — (required) | How the slot becomes filled. See [`SlotFill`](#slotfill). |

### `SlotFill`

Exactly one source per slot (a discriminated union):

| Variant | Type | Compiles to | Meaning |
| --- | --- | --- | --- |
| `resultPath` | `{ readonly resultPath: string }` | `result_path` | A truthy value at this dotted path over a tool result fills the slot. |
| `toolCalled` | `{ readonly toolCalled: readonly string[] }` | `tool_called` | Any of the listed tools succeeding fills the slot. |
| `toolsAll` | `{ readonly toolsAll: readonly string[] }` | `tools_all` | **All** listed tools succeeding this session fills the slot. |

### `GateOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `requirePrior` | `readonly string[]` | — | Block the gated tool until **all** these tools have succeeded this session. |
| `whenArg` | `{ field: string; operator: "in" \| "not_in" \| "eq" \| "ne"; values: readonly string[] }` | — | Block when the gated tool's own argument at `field` matches the condition against `values`. |
| `blockReason` | `string` | — (required) | The reason returned to the model when blocked, so it self-corrects. |
| `maxBlocks` | `number` | `2` | Anti-livelock: stop blocking after N consecutive blocks. Range **1..10**. |

A gate must specify at least one of `requirePrior` / `whenArg` (enforced at
`build()`).

### `FlowFrame`

The compiled, platform-compatible frame (snake_case keys, `undefined` values
excluded):

```ts
type FlowFrame = {
  readonly slots: ReadonlyArray<Record<string, unknown>>;
  readonly completion: Record<string, unknown>;
  readonly finalized?: Record<string, unknown>;
  readonly narration_guard?: Record<string, unknown>;
  readonly rules?: readonly string[];
  readonly gates?: ReadonlyArray<Record<string, unknown>>;
  readonly injections?: ReadonlyArray<Record<string, unknown>>;
};
```

You normally do not construct this directly — `build()` emits it. It is exposed so
you can inspect or serialize the compiled frame.

### `Flow`

```ts
type Flow = { readonly name: string; readonly frame: FlowFrame };
```

The SDK-level flow name plus the platform frame. Pass the whole `Flow` to an
Agent's `flow` option.

## Agent option

Set on [`AgentOptions`](./agents.md):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `flow` | `Flow` | — | The compiled funnel. Runs client-side in the hosted client (every tool is a client tool, so the gate is complete), or in the agent's own engine via the `diva-flow` plugin when self-hosted. Gates tools until required slots are filled, injects the roadmap each turn, and guards against fake completion. Tool references are cross-checked against the agent's real tools when attached. |

## Notes & caveats

- **A flow makes the agent own its host.** Passing `flow` alongside an explicit
  `client` throws `DivaError` — *"Agent `flow` requires the agent to own its host:
  pass `flow` without a shared `client` (configure the implicit client via
  `clientOptions`)."* A shared client's engine session can't receive a per-agent frame.
- **Enforcement gates *every* tool the model can call.** In the hosted client that is
  every tool (all are client tools); when self-hosted the gate also covers backend and
  MCP tools that run inside the engine. Either way the block is a real gate, so the
  model cannot talk its way past a filled-slot requirement.
- **Slot hints are guidance, not guarantees.** `ask` and a slot's `tools` list are
  roadmap hints; only `fillWhen` (via `completion`/`gate`) is enforced. `tools` is
  explicitly **not an ACL** — use [Permissions](./permissions.md) to restrict tool
  access.
- **Anti-livelock is built in.** A gate stops blocking after `maxBlocks`
  consecutive blocks (default 2, max 10) so a confused model can't be trapped
  forever.
- **The frame is platform-grammar-compatible.** `build()` emits snake_case,
  exclude-undefined JSON that matches the platform's schema exactly — the same
  frame could later POST to `/v1/flows` unchanged. Unknown keys are forbidden by
  that grammar, so the builder emits only the documented fields.

## See also

- [Agents](./agents.md) — the `flow` option and the owns-host rule.
- [Tools](./tools.md) — the tools a flow gates and references by name.
- [Permissions](./permissions.md) — restrict tool access (a flow's `tools` hint does not).
- [Sub-agents](./subagents.md) — delegation across agents, versus in-agent flow control.
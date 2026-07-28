# Hooks

Lifecycle hooks let you intercept an agent's turn **in your own process** — observe it,
rewrite the values flowing through it, or block it. You pass a `Hooks` object to
`AgentOptions.hooks`; each handler fires at a defined point in the turn and returns a
`HookOutcome` that tells the SDK whether to continue, substitute a value, or reject.

Hooks are the low-level primitive. [Guards](./guards.md) are sugar on top of the same
machinery (tripwires with named reasons), and both compile into the same per-hook chains.

## When to use

- **Redact / rewrite** the outgoing message, a tool's input or output, or the final reply
  (PII scrubbing, prompt hardening, normalization).
- **Block** a turn or a tool call on a policy decision (content rules, human-in-the-loop
  approval).
- **Observe** the turn for logging, audit, or metrics (`agent_end`, and the read side of
  every other hook).

For declarative security rules prefer [Guards](./guards.md); to gate the **engine's**
built-in tools (`exec`/`read`/`write`/`web`) use [`permissions.canUseTool`](./permissions.md)
— tool hooks only see **your** client-side `tool()`s.

## How it works

The SDK can enforce the subset of the engine's hook set that lives **in the SDK's own
process**:

- **Turn-level hooks** wrap `run()` / `stream()` / `generate()`. They run entirely
  client-side, so they work whether the agent owns its host or shares an explicit
  [`client`](./agents.md).
- **Tool hooks** (`before_tool_call` / `after_tool_call`) wrap the `execute` of **this
  agent's** client-side [tools](./tools.md). Because they decorate the agent's own tools —
  served from the agent's own host — an agent that declares them **cannot share an explicit
  `client`**; doing so throws a `DivaError` at construction (see [Notes](#notes--caveats)).
- **Host-internal hooks** (model calls, compaction, sessions, subagent lifecycle, channels,
  flow) require host integration and are **not wired yet**. Declaring one fails loud with a
  [`DivaNotImplementedError`](./error-handling.md) — never a silent no-op.

Within a single hook name, handlers compose into a **chain** (your hooks first, then any
[guards](./guards.md), in order). A `{ replace }` outcome threads the new value forward to
the next handler; a `{ block }` short-circuits the chain and throws
[`DivaGuardTripped`](./error-handling.md) naming the guard. A handler that **throws** fails
the turn loudly with [`DivaHookError`](./error-handling.md) — hook errors are never
swallowed.

### The hook catalog

Every RFC hook name is one of 21; only the six **wired** names below run today. The others
are declared in the protocol but require the host, and throw `DivaNotImplementedError` if you
bypass the types and pass one.

| Hook | Status | Event | Returns | What it can do |
| --- | --- | --- | --- | --- |
| `before_agent_start` | ✅ wired | `BeforeAgentStartEvent` | `HookOutcome` | Observe the outgoing message + selector; `replace` (string) rewrites the message; `block` aborts the turn. |
| `before_tool_call` | ✅ wired | `BeforeToolCallEvent` | `HookOutcome` | Observe a client-side tool's input; `replace` rewrites it (re-validated against the tool schema); `block` prevents the tool from running (**soft** — see below). |
| `after_tool_call` | ✅ wired | `AfterToolCallEvent` | `HookOutcome` | Observe a client-side tool's output (side-effect already happened); `replace` redacts/rewrites it; `block` only hides the result from the model. |
| `before_reply` | ✅ wired | `ReplyEvent` | `HookOutcome` | Observe the reply text; `replace` (string) rewrites it; `block` rejects the turn. |
| `final_reply_guard` | ✅ wired | `ReplyEvent` | `HookOutcome` | Last gate on the reply (runs **after** `before_reply`); `replace` (string) / `block`. |
| `agent_end` | ✅ wired | `AgentEndEvent` | `void` | Observational only — cannot block or replace. Fires even when a reply guard blocked (so audit sees blocked turns). |
| `before_model_call` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `after_model_call` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `tool_result_persist` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `session_start` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `session_end` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `before_compaction` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `after_compaction` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `subagent_spawning` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `subagent_spawned` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `subagent_ended` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `message_received` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `message_sending` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `message_sent` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `flow_slot_filled` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `flow_gate_blocked` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |
| `flow_completed` | ⚠️ not wired | — | — | Host-internal; `DivaNotImplementedError` if declared. |

> The exported `Hooks` TypeScript type only exposes the six wired fields, so TypeScript
> already rejects the unwired names. The `DivaNotImplementedError` is the runtime backstop
> for a call site that casts around the types; a key that is not an RFC name at all is
> dropped silently (the typed API already excludes it).

### Blocks: hard vs. soft

- **Turn-level blocks are hard.** A `block` from `before_agent_start`, `before_reply`, or
  `final_reply_guard` throws `DivaGuardTripped` out of `run()` / `stream()` / `generate()`.
- **Tool-call blocks are soft.** A `before_tool_call` block runs behind the MCP tool
  boundary, so it cannot throw to you or abort the turn. The tool does not run and the
  `DivaGuardTripped` surfaces **to the model** as a distinct "blocked by policy" tool result,
  which the model then adapts to. An `after_tool_call` block cannot undo a side-effect that
  already happened — it only hides the result from the model.

### Chain re-runs, `once`, and convergence

When a handler returns `{ replace }`, the value threads forward. Interactive handlers marked
`once` (a human-approval [guard](./guards.md)) run **at most once** per value-chain: their
`replace` re-runs the chain from the top so earlier guards re-vet the edited value, but the
`once` handler itself is skipped on the re-run. The chain is bounded to **8 replace passes**;
a non-converging chain (a replace loop) throws `DivaHookError` (`hook/guard chain did not
converge after 8 replace passes`).

### Where hooks fire in a turn

```
run()/stream()/generate()
  └─ before_agent_start        (rewrite the outgoing message)
       └─ [ per tool call: before_tool_call → tool.execute → after_tool_call ]
            └─ before_reply    (rewrite the reply)
                 └─ final_reply_guard   (last gate)
                      └─ agent_end       (observe; fires even if a reply guard blocked)
```

`generate()` runs the same hooks (a PII/reply guard is not bypassable by choosing structured
output): `before_agent_start` rewrites the outgoing message, and the reply chains +
`agent_end` run on the text that could be returned. In `stream()`, reply hooks apply to the
final `done` text — **not** to the deltas, which already streamed the raw text; a stream block
throws at the `done` step but cannot un-deliver deltas already yielded.

## Example

```ts
// DIVA_API_KEY=sk-diva-… node --import tsx app.ts
import { Agent, DivaGuardTripped, tool, z } from "@diva-ai/sdk";

const getBalance = tool({
  name: "get_balance",
  description: "Return the account balance for a user id.",
  inputSchema: z.object({ userId: z.string() }),
  execute: async ({ userId }) => ({ userId, balance: 4212 }),
});

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "You are a terse banking assistant. Use tools for balances.",
  tools: [getBalance],
  hooks: {
    // Observe / rewrite the outgoing message.
    before_agent_start: (e) => {
      console.log("[hook] turn starting:", e.message);
      // return { replace: e.message.trim() }; // rewrite (must be a string)
    },
    // Inspect a tool call; a block here is SOFT (the model is told, the turn continues).
    before_tool_call: (e) => {
      console.log("[hook] tool call:", e.tool, e.input);
      // return { block: "balances are restricted" };
    },
    // Redact the tool output before the model sees it (side-effect already happened).
    after_tool_call: (e) => {
      const out = e.output as { userId: string; balance: number };
      return { replace: { ...out, balance: "***" } };
    },
    // A turn-level block IS a hard abort: run() throws DivaGuardTripped.
    final_reply_guard: (e) =>
      e.text.length > 2000 ? { block: "reply too long" } : undefined,
    // Observational: fires even when a reply guard blocked.
    agent_end: (e) => console.log("[hook] done:", e.reply),
  },
});

try {
  const { text } = await agent.run("What's the balance for user u_42?");
  console.log("reply:", text);
} catch (err) {
  if (err instanceof DivaGuardTripped) {
    console.error("guard tripped:", err.detail.guard, "-", err.detail.reason);
  } else {
    throw err;
  }
} finally {
  await agent.close();
}
```

### Human-in-the-loop with the abort signal

`before_tool_call` receives an `AbortSignal` that fires at the tool's execute deadline. An
`await`-based approval should **race** it, so a late decision cancels instead of running the
tool. This pattern is packaged as [`guard.approval`](./guards.md); a raw hook looks like:

```ts
before_tool_call: async (e) => {
  if (e.tool !== "refund") return;
  const decision = await Promise.race([
    askHuman(e.input),                                   // your UI/Slack/CLI approval
    new Promise((resolve) =>
      e.signal?.addEventListener("abort", () => resolve(false), { once: true })),
  ]);
  return decision ? undefined : { block: "refund not approved by a human" };
},
```

If the deadline elapses while the hook is still awaiting, the SDK does **not** run the
side-effect and throws `DivaHookError` (`a before_tool_call hook resolved after the tool
deadline — not executed`).

## API

### `Hooks`

Passed as `AgentOptions.hooks`. Every field is optional.

| Field | Type | Description |
| --- | --- | --- |
| `before_agent_start` | `(ev: BeforeAgentStartEvent) => HookOutcome \| Promise<HookOutcome>` | Fires before a turn is sent. |
| `before_tool_call` | `(ev: BeforeToolCallEvent) => HookOutcome \| Promise<HookOutcome>` | Fires before a client-side tool executes. |
| `after_tool_call` | `(ev: AfterToolCallEvent) => HookOutcome \| Promise<HookOutcome>` | Fires after a client-side tool executes. |
| `before_reply` | `(ev: ReplyEvent) => HookOutcome \| Promise<HookOutcome>` | Fires on the reply text (before `final_reply_guard`). |
| `final_reply_guard` | `(ev: ReplyEvent) => HookOutcome \| Promise<HookOutcome>` | Last gate on the reply text. |
| `agent_end` | `(ev: AgentEndEvent) => void \| Promise<void>` | Fires after the reply is produced (observational). |

### `HookOutcome`

```ts
type HookOutcome = void | { readonly block: string } | { readonly replace: unknown };
```

| Outcome | Meaning |
| --- | --- |
| `void` (return nothing) | Continue — the value is unchanged. |
| `{ block: string }` | Reject. Throws `DivaGuardTripped` (turn-level) or surfaces to the model (tool-level). The string is the human-readable reason. |
| `{ replace: unknown }` | Substitute the value. For message/reply slots it **must** be a string, else `DivaHookError`. For a tool input it is re-validated against the tool's schema, else `DivaHookError`. For a tool output it passes through as-is. |

### Event types

| Event | Fields | Notes |
| --- | --- | --- |
| `BeforeAgentStartEvent` | `message: string`, `provider: string`, `model: string` (all `readonly`) | `replace` (string) rewrites `message`. |
| `BeforeToolCallEvent` | `tool: string`, `input: unknown`, `signal?: AbortSignal` (all `readonly`) | `signal` aborts at the tool's execute deadline; race it in await-based hooks. |
| `AfterToolCallEvent` | `tool: string`, `input: unknown`, `output: unknown` (all `readonly`) | `input` is the (possibly replaced) effective input. |
| `ReplyEvent` | `text: string`, `runId?: string` (all `readonly`) | Used by both `before_reply` and `final_reply_guard`. |
| `AgentEndEvent` | `message: string`, `reply: string`, `runId?: string` (all `readonly`) | `message` is the (possibly rewritten) outgoing message; `reply` is the final text. |

## Notes & caveats

- **Tool hooks require owning the host.** Declaring `before_tool_call` / `after_tool_call`
  (or `guard.tool` / `guard.toolOutput`) together with an explicit shared `client` throws at
  construction: *"A before_tool_call/after_tool_call hook or guard.tool/guard.toolOutput
  requires the agent to own its host — don't pass a shared `client` (use `clientOptions`)."*
  Turn-level hooks (`before_agent_start`, `before_reply`, `final_reply_guard`, `agent_end`)
  run purely in the SDK process and are fine with a shared client.
- **Unwired hooks fail loud.** All 15 non-wired RFC hook names throw
  `DivaNotImplementedError` at construction if you bypass the types and supply one — they are
  a later increment, never a silent no-op.
- **Hook errors are loud.** A handler that throws fails the turn with `DivaHookError` (its
  `detail.hook` names the guard, `detail.cause` carries the original error). Nothing is
  swallowed.
- **`agent_end` still fires on a blocked turn.** The reply chains run first; if a reply guard
  blocks, `agent_end` fires anyway (so audit observers see blocked turns) and then the block
  is re-raised. A block is preferred over an `agent_end` throw for the surfaced exception.
- **Soft vs. hard blocks matter.** A `before_tool_call` block never reaches your `catch`; it
  becomes a tool result the model sees. For a hard, caller-visible stop on tool behavior,
  pair it with a reply guard, or gate the tool with
  [`permissions.canUseTool`](./permissions.md).
- **`replace` re-validation.** A `before_tool_call` replace that fails the tool's zod schema
  throws `DivaHookError` — a hook cannot smuggle an off-shape input past the tool. A
  message/reply replace that is not a string throws `DivaHookError`.

## See also

- [Guards](./guards.md) — declarative tripwires that compile to these same hook chains.
- [Permissions](./permissions.md) — gate the engine's built-in tools (`canUseTool`).
- [Tools](./tools.md) — the client-side tools that `before_tool_call` / `after_tool_call` wrap.
- [Error handling](./error-handling.md) — `DivaGuardTripped`, `DivaHookError`, `DivaNotImplementedError`.
- [Agents](./agents.md) — the "owns its host" rule and shared clients.
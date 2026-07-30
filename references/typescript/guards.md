# Guards

Client-side business-rule guards: small `guard.*` factories that shape an agent's input, output,
and tool calls with tripwire semantics. They are sugar over [hooks](./hooks.md) (RFC §7) — each one
compiles to named hook handlers — so you get declarative policy (reject overly long replies, block a
tool call, put a human in front of a refund) without hand-writing hook chains.

## Guards are not the security gate

This is the most important thing to understand before using guards:

> **Guards gate *your own* client `tool()`s** — they are client-side, input-inspecting, and
> lightweight. **They cannot reach the engine's built-in tools** (`exec`/`read`/`write`/`web_*`),
> which live behind the MCP boundary. To gate built-ins — or *every* tool, fail-closed — use
> [`permissions.canUseTool`](./permissions.md), the engine-backed `before_tool_call` gate.

Rule of thumb: **`guard.tool` for your tools, `canUseTool` for built-ins / all.** Guards are
best-effort business-rule sugar, *not* a security boundary. When you need a hard, auditable gate,
reach for `permissions`.

## How guards work

Every guard compiles to a `Guard` (an alias for `CompiledHooks` — named handlers keyed by hook
name). Because guards compile to the **same per-name chains as user hooks** (merged via the same
machinery), any number of guards plus your own hooks coexist without collision. **User hooks run
before guards** per name, so a guard vets the value the caller will actually receive.

A tripped guard throws `DivaGuardTripped` with the guard's name and reason:

```ts
class DivaGuardTripped extends DivaError {
  readonly detail: { guard: string; reason: string };
}
// message: `${guard} blocked: ${reason}`
```

`DivaGuardTripped` is a *deliberate* block, distinct from `DivaHookError` (an *unexpected* throw in
guard/hook code). Name a guard with `label` to control its identity in that error.

### Hard abort vs soft block — the scope contract

The honest limits, straight from the source:

- **`guard.output` / `guard.custom` / `guard.input` map to turn hooks** → a trip **hard-aborts the
  turn** and throws `DivaGuardTripped` to the caller. In [`stream()`](./streaming.md) they act on
  the final `done.text` — they **cannot un-deliver deltas already streamed**.
- **`guard.tool` / `guard.toolOutput` map to tool hooks** → a **soft block**: the tool does not run
  (or its output is withheld) and the model is *told* so it can adapt, but — behind the MCP boundary
  — it **cannot abort the turn or throw** to the caller. Pair with a reply guard (`guard.output` /
  `guard.custom`) for a hard, caller-visible stop.
- **`guard.approval` maps to `before_tool_call`** → a soft block that additionally awaits a human
  decision (see below).

### Owning the host

`guard.tool`, `guard.toolOutput`, and `guard.approval` compile to `before_tool_call` /
`after_tool_call` hooks, which decorate *this agent's* client tools. A shared client's tools are its
own and already served, so such a guard cannot attach — the SDK fails loud at construction rather
than silently dropping it:

```
A before_tool_call/after_tool_call hook or guard.tool/guard.toolOutput requires the agent to own
its host — don't pass a shared `client` (use `clientOptions`).
```

Reply/input guards (`guard.output`, `guard.custom`, `guard.input`) run entirely in the SDK process
and impose no such requirement.

## Guard kinds at a glance

| Guard | Hook | Trip effect | Fires when |
| --- | --- | --- | --- |
| `guard.output` | `final_reply_guard` | hard abort | final reply exceeds `maxChars` or matches a blocklist term |
| `guard.custom` | `final_reply_guard` | hard abort | `fn(reply)` returns a non-empty reason string |
| `guard.input` | `before_agent_start` | hard abort | `when(message)` is true |
| `guard.tool` | `before_tool_call` | soft block | tool `name` is called **and** `when(input)` is true |
| `guard.toolOutput` | `after_tool_call` | soft block (hides output) | tool `name` returns **and** `when(output)` is true |
| `guard.approval` | `before_tool_call` | soft block (HITL) | tool `name` is called; `approve()` is awaited |

### `guard.output`

Reject a reply that exceeds `maxChars` (UTF-16 code units) or matches a blocklist term.

```ts
guard.output(opts: { maxChars?: number; blocklist?: (string | RegExp)[]; label?: string }): Guard
```

- A blocklist **string** is a case-insensitive substring; a **RegExp** is tested as-is. Use
  `/\bSSN\b/i` or `/\d{3}-\d{2}-\d{4}/` for real PII shapes — a literal string cannot match an SSN
  *value*.
- Throws `DivaError` if neither `maxChars` nor a non-empty `blocklist` is set:
  `guard.output(): set at least one of { maxChars, blocklist }.` (an empty guard is a silent no-op).
- Trip reasons: `reply exceeds ${maxChars} chars (${length})`, or `reply matches blocked term "…"`
  / `reply matches blocked pattern /…/`.

### `guard.custom`

Run a custom checker on the final reply (hard-abort on trip).

```ts
guard.custom(
  fn: (reply: ReplyEvent) => string | null | undefined | Promise<string | null | undefined>,
  opts?: { label?: string },
): Guard
```

- Return a **non-empty reason string** to trip; return `null`/`undefined`/`""` to pass.
- A **throw** in `fn` is loud (`DivaHookError`) — it is *not* a trip. Return a reason to trip.

### `guard.input`

A client-side check on the outgoing message, before the turn is sent (hard-abort on trip).

```ts
guard.input(opts: {
  when?: (message: string) => boolean;
  reason?: string;
  noPii?: boolean;
  label?: string;
}): Guard
```

- This is a **best-effort client predicate, not a security boundary.**
- `when` is required — omitting it throws `DivaError`:
  `guard.input(): set { when } (a predicate) — an empty guard does nothing.`
- `noPii` is the server-side PII gateway (platform Obscura), a *distinct* fail-closed control that
  is **not yet wired** and does not compose with `when`. Setting it throws `DivaNotImplementedError`:
  `guard.input({ noPii }) is the server-side PII gateway (platform Obscura) and is not yet wired.`

### `guard.tool`

Block a call to a named client tool when a predicate over its input is true. **Soft block.**

```ts
guard.tool(name: string, opts: {
  when: (input: unknown) => boolean;
  reason?: string;
  requireApprovalOver?: number;
  label?: string;
}): Guard
```

- Fires only for the tool named `name`; when `when(input)` is true the tool does not run and the
  model is told (default reason `tool "${name}" blocked by guard`).
- `requireApprovalOver` is threshold approval routing (RFC §10 serializable interruptions), which
  needs host support and is **not yet wired** — setting it throws `DivaNotImplementedError`:
  `guard.tool({ requireApprovalOver }) is threshold approval routing (RFC §10 serializable
  interruptions), which needs host support and is not yet wired. Use guard.approval() for
  synchronous in-tool human approval, or { when } for a soft block.`
- Requires the agent to own its host (tool-hook guard).

### `guard.toolOutput`

Withhold a tool's **output** from the model when a predicate over the output is true. **Soft** — the
side-effect already ran; this only hides the result.

```ts
guard.toolOutput(name: string, opts: {
  when: (output: unknown) => boolean;
  reason?: string;
  label?: string;
}): Guard
```

- Default reason: `tool "${name}" output blocked by guard`.
- To *redact/rewrite* rather than withhold, use a hooks `after_tool_call` `{ replace }` instead.
- Requires the agent to own its host (tool-hook guard).

### `guard.approval`

Human-in-the-loop approval for a tool call (RFC §10, synchronous form). **Soft block** that awaits a
human decision.

```ts
guard.approval(name: string, opts: {
  approve: (request: { tool: string; input: unknown; signal?: AbortSignal }) =>
    | { approved: boolean; editedInput?: unknown }
    | Promise<{ approved: boolean; editedInput?: unknown }>;
  reason?: string;
  label?: string;
}): Guard
```

- When tool `name` is called, `approve({ tool, input })` is awaited — put a human in that promise (a
  UI/Slack/CLI prompt). If not approved, the tool does **not** run and the model is told; if approved
  with `editedInput`, the call proceeds with that (schema-re-validated) input.
- **The tool blocks until `approve` resolves**, so the tool carrying this guard must set a generous
  `executeTimeoutMs` — a human takes longer than the 60s tool default.
- Races the tool-call deadline (`signal`): a late human decision is cancelled (the tool never runs)
  instead of ghost-executing → block reason `tool "${name}" approval deadline elapsed`.
- **Strict boolean:** a truthy non-boolean `approved` fails closed, not open →
  `approve() must return a boolean 'approved' (got …)`.
- Not approved → default block reason `tool "${name}" was not approved`.
- Marked `once` — interactive and side-effecting, it is not re-run when a later `replace` re-checks
  the chain.
- The serializable, resume-across-days variant (RFC §10 `RunState` / `result.interruptions`) needs
  host support and is a later increment.
- Requires the agent to own its host (tool-hook guard).

## Example

### Reply guards (mirrors `examples/guards.ts`)

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx guards.ts
import { Agent, DivaGuardTripped, guard } from "@diva-ai/sdk";

async function main(): Promise<void> {
  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "Answer briefly.",
    guards: [
      // Reject a reply that is too long or names a banned topic (hard abort).
      guard.output({ maxChars: 500, blocklist: ["password", "secret key"] }),
      // A custom tripwire on the reply.
      guard.custom((r) => (r.text.includes("http://") ? "insecure link in reply" : null)),
    ],
  });

  try {
    const { text } = await agent.run("Give me a one-line tip for strong passwords.");
    console.log("reply:", text);
  } catch (err) {
    if (err instanceof DivaGuardTripped) {
      console.error(`guard tripped: ${err.detail.guard} — ${err.detail.reason}`);
    } else {
      throw err;
    }
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### HITL tool approval (mirrors `examples/hitl.ts`)

`guard.approval` puts a human in front of a specific client tool. Note the generous
`executeTimeoutMs` — the tool blocks until the human decides.

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx hitl.ts
import { Agent, guard, tool, z } from "@diva-ai/sdk";

// In a real app, askHuman awaits a UI/Slack/CLI decision. Here we auto-deny
// large refunds and approve small ones.
async function askHuman(amount: number): Promise<boolean> {
  return amount <= 100;
}

const refund = tool({
  name: "refund",
  description: "Issue a refund for an order.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  // A human takes longer than the 60s default — give the tool room to block.
  executeTimeoutMs: 300_000,
  execute: async ({ orderId, amount }) => ({ orderId, refunded: amount }),
});

async function main(): Promise<void> {
  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "You are a support agent. Use the refund tool to issue refunds.",
    tools: [refund],
    guards: [
      guard.approval("refund", {
        approve: async ({ input }) => ({
          approved: await askHuman((input as { amount: number }).amount),
        }),
        reason: "refund not approved by a human",
      }),
    ],
  });

  try {
    const { text } = await agent.run("Refund $5000 for order 4512.");
    console.log(text); // the large refund is denied; the model is told
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## API

### `guard`

The factory object. Each method returns a `Guard`; pass an array of them as `AgentOptions.guards`.

| Method | Signature | Trip |
| --- | --- | --- |
| `guard.output` | `(opts: { maxChars?; blocklist?; label? }) => Guard` | hard abort |
| `guard.custom` | `(fn, opts?: { label? }) => Guard` | hard abort |
| `guard.input` | `(opts: { when?; reason?; noPii?; label? }) => Guard` | hard abort |
| `guard.tool` | `(name, opts: { when; reason?; requireApprovalOver?; label? }) => Guard` | soft block |
| `guard.toolOutput` | `(name, opts: { when; reason?; label? }) => Guard` | soft block (hides output) |
| `guard.approval` | `(name, opts: { approve; reason?; label? }) => Guard` | soft block (HITL) |

### `Guard`

```ts
type Guard = CompiledHooks; // named hook handlers keyed by hook name
```

An opaque compiled artifact — construct it with a `guard.*` factory, don't build it by hand.

### Not-yet-wired options (throw loud)

| Option | Error type | Reason |
| --- | --- | --- |
| `guard.tool({ requireApprovalOver })` | `DivaNotImplementedError` | RFC §10 threshold approval routing — needs host support |
| `guard.input({ noPii })` | `DivaNotImplementedError` | server-side PII gateway (platform Obscura) — not wired |

## Notes & caveats

- **Not a security boundary.** Guards are client-side, best-effort business-rule sugar. The security
  gate is [`permissions.canUseTool`](./permissions.md) plus the engine tool policy — reach for that
  when a hard, fail-closed, auditable gate is what you need.
- **Soft blocks don't abort the turn.** `guard.tool` / `guard.toolOutput` / `guard.approval` inform
  the model but cannot throw to the caller. Pair with a reply guard for a caller-visible stop.
- **Stream deltas already sent can't be recalled.** In `stream()`, reply guards act on the final
  `done.text` only.
- **Tool-hook guards need an owned host.** `guard.tool` / `guard.toolOutput` / `guard.approval` fail
  loud at construction if you pass a shared `client`; configure via `clientOptions`.
- **Empty guards throw.** `guard.output` with no `maxChars`/`blocklist` and `guard.input` with no
  `when` throw `DivaError` rather than silently doing nothing.
- **A throw in `guard.custom` is a `DivaHookError`, not a trip.** Return a reason string to trip.
- **User hooks run before guards** per hook name, so a guard vets the value the caller will actually
  receive.
- **Not-yet-wired options fail loud** (`DivaNotImplementedError`) — you can never accidentally depend
  on an unimplemented guard feature.

## See also

- [Permissions](./permissions.md) — the real security gate (`canUseTool`, mode presets, `deny`); use
  it for built-ins and for a fail-closed HITL over *every* tool.
- [Hooks](./hooks.md) — the lower-level hook chains guards compile to (`replace` to redact, custom
  chains).
- [Tools](./tools.md) — defining the client `tool()`s that `guard.tool` / `guard.approval` gate.
- [Error Handling](./error-handling.md) — `DivaGuardTripped`, `DivaHookError`,
  `DivaNotImplementedError`.
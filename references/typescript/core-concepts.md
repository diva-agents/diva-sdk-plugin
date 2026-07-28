# Core concepts

A short tour of the model behind the SDK: the two entry points, where the engine runs, the traffic
lock, model references, and what "owning the host" means. Understanding these makes every other page
click.

## Agent and DivaClient

There are two ways in:

- **`Agent`** — the high-level entry point. You give it a model and options; it creates and manages
  an implicit client for you. This is what you want 90% of the time. See [Agents](./agents.md).
- **`DivaClient`** — the low-level entry point for advanced use: dependency injection, holding
  several keys, or explicit lifecycle control. It owns the connection to the engine and exposes the
  typed turn RPC directly. Multiple `Agent`s can share one `DivaClient` (with a caveat — see
  [Owning the host](#owning-the-host)).

```ts
import { Agent, DivaClient } from "@diva-ai/sdk";

// High-level: implicit client
const agent = new Agent("diva/gpt/gpt-4o-mini");

// Advanced: explicit client, shared across agents
const client = new DivaClient({ apiKey: process.env.DIVA_API_KEY });
const support = new Agent("diva/gpt/gpt-4o-mini", { client, instructions: "Support." });
const sales = new Agent("diva/gpt/gpt-4o-mini", { client, instructions: "Sales." });
```

## Where the engine runs

The SDK is a **hosted-first thin client**. Rather than calling a model API directly, the client
connects to the **Diva engine** over a WebSocket and drives it with a typed RPC. The full agent
machinery lives in that engine: the model loop, tool routing, context compaction, and (when
self-hosted) the code-execution sandbox and built-in tools. The client never spawns or supervises a
local engine — it only ever connects to a remote gateway over the network.

**Where** the engine runs is a deployment choice — the API is identical in both modes:

- **Platform (default).** The published thin client connects to the Diva platform gateway with your
  `sk-diva-…` key. The engine runs **server-side and is never downloaded**.
- **Self-host (advanced).** Pass `clientOptions.remoteHost` (or set `DIVA_GATEWAY_URL`) to reach
  **your own** Diva gateway over the network — including one you run on `localhost` for development.

Call `agent.close()` (or `client.stop()`) when you're done — it closes the gateway connection. Full
details and precedence: **[Deployment](./deployment.md)**.

```
your process ───WS RPC───▶ Diva engine (server-side: platform or self-hosted)
     │  client tools over the turn WS   │  model loop · tool routing · compaction
     └──────────────────────────────────┘         │
                                                   └── Diva /v1 gateway ── model
```

### Client-side vs engine-side execution

This split is the crux of the security model:

- **Your client tools run in *your* process.** When you pass `tools: [...]`, the model's call is
  routed back over the turn's WebSocket and your `execute` closure runs locally. Your code, your
  privileges. See [Tools](./tools.md). **In the thin client every tool is a client tool**, so
  client-side gates (`canUseTool`, `guard.tool`, `flow`) cover every call the model can make.
- **The model loop and compaction run in the *engine*.** Engine built-ins and the code-execution
  sandbox are available only when you **self-host**; against the shared platform host they are
  fail-loud (RCE risk). See [Code execution](./code-execution.md) and [Deployment](./deployment.md).

## The traffic lock

Every LLM call goes through the **Diva platform `/v1` gateway**, authenticated by your `sk-diva-…`
key. There is **no bring-your-own-provider**: you never configure OpenAI/Anthropic/etc. keys, and the
base URL is fixed to the platform. This is by design — one key to manage, one egress to audit.

Practically: you authenticate once (`DIVA_API_KEY`), and choose models by their platform reference.

## Model references

A model is named `provider/model`:

```
diva/gpt/gpt-4o-mini
│    └──────────────┘
│         model id (provider-relative)
└── platform provider
```

The first segment (`diva`) is the **platform namespace** and is required — a bare model id (no
slash) is rejected at construction, because it could escape the platform routing. The engine
addresses the model by the stripped id (`gpt/gpt-4o-mini`) under that provider; the `diva/` prefix
is re-attached on the wire by the platform provider. You just pass the full reference.

## Sessions

By default each turn is **stateless** — the SDK mints a fresh random session key, so turns don't
share history. Pass a `sessionId` (per turn, or once via `agent.session(id)`) to make turns
**resumable**: the same id continues the same conversation, distinct ids stay isolated, and the id is
**hashed and scoped** to the agent's identity before it hits the wire (so it can never be guessed or
collide across users). Full mechanism and BYO local stores: [Sessions & memory](./sessions-and-memory.md).

## Owning the host

Some options configure the agent's own engine session — forwarded to the gateway with each turn — so
they can't be applied to a connection the agent doesn't control. These are:

`tools` · `mcp` · `params` · `thinkingDefault` · `compaction` · `flow` · `builtinTools` ·
`permissions` · `skills` (invocable) · tool hooks/guards (`before_tool_call` / `after_tool_call`).

If you pass one of these **and** a shared `client`, construction throws a clear `DivaError` telling
you to drop the shared client (configure the implicit client via `clientOptions` instead), or to set
that option on the `DivaClient` you pass. An `Agent` that uses any of them therefore **owns its
host**. Options that are pure client-side callbacks (like `onCompaction`) note their own rule on the
relevant page.

Rule of thumb: **share a `client` only for plain conversational agents.** The moment an agent needs
tools, built-ins, permissions, or host tuning, let it own its host (use `clientOptions` to configure
the implicit client).

## Lifecycle summary

1. `new Agent(model, options)` — validates options, prepares the (implicit) client. No connection yet.
2. First `run()` / `stream()` / `generate()` — connects to the gateway, then runs the turn.
3. Subsequent turns — reuse the live gateway connection.
4. `agent.close()` — closes the gateway connection.

## See also

- [Agents](./agents.md) — the full `Agent` API and options.
- [Deployment](./deployment.md) — platform (hosted) and self-host modes.
- [Getting started](./getting-started.md) — install and first agent.
- [Code execution](./code-execution.md) — the sandbox and the security model.
- [API reference](./api-reference.md) — every exported symbol.
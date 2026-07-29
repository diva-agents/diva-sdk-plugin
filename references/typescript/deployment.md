# Deployment — where the engine runs

`@diva-ai/sdk` is a **hosted-first thin client**. `new Agent(model, { apiKey })` opens a
WebSocket to a **remote Diva gateway** and runs the turn there — the agent loop, model
routing, tool orchestration, and compaction all run **server-side**. The client never
spawns or supervises a local engine; it only ever connects to a gateway over the network.

There are two ways to point it at a gateway. You pick a mode by **which options you pass** —
the code path is chosen for you at construction.

| Mode | How you select it | Where the engine runs | What ships to your machine |
| --- | --- | --- | --- |
| **Platform (default)** | `new Agent(model, { apiKey })` | The Diva platform, server-side | Nothing but the thin client |
| **Self-host (advanced)** | `clientOptions: { remoteHost: { url, token } }` or the `DIVA_GATEWAY_URL` env | Your own Diva gateway | Nothing — you already run the engine |

## 1. Platform — the hosted default

This is what a consumer of the published package gets. You pass an `sk-diva-…` key and the
SDK opens a WebSocket to the **platform gateway**; the Diva engine — the model loop, tool
routing, compaction, everything — runs **server-side and is never downloaded**. The package
is a thin, typed transport (like the OpenAI/Anthropic client): it carries no engine code and
no secrets beyond your key.

```ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  apiKey: process.env.DIVA_API_KEY, // sk-diva-…
  instructions: "You are a terse assistant.",
});

const { text } = await agent.run("Hi!");
await agent.close(); // closes the gateway connection
```

- **Gateway URL.** Defaults to `wss://api.diva-ai.ru/gateway`. Override with `DIVA_GATEWAY_URL`
  (used for staging, preview, or pointing at a Diva-provided endpoint).
- **Your tools stay yours.** Any `tool()` / MCP server you attach executes **in your process**
  over the turn's WebSocket (see [Tools](./tools.md), [MCP](./mcp.md)). The engine never sees
  your tool code, only its declared schema and the model's call.
- **Why it's thin.** Keeping the engine server-side is deliberate: the Diva runtime is the
  product, so it is never bundled into the client, and every LLM call is billed and audited on
  the platform.

```
your process ───WS RPC───▶ Diva engine (server-side, on the platform)
     │  client tools over the turn WS   │  model loop · tool routing · compaction
     └──────────────────────────────────┘         │
                                                   └── Diva /v1 gateway ── model
```

## 2. Self-host — bring your own engine (advanced)

Run a Diva gateway yourself and point the SDK at it. Same client, same API — only the endpoint
changes. Use this when you want the engine on your own infrastructure, or for local development
against a gateway running on `localhost`.

```ts
const agent = new Agent("diva/gpt/gpt-4o-mini", {
  clientOptions: {
    apiKey: process.env.DIVA_API_KEY,
    remoteHost: { url: "wss://engine.internal.example.com/gateway", token: process.env.GATEWAY_TOKEN },
  },
});
```

An explicit `remoteHost` **always wins** over apiKey routing. Alternatively, set
`DIVA_GATEWAY_URL=ws://…` in the environment and keep passing just `apiKey` — the SDK connects
there with the apiKey as the token. Because the client is hosted-only and never spawns an
engine, local development is just the self-host path aimed at a gateway you run on `localhost`.

## Selection precedence

The client resolves the gateway to connect to in this order:

1. **Explicit `remoteHost`** → self-host (mode 2). No `apiKey` needed — the bearer token in
   `remoteHost` authenticates.
2. **`DIVA_GATEWAY_URL` pinned** → connect there with the `apiKey` as the token (self-host /
   testing endpoint).
3. **`apiKey` only** → the platform gateway (`wss://api.diva-ai.ru/gateway`), mode 1.

If none of the three is available, construction throws an actionable `DivaAuthError`. If the
resolved gateway can't be reached, the SDK fails with a `DivaRequestError` naming the endpoint
and telling you to set `DIVA_GATEWAY_URL` or pass `clientOptions.remoteHost` — never an opaque
WebSocket error.

## Host-owned config: what is hosted vs self-host only

A few options configure the **engine host itself** — a security/deployment decision the gateway
owns. Against the hosted platform they are **fail-loud**: they throw `DivaNotImplementedError`
rather than silently do nothing.

- **`builtinTools`** and **`permissions.mode` / `permissions.deny`** — these enable or govern
  the engine's shell/filesystem/network built-ins. Turning them on for a *shared* platform host
  would be remote code execution on the platform for anyone with a key, so they are **self-host
  only**. To get the same effect on the hosted client, wrap what you need as your **own client
  `tool()`** (it runs on *your* machine — you sandbox it there) or self-host the engine and enable
  them there.

Everything else works over the hosted client and per-turn: `tools`, `mcp`, `params`,
`thinkingDefault`, `compaction`, invocable `skills`, `flow`, `hooks`, `guards`, sub-agents
(`handoff`), and interactive `permissions.canUseTool` / `permissions.allow`. In the hosted
client **all** tools are client tools, so client-side gates (`canUseTool`, `guard.tool`, `flow`)
cover every call the model can make — there is no host-executed tool to slip past them.

## See also

- [Getting started](./getting-started.md) · [Core concepts](./core-concepts.md)
- [Tools](./tools.md) · [MCP](./mcp.md) · [Permissions](./permissions.md) · [Flow](./flow.md)
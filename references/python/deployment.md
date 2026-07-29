# Deployment — where the engine runs

`diva_ai` is a **hosted-first thin client**. `Agent(model, api_key=...)` opens
a WebSocket to a Diva gateway and runs the turn there — the agent loop, model
routing, and tool orchestration all run **server-side**. Your Python process
never spawns or supervises a local engine; it only ever connects to a gateway
over the network, opening and closing a fresh connection for every
`run()` / `stream()` call.

There is one client class, `Agent`, and one axis that decides where it
connects: **which gateway URL it resolves to**, evaluated lazily at the start
of the first turn (not at construction — see
[Error handling](./error-handling.md)).

| Mode | How you select it | Where the engine runs | What ships to your machine |
| --- | --- | --- | --- |
| **Platform (default)** | `Agent(model, api_key=...)` with no `gateway_url=` / `DIVA_GATEWAY_URL` | The Diva platform, server-side | Nothing but the thin client |
| **Self-host (advanced)** | `gateway_url=...` or the `DIVA_GATEWAY_URL` env | Your own Diva gateway | Nothing — you already run the engine |

## 1. Platform — the hosted default

This is what a consumer of the published package gets. You pass an
`sk-diva-…` key (or set `DIVA_API_KEY`) and the SDK opens a WebSocket to the
platform gateway; the Diva engine — the model loop, tool routing, everything
— runs **server-side and is never downloaded**. The package is a thin, typed
transport: it carries no engine code and no secret beyond your key.

```python
import asyncio
import os
from diva_ai import Agent


async def main() -> None:
    agent = Agent(
        "diva/gpt/gpt-4o-mini",
        api_key=os.environ["DIVA_API_KEY"],  # sk-diva-...
        instructions="You are a terse assistant.",
    )
    result = await agent.run("Hi!")
    print(result.text)
    await agent.close()  # tears down any MCP connections


asyncio.run(main())
```

- **Gateway URL.** Defaults to `wss://api.diva-ai.ru/gateway`
  (`DEFAULT_GATEWAY_URL` in `diva_ai.gateway_client`). Override with
  `DIVA_GATEWAY_URL` (staging, preview, or a Diva-provided endpoint) or the
  `gateway_url=` constructor argument.
- **Your tools stay yours.** Any `tool()` / MCP server you attach executes
  **in your process** over the turn's WebSocket (see
  [Tools & toolsets](./tools.md)). The engine never sees your tool code, only
  its declared schema and the model's call.
- **Why it's thin.** The runtime is the product, so it's never bundled into
  the client. The same server-side engine backs both the Python and the
  TypeScript SDKs — session-key hashing is byte-identical between them, so a
  Python and a TS client can resume the same server-side conversation.

```
your process ───WS RPC───▶ Diva engine (server-side, on the platform)
     │  client tools over the turn's WS   │  model loop · tool routing
     └────────────────────────────────────┘         │
                                                      └── Diva gateway ── model
```

## 2. Self-host — bring your own engine (advanced)

Run a Diva gateway yourself and point the SDK at it. Same `Agent`, same API —
only the resolved URL changes. Use this to run the engine on your own
infrastructure, or for local development against a gateway on `localhost`.

```python
import os
from diva_ai import Agent

agent = Agent(
    "diva/gpt/gpt-4o-mini",
    api_key=os.environ["GATEWAY_TOKEN"],  # bearer token for YOUR gateway
    gateway_url="wss://engine.internal.example.com/gateway",
)
```

Or set `DIVA_GATEWAY_URL=ws://localhost:5002/gateway` and keep passing just
`api_key=` — the SDK connects there instead, using that same key as the
bearer token. **Unlike the TypeScript SDK's `clientOptions.remoteHost: {url,
token}`, Python does not separate a "platform key" from a "self-host
token"** — there's a single `api_key` (or `DIVA_API_KEY`) used as the bearer
token for whichever `gateway_url` is resolved.

### `ws://` is restricted

The gateway URL is validated the moment a connection opens (start of the
first turn), not at construction: `wss://` is always allowed; a plain
`ws://` target is allowed only to `localhost` / `127.0.0.1` / `::1` or
another loopback address. To point `ws://` at a private-network host (a
gateway on your LAN or in a private VPC), opt in explicitly:

```bash
export DIVA_ALLOW_INSECURE_PRIVATE_WS=1
```

Any other `ws://` target, or a scheme that's neither `ws://` nor `wss://`,
raises `DivaAuthError` naming the rejected host in the message — never a
silent downgrade to an insecure connection, and never an opaque socket error.

## Selection precedence

`Agent` resolves the gateway URL in this order, evaluated lazily on the
first turn:

1. **`gateway_url=` passed to `Agent(...)`.**
2. **`DIVA_GATEWAY_URL` environment variable.**
3. **`DEFAULT_GATEWAY_URL`** (`wss://api.diva-ai.ru/gateway`) — the platform.

The bearer token is always `api_key=` (or `DIVA_API_KEY`) — there's no
separate token source for either mode. If no API key is resolvable when a
turn starts, construction has already succeeded but the turn raises an
actionable `DivaAuthError`; if the resolved gateway can't be reached, the
turn raises `DivaHostError` wrapping the underlying connection failure. See
[Error handling](./error-handling.md).

## Host-owned config: what is hosted vs self-host only

The TypeScript SDK draws a line between engine built-ins that are safe to
run against your own self-hosted gateway (`builtinTools`,
`permissions.mode` / `permissions.deny`) and the hosted platform, where
enabling them would be remote code execution for anyone with a key.
**`diva_ai` doesn't draw that line at all — it never exposes these engine
built-ins, on either target:**

- There's no `builtin_tools` parameter on `Agent` in this SDK.
- `Permissions.mode` and `Permissions.deny` always raise
  `DivaNotImplementedError` at construction, regardless of whether
  `gateway_url` points at the platform or at a gateway you run yourself.
  `diva_ai.Agent` is a thin client end-to-end — self-hosting the *gateway*
  doesn't change what the *Python client* exposes.

To get the same effect, wrap what you need as your own client `tool()` (it
runs on *your* machine, so you sandbox it there — see
[Tools & toolsets](./tools.md)); the same escape hatch the TypeScript SDK
documents for its hosted mode.

Everything else works the same regardless of which gateway you point at, and
per-turn: `tools`, `toolsets`, `mcp`, `params`, `thinking_default`, local
`skills` (`skill()` / `skill_from_dir()` — a platform *string* skill ref
still raises `DivaNotImplementedError`; see
[Error handling](./error-handling.md)), `flow`, `hooks`, `guards`,
sub-agents (`handoff`), and interactive `Permissions.can_use_tool` /
`Permissions.allow`. Because in `diva_ai` **all** tools are client tools,
client-side gates (`can_use_tool`, `guard.tool`, `flow`) cover every call the
model can make — there's no host-executed tool to slip past them.

## See also

- [Overview](./overview.md) · [Quickstart](./quickstart.md)
- [Tools & toolsets](./tools.md) — client tools, MCP servers, and `Permissions`.
- [Error handling](./error-handling.md) — `DivaAuthError` / `DivaHostError` and exactly when each fires.
- [Model configuration](./model-configuration.md) — `params` and `thinking_default`, which work identically over either gateway target.
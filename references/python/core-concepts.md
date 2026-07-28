# Core concepts

A short tour of the model behind the SDK: the two classes involved, where the engine
runs, the traffic lock, model references, and what session scoping actually hashes.
Understanding these makes every other guide click.

## Agent and DivaClient

There are two classes in the picture:

- **`Agent`** — the high-level entry point. You give it a model ref and keyword
  options; it lazily creates and owns an implicit `DivaClient` for you. This is
  what you want essentially all the time. See [Agents](./agents.md).
- **`DivaClient`** — the low-level engine connector. Constructed from a bare
  `gateway_url` and API `token`, it exposes the typed turn RPCs directly:
  `run_agent_turn()`, `stream_agent_turn()`, `close()`. Every `Agent` creates one
  internally, on first use.

```python
import asyncio
from diva_ai import Agent

async def main() -> None:
    # High-level: implicit client, created lazily on the first turn
    agent = Agent("diva/gpt/gpt-4o-mini")
    result = await agent.run("Hello!")
    print(result.text)
    await agent.close()

asyncio.run(main())
```

Unlike the TypeScript SDK, `Agent` does **not** currently accept an explicit
client for dependency injection — there is no `client=` (or `client_options=`)
constructor parameter, so a `DivaClient` cannot be shared across several
`Agent`s yet. `DivaClient` remains part of the public surface
(`from diva_ai import DivaClient`) as the natural extension point for that later,
but today it's an implementation detail `Agent` drives for you rather than
something with a documented direct-use pattern.

## Where the engine runs

The SDK is a **hosted-first thin client**. Rather than calling a model API
directly, it connects to the **Diva engine** over a WebSocket and drives it with
a typed RPC. The full agent machinery lives in that engine: the model loop, tool
routing, and context compaction. The client never spawns or supervises a local
engine — it only ever connects to a remote gateway over the network.

**Where** the engine runs is a deployment choice — the API is identical in both
modes:

- **Platform (default).** `Agent(model, api_key=...)` (or the `DIVA_API_KEY` env
  var) connects to the Diva platform gateway at `wss://api.diva.ai/gateway` — the
  SDK's built-in `DEFAULT_GATEWAY_URL`. The engine runs **server-side and is
  never downloaded**.
- **Self-host (advanced).** Pass `gateway_url=` (or set `DIVA_GATEWAY_URL`) to
  reach **your own** Diva gateway over the network — including one you run on
  `localhost` for development. `wss://` is always allowed; a plain `ws://`
  target is accepted only to a loopback host (or, with an explicit opt-in env
  var, other private-network ranges) — the SDK refuses to send your bearer token
  over an insecure socket anywhere else.

Call `await agent.close()` when you're done — it tears down the client and any
bridged MCP connections.

```
your process ───WS RPC───▶ Diva engine (server-side: platform or self-hosted)
     │  client tools over the turn WS   │  model loop · tool routing · compaction
     └──────────────────────────────────┘         │
                                                   └── Diva /v1 gateway ── model
```

### Client-side vs engine-side execution

This split is the crux of the security model:

- **Your client tools run in *your* process.** When you pass `tools=[...]`, the
  model's call is routed back over the turn's WebSocket and your `execute`
  callable runs locally — sync or async, your code, your privileges. See
  [Tools & toolsets](./tools.md). **In the thin client every tool is a client
  tool**, so `permissions.can_use_tool`, `hooks`, and `guards` cover every call
  the model can make.
- **The model loop and compaction run in the *engine*.** The Python SDK does not
  yet expose engine built-ins or a code-execution sandbox — there is no
  `builtin_tools`-style option on `Agent`. The model can only ever call the
  `tools` / `toolsets` / `mcp` you hand it, whether you're on the platform or
  self-hosting.

## The traffic lock

Every LLM call goes through the **Diva platform `/v1` gateway**, authenticated by
your `sk-diva-…` key. There is **no bring-your-own-provider**: you never
configure OpenAI/Anthropic/etc. keys, and the gateway target is either the
platform default or a gateway you explicitly point the client at — never a
per-provider base URL. This is by design — one key to manage, one egress to
audit.

Practically: you authenticate once (`DIVA_API_KEY` or `api_key=`), and choose
models by their platform reference.

## Model references

A model is named `provider/model`:

```
diva/gpt/gpt-4o-mini
│    └──────────────┘
│         model id (provider-relative)
└── platform provider
```

`split_model_ref()` splits on the **first** `/`, returning `(provider, model)`.
The first segment (`diva`) is the **platform namespace**; the engine addresses
the model by the stripped id (`gpt/gpt-4o-mini`) under that provider. You just
pass the full reference:

```python
from diva_ai import Agent, split_model_ref

split_model_ref("diva/gpt/gpt-4o-mini")  # -> ("diva", "gpt/gpt-4o-mini")

agent = Agent("diva/gpt/gpt-4o-mini")
```

`Agent(model)` rejects a blank/whitespace-only ref at construction with a
`DivaAuthError`. Note one gap versus the TypeScript client: TS re-validates the
namespace on **every** turn (`resolveSelector`) and raises locally if it's
missing; the Python client does not re-check this per turn — a bare id like
`"gpt-4o-mini"` (no slash) is accepted locally and simply sends an empty
`provider` field on the wire. The platform gateway still requires a namespaced
ref, so a missing namespace still fails — just as a server-side error rather
than a local `DivaError`. Always use the full ref from the platform's model
listing.

## Sessions

By default each turn is **stateless** — the SDK mints a fresh random session id,
so turns don't share history. Pass `session_id=` (per call, or once via
`agent.session(session_id)`) to make turns **resumable**: the same id continues
the same conversation, distinct ids stay isolated.

The id is never sent verbatim. It's hashed and folded into a scope digest built
from the agent's identity — the full model ref, the raw `instructions` string,
and the composed skill names — before it hits the wire, as
`diva-sdk:<scope-digest>:<session-id-digest>`. This mirrors the TS client's
digest recipe (same inputs, same intent: two logically-distinct agents sharing a
gateway never interleave into one conversation). One honest caveat straight from
the source: byte-for-byte parity between the Python and TS digest algorithms is
called out in-code as a pending verification item, so don't rely on a session
started in one SDK resuming cleanly in the other without checking your SDK
versions first.

## Owning the host

The TypeScript SDK draws a line around options that configure the agent's own
engine session (`tools`, `mcp`, `params`, `thinkingDefault`, `flow`,
`permissions`, …): passing one of those **and** a shared `client` throws at
construction, because a shared client's session config can't be reconfigured
per agent.

That entire class of conflict doesn't exist in the Python SDK today, because the
Python SDK doesn't expose client sharing in the first place — `Agent.__init__`
has no `client=` parameter. Every `Agent` always creates and owns exactly one
implicit `DivaClient`. Practically: pass any combination of `tools`, `toolsets`,
`mcp`, `params`, `thinking_default`, `permissions`, `flow`, `skills`, `hooks`,
and `guards` you like — none of them can conflict with a shared client, because
there is no shared-client feature yet to conflict with.

## Lifecycle summary

1. `Agent(model, *, ...)` — validates options eagerly (bad `thinking_default`,
   `permissions`, duplicate tool names, duplicate MCP server names, a blank
   model, …); no network activity yet.
2. First `run()` / `stream()` / `generate()` — lazily resolves `api_key` /
   `gateway_url`, creates the implicit `DivaClient`, connects any declared MCP
   servers, then opens a gateway WebSocket connection for that turn.
3. Subsequent turns — reuse the same `DivaClient` instance, but each turn
   currently opens and closes **its own** gateway connection rather than
   reusing one held open across turns (`DivaClient.close()` is a no-op today —
   there's no persistent connection for it to tear down).
4. `await agent.close()` — closes any bridged MCP connections and drops the
   client reference.

## See also

- [Agents](./agents.md) — the full `Agent` API and options.
- [Tools & toolsets](./tools.md) — defining client-side tools.
- [Toolsets](./toolsets.md) — grouping tools into named, reusable sets.
- [Overview](./overview.md) — install and what the SDK is.
- [Quickstart](./quickstart.md) — your first agent turn.
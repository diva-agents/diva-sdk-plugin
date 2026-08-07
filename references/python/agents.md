# Agents

`Agent` is the top-level entry point of `diva_ai`. You construct one with a
model ref and a set of keyword options, then call `run()`, `stream()`, or
`generate()` to take a turn. Under the hood the agent connects to the Diva
engine over a typed WebSocket RPC and drives it; the agent loop and tool
routing run in that engine, server-side. Where it runs — the Diva platform
(default) or your own self-hosted gateway — is a deployment choice with an
identical API. See [Core concepts](./core-concepts.md).

Every LLM call is routed through the Diva `/v1` gateway on your `sk-diva-…` key
(env `DIVA_API_KEY`). There is no bring-your-own-provider — the model ref names
a platform-namespaced model and the turn can never escape the gateway.

## Constructing an agent

```python
from diva_ai import Agent

agent = Agent(
    "diva/gpt/gpt-4o-mini",
    instructions="You are a terse, friendly assistant.",
)
```

`Agent(model, *, ...)`:

- `model` (`str`, required, positional) — the platform model ref, e.g.
  `"diva/gpt/gpt-4o-mini"`. An empty/blank model raises `DivaAuthError`:
  `Agent(model) requires a namespaced model ref, e.g. 'diva/<family>/<model>'`.
- every other option is a named, **keyword-only** parameter (the constructor
  signature puts `*` right after `model` — not a `**kwargs` catch-all) — see
  the table below.

The constructor validates eagerly: a bad `thinking_default`, `permissions`
value, a duplicate tool name across `tools` + `toolsets`, or a duplicate MCP
server name all raise before the agent is even usable, rather than surfacing
as an opaque failure on the first turn.

### The model ref: provider + model

A Diva model ref names the platform provider in its first segment.
`split_model_ref()` splits on the **first** `/`:

| Ref | provider | model (engine-relative id) |
| --- | --- | --- |
| `"diva/gpt/gpt-4o-mini"` | `diva` | `gpt/gpt-4o-mini` |
| `"diva/deepseek/deepseek-v4-flash"` | `diva` | `deepseek/deepseek-v4-flash` |
| `"gpt-4o-mini"` (no namespace) | `""` | `"gpt-4o-mini"` |

The leading provider segment routes the turn through the Diva provider; the
engine addresses the model by the stripped, provider-relative id under it.
`Agent` checks only that the ref is non-blank at construction — it does not
re-validate the namespace on every turn. A ref without one (e.g.
`"gpt-4o-mini"`) is accepted locally and sent with an empty `provider` field;
the platform still requires the namespace, so it will still be rejected — just
server-side, not as a local `DivaError`. Always use the full ref from the
platform's model listing. See [Core concepts](./core-concepts.md).

## Constructor options

Every option beyond `model` is optional. Names are `snake_case`; a few (noted
below) accept dicts whose *keys* pass straight through to the wire and must
keep the platform's own spelling.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `api_key` | `str \| None` | `DIVA_API_KEY` env | Your `sk-diva-…` key. Selects the platform engine. To reach your own engine, pass `gateway_url=` instead. |
| `instructions` | `str \| None` | `None` | System prompt: the agent's persona / task framing. |
| `tools` | `list[ToolDefinition] \| None` | `None` | Client-side tools the agent can call (built with `tool(...)`). Names must be unique across `tools` + `toolsets`; a duplicate raises `DivaError` at construction. See [Tools & toolsets](./tools.md). |
| `toolsets` | `list[Toolset] \| None` | `None` | Named groups of client-side tools (via `toolset(name, tools)`), composed alongside `tools`. See [Toolsets](./toolsets.md). |
| `gateway_url` | `str \| None` | `DIVA_GATEWAY_URL` env, else the platform default | Point at your own self-hosted gateway (`ws://localhost:...` for local dev, or any `wss://` host). |
| `thinking_default` | `ThinkingLevel \| None` | `None` | Default reasoning level: one of `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"adaptive"`. Validated at construction — a bad value raises `DivaError`. |
| `params` | `dict[str, Any] \| None` | `None` | Generation params applied to every turn, sent **verbatim** as the wire's `streamParams` — use the platform's own key spelling, e.g. `{"maxTokens": 500, "temperature": 0.2}`, not a snake_cased translation. Unknown keys pass through to the provider. |
| `permissions` | `Permissions \| None` | `None` | Per-call tool gating. Only `can_use_tool` + `allow` are wired today; setting `mode` or a non-empty `deny` raises `DivaNotImplementedError` (see Notes below). |
| `store` | `SessionStore \| None` | `None` | Client-side conversation storage (`MemoryStore`, `FileStore`, or your own object implementing `load`/`append`/`clear`). Moves history into YOUR store instead of Diva's server-side sessions; each server turn becomes stateless and prior turns are injected as fenced reference data. |
| `hooks` | `Hooks \| None` | `None` | Client-side lifecycle hooks: `before_agent_start`, `before_tool_call`, `after_tool_call`, `before_reply`, `final_reply_guard`, `agent_end`. Each is `Callable[[dict], dict | None]`, sync or async. |
| `guards` | `list[Hooks] \| None` | `None` | Declarative sugar over hooks — build entries with `guard.output(...)`, `guard.input(...)`, `guard.tool(...)`, `guard.tool_output(...)`, or `guard.custom(...)`; each returns a `Hooks` object to add to the list. A tripped guard raises `DivaGuardTripped` naming it. Merged with `hooks` (per-name chains). |
| `skills` | `list[Skill] \| None` | `None` | Named instruction/knowledge blocks, built with `skill(...)` / `skill_from_dir(...)`. Composed directly into the system prompt on every turn. A `"platform:<name>"` string ref raises `DivaNotImplementedError` (not yet wired). |
| `mcp` | `list[McpServer] \| None` | `None` | External MCP servers (`MCP.stdio(...)` / `MCP.http(...)`) whose tools join the agent. Requires the `diva-ai[mcp]` extra. Connected locally by the SDK and bridged as client tools named `<server>__<tool>`. Duplicate server names raise `DivaError`. |
| `flow` | `Flow \| None` | `None` | A slot-filling funnel built with `flow(...)`. Executed entirely client-side — the compiled frame is compiled into hooks (tool gates, slot-fill tracking, narration guard) by the SDK's own flow interpreter. |
| `knowledge` | `str \| None` | `None` | Not yet wired. Passing anything raises `DivaNotImplementedError` immediately at construction, and the message names the HTTP API that IS live: `POST /api/v1/agi/sdk/kb/collections` + `/collections/{id}/chunks`, after which the corpus becomes a search tool on the agent's next turn. Both sources reach the agent — `source="platform"` (we embed your text) and `source="byo"` (you send vectors; we index the same text with our embedder, `agent_search="shadow"` by default). The field exists so the surface is stable. |

> There is no `client=` / `client_options=` parameter — every `Agent` always
> creates and owns its own implicit `DivaClient`, so none of the options above
> can conflict with a shared client the way they do in the TypeScript SDK. See
> the "Owning the host" section in [Core concepts](./core-concepts.md).

## Call options

`session_id`, `timeout`, and `model` are accepted as keyword arguments by
`run()` and `stream()` (and `model`, but not `session_id`, by `generate()` —
see below):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `session_id` | `str \| None` | fresh random UUID | Conversation id for multi-turn continuity: successive calls with the same id share history. Omit for a stateless turn. |
| `timeout` | `float \| None` | the client's internal default (120s for a turn) | Per-call timeout **in seconds** — note this is seconds, not milliseconds. |
| `model` | `str \| None` | the Agent's own model | Per-call model override (a full platform ref, e.g. `"diva/gpt/gpt-4o-mini"`); the namespace convention still applies, though it isn't locally re-validated (see above). |

## Call methods

### `run(message, *, session_id=None, timeout=None, model=None) -> AgentResult`

Runs one turn and returns the assistant's reply.

```python
result = await agent.run("Give me one commit-message tip.")
print(result.text)
```

`AgentResult`:

| Field | Type | Description |
| --- | --- | --- |
| `text` | `str` | The assistant's text reply (final answer only — reasoning and compaction notices are stripped). |
| `reasoning` | `str \| None` | The model's reasoning trace, when the engine reports it separately. |
| `run_id` | `str \| None` | The run id assigned by the engine. |
| `usage` | `Usage \| None` | Token usage for the turn when the engine reports it: `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`, `cache_write_tokens`. Prices are not computed — multiply by your own per-model rates. |
| `duration_ms` | `float \| None` | Wall-clock duration of the turn in ms. |
| `stop_reason` | `str \| None` | Why the turn stopped (e.g. `"stop"`, `"length"`). |

`usage` / `duration_ms` / `stop_reason` ride on `AgentResult`, the `stream()`
`DoneChunk`, and `StructuredResult` — so cost/latency accounting needs no
extra call.

If the turn returns no result payloads, an error payload, or a reply that
looks like a raw gateway HTTP error envelope (e.g. `"HTTP 429: ..."`), `run()`
raises `DivaRequestError` rather than returning empty or malformed text.

### `stream(message, *, session_id=None, timeout=None, model=None) -> AsyncIterator[AgentStreamChunk]`

Streams one turn: yields incremental `DeltaChunk`s as text is produced, then a
single terminal `DoneChunk`. Same turn semantics as `run()`.

```python
from diva_ai import DeltaChunk, DoneChunk

async for chunk in agent.stream("List three uses for a paperclip."):
    if isinstance(chunk, DeltaChunk):
        print(chunk.delta, end="", flush=True)
    elif isinstance(chunk, DoneChunk):
        print(f"\n[done] run_id={chunk.run_id}")
```

`AgentStreamChunk` is a union: `DeltaChunk | ReasoningChunk | DoneChunk`. Only
`DeltaChunk` and `DoneChunk` are actually yielded today — `ReasoningChunk` is
declared for when the engine surfaces a separate reasoning stream, but isn't
produced yet.

Breaking out of the loop (or otherwise letting the generator go out of scope)
tears down the in-flight local request and any pending tool-call tasks through
the generator's own cleanup path; for prompt, deterministic cancellation, wrap
the loop in `contextlib.aclosing()` or call `.aclose()` on the generator
explicitly rather than relying on garbage collection.

### `generate(message, schema, *, timeout=None, model=None) -> StructuredResult`

Runs one turn and returns a typed, schema-validated result. The model is
instructed to reply with only JSON matching a `pydantic.BaseModel` subclass;
the reply is parsed, validated, and re-asked once on failure.

```python
from pydantic import BaseModel
from diva_ai import Agent

class Lead(BaseModel):
    name: str
    email: str

result = await agent.generate(
    "Extract the lead from: 'Hi, I'm Ada (ada@example.com), want to buy 10 seats.'",
    Lead,
)
result.output.email  # typed, validated Lead instance
```

Signature: `generate(message: str, schema: type[TSchema], *, timeout=None, model=None) -> StructuredResult`
where `TSchema` is bound to `pydantic.BaseModel`.

`StructuredResult`:

| Field | Type | Description |
| --- | --- | --- |
| `output` | your schema type | The validated instance of `schema`. |
| `text` | `str` | The raw reply text that was parsed. |
| `attempts` | `int` | `1` if the first reply validated, `2` if the repair retry was needed. |
| `repaired` | `bool` | Whether the repair retry ran. |
| `run_id` / `usage` / `duration_ms` / `stop_reason` | — | Same as `AgentResult`, from the attempt that succeeded. |

Note `generate()` has **no `session_id` parameter** — it always runs both the
initial ask and the (possible) repair retry inside a fresh, private
`generate:<uuid>` session, so a validation retry keeps its own context without
ever joining any conversation you're tracking with `run()` / `stream()` /
`session()`. If both attempts fail validation, it raises `DivaRequestError`
(`"generate(): reply failed schema validation after one retry: …"`) with
`detail={"provider": ..., "model": ...}`.

## Sessions

### `session(session_id=None) -> AgentSession`

Opens a multi-turn conversation. Successive `run()` / `stream()` calls on the
returned `AgentSession` share history (server-side by default, or in the
agent's `store`). Omit `session_id` for a fresh conversation (a random UUID is
minted); pass one to resume.

```python
chat = agent.session()                       # fresh conversation
await chat.run("My name is Ada.")
(await chat.run("What's my name?")).text      # -> "…Ada…"

resumed = agent.session("user-42")            # resume by stable id
```

`AgentSession` only proxies `run()` and `stream()` — there's no
`AgentSession.generate()`. If you need schema-validated output mid-conversation,
call `agent.generate(...)` directly; as noted above, it always uses its own
disjoint session regardless.

Internally the caller's `session_id` is **hashed** into the wire session key
(never interpolated verbatim), scoped by the agent's identity digest (model +
raw instructions + skill names). See the "Sessions" section in
[Core concepts](./core-concepts.md) for the exact digest recipe and its
cross-SDK caveat.

## Host lifecycle

### `close() -> None`

Closes any bridged MCP connections and drops the agent's implicit
`DivaClient`. Always call it in a `finally` block:

```python
agent = Agent("diva/gpt/gpt-4o-mini")
try:
    result = await agent.run("Hello!")
    print(result.text)
finally:
    await agent.close()
```

There is currently no `start()` / pre-warm method — the first `run()` /
`stream()` / `generate()` call pays the full cost of resolving the client and
connecting MCP servers itself.

## Example: an agent with tools

```python
import asyncio
from pydantic import BaseModel
from diva_ai import Agent, tool

class WeatherInput(BaseModel):
    city: str

async def get_weather(inp: WeatherInput) -> str:
    return f"It is 21°C and clear in {inp.city}."

async def main() -> None:
    weather_tool = tool(
        name="get_weather",
        description="Current weather for a city.",
        input_schema=WeatherInput,
        execute=get_weather,
    )

    agent = Agent(
        "diva/gpt/gpt-4o-mini",
        instructions="You are a travel assistant. Use tools when asked about weather.",
        tools=[weather_tool],
        params={"temperature": 0.2, "maxTokens": 400},
    )

    try:
        result = await agent.run("What's the weather in Lisbon?")
        print(result.text)
    finally:
        await agent.close()

asyncio.run(main())
```

## Notes & caveats

- **No client-sharing conflicts.** Because `Agent` has no `client=` parameter,
  none of `tools`, `toolsets`, `mcp`, `params`, `thinking_default`,
  `permissions`, `flow`, or `skills` can conflict with a shared client the way
  they do in the TypeScript SDK — there's no such feature yet to conflict with.
- **`knowledge` fails loud.** Passing it raises `DivaNotImplementedError`
  immediately at construction — *"knowledge/RAG is not wired in the thin
  client yet."* The field exists so the surface is stable; it is not yet
  functional.
- **`permissions.mode` / `permissions.deny` fail loud too.** They target
  engine built-ins the thin/hosted client doesn't expose, and raise
  `DivaNotImplementedError` at construction. Use `can_use_tool` (+ `allow`) to
  gate your own client tools instead.
- **`permissions.approval_timeout_ms` is validated but inert.** It's
  bounds-checked at construction (positive, ≤ 600 000 ms) but not yet wired to
  any interactive-approval flow.
- **Skills are always "prepend" style.** There's no `skills_mode` option and
  no workspace-confined "invocable" mode — every local `Skill` is composed
  straight into the system prompt on every turn.
- **No built-in tools / code execution.** There's no `builtin_tools`-style
  option — a remotely-driven model can only ever touch the `tools` / `mcp` you
  hand it.
- **Platform namespace only checked for blankness.** See "The model ref:
  provider + model" above.
- **Auth is resolved lazily.** A missing `api_key` (and no `DIVA_API_KEY`) is
  not an error at construction — it only raises `DivaAuthError` on the first
  `run()` / `stream()` / `generate()` call, when the implicit client is
  actually created.
- **Requires Python ≥ 3.10.**

## See also

- [Core concepts](./core-concepts.md) — `Agent` vs `DivaClient`, deployment, sessions.
- [Tools & toolsets](./tools.md) · [Toolsets](./toolsets.md)
- [Overview](./overview.md) · [Quickstart](./quickstart.md)
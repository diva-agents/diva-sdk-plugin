# Streaming

`agent.stream(message, opts?)` runs one turn and yields the reply
incrementally, so you can render text token-by-token instead of waiting for
the whole answer. It has the same turn semantics as
[`agent.run()`](./sessions-and-memory.md) (same model, instructions, and
session handling) — just delivered as an async generator.

## When to use

- Rendering a live, typing-style UI (CLI, chat surface).
- Long replies where time-to-first-token matters.
- You want to cancel a run mid-flight by simply stopping consumption.

Reach for `run()` instead when you only need the final text, and `generate()`
when you need typed, pydantic-validated output (streaming a structured turn
is not supported — [Structured output](./structured-output.md)).

## How it works

`stream()` is an async generator method:

```python
def stream(
    self,
    message: str,
    *,
    session_id: str | None = None,
    timeout: float | None = None,
    model: str | None = None,
) -> AsyncIterator[AgentStreamChunk]
```

Call it and consume it with `async for` — there's no separate "start"/"await"
step. It yields a sequence of `DeltaChunk`s as the model produces text, then
exactly one terminal `DoneChunk` carrying the complete reply and
observability data:

```python
AgentStreamChunk = DeltaChunk | ReasoningChunk | DoneChunk
```

| Variant | Fields | Description |
| --- | --- | --- |
| `DeltaChunk` | `type: "delta"`, `delta: str`, `text: str` | An incremental fragment. `delta` = newest fragment; `text` = cumulative text so far. |
| `ReasoningChunk` | `type: "reasoning"`, `delta: str`, `text: str` | Part of the type union for forward compatibility — **not currently yielded** by `Agent.stream()`. |
| `DoneChunk` | `type: "done"`, `text: str`, `reasoning: str \| None`, `run_id: str \| None`, `usage: Usage \| None`, `duration_ms: float \| None`, `stop_reason: str \| None` | Terminal chunk (exactly one). `text` = authoritative final reply; the rest mirror `AgentResult`'s observability fields. |

`ReasoningChunk` exists in the union type and is exported from `diva_ai`, but
today `Agent.stream()` only ever produces `DeltaChunk` and `DoneChunk` — if
the turn ran with a non-`"off"` `thinking_default` and the model produced
reasoning text, it arrives as a single string on `DoneChunk.reasoning`, not as
incremental reasoning deltas. Prefer `isinstance()` checks over branching on
`chunk.type`, matching the pattern in the [Quickstart](./quickstart.md):

```python
from diva_ai import DeltaChunk, DoneChunk

async for chunk in agent.stream(message):
    if isinstance(chunk, DeltaChunk):
        ...
    elif isinstance(chunk, DoneChunk):
        ...
```

### Reconstructing the text

Both of these produce the same result for a normal turn:

```python
# (a) append each delta as it streams
out = ""
async for chunk in agent.stream(msg):
    if isinstance(chunk, DeltaChunk):
        out += chunk.delta
    elif isinstance(chunk, DoneChunk):
        out = chunk.text  # authoritative final

# (b) always take the newest cumulative snapshot
out = ""
async for chunk in agent.stream(msg):
    if isinstance(chunk, (DeltaChunk, DoneChunk)):
        out = chunk.text  # both variants carry a cumulative `text`
```

`DoneChunk.text` is the value to trust — `hooks.before_reply` /
`hooks.final_reply_guard` run on it, not on the raw deltas, so it may differ
from the concatenated deltas if a hook rewrites the final reply (see Notes).

### Early termination cancels the run

Breaking out of the `async for` loop (or otherwise closing the generator)
raises `GeneratorExit` inside `stream_agent_turn`, whose `finally` block
cancels the pending request task and closes the underlying gateway
connection — so the client stops waiting on the turn:

```python
async for chunk in agent.stream("Write a long essay..."):
    if isinstance(chunk, DeltaChunk):
        print(chunk.delta, end="", flush=True)
        if enough_for_now():
            break  # closes the gateway connection; DoneChunk is never yielded
```

This closes the *client's* connection rather than sending an explicit abort
RPC — `sessions.abort` in this SDK is reserved for recovering from a dropped/
gapped stream (see below), not for a plain consumer-initiated `break`.

In CPython, a `for`/`async for` loop that `break`s out of a freshly-created,
unreferenced generator is finalized promptly by reference counting, so the
cancellation above runs effectively immediately. That timing isn't guaranteed
on every Python implementation (e.g. PyPy's GC), and it isn't guaranteed if
you hold a reference to the generator elsewhere. For a deterministic close,
wrap the loop:

```python
from contextlib import aclosing

async with aclosing(agent.stream("Write a long essay...")) as chunks:
    async for chunk in chunks:
        if isinstance(chunk, DeltaChunk):
            print(chunk.delta, end="", flush=True)
            if enough_for_now():
                break  # aclosing() guarantees the generator's finally: runs
```

The cancellation is a no-op once the turn has already finished.

### `run_id`, usage, and timing

`run_id`, `usage`, `duration_ms`, and `stop_reason` are delivered only on the
terminal `DoneChunk` — `DeltaChunk` carries none of them. Use `run_id` to
correlate the turn with server-side logs / observability.

## Example

```python
# Streaming: render the reply token-by-token, then the final result.
#
# Run:  DIVA_API_KEY=sk-diva-... python examples/streaming.py
import asyncio

from diva_ai import Agent, DeltaChunk, DoneChunk


async def main() -> None:
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="Reply concisely.",
    )
    try:
        async for chunk in agent.stream("List three uses for a paperclip."):
            if isinstance(chunk, DeltaChunk):
                print(chunk.delta, end="", flush=True)
            elif isinstance(chunk, DoneChunk):
                print(f"\n\n[done] run_id={chunk.run_id} usage={chunk.usage}")
    finally:
        await agent.close()


asyncio.run(main())
```

Streaming inside a multi-turn conversation works the same way via
[`AgentSession.stream()`](./sessions-and-memory.md):

```python
chat = agent.session("user-42")
async for chunk in chat.stream("Summarize our last exchange."):
    if isinstance(chunk, DeltaChunk):
        print(chunk.delta, end="", flush=True)
```

## API

### `agent.stream(message, *, session_id=None, timeout=None, model=None)`

| Param | Type | Description |
| --- | --- | --- |
| `message` | `str` | The user message for this turn. |
| `session_id` | `str \| None` | Share history with prior turns of the same id; omit for a stateless turn. |
| `timeout` | `float \| None` | Optional per-call timeout in seconds. |
| `model` | `str \| None` | Optional per-call model-ref override. |

Returns `AsyncIterator[AgentStreamChunk]`.

## Notes & caveats

- **Deltas are raw; `DoneChunk.text` is authoritative.** Reply hooks/guards
  (`hooks.before_reply` / `hooks.final_reply_guard`) run on the final
  `done`-branch text, not on the deltas. A hook that **blocks** the reply
  raises `DivaGuardTripped` at the point the `DoneChunk` would be produced —
  but it cannot un-deliver deltas already yielded to your loop, and no
  `DoneChunk` is ever produced for that turn. If you display deltas live, be
  aware the terminal step may reject or rewrite what you've already shown.
- **A client-side `store` records the post-hook text, symmetrically with
  `run()`.** `Agent.stream()`'s store commit sits *after*
  `hooks.before_reply`/`hooks.final_reply_guard`, using the same (possibly
  hook-rewritten) text that ends up in `DoneChunk.text` — not the raw
  concatenated deltas. And because a block raises before that line is
  reached, a blocked streamed reply is never committed to the store, exactly
  like a blocked `run()`. See [Sessions & memory](./sessions-and-memory.md).
- **Error handling.** Like `run()`, a turn that returns an error payload
  surfaces as a thrown `DivaRequestError` at the point the `done` chunk would
  be produced; a malformed response raises `DivaRequestError("agent turn
  returned no result payloads (unexpected shape)")`. Wrap the loop in
  `try`/`except`.
- **Transient drops resume transparently.** If the connection drops
  mid-stream after it had connected, the client reconnects and replays
  missed deltas via cursor-based polling (`agent.streamEvents`) rather than
  failing your loop outright — you keep receiving `DeltaChunk`s as if nothing
  happened. Only a genuine gap (the server's event buffer advanced past what
  the reconnect can recover), a stall, or exhausting the reconnect budget
  surfaces as a `DivaRequestError`; a detected gap also issues a best-effort
  `sessions.abort` for that run before raising.
- **Always `close()`.** Stop the agent in a `finally` so the gateway
  connection (and any MCP connections) close.

## See also

- [Sessions & memory](./sessions-and-memory.md) — `session_id`, `AgentSession`,
  client-side stores.
- [Structured output](./structured-output.md) — typed results (not streamed).
- [Tools & toolsets](./tools.md) — `Agent` construction, `run()`.
- [Quickstart](./quickstart.md) — the minimal streaming snippet.
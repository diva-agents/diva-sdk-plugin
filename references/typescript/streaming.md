# Streaming

`agent.stream(message, opts?)` runs one turn and yields the reply incrementally,
so you can render text token-by-token instead of waiting for the whole answer.
It has the same turn semantics as [`agent.run()`](./agents.md) (same model,
instructions, and session handling) — just delivered as a stream.

## When to use

- Rendering a live, typing-style UI (CLI, chat surface).
- Long replies where time-to-first-token matters.
- You want to cancel a run mid-flight by simply stopping consumption.

Reach for `run()` instead when you only need the final text, and `generate()` when
you need typed, schema-validated output (streaming a structured turn is not
supported — [Structured output](./structured-output.md)).

## How it works

`stream()` is an `async` generator:

```ts
async *stream(message: string, opts?: RunOptions): AsyncGenerator<AgentStreamChunk>
```

It yields a sequence of `delta` chunks as the model produces text, then exactly one
terminal `done` chunk carrying the complete reply and run id:

```ts
export type AgentStreamChunk =
  | { type: "delta"; delta: string; text: string }
  | { type: "done"; text: string; runId?: string };
```

- **`delta` chunk** — `delta` is the newest fragment produced since the previous
  chunk; `text` is the cumulative assistant text up to and including this step.
- **`done` chunk** — emitted once, after the last delta. `text` is the
  authoritative final reply; `runId` is the engine's run id (may be `undefined`).

For simple text turns the deltas concatenate to the final text, so writing
`chunk.delta` as it arrives is correct. If you want to be robust against any
mid-stream reset, render `chunk.text` (the latest cumulative snapshot) instead of
accumulating deltas yourself.

### Reconstructing the text

Both of these produce the same result for a normal turn:

```ts
// (a) append each delta as it streams
let out = "";
for await (const chunk of agent.stream(msg)) {
  if (chunk.type === "delta") out += chunk.delta;
  else out = chunk.text; // authoritative final
}

// (b) always take the newest cumulative snapshot
let out = "";
for await (const chunk of agent.stream(msg)) {
  out = chunk.text; // delta chunks carry cumulative `text`, done carries final `text`
}
```

The `done` chunk's `text` is the value to trust — reply-level hooks and guards are
applied to it (not to the raw deltas), so it may differ from the concatenated
deltas if a hook rewrites the final reply (see Notes).

### Early termination cancels the run

Breaking out of the `for await` loop (or calling `.return()` on the iterator)
aborts the in-flight server-side run. `stream()` forwards the cancellation to the
underlying turn in a `finally` block, so the host stops generating rather than
running the turn to completion in the background:

```ts
for await (const chunk of agent.stream("Write a long essay…")) {
  if (chunk.type === "delta") {
    process.stdout.write(chunk.delta);
    if (enoughForNow()) break; // aborts the server-side run
  }
}
```

The cancellation is a no-op once the turn has already finished.

### `runId`

The run id is delivered on the terminal `done` chunk as `chunk.runId`. `delta`
chunks do not carry it. Use it to correlate the turn with server-side logs /
observability. It is optional (`string | undefined`).

## Example

```ts
// Streaming: render the reply token-by-token, then the final result.
//
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/streaming.ts
import { Agent } from "@diva-ai/sdk";

async function main(): Promise<void> {
  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "Reply concisely.",
  });

  try {
    for await (const chunk of agent.stream("List three uses for a paperclip.")) {
      if (chunk.type === "delta") {
        process.stdout.write(chunk.delta);
      } else {
        console.log(`\n\n[done] runId=${chunk.runId}`);
      }
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

Streaming inside a multi-turn conversation works the same way via
[`AgentSession.stream()`](./sessions-and-memory.md):

```ts
const chat = agent.session("user-42");
for await (const chunk of chat.stream("Summarize our last exchange.")) {
  if (chunk.type === "delta") process.stdout.write(chunk.delta);
}
```

## API

### `agent.stream(message, opts?)`

| Param | Type | Description |
| --- | --- | --- |
| `message` | `string` | The user message for this turn. |
| `opts` | `RunOptions` | Optional. `{ sessionId?: string }` — share history with prior turns of the same id; omit for a stateless turn. |

Returns `AsyncGenerator<AgentStreamChunk>`.

### `AgentStreamChunk`

| Variant | Fields | Description |
| --- | --- | --- |
| `delta` | `type: "delta"`, `delta: string`, `text: string` | An incremental fragment. `delta` = newest fragment; `text` = cumulative text so far. |
| `done` | `type: "done"`, `text: string`, `runId?: string` | Terminal chunk (exactly one). `text` = authoritative final reply; `runId` = engine run id. |

## Notes & caveats

- **Deltas are raw; `done.text` is authoritative.** Reply hooks/guards
  (`before_agent_reply` / `after_agent_reply`, `guard.output`) run on the final
  `done.text`, not on the deltas. A hook that **blocks** the reply throws at the
  `done` step — but it cannot un-deliver deltas already yielded to your loop. If
  you display deltas live, be aware the terminal chunk may rewrite or reject them.
- **History records what you saw.** With a client-side `store`, streaming commits
  the delta-delivered text to history to match what the consumer received — even
  if a post-hoc reply guard then blocks or rewrites the terminal chunk. (This
  differs from `run()`, where a blocked reply is never delivered and never stored.)
- **Error handling.** Like `run()`, a turn that returns an error payload surfaces
  as a thrown `DivaRequestError` at the point the `done` chunk would be produced;
  a malformed response throws `agent turn returned no result payloads (unexpected
  shape)`. Wrap the loop in `try/catch`. See [Error handling](./error-handling.md).
- **Always `close()`.** Stop the agent in a `finally` so the gateway connection closes.

## See also

- [Agents](./agents.md) — construction, `run()`, `generate()`, lifecycle
- [Structured output](./structured-output.md) — typed results (not streamed)
- [Sessions & memory](./sessions-and-memory.md) — streaming within a conversation
- [Hooks](./hooks.md) · [Guards](./guards.md) — reply interception
- [Error handling](./error-handling.md)
---
name: structured-and-streaming
description: Use when a Diva SDK agent turn needs typed/schema-validated JSON output (agent.generate() with a zod/pydantic schema) or token-by-token rendering (agent.stream() delta/done chunks) instead of a plain agent.run() reply, in Python (diva-ai) or TypeScript (@diva-ai/sdk).
---

# Structured output & streaming

Two alternatives to `run()`'s plain-text reply, for different needs — pick one,
they're mutually exclusive per turn (structured output is not streamed):

- **`generate()`** — get back typed, schema-validated data instead of prose.
- **`stream()`** — get back the same text `run()` would, but delivered incrementally.

## When to reach for this

- Extraction/parsing/classification whose shape is known ahead of time → `generate()`.
- A live, typing-style UI, or you want to cancel mid-flight by stopping consumption
  → `stream()`.
- Just need the final text, nothing typed or incremental → plain `run()`.

## Structured output: `generate()`

TypeScript (zod schema):
```ts
import { Agent, z } from "@diva-ai/sdk";

const Lead = z.object({
  name: z.string(),
  email: z.string(),
  intent: z.enum(["buy", "support", "other"]),
});

const agent = new Agent("diva/deepseek/deepseek-v4-flash");
const { output, attempts, repaired } = await agent.generate(
  "Email: 'Hi, I'm Ada (ada@example.com) — I'd like to buy 10 licenses.' Extract the lead.",
  Lead,
);
console.log(output.intent); // "buy" — narrowed to the enum, fully typed
await agent.close();
```

Python (pydantic `BaseModel`):
```python
from typing import Literal
from pydantic import BaseModel
from diva_ai import Agent

class Lead(BaseModel):
    name: str
    email: str
    intent: Literal["buy", "support", "other"]

agent = Agent("diva/deepseek/deepseek-v4-flash")
result = await agent.generate(
    "Email: 'Hi, I'm Ada (ada@example.com) — I'd like to buy 10 licenses.' Extract the lead.",
    Lead,
)
print(result.output.intent)  # "buy" — a Lead instance at runtime
await agent.close()
```

How it works in both: the schema is turned into JSON Schema, a JSON-only directive
is added for the turn, the reply is extracted (tolerates prose/fences around the
JSON) and validated. On failure it retries **once** in the same ephemeral session
(so the model sees its own rejected reply), then raises `DivaRequestError` —
there is no silent fallback. Result carries `output`, `text` (raw reply),
`attempts` (1 or 2), `repaired` (bool), plus `usage`/`durationMs`/`stopReason`
(`duration_ms`/`stop_reason` in Python).

## Streaming: `stream()`

TypeScript:
```ts
for await (const chunk of agent.stream("List three uses for a paperclip.")) {
  if (chunk.type === "delta") process.stdout.write(chunk.delta);
  else console.log(`\n[done] runId=${chunk.runId}`); // chunk.text is the authoritative final reply
}
await agent.close();
```

Python:
```python
from diva_ai import DeltaChunk, DoneChunk

async for chunk in agent.stream("List three uses for a paperclip."):
    if isinstance(chunk, DeltaChunk):
        print(chunk.delta, end="", flush=True)
    elif isinstance(chunk, DoneChunk):
        print(f"\n[done] run_id={chunk.run_id} usage={chunk.usage}")
await agent.close()
```

Both yield `delta` chunks (`delta` = newest fragment, `text` = cumulative so far)
then exactly one terminal `done` chunk carrying the authoritative final `text`.
Breaking the loop (or `.return()`/generator close) cancels the in-flight
server-side run — for a Python generator you hold a reference to elsewhere,
wrap it in `contextlib.aclosing(...)` for a deterministic cancel.

## Gotchas

- **`generate()` is prompt-guided, not native** — there's no `response_format`
  RPC yet; the `StructuredResult` shape is stable regardless.
- **Avoid non-serializable schema constructs.** TS: `.transform()`/`z.custom()`
  throw a typed `DivaError` before any turn runs. Python: an arbitrary/custom
  pydantic field type raises pydantic's **own** exception (not `DivaError`) at
  the same point — keep schemas to plain types/enums/nested models in both.
- **`z.object`/`BaseModel` strip unknown keys by default** — use
  `.passthrough()` (zod) or `ConfigDict(extra="allow")` (pydantic) to keep extras;
  they remain in `text` (the raw reply) either way.
- **The JSON directive's scope differs by language.** TS appends it to the
  **system prompt** for that turn, deliberately overriding a chatty
  `instructions` persona. Python appends it to the **user message** instead —
  `instructions` passes through unchanged, so a very conversational persona can
  wrap JSON in more prose there than in TS.
- **`stream()`'s `done` chunk carries the full result — in both languages.** The
  terminal chunk exposes `text` plus optional `reasoning`, `usage`, and
  `durationMs`/`stopReason` (TS) / `duration_ms`/`stop_reason` (Python) — the same
  field set as `AgentResult`, so you can read usage/cost off the `done` chunk
  without a follow-up `run()`. Reasoning text, if any, lands as one string on the
  done chunk's `reasoning`. (Python also defines a `ReasoningChunk` variant in the
  type union for forward compatibility, but `Agent.stream()` does not currently
  yield it.)
- **Deltas are raw; the terminal chunk is authoritative.** Reply hooks/guards
  run on `done.text`/`DoneChunk.text`, not on the deltas — a hook can rewrite or
  block the final text even after you've already rendered deltas live.
- **`generate()` is session-isolated from `run()`/`stream()` history** in both
  languages (its own ephemeral namespace), but its relationship to a
  client-side `store` differs by language — see the **sessions-memory** skill.

Full reference: https://front.dev.diva-ai.ru/ux/sdk-docs

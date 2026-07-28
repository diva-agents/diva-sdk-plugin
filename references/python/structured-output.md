# Structured output

`agent.generate(message, schema, opts?)` runs one turn and returns a typed,
schema-validated result instead of free text. You pass a pydantic `BaseModel`
subclass; the SDK asks the model to reply with JSON matching its schema, then
parses and validates the reply into an instance of that model. Use it whenever
you need machine-readable data — extracting a lead, classifying an intent,
pulling fields out of a message — rather than prose.

## When to use

- Extraction / parsing where the shape is known ahead of time.
- Classification into a fixed enum / `Literal`.
- Any turn whose output you will consume programmatically.

Use [`run()`](./sessions-and-memory.md) for conversational text and
[`stream()`](./streaming.md) for token-by-token rendering. `generate()` is not
streamed.

## How it works

```python
async def generate(
    self,
    message: str,
    schema: type[TSchema],  # TSchema bound to pydantic.BaseModel
    *,
    timeout: float | None = None,
    model: str | None = None,
) -> StructuredResult
```

Step by step:

1. **Schema → JSON Schema.** `schema` is converted with pydantic's
   `schema.model_json_schema()` (the `$schema` meta-key is popped before it's
   sent). This step is **not** wrapped in a try/except — a pydantic model that
   can't produce a JSON Schema (e.g. arbitrary, non-serializable field types
   without `model_config = ConfigDict(arbitrary_types_allowed=True)`) raises
   pydantic's own error, not a `DivaError`. Keep `generate()` schemas to plain
   field types: `str`, `int`, `float`, `bool`, `Literal`/`Enum`, `list[...]`,
   nested `BaseModel`s.

2. **JSON directive appended to your message — not to `instructions`.**
   Unlike a system-prompt override, the directive is concatenated onto the
   user message for this call only:

   ```python
   directive = (
       "Respond with ONLY a single JSON value that validates against this JSON "
       "Schema. No prose, no markdown, no code fences.\nJSON Schema:\n"
       + json.dumps(schema_json)
   )
   first = await self.run(f"{message}\n\n{directive}", session_id=gen_session, timeout=timeout, model=model)
   ```

   The agent's `instructions` (persona/system prompt) are passed through
   **unchanged** — there is no equivalent of suppressing a chatty persona for
   the turn. In practice this rarely matters because step 3 below tolerates
   prose around the JSON, but a strongly conversational `instructions` can
   still make the model wrap its JSON in commentary more often than a minimal
   one would.

3. **Extract / repair.** The reply text is passed through `parse_json_reply`,
   which tries, in order: the whole trimmed text, a fenced code block
   (`` ``` `` or `` ```json ``), then the first balanced `{…}` / `[…]` span
   (tracking string state so braces inside quoted strings don't confuse it).
   So prose around the JSON, or a fence, still parses. If none of the
   candidates parse, it raises `ValueError("no JSON value found in reply")`
   internally.

4. **Validate.** The parsed value is validated with `schema.model_validate(...)`.
   On success the call returns; on a `ValueError` (no JSON found) or
   pydantic `ValidationError` the error is captured for the retry.

5. **Retry once, same ephemeral session.** `generate()` makes at most **two**
   attempts (one retry). Both attempts share one freshly-minted
   `session_id` (`f"generate:{uuid4()}"`, fixed once per `generate()` call),
   so the model sees its own rejected reply on the retry, re-prompted with:

   > *"Your previous reply was not valid JSON for the schema. Error:
   > `<error message>`. Reply with ONLY the corrected JSON value — no prose,
   > no code fences."*

   `<error message>` is pydantic's `str(ValidationError)` verbatim, which can
   be long and multi-line for schemas with several failing fields.

6. **Fail loud.** If the second attempt still doesn't parse/validate,
   `generate()` raises `DivaRequestError`:

   ```
   generate(): reply failed schema validation after one retry: <error>
   ```

   `error.detail` is `{"provider": ..., "model": ...}`.

### Return shape: `StructuredResult`

```python
@dataclass(slots=True)
class StructuredResult:
    output: Any
    text: str
    attempts: int
    repaired: bool
    run_id: str | None = None
    usage: Usage | None = None
    duration_ms: float | None = None
    stop_reason: str | None = None
```

| Field | Type | Description |
| --- | --- | --- |
| `output` | `Any` | The reply parsed and validated against `schema` — at *runtime* an instance of your `schema` class. See the static-typing note below. |
| `text` | `str` | The raw assistant text `output` was parsed from (after reply hooks). |
| `attempts` | `int` | Model attempts taken: `1` = one-shot, `2` = the first reply failed validation and was re-asked. |
| `repaired` | `bool` | `True` when the first attempt failed schema validation and the retry produced the result — distinguish a clean extraction from a repaired one. |
| `run_id` | `str \| None` | The engine's run id for the (final) turn. |
| `usage` | `Usage \| None` | Token usage for the final turn (see below). |
| `duration_ms` | `float \| None` | Wall-clock ms of the final turn. |
| `stop_reason` | `str \| None` | Why the final turn stopped. |

**Static typing note.** `StructuredResult.output` is annotated `Any` in the
dataclass — `generate()`'s return type is a plain `StructuredResult`, not a
generic `StructuredResult[TSchema]`. Pydantic still validates `output` against
`schema` at runtime and `isinstance(result.output, Lead)` holds, but a static
type-checker won't narrow it for you. Assign a local annotation or `cast` if
you want static coverage:

```python
from typing import cast
lead = cast(Lead, result.output)
```

### Session isolation

`generate()` has **no `session_id` parameter** — every call mints a fresh
`f"generate:{uuid4()}"` id internally, so there is no way to make two
separate `generate()` calls share context or resume a prior structured
extraction. Consequences:

- The JSON directive and any rejected attempt never leak into your `run()`/
  `stream()` conversation history — a structured extraction won't bias the
  next chat turn toward JSON mode.
- Within **one** `generate()` call, the initial attempt and the retry (if
  needed) share that one ephemeral id — that's how the model sees its
  previous reply on the retry. How it sees it depends on whether the agent
  has a `store=`:
  - **No `store`** — both attempts hit the same real server-side session, so
    the model sees the previous (invalid) reply via native chat history.
  - **With `store=...`** — every turn is server-side stateless (a fresh,
    one-off server session key each time); continuity instead comes from the
    store's fenced `<prior_conversation>` injection, described in
    [Sessions & memory](./sessions-and-memory.md). The retry still sees its
    previous reply — just via the client-injected block rather than native
    server history.
- **A client-side `store` is still read from *and* written to.**
  `generate()` is a thin wrapper over `run()`, with no special-casing for its
  own ephemeral session id. If the agent has `store=...`:
  - `run()`'s store lookup for a brand-new `generate:<uuid>` id always comes
    back empty (nothing to inject) — so it doesn't corrupt the JSON reply.
  - But `run()` still **commits** the completed turn (the directive-appended
    message and the reply) to the store under that id, once per attempt.
    Because the id is never reused across separate `generate()` calls, that
    entry is never read back — but it isn't free: **every `generate()` call
    adds one or two throwaway records to your store** (e.g. one more file
    under `FileStore(dir)`), the same as any other conversation. If you rely
    on a client-side store and call `generate()` frequently, expect its
    footprint (file count, or a `MemoryStore`'s dict size) to grow
    unboundedly from these orphaned entries — `max_turns` bounds turns
    *within* a session, not the number of sessions.

Client-side hooks and guards still apply: `hooks.before_agent_start` can
rewrite the outgoing message (including the appended directive), and
`hooks.before_reply` / `hooks.final_reply_guard` run on the text that could be
returned — on each of `generate()`'s (up to two) internal `run()` calls — so a
reply/PII guard can't be bypassed by choosing `generate()` over `run()`.

## Example

```python
# Structured output: get typed, pydantic-validated data instead of free text.
#
# Run:  DIVA_API_KEY=sk-diva-... python examples/structured_output.py
import asyncio
from typing import Literal

from pydantic import BaseModel

from diva_ai import Agent


class Lead(BaseModel):
    name: str
    email: str
    intent: Literal["buy", "support", "other"]


async def main() -> None:
    agent = Agent("diva/gpt/gpt-4o-mini")
    try:
        result = await agent.generate(
            "Email: 'Hi, I'm Ada (ada@example.com) — I'd like to buy 10 licenses.' "
            "Extract the lead.",
            Lead,
        )
        print(result.output)         # Lead(name='Ada', email='ada@example.com', intent='buy')
        print(result.output.intent)  # "buy"  (a Literal member, checked by pydantic)
        print(result.run_id, result.text)  # run id + the raw JSON it parsed
    finally:
        await agent.close()


asyncio.run(main())
```

`result.output` is a `Lead` instance at runtime — `result.output.name`,
`.email`, `.intent` are fully populated and pydantic-validated.

## API

### `agent.generate(message, schema, *, timeout=None, model=None)`

| Param | Type | Description |
| --- | --- | --- |
| `message` | `str` | The user message to extract from / respond to. |
| `schema` | `type[TSchema]` (`TSchema` bound to `pydantic.BaseModel`) | The pydantic model class. `output` holds an instance of it at runtime. |
| `timeout` | `float \| None` | Optional per-call timeout in seconds. |
| `model` | `str \| None` | Optional per-call model-ref override (doesn't fork the session scope — see [Sessions & memory](./sessions-and-memory.md)). |

Returns `StructuredResult` (an `async def`, so `await` the call).

## Notes & caveats

- **`BaseModel` strips unknown keys by default.** Pydantic v2's default
  `model_config` (`extra="ignore"`) silently drops any keys the model returns
  that aren't declared on `schema`. Set
  `model_config = ConfigDict(extra="allow")` on your model if you need to
  keep extras — they also remain in `text` (the raw reply) regardless.
- **Avoid non-serializable pydantic constructs.** Custom/arbitrary field
  types that pydantic can't turn into JSON Schema raise before any turn
  runs — and, unlike the schema-validation failure path above, this raises
  pydantic's native exception, not a `DivaError`. Keep `generate()` schemas to
  plain shapes/enums/primitives/nested models.
- **Prompt-guided, not native.** Structured output is currently driven by the
  JSON directive above; the `agent` RPC has no native `response_format`
  equivalent yet. The return shape (`StructuredResult`) is stable and won't
  change if native support lands.
- **One retry, then it throws.** There is no silent fallback: after two
  failed attempts you get a `DivaRequestError`. Catch it and decide (retry
  with a simpler schema, log the raw `text`, etc.).
- **The directive does not suppress `instructions`.** See step 2 above — a
  conversational persona in `instructions` is passed through unchanged for
  the `generate()` turn, unlike a design that would override it.
- **`generate()` has no `session_id` and still touches a `store`.** See
  "Session isolation" above — this is the most likely surprise if you're
  coming from an SDK where structured calls are fully store-independent.

## See also

- [Sessions & memory](./sessions-and-memory.md) — `session_id`, `AgentSession`,
  and why `generate()`'s store interaction is unusual.
- [Streaming](./streaming.md) — token-by-token text (not structured).
- [Tools & toolsets](./tools.md) — `Agent` construction, `run()`.
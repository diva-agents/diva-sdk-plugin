# Model configuration

Tune how the model generates and reasons. Two `Agent` constructor options
cover it today: `params` (generation parameters) and `thinking_default`
(reasoning effort). Both apply to every turn the agent runs; a per-turn
override exists only for `model` (see [Quickstart](./quickstart.md)'s
`run(..., model=...)`), not yet for `thinking_default`.

Unlike the TypeScript SDK, a Python `Agent` never shares a connection with
another `Agent` — there is no `clientOptions` / shared-`client` concept in
`diva_ai`, so the TS SDK's "requires the agent to own its host" restriction on
these options does not apply here. Every `Agent` always owns (and lazily
creates, on its first turn) its own `DivaClient`.

## Generation params (`params`)

`params` is a `dict[str, Any]` forwarded, unvalidated, as the wire's
`streamParams` field on every turn this agent runs. Because it's a raw
passthrough — the one place in `diva_ai` where you write the *platform's*
wire key names instead of Python's usual `snake_case` — use the keys below
exactly as shown:

| Param key | Type | Notes |
| --- | --- | --- |
| `maxTokens` | `int` | **Hard** output cap the platform enforces (`finish_reason: "length"`). |
| `temperature` | `float` | Sampling randomness — lower is more deterministic. |

A few more keys are **provider-scoped**: the platform reads them only for
providers that support them, and ignores them elsewhere.

| Param key | Type | Provider | Meaning |
| --- | --- | --- | --- |
| `parallel_tool_calls` | `bool` | OpenAI | Allow multiple tool calls in one step. |
| `textVerbosity` | `"low" \| "medium" \| "high"` | OpenAI Responses | Response verbosity. |
| `cacheRetention` | `"none" \| "short" \| "long"` | Anthropic-family + Gemini | Prompt-cache retention. |
| `cacheControlTtl` | `"5m" \| "1h"` | Anthropic-family + Gemini | Legacy alias for prompt-cache TTL. |

**`top_p` is not read by the engine — omit it.** For reasoning effort, don't
reach for a param; use `thinking_default` below. `diva_ai` does not validate
`params` at all — unknown keys are passed through to the provider as-is.

```python
import asyncio
from diva_ai import Agent


async def main() -> None:
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        # maxTokens is a HARD output cap (finish_reason "length"); temperature
        # lowers randomness. Keys are the platform's wire names, not snake_case.
        params={"maxTokens": 400, "temperature": 0.2},
    )
    try:
        # Even a verbose prompt is truncated to ~400 tokens.
        result = await agent.run("Write a 2000-word essay about the ocean.")
        print(f"length: {len(result.text)} chars")
    finally:
        await agent.close()


asyncio.run(main())
```

## Reasoning level (`thinking_default`)

`thinking_default` sets how much the model deliberates before answering. It
maps to each provider's **native** reasoning control — OpenAI
`reasoning_effort`, Anthropic extended-thinking budget, Google
`thinkingBudget` — so one setting works across reasoning-capable models. It
is validated at construction: a bad value raises `DivaError` synchronously,
not an opaque failure mid-turn.

`ThinkingLevel` (exported from `diva_ai`) is one of the values in
`THINKING_LEVELS`:

| Value | Meaning |
| --- | --- |
| `"off"` | No reasoning — fastest and cheapest. |
| `"minimal"` | Minimal deliberation. |
| `"low"` | Low deliberation. |
| `"medium"` | Moderate deliberation. |
| `"high"` | High deliberation. |
| `"xhigh"` | Maximum deliberation (the engine's ceiling). |
| `"adaptive"` | The engine picks a level per turn. |

`minimal → low → medium → high → xhigh` is increasing deliberation, trading
latency and cost for answer quality.

```python
from diva_ai import Agent

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    thinking_default="medium",  # deliberate more by default
)
```

`THINKING_LEVELS` and `validate_thinking_default` are also exported, useful
if you want to validate a value coming from user input or config before
constructing the `Agent`:

```python
from diva_ai import THINKING_LEVELS, validate_thinking_default

def parse_level(raw: str) -> str:
    validate_thinking_default(raw)  # raises DivaError if raw not in THINKING_LEVELS
    return raw

print(THINKING_LEVELS)  # ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive')
```

There is currently no per-message override for `thinking_default` — `run()`,
`stream()`, and `generate()` accept a per-turn `model=` override, but not a
per-turn reasoning level. Set `thinking_default` once at construction.

## Compaction — not yet available

The TypeScript SDK automatically summarizes older history as a conversation
approaches the model's context window, tunable via a `compaction` option and
observable via an `onCompaction` callback. **`diva_ai.Agent` has no
equivalent today** — there is no `compaction` or `on_compaction` constructor
parameter, and no `compaction` module in the package (verified against
`Agent.__init__` in `src/diva_ai/agent.py`).

If you need to bound a long conversation's size in Python today, manage it
client-side with `store=`, whose `max_turns` caps how many prior turns are
kept and re-injected as fenced history on every call:

```python
from diva_ai import Agent, MemoryStore

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    store=MemoryStore(max_turns=20),  # keep at most the last 20 turns
)
```

This bypasses the engine's own history handling entirely: with a `store=`,
each server turn is stateless and Python reconstructs context from the store
on every call, so `max_turns` is an outright cap, not a summarize-then-keep-
going scheme. `diva_ai.FileStore(dir, max_turns=...)` is the on-disk
equivalent.

## Full example

```python
# DIVA_API_KEY=sk-diva-... python examples/params.py
import asyncio
from diva_ai import Agent


async def main() -> None:
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        # Cap length + steer sampling; parallel_tool_calls is OpenAI-scoped.
        params={"maxTokens": 400, "temperature": 0.2, "parallel_tool_calls": False},
        thinking_default="low",
    )
    try:
        result = await agent.run("Write a 2000-word essay about the ocean.")
        print(f"length: {len(result.text)} chars")
    finally:
        await agent.close()


asyncio.run(main())
```

## Notes & caveats

- **`params` keys use the platform's wire names, not Python's `snake_case`.**
  It's the one escape hatch in `diva_ai` that isn't converted — write
  `maxTokens`, not `max_tokens`.
- **`params` is entirely unvalidated client-side.** Bad or unknown keys are
  sent to the gateway as-is; there's no local schema check like there is for
  `thinking_default` or `Permissions`.
- **`top_p` in `params` is a no-op.** The engine does not read it; use
  `temperature` for sampling and `thinking_default` for reasoning effort.
- **No per-turn `thinking_default` override.** Unlike `model`, which `run()`
  / `stream()` / `generate()` all accept as a keyword override, the reasoning
  level is fixed for the `Agent`'s lifetime.
- **Compaction and `onCompaction` are TypeScript-only as of this version.**
  Passing `compaction=` or `on_compaction=` to `Agent(...)` raises a
  `TypeError`, not a `DivaError` — it isn't a recognized-but-rejected option,
  it simply isn't in the constructor's signature.
- **Validation is synchronous.** An unknown `thinking_default` raises a
  clean `DivaError` at construction, not an opaque engine error mid-turn.

## See also

- [Overview](./overview.md) — model refs (`diva/<family>/<model>`) and what the SDK provides.
- [Quickstart](./quickstart.md) — `run()` / `stream()` / `generate()`, including the per-turn `model=` override.
- [Tools & toolsets](./tools.md) — `Permissions` / `can_use_tool`, referenced above for gating client tools.
- [Error handling](./error-handling.md) — the `DivaError` hierarchy, including the construction-time error for a bad `thinking_default`.
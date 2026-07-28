# Parallel agents

Run many agent turns — or a batch of sub-agents — **at the same time**. `diva-ai` gives you two
concurrency mechanisms, from most explicit to most autonomous. They're independent — pick
whichever fits, or combine them.

| Mechanism | Runs where | Who drives it | Use it for |
| --- | --- | --- | --- |
| [`parallel()`](#client-side-parallel) | Your process (each task opens its own gateway connection) | Your code | A known batch of independent turns you orchestrate. |
| [Parallel `handoff()`](#model-driven-parallel-handoff) | Your process | The model (parallel tool calls) | Let the parent model delegate several sub-tasks at once. |

> **Scope today.** These are *independent* parallel agents/sub-agents — no agent-to-agent
> messaging, and (see [Host-side spawning](#host-side-spawning-not-in-this-sdk) below) no
> engine-managed background batch. Both mechanisms run entirely in your own process.

## Client-side: `parallel()`

The example below mirrors the `parallel()` section of `examples/subagents_parallel.py`.
`parallel(tasks, *, concurrency=DEFAULT_PARALLEL_CONCURRENCY)` runs independent async thunks
concurrently, bounded, and returns their outcomes **in input order** as settled results. It
**never raises** — a failing task becomes a `Settled(status="rejected", reason=exc)` entry, so
one bad run doesn't sink the batch.

Each `Agent.run()` opens its own gateway WebSocket connection for the turn, so an unbounded
fan-out can exhaust sockets/memory. The `concurrency` cap (default
`DEFAULT_PARALLEL_CONCURRENCY = 4`) bounds how many run at once; raise it deliberately once
you've sized for it.

```python
import asyncio

from diva_ai import Agent, parallel


async def main() -> None:
    reviewer = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="Review the file. Reply: APPROVE or REQUEST-CHANGES + one reason.",
    )

    files = ["auth.py", "db.py", "api.py", "ui.py"]
    results = await parallel(
        # each thunk must capture its own `f` — a plain closure over the loop
        # variable would see the LAST value of `f` for every call.
        [lambda f=f: reviewer.run(f"Review {f}. (pretend contents)") for f in files],
        concurrency=2,  # at most 2 turns in flight at once
    )

    for f, r in zip(files, results):
        if r.status == "fulfilled":
            print(f, "->", r.value.text)
        else:
            print(f, "failed:", r.reason)

    await reviewer.close()


asyncio.run(main())
```

Tasks are **thunks** (`Callable[[], Awaitable[T]]`) so a task starts only when a concurrency
slot frees up — passing already-started coroutines would defeat the bound (and a coroutine
object can only be awaited once, so it couldn't be retried or reordered anyway). `parallel()`
is generic: any zero-argument callable returning an awaitable works, not just agent turns.

### API

```python
async def parallel(
    tasks: Sequence[Callable[[], Awaitable[Any]]],
    *,
    concurrency: int = DEFAULT_PARALLEL_CONCURRENCY,
) -> list[Settled]: ...

DEFAULT_PARALLEL_CONCURRENCY = 4
```

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `tasks` | `Sequence[Callable[[], Awaitable[Any]]]` | — | Thunks; each starts when a concurrency slot is free. |
| `concurrency` | `int` (keyword-only) | `4` | Max tasks in flight at once. A non-`int` or `< 1` raises `ValueError`. |

- **Returns** results in **input order** (not completion order), as `list[Settled]`.
- **Never raises.** Inspect each result's `.status`.
- **Fully client-side** — there is no engine-side scheduling involved; each task is its own
  top-level `run()` (or whatever async call you pass) on its own gateway connection.

### `Settled`

```python
@dataclass(slots=True)
class Settled:
    status: Literal["fulfilled", "rejected"]
    value: Any = None
    reason: BaseException | None = None
```

Mirrors JavaScript's `PromiseSettledResult`: `status == "fulfilled"` → read `.value`;
`status == "rejected"` → read `.reason` (the caught exception).

## Model-driven: parallel `handoff()`

If the parent model emits **parallel tool calls** in a single turn, multiple
[`handoff()`](./subagents.md) sub-agents execute **concurrently** in your process (bounded by
the process-wide 64-in-flight backstop — see
[Sub-agents](./subagents.md#notes--caveats)). This is delegation the *model* decides, versus
the explicit, code-orchestrated `parallel()`. See [Sub-agents](./subagents.md) for
`handoff()` itself.

## Host-side spawning: not in this SDK

The TypeScript SDK offers a self-hosted-only `builtinTools.subagents` feature — the model
spawns a batch of sub-agent turns that the *engine* runs in-process, on per-tenant
fair-scheduled lanes. `diva-ai` has no equivalent, and it isn't a temporary gap: this package
is a **thin client** (see [Overview](./overview.md)) — the Diva engine always runs
server-side on the platform, and there is no local engine process for this client to
configure fair-scheduling lanes on. If you want the model itself to decide what to delegate,
use parallel `handoff()` above; for large fan-outs orchestrated by your own code, use
`parallel()`.

## Choosing a mechanism

- **Known batch, your orchestration** → `parallel()`. Simplest, fully in your control, works
  with any awaitable-returning thunk.
- **Let the parent model decide what to delegate** → parallel `handoff()`.

Both mechanisms run in *your* process — one gateway connection per turn. For very large
fan-outs, mind the `concurrency` cap on `parallel()` and the 64-in-flight backstop on
`handoff()`; there is no host-side lane to fall back to in this SDK.

## See also

- [Sub-agents](./subagents.md) — `handoff()`, the delegation primitive.
- [Overview](./overview.md) — why `diva-ai` is a thin client and what that implies for
  concurrency.
- [Tools & toolsets](./tools.md) — client tools, which both `handoff()` and your own tools
  build on.
- The project [README](../README.md) — the `parallel()` example under "Parallel fan-out".
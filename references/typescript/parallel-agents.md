# Parallel agents

Run many agents — or a batch of sub-agents — **at the same time**. This is the SDK's concurrency
surface: fan a workload across independent agents from your own code, or let the model spawn a batch
of sub-agents that the host runs in parallel on fair-scheduled lanes.

There are three ways to get parallelism, from most explicit to most autonomous. They're independent
— pick whichever fits, or combine them.

| Mechanism | Runs where | Who drives it | Use it for |
| --- | --- | --- | --- |
| [`parallel()`](#client-side-parallel) | Your process (each agent = a host) | Your code | A known batch of independent turns you orchestrate. |
| [Parallel `handoff()`](#model-driven-parallel-handoffs) | Your process | The model (parallel tool calls) | Let the parent model delegate several sub-tasks at once. |
| [`builtinTools.subagents`](#host-side-builtintoolssubagents) | The host (fair-scheduled lanes) | The model (spawns) | "Spawn a batch of sub-agents and run them in the background." |

> **Scope today.** These are *independent* parallel agents/sub-agents — no agent-to-agent messaging.
> Richer orchestration (distinct sub-agent personas, agent-to-agent coordination, workflows) builds
> on this surface and is tracked in [Roadmap](#roadmap).

## Client-side: `parallel()`

`parallel(tasks, { concurrency })` runs independent async tasks concurrently, bounded, and returns
their results **in input order** as settled results. It **never rejects** — a failing task becomes a
`{ status: "rejected", reason }` entry, so one bad run doesn't sink the batch.

Each `Agent` owns a host child process, so an unbounded fan-out can exhaust memory/PIDs. The
`concurrency` cap (default `DEFAULT_PARALLEL_CONCURRENCY` = 4) bounds how many run at once; raise it
deliberately once you've sized host resources.

```ts
import { Agent, parallel } from "@diva-ai/sdk";

const reviewer = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "Review the file. Reply: APPROVE or REQUEST-CHANGES + one reason.",
});

const files = ["auth.ts", "db.ts", "api.ts", "ui.ts"];
const results = await parallel(
  files.map((f) => () => reviewer.run(`Review ${f}. (pretend contents)`)),
  { concurrency: 2 }, // at most 2 turns in flight at once
);

for (const [i, r] of results.entries()) {
  if (r.status === "fulfilled") console.log(files[i], "→", r.value.text);
  else console.error(files[i], "failed:", r.reason);
}
await reviewer.close();
```

Tasks are **thunks** (`() => Promise<T>`) so a task starts only when a slot frees up — passing
already-started promises would defeat the bound. `parallel()` is generic: any `() => Promise<T>`
works, not just agent runs.

### API

```ts
function parallel<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  options?: { concurrency?: number },
): Promise<PromiseSettledResult<T>[]>;

const DEFAULT_PARALLEL_CONCURRENCY = 4;
```

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `tasks` | `(() => Promise<T>)[]` | — | Thunks; each starts when a concurrency slot is free. |
| `options.concurrency` | number ≥ 1 | 4 | Max tasks in flight at once. Non-finite / `< 1` throws `RangeError`. |

- **Returns** results in **input order** (not completion order), as `PromiseSettledResult<T>[]`.
- **Never rejects.** Inspect each result's `status`.
- **Fully client-side** — the engine's fair-scheduling lanes are not involved (each agent is its own
  top-level turn on its own host).

## Model-driven: parallel `handoff()`

If the parent model emits **parallel tool calls** in a single turn, multiple [`handoff()`](./subagents.md)
sub-agents execute **concurrently** in your process (bounded by the process-wide
`MAX_INFLIGHT_HANDOFFS` = 64 backstop). This is delegation the *model* decides, versus the explicit,
code-orchestrated `parallel()`. See [Sub-agents](./subagents.md) for `handoff()` itself.

## Host-side: `builtinTools.subagents`

> **Self-host only — throws `DivaNotImplementedError` in the hosted client.** This is a `builtinTools`
> feature (host-side sub-agent spawning), so it requires a self-hosted engine. On the hosted client,
> use client-side [`parallel()`](#client-side-parallel) and parallel [`handoff()`](./subagents.md)
> instead — those run entirely from your process and need no host built-ins.

For "spawn a batch of sub-agents and let them run in the background," opt into the engine's host-side
sub-agents. The model then spawns independent sub-agent turns that run **in the host, in parallel, on
per-tenant fair-scheduled lanes** — so one tenant's burst can't starve another's. This is the SDK
surface for the engine's fair-scheduling lanes.

```ts
const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "Break the task into independent parts, run them as parallel sub-agents, and merge.",
  builtinTools: {
    subagents: {
      maxParallel: 16,      // fair-scheduling ceiling (concurrent sub-agent turns in this host)
      perTenantMaxParallel: 8,
      maxSpawnDepth: 1,     // sub-agents are leaves (can't themselves spawn) — the default
    },
  },
});
```

### What it un-gates

The SDK is [secure by default](./code-execution.md) — every engine built-in is denied unless you
opt in. `subagents` un-gates the **spawn + observe/collect** tools only:

| Un-gated | Purpose |
| --- | --- |
| `sessions_spawn` | Spawn a child sub-agent turn. |
| `sessions_yield` | End the turn to receive the parallel children's results. |
| `session_status` | Poll a child's status. |
| `sessions_list` | Enumerate spawned children. |
| `sessions_history` | Read a child's transcript / result. |
| `agents_list` | Discover valid spawn targets. |

**Deliberately kept denied:** `sessions_send` (agent-to-agent messaging) **and** the `subagents`
management tool — its `steer` action can abort and restart a child with a model-supplied message,
which is a parent→child message channel. Excluding both keeps these **independent** parallel
sub-agents, not a dialogue.

### Options

| Field | Type | Maps to (`agents.defaults.subagents.*`) | Meaning |
| --- | --- | --- | --- |
| `subagents` | `true` \| object | — | `true` enables with engine defaults; an object tunes it. |
| `maxParallel` | number | `globalMaxConcurrent` (default 16) | Max sub-agent turns running at once across the host (memory ceiling). SDK-capped at 1024. |
| `perTenantMaxParallel` | number | `perTenantMaxConcurrent` (default 8) | Per-tenant cap; clamped to `maxParallel`. |
| `maxSpawnDepth` | number | `maxSpawnDepth` (default 1) | How deep sub-agents may spawn sub-agents. Range `[1, 5]` (clamped). |
| `allowAgents` | string[] | `allowAgents` | Target agent ids the model may spawn (`["*"]` = any). Empty `[]` is treated as omit. |

### Security & behavior

- **Owns its host.** Like all `builtinTools`, it configures the agent's own engine session, so an
  agent using it cannot share an explicit `client`.
- **Spawned sub-agents inherit this host's secure-default tool policy** — they're as restricted as the
  parent (they don't get your client `tool()`s or any built-in you didn't opt into). The global deny
  is authoritative and monotonic: no per-sub-agent rule can re-enable a denied tool.
- **No A2A, no steering.** `sessions_send` and the `subagents`/`steer` tool stay denied (see above).
- **Config is SDK-authoritative.** The SDK's config for `agents.defaults.subagents` is authoritative,
  so stale or externally-supplied config can't inject spawn-scope / DoS keys.

### v1 limitations

- Spawns run the **base agent config** with a distinct per-spawn task (+ optional model/reasoning
  override the model chooses). **Distinct personas** (separate instructions per sub-agent) is a
  [roadmap](#roadmap) item.
- Live end-to-end spawn verification is pending (the reconcile + config are unit-tested + schema-valid).

## Choosing a mechanism

- **Known batch, your orchestration** → `parallel()`. Simplest, fully in your control, works with any
  promise-returning task.
- **Let the parent model decide what to delegate** → parallel `handoff()`.
- **The model should spawn and manage a background batch itself, on fair lanes** →
  `builtinTools.subagents`.

`parallel()` and `handoff()` run in *your* process (one host per agent); `builtinTools.subagents`
runs in the *host* (one process, many lanes). For large fan-outs, host-side lanes are cheaper than a
host process per agent.

## Roadmap

This surface will grow. Planned/anticipated (fail-loud until wired):

- **Distinct sub-agent personas** — define per-sub-agent instructions/models the model can spawn
  (host `agents.list[]`), instead of only the base agent + a task.
- **Agent-to-agent coordination** — a correct, SOTA A2A mechanism (the earlier `sessions_send`
  approach was superseded; it is *not* exposed here).
- **Orchestration / workflows** — higher-level batch + dependency control on top of these primitives.

## See also

- [Sub-agents](./subagents.md) — `handoff()`, the delegation primitive.
- [Code execution](./code-execution.md) — `builtinTools` and the secure-default model.
- [Agents](./agents.md) — constructing and closing agents.
- [API reference](./api-reference.md) — `parallel`, `DEFAULT_PARALLEL_CONCURRENCY`, `BuiltinToolsConfig`.
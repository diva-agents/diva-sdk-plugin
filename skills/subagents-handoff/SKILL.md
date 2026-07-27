---
name: subagents-handoff
description: Use when delegating a sub-task to a focused sub-agent via handoff() (a transfer_to_<name> tool the parent model calls for one isolated turn), or when fanning work across agents concurrently with parallel() / parallel handoff() / host-side builtinTools.subagents — in the Diva SDK, Python or TypeScript.
---

# Sub-agents & Handoff

A sub-agent is a normal `Agent` you construct and own. `handoff()` wraps it as a client tool named
`transfer_to_<name>` that the parent model calls — "handoff is just a typed tool transfer," no
graph or orchestration DSL.

## When to use

- Route a distinct sub-task to a focused agent (lead qualifier, code reviewer, translator) with
  its own `instructions`, model, and tools.
- Keep the sub-agent's work in an **isolated, stateless session** so the parent conversation stays
  uncluttered — each handoff is a fresh turn with no memory of earlier handoffs.
- Avoid for anything the parent can do inline (each handoff pays a full sub-agent turn), and avoid
  wiring handoffs into cycles (A → B → A) — a real cycle trips the concurrency backstop.

## `handoff()`

```ts
// TypeScript
import { Agent, handoff } from "@diva-ai/sdk";

const qualifier = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "You score sales leads. Reply with a one-line score and reason.",
});

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "For sales leads, call transfer_to_qualifier and relay its score.",
  tools: [handoff(qualifier, { name: "qualifier", description: "Qualify an inbound sales lead." })],
});

await qualifier.start(); // pre-warm so the first handoff isn't a cold boot
const { text } = await agent.run("New lead: Acme Corp, 100 seats, budget approved.");
await agent.close();
await qualifier.close(); // parent close() does NOT cascade
```

```python
# Python
from diva_ai import Agent, handoff

qualifier = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="You score sales leads. Reply with a one-line score and reason.",
)

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="For sales leads, call transfer_to_qualifier and relay its score.",
    tools=[handoff(qualifier, name="qualifier", description="Qualify an inbound sales lead.")],
)

result = await agent.run("New lead: Acme Corp, 100 seats, budget approved.")
await agent.close()
await qualifier.close()  # parent close() does NOT cascade
```

`name` must be a letter-led identifier (`^[a-zA-Z][a-zA-Z0-9_]*$`, no hyphen — it's exposed as
`transfer_to_<name>`) and `description` non-empty; both validated at build time, `DivaError`
otherwise. The default input schema is `{ message: string }`; supply `inputSchema`/`input_schema`
**and** a required `render` to map a structured input to the sub-agent's message string instead.
`onResult`/`on_result` observes the sub-agent's **full** `AgentResult` (usage, duration, runId)
after every delegation — the parent model only ever sees the returned text, so this is your audit/
cost-accounting side channel; a throwing observer is ignored.

### Python vs TypeScript — real divergences

- **Pre-warming only matters in TS.** TS's `Agent` owns a local host child process that must boot;
  call `subAgent.start()` before traffic so the first handoff doesn't eat that boot cost inside
  the parent's tool-call timeout. Python's `diva_ai` is a thin client with **no local engine
  process ever** — every `run()` (including one a handoff makes) opens a fresh gateway WebSocket
  and closes it after the turn, so there is no `start()` method and nothing to pre-warm; the cost
  is simply "one more turn," bounded by `timeout_ms`.
- **Default timeout is the same (180 s)** — `timeoutMs`/`timeout_ms` — but keep the *sub-agent's*
  own request timeout (TS: `requestTimeoutMs`) below it so the sub-agent's own bound fires first.
  Python has no separate sub-agent request-timeout knob to coordinate.
- **Error wrapper text differs slightly** but the class is the same: both raise `DivaError` —
  TS: `` `handoff to "<name>" failed: <cause>` ``; Python: `` `handoff to "<name>" failed: <cause>` ``
  (single-quoted in Python's message). Either way the parent model sees an attributed failure
  instead of an opaque tool error.

## Parallel agents

Three ways to get concurrency; pick by who's driving:

| Mechanism | Who drives it | Runs where |
| --- | --- | --- |
| `parallel(tasks, { concurrency })` | your code | your process, one connection per task |
| parallel `handoff()` calls | the model (parallel tool calls in one turn) | your process |
| `builtinTools.subagents` | the model (spawns) | **TS self-host only** — see below |

### `parallel()` — explicit, code-orchestrated

Thunks (not already-started promises/coroutines) so a task starts only when a concurrency slot
frees; never rejects/raises — inspect each result's status.

```ts
// TypeScript — default concurrency 4
import { Agent, parallel } from "@diva-ai/sdk";

const results = await parallel(
  files.map((f) => () => reviewer.run(`Review ${f}.`)),
  { concurrency: 2 },
);
for (const [i, r] of results.entries()) {
  if (r.status === "fulfilled") console.log(files[i], r.value.text);
}
```

```python
# Python — same semantics, DEFAULT_PARALLEL_CONCURRENCY = 4
from diva_ai import Agent, parallel

results = await parallel(
    [lambda f=f: reviewer.run(f"Review {f}.") for f in files],  # capture f explicitly!
    concurrency=2,
)
for f, r in zip(files, results):
    if r.status == "fulfilled":
        print(f, r.value.text)
```

Both return results **in input order** (not completion order) as settled results
(`PromiseSettledResult<T>[]` in TS, `list[Settled]` in Python — `Settled` mirrors the JS shape:
`status`, `.value`, `.reason`).

### Model-driven parallel `handoff()`

When the parent model emits parallel tool calls in one turn, multiple `handoff()` sub-agents run
concurrently in your process automatically — bounded by the same 64-in-flight backstop as a single
handoff, in both SDKs. No extra code either way.

### Host-side `builtinTools.subagents` — TS-only, self-host-only

**This mechanism does not exist in Python at all**, and it is not a temporary gap: `diva_ai` is a
thin client end-to-end — there is no local engine process for it to configure fair-scheduling
lanes on, on any gateway target. In TS it's **also** unavailable on the **hosted** client
(throws `DivaNotImplementedError` there) — it only runs self-hosted, where the engine spawns a
batch of sub-agent turns on per-tenant fair-scheduled lanes:

```ts
// TypeScript, self-host only
const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "Break the task into independent parts, run them as parallel sub-agents, merge.",
  builtinTools: { subagents: { maxParallel: 16, perTenantMaxParallel: 8, maxSpawnDepth: 1 } },
});
```

Un-gates spawn/observe tools only (`sessions_spawn`, `sessions_yield`, `session_status`,
`sessions_list`, `sessions_history`, `agents_list`); `sessions_send` (agent-to-agent messaging) and
the `steer` action stay deliberately denied — these are independent parallel sub-agents, not a
dialogue. For Python, or for the TS hosted client, use `parallel()` / parallel `handoff()` for
large fan-outs instead — there is no host-side lane to fall back to in either of those paths.

## Gotchas

- **Concurrency backstop is 64 in-flight handoffs** in both SDKs (process-wide counter) — past it,
  the tool throws/raises `DivaError` naming a likely delegation cycle. A genuine cycle grows
  unbounded and trips this; normal concurrency never does.
- **No shared memory between handoffs** — each is a brand-new session. Thread continuity yourself
  by folding prior context into the rendered message.
- A handoff always runs a **distinct persona**: the sub-agent's own `instructions`/model/tools,
  never the parent's.

Full docs: https://front.dev.diva-ai.ru/ux/sdk-docs

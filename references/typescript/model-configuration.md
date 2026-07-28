# Model configuration

Tune how the model generates, reasons, and manages a long conversation. Three agent
options cover it: `params` (generation parameters), `thinkingDefault` (reasoning effort),
and `compaction` (automatic history summarization) — plus an observe-only `onCompaction`
callback. All three are **baked into the agent's host**, so an agent that sets any of them
cannot share an explicit `client` (it throws a `DivaError` at construction). Configure the
implicit client via `clientOptions` instead. See [Agents](./agents.md) for the owns-its-host rule.

## Generation params (`params`)

`params` is a bag of generation parameters applied to **every turn** this agent runs. The
common two are portable across providers:

| Param | Type | Notes |
| --- | --- | --- |
| `maxTokens` | `number` | **Hard** output cap the platform enforces (`finish_reason: "length"`). |
| `temperature` | `number` | Sampling randomness — lower is more deterministic. |

A few more keys are **provider-scoped**: they're read only by providers that support them
and silently ignored elsewhere.

| Param | Type | Provider | Meaning |
| --- | --- | --- | --- |
| `parallel_tool_calls` | `boolean` | OpenAI | Allow multiple tool calls in one step. |
| `textVerbosity` | `"low" \| "medium" \| "high"` | OpenAI Responses | Response verbosity. |
| `cacheRetention` | `"none" \| "short" \| "long"` | Anthropic-family + Gemini | Prompt-cache retention. |
| `cacheControlTtl` | `"5m" \| "1h"` | Anthropic-family + Gemini | Legacy alias for prompt-cache TTL. |

**`top_p` is NOT read by the engine — omit it.** For reasoning effort, do **not** reach for
a param; use the first-class `thinkingDefault` field below. Unknown keys are passed through
to the provider as-is.

```ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  // maxTokens is a HARD output cap (finish_reason "length"); temperature lowers randomness.
  params: { maxTokens: 400, temperature: 0.2 },
});

try {
  // Even a verbose prompt is truncated to ~400 tokens.
  const { text } = await agent.run("Write a 2000-word essay about the ocean.");
  console.log(`length: ${text.length} chars`);
} finally {
  await agent.close();
}
```

## Reasoning level (`thinkingDefault`)

`thinkingDefault` sets how much the model deliberates before answering. It maps to each
provider's **native** reasoning control — OpenAI `reasoning_effort`, Anthropic
extended-thinking budget, Google `thinkingBudget` — so one setting works across
reasoning-capable models. It is the *default*; a per-message directive can still override
it for a single turn. It is validated at construction (a bad value throws `DivaError`
synchronously, not an opaque host boot crash).

`ThinkingLevel` is one of:

| Value | Meaning |
| --- | --- |
| `"off"` | No reasoning — fastest and cheapest. |
| `"minimal"` | Minimal deliberation. |
| `"low"` | Low deliberation. |
| `"medium"` | Moderate deliberation. |
| `"high"` | High deliberation. |
| `"xhigh"` | Maximum deliberation (the engine's ceiling — Claude's `max` maps here). |
| `"adaptive"` | The engine picks a level per turn. |

`minimal → low → medium → high → xhigh` is increasing deliberation, trading latency and
cost for answer quality.

```ts
const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  thinkingDefault: "medium", // deliberate more by default; override per turn if needed
});
```

## Compaction (`compaction`)

As a conversation approaches the model's context window, the engine **automatically**
summarizes older history. Compaction is **always on and cannot be turned off** (parity with
Claude's Agent SDK); it only activates near the context limit, so it is a no-op for short
conversations. `compaction` tunes the *scheme* — omit it for the safe default. The engine
already preserves identifiers (order IDs, refs, …) across a summary by default, so use
`customInstructions` for the things it can't guess — language, persona, domain facts.

Values are validated at construction; an out-of-range value throws `DivaError` immediately.

| Field | Type | Range | Default | Description |
| --- | --- | --- | --- | --- |
| `customInstructions` | `string` | — | — | Extra summary instructions (preserve language / persona / domain facts). |
| `recentTurnsPreserve` | `number` (integer) | 0–12 | — | Most-recent user/assistant turns kept verbatim in the summary. |
| `maxHistoryShare` | `number` | 0.1–0.9 | `0.5` | Max share of the context window kept for history during pruning. |
| `qualityGuard` | `{ enabled?: boolean; maxRetries?: number }` | `maxRetries` ≥ 0 (integer) | — | Audit the summary and regenerate on failure (adds latency + cost). |
| `model` | `string` | — | agent's primary model | A cheaper/faster model for the summarization pass, e.g. `"diva/gpt/gpt-4o-mini"`. |
| `notifyUser` | `boolean` | — | `false` (silent) | Emit a "🧹 Compacting context…" notice as a text chunk in the reply. |

```ts
const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  compaction: {
    recentTurnsPreserve: 4,       // keep the last 4 turns verbatim
    maxHistoryShare: 0.4,         // give history at most 40% of the window
    model: "diva/gpt/gpt-4o-mini", // summarize with a cheaper model
    customInstructions: "Reply in the customer's language; keep every open action item.",
    notifyUser: true,             // surfaces as a text chunk in run()/stream()
  },
});
```

### Observing compaction (`onCompaction`)

`onCompaction` is an **observe-only** callback (Claude PreCompact-style) fired when the
engine compacts this agent's history. You cannot alter or veto the compaction — it runs
host-side — only react to it (log it, track frequency, surface a UI notice). Unlike the
host-baked options above, `onCompaction` is a **pure client-side callback**: with a shared
`client`, set it on that `DivaClient` instead of on the `Agent`.

It receives a `CompactionEvent`:

| Field | Type | Description |
| --- | --- | --- |
| `phase` | `"before" \| "after"` | `"before"` = compaction starting; `"after"` = finished. |
| `runId` | `string` | The run this compaction occurred within (always present). |
| `sessionKey` | `string` | Session whose history was compacted. Absent for host-hidden runs (channel-driven traffic). |
| `messageCount` | `number` | Message count at this phase (present for framework auto-compaction). |
| `completed` | `boolean` | *(after only)* Whether the summary completed vs was aborted. |
| `willRetry` | `boolean` | *(after only)* Whether the framework will retry the LLM request after compacting (overflow). |
| `compactedCount` | `number` | *(after only)* Cumulative number of compactions in this session. |

A single turn fires a `before` + `after` **pair per compaction**, and can produce several
pairs when the model repeatedly overflows (each retry compacts again). Use `willRetry` to
spot a non-terminal `after`. Only **this** turn's own compactions are delivered — a nested
subagent's compaction runs under its own run and is not surfaced here. Errors thrown from
the callback are swallowed (optionally logged via the client `logger`).

```ts
const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  compaction: { recentTurnsPreserve: 4, notifyUser: true },
  onCompaction(event) {
    if (event.phase === "after") {
      console.log(
        `compacted run=${event.runId} count=${event.compactedCount} willRetry=${event.willRetry}`,
      );
    }
  },
});
```

## Full example

```ts
// DIVA_API_KEY=sk-diva-… node --import tsx examples/params.ts
import { Agent } from "@diva-ai/sdk";

async function main(): Promise<void> {
  const agent = new Agent("diva/gpt/gpt-4o-mini", {
    // Cap length + steer sampling; parallel_tool_calls is OpenAI-scoped.
    params: { maxTokens: 400, temperature: 0.2, parallel_tool_calls: false },
    thinkingDefault: "low",
    compaction: {
      recentTurnsPreserve: 4,
      maxHistoryShare: 0.4,
      model: "diva/gpt/gpt-4o-mini",
      customInstructions: "Keep the customer's language and any open action items.",
    },
    onCompaction: (e) => console.log(`[compaction ${e.phase}] run=${e.runId}`),
  });

  try {
    const { text } = await agent.run("Write a 2000-word essay about the ocean.");
    console.log(`length: ${text.length} chars`);
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## Notes & caveats

- **`params`, `thinkingDefault`, and `compaction` require the agent to own its host.**
  Passing any of them together with an explicit `client` throws a `DivaError` at
  construction (e.g. *"Agent `params` … require the agent to own its host: pass `params`
  without a shared `client` …"*). Configure the implicit client via `clientOptions`, or set
  the equivalent field on the shared `DivaClient`.
- **`onCompaction` is the exception** — it can't be *injected* into a shared client. With a
  shared `client`, set `onCompaction` on that `DivaClient`; on the `Agent` it throws.
- **An unknown compaction `model` silently disables compaction.** If `compaction.model`
  doesn't resolve to a real model reference, compaction is turned off (history keeps
  growing) rather than erroring — always pass a valid `provider/model` ref.
- **`top_p` in `params` is a no-op.** The engine does not read it; use `temperature` for
  sampling and `thinkingDefault` for reasoning effort.
- **Compaction can't be disabled.** You can only tune it. For very long conversations kept
  entirely on your side, note that a client-side `store` bypasses engine compaction and
  bounds history by `maxTurns` instead — see
  [Sessions & memory](./sessions-and-memory.md#notes--caveats).
- **`notifyUser: true` adds a text chunk.** The "🧹 Compacting context…" notice surfaces in
  the `run()`/`stream()` reply — account for it if you parse the stream.
- **Validation is synchronous.** Out-of-range `compaction` values and unknown
  `thinkingDefault` levels throw a clean `DivaError` at construction, not an opaque
  engine error mid-turn.

## See also

- [Agents](./agents.md) — the `Agent` API and the owns-its-host rule these options trigger.
- [Sessions & memory](./sessions-and-memory.md) — server-side sessions vs. a client `store`, and how a store interacts with compaction.
- [Streaming](./streaming.md) — parsing `run()`/`stream()` output (including `notifyUser` notices).
- [Error handling](./error-handling.md) — `DivaError` construction-time validation failures.
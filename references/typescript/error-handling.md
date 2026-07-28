# Error handling

The SDK throws a single, importable hierarchy rooted at `DivaError`. Every failure — a
missing key, an unreachable gateway, a turn error, a tripped guard, a broken hook, an unwired
feature — surfaces as a typed subclass you can `instanceof` and whose `detail` carries the
context you need to debug (provider, model, gateway code, the underlying cause). Nothing fails
silently.

All error classes are exported from the package root:

```ts
import {
  DivaError, DivaAuthError, DivaHostError,
  DivaRequestError, DivaNotImplementedError, DivaHookError, DivaGuardTripped,
} from "@diva-ai/sdk";
```

## The hierarchy

```
DivaError
├─ DivaAuthError
├─ DivaHostError
├─ DivaRequestError
├─ DivaNotImplementedError
├─ DivaHookError
└─ DivaGuardTripped
```

| Class | Extends | Thrown when | Carries |
| --- | --- | --- | --- |
| `DivaError` | `Error` | Base class; also thrown directly for construction-time misconfiguration — host-ownership violations (e.g. `tools` with a shared `client`), a model ref missing its platform namespace, or a `generate()` schema that can't convert to JSON Schema. | `message`; `cause` (via `Error`'s `options.cause`). |
| `DivaAuthError` | `DivaError` | No Diva API key: neither `{ apiKey }` nor `DIVA_API_KEY` is set. Thrown at **client construction** (so at `new Agent(...)` when using the implicit client). | `message` only — e.g. *"No Diva API key. Pass { apiKey } or set DIVA_API_KEY (sk-diva-… from the platform API-keys page)."* |
| `DivaHostError` | `DivaError` | The gateway could not be reached, or the client was used after `close()` / `stop()`. | `detail.cause?: unknown` (the underlying transport error). |
| `DivaRequestError` | `DivaError` | A gateway request failed: the agent turn errored on the platform, timed out, or the connection dropped mid-call and could not be recovered. Also thrown by `generate()` when the reply still doesn't match the schema after its one retry. | `detail.code?: string \| number` (gateway error code), `detail.provider?: string`, `detail.model?: string`, `detail.cause?: unknown` (the wrapped internal gateway error). |
| `DivaNotImplementedError` | `DivaError` | A capability is declared in the public API but not available on the hosted client — an unwired [hook](./hooks.md) name, `knowledge` (RAG), platform channels, or the self-host-only `builtinTools` / `permissions.mode` / `permissions.deny`. Thrown loudly rather than no-op'd, so callers never depend on an unavailable feature. | `message` only. |
| `DivaHookError` | `DivaError` | A [hook's](./hooks.md) own code threw, or a hook misbehaved (non-string `replace` for a text slot, a tool-input `replace` that fails the schema, a chain that didn't converge in 8 passes, or a `before_tool_call` hook that resolved after the tool deadline). Hook errors are LOUD — never swallowed. | `detail.hook?: string` (the guard/handler identity), `detail.cause?: unknown`. |
| `DivaGuardTripped` | `DivaError` | A [guard](./guards.md) — or a hook returning `{ block }` — deliberately tripped. Distinct from `DivaHookError` (an *unexpected* throw): this is a *deliberate* block. Message format: `` `${guard} blocked: ${reason}` ``. | `detail.guard: string`, `detail.reason: string` (both **required**). |

## Where each error appears

- **At construction** (`new Agent(...)` / `new DivaClient(...)`): `DivaAuthError` (no key);
  `DivaError` (host-ownership violations — see [Agents](./agents.md); e.g. passing `tools`,
  `mcp`, `params`, `hooks` with tool hooks, etc. alongside a shared `client`);
  `DivaNotImplementedError` (declaring an unwired [hook](./hooks.md) name — hooks are compiled
  in the constructor — or the self-host-only `builtinTools` / `permissions.mode` / `deny`).
- **At the start of a turn** (`run()` / `stream()` / `generate()`): `DivaNotImplementedError`
  (`knowledge` / RAG); `DivaError` (a model ref missing its platform namespace, e.g. `"gpt-5"`
  instead of `"diva/gpt/gpt-4o-mini"`).
- **During a turn**: `DivaHostError` (the gateway could not be reached); `DivaRequestError`
  (gateway/turn failure, timeout, or an unrecoverable mid-stream drop); `DivaGuardTripped` (a
  turn-level guard or hook block); `DivaHookError` (a hook threw or returned a bad `replace`).

## Built-in retry & supervision

The SDK does meaningful recovery for you before an error ever reaches your `catch`:

- **Stream reconnect & replay.** If a streaming turn's WebSocket drops mid-run (a transient
  network blip) **after** it had connected, the SDK replays the run's missed events from the
  gateway's server-side buffer and continues to the run's terminal instead of failing the turn.
  It is bounded by the turn's timeout; only an unrecoverable drop (or a gateway that never comes
  back) surfaces as a `DivaRequestError`.
- **Actionable connect failures.** If the gateway was never reachable, the SDK relabels the
  opaque WebSocket error with the endpoint it tried and how to fix it (set `DIVA_GATEWAY_URL` or
  pass `clientOptions.remoteHost`) rather than leaking a raw socket error.
- **Turn cancellation on failure.** On a client-side timeout or failure, the SDK cancels the
  still-running server turn (best-effort) before wrapping the internal gateway error in
  `DivaRequestError` — so a timed-out turn doesn't keep burning tokens server-side.
- **`generate()` self-repair.** `generate()` re-asks the model **once**, within the same
  (generate-scoped) session so the model sees its rejected reply, if the output doesn't
  validate. Only if the retry also fails does it throw `DivaRequestError` (with the last reply
  text in the message and `detail.cause` set to the last validation error). See
  [Structured output](./structured-output.md).
- **Timeouts.** The default per-turn request timeout is 60 s; when an interactive
  `permissions.canUseTool` is configured the turn budget is extended past the approval window
  so a decision in flight doesn't abort the turn.

There is **no automatic retry of a failed gateway turn** — a `DivaRequestError` is surfaced to
you to handle (retry, fall back, or report) with full context in `detail`.

## Example

```ts
// DIVA_API_KEY=sk-diva-… node --import tsx app.ts
import { Agent, DivaAuthError, DivaHostError, DivaRequestError } from "@diva-ai/sdk";

// Missing key -> DivaAuthError at construction (thrown by the implicit client).
try {
  const saved = process.env.DIVA_API_KEY;
  delete process.env.DIVA_API_KEY;
  new Agent("diva/gpt/gpt-4o-mini");
  if (saved) process.env.DIVA_API_KEY = saved;
} catch (err) {
  if (err instanceof DivaAuthError) console.log("no key ->", err.message);
}

const agent = new Agent("diva/gpt/gpt-4o-mini");
try {
  await agent.run("hello");
} catch (err) {
  if (err instanceof DivaRequestError) {
    // A turn failed on the platform (auth, model, timeout). Inspect typed detail:
    console.error("request failed:", err.detail?.code, err.detail?.model, err.detail?.cause);
  } else if (err instanceof DivaHostError) {
    // The gateway could not be reached (or the client was used after close()).
    console.error("gateway unreachable:", err.detail?.cause);
  } else {
    throw err;
  }
} finally {
  await agent.close();
}
```

### Distinguishing every failure mode

Order matters: check the most specific class first. `DivaError` last catches anything you
didn't name.

```ts
import {
  DivaError, DivaAuthError, DivaGuardTripped, DivaHookError,
  DivaHostError, DivaNotImplementedError, DivaRequestError,
} from "@diva-ai/sdk";

try {
  const { text } = await agent.run(userMessage);
  return text;
} catch (err) {
  if (err instanceof DivaGuardTripped) {
    // A deliberate policy block (a turn-level guard or a hook `block`).
    console.warn(`blocked by ${err.detail.guard}: ${err.detail.reason}`);
  } else if (err instanceof DivaHookError) {
    // A hook's own code threw / misbehaved — a bug in your hook.
    console.error(`hook ${err.detail?.hook} failed`, err.detail?.cause);
  } else if (err instanceof DivaRequestError) {
    // Platform/gateway turn failure — retriable at your discretion.
    console.error(`gateway ${err.detail?.code} on ${err.detail?.provider}/${err.detail?.model}`);
  } else if (err instanceof DivaHostError) {
    console.error("gateway unreachable / client closed", err.detail?.cause);
  } else if (err instanceof DivaAuthError) {
    console.error("missing/invalid DIVA_API_KEY");
  } else if (err instanceof DivaNotImplementedError) {
    console.error("feature not available on the hosted client:", err.message);
  } else if (err instanceof DivaError) {
    console.error("Diva SDK error:", err.message);
  } else {
    throw err; // not ours — re-throw
  }
}
```

### A guarded retry on transient gateway failures

Because the SDK manages the gateway connection and does not auto-retry the gateway turn, a thin
application-level retry over `DivaRequestError` is a reasonable pattern:

```ts
import { Agent, DivaRequestError } from "@diva-ai/sdk";

async function runWithRetry(agent: Agent, message: string, attempts: number): Promise<string> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return (await agent.run(message)).text;
    } catch (err) {
      if (!(err instanceof DivaRequestError)) throw err; // only retry gateway turns
      lastError = err;
      console.warn(`attempt ${i + 1} failed (${err.detail?.code}); retrying`);
    }
  }
  throw lastError;
}
```

## Notes & caveats

- **Import the types you match.** All seven classes are exported from `@diva-ai/sdk`; never
  reach for an internal, non-importable gateway error — `DivaRequestError.detail.cause` holds
  the underlying gateway error if you need to inspect it.
- **`DivaGuardTripped.detail` is required**, so `err.detail.guard` / `err.detail.reason` are
  always present; the other subclasses' `detail` is optional (use `?.`).
- **Soft tool blocks don't throw.** A `before_tool_call` [hook](./hooks.md) / `guard.tool`
  block never reaches your `catch` — it surfaces to the *model* as a "blocked by policy" tool
  result. Only turn-level blocks (reply/message/`guard.output`/`guard.custom`) raise
  `DivaGuardTripped` to you.
- **`DivaNotImplementedError` is the honest boundary.** It marks features present in the API
  surface but not available on the hosted client: unwired [hook](./hooks.md) names, `knowledge`
  (RAG), platform channels, and the self-host-only `builtinTools` / `permissions.mode` / `deny`.
  Treat it as "not available in this mode," not a bug.
- **After `close()`**, further calls throw `DivaHostError` (*"DivaClient is closed — create a
  new Agent/DivaClient to run again"*). Create a fresh `Agent` / `DivaClient` rather than
  reusing a closed one.

## See also

- [Hooks](./hooks.md) — sources of `DivaHookError` and `DivaGuardTripped`.
- [Guards](./guards.md) — tripwires that raise `DivaGuardTripped`.
- [Permissions](./permissions.md) — `canUseTool` gating for the engine's built-in tools.
- [Agents](./agents.md) — the "owns its host" rule behind construction-time `DivaError`s.
- [Structured output](./structured-output.md) — `generate()`'s retry and its `DivaRequestError`.
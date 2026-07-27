---
name: deployment-and-errors
description: Use when deciding hosted vs self-hosted gateway targets, handling the DivaError exception hierarchy (DivaAuthError/DivaHostError/DivaRequestError/DivaNotImplementedError/DivaHookError/DivaGuardTripped), or tuning params/thinkingDefault/compaction in the Diva SDK — includes real Python vs TypeScript divergences (auth-error timing, default timeouts, compaction Python-only-missing, host-owned config scope).
---

# Deployment, Errors & Model Configuration

Both SDKs are **hosted-first thin clients**: the agent loop, model routing, and tool orchestration
always run **server-side** on a Diva gateway. Neither client ever spawns or supervises a local
engine — they only ever open a WebSocket connection.

## Deployment — where the engine runs

| Mode | How you select it | What ships to your machine |
| --- | --- | --- |
| **Platform (default)** | pass an `sk-diva-…` key, nothing else | nothing but the thin client |
| **Self-host (advanced)** | point at your own gateway URL | nothing — you already run the engine |

```ts
// TypeScript — platform default
import { Agent } from "@diva-ai/sdk";
const agent = new Agent("diva/gpt/gpt-4o-mini", { apiKey: process.env.DIVA_API_KEY });

// self-host — explicit remoteHost always wins
const selfHosted = new Agent("diva/gpt/gpt-4o-mini", {
  clientOptions: { remoteHost: { url: "wss://engine.internal/gateway", token: process.env.GATEWAY_TOKEN } },
});
```

```python
# Python — platform default
from diva_ai import Agent
agent = Agent("diva/gpt/gpt-4o-mini", api_key=os.environ["DIVA_API_KEY"])

# self-host — one bearer token (api_key) for whichever gateway_url resolves
self_hosted = Agent("diva/gpt/gpt-4o-mini", api_key=os.environ["GATEWAY_TOKEN"],
                     gateway_url="wss://engine.internal/gateway")
```

### Selection precedence

- **TS**: explicit `clientOptions.remoteHost` → `DIVA_GATEWAY_URL` env → `apiKey` alone (platform).
  Resolved (and `DivaAuthError` raised if nothing resolves) essentially **at construction** for
  the implicit client.
- **Python**: `gateway_url=` constructor arg → `DIVA_GATEWAY_URL` env → `DEFAULT_GATEWAY_URL`
  (platform), resolved **lazily on the first turn**, not at construction — see the error-timing
  divergence below.

### Real divergences (deployment)

- **No separate "platform key" vs "self-host token" in Python.** TS's `remoteHost: { url, token }`
  carries its own bearer token distinct from `apiKey`. Python has a single `api_key`/`DIVA_API_KEY`
  used as the bearer token for whichever `gateway_url` is resolved — always.
- **`ws://` is restricted in Python, undocumented as a check in TS.** Python validates the scheme
  when the connection opens: `wss://` always allowed; plain `ws://` only to `localhost`/
  `127.0.0.1`/`::1` unless you set `DIVA_ALLOW_INSECURE_PRIVATE_WS=1`. Anything else raises
  `DivaAuthError` naming the rejected host.
- **Host-owned config scope is fundamentally narrower in Python.** TS: `builtinTools` and
  `permissions.mode`/`permissions.deny` gate the engine's shell/filesystem/network built-ins —
  they're **self-host only**, throwing `DivaNotImplementedError` on the hosted platform (enabling
  them for a shared host would be RCE for anyone with a key). Python: **there is no
  `builtin_tools` parameter at all**, and `Permissions.mode`/`Permissions.deny` **always** raise
  `DivaNotImplementedError` regardless of which `gateway_url` you point at — `diva_ai` is a thin
  client end-to-end; self-hosting the *gateway* does not unlock engine built-ins in the *Python
  client*. To get the same effect in either SDK, wrap what you need as your own client `tool()`
  (it runs on your machine — sandbox it there).
- Everything else — `tools`, `mcp`, `params`, `thinkingDefault`/`thinking_default`, `flow`,
  `hooks`, `guards`, `handoff`, interactive `permissions.canUseTool`/`can_use_tool` + `allow` —
  works over either target, per-turn, in both SDKs. Because **all** tools are client tools in both
  clients, client-side gates cover every call the model can make.

## Error handling

Single hierarchy, same six subclasses, same import surface, in both SDKs:

```
DivaError
├─ DivaAuthError            # no/invalid key, no gateway target, rejected ws://
├─ DivaHostError             # gateway unreachable / connection state issue
├─ DivaRequestError          # turn failed on the platform, timed out, or dropped
├─ DivaNotImplementedError   # declared in the API but not available on this client
├─ DivaHookError             # a hook's own code threw / misbehaved
└─ DivaGuardTripped          # a guard or hook `block` deliberately tripped
```

```ts
// TypeScript
import { Agent, DivaGuardTripped, DivaHookError, DivaRequestError, DivaHostError,
         DivaAuthError, DivaNotImplementedError, DivaError } from "@diva-ai/sdk";
try {
  const { text } = await agent.run(userMessage);
} catch (err) {
  if (err instanceof DivaGuardTripped) console.warn(err.detail.guard, err.detail.reason);
  else if (err instanceof DivaRequestError) console.error(err.detail?.code, err.detail?.model);
  else if (err instanceof DivaError) console.error(err.message);
  else throw err;
}
```

```python
# Python
from diva_ai import DivaGuardTripped, DivaHookError, DivaRequestError, DivaHostError, \
    DivaAuthError, DivaNotImplementedError, DivaError
try:
    result = await agent.run(user_message)
except DivaGuardTripped as err:
    print(err.detail["guard"], err.detail["reason"])       # always present, both required ctor args
except DivaRequestError as err:
    detail = err.detail or {}
    print(detail.get("code"), detail.get("model"))
except DivaError as err:
    print(err)
```

### Real divergences (errors & retry)

- **`DivaAuthError` timing for a missing key is the headline divergence.** TS: for a missing key,
  the implicit client throws at **construction** (`new Agent(...)`). Python: construction always
  succeeds — `DivaAuthError` only surfaces **lazily, on the first `run()`/`stream()`/`generate()`
  call**, because that's when the `Agent` first opens a gateway connection. Don't assume a
  successfully constructed Python `Agent` has a valid key.
- **`close()` semantics differ.** TS: after `close()`, further calls throw `DivaHostError` — you
  must create a fresh `Agent`. Python: `close()` only tears down MCP connections and drops the
  cached client; it does **not** permanently close the `Agent` (each turn opens/closes its own
  gateway connection anyway) — a subsequent `run()` transparently reconnects instead of raising.
- **Default per-turn timeout differs**: **60 s in TS**, **120 s in Python**. Pass `timeout=`
  (Python) or rely on the SDK's own extension for `canUseTool` (TS) if you need longer.
- **`DivaHookError` triggers differ** because the underlying hook chains differ (see
  [Hooks & Flow](../hooks-flow/SKILL.md)): TS can additionally raise it for a chain that didn't
  converge in 8 `replace` passes, or a `before_tool_call` hook resolving after the tool deadline
  (there's an abort signal to miss). Python has neither concept — single-pass chain, no abort
  signal — so those two triggers don't exist there.
- **`.detail` presence differs by class in Python, uniformly optional-except-one in both.**
  `DivaGuardTripped.detail` is always a populated dict in both SDKs. In Python, `DivaError` and
  `DivaNotImplementedError` **never** set `.detail` at all (base `Exception.args` only); guard
  every other subclass's `.detail` access with `err.detail or {}`.
- **Stream reconnect/replay exists in both** but with different trigger sets (TS: any drop after
  connect; Python: specific close codes 1006/1001/1012 plus a stall/poll budget) and a different
  reconnect budget (Python: `min(120, max(30, timeout))` seconds). Neither auto-retries a plain
  failed gateway turn — write an app-level retry over `DivaRequestError` if you want one (same
  pattern both languages: catch `DivaRequestError` only, loop with an attempt counter).

## Model configuration

`params` (generation), `thinkingDefault`/`thinking_default` (reasoning effort), and — **TS
only** — `compaction` (auto-summarization).

```ts
// TypeScript
const agent = new Agent("diva/gpt/gpt-4o-mini", {
  params: { maxTokens: 400, temperature: 0.2 },   // maxTokens is a HARD output cap
  thinkingDefault: "medium",                       // off|minimal|low|medium|high|xhigh|adaptive
  compaction: { recentTurnsPreserve: 4, maxHistoryShare: 0.4, model: "diva/gpt/gpt-4o-mini" },
});
```

```python
# Python — params keys are the PLATFORM'S WIRE NAMES, not snake_case
agent = Agent(
    "diva/gpt/gpt-4o-mini",
    params={"maxTokens": 400, "temperature": 0.2},   # NOT max_tokens
    thinking_default="medium",
)
```

### Real divergences (model configuration)

- **Compaction does not exist in Python.** TS's history auto-summarization (always-on, tunable via
  `compaction` + observable via `onCompaction`) has **no equivalent** in `diva_ai` — verified
  against `Agent.__init__`: no `compaction` or `on_compaction` parameter, no `compaction` module.
  Passing either raises a plain `TypeError` (unrecognized keyword), **not** a `DivaError` — it
  isn't a rejected-but-known option, it simply isn't in the signature. To bound a long Python
  conversation, use a client-side `store=MemoryStore(max_turns=N)` (or `FileStore`) instead — this
  bypasses engine history handling entirely and hard-caps turns rather than summarizing.
- **`params` validation differs.** TS validates some fields at construction (e.g. `thinkingDefault`
  synchronously). Python's `params` is **entirely unvalidated client-side** — a raw
  `dict[str, Any]` forwarded as-is on the wire; bad/unknown keys reach the gateway unchanged.
  **In both languages `params` keys stay camelCase** (`maxTokens`, `parallel_tool_calls` is the
  one snake_case provider key) — this is the one escape hatch that isn't converted to Python's
  usual `snake_case`.
- **No per-turn `thinking_default` override in Python.** TS: "a per-message directive can still
  override it for a single turn." Python: `run()`/`stream()`/`generate()` accept a per-turn
  `model=` override but **not** a reasoning-level override — `thinking_default` is fixed for the
  `Agent`'s lifetime. Python additionally exports `THINKING_LEVELS` and `validate_thinking_default`
  for validating a value before construction.
- **"Owns its host" applies only to TS.** TS: `params`/`thinkingDefault`/`compaction` bake into the
  agent's own engine session, so setting any of them alongside a shared `client` throws
  `DivaError` at construction. Python has no shared-`client` concept, so this restriction never
  applies — every `Agent` always owns its own connection.
- `top_p` is a no-op in `params` in **both** SDKs — use `temperature` for sampling and
  `thinkingDefault`/`thinking_default` for reasoning effort.

Full docs: https://front.dev.diva-ai.ru/ux/sdk-docs

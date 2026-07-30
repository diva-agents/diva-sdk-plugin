# Error handling

The SDK raises a single, importable exception hierarchy rooted at
`DivaError`. Every failure — a missing key, an unreachable gateway, a turn
error, a tripped guard, a broken hook, an unwired feature — surfaces as a
typed subclass you can check with `isinstance()`, and whose `detail` dict
carries the context you need to debug (provider, model, gateway code, the
underlying cause). Nothing fails silently.

All error classes are exported from the package root:

```python
from diva_ai import (
    DivaError,
    DivaAuthError,
    DivaHostError,
    DivaRequestError,
    DivaNotImplementedError,
    DivaHookError,
    DivaGuardTripped,
)
```

## The hierarchy

```
DivaError(Exception)
├─ DivaAuthError
├─ DivaHostError
├─ DivaRequestError
├─ DivaNotImplementedError
├─ DivaHookError
└─ DivaGuardTripped
```

| Class | Extends | Raised when | Carries |
| --- | --- | --- | --- |
| `DivaError` | `Exception` | Base class; also raised directly for misconfiguration that has nowhere more specific to go — bad `Permissions` values, a duplicate tool/skill/MCP-server name, an invalid `thinking_default`, a malformed `FileStore` payload, an invalid `Flow` slot, and similar builder-time checks. | The message, via `Exception.args`. No `detail`. |
| `DivaAuthError` | `DivaError` | An empty/blank `model` ref passed to `Agent(...)` (raised at construction); **or**, lazily, at the start of the first turn — no API key resolvable (`api_key=` / `DIVA_API_KEY`), no gateway target resolvable, or an insecure `ws://` URL rejected by the client. | The message only. No `detail`. |
| `DivaHostError` | `DivaError` | The gateway WebSocket could not be opened, or an internal request is attempted on a connection that was never opened. | `detail: dict \| None` — `detail["cause"]` holds the underlying exception when known. |
| `DivaRequestError` | `DivaError` | A gateway request failed, the turn errored on the platform, a request timed out, or a dropped stream could not be resumed. Also raised by `generate()` once its single retry still fails schema validation. | `detail: dict \| None` — commonly some of `code`, `provider`, `model`, `runId`, `cause`, depending on the site. |
| `DivaNotImplementedError` | `DivaError` | A capability declared in the public API but not available on the thin client: `knowledge=...` (RAG), `Permissions.mode` / `Permissions.deny` (engine built-ins), or a platform (string) entry in `skills=[...]` instead of a local `Skill`. | The message only. No `detail`. |
| `DivaHookError` | `DivaError` | A hook's own code raised (surfaced via the `agent_end` observer), or a `before_agent_start` / `before_reply` / `final_reply_guard` hook's `{"replace": ...}` outcome was not a string. | The message only. No `detail`. |
| `DivaGuardTripped` | `DivaError` | A turn-level guard (`guard.output`, `guard.input`, `guard.custom`) or a hook returning `{"block": reason}` on `before_agent_start` / `before_reply` / `final_reply_guard` deliberately blocked the turn. | `detail: dict` — always `{"guard": str, "reason": str}` (both are required positional constructor args). |

## Where each error appears

- **At builder-function call time** (before `Agent(...)`, while assembling a
  reusable piece): `DivaError` from `tool()`, `toolset()`, `skill()`,
  `skill_from_dir()`, `flow()`, `handoff()`, `MCP.stdio()` / `MCP.http()` —
  each validates its own arguments immediately (duplicate names, empty
  descriptions, an oversized skill body, a missing MCP command, and so on).
- **At `Agent(...)` construction:** `DivaAuthError` (a blank/empty `model`);
  `DivaError` (an invalid `thinking_default`, `Permissions` validation
  failures, or a duplicate server name across the `mcp=` list);
  `DivaNotImplementedError` (`knowledge=...`, or `Permissions(mode=...)` /
  `Permissions(deny=[...])`).
- **At the start of a turn** (`run()` / `stream()` / `generate()`, on the
  *first* call for this `Agent`): `DivaAuthError` — no API key, no gateway
  target, or a rejected `ws://` URL. These are checked lazily rather than at
  construction, because the `Agent` only opens a gateway connection once a
  turn actually starts. Also `DivaNotImplementedError` (a platform
  `skills=["name"]` string entry) and `DivaError` (an MCP-bridged tool name
  colliding with an existing tool name) — MCP servers are connected lazily on
  the first turn too.
- **During a turn:** `DivaHostError` (the gateway could not be reached);
  `DivaRequestError` (gateway/turn failure, timeout, or an unrecoverable
  mid-stream drop); `DivaGuardTripped` (a turn-level guard or hook block);
  `DivaHookError` (a hook raised, or returned a non-string `replace`).

## Built-in retry & supervision

The SDK does some recovery for you before an error ever reaches your
`except`:

- **Stream reconnect & replay.** If a `stream()` turn's WebSocket drops
  mid-run — a transient close code (1006, 1001, 1012) or an unrecognized
  abnormal close — **after** it had connected, the SDK reconnects on a
  dedicated `agent.streamEvents` scope and replays the run's missed events
  from the gateway's server-side event buffer, resuming your async iterator
  instead of failing the turn. A `gap` (the server's buffer already advanced
  past your cursor) aborts the session and raises `DivaRequestError`; so does
  a stall (20 polls with no new events) or exhausting the reconnect budget
  (`min(120, max(30, timeout))` seconds).
- **`generate()` self-repair.** `generate()` re-asks the model **once**,
  inside the same `generate:<uuid>`-scoped session so the model sees its
  rejected reply, if the output isn't valid JSON or doesn't validate against
  your pydantic `schema`. Only if the retry also fails does it raise
  `DivaRequestError`, with the last validation error folded into the
  message. See [Quickstart](./quickstart.md#structured-output).
- **Timeouts.** The default per-turn timeout is **120 seconds**; pass
  `timeout=<seconds>` to `run()` / `stream()` / `generate()` to override it.

There is **no automatic retry of a plain failed gateway turn** — a
`DivaRequestError` from `run()` is surfaced to you to handle (retry, fall
back, or report) with whatever context is in `detail`.

## Example

```python
# DIVA_API_KEY=sk-diva-... python app.py
import asyncio
import os
from diva_ai import Agent, DivaAuthError, DivaHostError, DivaRequestError


async def main() -> None:
    # Missing key -> DivaAuthError, but only once a turn actually starts;
    # construction itself does not check for a key.
    saved_key = os.environ.pop("DIVA_API_KEY", None)
    no_key_agent = Agent("diva/deepseek/deepseek-v4-flash")  # construction succeeds
    try:
        await no_key_agent.run("hello")
    except DivaAuthError as err:
        print("no key ->", err)
    finally:
        if saved_key is not None:
            os.environ["DIVA_API_KEY"] = saved_key

    agent = Agent("diva/deepseek/deepseek-v4-flash")
    try:
        result = await agent.run("hello")
        print(result.text)
    except DivaRequestError as err:
        # A turn failed on the platform (auth, model, timeout). Inspect detail:
        detail = err.detail or {}
        print("request failed:", detail.get("code"), detail.get("cause"))
    except DivaHostError as err:
        # The gateway could not be reached.
        print("gateway unreachable:", (err.detail or {}).get("cause"))
    finally:
        await agent.close()


asyncio.run(main())
```

### Distinguishing every failure mode

Order matters: check the most specific class first. `DivaError` last catches
anything you didn't name.

```python
from diva_ai import (
    Agent,
    DivaError,
    DivaAuthError,
    DivaGuardTripped,
    DivaHookError,
    DivaHostError,
    DivaNotImplementedError,
    DivaRequestError,
)


async def handle_turn(agent: Agent, user_message: str) -> str:
    try:
        result = await agent.run(user_message)
        return result.text
    except DivaGuardTripped as err:
        # A deliberate policy block (a turn-level guard or a hook `block`).
        print(f"blocked by {err.detail['guard']}: {err.detail['reason']}")
        raise
    except DivaHookError as err:
        # A hook's own code raised / misbehaved — a bug in your hook.
        print("hook failed:", err)
        raise
    except DivaRequestError as err:
        # Platform/gateway turn failure — retriable at your discretion.
        detail = err.detail or {}
        print(f"gateway {detail.get('code')} on {detail.get('provider')}/{detail.get('model')}")
        raise
    except DivaHostError as err:
        print("gateway unreachable / connect failed:", (err.detail or {}).get("cause"))
        raise
    except DivaAuthError:
        print("missing/invalid DIVA_API_KEY, or no gateway target")
        raise
    except DivaNotImplementedError as err:
        print("feature not available on the thin client:", err)
        raise
    except DivaError as err:
        print("diva-ai error:", err)
        raise
```

### A guarded retry on transient gateway failures

Because the SDK does not auto-retry a plain failed gateway turn, a thin
application-level retry over `DivaRequestError` is a reasonable pattern:

```python
from diva_ai import Agent, DivaRequestError


async def run_with_retry(agent: Agent, message: str, attempts: int) -> str:
    last_error: DivaRequestError | None = None
    for i in range(attempts):
        try:
            result = await agent.run(message)
            return result.text
        except DivaRequestError as err:
            last_error = err
            print(f"attempt {i + 1} failed ({(err.detail or {}).get('code')}); retrying")
    assert last_error is not None
    raise last_error
```

## Notes & caveats

- **Import the classes you match.** All seven are exported from `diva_ai`;
  `DivaRequestError.detail["cause"]` (when present) holds the underlying
  gateway/transport error if you need to inspect it further.
- **`DivaGuardTripped.detail` is always a dict with `guard` and `reason`**
  (they're required positional constructor arguments), so `err.detail["guard"]`
  never fails. Every other subclass's `detail` is `dict[str, Any] | None` —
  guard access with `err.detail or {}`.
- **`DivaError` and `DivaNotImplementedError` never set `.detail`.** Only
  `DivaHostError`, `DivaRequestError`, and `DivaGuardTripped` carry one — see
  the hierarchy table above.
- **Soft tool blocks don't raise.** A `before_tool_call` / `after_tool_call`
  hook block — including `guard.tool` / `guard.tool_output` — never reaches
  your `except`. It's delivered to the *model* as an `isError` tool result
  (`"tool 'x' blocked: ..."` / `"tool 'x' output withheld: ..."`). Only
  turn-level blocks — `before_agent_start`, `before_reply`,
  `final_reply_guard` (i.e. `guard.input`, `guard.output`, `guard.custom`) —
  raise `DivaGuardTripped` to you.
- **`DivaAuthError` for a missing key is lazy, not eager.**
  `Agent("diva/deepseek/deepseek-v4-flash")` with no `DIVA_API_KEY` set constructs
  successfully; the error only surfaces on the first `run()` / `stream()` /
  `generate()` call, because that's when the `Agent` first opens a gateway
  connection.
- **`close()` does not permanently close the `Agent`.** Each turn opens and
  closes its own gateway connection, so `Agent.close()` only tears down any
  open MCP server connections and drops the cached client reference — a
  subsequent `run()` / `stream()` / `generate()` transparently reconnects
  rather than raising `DivaHostError`.
- **`DivaNotImplementedError` is the honest boundary.** It marks
  capabilities present in the public API but not available on the thin
  client: `knowledge` (RAG), `Permissions.mode` / `Permissions.deny` (these
  always target engine built-ins the thin client never exposes —
  self-hosting your own gateway does not unlock them; see
  [Deployment](./deployment.md)), and platform (string) `skills=` entries.
  Treat it as "not available in this SDK yet," not a bug.

## See also

- [Model configuration](./model-configuration.md) — the construction-time `DivaError` for an invalid `thinking_default`.
- [Tools & toolsets](./tools.md) — `Permissions.can_use_tool`, whose fail-closed denial surfaces as a tool result, not an exception.
- [Deployment](./deployment.md) — how `DivaAuthError` / `DivaHostError` relate to gateway resolution and `ws://` vs `wss://`.
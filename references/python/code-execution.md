# Code execution & built-in tools

The TypeScript SDK lets a **self-hosted** agent opt into the engine's
built-in `exec`/`process`/`read`/`write`/`web_search`/… tools through a
`builtinTools` option, routing sandboxed code execution into a hardened,
network-off Docker container. `diva_ai` has **no such surface at all** — not
a disabled one, not a fail-loud one, an absent one.

> **The scope is deliberate:** the Diva engine stays
> **server-side**; this package only speaks the gateway WS protocol over a
> bearer token. **No engine code ships.** There is no self-hosted mode to
> opt into, so there is no `builtin_tools` argument on `Agent`, no engine
> built-ins, and no Docker sandbox to provision. If you want the model to run
> code, you write your own client-side `tool()` and decide how — and
> whether — to sandbox it. The rest of this page covers that DIY path.

This mirrors the TS SDK's own **hosted-client** guidance, not its
self-hosted one. The TS guide's callout box says engine built-ins "throw
`DivaNotImplementedError`" on the hosted platform gateway, and tells
hosted-client users to "wrap what you need as your own client `tool()` (it
runs on your machine — you sandbox it), gated by `canUseTool` / `guard.tool`."
`diva_ai` has *only* that mode — [Overview](./overview.md) says it plainly:
"the agent engine runs **server-side** on Diva's hosted gateway... the engine
never runs locally." So the self-hosted `builtinTools` security model the TS
guide documents (Docker sandbox provisioning, escape-hatch stripping,
`codeExec: "host"`, …) doesn't apply here — it was never part of this
package's surface to begin with.

## What this means in practice

- **No `builtin_tools=`** on `Agent` (or anywhere else). It is not a
  declared-but-unwired parameter the way `knowledge=` is (`Agent(knowledge=
  ...)` raises `DivaNotImplementedError("knowledge/RAG is not wired in the
  thin client yet")`) — `builtin_tools` simply does not exist as a symbol
  anywhere in `diva_ai`.
- **`permissions.mode` and `permissions.deny` raise `DivaNotImplementedError`
  at construction**, because both target engine built-ins this client
  doesn't expose:

  ```python
  from diva_ai import Agent, Permissions

  Agent("diva/gpt/gpt-4o-mini", permissions=Permissions(mode="bypassPermissions"))
  # DivaNotImplementedError: permissions.mode/deny target ENGINE built-ins,
  # which the thin/hosted client does not expose. Use can_use_tool (+ allow)
  # to gate your own client tools.
  ```

- **Every tool the model can call is one you wired yourself** — via
  `tools=`/`toolsets=` (see [Tools & toolsets](./tools.md)) or an external
  MCP server bridged locally via `mcp=` (see
  [External MCP servers](./mcp.md)). There is no engine shell, no engine
  filesystem, no engine web search sitting behind a flag — there is nothing
  else on the table.

## Running code as a client tool

Since this SDK gives you no sandbox, treat any "let the model run code" tool
exactly like the TS guide's hosted-client advice: it runs **in your own
process**, so **you** own the isolation. A minimal version, gated by
`can_use_tool`:

```python
import asyncio

from pydantic import BaseModel

from diva_ai import Agent, Permissions, tool


class RunPythonInput(BaseModel):
    code: str


async def run_python(inp: RunPythonInput) -> dict:
    # DIY sandboxing — diva_ai provides none. `-I` (isolated mode) and a
    # timeout are the only guardrails here; there is no network deny, no
    # capability drop, no memory/CPU cap. For anything beyond a trusted demo,
    # run this INSIDE a container you control (see below) and gate it with
    # can_use_tool.
    proc = await asyncio.create_subprocess_exec(
        "python3", "-I", "-c", inp.code,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return {"stdout": stdout.decode(), "stderr": stderr.decode(), "exitCode": proc.returncode}


run_python_tool = tool(
    name="run_python",
    description="Run a short Python snippet and return stdout/stderr.",
    input_schema=RunPythonInput,
    execute=run_python,
)


async def can_use_tool(name: str, args: dict) -> dict:
    # The interactive per-call gate — the only enforcement layer this SDK
    # gives you for a tool like this.
    if name == "run_python":
        return {"behavior": "allow"}
    return {"behavior": "deny", "message": "not permitted"}


agent = Agent(
    "diva/gpt/gpt-4o-mini",
    instructions=(
        "You have a run_python tool that executes short Python snippets. "
        "When asked to compute something, WRITE and RUN code with run_python "
        "— never do the arithmetic yourself. Report exactly what it prints."
    ),
    tools=[run_python_tool],
    permissions=Permissions(can_use_tool=can_use_tool),
)
```

A tool that raises is not a crash: `Agent` catches the exception and reports
it to the model as a failed tool call (`"tool 'run_python' failed: ..."`), so
a timeout above surfaces as an ordinary tool error, not an unhandled
exception in your process.

### For real isolation, replicate the hardening yourself

If you need the guarantees the TS SDK's Docker sandbox provides
automatically — network-off, read-only root, dropped capabilities, resource
caps, ephemeral — you build them into your own `execute`, typically by
shelling out to `docker run` from inside the tool instead of running the
interpreter directly. Mirror the flags the TS engine applies by default:

| Concern | Flag to add yourself |
| --- | --- |
| No network egress | `--network none` |
| Read-only root filesystem | `--read-only` |
| No Linux capabilities | `--cap-drop=ALL` |
| No privilege escalation | `--security-opt=no-new-privileges` |
| Non-root | `--user <uid>:<gid>` |
| Memory cap, no swap growth | `--memory=1g --memory-swap=1g` |
| CPU cap | `--cpus=1` |
| Fork-bomb blunting | `--pids-limit=512` |
| Bounded tmpfs | `--tmpfs /tmp:size=256m,mode=1777` |
| File descriptor / file size / process caps | `--ulimit nofile=1024:1024 --ulimit fsize=268435456 --ulimit nproc=512:512` |
| Ephemeral, per-call container | `--rm` |
| Isolated workspace | mount a scratch copy, never your real project, and never read-write |

None of this is provided by `diva_ai` — it is a checklist for what to put in
your own `docker run` invocation (or equivalent gVisor/microVM setup) if you
choose to shell out to Docker from a client tool. The container is your
isolation boundary, the same way it is the TS engine's: run any command
inside it freely, because the container — not a command allowlist — is what
contains a hostile one.

## Gating with guards

`guard.tool(...)` inspects a tool call's arguments (JSON-encoded) before it
runs and can block on a substring or regex match — useful as a cheap,
synchronous check layered in front of (or instead of) an async
`can_use_tool` gate:

```python
from diva_ai import Agent, guard

agent = Agent(
    "diva/gpt/gpt-4o-mini",
    tools=[run_python_tool],
    guards=[
        guard.tool(
            "import os", "subprocess", "socket",
            tool="run_python",
            name="deny-dangerous-imports",
        ),
    ],
)
```

See [Tools & toolsets](./tools.md) for the full `can_use_tool` and guard
surface.

## Secure default (no tools at all)

With no `tools=`/`toolsets=`/`mcp=`, the model has nothing to call — there is
no engine sitting behind the agent granting it anything else:

```python
from pydantic import BaseModel

from diva_ai import Agent, tool


class GetBadgeInput(BaseModel):
    pass


def get_badge_number(_: GetBadgeInput) -> dict:
    return {"badgeNumber": "907341"}


agent = Agent(
    "diva/gpt/gpt-4o-mini",
    instructions="Answer using get_badge_number; never invent a number.",
    tools=[
        tool(
            name="get_badge_number",
            description="Returns the user's badge number.",
            input_schema=GetBadgeInput,
            execute=get_badge_number,
        ),
    ],
    # get_badge_number is the only thing the model can call — there is no
    # engine to grant shell/filesystem/web access to in the first place.
)
```

## Web search / web fetch

The TS SDK ships `web_search`/`web_fetch` engine built-ins behind
`builtinTools.webSearch` / `builtinTools.webFetch` (keyless DuckDuckGo by
default). `diva_ai` has neither. If the model needs to search the web or
fetch a URL, write your own `tool()` wrapping an HTTP client (e.g. `httpx`)
or a search API, and gate it exactly like any other tool. There is no
SDK-shipped default provider and no SDK-level "traffic-lock" to reason
about — outbound requests your tool makes are just your own process's
ordinary network traffic.

## Notes & caveats

- **`builtin_tools` does not exist.** There is no `exec`, `process`, `read`,
  `write`, `edit`, `apply_patch`, `web_search`, `web_fetch`, `image`, `pdf`,
  or session/agent-orchestration built-in anywhere in `diva_ai` — grep the
  package and you will not find them.
- **`permissions.mode` / `permissions.deny` raise `DivaNotImplementedError`
  at `Agent` construction.** Use `Permissions(can_use_tool=..., allow=[...])`
  instead — the one permission layer this SDK actually implements.
- **No Docker sandbox, no `codeExec: "host"` escape valve, no
  `agents.defaults.sandbox` config, no escape-hatch stripping** — none of
  that exists to strip, because there is no engine to strip it from.
- **No host-side `subagents` built-in either** (the TS SDK's
  `builtinTools.subagents`). This SDK's `handoff()` / `parallel()` primitives
  are client-side alternatives, not the engine-hosted parallel-lane feature
  the TS doc describes, and are out of scope for this page.
- **Everything a Python agent's model can do is exactly what you wired** via
  `tools=`, `toolsets=`, and `mcp=`. Audit those — not an engine tool
  policy — when reasoning about what an agent can do.

## See also

- [Tools & toolsets](./tools.md) — `can_use_tool`, `guard`, and how client tools execute.
- [External MCP servers](./mcp.md) — the other source of tools available to a Python agent.
- [Flow](./flow.md) — gates any tool call, including one that runs code.
- [Overview](./overview.md) — the thin-client architecture and why the engine never runs locally.
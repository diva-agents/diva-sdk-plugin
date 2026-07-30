---
name: code-execution
description: Use when you want a Diva SDK agent to run code, read/write files, or search/fetch the web — the engine built-ins (builtinTools codeExec/fileOps/webSearch/webFetch, permissions.mode/deny) and why they are UNAVAILABLE on the hosted platform (raise DivaNotImplementedError) and absent in Python, plus the client-tool() workaround that actually works, in @diva-ai/sdk (TypeScript) or diva-ai (Python).
---

# Code execution & built-in tools

The engine's built-in tools — a real shell (`exec`/`process`), filesystem (`read`/`write`/
`edit`), `web_search`, `web_fetch` — **do not run through the thin clients you install**.
`@diva-ai/sdk` and `diva-ai` are hosted-first WebSocket clients (see the **diva-sdk** and
**deployment-and-errors** skills); the agent loop runs server-side, and **all** tools the
model can call are **your** client `tool()`s + external `mcp` servers. Enabling engine
built-ins on a shared multi-tenant host would be RCE, so the SDKs **fail loud** instead of
silently no-op'ing.

If a vibe-coder asks "let the model run code / fetch this URL / search the web", the honest
answer is: **write a client `tool()` that does it in your own process** — not `builtinTools`.

## What is actually available where

| Capability | TS `@diva-ai/sdk` (hosted `sk-diva`) | TS `@diva-ai/sdk` (self-host gateway) | Python `diva-ai` (any target) |
| --- | --- | --- | --- |
| `builtinTools` codeExec / fileOps / webSearch / webFetch / subagents | ❌ `DivaNotImplementedError` at **construction** | ❌ **still** throws at construction (see footgun) | ❌ **no `builtin_tools` param exists** — absent symbol |
| `permissions.mode` / `permissions.deny` | ❌ `DivaNotImplementedError` at construction | ❌ throws at construction | ❌ `DivaNotImplementedError` at construction |
| `knowledge=` (RAG) | ❌ `DivaNotImplementedError` | ❌ same | ❌ `DivaNotImplementedError` |
| Your client `tool()` / `toolset()` | ✅ **always** (loopback MCP, never gated) | ✅ always | ✅ always |
| External `mcp` server | ✅ always | ✅ always | ✅ always |
| `permissions.canUseTool` / `can_use_tool` + `guard.*` | ✅ works remotely | ✅ | ✅ |

The exact TS throw (`client.ts`): `Not available over the hosted thin client: … builtinTools:
host built-ins never run on the shared platform host (that would be an RCE) — wrap them as
your OWN client tool()`. Python's `permissions.mode/deny` message points the same way:
`use can_use_tool (+ allow) to gate your own client tools`.

> **FOOTGUN — "self-host" does NOT re-enable `builtinTools` through this SDK.**
> The docs (`docs/code-execution.md`) describe a full self-hosted *engine* security model
> (Docker sandbox, escape-hatch stripping, `codeExec:"host"`). That model is **engine-side**.
> The standalone `@diva-ai/sdk` **never sends `builtinTools` on the wire** — it appears only
> as a type field and a throw. The `DivaClient` constructor throws on *any* truthy
> `builtinTools` **regardless of target** (`sk-diva`, `DIVA_GATEWAY_URL`, or a `remoteHost`);
> the old `localHost` local-spawn escape hatch was **removed** from the thin client
> (`agent.test.ts`: *"That path is REMOVED here — this hosted client fails loud on
> builtinTools"*). Reaching engine built-ins means running the full engine/harness, not
> passing `builtinTools` to this package. **Do not tell a user "just self-host and it works" —
> through this SDK it throws.**

> **FOOTGUN — Python has no built-ins surface at all.** Not disabled, not fail-loud — *absent*.
> `grep diva_ai` and there is no `exec`, `read`, `web_search`, or `builtin_tools`. So there is
> no Docker sandbox, no `codeExec:"host"`, no `agents.defaults.sandbox` — nothing to strip,
> because there is no engine to strip it from. Everything the model can do is exactly what you
> wired via `tools=` / `toolsets=` / `mcp=`.

## The workaround that actually works — a client `tool()`

This is the real "run code / fetch a URL / search" path on both SDKs. It runs **in your own
process**, so **you** own the isolation and you gate it (cross-ref the **tools-and-toolsets**
and **guards-permissions** skills).

```ts
// TypeScript — @diva-ai/sdk. A code-runner as a normal client tool.
import { Agent, tool, z } from "@diva-ai/sdk";

const runPython = tool({
  name: "run_python",
  description: "Run a short Python snippet; return stdout/stderr. Use for any computation.",
  inputSchema: z.object({ code: z.string() }),
  // DIY isolation: shell out to `docker run --network=none --read-only …` yourself —
  // the SDK provides NO sandbox here. A bare spawn is a trusted-demo only.
  execute: async ({ code }) => runInYourOwnSandbox(code),
});

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "Compute by calling run_python — never do arithmetic yourself.",
  tools: [runPython],
  // Gate it: permissions.canUseTool (fail-closed) and/or a guard.tool substring block.
});
```

```python
# Python — diva-ai. Same shape; permissions.can_use_tool is the enforcement layer.
import asyncio
from pydantic import BaseModel
from diva_ai import Agent, Permissions, tool

class RunPythonInput(BaseModel):
    code: str

async def run_python(inp: RunPythonInput) -> dict:
    # `-I` + a timeout are the ONLY guardrails here — no network deny, no cap-drop.
    # For real isolation, shell out to `docker run …` yourself (see table below).
    proc = await asyncio.create_subprocess_exec(
        "python3", "-I", "-c", inp.code,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), timeout=10)
    return {"stdout": out.decode(), "stderr": err.decode(), "exitCode": proc.returncode}

async def can_use_tool(name: str, args: dict) -> dict:
    return {"behavior": "allow"} if name == "run_python" else {"behavior": "deny", "message": "no"}

agent = Agent("diva/deepseek/deepseek-v4-flash",
    tools=[tool(name="run_python", description="Run a short Python snippet.",
                input_schema=RunPythonInput, execute=run_python)],
    permissions=Permissions(can_use_tool=can_use_tool))
```

A raised error inside `execute` is **not** a crash — the agent reports it to the model as a
failed tool call and the turn continues. Raise specific errors; don't swallow them.

If you need real hardening in your own tool, mirror the flags the engine would apply:
`--network none --read-only --cap-drop=ALL --security-opt=no-new-privileges --user <uid>:<gid>
--memory=1g --memory-swap=1g --cpus=1 --pids-limit=512 --tmpfs /tmp:size=256m --rm`, and mount
a scratch copy of the workspace, never your real project.

## The self-host option shapes (reference — the ENGINE model, not reachable via this SDK)

For completeness, `builtinTools` is a `BuiltinToolsConfig` (TS-only type; passing it throws —
see footgun). If you run the full engine, these are what the fields mean:

```ts
type BuiltinToolsConfig = {
  codeExec?: false | "sandbox" | "host"; // "sandbox": hardened Docker (net off, ro-root, cap-drop,
                                          // non-root, 1cpu/1g, isolated ro workspace copy, ephemeral).
                                          // "host": runs on the REAL machine, no isolation — you own the RCE.
  fileOps?:  false | "workspace" | "full"; // "workspace": confined; "full": whole host fs (dangerous).
  webSearch?: boolean | { readonly provider?: string }; // keyless DuckDuckGo; egresses to the provider.
  webFetch?: boolean;                       // URL → markdown; outbound egress.
  subagents?: boolean | { maxParallel?; perTenantMaxParallel?; maxSpawnDepth?; allowAgents? };
};
```

`codeExec:"sandbox"` is the intended path (the container *is* the boundary; `security:"full"`
means any command runs *inside* it). `codeExec:"host"` is unsandboxed and inherits ambient
non-Diva secrets (`OPENAI_API_KEY`, `AWS_*`, `GITHUB_TOKEN`); `DIVA_*` keys are scrubbed. None
of this is reachable by passing `builtinTools` to `@diva-ai/sdk`.

## See also

- **tools-and-toolsets** — client `tool()` / `toolset()`, the real path here.
- **guards-permissions** — `canUseTool` / `guard.*` to gate a code-runner tool.
- **deployment-and-errors** — hosted vs self-host targets and the `DivaError` hierarchy.
- **diva-sdk** — the thin-client architecture (why the engine never runs locally).
- Full docs: https://front.dev.diva-ai.ru/ux/sdk-docs

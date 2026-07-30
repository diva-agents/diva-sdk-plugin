# Diva SDK

Build production AI agents on the **Diva platform** from TypeScript. `@diva-ai/sdk` gives you an
agent runtime — the model loop, tools, sandboxed code execution, context management, permissions,
sessions — as a library: you describe an agent, call `run()`, and get a reply.

```ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You are a concise assistant.",
});

const { text } = await agent.run("Explain vector databases in one sentence.");
console.log(text);

await agent.close();
```

`@diva-ai/sdk` is a **thin, typed client** (like the OpenAI/Anthropic SDKs): the agent harness — the
Diva runtime — runs **server-side on the Diva platform** and is never downloaded, reached over a
WebSocket. **Every LLM call goes through the Diva platform `/v1` gateway**, authenticated by your
`sk-diva-…` key; there is no bring-your-own-provider — traffic is locked to the platform by design.
You can also point the same client at your **own** engine — see [Deployment](./deployment.md) and
[Core concepts](./core-concepts.md).

## Why Diva SDK

- **Batteries included.** Client tools, MCP, sub-agents, skills, structured conversation flows,
  per-turn params/compaction/reasoning, and (when self-hosted) sandboxed code execution ship in the
  box — not left as an exercise.
- **Secure by default.** The model gets *only* the client-side tools you hand it, gated by
  `canUseTool` / `guard.tool` / `flow`. Engine built-ins (shell, filesystem, network) are never
  exposed on the shared platform host — enable them by self-hosting. See [Deployment](./deployment.md)
  and [Code execution](./code-execution.md).
- **Human-in-the-loop.** A Claude-parity `canUseTool` callback can gate *every* tool call with the
  tool's full arguments, fail-closed. See [Permissions](./permissions.md).
- **Traffic-locked.** One key (`sk-diva-…`), one gateway. No provider keys to manage, no egress to
  audit per model.

## Capabilities

| Area | What you get | Guide |
| --- | --- | --- |
| **Agents** | `run()` / `stream()` / `generate()`, instructions, model refs, lifecycle | [Agents](./agents.md) |
| **Client tools** | In-process `tool()` functions the model can call (via a loopback MCP) | [Tools](./tools.md) · [Toolsets](./toolsets.md) |
| **External MCP** | Connect stdio / streamable-HTTP MCP servers | [MCP](./mcp.md) |
| **Code execution** | Sandboxed (Docker) or host code exec, web search, file ops — self-host only | [Code execution](./code-execution.md) |
| **Permissions / HITL** | `canUseTool` approval gate, allow/deny, permission modes | [Permissions](./permissions.md) |
| **Sessions & memory** | Multi-turn sessions, per-user isolation, BYO local stores | [Sessions & memory](./sessions-and-memory.md) |
| **Streaming** | Token-by-token deltas + a terminal result | [Streaming](./streaming.md) |
| **Structured output** | `generate()` with a Zod schema → typed object | [Structured output](./structured-output.md) |
| **Model tuning** | Generation params, reasoning level, context compaction | [Model configuration](./model-configuration.md) |
| **Skills** | Progressive-disclosure capabilities the model loads on demand | [Skills](./skills.md) |
| **Sub-agents** | Delegate focused subtasks with `handoff()` | [Sub-agents](./subagents.md) |
| **Parallel agents** | Run agents/sub-agents concurrently — `parallel()`, parallel handoffs, host-side fair-scheduled sub-agents | [Parallel agents](./parallel-agents.md) |
| **Flows** | Slot-filling conversation flows that gate tools until requirements are met | [Flow](./flow.md) |
| **Hooks & guards** | Observe/mutate/block the agent lifecycle; client-side business rules | [Hooks](./hooks.md) · [Guards](./guards.md) |
| **Errors** | A typed `DivaError` hierarchy | [Error handling](./error-handling.md) |

Full symbol-by-symbol reference: [API reference](./api-reference.md).

## Install

```bash
pnpm add @diva-ai/sdk
# or: npm i @diva-ai/sdk  ·  yarn add @diva-ai/sdk
```

Requires **Node ≥ 22.14**. The published package is a thin client — no engine bundle, connects to
the platform engine over a WebSocket. Full setup and your first agent: [Getting started](./getting-started.md).

## How it compares

The Diva SDK is inspired by the **Claude Agent SDK** — same idea (an agent harness as a library,
in TypeScript), with two deliberate differences:

- **One platform, one key.** All traffic is locked to the Diva `/v1` gateway (`sk-diva-…`); you do
  not configure model providers. The Claude Agent SDK is provider-agnostic; Diva is platform-native.
- **A server-side engine.** The Diva runtime runs **server-side and is never downloaded** — the thin
  client just drives it over a WebSocket. Your client tools execute in *your* process; the model loop
  and compaction run in the engine. (Self-host the engine if you want it local — see
  [Deployment](./deployment.md).)

## Status

Shipped and live-tested: `Agent.run()` / `stream()` / `generate()`, client-side `tool()` execution,
external MCP, interactive **`canUseTool`** permissions, multi-turn **sessions**, per-turn
**params** / **reasoning-level** / **compaction** control (plus an `onCompaction` observer),
**skills** (prepend + invocable), **sub-agents**, **flows**, **hooks**, and **guards**, against a
remote engine (platform or self-hosted). Engine built-ins (**sandboxed code execution**, **web
search**, file ops) ship too but are available when you **self-host** — on the shared platform host
they are fail-loud (RCE risk); see [Deployment](./deployment.md).

On the roadmap and **fail-loud** if you reach for them today (they throw, never silently no-op):
server-side knowledge bases / RAG, platform-hosted skills, platform channels, and
`builtinTools`/`permissions.mode`/`deny` in remote mode. See each feature page for the exact boundary.

## Next steps

- **[Getting started](./getting-started.md)** — install, authenticate, and run your first agent.
- **[Core concepts](./core-concepts.md)** — where the engine runs, the traffic lock, sessions, and
  "owning the host".
- **[Deployment](./deployment.md)** — platform (hosted) and self-host modes.
- **[Agents](./agents.md)** — the full `Agent` API.
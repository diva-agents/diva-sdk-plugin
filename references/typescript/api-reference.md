# API reference

Every public symbol exported from `@diva-ai/sdk`, grouped by area, with its kind, a one-line
description, and a link to the guide that documents it fully. Import everything from the package
root:

```ts
import { Agent, tool, z, guard, flow, handoff, DivaError /* … */ } from "@diva-ai/sdk";
```

## Entry points

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `Agent` | class | High-level agent. `new Agent(model, options?)` → `run()` / `stream()` / `generate()` / `session()` / `close()`. | [Agents](./agents.md) |
| `DivaClient` | class | Low-level client that connects to the Diva engine over a WebSocket (platform or self-hosted gateway) and exposes the turn RPC. For DI / multiple keys / explicit lifecycle. | [Core concepts](./core-concepts.md) · [Deployment](./deployment.md) |
| `AgentSession` | class | A bound conversation: `agent.session(id)` reuses one `sessionId` across turns. | [Sessions & memory](./sessions-and-memory.md) |

## Agent & client types

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `AgentOptions` | type | Options for `new Agent(...)` — apiKey, instructions, tools, mcp, params, thinkingDefault, compaction, onCompaction, flow, builtinTools, permissions, skills, hooks, guards, client, clientOptions, … | [Agents](./agents.md) |
| `RunOptions` | type | Per-turn options for `run()` / `stream()` / `generate()` (e.g. `sessionId`, `provider`/`model` override, `timeoutMs`). | [Agents](./agents.md) |
| `AgentResult` | type | Return of `run()`: `{ text, runId, usage?, durationMs?, stopReason? }`. | [Agents](./agents.md) |
| `Usage` | type | Token usage for a turn: `{ inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens? }`. Prices are not computed. | [Agents](./agents.md) |
| `AgentStreamChunk` | type | Yielded by `stream()`: a `delta` chunk or the terminal `done` chunk. | [Streaming](./streaming.md) |
| `StructuredResult` | type | Return of `generate()`: the parsed, schema-typed `output`, plus `attempts`/`repaired` (retry metadata) and `usage`/`durationMs`/`stopReason`. | [Structured output](./structured-output.md) |
| `DivaClientOptions` | type | Options for `new DivaClient(...)` — `apiKey`, `remoteHost` (self-host), host-config options, `onCompaction`, `logger`, timeouts. | [Core concepts](./core-concepts.md) · [Deployment](./deployment.md) |
| `AgentTurnRequest` | type | The turn request shape the client sends. | [Agents](./agents.md) |
| `AgentTurnPayload` | type | A payload item within a turn response. | [Agents](./agents.md) |
| `AgentTurnResponse` | type | The raw turn response the engine returns. | [Agents](./agents.md) |
| `AgentStreamDelta` | type | The raw streaming delta shape backing `AgentStreamChunk`. | [Streaming](./streaming.md) |

## Tools

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `tool` | function | Define a client-side tool: `tool({ name, description, inputSchema, execute })`. | [Tools](./tools.md) |
| `ToolDefinition` | type | The object `tool()` accepts / returns. | [Tools](./tools.md) |
| `ToolInput` | type | The validated input passed to a tool's `execute`. | [Tools](./tools.md) |
| `ToolExecuteContext` | type | The context object passed to `execute` (signal, ids, …). | [Tools](./tools.md) |
| `toWireDefinition` | function | Convert a `ToolDefinition` to its wire (MCP) form. | [Tools](./tools.md) |
| `toolset` | function | Group related tools into a `Toolset`. | [Toolsets](./toolsets.md) |
| `composeToolsets` | function | Merge several toolsets, enforcing unique names. | [Toolsets](./toolsets.md) |
| `Toolset` | type | A named collection of tools. | [Toolsets](./toolsets.md) |

## MCP

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `MCP` | namespace/fn | Declare external MCP servers (`MCP.stdio(...)`, `MCP.http(...)`). | [MCP](./mcp.md) |
| `McpServer` | type | Discriminated server config: `stdio` \| `streamable-http` \| `sse`. | [MCP](./mcp.md) |

## Built-in tools & code execution

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `BuiltinToolsConfig` | type | Opt into host built-ins: `{ codeExec, fileOps, webSearch, webFetch, subagents }`. Denied by default. **Self-host only — throws `DivaNotImplementedError` in the hosted client.** `subagents` enables host-side parallel sub-agents (fair-scheduled lanes; no A2A). | [Code execution](./code-execution.md) · [Parallel agents](./parallel-agents.md#host-side-builtintoolssubagents) |

## Permissions

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `Permissions` | type | `{ mode, allow, deny, canUseTool, approvalTimeoutMs }`. `canUseTool` / `allow` work on the hosted client; **`mode` / `deny` are self-host only** (throw `DivaNotImplementedError` hosted). | [Permissions](./permissions.md) |
| `PermissionMode` | type | `"default" \| "acceptEdits" \| "plan" \| "bypassPermissions"`. | [Permissions](./permissions.md) |
| `PERMISSION_MODES` | const | The array of valid `PermissionMode` values. | [Permissions](./permissions.md) |
| `CanUseTool` | type | The interactive gate: `(toolName, input, { signal }) => Promise<PermissionResult>`. | [Permissions](./permissions.md) |
| `PermissionResult` | type | `{ behavior: "allow", updatedInput? } \| { behavior: "deny", message? }`. | [Permissions](./permissions.md) |

## Model configuration

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `ThinkingLevel` | type | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "adaptive"`. | [Model configuration](./model-configuration.md) |
| `THINKING_LEVELS` | const | The array of valid `ThinkingLevel` values. | [Model configuration](./model-configuration.md) |
| `validateThinkingDefault` | function | Throw `DivaError` if a level is invalid (also runs at construction). | [Model configuration](./model-configuration.md) |
| `CompactionConfig` | type | Tune automatic context compaction (recentTurnsPreserve, maxHistoryShare, qualityGuard, model, customInstructions, notifyUser). | [Model configuration](./model-configuration.md) |
| `CompactionEvent` | type | Observe-only event delivered to `onCompaction` (phase before/after + counts). | [Model configuration](./model-configuration.md) |

## Skills

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `skill` | function | Define an inline skill: `skill({ name, description, body })`. | [Skills](./skills.md) |
| `skillFromDir` | function | Load a skill from a `SKILL.md` directory. | [Skills](./skills.md) |
| `composeSkills` | function | Merge skills, enforcing unique names. | [Skills](./skills.md) |
| `Skill` | type | A resolved skill. | [Skills](./skills.md) |
| `SkillRef` | type | A skill or a `"platform:<name>"` reference (platform refs not yet wired). | [Skills](./skills.md) |

## Sub-agents

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `handoff` | function | Define a sub-agent the parent can delegate to. | [Sub-agents](./subagents.md) |
| `HandoffOptions` | type | `{ name, description, inputSchema?, render?, timeoutMs?, … }`. | [Sub-agents](./subagents.md) |
| `parallel` | function | Run independent agent tasks concurrently, bounded, in input order (settled results, never rejects). | [Parallel agents](./parallel-agents.md#client-side-parallel) |
| `DEFAULT_PARALLEL_CONCURRENCY` | const | Default `concurrency` for `parallel()` (= 4). | [Parallel agents](./parallel-agents.md#client-side-parallel) |

## Flow

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `flow` | function | Start a slot-filling `FlowBuilder`. | [Flow](./flow.md) |
| `FlowBuilder` | class | Fluent builder → `.build()` → a `Flow`. | [Flow](./flow.md) |
| `Flow` | type | A compiled flow passed to an Agent. | [Flow](./flow.md) |
| `FlowFrame` | type | The serialized frame declared into the host's `diva-flow` plugin. | [Flow](./flow.md) |
| `GateOptions` | type | Options for a flow gate. | [Flow](./flow.md) |
| `SlotFill` | type | A slot-fill declaration. | [Flow](./flow.md) |
| `SlotOptions` | type | Options for a slot. | [Flow](./flow.md) |

## Hooks

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `Hooks` | type | The lifecycle-hooks object (wired: before_agent_start, before_tool_call, after_tool_call, before_reply, final_reply_guard, agent_end). | [Hooks](./hooks.md) |
| `HookOutcome` | type | What a hook may return (observe / mutate / block). | [Hooks](./hooks.md) |
| `BeforeAgentStartEvent` | type | Event for `before_agent_start`. | [Hooks](./hooks.md) |
| `BeforeToolCallEvent` | type | Event for `before_tool_call`. | [Hooks](./hooks.md) |
| `AfterToolCallEvent` | type | Event for `after_tool_call`. | [Hooks](./hooks.md) |
| `ReplyEvent` | type | Event for `before_reply`. | [Hooks](./hooks.md) |
| `AgentEndEvent` | type | Event for `agent_end`. | [Hooks](./hooks.md) |

## Guards

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `guard` | function/namespace | Client-side business-rule guards (`guard.output`, `guard.approval`, `guard.tool`, …). Not the security gate — see [Permissions](./permissions.md). | [Guards](./guards.md) |
| `Guard` | type | A compiled guard. | [Guards](./guards.md) |

## Sessions & memory

| Symbol | Kind | Description | Guide |
| --- | --- | --- | --- |
| `SessionStore` | type | Interface for a BYO conversation store. | [Sessions & memory](./sessions-and-memory.md) |
| `MemoryStore` | class | In-memory `SessionStore`. | [Sessions & memory](./sessions-and-memory.md) |
| `FileStore` | class | File-backed `SessionStore` (local data residency). | [Sessions & memory](./sessions-and-memory.md) |
| `Turn` | type | One stored `{ role, content }` turn. | [Sessions & memory](./sessions-and-memory.md) |

## Errors

All are subclasses of `DivaError`. See [Error handling](./error-handling.md).

| Symbol | Thrown when |
| --- | --- |
| `DivaError` | Base class for every SDK error. |
| `DivaAuthError` | Missing/invalid Diva API key. |
| `DivaRequestError` | A turn failed at the gateway; carries `detail` (`code`, `provider`, `model`, `cause`). |
| `DivaHostError` | The gateway could not be reached, or the client was used after `close()`; carries `detail.cause`. |
| `DivaHookError` | A hook threw. |
| `DivaGuardTripped` | A guard blocked the run. |
| `DivaNotImplementedError` | You reached for a feature not available on the hosted client (e.g. knowledge/RAG, platform channels/skills, an unwired hook, or self-host-only `builtinTools` / `permissions.mode` / `deny`). |

## Re-exports

| Symbol | Description |
| --- | --- |
| `z` | The [Zod](https://zod.dev) instance the SDK uses — build tool/generate schemas with it so versions match. |

## See also

- [Overview](./index.md) · [Getting started](./getting-started.md) · [Core concepts](./core-concepts.md)
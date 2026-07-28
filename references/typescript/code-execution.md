# Code execution & built-in tools

Let the model write and run code — safely. `@diva-ai/sdk` ships the engine's built-in
tools (shell/exec, file read/write, web search/fetch, …) but **denies all of them by
default**. You re-enable exactly the ones you need through `builtinTools`, and sandboxed
code execution runs inside a hardened, network-off Docker container — the same posture
frontier teams use for local single-tenant code exec.

This page is the security contract for those built-ins. Read it before enabling any of
them: an agent is driven by a remote model, and these tools give that model a shell and a
filesystem.

> **Self-host only — throws `DivaNotImplementedError` in the hosted client.** Engine built-ins
> (`builtinTools`) and `permissions.mode` / `permissions.deny` require the engine to run somewhere
> **you** control — **self-host** ([Deployment](./deployment.md)). On the hosted platform gateway
> they are **fail-loud** (they throw `DivaNotImplementedError`): enabling shell/filesystem/network
> on a multi-tenant host would be RCE. On the hosted client, wrap what you need as your own client
> `tool()` (it runs on your machine — you sandbox it), gated by `canUseTool` / `guard.tool`.
> The rest of this page describes the self-hosted engine's security model.

## The secure-by-default model

When you construct an `Agent` (or `DivaClient`) **without** `builtinTools`, the model gets
**only** the tools you gave it — your client `tool()`s and any external `mcp` servers.
Every engine built-in is denied: `exec`, `process`, `read`, `write`, `edit`,
`apply_patch`, `web_search`, `web_fetch`, `image`, `pdf`, session/agent orchestration, and
the rest.

This is deliberate. When you self-host, the agent loop runs inside a Diva engine on
infrastructure **you** control (see [Core concepts](./core-concepts.md)), and the loop is
steered by a model reached over the Diva `/v1` gateway. If built-ins were on by default,
attaching a single harmless client tool would hand a remotely-driven model host shell, host
filesystem, and arbitrary web egress on your box. So the SDK closes that gap: it **always**
sends a built-in-tools policy to the engine (even an empty `{}`), and the engine writes a
`config.tools.deny` list covering the full gated inventory minus whatever you opted into.

The deny matches **bare engine tool names** only. Your client `tool()`s are served as a
loopback MCP server and carry an MCP prefix (`diva-tools__<name>`), so they are never
matched by the deny and always run. See [Tools](./tools.md).

### The gated inventory

Every name below is denied unless you opt it back in via `builtinTools`. Grouped by the
capability class each one exposes:

| Class | Tools |
| --- | --- |
| File + shell + code (host RCE / data access) | `read`, `write`, `edit`, `apply_patch`, `exec`, `process`, `code_execution` |
| Web (SSRF / exfiltration egress) | `web_search`, `web_fetch`, `x_search` |
| Memory (may hold secrets) | `memory_search`, `memory_get` |
| Session / agent orchestration (amplification / lateral movement) | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `agents_list`, `update_plan` |
| UI / channels / automation / control-plane (owner-only) | `browser`, `canvas`, `message`, `cron`, `gateway`, `nodes` |
| Media (cost abuse; `image`/`pdf` also do URL egress into a vision model) | `image`, `pdf`, `image_generate`, `music_generate`, `video_generate`, `tts` |

Five capability groups can be re-enabled through `builtinTools` — `codeExec`, `fileOps`,
`webSearch`, `webFetch`, and `subagents` (host-side parallel sub-agents). Everything else on the
list has **no opt-in** and stays denied for SDK agents by design (`code_execution`, `sessions_send`
/ agent-to-agent messaging, control-plane, channels, `update_plan`, media generation, …). If you
need one of those capabilities, attach your own `tool()` or `mcp` server for it — that keeps the
capability under your code's control rather than the engine's owner-scoped built-in.

## `builtinTools` — the opt-in surface

`builtinTools` is a `BuiltinToolsConfig`. Each field re-enables one capability group and,
for `codeExec`/`fileOps`, chooses how confined it is:

```ts
type BuiltinToolsConfig = {
  codeExec?: false | "sandbox" | "host";
  fileOps?: false | "workspace" | "full";
  webSearch?: boolean | { readonly provider?: string };
  webFetch?: boolean;
  // Host-side parallel sub-agents (fair-scheduled lanes; A2A `sessions_send` stays denied).
  subagents?: boolean | {
    maxParallel?: number;          // concurrent sub-agent turns (default 16)
    perTenantMaxParallel?: number; // per-tenant cap (default 8)
    maxSpawnDepth?: number;        // nesting depth (default 1 — sub-agents are leaves)
    allowAgents?: readonly string[];
  };
};
```

The `subagents` opt-in un-gates the engine's host-side sub-agent spawn + observe/collect tools so
the model can run a batch of sub-agents in parallel in the background. Full details, the field
mapping, and how it differs from a client-side `handoff()` / `parallel()`:
[Parallel agents → host-side](./parallel-agents.md#host-side-builtintoolssubagents).

Because `builtinTools` **configures the agent's own engine session** (its tool policy), an
agent that sets it **owns its host** and cannot share an explicit `client`. Passing both throws
a `DivaError` at construction:

> Agent `builtinTools` require the agent to own its host: pass `builtinTools` without a
> shared `client` (configure the implicit client via `clientOptions`).

Configure the implicit client through `clientOptions` instead (see the examples below).

## Sandboxed code execution — `codeExec: "sandbox"`

`codeExec: "sandbox"` is the intended way to let the model run code. It un-gates `exec` and
`process` and routes them into the engine's **Docker sandbox** — an isolated, ephemeral,
per-agent container the host provisions specifically for this agent.

Two things happen in the host reconcile, and both are required:

1. **Route** — `config.tools.exec` is set to `{ host: "sandbox", security: "full" }`.
   `security: "full"` means the model may run **any command inside the sandbox**. The
   isolation *is* the boundary here — there is no command allowlist, because the container
   itself is what contains a hostile command. (Without `security: "full"` the sandbox
   default is `deny` and nothing runs.)
2. **Provision** — `agents.defaults.sandbox` is written with the complete secure config
   below. Routing exec to a sandbox that was never provisioned would fail closed
   (`requires a sandbox runtime`); the provision is the other half that makes it actually
   run.

### What the container is locked down to

The provisioned sandbox (`SDK_SANDBOX_PROVISION`) is:

| Setting | Value | Why |
| --- | --- | --- |
| `mode` | `"all"` | Provisions a runtime for every session (the SDK pins a hard `host: "sandbox"` target that would throw under `"non-main"`). |
| `backend` | `"docker"` | Pinned. An inherited `ssh`/`remote` backend would void every docker-only limit below. |
| `workspaceAccess` | `"none"` | The model gets an **isolated, read-only copy** of the workspace — never the developer's real project read-write. |
| network | `"none"` (docker backend default) | No egress at all — the model's code cannot reach the internet, the LAN, or a cloud metadata endpoint. |
| root filesystem | read-only (docker backend default) | The container cannot mutate its own image. |
| capabilities | `capDrop: ALL` (docker backend default) | No Linux capabilities. |
| privilege escalation | `no-new-privileges` (docker backend default) | `setuid` binaries can't gain privilege. |
| user | non-root (docker backend default) | Code runs unprivileged inside the container. |
| lifetime | per-agent, ephemeral (docker backend default) | A fresh container per agent; nothing persists across runs. |
| `docker.memory` / `docker.memorySwap` | `"1g"` / `"1g"` | Caps RAM and forbids swap growth (swap == memory ⇒ no swap headroom). |
| `docker.cpus` | `1` | One CPU. |
| `docker.pidsLimit` | `512` | Blunts fork bombs. |
| `docker.tmpfs` | `/tmp:size=256m,mode=1777`, `/var/tmp:size=64m,mode=1777`, `/run:size=16m,mode=755` | Bounds the memory-backed tmpfs. An unsized `--tmpfs` defaults to ~50% of **host** RAM and is *not* capped by `--memory`, so code could `dd` into `/tmp` and exhaust the host despite the 1g cgroup. Sizing it closes that host-DoS. |
| `docker.ulimits` | `nofile 1024/1024`, `fsize 268435456` (256 MiB max single file), `nproc 512/512` | Caps file descriptors, single-file size, and process count — DoS surfaces that `--pids-limit` alone misses. |

This object **overwrites** `agents.defaults.sandbox` rather than merging into it: a reused
or tampered state dir must not be able to weaken isolation via a surviving sibling key (a
lingering `backend`, `workspaceAccess`, or `workspaceRoot`). The whole object is replaced
with the complete secure config every boot.

### The escape hatches are stripped

Provisioning a hardened sandbox is pointless if the model can ask to step outside it, so the
reconcile also removes every known escape vector:

- `config.tools.elevated` is deleted. An `exec({ elevated: true })` would otherwise flip the
  target to the **gateway host** with approvals bypassed — a full escape from the sandbox
  just provisioned.
- Per-agent entries in `agents.list[]` are scrubbed of `sandbox`, `tools.elevated`, and
  `tools.exec`. A per-agent config layers **on top of** `agents.defaults` and the first
  entry becomes the default agent, so a reused state dir could otherwise redirect the main
  session; a per-agent `exec.host: "gateway"` in particular *wins* over the global
  `host: "sandbox"` pin.

### How this compares to frontier teams

For **local, single-tenant** code execution — one developer, their own machine — this
configuration sits **at or above** the bar set by Claude Code and OpenAI Codex. Those tools
use an OS-level sandbox (macOS Seatbelt / Linux bubblewrap + seccomp) and state plainly that
it "is not a complete isolation boundary." Diva's docker default matches the table-stakes
checklist frontier teams share — network deny-by-default, non-root, read-only root, all caps
dropped, `no-new-privileges`, resource caps, ephemeral, no host filesystem, no docker socket,
workspace confinement — and goes further on three points:

- **Full `--network none`**, versus a proxy-allowlist that domain-fronting can defeat.
- An **isolated read-only workspace copy**, versus mounting the real project writable.
- **Environment secret-scrubbing** (see below), versus reading `~/.aws/credentials` by default.

It is, in fact, Anthropic's own published self-hosted recipe — cap-drop + non-root +
read-only rootfs — where "the security boundary stops at the sandbox."

Be honest about where the boundary ends: a hardened Docker container **shares the host
kernel**, so any container-runtime or kernel privilege-escalation bug is a container→host
path. That residual risk is acceptable single-tenant (you already trust your own machine);
it is **not** an accepted boundary for **multi-tenant, mutually-distrusting** workloads,
which need a per-session kernel-surface-reducing sandbox (gVisor) or a hardware-VM boundary
(microVM). That layer is a **hosting-platform** concern, not something the SDK ships — the
SDK provides the docker/OS-level local sandbox and the config seam; the platform's `remote`
backend is where a per-tenant microVM/gVisor + egress proxy would live.

## Host code execution — `codeExec: "host"`

`codeExec: "host"` un-gates `exec`/`process` and pins them to `{ host: "gateway", security:
"full" }` — running commands **directly on the host, with no sandbox at all**. The gateway
process *is* the developer's machine.

⚠️ **You own the risk entirely.** A remotely-driven model gets a real shell on your box. It
inherits the supervisor's **ambient environment**, so any secrets in `process.env` that the
host-env denylist does not cover — `OPENAI_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, and the like —
are readable by whatever the model chooses to run. It can read and write your files, and (if
the machine has network) egress freely.

`"host"` is pinned to `"gateway"` on purpose: an `"auto"` target would silently route to the
sandbox when Docker happens to be present, defeating the explicit intent. If you ask for
host exec, you get host exec. Reach for it only when you deliberately want the model to act
on the real machine and you accept the consequences. Otherwise, prefer `"sandbox"`.

## The other opt-ins

### `fileOps` — file read/write/edit

- `"workspace"` un-gates `read`/`write`/`edit`/`apply_patch` confined to the agent's
  workspace (`config.tools.fs = { workspaceOnly: true }`).
- `"full"` un-gates the same tools against the **whole host filesystem** (`workspaceOnly:
  false`) — dangerous; the model can read and write anywhere the host process can.
- Omitted / `false` — all four stay denied.

### `webSearch` — web search

`true` (or `{ provider?: string }`) un-gates `web_search`, which by default uses a **keyless
DuckDuckGo** provider. This tool **egresses to the search provider** — a real outbound
request — and is intentionally **not** blocked by the SDK's LLM traffic-lock, which pins
only the Diva `/v1` gateway. This behavior is live-verified end-to-end. (See *Notes &
caveats* on the `provider` sub-field.)

### `webFetch` — URL → markdown

`true` un-gates `web_fetch` (fetch a URL and return markdown). Like `web_search` it is an
outbound-egress tool; enable it only if the model is meant to pull content off the web.

## Example

### Sandboxed compute (the recommended path)

Ask the model to actually *run* code to get an answer, inside the isolated Docker sandbox.
Requires Docker on the host and a live `sk-diva` key (`DIVA_API_KEY`).

```ts
import { Agent } from "@diva-ai/sdk";

async function main(): Promise<void> {
  const agent = new Agent("diva/gpt/gpt-4o-mini", {
    instructions:
      "You have an `exec` tool that runs shell commands in a sandbox. When asked to " +
      "compute something, WRITE and RUN code with exec — never do the arithmetic yourself. " +
      "Report exactly what the command prints.",
    // Un-gates exec/process, routes them into the hardened Docker sandbox, and
    // provisions the runtime (network off, read-only root, caps dropped, non-root,
    // 1 CPU / 1g RAM, isolated read-only workspace copy). Escape hatches stripped.
    builtinTools: { codeExec: "sandbox" },
    // builtinTools bakes host config, so the agent owns its host — configure the
    // implicit client here, never via a shared `client`.
    clientOptions: { requestTimeoutMs: 240_000 },
  });

  try {
    const { text } = await agent.run(
      "Using Python, compute the SHA-256 hex digest of the exact string " +
        "'diva-sandbox' and report it.",
    );
    console.log(text);
  } finally {
    // Always stop the host so the child process (and its sandbox) exit cleanly.
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

The model's code runs with no network, no host filesystem, and no ambient secrets — it can
only compute and print. The digest it returns is unfakeable proof the command really
executed inside the sandbox.

### Secure default (no built-ins)

With no `builtinTools`, only your client tools run — every engine built-in is denied:

```ts
import { Agent, tool, z } from "@diva-ai/sdk";

const getBadge = tool({
  name: "get_badge_number",
  description: "Returns the user's badge number.",
  inputSchema: z.object({}),
  execute: async () => ({ badgeNumber: "907341" }),
});

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "Answer using get_badge_number; never invent a number.",
  tools: [getBadge],
  // Nothing here → exec/read/write/web_search/… all denied. get_badge_number still runs.
});
```

### Web search under the traffic-lock

```ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/gpt/gpt-4o-mini", {
  instructions: "Use web_search to look things up; don't answer from memory.",
  builtinTools: { webSearch: true }, // keyless DuckDuckGo; egresses to the search provider
  clientOptions: { requestTimeoutMs: 180_000 },
});
```

## Options

`builtinTools?: BuiltinToolsConfig` on `AgentOptions` / `DivaClientOptions`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `codeExec` | `false \| "sandbox" \| "host"` | `false` (denied) | `"sandbox"`: un-gate `exec`/`process` into the hardened Docker sandbox (network off, read-only root, caps dropped, non-root, resource-limited, isolated read-only workspace copy, ephemeral). Needs Docker on the host. `"host"`: run `exec`/`process` **directly on the host** with no isolation — you own the risk. |
| `fileOps` | `false \| "workspace" \| "full"` | `false` (denied) | `"workspace"`: un-gate `read`/`write`/`edit`/`apply_patch` confined to the agent's workspace. `"full"`: same tools against the whole host filesystem (dangerous). |
| `webSearch` | `boolean \| { readonly provider?: string }` | `false` (denied) | `true` (or a `{ provider }` object) un-gates `web_search` — keyless DuckDuckGo by default. Egresses to the search provider (not blocked by the traffic-lock). |
| `webFetch` | `boolean` | `false` (denied) | `true` un-gates `web_fetch` (URL → markdown). Outbound egress. |

> Defaults: the type sets no field defaults; an omitted field means the capability stays
> denied. The engine-side "keyless DuckDuckGo" is the `web_search` tool's own provider
> default, not a field default on `webSearch`.

## Notes & caveats

- **Owns-host requirement.** `builtinTools` configures the agent's own engine session, so an
  agent that sets it cannot also pass an explicit `client` — that throws a `DivaError` at
  construction. Use `clientOptions` to configure the implicit client. (This applies to every
  host-config option: `tools`, `mcp`, `params`, `thinkingDefault`, `compaction`, `flow`,
  `permissions`, invocable `skills`.) See [Core concepts](./core-concepts.md).
- **Docker is required for `codeExec: "sandbox"`.** With no Docker on the host the sandbox
  cannot be provisioned and exec fails closed. `codeExec: "host"` needs no Docker — but runs
  on the real machine.
- **Diva/platform secrets are scrubbed from host-exec.** Every `DIVA_*` env var (including
  your `sk-diva` key in `DIVA_API_KEY`) is in the host-exec denylist prefix set, so it is
  removed from the environment any host command sees. The operator gateway token is likewise
  scrubbed from `process.env` once the server holds it. **Non-Diva** secrets in the ambient
  environment (`OPENAI_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, …) are **not** scrubbed and are
  visible to `codeExec: "host"` — another reason to prefer `"sandbox"`, where the whole
  environment is contained anyway.
- **`security: "full"` is not a command allowlist.** In the sandbox, the model may run any
  command; the container is the boundary. Do not read `"full"` as "trusted commands only."
- **The workspace copy is isolated, not your project.** `workspaceAccess: "none"` gives the
  sandbox a read-only copy, so file writes by the model never touch your real files. If that
  copy could contain repo secrets (`.env`, keys), note that env-scrubbing does not cover
  file contents — but the blast radius is small because it is an isolated scratch copy, not
  the live project.
- **`webSearch: { provider }` sub-field.** The public type accepts a `{ provider }` form and
  the string travels to the host, but the SDK's secure-default reconcile currently only
  *toggles* `web_search` on (it un-gates the tool; `web_search` then uses the engine's
  configured/default provider — keyless DuckDuckGo). Don't rely on this field to select a
  provider per-agent through the SDK until it's documented as wired.
- **Permission modes layer on top.** `builtinTools` decides which built-ins are *available*;
  [`permissions`](./permissions.md) decides *how* they may be used (mode presets + deny
  rules + the interactive `canUseTool` gate). E.g. `mode: "plan"` denies
  `write`/`edit`/`apply_patch`/`exec`/`process` even if `builtinTools` opted them in;
  `mode: "bypassPermissions"` runs the opted-in exec with no approval gate.
- **Invocable skills conflict with `fileOps`.** Invocable skills (the default `skillsMode`)
  pin a dedicated skills-only workspace and un-gate a `read` confined to it, so combining
  them with `builtinTools.fileOps` throws at construction. Use `skillsMode: "prepend"` if you
  need both, or drop one. See [Skills](./skills.md).
- **Multi-tenant hosting is out of scope for this sandbox.** The docker sandbox is a
  single-tenant, dev-side boundary. Running untrusted multi-tenant code needs a per-tenant
  gVisor/microVM + egress inspection at the platform layer — a Diva hosting-platform build,
  not the SDK.

## See also

- [Core concepts](./core-concepts.md) — the harness-as-library model and why the host runs
  on your machine.
- [Tools](./tools.md) — your own client `tool()`s, which are always available and never
  gated by the built-in deny.
- [Permissions](./permissions.md) — mode presets, deny rules, and the interactive
  `canUseTool` approval gate that layer on top of `builtinTools`.
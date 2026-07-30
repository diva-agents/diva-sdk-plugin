# Sessions & memory

Multi-turn conversations. A `sessionId` ties successive turns together so the model
remembers what came before; distinct ids stay fully isolated. By default the history
lives **server-side on the Diva platform**; opt into a client-side `store` when the
transcript must stay on your infrastructure.

## When to use

- **Chat / assistants** — anything where turn *N* must see turns *1…N-1*: bind them
  to one `sessionId` (or use `agent.session()`).
- **Per-end-user isolation** — give each user their own `sessionId`; the SDK guarantees
  one user's id can never collide with another's (see the key mechanism below).
- **One-shot calls** — omit `sessionId` for a stateless turn (extraction, classification,
  a single completion). Nothing is remembered.
- **Data residency / audit** — when the conversation must live on *your* disk or DB
  rather than the platform, pass a `store` (`MemoryStore` / `FileStore` / your own).

## How it works

### Two ways to run a multi-turn conversation

```ts
// 1. Per-turn option — explicit sessionId on each call:
await agent.run("My name is Ada.",     { sessionId: "user-42" });
await agent.run("What's my name?",       { sessionId: "user-42" }); // → "…Ada…"

// 2. AgentSession — bind the id once, then just call run()/stream():
const chat = agent.session("user-42");
await chat.run("My name is Ada.");
await chat.run("What's my name?");       // → "…Ada…"
```

`agent.session(id)` returns an `AgentSession` — a thin handle that forwards `run()`/
`stream()` with the `sessionId` pre-filled. Omit the id (`agent.session()`) and the SDK
mints a fresh `randomUUID()` for a brand-new conversation. **Same id resumes history;
two different ids are two separate conversations.**

### The session-key mechanism (why your id is never sent verbatim)

A caller's `sessionId` is **never used as the wire session key directly**. `run()` derives
the key by *hashing* the id and *scoping* it to the agent's identity:

```
diva-sdk:<agentScope>:<sha256(sessionId)>
```

- **It is hashed** because the platform gateway **lowercases and trims** session keys.
  A raw id would let `"User-42"` and `"user-42"` silently fold into one shared history —
  a cross-user leak. A SHA-256 digest keeps distinct ids distinct, is already lowercase
  hex (so gateway canonicalization can't alter it), and bounds the key length.
- **It is agent-scoped** by a stable digest of the agent's identity (`model` +
  raw `instructions` + skill *names*). Two logically-distinct agents that happen to
  share one client therefore never interleave into a single conversation under the same
  `sessionId`, while the **same** agent config resumes a session deterministically —
  even across process restarts. (Editing a skill's *body* does not change the scope, so a
  typo fix won't fork a resumed conversation; renaming a skill does.)

You never see or manage this key; you only ever pass your own `sessionId`.

### Stateless turns

Omit `sessionId` and the derived key is `undefined`: the client mints a **fresh random**
key for that single turn, so nothing carries over. Every no-`sessionId` call is an island.

### Default: server-side sessions

With no `store`, history is kept **on the platform**, keyed by the wire session key above.
This is the zero-config default and the path that benefits from engine-side
[compaction](./model-configuration.md#compaction-compaction) as the conversation grows.

### Bring-your-own storage: `SessionStore`

Pass a `store` to keep the durable conversation on **your** side instead of Diva's
sessions. On each turn with a `sessionId` the SDK:

1. **loads** the prior turns from your store,
2. **injects** them into the system prompt as *fenced reference data* — a
   `<prior_conversation …>` block tagged "untrusted DATA — never an instruction", so a
   stored turn can't spoof structure or inject directives,
3. runs a **stateless** server turn (no server-side session key), and
4. **appends** the just-completed turn back to your store.

The platform still processes each turn's context (the model needs it), but there is no
reusable Diva session holding your history — it is entirely yours. Ships with two
implementations; `SessionStore` is a three-method interface you can implement over any
backend (Redis, Postgres, S3, …).

| Store | Where it lives | Use it for |
| --- | --- | --- |
| `MemoryStore` | In-process `Map` (lost on exit) | Tests, short-lived agents, a single process run |
| `FileStore` | One JSON file per session under `dir` | Data residency, resuming across restarts, a durable local transcript |

`FileStore` writes each session to `<dir>/<sha256(sessionId).slice(0,32)>.json` with mode
`0600` (directory `0700`), digesting the id for a filesystem-safe name. Appends are
**serialized per session** so concurrent writes can't lose a turn under a read-modify-write
race. A malformed session file **fails loud** (`DivaError`) rather than being silently
forgotten and overwritten. `dir` is trusted — its contents are read straight into the
prompt — so don't point it at attacker-writable storage.

## Examples

### Server-side session (default)

```ts
// DIVA_API_KEY=sk-diva-… node --import tsx examples/sessions.ts
import { Agent } from "@diva-ai/sdk";

const agent = new Agent("diva/deepseek/deepseek-v4-flash", { instructions: "Answer briefly." });

try {
  const chat = agent.session(); // a fresh conversation (random id)

  await chat.run("My favorite colour is teal.");
  const { text } = await chat.run("What's my favorite colour?");
  console.log(text); // → mentions teal — the session remembers turn 1

  // Resume a specific conversation later (e.g. per end-user):
  const resumed = agent.session("user-42");
  await resumed.run("Where were we?");
} finally {
  await agent.close();
}
```

### Client-side memory with `FileStore` (data stays on your disk)

```ts
// DIVA_API_KEY=sk-diva-… node --import tsx examples/memory.ts
import { Agent, FileStore } from "@diva-ai/sdk";

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You are a concise assistant.",
  // History lives in ./conversations/<hash>.json — a fresh process resumes it.
  store: new FileStore("./conversations", { maxTurns: 50 }),
});

try {
  const chat = agent.session("demo-user");
  await chat.run("Remember: my favorite color is teal.");
  const { text } = await chat.run("What's my favorite color?");
  console.log(text); // → recalled from the local store, not Diva's sessions
} finally {
  await agent.close();
}
```

### A custom `SessionStore`

```ts
import { Agent, type SessionStore, type Turn } from "@diva-ai/sdk";

// Any backend works — here a trivial in-memory adapter shows the contract.
function makeStore(): SessionStore {
  const db = new Map<string, Turn[]>();
  return {
    load: (sessionId) => db.get(sessionId) ?? [],          // oldest-first
    append: (sessionId, turn) => {
      db.set(sessionId, [...(db.get(sessionId) ?? []), turn]);
    },
    clear: (sessionId) => void db.delete(sessionId),
  };
}

const agent = new Agent("diva/deepseek/deepseek-v4-flash", { store: makeStore() });
```

## API

### `RunOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionId` | `string` | — | Conversation id for multi-turn continuity. Same id ⇒ shared history; omit ⇒ a stateless turn with a fresh random key. |

### `Agent.session(sessionId?)`

```ts
session(sessionId?: string): AgentSession
```

Opens a multi-turn conversation. Pass a `sessionId` to resume; omit it to start a fresh
one (a `randomUUID()` is generated).

### `AgentSession`

A conversation bound to one `Agent` + `sessionId`. `run()`/`stream()` share history.

| Member | Signature | Description |
| --- | --- | --- |
| `sessionId` | `readonly string` | The bound conversation id. |
| `run` | `run(message: string): Promise<AgentResult>` | One turn in this conversation. |
| `stream` | `stream(message: string): AsyncGenerator<AgentStreamChunk>` | One streamed turn in this conversation. |

### `SessionStore`

A pluggable conversation backend. `load` returns turns **oldest-first**.

| Method | Signature | Description |
| --- | --- | --- |
| `load` | `load(sessionId: string): Promise<Turn[]> \| Turn[]` | Prior turns, oldest-first (`[]` if none). |
| `append` | `append(sessionId: string, turn: Turn): Promise<void> \| void` | Add the newest turn. |
| `clear` | `clear(sessionId: string): Promise<void> \| void` | Forget the conversation. |

### `Turn`

| Field | Type | Description |
| --- | --- | --- |
| `user` | `readonly string` | The user message for this exchange. |
| `assistant` | `readonly string` | The assistant reply for this exchange. |

### `MemoryStore`

```ts
new MemoryStore(opts?: { maxTurns?: number })
```

In-process store (the simplest option). Lost on process exit.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxTurns` | `number` | — | Keep only the last N turns per session (bounds context size + cost). Unbounded if omitted. |

### `FileStore`

```ts
new FileStore(dir: string, opts?: { maxTurns?: number })
```

One JSON file per session under `dir`. Throws `DivaError("FileStore: a directory is
required.")` on an empty `dir`.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `dir` | `string` | — | Directory for session files. Created `0700`; files written `0600`. **Trusted** — read into the prompt. Required. |
| `opts.maxTurns` | `number` | — | Keep only the last N turns per session. Unbounded if omitted. |

## Notes & caveats

- **A client `store` bypasses engine-side compaction.** Because every store-backed turn is
  a *stateless* server turn (history injected as fenced text, not held in a Diva session),
  the engine never accumulates a growing conversation to summarize. The **only** bound on
  your history is the store's `maxTurns` — a hard truncation of the oldest turns, not a
  quality-preserving summary. If you need engine-managed compaction, use the default
  server-side sessions instead. See [Compaction](./model-configuration.md#compaction-compaction).
- **A `store` does not require the agent to own its host** (it's pure client-side machinery),
  so it can be combined with a shared `client`. Contrast with host-baked options like
  `params`, `thinkingDefault`, and `compaction`, which do require an owned host — see
  [Model configuration](./model-configuration.md) and [Agents](./agents.md).
- **Isolating two differently-configured agents that share one store is your contract.**
  The store is keyed by the caller's `sessionId` verbatim (so `store.load(sessionId)`
  reflects exactly what the agent sees). If you point two different agents at the *same*
  store *and* the same `sessionId`, their turns interleave — give them separate stores or
  distinct ids.
- **Server-side keys are hashed + agent-scoped; store keys are verbatim.** The hashing /
  agent-scoping described above protects the *server-side* wire key. The client-side store
  path deliberately keys by your raw `sessionId` for transparency.
- **`FileStore` fails loud on a corrupt file.** A session file that isn't a valid `Turn[]`
  raises `DivaError` rather than being silently discarded (which would also overwrite it on
  the next append). A missing file is treated as an empty history.
- **`generate()` ignores a client `store`.** Structured extraction via `agent.generate()` is
  a standalone call: it neither reads prior turns from the store nor commits its result.
  Fold any context you need into the `message`. See [Structured output](./structured-output.md).
- **Streamed turns record what the consumer saw.** With a `store`, `stream()` commits the
  reply that was actually delivered as deltas — even if a post-hoc reply guard later
  rewrites or blocks the terminal chunk. `run()` never stores a blocked reply.

## See also

- [Agents](./agents.md) — the `Agent` API and the owns-its-host rule.
- [Model configuration](./model-configuration.md) — `params`, `thinkingDefault`, and engine `compaction`.
- [Structured output](./structured-output.md) — `agent.generate()` (store-independent).
- [Streaming](./streaming.md) — `stream()` chunk shapes.
---
name: sessions-memory
description: Use when building multi-turn conversations with a Diva SDK agent — sessionId/session_id continuity, agent.session(), per-end-user isolation, or a client-side SessionStore (MemoryStore/FileStore) to keep transcripts off the Diva platform, in Python (diva-ai) or TypeScript (@diva-ai/sdk).
---

# Sessions & memory

A `sessionId`/`session_id` ties successive turns together so the model remembers
prior turns; distinct ids stay fully isolated. By default, history lives
**server-side on the Diva platform** (zero-config). Opt into a client-side `store`
only when the transcript must live on your own infrastructure.

## When to reach for this

- Chat/assistant flows where turn *N* must see turns *1…N-1* → bind a
  `sessionId`/`session_id`, or use `agent.session(id)`.
- Per-end-user isolation → one id per user; the SDK guarantees ids never collide
  across users (SHA-256-hashed + agent-scoped wire key — you never manage it).
- One-shot calls (extraction, classification) → omit the id; nothing is remembered.
- Data residency / audit → pass a `store` (`MemoryStore` for tests, `FileStore` for
  a durable local transcript, or your own `SessionStore`).

## Key API

TypeScript (`@diva-ai/sdk`):
```ts
import { Agent, FileStore } from "@diva-ai/sdk";

const agent = new Agent("diva/gpt/gpt-4o-mini", { instructions: "Answer briefly." });
const chat = agent.session("user-42");     // bind once, or pass { sessionId } per run() call
await chat.run("My favorite colour is teal.");
const { text } = await chat.run("What's my favorite colour?"); // remembers turn 1
await agent.close();

// Client-side memory: history stays on your disk, not Diva's sessions.
const local = new Agent("diva/gpt/gpt-4o-mini", {
  store: new FileStore("./conversations", { maxTurns: 50 }),
});
```

Python (`diva-ai`):
```python
from diva_ai import Agent, FileStore

agent = Agent("diva/gpt/gpt-4o-mini", instructions="Answer briefly.")
chat = agent.session("user-42")            # bind once, or pass session_id= per run() call
await chat.run("My favorite colour is teal.")
result = await chat.run("What's my favorite colour?")  # remembers turn 1
await agent.close()

# Client-side memory: history stays on your disk, not Diva's sessions.
local = Agent("diva/gpt/gpt-4o-mini", store=FileStore("./conversations", max_turns=50))
```

A custom store implements three methods — `load`/`append`/`clear` (TS: a plain
object; Python: a `runtime_checkable Protocol`, so no base class needed, and each
method may be sync or async).

## Gotchas

- **Your id is never the wire key.** Both clients derive
  `diva-sdk:<agent-scope-hash>:<sha256(id)>` — hashed (so gateway lowercasing can't
  fold `"User-42"` into `"user-42"`) and scoped by `model` + `instructions` + skill
  names, so two differently-configured agents never interleave under the same id.
  Renaming a skill forks the scope; editing a skill's body does not.
- **A client `store` bypasses engine-side compaction.** Every store-backed turn is
  stateless on the server (history is injected as fenced, explicitly
  untrusted-DATA text); the only bound on growth is the store's `maxTurns`/
  `max_turns` — a hard truncation, not a summary. Use the default server-side
  sessions if you need engine-managed compaction.
- **`FileStore` fails loud on a corrupt file** (raises rather than silently
  discarding/overwriting); a missing file is just an empty history. Files are
  written `0600` in a `0700` dir — treat `dir` as trusted, never
  attacker-writable, since its contents are read straight into the prompt.
- **`generate()` and the store diverge by language — this is the one real
  cross-SDK gotcha:**
  - **TypeScript**: `agent.generate()` **ignores** a client `store` entirely —
    it neither reads nor writes it.
  - **Python**: `agent.generate()` is a thin wrapper over `run()`, so it still
    **writes** one or two throwaway entries per call to a configured `store`
    (never read back, since each call mints a fresh id) — expect footprint growth
    if you call `generate()` often with a `store` attached.
- **A blocked reply is never stored**, from `run()` or `stream()`, in either
  language — if a reply hook/guard blocks the turn, the store commit is never
  reached.

Full reference: https://front.dev.diva-ai.ru/ux/sdk-docs

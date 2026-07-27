---
description: Run a runnable example from the Diva SDK docs (quickstart, tools, mcp, subagents, streaming, ...)
argument-hint: [example name, e.g. "tools" or "subagents"]
---

Fetch and run a real, documented example from the Diva SDK docs.
`$ARGUMENTS` names the example (e.g. `tools`, `mcp`, `subagents`).

## 1. Determine language

Infer from the current project (`@diva-ai/sdk` in `package.json` vs `diva-ai` in
`pyproject.toml`/`requirements.txt`), or ask if there's no project yet.

## 2. Known example set (verify against live docs — this list can grow)

- **TypeScript** (`@diva-ai/sdk`, run with `node --import tsx examples/<name>.ts`):
  `quickstart`, `tools`, `toolsets`, `mcp`, `subagents`, `streaming`,
  `structured-output`, `error-handling`, `flow`, `guards`, `hooks`, `hitl`,
  `knowledge`, `memory`, `params`, `sessions`, `skills`.
- **Python** (`diva-ai`, run with `python examples/<name>.py`): `quickstart`,
  `tools`, `permissions_hooks_guards`, `sessions_memory`, `streaming`,
  `structured_output`, `subagents_parallel`.

If `$ARGUMENTS` doesn't match one of these, `WebFetch`
**https://front.dev.diva-ai.ru/ux/sdk-docs** and its index/guide pages to find
the closest current example rather than guessing — the docs are the source of
truth and this list may be stale.

## 3. Fetch the real source, don't reconstruct it from memory

`WebFetch` the doc page that matches the topic (e.g. the Tools guide embeds the
exact content of `examples/tools.ts`/`examples/tools.py`) and pull the runnable
code block verbatim — every guide's "Example" section names the file it mirrors
(`Mirrors examples/<name>.ts`). Do not hand-write a look-alike from memory; use
the fetched source so behavior matches the shipped example exactly.

## 4. Save it into the user's project

Write it to `./examples/<name>.ts` or `./examples/<name>.py`, creating the
`examples/` directory if needed.

## 5. Preflight

Check `DIVA_API_KEY` is set (don't print its value). If it isn't, stop and ask
the user to `export DIVA_API_KEY=sk-diva-...` — never fabricate or guess a key.

## 6. Install and run

- TS: ensure `@diva-ai/sdk` and `tsx` (dev dep) are installed, then run exactly
  the command the doc page shows, typically
  `DIVA_API_KEY=sk-diva-… node --import tsx examples/<name>.ts`.
- Python: ensure `diva-ai` (and `diva-ai[mcp]` if the example uses `MCP.*`) is
  installed, then run `DIVA_API_KEY=sk-diva-... python examples/<name>.py`.

## 7. Show the result

Print the output. On failure, map the raised error to the SDK's `DivaError`
hierarchy (`DivaAuthError`, `DivaHostError`, `DivaRequestError`,
`DivaNotImplementedError`, `DivaHookError`, `DivaGuardTripped`) instead of
guessing at the cause — each has a distinct, documented trigger (see the
`error-handling` skill / docs page).

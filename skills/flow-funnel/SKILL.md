---
name: flow-funnel
description: Use when authoring a full Diva platform funnel / frame-flow — slot-filling that hard-gates a terminal action, with elicit, branched completions, reactions, escalation, decay, and state predicates — via raw funnel-JSON or the SDK flow() builder, and to know which features run client-side vs engine-only. Broader than the hooks-flow skill (which covers the SDK flow() builder's static core).
---

# Funnels & frame-flow (the full grammar)

A **funnel** (a frame, or an array of frames for multi-intent bots) is slot-filling that
**hard-gates** a terminal tool until required facts are collected. The SDK `flow()` builder
(see **hooks-flow**) reaches only the *static core* of one frame. This skill covers the **full
platform grammar** and — critically — **where each feature is actually enforced**.

## THE crux: where a funnel runs decides what's enforced

There are **three** enforcement tiers, and they are NOT equivalent:

| Tier | Where it runs | Enforces |
| --- | --- | --- |
| **Engine (authoritative)** | funnel saved on the platform, run server-side by the platform engine | the **full** grammar below |
| **TS client interpreter** | `@diva-ai/sdk` `flow()` in Model-B (gates the client's own tools) | a **subset** (static core) |
| **Python client interpreter** | `diva-ai` `flow()` | a **smaller subset** |

**Read this before building anything:** the advanced grammar — `elicit`, `required_when`,
branched `completions[]`, `reactions`, `escalation`, `decay`, `redactions`, and all state
**predicates** — is **engine-only**. Neither SDK `flow()` builder can express it, and neither
client interpreter reads it. If you hand-author a frame with those fields and run it **client-side
(Model-B)**, those guarantees are **silently stripped** — the funnel still runs, but the branch/
escalation/elicitation simply never happens. They take effect **only** when the funnel is authored
on the platform and runs through the engine.

So: **static slot-filling + hard gates → fine client-side via `flow()`. Anything conditional,
branched, elicited, or escalating → author as platform funnel-JSON and run server-side.**

### "Compiles but does nothing" traps (client-side)
- **`injections`** — emitted by both SDK builders, read by **neither** client interpreter. Engine-only.
- **`narration_guard`** (blocks "I placed your order" when the tool never fired) — **dead client-side**: the TS function isn't wired, Python has no reply hook. Engine-only.
- **`finalized`** — **Python ignores it entirely** (TS tracks it only for guidance).
- Python is weaker than TS even on the shared subset: `result_path` doesn't unwrap JSON-string /
  MCP-envelope results, and filled slots are **monotonic** (never un-fill).

## Two authoring paths

1. **SDK `flow()` builder** (TS `flow.ts` / Python `flow.py`) — type-safe, but only the static core
   of **one** frame: `.slot` (`resultPath`/`toolCalled`/`toolsAll` fills), `.gate`, `.completion`,
   `.rule`, `.injection`, `.narrationGuard`, `.finalized`. Runs client-side. See **hooks-flow**.
2. **Raw funnel-JSON** — the full grammar. Authored on the platform (funnel editor → **JSON** button,
   available for multi-frame funnels) or POSTed. Runs server-side (engine). This is the **only** way
   to use `elicit`, `completions`, `reactions`, `escalation`, `required_when`, `decay`, predicates,
   `service_tools`, `redactions`, and multi-frame `key`/`intent`/`handoff`.

## Grammar (frame — current)

Root is one frame **object** or a **`frames[]`** array (multi-intent). The schema is **fully closed
(`extra: forbid`)** — any unknown key → **422**.

- **`slots[]`** (≥1, required): `name`, `fill_from` (required, exactly one of `result_path` |
  `tool_called[]` | `tools_all[]` | `elicit`), `required` (default `true`), `activating`
  (default `true`), `label?`, `ask?`, `tools?`, `required_when?` (predicate → conditional required).
  - **`elicit`**: `type` (`enum|number|boolean|text|date`), `description`, `enum_values?` (enum),
    `allow_unknown?` (default true), `confirm?` (default false), `validate_reject_when?` (predicate),
    **`default?`** (presumed value, type-checked).
- **`completion`** `{action, requires?}` **XOR** **`completions[]`** (branched): each arm
  `{when? (predicate), action | handoff{to_funnel, carry?, max_hops? 1–8}, requires?}`; the arm with
  no `when` is the default and must be **last**.
- **`gates[]`**: `{tool, block_reason, require_prior?[], when_arg? {field, operator in|not_in|eq|ne, values}, max_blocks? 1–10 default 2}` — needs ≥1 of require_prior/when_arg.
- **`injections[]`** `{tool, append, from_result?[]}` · **`reactions[]`** `{on_tool, then escalate|redact|inject, when? (result-condition), paths?(redact), text?(inject), action?/message?(escalate)}` · **`redactions[]`** `{tool, paths[]}` (standalone masking).
- **`escalation`** `{action, when? (predicate), after_fails? (default 2), after_stall_turns?, on_not_found? (default false), message?}` — a separate axis (not a completion outcome).
- **`rules[]`**, **`narration_guard`** `{claim_patterns[]}`, **`finalized`** `{tool?, result_path?}`,
  **`decay`** `{turns?, minutes?}`, **`state_tail`** (default true), **`dormant_redirect`?`**,
  **`service_tools[]`** (hot tools outside the slot course), and (multi-frame) **`key`** (unique),
  **`intent?`**.
- **Predicate** (`required_when`, `escalation.when`, `completions[].when`, `elicit.validate_reject_when`):
  leaf `{slot, op, value|values}` **or** `{all:[…]}` / `{any:[…]}` — exactly one form. `op` ∈
  `eq, ne, gt, gte, lt, lte, in, not_in, exists, absent, truthy, falsy`.

## Save-time validation (server enforces ~15 invariants)

The server validates only on **save** (`PUT /flows/{id}/frame` or `/frames`, which **replaces the
whole funnel**; a bad save leaves the funnel untouched and returns the reason). There is **no**
separate "validate" endpoint — the funnel editor's **Проверить** button is a client-side
pre-check. Key invariants (beyond the closed schema): ≥1 slot, unique slot `name`s; exactly one of
`completion`/`completions`; `requires`/predicate slot-refs must exist; `fill_from` exactly one
source; **slot-closure** (every `required` slot must be fillable — has `tools`/`tool_called`/
`tools_all`/`result_path`/`elicit`); **elicit branch-key trust rule** (a slot that selects a
`completions` arm and is `elicit`-filled must be `enum`/`boolean` or `confirm=true`); every
referenced tool must be in the agent's arsenal; unique frame `key`s; **no two frames share a
terminal action**; `escalation.action` ≠ any `completions[]` arm action.

Use the **`/diva:verify-flow`** command (or the `diva-flow-verifier` agent) to check a funnel-JSON
against these before you save.

## Footguns

- **Wrong tier = silent no-op.** The #1 mistake: authoring `escalation`/`completions`/`elicit` and
  running it through the SDK `flow()` client-side. It compiles and runs but the feature never fires.
  Run the full grammar **server-side**.
- **Closed schema.** A typo'd or extra key anywhere → 422 on save. There is no lenient mode.
- **`tools` on a slot is guidance, not an ACL** — use **guards-permissions** to actually restrict.
- **Save replaces the whole funnel** — JSON save is all-or-nothing over the frame array.

## See also
- **hooks-flow** — the SDK `flow()` builder (static core, client-side) + hooks.
- **guards-permissions** — real tool ACLs (vs a slot's `tools` hint).
- **tools-and-toolsets** — the client tools a funnel gates and fills from.
- Full docs: https://front.dev.diva-ai.ru/ux/sdk-docs

---
description: Validate a Diva funnel / frame-flow JSON against the current grammar + save-time invariants before you save it
argument-hint: [path to funnel .json]
---

Validate a Diva **funnel / frame-flow JSON** against the current platform grammar and the
server's save-time invariants, so the author fixes problems locally instead of eating a 422 on
save. Read the **flow-funnel** skill first — it is the grammar source of truth; this command
applies it as a checklist. Do NOT save or POST anything — this is read-only validation.

Input: the funnel JSON at `$ARGUMENTS` (a file path), or the JSON the user pasted. If neither is
present, ask for the file/JSON.

## Steps

1. **Parse.** `JSON.parse` it. On a parse error, report the exact location and stop. The root must
   be a **non-empty array of frame objects** (a single frame is a one-element array).

2. **Run the invariant checklist** per frame (report every violation with the frame `key`/index
   and the offending path — do not stop at the first):

   **Structure**
   - `slots` present and non-empty; no duplicate slot `name`.
   - each slot's `fill_from` sets **exactly one** of `result_path` | `tool_called` | `tools_all` | `elicit`.
   - **slot-closure:** every slot with `required: true` (default true) must be fillable — it has
     one of `tools`, `fill_from.tool_called`, `tools_all`, `result_path`, or `elicit`.
   - exactly one of `completion` | `completions` (never both, never neither).
   - `completion.requires` (and each `completions[].requires`) reference only existing slot names.

   **Completions / handoff**
   - each `completions[]` arm has exactly one of `action` | `handoff`.
   - `handoff` has `to_funnel`; `carry` references existing slots; `max_hops` in 1–8.
   - at most one default arm (no `when`) and it must be **last**.

   **elicit**
   - `type` ∈ `enum|number|boolean|text|date`; non-empty `description`; `enum` ⇒ non-empty `enum_values`.
   - `default` (if present) matches `type` and, for enum, is a member.
   - **trust rule:** a slot that selects a `completions` arm (appears in an arm's `when` predicate)
     and is `elicit`-filled must have `type` ∈ `enum|boolean` **or** `confirm: true`.

   **gates / reactions / predicates**
   - each gate has `tool`, `block_reason`, and ≥1 of `require_prior` | `when_arg` (`when_arg` needs
     `field` + non-empty `values`; operator ∈ `in|not_in|eq|ne`); `max_blocks` in 1–10.
   - each injection has `tool` + `append`. Each reaction: `redact` needs `paths`; `inject` needs
     `text`; `escalate` needs its own `action` or a frame `escalation.action`.
   - result-conditions: `eq`/`ne` need `values`; all other operators forbid `values`.
   - every predicate node is exactly one form (leaf `{slot,op,value|values}` / `all` / `any`); leaf
     needs `slot`+`op`; numeric ops (`gt/gte/lt/lte`) need a numeric `value`; `in/not_in` need
     `values`; every predicate `slot` must exist in that frame's slots.
   - `escalation.action` must NOT equal any `completions[]` arm action.

   **Closed schema + cross-frame**
   - flag any **unknown key** at any level — the server schema is closed (`extra: forbid`) and 422s
     on unknowns. Known top-level frame keys: `key, intent, slots, completion, completions, rules,
     injections, gates, reactions, redactions, escalation, finalized, narration_guard, decay,
     state_tail, dormant_redirect, service_tools`.
   - when >1 frame: every frame needs a unique non-empty `key`; **no two frames share a terminal
     action** (across `completion.action` and every `completions[].action`).
   - note (can't fully check offline): every referenced tool must exist in the agent's arsenal —
     the server rejects unknown tools unless the agent uses an external/open MCP arsenal.

3. **Where-it-runs warnings** (not errors — but call them out): if the frame uses **engine-only**
   features — `elicit`, `required_when`, `completions`, `reactions`, `escalation`, `decay`,
   `redactions`, or any predicate — warn that these **silently no-op if the funnel is run
   client-side via the SDK `flow()`**; they only take effect when authored on the platform and run
   server-side. Also warn that `injections` and (in Python) `narration_guard`/`finalized` are not
   honored client-side. See **flow-funnel** for the tier table.

4. **Report**: a clear PASS, or a grouped list of violations (structure / completions / elicit /
   gates-reactions / schema / cross-frame) each with frame + path + the fix, followed by any
   where-it-runs warnings.

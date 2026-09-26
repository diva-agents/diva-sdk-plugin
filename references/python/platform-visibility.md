# What the platform sees

You do not write any telemetry. Set `DIVA_API_KEY`, take a turn, and your agent
appears in the dashboard with its model, instructions, skills, guards, funnel,
tools and full run history.

That is convenient, and it is also a reason to know precisely what travels. This
page is the complete list. Nothing here is opt-in and nothing here is hidden:
every field below is on the `agent` RPC your SDK already sends, and you can read
it yourself by pointing `DIVA_GATEWAY_URL` at a local proxy.

## Reported, and visible on the agent card

| What | Where it comes from | Shown as |
|---|---|---|
| Model reference | `Agent(model=…)` | Agent name and `model_ref` |
| **Agent label** | `Agent(model, label=…)` | The agent's name on the card and in the list, instead of the derived one |
| **Instructions** | `Agent(instructions=…)` | The "System prompt" tab, read-only |
| Skill names and one-line descriptions | `skill(name=…, description=…)` | "What the agent is made of" |
| Guard kinds and labels | `guard.output(name=…)` etc. | Same panel |
| Funnel shape | `flow(...)` — slots, gates, completion | The platform's own funnel graph, read-only |
| **Which funnel slots are filled**, each turn | your funnel interpreter, running in your process | The run's trace: which step the conversation was on |
| Tool names, descriptions, JSON schemas | `tool(...)` / `toolsets` | "The agent's tools", with an
  "executes on the developer's side" badge for every local tool |
| **Tool display metadata** | `tool(..., display={"label": …, "icon": …, "category": …})` | The tool's row in "The agent's tools" — label and icon instead of the raw name |
| **Which tools need an operator's approval** | `tool({ requiresApproval })` / `tool(requires_approval=True)` | The tool's row in "The agent's tools", and an approval card in the dashboard queue each time one is called |
| **The operator's decision on a gated call** | the operator, in the dashboard | The run's trace: who approved or refused it, when, and until when the card was valid |
| Every tool call: arguments, result, status, duration | the turn itself | The run's trace |
| Tokens, cost, duration of each turn | the engine's reply | The run card |

Tool arguments and results are **encrypted at rest** on the platform
(AES-256-GCM); a direct `SELECT` against the database returns ciphertext.

## Never reported

Four things stay in your process, by design and not by configuration:

* **Skill bodies.** A skill's `body=` is composed into the system prompt your
  model receives, and the platform stores none of it. This is why the reported
  instructions are your `instructions=` argument verbatim rather than the
  composed prompt — the composed one carries every attached body, and sending it
  would put all of them in a database you do not own.
* **Guard blocklists.** A `blocklist=` is usually the exact set of strings the
  guard exists to keep off the wire. Reporting it would defeat the guard. Only
  the guard's kind and label travel.
* **Your tool implementations.** A local `tool()` is a function in your process.
  The platform relays the call, records the arguments and the result, and never
  executes anything — which is what the "executes on the developer's side" badge
  on the card means.
* **Funnel execution.** `flow()` compiles to client-side hooks and runs where
  your code runs. What the platform receives is a description of its shape so
  the dashboard can draw it, plus, each turn, which slots are filled — as
  flags. The VALUE a slot was filled with is your customer's and never leaves
  your process: the dashboard draws a tick, not an address.

## Older SDKs, older platforms

Every field above is additive, in both directions.

An agent built with a version that predates one of them simply reports nothing
for it, and the dashboard says so rather than showing an empty box — "No
instructions were sent" is a different statement from "the developer wrote
none", and the card makes the difference visible.

The reverse also holds: a field this SDK sends and an older platform does not
know is ignored by it, because every one of them is an extra key next to the
keys that were always there — never a replacement for one. A tool's `display`
sits beside `name`/`description`, not instead of them; the agent's `label` sits
beside the model ref, not instead of it. And when you declare none of them, the
frame is byte-for-byte the one the SDK sent before they existed. Both directions
are pinned by tests in this repository (`tests/test_compat.py`), and the vendored
gateway protocol itself is pinned by `python scripts/check_protocol_drift.py`
(also run by `pytest`, via `tests/test_protocol_drift.py`).

## Agent identity, and why editing a skill makes a new agent

An SDK agent is identified by a digest of **model + composed system prompt**.
Not by its `label`: renaming an agent is a display change, so it keeps its runs.
Because skills are composed into that prompt, editing a skill body produces a
new digest and therefore a new agent row, with its own run history.

That is deliberate: two agents whose knowledge differs are genuinely different
agents, and merging their runs would make both traces lie. It is also why the
digest is computed from the composed prompt while the card shows your raw
`instructions=` — the two answer different questions.

A side effect worth knowing: iterating on a prompt fills your agent list with
one row per revision. The platform archives quiet, single-run agents on its own;
nothing is deleted, and a new turn from the same configuration revives the row.

## See also

- [Skills](./skills.md) — what a skill is and how it reaches the model
- [Guards](./guards.md) — where a guard acts and what it blocks on
- [Flow](./flow.md) — building a funnel
- [Deployment](./deployment.md) — keys, gateway URL, self-hosted stands
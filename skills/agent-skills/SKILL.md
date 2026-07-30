---
name: agent-skills
description: Use when packaging reusable instructions / domain knowledge (brand voice, a refund policy, a glossary) and attaching it to a Diva SDK agent as a skill — skill() / skillFromDir(), composing several, and choosing invocable vs prepend delivery in Python (diva-ai) or TypeScript (@diva-ai/sdk).
---

# Agent skills

A **skill** is a named, reusable instruction/knowledge block — `{ name, description, body }` —
that an agent gains without you hand-editing `instructions` every turn: a persona's tone, an
objection-handling playbook, a domain glossary. You author the body, so it is **trusted at the
same level as `instructions`** (the SDK does not sandbox it). Attach skills to an
[Agent](../subagents-handoff/SKILL.md) via the `skills` option.

## When to reach for this

- Stable, reusable knowledge you want to attach declaratively and **share across agents**
  (brand voice, refund policy, a support runbook) → define once, pass to each agent.
- The knowledge is durable, not turn-specific → skill. Volatile per-turn context belongs in
  the `message` you pass to `run()` / `stream()`, not a skill.
- You have several skills or large bodies and want low per-turn token cost → **invocable mode
  (TS only)**, which loads bodies on demand.

## Key API

Both SDKs expose `skill()` (define programmatically) and `skillFromDir()` /
`skill_from_dir()` (load `<dir>/SKILL.md`). Attach via `skills` on the Agent.

TypeScript (`@diva-ai/sdk`):
```ts
import { Agent, skill, skillFromDir } from "@diva-ai/sdk";

const brandVoice = skill({
  name: "brand-voice",                 // /^[a-zA-Z][a-zA-Z0-9_-]*$/ , trimmed
  description: "How this brand speaks", // single line only (a \n throws)
  body: "Be warm and concise. Never use exclamation marks. Sign off with '— Team Diva'.",
});
const refundPolicy = skillFromDir("./skills/refund-policy"); // reads ./skills/refund-policy/SKILL.md

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You are a customer support assistant.",
  skills: [brandVoice, refundPolicy], // skillsMode defaults to "invocable"
});
const { text } = await agent.run("Is order 4512 shipped?");
await agent.close();
```

Python (`diva-ai`):
```python
from diva_ai import Agent, skill, skill_from_dir

brand_voice = skill(                       # keyword-only args (note the difference vs TS)
    name="brand-voice",
    description="How this brand speaks",
    body="Be warm and concise. Never use exclamation marks. Sign off with '— Team Diva'.",
)
refund_policy = skill_from_dir("./skills/refund-policy")

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="You are a customer support assistant.",
    skills=[brand_voice, refund_policy],   # no skills_mode — always prepend (see below)
)
result = await agent.run("Is order 4512 shipped?")
await agent.close()
```

`skillFromDir` reads `<dir>/SKILL.md`, splitting `name` / `description` from optional
`--- key: value ---` frontmatter and using the rest as the body. Missing/empty `name` falls
back to the directory basename; missing `description` becomes `""`; a YAML block scalar
(`|`/`>`) as a frontmatter value throws — keep it one line or move the text to the body.

## Invocable vs prepend mode — the key distinction (**TS only**)

> **TS↔Python divergence — read this first.** `skillsMode` and the invocable path exist
> **only in TypeScript**. `diva-ai` is a thin client with no locally-hosted engine to write
> `SKILL.md` files into or expose a read tool from, so there is **no `skills_mode` option** —
> Python **always** composes bodies into the prompt (equivalent to TS `prepend`). Everything
> in this section about invocable mode is TypeScript-only.

TypeScript `skillsMode?: "invocable" | "prepend"`, default `"invocable"`:

- **`"invocable"` (default)** — the SDK materializes each skill as a `SKILL.md` in a
  dedicated skills-only workspace and puts **only each skill's name + description** in the
  system prompt. The model loads a body **on demand** (via the agent's workspace-confined
  `read` tool) when it decides the skill is relevant. Per-turn token cost scales with the
  *headers*, not the sum of bodies — the progressive-disclosure win. Because it bakes a host
  workspace + read tool into the agent, an invocable-skills agent **owns its host** (like
  `tools`/`flow`): it cannot take a shared `client` — configure the implicit client via
  `clientOptions`.
- **`"prepend"`** — inlines **every** body into the system prompt each turn, appended after
  `instructions` under `You have the following skills. Use them when relevant:`. No host FS,
  no read tool, so it **works with a shared `client`**. Trade-off: per-turn cost scales with
  the **sum of all bodies**, and there is no on-demand loading. This is exactly what
  `composeSkills` produces.

```ts
// Prepend: zero-FS, runs against a shared/pooled client.
const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You answer product questions.",
  skills: [glossary],
  skillsMode: "prepend",
  client, // allowed only in prepend mode
});
```

Python — prepend is the only path; to control per-turn cost, attach fewer/smaller skills:
```python
from diva_ai import compose_skills, skill
# compose_skills() is exactly what Agent calls internally — call it to preview/unit-test
# the system prompt that reaches the model:
print(compose_skills("You answer product questions.", [glossary]))
```
TS exposes the same composer as `composeSkills(instructions, skills)`.

## The platform-skill boundary

A skill ref can be a local `Skill` **or** a `"platform:<name>"` string naming a server-side
skill from the platform skill base. **Platform skills are not yet wired** — a string ref
throws `DivaNotImplementedError` in both languages (TS `composeSkills` /
`resolveInvocableSkills`; Python `compose_skills`). There is no platform-shadows-client
behavior to worry about *because platform skills do not resolve at all yet*. Python's
`Agent(skills=...)` is even typed `list[Skill]`, so a string ref is only reachable by calling
`compose_skills()` yourself. Use local `skill()` / `skillFromDir()` until the base lands.

## Footguns

- **`skills_mode` does not exist in Python.** Reaching for invocable/on-demand loading in
  `diva-ai` is a category error — pick which skills to attach per conversation instead.
- **Invocable owns the host (TS).** With the default `skillsMode: "invocable"` and a non-empty
  `skills` array, construction throws `DivaError` if you also pass a shared `client`, if
  `builtinTools.fileOps` is set (it needs your files; invocable uses a separate workspace), or
  if `permissions.deny` includes `"read"` (invocable loads bodies via `read`). Fix: drop the
  conflict, or switch to `skillsMode: "prepend"`.
- **Platform refs fail loud** — `"platform:<name>"` → `DivaNotImplementedError`. Not a bug;
  the feature isn't shipped.
- **Duplicate names fail loud, at construction** — each skill needs a unique `name`, checked
  in both modes / both languages.
- **Size limits throw, never truncate** — `body` ≤ 64 KiB (65,536 bytes UTF-8); the composed
  system prompt ≤ 256 KiB. `description` must be a single line; `name` must match the
  identifier regex. All validated in `skill()`.
- **`skillFromDir` reads a trusted path only.** The file (following symlinks) goes straight
  into the system prompt — an attacker-controlled directory is an exfiltration channel.
- **Session identity uses skill *names*, not bodies.** The resumable session scope folds in
  the sorted set of skill names — fixing a typo in a body won't fork a resumed conversation,
  but renaming / adding / removing a skill will.

## See also

- [diva-sdk](../diva-sdk/SKILL.md) — umbrella skill; read it first.
- [tools-and-toolsets](../tools-and-toolsets/SKILL.md) — client tools an agent can call (also owns the host).
- [guards-permissions](../guards-permissions/SKILL.md) — the `read`/`deny` interaction with invocable skills.
- [sessions-memory](../sessions-memory/SKILL.md) — how skill names scope a session.

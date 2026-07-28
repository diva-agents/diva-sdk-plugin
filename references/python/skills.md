# Skills

Skills are named, reusable instruction/knowledge blocks — a persona's tone, an
objection-handling playbook, a domain glossary — that an agent gains without you
hand-editing `instructions` for every turn.

## When to use

- **Use** for stable, reusable capabilities you want to attach declaratively and share across
  agents (brand voice, refund policy, a support runbook).
- **Use** when the same block of knowledge needs to live in more than one `Agent` — define it
  once with `skill()` and pass it to every agent that needs it.
- **Keep bodies modest.** Every attached skill's full body is composed into the system prompt
  on **every** turn — there is no on-demand loading in `diva-ai` (see
  [How it works](#how-it-works)) — so per-turn token cost scales with the sum of all skill
  bodies, not just their headers.
- **Avoid** stuffing volatile, turn-specific context here — put that in the `message` you pass
  to `run()` / `stream()`. Skills are for durable knowledge.

## How it works

A skill is an immutable `Skill` — `name`, `description`, `body` — that you author and
therefore trust (the same trust level as `instructions`). You attach skills to an
[`Agent`](./quickstart.md) via the `skills` option:

```python
agent = Agent(model, instructions="...", skills=[my_skill, another_skill])
```

Internally, the agent composes every attached skill's full body into the system prompt on
every turn (`compose_skills(instructions, skills)`, appended after `instructions` under a
`You have the following skills. Use them when relevant:` block) — this is the same path
`instructions` itself takes, sent as `extraSystemPrompt` on the wire. No host filesystem is
touched by the agent at request time (only `skill_from_dir()` reads a file, and only once,
when you call it), and no extra tool is added.

`diva-ai` is a thin client — there is no locally-hosted engine process for it to write
`SKILL.md` files into or expose a `read_skill` tool from, so there is only **one** way skills
reach the model: composed directly into the prompt. If you need to control per-turn token
cost, keep the number and size of attached skills small, or choose *which* skills to attach
yourself before constructing the `Agent` (e.g. pick relevant skills per conversation instead
of attaching your whole library to every agent).

### The platform-skill boundary

`compose_skills()` also accepts a raw `"platform:<name>"` string in place of a `Skill`, naming
a server-side skill from the platform's skill base — but **platform skills are not yet
wired**: a string ref raises `DivaNotImplementedError`. `Agent(skills=...)` is typed as
`list[Skill]`, so stick to local skills built with `skill()` / `skill_from_dir()` until the
platform skill base lands.

## Example

### Attach a local skill

Mirrors the Skills section of the project README: a `brand-voice` skill attached to a support
agent.

```python
import asyncio

from diva_ai import Agent, skill


async def main() -> None:
    brand_voice = skill(
        name="brand-voice",
        description="How this brand speaks",
        body="Be warm and concise. Never use exclamation marks. Sign off with '— Team Diva'.",
    )

    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="You are a customer support assistant.",
        skills=[brand_voice],
    )

    try:
        result = await agent.run("A customer asks: is my order 4512 shipped?")
        print(result.text)  # follows the brand-voice skill (warm, concise, signed off)
    finally:
        await agent.close()


asyncio.run(main())
```

### Load a skill from a directory

`skill_from_dir()` reads `<dir>/SKILL.md`, splitting `name` / `description` from optional
frontmatter and using the rest as the body.

```python
from diva_ai import Agent, skill_from_dir

# ./skills/refund-policy/SKILL.md:
#   ---
#   name: refund-policy
#   description: When and how to authorize a refund
#   ---
#   Refunds are allowed within 30 days with proof of purchase. ...
refund_policy = skill_from_dir("./skills/refund-policy")

agent = Agent(
    "diva/deepseek/deepseek-v4-flash",
    instructions="You handle billing questions.",
    skills=[refund_policy],
)
```

### Preview the composed system prompt

`compose_skills()` is the exact function `Agent` calls internally — call it yourself to see
(or unit-test) what actually reaches the model:

```python
from diva_ai import compose_skills, skill

glossary = skill(
    name="glossary",
    description="Internal product terms",
    body="'Seat' = one licensed user. 'Workspace' = a billing account.",
)

prompt = compose_skills("You answer product questions.", [glossary])
print(prompt)
# You answer product questions.
#
# You have the following skills. Use them when relevant:
#
# ## Skill: glossary — Internal product terms
# 'Seat' = one licensed user. 'Workspace' = a billing account.
```

## API

### `skill(*, name, description, body)`

```python
def skill(*, name: str, description: str, body: str) -> Skill: ...
```

Define a skill programmatically. Validates and returns a `Skill`. Raises `DivaError` when:

| Rule | Constraint |
| --- | --- |
| `name` | Must match `^[a-zA-Z][a-zA-Z0-9_-]*$` — a letter-led identifier (letters, digits, `_`, `-`), e.g. `"objection-handling"`. Trimmed (`.strip()`) before validation. |
| `description` | Must be a **single line** — a `\n` or `\r` raises (a newline would forge a second header line in the composed prompt). Trimmed before the check. |
| `body` | Must be non-empty after `.strip()`. |
| `body` size | Must be ≤ 64 KiB (65,536 bytes, UTF-8-encoded). Larger raises — it will not be truncated. |

### `skill_from_dir(dir)`

```python
def skill_from_dir(dir: str) -> Skill: ...
```

Load a skill from a directory containing `SKILL.md`. `dir` **must be trusted** — the file is
read into the system prompt, so an attacker-controlled path is an exfiltration channel.

- **Frontmatter** is a leading `---` … `---` block. It is treated as frontmatter **only if it
  contains at least one `key: value` line**; a document that merely opens with a `---`
  horizontal rule is kept entirely as the body. Recognized keys are `name` and `description`;
  surrounding `'`/`"` quotes are stripped.
- **Missing or empty `name`** falls back to the directory's resolved basename.
- **Missing `description`** becomes `""`.
- **YAML block scalars** (`|` or `>`) as a frontmatter value raise `DivaError` rather than
  being mis-parsed — use a single-line value or move long text to the body.
- The parsed result is passed through `skill()`, so all `skill()` validation (name regex,
  single-line description, body size) applies.
- If `<dir>/SKILL.md` cannot be read, raises `DivaError` with the underlying `OSError`
  attached as its cause.

### `compose_skills(instructions, skills)`

```python
def compose_skills(
    instructions: str | None,
    skills: list[Skill] | None,
) -> str | None: ...
```

The composer `Agent` uses internally to build the per-turn system prompt; you rarely call it
directly (the [preview example](#preview-the-composed-system-prompt) above is the main reason
to).

- Returns `instructions` **unchanged** when `skills` is `None` or empty.
- Each skill renders as `## Skill: <name> — <description>` (or `## Skill: <name>` when the
  description is empty) followed by its body, under a leading `You have the following skills.
  Use them when relevant:` line, skills joined by a blank line.
- A `"platform:<name>"` string ref raises `DivaNotImplementedError`.
- A duplicate skill `name` raises `DivaError`.
- If the composed prompt exceeds 256 KiB (262,144 bytes, UTF-8), raises `DivaError` — reduce
  skill bodies.

### `Skill`

```python
@dataclass(frozen=True, slots=True)
class Skill:
    name: str
    description: str
    body: str
```

A named instruction/knowledge block the agent gains. Immutable (`frozen=True`) with
`slots=True`.

## Agent options

Set on the `Agent` constructor:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `skills` | `list[Skill] \| None` | `None` | Skills the agent gains. Composed into the system prompt on every turn (see [How it works](#how-it-works)). Local skills only — a `"platform:<name>"` ref fails loud via `compose_skills`. |

There is no `skills_mode` option: composition into the system prompt is the only way skills
reach the model in this thin client.

## Notes & caveats

- **Skill content is trusted.** You author skill bodies like you author `instructions`; the
  SDK does not sandbox their content. Only load `skill_from_dir()` from directories you
  control.
- **Session identity uses skill *names*, not bodies.** An agent's session key folds in the set
  of skill names (order-independent, sorted) alongside the model ref and `instructions` — so
  fixing a typo in a skill body will not silently fork a resumed conversation, but renaming,
  adding, or removing a skill does change the key. See [Sessions & memory](../README.md) in
  the README.
- **Duplicate names fail loud** — each skill needs a unique `name`, checked by
  `compose_skills()`.
- **Platform skills are a later increment.** Any `"platform:<name>"` ref raises
  `DivaNotImplementedError` today, and it isn't reachable through `Agent`'s documented
  `skills: list[Skill]` type — only by calling `compose_skills()` yourself with a raw string
  in the list.

## See also

- [Quickstart](./quickstart.md) — the `Agent` constructor and `run()` / `stream()`.
- [Tools & toolsets](./tools.md) — client-side tools an agent can call.
- [Sub-agents](./subagents.md) — delegating to a specialized agent (a sub-agent can have its
  own skills too).
- The project [README](../README.md) — Sessions & memory, and the full `DivaError` taxonomy.
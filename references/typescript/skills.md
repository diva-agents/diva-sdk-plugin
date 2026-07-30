# Skills

Skills are named, reusable instruction/knowledge blocks — a persona's tone, an
objection-handling playbook, a domain glossary — that an agent gains without you
hand-editing `instructions` for every turn. They mirror the engine's own
progressive-disclosure skills: by default only a skill's name and description sit
in context, and the model loads a skill's body **on demand** when it decides the
skill is relevant.

## When to use

- **Use** for stable, reusable capabilities you want to attach declaratively and
  share across agents (brand voice, refund policy, a support runbook).
- **Use invocable mode** (the default) when you have several skills or large
  bodies and want to keep per-turn token cost low — the model pulls in only what
  it needs.
- **Use prepend mode** when you need a shared `client` (a pooled host) or want to
  avoid any host filesystem, and the total skill text is small.
- **Avoid** stuffing volatile, turn-specific context here — put that in the
  `message`. Skills are for durable knowledge.

## How it works

A skill is a plain object — `{ name, description, body }` — that you author and
therefore trust (the same trust level as `instructions`). You attach skills to an
[Agent](./agents.md) via the `skills` option, and choose how they reach the model
with `skillsMode`:

### Invocable mode (default)

`skillsMode: "invocable"` matches the engine and Claude. The SDK exposes each skill
through a client-side `read_skill` tool and puts only each skill's **name +
description** into the system prompt; the model reads a skill's `body` on demand via
`read_skill`. Per-turn cost scales with the number of skills' headers, not the sum of
all bodies — this is the progressive-disclosure win.

Because invocable mode adds a client-side tool to the agent's own engine session, an
invocable-skills agent **owns its host** and cannot share an explicit `client`.
Construction throws a `DivaError` if you pass one (see [Notes & caveats](#notes--caveats)).

### Prepend mode (zero-FS opt-out)

`skillsMode: "prepend"` inlines **every** skill body into the system prompt on
every turn (appended after `instructions`, under a `You have the following skills.
Use them when relevant:` block). No host filesystem is touched and no `read` tool
is added, so a prepend-mode agent works with a shared `client`. The trade-off is
token cost: per-turn cost scales with the **sum of all skill bodies**, and there
is no progressive disclosure. This is the composition performed by
[`composeSkills`](#composeskillsinstructions-skills).

### The platform-skill boundary

A skill reference can be a local `Skill` object or a `"platform:<name>"` string
naming a server-side skill from the platform's skill base. **Platform skills are
not yet wired** — passing a string ref throws `DivaNotImplementedError` in both
modes. Use local skills (`skill()` / `skillFromDir()`) until the platform skill
base lands.

## Example

### Attach a local skill (invocable, default)

Mirrors `examples/skills.ts`. The `brand-voice` skill is written as a `SKILL.md`
the model loads when it's about to write to the customer.

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/skills.ts
import { Agent, skill } from "@diva-ai/sdk";

async function main(): Promise<void> {
  const brandVoice = skill({
    name: "brand-voice",
    description: "How this brand speaks",
    body: "Be warm and concise. Never use exclamation marks. Sign off with '— Team Diva'.",
  });

  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "You are a customer support assistant.",
    skills: [brandVoice], // skillsMode defaults to "invocable"
  });

  try {
    const { text } = await agent.run("A customer asks: is my order 4512 shipped?");
    console.log(text); // follows the brand-voice skill (warm, concise, signed off)
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Load a skill from a directory

`skillFromDir` reads `<dir>/SKILL.md`, splitting `name` / `description` from
optional frontmatter and using the rest as the body.

```ts
import { Agent, skillFromDir } from "@diva-ai/sdk";

// ./skills/refund-policy/SKILL.md:
//   ---
//   name: refund-policy
//   description: When and how to authorize a refund
//   ---
//   Refunds are allowed within 30 days with proof of purchase. …
const refundPolicy = skillFromDir("./skills/refund-policy");

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You handle billing questions.",
  skills: [refundPolicy],
});
```

### Prepend mode with a shared client

Prepend mode inlines bodies into the prompt, so it needs no host FS and can run
against a shared `client`.

```ts
import { Agent, DivaClient, skill } from "@diva-ai/sdk";

const client = new DivaClient({ apiKey: process.env.DIVA_API_KEY });

const glossary = skill({
  name: "glossary",
  description: "Internal product terms",
  body: "‘Seat’ = one licensed user. ‘Workspace’ = a billing account.",
});

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "You answer product questions.",
  skills: [glossary],
  skillsMode: "prepend", // zero-FS: works with a shared client
  client,
});
```

## API

### `skill(def)`

```ts
function skill(def: { name: string; description: string; body: string }): Skill;
```

Define a skill programmatically. Validates and returns a `Skill`. Throws
`DivaError` when:

| Rule | Constraint |
| --- | --- |
| `name` | Must match `/^[a-zA-Z][a-zA-Z0-9_-]*$/` — a letter-led identifier (letters, digits, `_`, `-`), e.g. `"objection-handling"`. Trimmed before validation. |
| `description` | Must be a **single line** — a `\r` or `\n` throws (a newline would forge a second header line in the composed prompt). |
| `body` | Must be non-empty after trim. |
| `body` size | Must be ≤ 64 KiB (65,536 bytes, UTF-8). Larger throws — it will not be truncated. |

### `skillFromDir(dir)`

```ts
function skillFromDir(dir: string): Skill;
```

Load a skill from a directory containing `SKILL.md`. `dir` **must be trusted** —
the file (following symlinks) is read into the system prompt, so an
attacker-controlled path is an exfiltration channel.

- **Frontmatter** is a leading `---` … `---` block. It is treated as frontmatter
  **only if it contains at least one `key: value` line**; a document that merely
  opens with a `---` horizontal rule is kept entirely as the body. Recognized keys
  are `name` and `description`; surrounding quotes are stripped.
- **Missing or empty `name`** falls back to the directory's basename.
- **Missing `description`** becomes `""`.
- **YAML block scalars** (`|` or `>`) as a frontmatter value throw `DivaError`
  rather than being mis-parsed — use a single-line value or move long text to the
  body.
- The parsed result is passed through `skill()`, so all `skill()` validation
  (name regex, single-line description, body size) applies.
- If `<dir>/SKILL.md` cannot be read, throws `DivaError` with the underlying
  cause attached.

### `composeSkills(instructions, skills)`

```ts
function composeSkills(
  instructions: string | undefined,
  skills: SkillRef[] | undefined,
): string | undefined;
```

The **prepend-mode** composer: folds skill bodies into a single system prompt
string. This is what the Agent uses under `skillsMode: "prepend"`; you rarely call
it directly.

- Returns `instructions` **unchanged** when `skills` is absent or empty.
- Each skill renders as `## Skill: <name> — <description>` (or `## Skill: <name>`
  when the description is empty) followed by its body, under a leading
  `You have the following skills. Use them when relevant:` line.
- A `"platform:<name>"` string ref throws `DivaNotImplementedError`.
- A duplicate skill `name` throws `DivaError`.
- If the composed prompt exceeds 256 KiB (262,144 bytes, UTF-8), throws
  `DivaError` — reduce skill bodies.

### `Skill`

```ts
type Skill = { readonly name: string; readonly description: string; readonly body: string };
```

A named instruction/knowledge block the agent gains. All fields are readonly.

### `SkillRef`

```ts
type SkillRef = Skill | string;
```

What you pass in the `skills` array: a local `Skill`, or a `"platform:<name>"`
string ref (**not yet wired** — throws `DivaNotImplementedError`).

## Agent options

Set on [`AgentOptions`](./agents.md):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `skills` | `SkillRef[]` | — | Skills the agent gains. Local skills only today; a `"platform:<name>"` ref fails loud. |
| `skillsMode` | `"invocable" \| "prepend"` | `"invocable"` | How skills reach the model. `"invocable"` adds a client-side `read_skill` tool and puts only each skill's name + description in the prompt (token-efficient, on-demand load, **owns the host**). `"prepend"` inlines every body into the system prompt each turn (works with a shared `client`, token-heavy). |

## Notes & caveats

- **Invocable skills own the host.** With `skillsMode: "invocable"` (the default)
  and a non-empty `skills` array, passing an explicit `client` throws a
  `DivaError`: *"Agent invocable skills (skillsMode:"invocable", the default)
  require the agent to own its host (they write SKILL.md files + a read tool):
  pass them without a shared `client`, or use skillsMode:"prepend"."* Configure
  the implicit client via `clientOptions` instead, or switch to prepend mode.
- **Invocable skills conflict with `builtinTools.fileOps`.** They use a dedicated
  skills-only workspace, whereas `fileOps` reads your files; construction throws.
  Use `skillsMode: "prepend"` to combine skills with file ops, or drop one.
- **Invocable skills need the `read` tool.** If `permissions.deny` includes
  `"read"`, construction throws — invocable mode loads bodies via `read`. Remove
  the deny or use prepend mode (which needs no `read` tool). See
  [Permissions](./permissions.md).
- **Skill content is trusted.** You author skill bodies like you author
  `instructions`; the SDK does not sandbox their content. Only load
  `skillFromDir` from directories you control.
- **Session identity uses skill *names*, not bodies.** An agent's resumable
  session scope folds in the set of skill names (order-independent), not the
  bodies — so fixing a typo in a skill body will not silently fork a resumed
  conversation. Renaming, adding, or removing a skill does change the scope. See
  [Sessions & memory](./sessions-and-memory.md).
- **Duplicate names fail loud** in both modes — each skill needs a unique `name`.
- **Platform skills are a later increment.** Any `"platform:<name>"` ref throws
  `DivaNotImplementedError` today.

## See also

- [Agents](./agents.md) — the `skills` / `skillsMode` options and the owns-host rule.
- [Permissions](./permissions.md) — the `read`/`deny` interaction with invocable skills.
- [Tools](./tools.md) — client-side tools an agent can call.
- [Sub-agents](./subagents.md) — delegating to a specialized agent.
- [Sessions & memory](./sessions-and-memory.md) — how skill identity scopes a session.
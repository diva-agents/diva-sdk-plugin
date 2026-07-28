# Toolsets

A **toolset** is a named, reusable group of client-side [`tool()`](./tools.md)s. Build
it once as a plain value and share it across agents — the toolset way to organize and
compose related tools, mirroring how [`mcp`](./mcp.md) attaches external servers.

## When to use

- **Group related tools** — e.g. a `crm` set and an `ops` set — so an agent's
  capabilities read as a short list of domains rather than a flat pile of tools.
- **Reuse across agents** — a `Toolset` is an immutable value; the same set can be
  handed to several agents.
- **Skip it** for a one-off agent with a couple of tools — just pass `tools: [...]`.

For a single tool or ad-hoc list, use the top-level `tools` option directly (see
[Tools](./tools.md)). Toolsets and top-level `tools` compose together on one agent.

## How it works

`toolset(name, tools)` returns a `Toolset` — a `{ name, tools }` value. Two checks
run eagerly so mistakes fail loud, early:

- The `name` must be non-empty after trimming, else it throws
  `toolset: a non-empty name is required.`
- Tool names must be **unique within the set**; a duplicate throws
  `toolset "<name>": duplicate tool name "<tool>" within the set.` (a duplicate would
  otherwise shadow its sibling).

The tool array is **copied**, so mutating your original array afterwards can't smuggle
a duplicate past the check.

When you attach toolsets to an agent (`new Agent(model, { toolsets: [crm, ops] })`),
the agent flattens the top-level `tools` plus every toolset into one list at
**construction**. A name collision **across** the two — `tools`↔`tools`,
`tools`↔toolset, or toolset↔toolset — throws a `DivaError` up front, naming both
offending sources, e.g.:

```
tool "deploy" from toolset "ops" collides with toolset "infra" —
tool names must be unique across `tools` and all `toolsets`.
```

Order is preserved: earlier source, earlier tool first. The flattened list is exactly
what the agent serves through its loopback tool server, so a collision surfaces as a
clean error before the first turn — not as a late host-side failure. Everything else
about how these tools execute is identical to [Tools](./tools.md): they run in your
process, namespaced to the model as `diva-tools__<name>`.

Because toolsets configure the agent's own engine session, an agent with `toolsets`
**owns its host** and cannot share an explicit `client` — configure the implicit
client via `clientOptions` (same rule as `tools`; see [Agents](./agents.md)).

## Example

Mirrors `examples/toolsets.ts`. Two reusable, named sets composed onto one agent.

```ts
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/toolsets.ts
import { Agent, tool, toolset, z } from "@diva-ai/sdk";

const createLead = tool({
  name: "create_lead",
  description: "Create a CRM lead for a company.",
  inputSchema: z.object({ company: z.string() }),
  execute: async ({ company }) => ({ id: `lead_${company.toLowerCase()}`, company }),
});

const deploy = tool({
  name: "deploy",
  description: "Deploy the given service to production.",
  inputSchema: z.object({ service: z.string() }),
  execute: async ({ service }) => ({ deployed: service, status: "ok" }),
});

async function main(): Promise<void> {
  // Two reusable, named sets — share them across agents.
  const crm = toolset("crm", [createLead]);
  const ops = toolset("ops", [deploy]);

  const agent = new Agent("diva/gpt/gpt-4o-mini", {
    instructions: "Use the available tools to fulfil the request. Report what you did.",
    toolsets: [crm, ops],
  });

  try {
    const { text } = await agent.run("Create a lead for Acme Corp.");
    console.log(text);
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Composing toolsets ahead of the agent

`composeToolsets` flattens several toolsets into a single tool list (failing loud on a
cross-set collision, naming both toolsets) — useful when you want the merged `tools`
list yourself before constructing the agent:

```ts
import { composeToolsets, toolset } from "@diva-ai/sdk";

const crm = toolset("crm", [createLead]);
const ops = toolset("ops", [deploy]);

// One flat, collision-checked list — order preserved (crm's tools, then ops').
const allTools = composeToolsets([crm, ops]);

const agent = new Agent("diva/gpt/gpt-4o-mini", { tools: allTools });
```

## API

### `toolset(name, tools)`

```ts
function toolset(name: string, tools: ToolDefinition[]): Toolset
```

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | `string` | Human-readable set name (required, trimmed). Used in collision messages. Empty → `DivaError`. |
| `tools` | `ToolDefinition[]` | The tools in this set. Copied into the toolset. Names must be unique within the set. |

Returns a `Toolset`. Throws `DivaError` on an empty name or an intra-set duplicate.

### `Toolset`

| Field | Type | Description |
| --- | --- | --- |
| `name` | `readonly string` | The set's name. |
| `tools` | `readonly ToolDefinition[]` | The tools in the set (a copy of the input array). |

### `composeToolsets(toolsets)`

```ts
function composeToolsets(toolsets: readonly Toolset[]): ToolDefinition[]
```

Flattens toolsets into one `ToolDefinition[]`, preserving order (earlier toolset,
earlier tool first). Throws a `DivaError` on a cross-set name collision, naming both
toolsets.

## Notes & caveats

- **Two levels of uniqueness.** `toolset()` catches duplicates *within* one set;
  the agent (and `composeToolsets`) catches duplicates *across* sets and against
  top-level `tools`. Both throw `DivaError`.
- **Immutable by construction.** `toolset()` copies the tool array, so later mutation
  of your source array can't change what the toolset contains.
- **`toolsets` owns the host** — like `tools`, an agent using `toolsets` can't take a
  shared `client`. Use `clientOptions`.
- **No behavioral difference at runtime.** Grouping is purely organizational; a tool
  inside a toolset executes exactly like a top-level `tool()` and is still
  `diva-tools__<name>` to the model.

## See also

- [Tools](./tools.md) — defining individual client-side tools and how they execute.
- [External MCP servers](./mcp.md) — attach tools that are separate programs/services.
- [Agents](./agents.md) — `tools` / `toolsets` options and the "owns its host" rule.
- [Core concepts](./core-concepts.md) — the harness-as-library host model.
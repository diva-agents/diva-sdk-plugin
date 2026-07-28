# toolset (function)

Group related tools into a named, reusable set. Tool names must be unique WITHIN
the set (a duplicate would shadow its sibling); collisions ACROSS composed
toolsets — or against an agent's top-level `tools` — are caught when the agent
composes them (see {@link composeAgentTools}). The tool array is COPIED, so
mutating the caller's array afterwards cannot smuggle a duplicate past this check.

```ts
toolset(name: string, tools: ToolDefinition[]): Toolset
```


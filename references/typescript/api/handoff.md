# handoff (function)

Turn a sub-agent into a handoff: a client-side tool the PARENT model can call
to delegate to it. When the parent invokes `transfer_to_<name>`, the sub-agent
runs one turn and its reply becomes the tool result the parent sees. A handoff
is "just a typed tool transfer" (RFC §11) — there are no graphs; a sub-agent
is a normal Agent you construct and own. Pass the handoff via the parent's
`tools`:

```ts
const qualifier = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "Qualify the lead in one line.",
  clientOptions: { apiKey },
});
const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  tools: [handoff(qualifier, { name: "qualifier", description: "Qualify an inbound lead" })],
  clientOptions: { apiKey },
});
```

Isolation: EACH handoff is an independent, stateless sub-agent turn (a fresh
session) — the sub-agent does NOT remember prior handoffs within the parent
conversation. This is the RFC's isolated-context choice; thread continuity
yourself if you need it.

Lifecycle: a sub-agent owns its own host. `close()` it yourself — the parent's
`close()` does NOT cascade (sub-agents are independent Agents), and calling
`close()` on a sub-agent that shares an explicit `client` is a no-op (the
client owner closes the host). Pre-warm with `subAgent.start()` before the
parent handles traffic, or the first delegated turn pays a host boot.

```ts
handoff<TSchema extends z.ZodType = ZodObject<{ message: ZodString; }, $strip>>(subAgent: Agent, options: HandoffOptions<TSchema>): ToolDefinition
```


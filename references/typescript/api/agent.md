# Agent (class)

```ts
Agent(model?: string, options?: AgentOptions): Agent
```

## serve — method

```ts
serve(opts?: ServeOptions | undefined): Promise<ServeHandle>
```

Hold a connection open so the PLATFORM can reach this agent (ТЗ H, §4.6).

Without it an agent is only ever visible after the fact: it appears in the
dashboard because it ran a turn, and it looks "offline" the moment it stops
running them, whether or not the process is alive. With it, the process says
which agent it serves and then stays on the line, so the dashboard can show
it as genuinely reachable and an operator can talk to it from the web — with
the agent's `tool()`s executing right here, which is the only place they can.

```ts
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
const serving = await agent.serve({ signal: controller.signal });
await serving.closed();
```

Reconnects on its own with exponential backoff, and deregisters on `stop()`
so the dashboard flips to offline immediately rather than when the lease
lapses. Calling it twice on one agent throws rather than opening a second
socket — two connections for one process is a state the platform tolerates
(a developer may genuinely run two) and this process has no reason to create.

| param | type | required |
|---|---|---|
| `opts` | `ServeOptions \| undefined` | no |

Returns: `Promise<ServeHandle>`

## run — method

```ts
run(message: string, opts?: RunOptions | undefined): Promise<AgentResult>
```

Run one turn and return the assistant's reply.

| param | type | required |
|---|---|---|
| `message` | `string` | yes |
| `opts` | `RunOptions \| undefined` | no |

Returns: `Promise<AgentResult>`

## stream — method

```ts
stream(message: string, opts?: RunOptions | undefined): AsyncGenerator<AgentStreamChunk, any, any>
```

Stream one turn: yields `delta` chunks as the model produces text, then a
single terminal `done` chunk with the complete reply. Same turn semantics as
run() (model + instructions), just incremental.

```ts
for await (const chunk of agent.stream("Tell me a joke")) {
  if (chunk.type === "delta") process.stdout.write(chunk.delta);
  else console.log("\n[done]", chunk.runId);
}
```

| param | type | required |
|---|---|---|
| `message` | `string` | yes |
| `opts` | `RunOptions \| undefined` | no |

Returns: `AsyncGenerator<AgentStreamChunk, any, any>`

## generate — method

```ts
generate<TSchema extends z.ZodType>(message: string, schema: TSchema, opts?: RunOptions | undefined): Promise<StructuredResult<output<TSchema>>>
```

Run one turn and return a typed, schema-validated result. The model is
instructed to reply with only JSON matching `schema`; the reply is parsed
and validated with the zod schema, and re-asked once — within the SAME
(generate-scoped) session, so the model sees its rejected reply — if it does
not conform. Fails loud with a DivaRequestError if it still doesn't match.

Semantics to know:
- The exchange runs in its own session namespace, disjoint from
  run()/stream(), so the JSON directive never pollutes conversational
  history (even when you pass the same `sessionId`).
- A client-side `store` is NOT consulted here: generate() is a standalone
  structured extraction, so it neither reads prior turns nor commits this
  one. Fold any conversational context you need into `message` yourself.
- For this turn the JSON directive overrides any conversational persona in
  `instructions` (a "greet warmly" persona would break JSON parsing).
- A default `z.object` STRIPS unknown keys the model returns; use
  `.passthrough()` if you need to keep extras (they remain in `text`).

(Prompt-guided structured output — the agent RPC has no native
response_format yet; the return shape is stable if it gains one.)

```ts
const { output } = await agent.generate("Extract the lead", z.object({
  name: z.string(), email: z.string(),
}));
output.email; // typed
```

| param | type | required |
|---|---|---|
| `message` | `string` | yes |
| `schema` | `TSchema` | yes |
| `opts` | `RunOptions \| undefined` | no |

Returns: `Promise<StructuredResult<output<TSchema>>>`

## session — method

```ts
session(sessionId?: string | undefined): AgentSession
```

Open a multi-turn conversation. Successive `run()`/`stream()` on the
returned session share history (server-side). Pass a `sessionId` to resume
an existing conversation; omit it for a fresh one.

```ts
const chat = agent.session();
await chat.run("My name is Ada.");
(await chat.run("What's my name?")).text; // → "…Ada…"
```

| param | type | required |
|---|---|---|
| `sessionId` | `string \| undefined` | no |

Returns: `AgentSession`

## start — method

```ts
start(): Promise<void>
```

Pre-warm the underlying host so the first `run()`/`stream()` is not a cold
boot. Idempotent while the agent is open; throws after `close()` (make a new
Agent to run again). Especially useful for a sub-agent used in a `handoff()`:
warm it before the parent handles traffic, or the first delegated turn pays
the full host boot INSIDE the parent's tool-call timeout.

Returns: `Promise<void>`

## close — method

```ts
close(): Promise<void>
```

Stop the underlying client if this agent created it.

Returns: `Promise<void>`


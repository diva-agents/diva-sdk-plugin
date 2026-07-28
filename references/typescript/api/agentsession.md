# AgentSession (class)

A multi-turn conversation bound to one `sessionId`. Successive `run()`/`stream()`
share history — server-side by default, or in the agent's client-side `store`.

```ts
AgentSession(agent: Agent, sessionId: string): AgentSession
```

## run — method

```ts
run(message: string): Promise<AgentResult>
```

Run one turn in this conversation.

| param | type | required |
|---|---|---|
| `message` | `string` | yes |

Returns: `Promise<AgentResult>`

## stream — method

```ts
stream(message: string): AsyncGenerator<AgentStreamChunk, any, any>
```

Stream one turn in this conversation.

| param | type | required |
|---|---|---|
| `message` | `string` | yes |

Returns: `AsyncGenerator<AgentStreamChunk, any, any>`


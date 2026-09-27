# Agent (class)

The top-level entry point of ``diva_ai``.

Construct one with a namespaced model ref (defaults to ``DEFAULT_MODEL``,
e.g. ``"diva/deepseek/deepseek-v4-flash"``) and a set of keyword-only
options — ``label``, ``instructions``, ``tools``/``toolsets``,
``permissions``, ``hooks``/``guards``, ``skills``, ``mcp``, ``flow``,
``store``, etc. — then call ``run()``, ``stream()``, or ``generate()`` to
take a turn, or ``session()`` for a multi-turn conversation. The agent loop
and tool routing run server-side in the Diva engine; this class drives it
over a typed WebSocket RPC via a lazily-created :class:`DivaClient`.
Constructor options are validated eagerly — a bad ``thinking_default``, an
invalid ``permissions`` value, or a duplicate tool/MCP-server name raises
at construction rather than on the first turn.

``label`` is the agent's human-readable name on the platform's dashboard
(D5), e.g. ``"Shop support"``. Without it the dashboard names the agent from
its model plus an identity digest — correct, and unreadable in a list. It is
presentation only: it is not folded into the session scope, so renaming an
agent neither forks its conversation nor splits its run history.

```python
Agent(model: str = DEFAULT_MODEL, api_key: str | None = None, label: str | None = None, instructions: str | None = None, tools: list[ToolDefinition] | None = None, toolsets: list[Toolset] | None = None, gateway_url: str | None = None, thinking_default: ThinkingLevel | None = None, params: dict[str, Any] | None = None, permissions: Permissions | None = None, store: SessionStore | None = None, hooks: Hooks | None = None, guards: list[Hooks] | None = None, skills: list[Skill] | None = None, mcp: list[McpServer] | None = None, flow: Flow | None = None, knowledge: str | None = None) -> None
```

## funnel_state — method

```python
funnel_state() -> dict[str, Any] | None
```

Where this agent's funnel stands right now, or ``None`` without one.

The same object the SDK reports to the platform on every turn (G4). The
funnel executes here, so this process is the only place the answer
exists — it is sent so a dashboard can show which step a conversation is
on, and it carries slot FLAGS, never the values a customer supplied.

Returns: `dict[str, Any] \| None`

## serve — method

```python
serve(on_status: Any = None, reconnect_min_delay_ms: int = 500, reconnect_max_delay_ms: int = 30000, logger: Any = None) -> ServeHandle
```

Hold a connection open so the PLATFORM can reach this agent (ТЗ H, §4.6).

Without it an agent is only ever visible after the fact: it appears in the
dashboard because it ran a turn, and it looks offline the moment it stops
running them, whether or not the process is alive. With it, the process
says which agent it serves and then stays on the line — so the dashboard
can show it as genuinely reachable and an operator can talk to it from the
web, with the agent's ``@tool`` functions executing right here, which is
the only place they can.

    handle = await agent.serve()
    try:
        await handle.closed()
    except KeyboardInterrupt:
        await handle.stop()

Reconnects on its own with exponential backoff and deregisters on
``stop()``, so the dashboard flips to offline immediately rather than when
the lease lapses. Calling it twice on one agent raises rather than opening
a second socket: two connections for one process is a state the platform
tolerates — a developer may genuinely run two — and this process has no
reason to create.

Mirror of the TypeScript ``agent.serve()``; the option names are the same
words in each language's casing, deliberately.

| param | type | required |
|---|---|---|
| `on_status` | `Any` | no |
| `reconnect_min_delay_ms` | `int` | no |
| `reconnect_max_delay_ms` | `int` | no |
| `logger` | `Any` | no |

Returns: `ServeHandle`

## run — method

```python
run(message: str, session_id: str | None = None, timeout: float | None = None, model: str | None = None) -> AgentResult
```

| param | type | required |
|---|---|---|
| `message` | `str` | yes |
| `session_id` | `str \| None` | no |
| `timeout` | `float \| None` | no |
| `model` | `str \| None` | no |

Returns: `AgentResult`

## stream — method

```python
stream(message: str, session_id: str | None = None, timeout: float | None = None, model: str | None = None) -> AsyncIterator[AgentStreamChunk]
```

Stream a turn: yields ``DeltaChunk`` as text is produced, then exactly
one terminal ``DoneChunk`` carrying the full text + observability.

| param | type | required |
|---|---|---|
| `message` | `str` | yes |
| `session_id` | `str \| None` | no |
| `timeout` | `float \| None` | no |
| `model` | `str \| None` | no |

Returns: `AsyncIterator[AgentStreamChunk]`

## generate — method

```python
generate(message: str, schema: type[TSchema], timeout: float | None = None, model: str | None = None) -> StructuredResult
```

Prompt-guided structured output: ask for JSON matching ``schema`` (a
pydantic model), validate it, and retry ONCE on failure. Runs in a
disjoint ``generate:<uuid>`` session so it never pollutes the caller's
conversation. Raises ``DivaRequestError`` if the retry also fails.

| param | type | required |
|---|---|---|
| `message` | `str` | yes |
| `schema` | `type[TSchema]` | yes |
| `timeout` | `float \| None` | no |
| `model` | `str \| None` | no |

Returns: `StructuredResult`

## session — method

```python
session(session_id: str | None = None) -> AgentSession
```

| param | type | required |
|---|---|---|
| `session_id` | `str \| None` | no |

Returns: `AgentSession`

## close — method

```python
close() -> None
```

Returns: `None`


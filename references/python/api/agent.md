# Agent (class)

The top-level entry point of ``diva_ai``.

Construct one with a namespaced model ref (e.g. ``"diva/deepseek/deepseek-v4-flash"``)
and a set of keyword-only options — ``instructions``, ``tools``/``toolsets``,
``permissions``, ``hooks``/``guards``, ``skills``, ``mcp``, ``flow``,
``store``, etc. — then call ``run()``, ``stream()``, or ``generate()`` to
take a turn, or ``session()`` for a multi-turn conversation. The agent loop
and tool routing run server-side in the Diva engine; this class drives it
over a typed WebSocket RPC via a lazily-created :class:`DivaClient`.
Constructor options are validated eagerly — a bad ``thinking_default``, an
invalid ``permissions`` value, or a duplicate tool/MCP-server name raises
at construction rather than on the first turn.

```python
Agent(model: str, api_key: str | None = None, instructions: str | None = None, tools: list[ToolDefinition] | None = None, toolsets: list[Toolset] | None = None, gateway_url: str | None = None, thinking_default: ThinkingLevel | None = None, params: dict[str, Any] | None = None, permissions: Permissions | None = None, store: SessionStore | None = None, hooks: Hooks | None = None, guards: list[Hooks] | None = None, skills: list[Skill] | None = None, mcp: list[McpServer] | None = None, flow: Flow | None = None, knowledge: str | None = None) -> None
```

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


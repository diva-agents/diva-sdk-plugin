# AgentSession (class)

A conversation bound to one :class:`Agent` and a stable ``session_id``.

A thin handle that forwards ``run()`` / ``stream()`` to the owning agent
with ``session_id`` pre-filled, so successive calls share history. Unlike
``Agent.run()`` / ``Agent.stream()``, it exposes no per-call ``model=``
override — only ``message`` and ``timeout``. Obtain one via
``Agent.session()`` rather than constructing it directly.

```python
AgentSession(agent: 'Agent', session_id: str) -> None
```

## run — method

```python
run(message: str, timeout: float | None = None) -> AgentResult
```

| param | type | required |
|---|---|---|
| `message` | `str` | yes |
| `timeout` | `float \| None` | no |

Returns: `AgentResult`

## stream — method

```python
stream(message: str, timeout: float | None = None) -> AsyncIterator[AgentStreamChunk]
```

| param | type | required |
|---|---|---|
| `message` | `str` | yes |
| `timeout` | `float \| None` | no |

Returns: `AsyncIterator[AgentStreamChunk]`


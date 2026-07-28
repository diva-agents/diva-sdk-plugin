# handoff (function)

Turn a sub-agent into a ``transfer_to_<name>`` client tool for delegation.

The parent model calls the returned tool to hand off one task to
``sub_agent``. Each call runs a single, independent, stateless sub-agent
turn (``sub_agent.run(message)``, no ``session_id``) and returns the
sub-agent's reply text as the tool result. The default input schema takes
a single ``message: str``; pass ``input_schema`` + ``render`` for a
structured hand-off instead.

Args:
    sub_agent: The delegate agent. Runs with its own instructions,
        model, and tools — never the parent's.
    name: The sub-agent's role; exposed as tool ``transfer_to_<name>``.
        Must be a letter-led identifier, unique among the parent's tools.
    description: When the parent should hand off — read by the model to
        decide.
    input_schema: Optional custom pydantic input schema. Requires
        ``render``.
    render: Maps a validated ``input_schema`` instance to the
        sub-agent's message string. Required when ``input_schema`` is set.
    timeout_ms: Execute ceiling for the handoff tool, in milliseconds.
    on_result: Optional synchronous observer called with the sub-agent's
        full ``AgentResult`` after every hand-off (errors in it are
        swallowed).

Returns:
    A :class:`ToolDefinition` ready for the parent's ``tools``.

Raises:
    DivaError: If ``name`` isn't a letter-led identifier, ``description``
        is blank, or ``input_schema`` is given without ``render``.

```python
handoff(sub_agent: 'Agent', name: str, description: str, input_schema: type[BaseModel] | None = None, render: Callable[[Any], str] | None = None, timeout_ms: int = DEFAULT_HANDOFF_TIMEOUT_MS, on_result: Callable[[AgentResult], None] | None = None) -> ToolDefinition
```


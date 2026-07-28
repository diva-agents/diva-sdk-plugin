# tool (function)

Define a client-side tool the agent's model can call.

``execute`` runs locally in your own process (sync or async) when the
model invokes the tool; its input is validated against ``input_schema``
(a pydantic model) before ``execute`` runs, and the same schema drives
the JSON-Schema sent to the engine on the wire.

Args:
    name: The tool's name, as seen by the model. Required.
    description: What the tool does — read by the model to decide when
        to call it. Required.
    input_schema: A pydantic model describing (and validating) the
        tool's arguments.
    execute: The callable that runs the tool, sync or async.
    execute_timeout_ms: Execute ceiling in milliseconds.

Returns:
    A :class:`ToolDefinition` ready for ``Agent(tools=[...])``.

Raises:
    ValueError: If ``name`` or ``description`` is blank.

```python
tool(name: str, description: str, input_schema: type[BaseModel], execute: Callable[..., Any], execute_timeout_ms: int = DEFAULT_TOOL_TIMEOUT_MS) -> ToolDefinition
```


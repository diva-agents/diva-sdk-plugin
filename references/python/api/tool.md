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
    display: Optional presentation metadata for the platform's dashboard —
        a human title, an icon and a grouping key
        (``{"label": ..., "icon": ..., "category": ...}``). Omit it and the
        platform falls back to ``name``/``description``. See
        :class:`ToolDisplay`.
    requires_approval: Ask a human before this tool runs (D6). The platform
        holds the call, puts an approval card in the organisation's dashboard
        and waits: an operator's Approve lets the call through to this
        process, a Deny returns a refusal to the agent with the operator's
        reason, and an unanswered card expires with an explicit outcome.
        ``execute`` is never entered unless approved.

        This is a SEPARATE gate from ``permissions.can_use_tool``, and they
        compose in this order: the platform's operator decides first (the
        call is still on the wire), your own ``can_use_tool`` decides second
        (the call has arrived). If you mark a tool here, do not ALSO prompt a
        human inside ``can_use_tool`` — that is the one way to get asked
        twice.

Returns:
    A :class:`ToolDefinition` ready for ``Agent(tools=[...])``.

Raises:
    ValueError: If ``name`` or ``description`` is blank.

```python
tool(name: str, description: str, input_schema: type[BaseModel], execute: Callable[..., Any], execute_timeout_ms: int = DEFAULT_TOOL_TIMEOUT_MS, display: ToolDisplay | None = None, requires_approval: bool = False) -> ToolDefinition
```


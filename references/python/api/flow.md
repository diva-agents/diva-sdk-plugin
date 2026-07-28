# flow (function)

Start building a slot-filling funnel (a :class:`Flow`) named ``name``.

Chain :class:`FlowBuilder` methods (``.slot()``, ``.gate()``,
``.completion()``, ...) then call ``.build()`` to validate and compile
it. Pass the result to ``Agent(flow=...)``, where it is enforced
client-side by hard-blocking the completion tool until required slots
are filled.

Args:
    name: The funnel's name. Stripped before validation.

Returns:
    A fresh :class:`FlowBuilder`.

Raises:
    DivaError: If ``name`` is empty after stripping.

```python
flow(name: str) -> FlowBuilder
```


# toolset (function)

Group related tools into a named set. Tool names must be unique within it;
cross-set / base collisions are caught when the agent composes them.

```python
toolset(name: str, tools: Sequence[ToolDefinition]) -> Toolset
```


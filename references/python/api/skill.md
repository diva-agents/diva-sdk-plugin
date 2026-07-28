# skill (function)

Define a named, reusable instruction/knowledge block for an agent.

Composed directly into the system prompt of every turn via
``Agent(skills=[...])`` (or manually with :func:`compose_skills`).

Args:
    name: A letter-led identifier (letters, digits, ``_``, ``-``),
        e.g. ``"objection-handling"``. Trimmed before validation.
    description: A single-line summary (no newlines).
    body: The skill's content. Must be non-empty and at most 64 KiB
        UTF-8-encoded.

Returns:
    The validated :class:`Skill`.

Raises:
    DivaError: If ``name`` is invalid, ``description`` spans multiple
        lines, or ``body`` is empty or too large.

```python
skill(name: str, description: str, body: str) -> Skill
```


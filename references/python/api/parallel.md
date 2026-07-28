# parallel (function)

Run independent async thunks with bounded concurrency.

At most ``concurrency`` tasks run at once; each task is a thunk
(``() -> Awaitable``) so it only starts once a concurrency slot frees up.
Results are collected and returned in INPUT order (not completion order)
as :class:`Settled` entries. Never raises — a failing task becomes a
``Settled(status="rejected", reason=exc)`` entry so one bad run can't
sink the batch.

Args:
    tasks: Zero-argument callables, each returning an awaitable.
    concurrency: Maximum number of tasks in flight at once.

Returns:
    One :class:`Settled` per task, in the same order as ``tasks``.

Raises:
    ValueError: If ``concurrency`` is not an int >= 1.

```python
parallel(tasks: Sequence[Callable[[], Awaitable[Any]]], concurrency: int = DEFAULT_PARALLEL_CONCURRENCY) -> list[Settled]
```


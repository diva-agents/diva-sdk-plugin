# parallel (function)

```ts
parallel<T>(tasks: readonly (() => Promise<T>)[], options?: { concurrency?: number | undefined; } | undefined): Promise<PromiseSettledResult<T>[]>
```


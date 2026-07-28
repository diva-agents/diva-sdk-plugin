# AgentResult (type)

The result of a turn: the assistant reply plus reasoning and observability (usage, timing, stop reason).

```ts
AgentResult
```

## text — property

```ts
text: string
```

The assistant's text reply.

## reasoning — property

```ts
reasoning: string | undefined
```

The model's reasoning / thinking, when reasoning is enabled (`thinkingDefault`
≠ "off") and the model emitted any. Kept SEPARATE from `text` — never stripped
or discarded — so you decide whether to show it. Undefined when reasoning is
off or the model produced none.

## runId — property

```ts
runId: string | undefined
```

The run id assigned by the engine.

## usage — property

```ts
usage: Usage | undefined
```

Token usage for the turn, when the engine reported it.

## durationMs — property

```ts
durationMs: number | undefined
```

Wall-clock duration of the turn in ms, when reported.

## stopReason — property

```ts
stopReason: string | undefined
```

Why the turn stopped (e.g. "stop", "length"), when reported.


# StructuredResult (type)

The result of a structured turn: the parsed, schema-validated output + raw text.

```ts
StructuredResult
```

## output — property

```ts
output: TOutput
```

The reply parsed and validated against the schema.

## text — property

```ts
text: string
```

The raw assistant text the output was parsed from.

## runId — property

```ts
runId: string | undefined
```

## attempts — property

```ts
attempts: number
```

Model attempts taken: 1 = one-shot; 2 = the first reply failed validation and was re-asked.

## repaired — property

```ts
repaired: boolean
```

True when the first attempt failed schema validation and the retry produced the result.

## usage — property

```ts
usage: Usage | undefined
```

Token usage for the (final, successful) turn, when the engine reported it.

## durationMs — property

```ts
durationMs: number | undefined
```

Wall-clock duration of the (final) turn in ms, when reported.

## stopReason — property

```ts
stopReason: string | undefined
```

Why the (final) turn stopped, when reported.


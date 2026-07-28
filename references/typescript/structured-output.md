# Structured output

`agent.generate(message, schema, opts?)` runs one turn and returns a typed,
schema-validated result instead of free text. You pass a zod schema; the SDK
prompts the model to reply with only JSON matching it, then parses and validates
the reply into a fully-typed object. Use it whenever you need machine-readable
data — extracting a lead, classifying an intent, pulling fields out of a message —
rather than prose.

## When to use

- Extraction / parsing where the shape is known ahead of time.
- Classification into a fixed enum.
- Any turn whose output you will consume programmatically.

Use [`run()`](./agents.md) for conversational text and [`stream()`](./streaming.md)
for token-by-token rendering. `generate()` is not streamed.

## How it works

```ts
async generate<TSchema extends z.ZodType>(
  message: string,
  schema: TSchema,
  opts?: RunOptions,
): Promise<StructuredResult<z.infer<TSchema>>>
```

Step by step:

1. **Schema → JSON Schema.** The zod `schema` is converted with
   `z.toJSONSchema(schema)` and stringified. If it cannot be represented as JSON
   Schema (e.g. `.transform()`, `z.custom()`, or certain date/bigint configs),
   `generate()` throws a typed `DivaError` — not a raw zod throw — so you catch one
   contract:

   ```
   agent.generate: the schema cannot be converted to JSON Schema (avoid
   .transform()/z.custom() in a generate() schema).
   ```

2. **JSON directive.** A directive is appended to the system prompt for this turn
   only:

   > *"For THIS reply only, ignore any instruction to greet, explain, apologize, or
   > add prose. Respond with ONLY a single JSON value that validates against the
   > JSON Schema below — nothing before or after it, no markdown fences."* followed
   > by the JSON Schema.

   This deliberately overrides any conversational persona in `instructions` for the
   turn (a "greet warmly" persona would otherwise break JSON parsing).

3. **Extract / repair.** The reply text is passed through `parseJsonReply`, which
   tries, in order: the whole trimmed text, a ```` ```json ```` fenced block, then
   the first balanced `{…}` / `[…]` span (tracking string state so braces inside
   strings don't confuse it). So prose around the JSON, or a fence, still parses. If
   none of the candidates parse, it throws `no valid JSON found in the reply`.

4. **Validate.** The parsed value is validated with `schema.parse(...)`. On success
   the turn returns; on a parse or validation failure the error is captured for the
   retry.

5. **Retry once, same session.** `generate()` makes at most **two** attempts (one
   retry). The retry runs in the SAME generate-scoped session, so the model sees its
   own rejected reply, and is re-prompted:

   > *"Your previous reply was not valid JSON matching the schema (`<error
   > message>`). Reply again with ONLY the corrected JSON."*

6. **Fail loud.** If the second attempt still doesn't parse/validate, `generate()`
   throws a `DivaRequestError`:

   ```
   agent.generate: the reply did not match the schema after a retry. Last reply: <first 200 chars>
   ```

   The error carries `{ provider, model, cause }` where `cause` is the last
   parse/validation error.

### Return shape: `StructuredResult<T>`

| Field | Type | Description |
| --- | --- | --- |
| `output` | `T` (`z.infer<TSchema>`) | The reply parsed and validated against the schema — fully typed. |
| `text` | `string` | The raw assistant text the output was parsed from (after reply hooks). |
| `runId` | `string \| undefined` | The engine's run id for the turn. |
| `attempts` | `number` | Model attempts taken: `1` = one-shot, `2` = the first reply failed validation and was re-asked. |
| `repaired` | `boolean` | `true` when the first attempt failed schema validation and the retry produced the result — distinguish a clean extraction from a repaired one. |
| `usage` | `Usage \| undefined` | Token usage for the final turn (see [Agents](./agents.md)). |
| `durationMs` | `number \| undefined` | Wall-clock ms of the final turn. |
| `stopReason` | `string \| undefined` | Why the final turn stopped. |

### Session isolation

`generate()` runs in its **own** session namespace (`diva-sdk:generate:…`), disjoint
from the `run()` / `stream()` history namespace. Consequences:

- Even if you pass the same `opts.sessionId`, the JSON directive and any rejected
  attempt never leak into your conversational history — a structured extraction
  won't bias the next chat turn toward JSON mode.
- The generate session key is computed **once per call**, so the first attempt and
  the retry share it (that's how the model sees its previous reply). A call with no
  `sessionId` mints a fresh random namespace, isolating each call.
- A client-side `store` is **not** consulted: `generate()` neither reads prior turns
  nor commits this one. Fold any conversational context you need directly into
  `message`.

Client-side hooks and guards still apply: `before_agent_start` can rewrite the
outgoing message, and the reply chains + `agent_end` run on the text that could be
returned — so a reply/PII guard can't be bypassed by choosing `generate()` over
`run()`.

## Example

```ts
// Structured output: get typed, schema-validated data instead of free text.
//
// Run:  DIVA_API_KEY=sk-diva-… node --import tsx examples/structured-output.ts
import { Agent, z } from "@diva-ai/sdk";

const Lead = z.object({
  name: z.string(),
  email: z.string(),
  intent: z.enum(["buy", "support", "other"]),
});

async function main(): Promise<void> {
  const agent = new Agent("diva/gpt/gpt-4o-mini");

  try {
    const { output, text, runId } = await agent.generate(
      "Email: 'Hi, I'm Ada (ada@example.com) — I'd like to buy 10 licenses.' Extract the lead.",
      Lead,
    );
    console.log(output);        // { name, email, intent } — fully typed
    console.log(output.intent); // "buy"  (narrowed to the enum)
    console.log(runId, text);   // run id + the raw JSON it parsed
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`output` is typed as `{ name: string; email: string; intent: "buy" | "support" |
"other" }` — the inferred type of the zod schema.

## API

### `agent.generate(message, schema, opts?)`

| Param | Type | Description |
| --- | --- | --- |
| `message` | `string` | The user message to extract from / respond to. |
| `schema` | `TSchema extends z.ZodType` | The zod schema. `output` is typed as `z.infer<TSchema>`. |
| `opts` | `RunOptions` | Optional. `{ sessionId?: string }` — hashed into the generate-scoped session key; does **not** join run/stream history. |

Returns `Promise<StructuredResult<z.infer<TSchema>>>`.

## Notes & caveats

- **`z.object` strips unknown keys.** By default a `z.object` schema drops any keys
  the model returns that aren't declared. Use `.passthrough()` if you need to keep
  extras — they also remain in `text` (the raw reply) regardless.
- **Avoid non-serializable zod constructs.** `.transform()`, `z.custom()`, and some
  date/bigint configs can't be converted to JSON Schema and throw a `DivaError`
  before any turn runs. Keep generate() schemas to plain shapes/enums/primitives.
- **Prompt-guided, not native.** Structured output is currently driven by the JSON
  directive above; the agent RPC has no native `response_format` yet. The return
  shape (`StructuredResult`) is stable and won't change if native support lands.
- **One retry, then it throws.** There is no silent fallback: after two failed
  attempts you get a `DivaRequestError`. Catch it and decide (retry with a simpler
  schema, log the raw `Last reply: …`, etc.). See [Error handling](./error-handling.md).
- **The directive overrides `instructions` for the turn.** A conversational persona
  in `instructions` is intentionally suppressed for the JSON reply.

## See also

- [Agents](./agents.md) — construction, `run()`, lifecycle
- [Streaming](./streaming.md) — token-by-token text (not structured)
- [Sessions & memory](./sessions-and-memory.md) — why generate() is session-isolated
- [Hooks](./hooks.md) · [Guards](./guards.md) — reply interception still applies
- [Error handling](./error-handling.md) — `DivaError` / `DivaRequestError`
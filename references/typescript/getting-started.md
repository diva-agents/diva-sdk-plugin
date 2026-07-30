# Getting started

Install the SDK, authenticate with your Diva platform key, and run your first agent.

## Requirements

- **Node.js ≥ 22.14.**
- A **Diva platform API key** (`sk-diva-…`) from your platform API-keys page.

## Install

```bash
pnpm add @diva-ai/sdk
# or: npm i @diva-ai/sdk  ·  yarn add @diva-ai/sdk
```

The published package is a **thin client**: it ships no engine bundle and connects to the Diva
platform engine over a WebSocket with your key. (You can also point it at your own engine — see
[Deployment](./deployment.md).)

## Authenticate

Every LLM call is routed through the Diva `/v1` gateway on your key. The SDK reads it from the
`DIVA_API_KEY` environment variable by default:

```bash
export DIVA_API_KEY=sk-diva-...
```

Or pass it explicitly (useful for multi-tenant servers that hold several keys):

```ts
const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  clientOptions: { apiKey: process.env.MY_TENANT_KEY },
});
```

If no key is found, construction throws:

> `No Diva API key. Pass { apiKey } or set DIVA_API_KEY (sk-diva-… from the platform API-keys page).`

There is no provider configuration and no bring-your-own-provider: one key, one gateway.

## Your first agent

A model reference is `provider/model` — the first segment is the platform provider (`diva`), the
rest is the model id.

```ts
import { Agent } from "@diva-ai/sdk";

async function main() {
  const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
    instructions: "You are a terse, friendly assistant.",
  });

  try {
    const { text, runId } = await agent.run("Give me one tip for writing clear commit messages.");
    console.log("reply:", text);
    console.log("runId:", runId);
  } finally {
    await agent.close(); // close the gateway connection
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Run it:

```bash
DIVA_API_KEY=sk-diva-... node --import tsx examples/quickstart.ts
```

Behind the scenes the first `run()` connects to the gateway, routes the turn through Diva `/v1`, and
returns the reply. The connection is reused across turns until you call `close()`. Where the engine
runs — the platform (default) or your own self-hosted gateway — is covered in
[Deployment](./deployment.md); the API is identical in both modes.

> **Always `close()`.** Call `agent.close()` (e.g. in a `finally`) when you're done — it closes the
> gateway connection.

## Stream the reply

For token-by-token output, use `stream()` instead of `run()`:

```ts
for await (const chunk of agent.stream("Count from 1 to 5.")) {
  if (chunk.type === "delta") process.stdout.write(chunk.delta);
  else console.log("\n[done]", chunk.text);
}
```

Details: [Streaming](./streaming.md).

## Give the agent a tool

Client-side tools are plain in-process functions the model can call. Define one with `tool()` and a
Zod input schema (`z` is re-exported from the SDK):

```ts
import { Agent, tool, z } from "@diva-ai/sdk";

const getWeather = tool({
  name: "get_weather",
  description: "Get the current temperature for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ tempC: 21, city }),
});

const agent = new Agent("diva/deepseek/deepseek-v4-flash", {
  instructions: "Use tools to answer questions about the weather.",
  tools: [getWeather],
});

const { text } = await agent.run("What's the weather in Berlin?");
```

The tool runs in *your* process; the model calls it inside the host. Details: [Tools](./tools.md).

> An agent with `tools` (or `mcp`, `builtinTools`, `permissions`, and other host-config options)
> **owns its host** and cannot share an explicit `client`. See [Core concepts →
> Owning the host](./core-concepts.md#owning-the-host).

## Handle errors

All failures are typed subclasses of `DivaError`:

```ts
import { DivaRequestError } from "@diva-ai/sdk";

try {
  await agent.run("…");
} catch (err) {
  if (err instanceof DivaRequestError) {
    console.error("turn failed:", err.detail?.code, err.detail?.model);
  } else {
    throw err;
  }
}
```

Full model: [Error handling](./error-handling.md).

## Next steps

- **[Core concepts](./core-concepts.md)** — Agent vs. DivaClient, the engine, the traffic lock, sessions.
- **[Deployment](./deployment.md)** — platform (hosted) and self-host modes.
- **[Agents](./agents.md)** — every `Agent` option and method.
- **[Code execution](./code-execution.md)** — let the model write and run code, safely.
- **[Permissions](./permissions.md)** — approve tool calls in the loop.
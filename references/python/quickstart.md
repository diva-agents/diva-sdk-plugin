# Quickstart

```python
import asyncio
from diva_ai import Agent


async def main() -> None:
    agent = Agent(
        "diva/deepseek/deepseek-v4-flash",
        instructions="You are a concise assistant.",
        api_key="sk-diva-...",          # or set DIVA_API_KEY
    )
    result = await agent.run("What is the capital of France?")
    print(result.text)                  # "Paris."
    print(result.usage)                 # token usage
    await agent.close()


asyncio.run(main())
```

Point the client at a gateway with `DIVA_GATEWAY_URL` (e.g.
`ws://localhost:5002/gateway` for a local platform) or pass `gateway_url=` to
`Agent`. `ws://` is allowed only to loopback / private ranges; `wss://` always.

## Streaming

```python
from diva_ai import DeltaChunk, DoneChunk

async for chunk in agent.stream("Write a haiku about the sea."):
    if isinstance(chunk, DeltaChunk):
        print(chunk.delta, end="", flush=True)
    elif isinstance(chunk, DoneChunk):
        print("\n--", chunk.usage)
```

## Structured output

```python
from pydantic import BaseModel

class Contact(BaseModel):
    name: str
    email: str

res = await agent.generate("Extract: John Smith, john@x.com.", Contact)
print(res.output)      # Contact(name="John Smith", email="john@x.com")
```
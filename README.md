# Durable agent replay cache stores unsanitized delegated chunks

Minimal reproduction for a follow-up to mastra-ai/mastra#24160. #24399 sanitizes delegated sub-agent chunks on the thread-stream broadcast path. The durable run stream (`agent.stream.<runId>`) and its replay cache still store them unsanitized, so cumulative `steps`, `messages` and request bodies are cached for every forwarded chunk.

No LLM or Redis is needed. Mock models play back a script, and the replay cache is `InMemoryServerCache`.

## Run

```sh
npm install
npm run repro
```

Output on `@mastra/core` 1.80.0 (same on 1.81.0-alpha.0):

```
28 events, 2206 KB cached
  $.data.payload.output.payload.output.steps             1116 KB
  $.data.payload.output.payload.messages                  279 KB
  $.data.payload.output.payload.metadata.request          258 KB
  $.data.payload.output.payload.request                   179 KB
```

The run's only content is 20 KB of instructions per agent and two 20 KB tool results, one delegation.

## Expected

Chunks published to the run stream and stored in the replay cache are sanitized like the broadcast path, including nested delegated chunks.

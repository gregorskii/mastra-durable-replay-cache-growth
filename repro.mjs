import { Agent } from "@mastra/core/agent"
import { createDurableAgent } from "@mastra/core/agent/durable"
import { InMemoryServerCache } from "@mastra/core/cache"
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock"
import { createTool } from "@mastra/core/tools"
import { z } from "zod"

const BIG = "x".repeat(20_000)
const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 }

// Plays back a script of turns and, like real providers, reports request.body.
function scriptedModel(id, turns) {
	let call = 0
	return new MastraLanguageModelV2Mock({
		modelId: id,
		doStream: async (options) => {
			const turn = turns[Math.min(call++, turns.length - 1)]
			const parts = [{ type: "stream-start", warnings: [] }, { type: "response-metadata", id: `r${call}`, modelId: id, timestamp: new Date(0) }]
			if (turn.tool) parts.push({ type: "tool-call", toolCallId: `c${call}`, toolName: turn.tool, input: JSON.stringify(turn.input) })
			else parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: turn.text }, { type: "text-end", id: "t" })
			parts.push({ type: "finish", finishReason: turn.tool ? "tool-calls" : "stop", usage })
			return {
				stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close() } }),
				request: { body: JSON.stringify({ prompt: options.prompt, tools: options.tools }) },
			}
		},
	})
}

const lookup = createTool({
	id: "lookup",
	description: "Look something up.",
	inputSchema: z.object({ q: z.string() }),
	execute: async () => ({ data: BIG }),
})

const researcher = new Agent({
	id: "researcher",
	name: "researcher",
	description: "Researches things",
	instructions: `You are a researcher. ${BIG}`,
	model: scriptedModel("researcher", [{ tool: "lookup", input: { q: "a" } }, { tool: "lookup", input: { q: "b" } }, { text: "Found it." }]),
	tools: { lookup },
})

const supervisor = new Agent({
	id: "supervisor",
	name: "supervisor",
	instructions: `You are a supervisor. ${BIG}`,
	model: scriptedModel("supervisor", [{ tool: "agent-researcher", input: { prompt: "Research it" } }, { text: "Done." }]),
	agents: { researcher },
})

const cache = new InMemoryServerCache()
const durable = createDurableAgent({ agent: supervisor, cache })
const { output, runId } = await durable.stream("Please research this.")
for await (const _ of output.fullStream) {}

const events = await cache.listFromTo(`pubsub:agent.stream.${runId}`, 0, -1)
const bytes = events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0)
console.log(`${events.length} events, ${(bytes / 1024).toFixed(0)} KB cached`)

// Where the bytes are: field paths inside forwarded sub-agent tool-output events.
const byPath = new Map()
const walk = (node, path, depth) => {
	if (node === null || typeof node !== "object" || depth === 0) return
	for (const [k, v] of Object.entries(node)) {
		const p = `${path}.${k}`
		byPath.set(p, (byPath.get(p) ?? 0) + Buffer.byteLength(JSON.stringify(v) ?? ""))
		walk(v, p, depth - 1)
	}
}
for (const e of events) if (e?.data?.type === "tool-output") walk(e, "$", 6)
const leaves = ["output.steps", "messages", "metadata.request", "payload.request"]
for (const [p, b] of [...byPath].filter(([p]) => leaves.some((l) => p.endsWith(l))).sort((a, z) => z[1] - a[1]))
	console.log(`  ${p.padEnd(52)} ${(b / 1024).toFixed(0).padStart(6)} KB`)
process.exit(0)

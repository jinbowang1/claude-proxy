import { describe, it, expect } from "vitest";
import { createUsageTrackingTransform } from "./stream-parser.js";

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

async function pipeChunks(chunks: string[]): Promise<{
	output: string;
	usage: ReturnType<ReturnType<typeof createUsageTrackingTransform>["getUsage"]>;
	model: string;
}> {
	const { transform, getUsage, getModel } = createUsageTrackingTransform();
	const writer = transform.writable.getWriter();
	const reader = transform.readable.getReader();

	const outputParts: string[] = [];

	const readAll = (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			outputParts.push(decoder.decode(value, { stream: true }));
		}
	})();

	for (const chunk of chunks) {
		await writer.write(encode(chunk));
	}
	await writer.close();
	await readAll;

	return { output: outputParts.join(""), usage: getUsage(), model: getModel() };
}

describe("createUsageTrackingTransform", () => {
	it("passes data through transparently", async () => {
		const input = 'data: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n';
		const { output } = await pipeChunks([input]);
		expect(output).toBe(input);
	});

	it("extracts usage from message_start event", async () => {
		const event = {
			type: "message_start",
			message: {
				model: "claude-sonnet-4-6",
				usage: {
					input_tokens: 100,
					cache_read_input_tokens: 50,
					cache_creation_input_tokens: 25,
				},
			},
		};
		const chunk = `data: ${JSON.stringify(event)}\n\n`;
		const { usage, model } = await pipeChunks([chunk]);

		expect(usage.inputTokens).toBe(100);
		expect(usage.cacheReadTokens).toBe(50);
		expect(usage.cacheCreationTokens).toBe(25);
		expect(model).toBe("claude-sonnet-4-6");
	});

	it("extracts usage from message_delta event", async () => {
		const startEvent = {
			type: "message_start",
			message: {
				model: "claude-opus-4-6",
				usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		};
		const deltaEvent = {
			type: "message_delta",
			usage: { output_tokens: 350 },
		};
		const chunks = [
			`data: ${JSON.stringify(startEvent)}\n\n`,
			`data: ${JSON.stringify(deltaEvent)}\n\n`,
		];
		const { usage, model } = await pipeChunks(chunks);

		expect(usage.inputTokens).toBe(200);
		expect(usage.outputTokens).toBe(350);
		expect(model).toBe("claude-opus-4-6");
	});

	it("handles chunked SSE lines split across buffers", async () => {
		const event = {
			type: "message_start",
			message: {
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		};
		const fullLine = `data: ${JSON.stringify(event)}\n\n`;
		// Split in the middle
		const mid = Math.floor(fullLine.length / 2);
		const { usage } = await pipeChunks([fullLine.slice(0, mid), fullLine.slice(mid)]);

		expect(usage.inputTokens).toBe(42);
	});

	it("ignores [DONE] marker", async () => {
		const chunks = ["data: [DONE]\n\n"];
		const { usage } = await pipeChunks(chunks);
		expect(usage.inputTokens).toBe(0);
		expect(usage.outputTokens).toBe(0);
	});

	it("ignores invalid JSON silently", async () => {
		const chunks = ["data: {invalid json}\n\n"];
		const { usage } = await pipeChunks(chunks);
		expect(usage.inputTokens).toBe(0);
	});

	it("handles complete stream with start, content, and delta events", async () => {
		const events = [
			`data: ${JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 500, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
				},
			})}\n\n`,
			`data: ${JSON.stringify({ type: "content_block_start", index: 0 })}\n\n`,
			`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "Hello" } })}\n\n`,
			`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
			`data: ${JSON.stringify({
				type: "message_delta",
				usage: { output_tokens: 150 },
			})}\n\n`,
			"data: [DONE]\n\n",
		];
		const { usage, model } = await pipeChunks(events);

		expect(model).toBe("claude-sonnet-4-6");
		expect(usage.inputTokens).toBe(500);
		expect(usage.outputTokens).toBe(150);
		expect(usage.cacheReadTokens).toBe(100);
		expect(usage.cacheCreationTokens).toBe(0);
	});

	it("message_delta can override input_tokens", async () => {
		const events = [
			`data: ${JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			})}\n\n`,
			`data: ${JSON.stringify({
				type: "message_delta",
				usage: { input_tokens: 120, output_tokens: 50 },
			})}\n\n`,
		];
		const { usage } = await pipeChunks(events);
		expect(usage.inputTokens).toBe(120);
		expect(usage.outputTokens).toBe(50);
	});
});

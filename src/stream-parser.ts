import type { UsageTokens } from "./pricing.js";

/**
 * A TransformStream that passes SSE data through transparently
 * while extracting Anthropic usage information from the events.
 */
export function createUsageTrackingTransform(): {
	transform: TransformStream<Uint8Array, Uint8Array>;
	getUsage: () => UsageTokens;
	getModel: () => string;
} {
	const usage: UsageTokens = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	};
	let model = "";
	let buffer = "";
	const decoder = new TextDecoder();

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			// Pass chunk through transparently
			controller.enqueue(chunk);

			// Decode and parse SSE events for usage extraction
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			// Keep the last incomplete line in the buffer
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6).trim();
				if (data === "[DONE]") continue;

				try {
					const event = JSON.parse(data);
					extractUsage(event, usage);
					if (event.type === "message_start" && event.message?.model) {
						model = event.message.model;
					}
				} catch {
					// Not valid JSON, ignore
				}
			}
		},
		flush(controller) {
			// Process any remaining data in buffer
			if (buffer.trim()) {
				const lines = buffer.split("\n");
				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const data = line.slice(6).trim();
					if (data === "[DONE]") continue;
					try {
						const event = JSON.parse(data);
						extractUsage(event, usage);
					} catch {
						// ignore
					}
				}
			}
		},
	});

	return {
		transform,
		getUsage: () => ({ ...usage }),
		getModel: () => model,
	};
}

function extractUsage(event: any, usage: UsageTokens): void {
	if (event.type === "message_start" && event.message?.usage) {
		const u = event.message.usage;
		usage.inputTokens = u.input_tokens || 0;
		usage.cacheReadTokens = u.cache_read_input_tokens || 0;
		usage.cacheCreationTokens = u.cache_creation_input_tokens || 0;
	}

	if (event.type === "message_delta" && event.usage) {
		const u = event.usage;
		if (u.output_tokens != null) {
			usage.outputTokens = u.output_tokens;
		}
		// Some proxies also include input tokens in message_delta
		if (u.input_tokens != null) {
			usage.inputTokens = u.input_tokens;
		}
		if (u.cache_read_input_tokens != null) {
			usage.cacheReadTokens = u.cache_read_input_tokens;
		}
		if (u.cache_creation_input_tokens != null) {
			usage.cacheCreationTokens = u.cache_creation_input_tokens;
		}
	}
}

/**
 * OpenAI SSE stream parser.
 * Passes data through transparently while extracting usage from the final chunk.
 * OpenAI format: usage is in the last chunk's `usage` field (when stream_options.include_usage is set).
 */
export interface OpenAIUsage {
	promptTokens: number;
	completionTokens: number;
}

export function createOpenAIUsageTrackingTransform(): {
	transform: TransformStream<Uint8Array, Uint8Array>;
	getUsage: () => OpenAIUsage;
	getModel: () => string;
} {
	const usage: OpenAIUsage = {
		promptTokens: 0,
		completionTokens: 0,
	};
	let model = "";
	let buffer = "";
	const decoder = new TextDecoder();

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			controller.enqueue(chunk);

			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6).trim();
				if (data === "[DONE]") continue;

				try {
					const event = JSON.parse(data);
					// Extract model from first chunk
					if (event.model && !model) {
						model = event.model;
					}
					// Usage appears in the final chunk
					if (event.usage) {
						usage.promptTokens = event.usage.prompt_tokens ?? 0;
						usage.completionTokens = event.usage.completion_tokens ?? 0;
					}
				} catch {
					// Not valid JSON, ignore
				}
			}
		},
		flush() {
			if (buffer.trim()) {
				const lines = buffer.split("\n");
				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const data = line.slice(6).trim();
					if (data === "[DONE]") continue;
					try {
						const event = JSON.parse(data);
						if (event.usage) {
							usage.promptTokens = event.usage.prompt_tokens ?? 0;
							usage.completionTokens = event.usage.completion_tokens ?? 0;
						}
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

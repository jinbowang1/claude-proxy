/** Anthropic official pricing (USD per million tokens) */
interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const PRICING: Record<string, ModelPricing> = {
	"claude-sonnet-4-6": {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"claude-sonnet-4-6-20250514": {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"claude-opus-4-6": {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
	"claude-opus-4-6-20250520": {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
};

/** Default fallback pricing (use Sonnet pricing) */
const DEFAULT_PRICING: ModelPricing = PRICING["claude-sonnet-4-6"]!;

export function getModelPricing(modelId: string): ModelPricing {
	return PRICING[modelId] ?? DEFAULT_PRICING;
}

export interface UsageTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

/** Calculate cost in USD from token usage */
export function calculateCostUsd(modelId: string, usage: UsageTokens): number {
	const pricing = getModelPricing(modelId);
	return (
		(usage.inputTokens * pricing.input +
			usage.outputTokens * pricing.output +
			usage.cacheReadTokens * pricing.cacheRead +
			usage.cacheCreationTokens * pricing.cacheWrite) /
		1_000_000
	);
}

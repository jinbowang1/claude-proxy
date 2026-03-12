/** OpenRouter model pricing (USD per million tokens) */
interface OpenRouterModelPricing {
	input: number;
	output: number;
}

const OPENROUTER_PRICING: Record<string, OpenRouterModelPricing> = {
	"openai/gpt-5.4-pro": {
		input: 30,
		output: 180,
	},
	"openai/gpt-5.2": {
		input: 1.25,
		output: 5,
	},
	"deepseek/deepseek-v3.2": {
		input: 0.14,
		output: 0.28,
	},
	// Nano Banana 2: text output $3/M, image output $60/M
	// OpenRouter usage doesn't distinguish image vs text output tokens,
	// so we bill at the image rate ($60/M) since this model is used for image generation.
	"google/gemini-3.1-flash-image-preview": {
		input: 0.5,
		output: 60.0,
	},
};

const DEFAULT_OPENROUTER_PRICING: OpenRouterModelPricing = OPENROUTER_PRICING["openai/gpt-5.2"]!;

export function getOpenRouterPricing(modelId: string): OpenRouterModelPricing {
	return OPENROUTER_PRICING[modelId] ?? DEFAULT_OPENROUTER_PRICING;
}

export function calculateOpenRouterCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
	const pricing = getOpenRouterPricing(modelId);
	return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

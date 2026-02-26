import { describe, it, expect } from "vitest";
import { getModelPricing, calculateCostUsd, type UsageTokens } from "./pricing.js";

describe("getModelPricing", () => {
	it("returns Sonnet 4.6 pricing for claude-sonnet-4-6", () => {
		const p = getModelPricing("claude-sonnet-4-6");
		expect(p.input).toBe(3);
		expect(p.output).toBe(15);
		expect(p.cacheRead).toBe(0.3);
		expect(p.cacheWrite).toBe(3.75);
	});

	it("returns Sonnet 4.6 pricing for dated variant", () => {
		const p = getModelPricing("claude-sonnet-4-6-20250514");
		expect(p.input).toBe(3);
		expect(p.output).toBe(15);
	});

	it("returns Opus 4.6 pricing for claude-opus-4-6", () => {
		const p = getModelPricing("claude-opus-4-6");
		expect(p.input).toBe(5);
		expect(p.output).toBe(25);
		expect(p.cacheRead).toBe(0.5);
		expect(p.cacheWrite).toBe(6.25);
	});

	it("returns Opus 4.6 pricing for dated variant", () => {
		const p = getModelPricing("claude-opus-4-6-20250520");
		expect(p.input).toBe(5);
		expect(p.output).toBe(25);
	});

	it("returns default (Sonnet) pricing for unknown models", () => {
		const p = getModelPricing("claude-3-5-sonnet-20241022");
		expect(p.input).toBe(3);
		expect(p.output).toBe(15);
	});

	it("returns default pricing for empty string", () => {
		const p = getModelPricing("");
		expect(p.input).toBe(3);
	});
});

describe("calculateCostUsd", () => {
	it("calculates cost correctly for Sonnet with all token types", () => {
		const usage: UsageTokens = {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
		};
		// Sonnet: input=3, output=15, cacheRead=0.3, cacheWrite=3.75
		// (1M*3 + 1M*15 + 1M*0.3 + 1M*3.75) / 1M = 3 + 15 + 0.3 + 3.75 = 22.05
		const cost = calculateCostUsd("claude-sonnet-4-6", usage);
		expect(cost).toBeCloseTo(22.05, 6);
	});

	it("calculates cost correctly for Opus", () => {
		const usage: UsageTokens = {
			inputTokens: 500_000,
			outputTokens: 200_000,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		};
		// Opus: input=5, output=25
		// (500k*5 + 200k*25) / 1M = 2.5 + 5.0 = 7.5
		const cost = calculateCostUsd("claude-opus-4-6", usage);
		expect(cost).toBeCloseTo(7.5, 6);
	});

	it("returns 0 for zero tokens", () => {
		const usage: UsageTokens = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		};
		expect(calculateCostUsd("claude-sonnet-4-6", usage)).toBe(0);
	});

	it("handles small token counts without precision issues", () => {
		const usage: UsageTokens = {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		};
		// (100*3 + 50*15) / 1M = (300 + 750) / 1M = 0.00105
		const cost = calculateCostUsd("claude-sonnet-4-6", usage);
		expect(cost).toBeCloseTo(0.00105, 8);
	});

	it("uses default pricing for unknown model", () => {
		const usage: UsageTokens = {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		};
		// Default = Sonnet: 1M * 3 / 1M = 3
		expect(calculateCostUsd("unknown-model", usage)).toBe(3);
	});
});

import { config } from "./config.js";
import { invalidateBalanceCache } from "./balance.js";
import { calculateCostUsd, type UsageTokens } from "./pricing.js";

export interface UsageReport {
	userId: string;
	model: string;
	usage: UsageTokens;
	costUsd: number;
}

/**
 * Report usage to the domestic billing server (fire-and-forget).
 * Errors are logged but never thrown.
 */
export function reportUsage(token: string, report: UsageReport): void {
	// Invalidate cached balance so next request gets fresh data
	invalidateBalanceCache(report.userId);

	const payload = {
		model: report.model,
		inputTokens: report.usage.inputTokens,
		outputTokens: report.usage.outputTokens,
		cacheReadTokens: report.usage.cacheReadTokens,
		cacheCreationTokens: report.usage.cacheCreationTokens,
		costUsd: report.costUsd,
	};

	fetch(`${config.domesticApiUrl}/api/billing/usage`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	}).catch((err) => {
		console.error("Failed to report usage:", err);
	});
}

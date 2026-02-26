import { config } from "./config.js";
import { invalidateBalanceCache } from "./balance.js";

export interface UsageReport {
	userId: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

interface FailedReport {
	token: string;
	payload: Record<string, unknown>;
	retries: number;
	nextRetry: number;
}

const MAX_FAILED_REPORTS = 1000;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 30_000; // 30 seconds

const failedReports: FailedReport[] = [];

/**
 * Report usage to the domestic billing server.
 * On failure, queues the report for retry.
 */
export function reportUsage(token: string, report: UsageReport): void {
	// Invalidate cached balance so next request gets fresh data
	invalidateBalanceCache(report.userId);

	const payload = {
		model: report.model,
		provider: "anthropic",
		inputTokens: report.inputTokens,
		outputTokens: report.outputTokens,
		totalTokens: report.inputTokens + report.outputTokens,
		cost: report.cost,
	};

	sendReport(token, payload);
}

function sendReport(token: string, payload: Record<string, unknown>): void {
	fetch(`${config.domesticApiUrl}/api/billing/usage`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	})
		.then((res) => {
			if (!res.ok) {
				throw new Error(`Billing server responded ${res.status}`);
			}
		})
		.catch((err) => {
			console.error("Failed to report usage:", err);
			enqueueFailedReport(token, payload);
		});
}

function enqueueFailedReport(token: string, payload: Record<string, unknown>): void {
	if (failedReports.length >= MAX_FAILED_REPORTS) {
		console.error("Failed reports queue full, dropping oldest entry");
		failedReports.shift();
	}
	failedReports.push({
		token,
		payload,
		retries: 0,
		nextRetry: Date.now() + BASE_RETRY_MS,
	});
}

/** Process the retry queue — called on a timer. Exported for testing. */
export function _processRetryQueue(): void {
	const now = Date.now();
	let i = 0;
	while (i < failedReports.length) {
		const entry = failedReports[i]!;
		if (entry.nextRetry > now) {
			i++;
			continue;
		}

		// Remove from queue before retrying
		failedReports.splice(i, 1);
		entry.retries++;

		if (entry.retries > MAX_RETRIES) {
			console.error("Dropping usage report after max retries:", entry.payload);
			continue;
		}

		// Re-send; on failure it will be re-enqueued with incremented retry count
		fetch(`${config.domesticApiUrl}/api/billing/usage`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${entry.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(entry.payload),
		})
			.then((res) => {
				if (!res.ok) {
					throw new Error(`Billing server responded ${res.status}`);
				}
			})
			.catch((err) => {
				console.error(`Retry #${entry.retries} failed:`, err);
				if (entry.retries < MAX_RETRIES) {
					const backoff = BASE_RETRY_MS * Math.pow(2, entry.retries - 1);
					entry.nextRetry = Date.now() + backoff;
					if (failedReports.length < MAX_FAILED_REPORTS) {
						failedReports.push(entry);
					}
				} else {
					console.error("Dropping usage report after max retries:", entry.payload);
				}
			});
	}
}

// Retry every 30 seconds
setInterval(_processRetryQueue, 30_000);

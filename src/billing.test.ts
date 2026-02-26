import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config
vi.mock("./config.js", () => ({
	config: {
		domesticApiUrl: "http://billing.test",
		anthropicApiKey: "test-key",
		jwtSecret: "test-secret",
		port: 3001,
	},
}));

// Mock balance cache invalidation
vi.mock("./balance.js", () => ({
	invalidateBalanceCache: vi.fn(),
}));

const { reportUsage, _processRetryQueue } = await import("./billing.js");
const { invalidateBalanceCache } = await import("./balance.js");
import type { UsageReport } from "./billing.js";

describe("reportUsage", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseReport: UsageReport = {
		userId: "user-1",
		model: "claude-sonnet-4-6",
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheCreationTokens: 100,
		cost: 0.0105,
	};

	it("sends correct payload matching dashixiong-server Zod schema", async () => {
		reportUsage("jwt-token", baseReport);

		await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

		const [url, options] = mockFetch.mock.calls[0]!;
		expect(url).toBe("http://billing.test/api/billing/usage");
		expect(options.method).toBe("POST");

		const payload = JSON.parse(options.body);
		expect(payload).toEqual({
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200,
			cacheWriteTokens: 100,
			totalTokens: 1000 + 500 + 200 + 100,
			cost: 0.0105,
			currency: "USD",
		});
	});

	it("sends Authorization header with Bearer token", async () => {
		reportUsage("my-jwt", baseReport);

		await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

		const [, options] = mockFetch.mock.calls[0]!;
		expect(options.headers.Authorization).toBe("Bearer my-jwt");
		expect(options.headers["Content-Type"]).toBe("application/json");
	});

	it("totalTokens includes input + output + cache tokens", async () => {
		const report: UsageReport = {
			userId: "user-2",
			model: "claude-opus-4-6",
			inputTokens: 12345,
			outputTokens: 67890,
			cacheReadTokens: 1000,
			cacheCreationTokens: 500,
			cost: 2.5,
		};
		reportUsage("token", report);

		await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

		const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(payload.totalTokens).toBe(12345 + 67890 + 1000 + 500);
	});

	it("provider is always 'anthropic'", async () => {
		reportUsage("token", baseReport);

		await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

		const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(payload.provider).toBe("anthropic");
	});

	it("includes cacheReadTokens, cacheWriteTokens, currency and no costUsd", async () => {
		reportUsage("token", baseReport);

		await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

		const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(payload).toHaveProperty("cacheReadTokens", 200);
		expect(payload).toHaveProperty("cacheWriteTokens", 100);
		expect(payload).toHaveProperty("currency", "USD");
		expect(payload).not.toHaveProperty("cacheCreationTokens");
		expect(payload).not.toHaveProperty("costUsd");
	});

	it("invalidates balance cache for the user", () => {
		reportUsage("token", baseReport);

		expect(invalidateBalanceCache).toHaveBeenCalledWith("user-1");
	});

	it("handles zero tokens correctly", async () => {
		const report: UsageReport = {
			userId: "user-3",
			model: "claude-sonnet-4-6",
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cost: 0,
		};
		reportUsage("token", report);

		await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

		const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(payload.totalTokens).toBe(0);
		expect(payload.cost).toBe(0);
	});

	describe("Zod schema compliance", () => {
		it("model is a non-empty string", async () => {
			reportUsage("token", baseReport);

			await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

			const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
			expect(typeof payload.model).toBe("string");
			expect(payload.model.length).toBeGreaterThan(0);
		});

		it("provider is a non-empty string", async () => {
			reportUsage("token", baseReport);

			await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

			const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
			expect(typeof payload.provider).toBe("string");
			expect(payload.provider.length).toBeGreaterThan(0);
		});

		it("token counts are non-negative integers", async () => {
			reportUsage("token", baseReport);

			await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

			const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
			expect(Number.isInteger(payload.inputTokens)).toBe(true);
			expect(payload.inputTokens).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(payload.outputTokens)).toBe(true);
			expect(payload.outputTokens).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(payload.totalTokens)).toBe(true);
			expect(payload.totalTokens).toBeGreaterThanOrEqual(0);
		});

		it("cost is a non-negative number", async () => {
			reportUsage("token", baseReport);

			await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

			const payload = JSON.parse(mockFetch.mock.calls[0]![1].body);
			expect(typeof payload.cost).toBe("number");
			expect(payload.cost).toBeGreaterThanOrEqual(0);
		});
	});
});

describe("retry queue (_processRetryQueue)", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function flushMicrotasks() {
		await new Promise((r) => setTimeout(r, 0));
	}

	it("enqueues failed report and retries when _processRetryQueue is called", async () => {
		// Initial send fails
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

		reportUsage("token", {
			userId: "user-retry",
			model: "claude-sonnet-4-6",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cost: 0.001,
		});

		// Wait for initial fetch to fail and catch handler to enqueue
		await flushMicrotasks();
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Set up retry to succeed
		mockFetch.mockResolvedValueOnce({ ok: true });

		// Manually trigger retry processing
		// Need to make nextRetry in the past so it gets picked up
		// The entry was enqueued with nextRetry = Date.now() + 30000
		// So we fast-forward Date.now by manipulating the entry via re-invoking after delay
		// Simpler: use fake timers just for Date.now
		vi.useFakeTimers();
		vi.advanceTimersByTime(31_000); // Make Date.now() > nextRetry

		_processRetryQueue();
		vi.useRealTimers();

		await flushMicrotasks();

		expect(mockFetch).toHaveBeenCalledTimes(2);

		// Verify retry has same payload structure
		const [, retryOptions] = mockFetch.mock.calls[1]!;
		const payload = JSON.parse(retryOptions.body);
		expect(payload).toEqual({
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 150,
			cost: 0.001,
			currency: "USD",
		});
	});

	it("enqueues on non-ok HTTP response and retries", async () => {
		// Server returns 500
		mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

		reportUsage("token", {
			userId: "user-500",
			model: "claude-sonnet-4-6",
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cost: 0.002,
		});

		await flushMicrotasks();
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Set up retry to succeed
		mockFetch.mockResolvedValueOnce({ ok: true });

		vi.useFakeTimers();
		vi.advanceTimersByTime(31_000);
		_processRetryQueue();
		vi.useRealTimers();

		await flushMicrotasks();

		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("retries up to 3 times then drops", async () => {
		// All calls fail
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		reportUsage("token", {
			userId: "user-drop",
			model: "claude-sonnet-4-6",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cost: 0.001,
		});

		await flushMicrotasks();
		expect(mockFetch).toHaveBeenCalledTimes(1); // initial send

		// Retry 1
		vi.useFakeTimers();
		vi.advanceTimersByTime(31_000);
		_processRetryQueue();
		vi.useRealTimers();
		await flushMicrotasks();
		expect(mockFetch).toHaveBeenCalledTimes(2);

		// Retry 2
		vi.useFakeTimers();
		vi.advanceTimersByTime(61_000); // 60s backoff
		_processRetryQueue();
		vi.useRealTimers();
		await flushMicrotasks();
		expect(mockFetch).toHaveBeenCalledTimes(3);

		// Retry 3
		vi.useFakeTimers();
		vi.advanceTimersByTime(121_000); // 120s backoff
		_processRetryQueue();
		vi.useRealTimers();
		await flushMicrotasks();
		expect(mockFetch).toHaveBeenCalledTimes(4);

		// No more retries — entry should be dropped
		vi.useFakeTimers();
		vi.advanceTimersByTime(300_000);
		_processRetryQueue();
		vi.useRealTimers();
		await flushMicrotasks();
		expect(mockFetch).toHaveBeenCalledTimes(4); // No additional calls
	});
});

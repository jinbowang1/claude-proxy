import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config before importing balance module
vi.mock("./config.js", () => ({
	config: {
		domesticApiUrl: "http://billing.test",
		anthropicApiKey: "test-key",
		jwtSecret: "test-secret",
		port: 3001,
	},
}));

// Must import after mock
const balanceModule = await import("./balance.js");
const { checkBalance, invalidateBalanceCache } = balanceModule;

describe("checkBalance", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// Clear internal cache by invalidating + waiting
		// We'll use a workaround: call with a known user, then invalidate
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns ok:true when balance > 0", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 10.5, freeTokens: 0 }),
			}),
		);

		const result = await checkBalance("user-1", "token-1");
		expect(result.ok).toBe(true);
		expect(result.balance).toBe(10.5);
		expect(result.freeTokens).toBe(0);
	});

	it("returns ok:true when freeTokens > 0 but balance = 0", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 0, freeTokens: 300000 }),
			}),
		);

		const result = await checkBalance("user-freeonly", "token-2");
		expect(result.ok).toBe(true);
		expect(result.balance).toBe(0);
		expect(result.freeTokens).toBe(300000);
	});

	it("returns ok:false when both balance and freeTokens are 0", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 0, freeTokens: 0 }),
			}),
		);

		const result = await checkBalance("user-broke", "token-3");
		expect(result.ok).toBe(false);
		expect(result.serviceUnavailable).toBeUndefined();
	});

	it("defaults missing fields to 0", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({}),
			}),
		);

		const result = await checkBalance("user-empty", "token-4");
		expect(result.balance).toBe(0);
		expect(result.freeTokens).toBe(0);
		expect(result.ok).toBe(false);
	});

	it("sends correct Authorization header", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ balance: 1, freeTokens: 0 }),
		});
		vi.stubGlobal("fetch", mockFetch);

		await checkBalance("user-auth", "my-jwt-token");
		expect(mockFetch).toHaveBeenCalledWith("http://billing.test/api/billing/balance", {
			headers: {
				Authorization: "Bearer my-jwt-token",
				"Content-Type": "application/json",
			},
		});
	});

	it("uses fresh cache on second call within TTL", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ balance: 5, freeTokens: 100 }),
		});
		vi.stubGlobal("fetch", mockFetch);

		// First call — hits server
		await checkBalance("user-cache", "token-c");
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Second call — should use cache
		const result = await checkBalance("user-cache", "token-c");
		expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch
		expect(result.ok).toBe(true);
		expect(result.balance).toBe(5);
		expect(result.freeTokens).toBe(100);
	});

	describe("fail-closed behavior", () => {
		it("returns serviceUnavailable on HTTP error with no cache", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					status: 500,
					statusText: "Internal Server Error",
				}),
			);

			const result = await checkBalance("user-nocache-500", "token-5");
			expect(result.ok).toBe(false);
			expect(result.serviceUnavailable).toBe(true);
		});

		it("returns serviceUnavailable on network error with no cache", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
			);

			const result = await checkBalance("user-nocache-net", "token-6");
			expect(result.ok).toBe(false);
			expect(result.serviceUnavailable).toBe(true);
		});

		it("falls back to stale cache within grace period on server error", async () => {
			// First: populate cache
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 20, freeTokens: 500 }),
			});
			vi.stubGlobal("fetch", mockFetch);
			await checkBalance("user-stale", "token-7");

			// Expire the cache by advancing time past TTL but within grace period
			vi.useFakeTimers();
			vi.advanceTimersByTime(3 * 60 * 1000); // 3 minutes (past 2min TTL, within 10min grace)

			// Server goes down
			mockFetch.mockResolvedValue({
				ok: false,
				status: 503,
				statusText: "Service Unavailable",
			});

			const result = await checkBalance("user-stale", "token-7");
			expect(result.ok).toBe(true);
			expect(result.balance).toBe(20);
			expect(result.freeTokens).toBe(500);
			expect(result.serviceUnavailable).toBeUndefined();

			vi.useRealTimers();
		});

		it("rejects when stale cache exceeds grace period", async () => {
			// Populate cache
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 20, freeTokens: 500 }),
			});
			vi.stubGlobal("fetch", mockFetch);
			await checkBalance("user-expired", "token-8");

			// Advance past grace period (10 min)
			vi.useFakeTimers();
			vi.advanceTimersByTime(15 * 60 * 1000); // 15 minutes

			mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

			const result = await checkBalance("user-expired", "token-8");
			expect(result.ok).toBe(false);
			expect(result.serviceUnavailable).toBe(true);

			vi.useRealTimers();
		});
	});

	describe("invalidateBalanceCache", () => {
		it("marks cache as expired but keeps entry for stale fallback", async () => {
			// Populate cache
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 50, freeTokens: 1000 }),
			});
			vi.stubGlobal("fetch", mockFetch);
			await checkBalance("user-inv", "token-9");
			expect(mockFetch).toHaveBeenCalledTimes(1);

			// Invalidate
			invalidateBalanceCache("user-inv");

			// Next call should re-fetch (cache expired)
			await checkBalance("user-inv", "token-9");
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		it("preserves stale cache for fallback after invalidation", async () => {
			// Populate cache
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 30, freeTokens: 200 }),
			});
			vi.stubGlobal("fetch", mockFetch);
			await checkBalance("user-inv-fallback", "token-10");

			// Invalidate
			invalidateBalanceCache("user-inv-fallback");

			// Server goes down
			mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

			// Should still fall back to stale cache (invalidation sets expiry=now, within grace period)
			const result = await checkBalance("user-inv-fallback", "token-10");
			expect(result.ok).toBe(true);
			expect(result.balance).toBe(30);
			expect(result.freeTokens).toBe(200);
		});
	});
});

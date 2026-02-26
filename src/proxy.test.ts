import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

// Mock dependencies
vi.mock("./config.js", () => ({
	config: {
		domesticApiUrl: "http://billing.test",
		anthropicApiKey: "sk-real-anthropic-key",
		jwtSecret: "test-secret",
		port: 3001,
	},
}));

vi.mock("./auth.js", () => ({
	verifyToken: vi.fn(),
}));

vi.mock("./balance.js", () => ({
	checkBalance: vi.fn(),
	invalidateBalanceCache: vi.fn(),
}));

vi.mock("./billing.js", () => ({
	reportUsage: vi.fn(),
}));

const { verifyToken } = await import("./auth.js");
const { checkBalance } = await import("./balance.js");
const { reportUsage } = await import("./billing.js");
const { registerProxyRoute } = await import("./proxy.js");

function createApp() {
	const app = Fastify({ logger: false });
	registerProxyRoute(app);
	return app;
}

/** Helper to create a mock non-streaming Anthropic response */
function mockAnthropicJsonResponse(body: Record<string, unknown>, status = 200) {
	const ok = status >= 200 && status < 300;
	return {
		ok,
		status,
		headers: new Headers({ "content-type": "application/json" }),
		arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(body)).buffer),
		body: null,
	};
}

describe("proxy route /v1/messages", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks(); // Clear call history for ALL mocks
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
		vi.mocked(verifyToken).mockResolvedValue({ userId: "user-1" });
		vi.mocked(checkBalance).mockResolvedValue({ balance: 10, totalAvailable: 0, ok: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("authentication", () => {
		it("returns 401 when x-api-key header is missing", async () => {
			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});
			expect(res.statusCode).toBe(401);
			expect(res.json().error).toBe("Missing x-api-key header");
		});

		it("returns 401 when JWT is invalid", async () => {
			vi.mocked(verifyToken).mockRejectedValue(new Error("Invalid signature"));
			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "bad-token" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});
			expect(res.statusCode).toBe(401);
			expect(res.json().error).toBe("Invalid or expired token");
		});
	});

	describe("balance check", () => {
		it("returns 402 when balance is insufficient", async () => {
			vi.mocked(checkBalance).mockResolvedValue({
				balance: 0,
				totalAvailable: 0,
				ok: false,
			});
			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});
			expect(res.statusCode).toBe(402);
			expect(res.json().error).toBe("Insufficient balance");
		});

		it("returns 503 when billing service is unavailable", async () => {
			vi.mocked(checkBalance).mockResolvedValue({
				balance: 0,
				totalAvailable: 0,
				ok: false,
				serviceUnavailable: true,
			});
			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});
			expect(res.statusCode).toBe(503);
			expect(res.json().error).toBe("Billing service unavailable");
		});

		it("passes when totalAvailable > 0 even if balance = 0", async () => {
			vi.mocked(checkBalance).mockResolvedValue({
				balance: 0,
				totalAvailable: 300000,
				ok: true,
			});
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse({
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 10, output_tokens: 5 },
				}),
			);

			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});
			expect(res.statusCode).toBe(200);
		});
	});

	describe("non-streaming response billing", () => {
		it("extracts usage and reports billing for non-streaming response", async () => {
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse({
					id: "msg_123",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-6",
					content: [{ type: "text", text: "Hello" }],
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 20,
						cache_creation_input_tokens: 10,
					},
				}),
			);

			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "Hi" }] },
			});

			expect(res.statusCode).toBe(200);
			expect(reportUsage).toHaveBeenCalledTimes(1);
			const [token, report] = vi.mocked(reportUsage).mock.calls[0]!;
			expect(token).toBe("valid-jwt");
			expect(report.userId).toBe("user-1");
			expect(report.model).toBe("claude-sonnet-4-6");
			expect(report.inputTokens).toBe(100);
			expect(report.outputTokens).toBe(50);
			expect(report.cost).toBeGreaterThan(0);
		});

		it("does not report billing for error responses", async () => {
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse(
					{ type: "error", error: { type: "invalid_request_error", message: "Bad" } },
					400,
				),
			);

			const app = createApp();
			await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});

			expect(reportUsage).not.toHaveBeenCalled();
		});

		it("does not report billing when usage has zero tokens", async () => {
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse({
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 0, output_tokens: 0 },
				}),
			);

			const app = createApp();
			await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});

			expect(reportUsage).not.toHaveBeenCalled();
		});

		it("still sends response even if usage field is missing", async () => {
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse({
					model: "claude-sonnet-4-6",
					content: [{ type: "text", text: "Hello" }],
				}),
			);

			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});

			expect(res.statusCode).toBe(200);
			expect(res.json().content[0].text).toBe("Hello");
			expect(reportUsage).not.toHaveBeenCalled();
		});

		it("uses response model over request model for billing", async () => {
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse({
					model: "claude-sonnet-4-6-20250514",
					usage: { input_tokens: 100, output_tokens: 50 },
				}),
			);

			const app = createApp();
			await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});

			expect(reportUsage).toHaveBeenCalledTimes(1);
			const [, report] = vi.mocked(reportUsage).mock.calls[0]!;
			expect(report.model).toBe("claude-sonnet-4-6-20250514");
		});

		it("includes cache tokens in cost calculation", async () => {
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse({
					model: "claude-sonnet-4-6",
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_read_input_tokens: 5000,
						cache_creation_input_tokens: 2000,
					},
				}),
			);

			const app = createApp();
			await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});

			expect(reportUsage).toHaveBeenCalledTimes(1);
			const [, report] = vi.mocked(reportUsage).mock.calls[0]!;
			// Sonnet: (1000*3 + 500*15 + 5000*0.3 + 2000*3.75) / 1M
			// = (3000 + 7500 + 1500 + 7500) / 1M = 0.0195
			expect(report.cost).toBeCloseTo(0.0195, 6);
		});
	});

	describe("upstream forwarding", () => {
		it("replaces x-api-key with real Anthropic key", async () => {
			mockFetch.mockResolvedValue(
				mockAnthropicJsonResponse({ model: "m", usage: {} }),
			);

			const app = createApp();
			await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: {
					"x-api-key": "user-jwt",
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});

			const [url, options] = mockFetch.mock.calls[0]!;
			expect(url).toBe("https://api.anthropic.com/v1/messages");
			expect(options.headers["x-api-key"]).toBe("sk-real-anthropic-key");
			expect(options.headers["anthropic-version"]).toBe("2023-06-01");
		});

		it("returns 502 when Anthropic API is unreachable", async () => {
			mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

			const app = createApp();
			const res = await app.inject({
				method: "POST",
				url: "/v1/messages",
				headers: { "x-api-key": "valid-jwt", "content-type": "application/json" },
				payload: { model: "claude-sonnet-4-6", messages: [] },
			});

			expect(res.statusCode).toBe(502);
			expect(res.json().error).toBe("Failed to reach Anthropic API");
		});
	});
});

import { Readable } from "stream";
import type { FastifyInstance } from "fastify";
import { verifyToken } from "./auth.js";
import { checkBalance } from "./balance.js";
import { reportUsage, type UsageReport } from "./billing.js";
import { config } from "./config.js";
import { calculateOpenRouterCostUsd } from "./openrouter-pricing.js";
import { createOpenAIUsageTrackingTransform } from "./openrouter-stream-parser.js";

const OPENROUTER_BASE = "https://openrouter.ai/api";

export function registerOpenRouterRoute(app: FastifyInstance): void {
	app.post("/openrouter/v1/chat/completions", async (request, reply) => {
		// 1. Extract JWT from Authorization header
		const authHeader = request.headers["authorization"];
		let token: string | undefined;
		if (authHeader?.startsWith("Bearer ")) {
			token = authHeader.slice(7);
		}
		// Also support x-api-key for consistency with Claude proxy
		if (!token) {
			const xApiKey = request.headers["x-api-key"];
			if (xApiKey && typeof xApiKey === "string") {
				token = xApiKey;
			}
		}
		if (!token) {
			return reply.status(401).send({ error: "Missing authorization" });
		}

		let jwt: Awaited<ReturnType<typeof verifyToken>>;
		try {
			jwt = await verifyToken(token);
		} catch (err) {
			return reply.status(401).send({
				error: "Invalid or expired token",
				details: err instanceof Error ? err.message : "Unknown error",
			});
		}

		// 2. Check balance (openRouterOk now checks claudeBalance, same as Claude)
		const balanceResult = await checkBalance(jwt.userId, token);
		if (!balanceResult.openRouterOk) {
			if (balanceResult.serviceUnavailable) {
				return reply.status(503).send({ error: "Billing service unavailable" });
			}
			return reply.status(402).send({ error: "Insufficient balance" });
		}

		// Get OpenRouter API key from balance response (managed by domestic server)
		const openrouterKey = balanceResult.openrouterApiKey || config.openrouterApiKey;
		if (!openrouterKey) {
			return reply.status(503).send({ error: "OpenRouter API key not configured" });
		}

		// 3. Extract model from body
		let model = "";
		try {
			const body = request.body as Record<string, unknown>;
			model = (body?.model as string) || "";
		} catch {
			// continue
		}

		// 4. Ensure stream_options.include_usage is set for streaming
		let bodyToForward = request.body as Record<string, unknown>;
		if (bodyToForward?.stream) {
			bodyToForward = {
				...bodyToForward,
				stream_options: {
					...(bodyToForward.stream_options as Record<string, unknown> || {}),
					include_usage: true,
				},
			};
		}

		// 5. Forward to OpenRouter
		let upstreamRes: Response;
		try {
			upstreamRes = await fetch(`${OPENROUTER_BASE}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${openrouterKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://dashixiong.club",
					"X-Title": "DaShiXiong",
				},
				body: JSON.stringify(bodyToForward),
			});
		} catch (err) {
			request.log.error({ err }, "Failed to reach OpenRouter API");
			return reply.status(502).send({ error: "Failed to reach OpenRouter API" });
		}

		// 6. Forward status and response headers
		reply.status(upstreamRes.status);

		const contentType = upstreamRes.headers.get("content-type");
		if (contentType) {
			reply.header("content-type", contentType);
		}

		for (const h of upstreamRes.headers.keys()) {
			if (h.startsWith("x-ratelimit") || h === "x-request-id") {
				const v = upstreamRes.headers.get(h);
				if (v) reply.header(h, v);
			}
		}

		// 7. Non-streaming response
		if (!upstreamRes.body || !contentType?.includes("text/event-stream")) {
			const buf = Buffer.from(await upstreamRes.arrayBuffer());

			if (upstreamRes.ok && contentType?.includes("application/json")) {
				try {
					const json = JSON.parse(buf.toString("utf-8"));
					const usage = json.usage;
					const resolvedModel = json.model || model;
					if (usage && (usage.prompt_tokens > 0 || usage.completion_tokens > 0)) {
						const inputTokens = usage.prompt_tokens || 0;
						const outputTokens = usage.completion_tokens || 0;
						const costUsd = calculateOpenRouterCostUsd(resolvedModel, inputTokens, outputTokens);

						const report: UsageReport = {
							userId: jwt.userId,
							model: resolvedModel,
							inputTokens,
							outputTokens,
							cacheReadTokens: 0,
							cacheCreationTokens: 0,
							cost: costUsd,
							provider: "openrouter",
						};
						request.log.info(
							{ userId: jwt.userId, model: resolvedModel, inputTokens, outputTokens, costUsd: costUsd.toFixed(6) },
							"OpenRouter usage report (non-streaming)",
						);
						reportUsage(token, report);
					}
				} catch {
					request.log.warn("Failed to parse OpenRouter non-streaming response for billing");
				}
			}

			return reply.send(buf);
		}

		// 8. Streaming: pipe through usage-tracking transform
		const { transform, getUsage, getModel } = createOpenAIUsageTrackingTransform();
		const readable = upstreamRes.body.pipeThrough(transform);
		const nodeStream = readableStreamToNodeReadable(readable);

		nodeStream.on("end", () => {
			const usage = getUsage();
			const resolvedModel = getModel() || model;
			const costUsd = calculateOpenRouterCostUsd(resolvedModel, usage.promptTokens, usage.completionTokens);

			if (usage.promptTokens > 0 || usage.completionTokens > 0) {
				const report: UsageReport = {
					userId: jwt.userId,
					model: resolvedModel,
					inputTokens: usage.promptTokens,
					outputTokens: usage.completionTokens,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					cost: costUsd,
					provider: "openrouter",
				};
				request.log.info(
					{ userId: jwt.userId, model: resolvedModel, usage, costUsd: costUsd.toFixed(6) },
					"OpenRouter usage report",
				);
				reportUsage(token, report);
			}
		});

		return reply.send(nodeStream);
	});
}

function readableStreamToNodeReadable(webStream: ReadableStream<Uint8Array>): Readable {
	const reader = webStream.getReader();
	return new Readable({
		async read() {
			try {
				const { done, value } = await reader.read();
				if (done) {
					this.push(null);
				} else {
					this.push(Buffer.from(value));
				}
			} catch (err) {
				this.destroy(err instanceof Error ? err : new Error(String(err)));
			}
		},
	});
}

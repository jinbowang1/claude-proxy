import type { FastifyInstance } from "fastify";
import { verifyToken } from "./auth.js";
import { checkBalance } from "./balance.js";
import { reportUsage, type UsageReport } from "./billing.js";
import { config } from "./config.js";
import { calculateCostUsd } from "./pricing.js";
import { createUsageTrackingTransform } from "./stream-parser.js";

const ANTHROPIC_BASE = "https://api.anthropic.com";

/** Headers to forward from client to Anthropic */
const FORWARD_HEADERS = [
	"anthropic-version",
	"anthropic-beta",
	"content-type",
];

export function registerProxyRoute(app: FastifyInstance): void {
	app.post("/v1/messages", async (request, reply) => {
		// 1. Extract JWT from x-api-key header
		const apiKey = request.headers["x-api-key"];
		if (!apiKey || typeof apiKey !== "string") {
			return reply.status(401).send({ error: "Missing x-api-key header" });
		}

		let jwt: Awaited<ReturnType<typeof verifyToken>>;
		try {
			jwt = await verifyToken(apiKey);
		} catch (err) {
			return reply.status(401).send({
				error: "Invalid or expired token",
				details: err instanceof Error ? err.message : "Unknown error",
			});
		}

		// 2. Check balance
		const { ok: hasBalance } = await checkBalance(jwt.userId, apiKey);
		if (!hasBalance) {
			return reply.status(402).send({ error: "Insufficient balance" });
		}

		// 3. Parse body to extract model (for pricing), but forward raw body
		let model = "";
		try {
			const body = request.body as Record<string, unknown>;
			model = (body?.model as string) || "";
		} catch {
			// If we can't parse, that's fine — Anthropic will validate
		}

		// 4. Build upstream request headers
		const upstreamHeaders: Record<string, string> = {
			"x-api-key": config.anthropicApiKey,
			"content-type": "application/json",
		};
		for (const header of FORWARD_HEADERS) {
			const value = request.headers[header];
			if (value && typeof value === "string") {
				upstreamHeaders[header] = value;
			}
		}

		// 5. Forward to Anthropic
		let upstreamRes: Response;
		try {
			upstreamRes = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
				method: "POST",
				headers: upstreamHeaders,
				body: JSON.stringify(request.body),
			});
		} catch (err) {
			request.log.error({ err }, "Failed to reach Anthropic API");
			return reply.status(502).send({ error: "Failed to reach Anthropic API" });
		}

		// 6. Forward status and response headers
		reply.status(upstreamRes.status);

		const contentType = upstreamRes.headers.get("content-type");
		if (contentType) {
			reply.header("content-type", contentType);
		}

		// Forward rate-limit headers
		for (const h of upstreamRes.headers.keys()) {
			if (h.startsWith("x-ratelimit") || h === "request-id") {
				const v = upstreamRes.headers.get(h);
				if (v) reply.header(h, v);
			}
		}

		// 7. If not streaming or error, pass through directly
		if (!upstreamRes.body || !contentType?.includes("text/event-stream")) {
			const buf = Buffer.from(await upstreamRes.arrayBuffer());
			return reply.send(buf);
		}

		// 8. Streaming: pipe through usage-tracking transform
		const { transform, getUsage, getModel } = createUsageTrackingTransform();
		const readable = upstreamRes.body.pipeThrough(transform);

		// Convert Web ReadableStream to Node.js Readable for Fastify
		const nodeStream = readableStreamToNodeReadable(readable);

		// When stream ends, report usage asynchronously
		nodeStream.on("end", () => {
			const usage = getUsage();
			const resolvedModel = getModel() || model;
			const costUsd = calculateCostUsd(resolvedModel, usage);

			if (usage.inputTokens > 0 || usage.outputTokens > 0) {
				const report: UsageReport = {
					userId: jwt.userId,
					model: resolvedModel,
					usage,
					costUsd,
				};
				request.log.info(
					{ userId: jwt.userId, model: resolvedModel, usage, costUsd: costUsd.toFixed(6) },
					"Usage report",
				);
				reportUsage(apiKey, report);
			}
		});

		return reply.send(nodeStream);
	});
}

/** Convert a Web ReadableStream<Uint8Array> to a Node.js Readable */
function readableStreamToNodeReadable(webStream: ReadableStream<Uint8Array>): import("stream").Readable {
	const { Readable } = require("stream") as typeof import("stream");
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

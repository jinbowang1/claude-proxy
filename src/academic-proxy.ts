import type { FastifyInstance } from "fastify";
import { verifyToken } from "./auth.js";
import { config } from "./config.js";
import { checkBalance } from "./balance.js";

/** Allowed target domains for academic proxy */
const ALLOWED_HOSTS = [
	"scholar.google.com",
	"serpapi.com",
	"api.semanticscholar.org",
	"api.openalex.org",
	"export.arxiv.org",
];

/** Headers to strip from client requests (hop-by-hop, auth, host) */
const STRIP_REQUEST_HEADERS = new Set([
	"host",
	"authorization",
	"connection",
	"transfer-encoding",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"upgrade",
]);

/**
 * Build forwarded request headers.
 * Keeps content-type and other safe headers, strips auth and hop-by-hop.
 */
function forwardHeaders(
	rawHeaders: Record<string, string | string[] | undefined>,
	targetHost: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(rawHeaders)) {
		if (!val || STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
		out[key] = Array.isArray(val) ? val[0] : val;
	}
	out["host"] = targetHost;
	return out;
}

export function registerAcademicProxyRoute(app: FastifyInstance): void {
	// Match /academic/:host/<path>
	app.all("/academic/:host/*", async (request, reply) => {
		// 1. Extract and verify JWT (login check only, no balance deduction)
		const authHeader = request.headers["authorization"];
		if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
			return reply.status(401).send({ error: "Missing or invalid Authorization header" });
		}
		const token = authHeader.slice(7);

		let jwt: Awaited<ReturnType<typeof verifyToken>>;
		try {
			jwt = await verifyToken(token);
		} catch (err) {
			return reply.status(401).send({
				error: "Invalid or expired token",
				details: err instanceof Error ? err.message : "Unknown error",
			});
		}

		// 2. Validate target host
		const host = (request.params as any).host as string;
		if (!ALLOWED_HOSTS.includes(host)) {
			return reply.status(403).send({ error: "Host not allowed", host });
		}

		// 3. Build upstream URL
		const path = (request.params as any)["*"] as string;
		const qs = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
		let targetUrl = `https://${host}/${path}${qs}`;

		// 4. SerpAPI: inject server-managed API key
		if (host === "serpapi.com") {
			// Try to get key from balance cache (same as OpenRouter key flow),
			// fall back to local config
			let serpApiKey = config.serpApiKey;

			// Attempt to get key from domestic server balance cache
			try {
				const balanceResult = await checkBalance(jwt.userId, token);
				if (balanceResult.serpapiKey) {
					serpApiKey = balanceResult.serpapiKey;
				}
			} catch {
				// Ignore — use local fallback
			}

			if (!serpApiKey) {
				return reply.status(503).send({ error: "SerpAPI key not configured" });
			}

			// Inject api_key param
			const url = new URL(targetUrl);
			url.searchParams.set("api_key", serpApiKey);
			targetUrl = url.toString();
		}

		// 5. Forward request to upstream
		const method = request.method;
		const headers = forwardHeaders(
			request.headers as Record<string, string | string[] | undefined>,
			host,
		);

		const fetchOptions: RequestInit = {
			method,
			headers,
		};

		// Forward body for non-GET methods
		if (method !== "GET" && method !== "HEAD" && request.body) {
			if (typeof request.body === "string") {
				fetchOptions.body = request.body;
			} else if (Buffer.isBuffer(request.body)) {
				fetchOptions.body = new Uint8Array(request.body);
			} else {
				fetchOptions.body = JSON.stringify(request.body);
				headers["content-type"] = "application/json";
			}
		}

		try {
			const upstreamRes = await fetch(targetUrl, fetchOptions);

			// 6. Relay response
			reply.status(upstreamRes.status);
			const contentType = upstreamRes.headers.get("content-type");
			if (contentType) {
				reply.header("content-type", contentType);
			}

			const body = Buffer.from(await upstreamRes.arrayBuffer());
			return reply.send(body);
		} catch (err) {
			request.log.error({ err, targetUrl }, "Academic proxy upstream error");
			return reply.status(502).send({
				error: "Failed to reach upstream service",
				details: err instanceof Error ? err.message : "Unknown error",
			});
		}
	});

	app.log.info("Academic proxy route registered: /academic/:host/*");
}

import type { FastifyInstance } from "fastify";
import { verifyToken } from "./auth.js";
import { config } from "./config.js";
import { checkBalance } from "./balance.js";
import * as scholarBrowser from "./scholar-browser.js";

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

/**
 * Verify JWT from Authorization header. Returns userId or sends 401.
 */
async function verifyAuth(request: any, reply: any): Promise<string | null> {
	const authHeader = request.headers["authorization"];
	if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
		reply.status(401).send({ error: "Missing or invalid Authorization header" });
		return null;
	}
	try {
		const jwt = await verifyToken(authHeader.slice(7));
		return jwt.userId;
	} catch (err) {
		reply.status(401).send({
			error: "Invalid or expired token",
			details: err instanceof Error ? err.message : "Unknown error",
		});
		return null;
	}
}

export function registerAcademicProxyRoute(app: FastifyInstance): void {
	// ── Google Scholar Browser API (Playwright, no SerpAPI cost) ──

	app.get("/academic/scholar/search", async (request, reply) => {
		const userId = await verifyAuth(request, reply);
		if (!userId) return;

		const q = request.query as Record<string, string>;
		const query = q.query || q.q || "";
		if (!query) return reply.status(400).send({ error: "Missing query parameter" });

		const limit = Math.min(parseInt(q.limit || "10"), 100);
		const yearFrom = q.year_from ? parseInt(q.year_from) : undefined;
		const yearTo = q.year_to ? parseInt(q.year_to) : undefined;

		try {
			const result = await scholarBrowser.searchPapers(query, limit, yearFrom, yearTo);
			return reply.send(result);
		} catch (err) {
			request.log.error({ err }, "Scholar browser search failed");
			return reply.status(502).send({
				error: "Scholar browser search failed",
				details: err instanceof Error ? err.message : "Unknown",
			});
		}
	});

	app.get("/academic/scholar/author", async (request, reply) => {
		const userId = await verifyAuth(request, reply);
		if (!userId) return;

		const q = request.query as Record<string, string>;
		const name = q.name || q.query || "";
		if (!name) return reply.status(400).send({ error: "Missing name parameter" });

		try {
			const result = await scholarBrowser.searchAuthors(name);
			return reply.send(result);
		} catch (err) {
			request.log.error({ err }, "Scholar browser author search failed");
			return reply.status(502).send({
				error: "Scholar browser author search failed",
				details: err instanceof Error ? err.message : "Unknown",
			});
		}
	});

	app.get("/academic/scholar/author-papers", async (request, reply) => {
		const userId = await verifyAuth(request, reply);
		if (!userId) return;

		const q = request.query as Record<string, string>;
		const userId2 = q.user_id || "";
		if (!userId2) return reply.status(400).send({ error: "Missing user_id parameter" });

		const limit = Math.min(parseInt(q.limit || "100"), 1000);

		try {
			const result = await scholarBrowser.getAuthorPapers(userId2, limit);
			return reply.send(result);
		} catch (err) {
			request.log.error({ err }, "Scholar browser author-papers failed");
			return reply.status(502).send({
				error: "Scholar browser author-papers failed",
				details: err instanceof Error ? err.message : "Unknown",
			});
		}
	});

	app.get("/academic/scholar/status", async (request, reply) => {
		const userId = await verifyAuth(request, reply);
		if (!userId) return;

		const result = await scholarBrowser.checkStatus();
		return reply.send(result);
	});

	// ── Generic academic proxy (fetch-based) ──

	// Match /academic/:host/<path>
	app.all("/academic/:host/*", async (request, reply) => {
		// 1. Verify JWT
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

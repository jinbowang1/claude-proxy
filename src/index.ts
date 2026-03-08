import Fastify from "fastify";
import { config } from "./config.js";
import { registerProxyRoute } from "./proxy.js";
import { registerOpenRouterRoute } from "./openrouter-proxy.js";
import { registerAcademicProxyRoute } from "./academic-proxy.js";

const app = Fastify({
	logger: {
		level: "info",
	},
});

// Health check
app.get("/health", async () => {
	return { status: "ok" };
});

// Main proxy routes
registerProxyRoute(app);
registerOpenRouterRoute(app);
registerAcademicProxyRoute(app);

// Start server
app.listen({ port: config.port, host: "0.0.0.0" }, (err, address) => {
	if (err) {
		app.log.error(err);
		process.exit(1);
	}
	app.log.info(`claude-proxy listening on ${address}`);
});

import "dotenv/config";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export const config = {
	anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
	openrouterApiKey: process.env.OPENROUTER_API_KEY || "",  // Optional fallback; primary key from domestic server
	serpApiKey: process.env.SERPAPI_KEY || "",  // Optional fallback; primary key from domestic server
	jwtSecret: requireEnv("JWT_SECRET"),
	domesticApiUrl: requireEnv("DOMESTIC_API_URL"),
	port: parseInt(process.env.PORT || "3000", 10),
} as const;

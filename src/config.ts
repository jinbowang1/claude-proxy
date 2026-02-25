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
	jwtSecret: requireEnv("JWT_SECRET"),
	domesticApiUrl: requireEnv("DOMESTIC_API_URL"),
	port: parseInt(process.env.PORT || "3000", 10),
} as const;

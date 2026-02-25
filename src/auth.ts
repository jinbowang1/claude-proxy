import * as jose from "jose";
import { config } from "./config.js";

const secret = new TextEncoder().encode(config.jwtSecret);

export interface JwtPayload {
	userId: string;
	[key: string]: unknown;
}

/**
 * Verify a JWT token and extract the userId.
 * Throws if the token is invalid or expired.
 */
export async function verifyToken(token: string): Promise<JwtPayload> {
	const { payload } = await jose.jwtVerify(token, secret);
	const userId = payload.userId ?? payload.sub ?? payload.id;
	if (typeof userId !== "string") {
		throw new Error("JWT missing userId/sub/id claim");
	}
	return { ...payload, userId } as JwtPayload;
}

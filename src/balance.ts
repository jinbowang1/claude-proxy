import { config } from "./config.js";

interface BalanceResult {
	balance: number;
	ok: boolean;
}

/** In-memory cache: userId -> { balance, expiry } */
const cache = new Map<string, { balance: number; expiry: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Check user balance from the domestic billing server.
 * Uses a 2-minute in-memory cache to reduce requests.
 */
export async function checkBalance(userId: string, token: string): Promise<BalanceResult> {
	const now = Date.now();
	const cached = cache.get(userId);
	if (cached && cached.expiry > now) {
		return { balance: cached.balance, ok: cached.balance > 0 };
	}

	try {
		const res = await fetch(`${config.domesticApiUrl}/api/billing/balance`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!res.ok) {
			// If billing server is unreachable, allow request (fail open)
			console.warn(`Balance check failed: ${res.status} ${res.statusText}`);
			return { balance: 0, ok: true };
		}

		const data = (await res.json()) as { balance?: string | number; totalAvailable?: number };
		const balance = data.totalAvailable ?? Number(data.balance) || 0;

		cache.set(userId, { balance, expiry: now + CACHE_TTL_MS });
		return { balance, ok: balance > 0 };
	} catch (err) {
		// Network error — fail open to avoid blocking users
		console.warn("Balance check error:", err);
		return { balance: 0, ok: true };
	}
}

/** Invalidate cache for a user after usage report */
export function invalidateBalanceCache(userId: string): void {
	cache.delete(userId);
}

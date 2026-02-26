import { config } from "./config.js";

interface BalanceResult {
	balance: number;
	freeTokens: number;
	ok: boolean;
	/** true when the billing server could not be reached */
	serviceUnavailable?: boolean;
}

interface CacheEntry {
	balance: number;
	freeTokens: number;
	expiry: number;
}

/** In-memory cache: userId -> { balance, freeTokens, expiry } */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const STALE_CACHE_TTL_MS = 10 * 60 * 1000; // 10-minute grace period for stale cache

/**
 * Check user balance from the domestic billing server.
 * Uses a 2-minute in-memory cache to reduce requests.
 * Fail-closed: rejects requests when billing server is unreachable (unless stale cache exists).
 */
export async function checkBalance(userId: string, token: string): Promise<BalanceResult> {
	const now = Date.now();
	const cached = cache.get(userId);

	// Fresh cache hit
	if (cached && cached.expiry > now) {
		return {
			balance: cached.balance,
			freeTokens: cached.freeTokens,
			ok: cached.balance > 0 || cached.freeTokens > 0,
		};
	}

	try {
		const res = await fetch(`${config.domesticApiUrl}/api/billing/balance`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!res.ok) {
			console.warn(`Balance check failed: ${res.status} ${res.statusText}`);
			return fallbackToStaleCache(userId, cached, now);
		}

		const data = (await res.json()) as { balance?: number; freeTokens?: number };
		const balance = data.balance ?? 0;
		const freeTokens = data.freeTokens ?? 0;

		cache.set(userId, { balance, freeTokens, expiry: now + CACHE_TTL_MS });
		return { balance, freeTokens, ok: balance > 0 || freeTokens > 0 };
	} catch (err) {
		// Network error — fail closed, but allow stale cache within grace period
		console.warn("Balance check error:", err);
		return fallbackToStaleCache(userId, cached, now);
	}
}

/**
 * Fall back to stale cache if within grace period.
 * If no usable cache, reject the request (fail-closed).
 */
function fallbackToStaleCache(
	userId: string,
	cached: CacheEntry | undefined,
	now: number,
): BalanceResult {
	if (cached && cached.expiry > now - STALE_CACHE_TTL_MS) {
		console.warn(`Using stale cache for user ${userId}`);
		return {
			balance: cached.balance,
			freeTokens: cached.freeTokens,
			ok: cached.balance > 0 || cached.freeTokens > 0,
		};
	}
	return { balance: 0, freeTokens: 0, ok: false, serviceUnavailable: true };
}

/** Mark cache as expired for a user after usage report (keeps stale entry for fallback) */
export function invalidateBalanceCache(userId: string): void {
	const entry = cache.get(userId);
	if (entry) {
		entry.expiry = Date.now(); // Mark as just expired; fallbackToStaleCache can still use it within grace period
	}
}

/** Periodically clean up expired cache entries beyond the stale grace period */
setInterval(() => {
	const now = Date.now();
	for (const [key, val] of cache) {
		if (val.expiry < now - STALE_CACHE_TTL_MS) {
			cache.delete(key);
		}
	}
}, 5 * 60 * 1000);

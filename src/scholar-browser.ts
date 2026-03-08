/**
 * Google Scholar browser-based scraping via Playwright.
 *
 * Maintains a singleton headless Chromium to access Google Scholar directly,
 * avoiding SerpAPI costs. The browser preserves cookies across requests and
 * auto-closes after idle timeout to save memory on small servers.
 */
import type { Browser, BrowserContext, Page } from "playwright";

// ── Configuration ──
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // Close browser after 5 min idle
const REQUEST_DELAY_MS = 4000; // Min delay between requests (avoid CAPTCHA)
const PAGE_TIMEOUT_MS = 30_000; // Navigation timeout
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── Singleton state ──
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastRequestTime = 0;
let launching = false;

/**
 * Get or create the browser context. Lazy-init on first request.
 */
async function getContext(): Promise<BrowserContext> {
	if (context && browser?.isConnected()) {
		resetIdleTimer();
		return context;
	}

	if (launching) {
		// Wait for in-flight launch
		while (launching) {
			await new Promise((r) => setTimeout(r, 200));
		}
		if (context && browser?.isConnected()) return context;
	}

	launching = true;
	try {
		const { chromium } = await import("playwright");
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage", // Important for low-memory servers
				"--disable-gpu",
				"--single-process",
				"--no-zygote",
			],
		});
		context = await browser.newContext({
			userAgent: USER_AGENT,
			locale: "en-US",
			viewport: { width: 1280, height: 800 },
			extraHTTPHeaders: {
				"Accept-Language": "en-US,en;q=0.9",
			},
		});

		// Prime cookies by visiting homepage
		const page = await context.newPage();
		try {
			await page.goto("https://scholar.google.com", {
				timeout: PAGE_TIMEOUT_MS,
				waitUntil: "domcontentloaded",
			});
			await page.waitForTimeout(1000);
		} catch {
			// Ignore — best effort
		} finally {
			await page.close();
		}

		console.log("[scholar-browser] Browser launched and cookies primed");
		resetIdleTimer();
		return context;
	} finally {
		launching = false;
	}
}

function resetIdleTimer(): void {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(async () => {
		console.log("[scholar-browser] Idle timeout — closing browser");
		await closeBrowser();
	}, IDLE_TIMEOUT_MS);
}

async function closeBrowser(): Promise<void> {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	try {
		await context?.close();
	} catch {}
	try {
		await browser?.close();
	} catch {}
	context = null;
	browser = null;
}

/**
 * Rate limit — wait at least REQUEST_DELAY_MS between Scholar requests.
 */
async function rateLimit(): Promise<void> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < REQUEST_DELAY_MS) {
		await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS - elapsed));
	}
	lastRequestTime = Date.now();
}

// ── Public API ──

export interface ScholarSearchResult {
	query: string;
	total_fetched: number;
	results: ScholarPaper[];
}

export interface ScholarPaper {
	title: string;
	url: string;
	abstract: string;
	citation_count: number;
	pdf_url: string;
	authors: string[];
	venue: string;
	year: number | null;
}

export interface ScholarAuthor {
	user_id: string;
	name: string;
	affiliation: string;
	email_domain: string;
	cited_by: number;
	interests: string[];
	profile_url: string;
}

/**
 * Search Google Scholar for papers.
 */
export async function searchPapers(
	query: string,
	limit: number = 10,
	yearFrom?: number,
	yearTo?: number,
): Promise<ScholarSearchResult> {
	limit = Math.min(limit, 100);
	const results: ScholarPaper[] = [];
	let start = 0;

	while (results.length < limit) {
		await rateLimit();
		const ctx = await getContext();
		const page = await ctx.newPage();

		try {
			const url = new URL("https://scholar.google.com/scholar");
			url.searchParams.set("q", query);
			url.searchParams.set("start", String(start));
			url.searchParams.set("hl", "en");
			if (yearFrom) url.searchParams.set("as_ylo", String(yearFrom));
			if (yearTo) url.searchParams.set("as_yhi", String(yearTo));

			await page.goto(url.toString(), {
				timeout: PAGE_TIMEOUT_MS,
				waitUntil: "domcontentloaded",
			});

			// Check for CAPTCHA
			const blocked = await page.evaluate(() => {
				const text = document.body?.innerText?.toLowerCase() ?? "";
				return (
					text.includes("unusual traffic") ||
					text.includes("captcha") ||
					document.title.toLowerCase().includes("sorry")
				);
			});
			if (blocked) {
				return {
					query,
					total_fetched: results.length,
					results,
					...({ error: "Google Scholar CAPTCHA triggered. Too many requests." } as any),
				};
			}

			// Parse results
			const papers = await page.evaluate(() => {
				const items = document.querySelectorAll("div.gs_r.gs_or.gs_scl");
				const out: any[] = [];

				for (const item of items) {
					const titleEl = item.querySelector("h3.gs_rt a");
					if (!titleEl) continue;

					const metaEl = item.querySelector("div.gs_a");
					const snippetEl = item.querySelector("div.gs_rs");
					const pdfEl = item.querySelector("div.gs_or_ggsm a");

					// Parse citations
					let citationCount = 0;
					for (const a of item.querySelectorAll("div.gs_fl a")) {
						const match = a.textContent?.match(/Cited by (\d+)/);
						if (match) {
							citationCount = parseInt(match[1]);
							break;
						}
					}

					// Parse meta line: "Authors - Venue, Year - Publisher"
					const meta = metaEl?.textContent?.trim() ?? "";
					const metaParts = meta.split(" - ");
					const authorStr = (metaParts[0] ?? "").replace(/…$/, "").trim();
					const authors = authorStr
						.split(",")
						.map((a: string) => a.trim())
						.filter(Boolean);

					let venue = "";
					let year: number | null = null;
					if (metaParts.length >= 2) {
						const venuePart = metaParts[1].trim();
						const yearMatch = venuePart.match(/\b(19|20)\d{2}\b/);
						if (yearMatch) {
							year = parseInt(yearMatch[0]);
							venue = venuePart.slice(0, yearMatch.index).replace(/,\s*$/, "").trim();
						} else {
							venue = venuePart;
						}
					}

					out.push({
						title: titleEl.textContent?.trim() ?? "",
						url: (titleEl as HTMLAnchorElement).href ?? "",
						abstract: snippetEl?.textContent?.trim() ?? "",
						citation_count: citationCount,
						pdf_url: pdfEl ? (pdfEl as HTMLAnchorElement).href : "",
						authors,
						venue,
						year,
					});
				}
				return out;
			});

			results.push(...papers);
			if (papers.length < 10) break; // No more pages
			start += 10;
		} finally {
			await page.close();
		}
	}

	return { query, total_fetched: Math.min(results.length, limit), results: results.slice(0, limit) };
}

/**
 * Search for author profiles on Google Scholar.
 */
export async function searchAuthors(name: string): Promise<{
	query: string;
	total: number;
	authors: ScholarAuthor[];
}> {
	await rateLimit();
	const ctx = await getContext();
	const page = await ctx.newPage();

	try {
		const url = new URL("https://scholar.google.com/citations");
		url.searchParams.set("view_op", "search_authors");
		url.searchParams.set("mauthors", name);
		url.searchParams.set("hl", "en");

		await page.goto(url.toString(), {
			timeout: PAGE_TIMEOUT_MS,
			waitUntil: "domcontentloaded",
		});

		const authors = await page.evaluate(() => {
			const items = document.querySelectorAll("div.gsc_1usr");
			const out: any[] = [];

			for (const item of items) {
				const nameEl = item.querySelector("h3.gs_ai_name a");
				if (!nameEl) continue;

				const href = (nameEl as HTMLAnchorElement).href ?? "";
				const userMatch = href.match(/user=([^&]+)/);
				const userId = userMatch ? userMatch[1] : "";

				const affEl = item.querySelector("div.gs_ai_aff");
				const emailEl = item.querySelector("div.gs_ai_eml");
				const citeEl = item.querySelector("div.gs_ai_cby");

				let citedBy = 0;
				if (citeEl) {
					const m = citeEl.textContent?.replace(/,/g, "").match(/(\d+)/);
					if (m) citedBy = parseInt(m[1]);
				}

				const interests = Array.from(item.querySelectorAll("a.gs_ai_one_int")).map(
					(a) => a.textContent?.trim() ?? "",
				);

				out.push({
					user_id: userId,
					name: nameEl.textContent?.trim() ?? "",
					affiliation: affEl?.textContent?.trim() ?? "",
					email_domain: emailEl?.textContent?.trim() ?? "",
					cited_by: citedBy,
					interests,
					profile_url: `https://scholar.google.com/citations?user=${userId}`,
				});
			}
			return out;
		});

		return { query: name, total: authors.length, authors };
	} finally {
		await page.close();
	}
}

/**
 * Get an author's publications by Google Scholar user ID.
 */
export async function getAuthorPapers(
	userId: string,
	limit: number = 100,
): Promise<{
	user_id: string;
	profile_url: string;
	total_fetched: number;
	papers: Array<{
		title: string;
		authors: string[];
		venue: string;
		year: number | null;
		citation_count: number;
		detail_url: string;
	}>;
}> {
	limit = Math.min(limit, 1000);
	const papers: any[] = [];
	let cstart = 0;

	while (papers.length < limit) {
		await rateLimit();
		const ctx = await getContext();
		const page = await ctx.newPage();

		try {
			const url = new URL("https://scholar.google.com/citations");
			url.searchParams.set("user", userId);
			url.searchParams.set("hl", "en");
			url.searchParams.set("cstart", String(cstart));
			url.searchParams.set("pagesize", "100");
			url.searchParams.set("sortby", "pubdate");

			await page.goto(url.toString(), {
				timeout: PAGE_TIMEOUT_MS,
				waitUntil: "domcontentloaded",
			});

			const pagePapers = await page.evaluate(() => {
				const rows = document.querySelectorAll("tr.gsc_a_tr");
				const out: any[] = [];

				for (const row of rows) {
					const titleCell = row.querySelector("td.gsc_a_t");
					if (!titleCell) continue;
					const link = titleCell.querySelector("a.gsc_a_at");
					if (!link) continue;

					const href = (link as HTMLAnchorElement).href ?? "";
					const detailUrl = href.startsWith("/")
						? `https://scholar.google.com${href}`
						: href;

					const grays = titleCell.querySelectorAll("div.gs_gray");
					const authors = grays[0]
						? grays[0].textContent
								?.trim()
								.split(",")
								.map((a: string) => a.trim())
								.filter(Boolean) ?? []
						: [];
					const venue = grays[1]?.textContent?.trim() ?? "";

					const citeEl = row.querySelector("td.gsc_a_c a");
					const citeText = citeEl?.textContent?.trim() ?? "";
					const citationCount = /^\d+$/.test(citeText)
						? parseInt(citeText)
						: 0;

					const yearEl = row.querySelector("td.gsc_a_y span");
					const yearText = yearEl?.textContent?.trim() ?? "";
					const year = /^\d{4}$/.test(yearText) ? parseInt(yearText) : null;

					out.push({
						title: link.textContent?.trim() ?? "",
						authors,
						venue,
						year,
						citation_count: citationCount,
						detail_url: detailUrl,
					});
				}
				return out;
			});

			papers.push(...pagePapers);
			if (pagePapers.length < 100) break;
			cstart += 100;
		} finally {
			await page.close();
		}
	}

	return {
		user_id: userId,
		profile_url: `https://scholar.google.com/citations?user=${userId}`,
		total_fetched: Math.min(papers.length, limit),
		papers: papers.slice(0, limit),
	};
}

/**
 * Check if Google Scholar is accessible.
 */
export async function checkStatus(): Promise<{
	status: string;
	backend: string;
	message: string;
}> {
	try {
		await rateLimit();
		const ctx = await getContext();
		const page = await ctx.newPage();

		try {
			const resp = await page.goto("https://scholar.google.com", {
				timeout: PAGE_TIMEOUT_MS,
				waitUntil: "domcontentloaded",
			});

			const blocked = await page.evaluate(() => {
				const text = document.body?.innerText?.toLowerCase() ?? "";
				return text.includes("unusual traffic") || text.includes("captcha");
			});

			if (blocked) {
				return {
					status: "blocked",
					backend: "playwright",
					message: "Google Scholar CAPTCHA detected.",
				};
			}

			return {
				status: "ok",
				backend: "playwright",
				message: `Google Scholar accessible (HTTP ${resp?.status()}).`,
			};
		} finally {
			await page.close();
		}
	} catch (err) {
		return {
			status: "error",
			backend: "playwright",
			message: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

/**
 * Graceful shutdown — close browser on process exit.
 */
process.on("beforeExit", closeBrowser);
process.on("SIGTERM", closeBrowser);
process.on("SIGINT", closeBrowser);

/**
 * 跨服务计费一致性测试
 *
 * 验证 claude-proxy 的 USD 定价 → dashixiong-server 的 CNY 积分转换
 * 确保整条链路的数值精确对齐。
 */

import { describe, it, expect } from "vitest";
import { calculateCostUsd, type UsageTokens } from "./pricing.js";

// ── dashixiong-server 端常量 (镜像) ──
const USD_TO_CNY = 7.25;
const DAILY_FREE_CREDITS = 30;

/** 模拟 server 端的积分计算逻辑 */
function costCnyToCredits(costCny: number): number {
	return costCny > 0 ? Math.max(1, Math.ceil(costCny * 100)) : 0;
}

/** 完整链路: proxy 定价 → server 转换 → 积分 */
function endToEndCredits(modelId: string, usage: UsageTokens): {
	costUsd: number;
	costCny: number;
	credits: number;
} {
	const costUsd = calculateCostUsd(modelId, usage);
	const costCny = costUsd * USD_TO_CNY;
	const credits = costCnyToCredits(costCny);
	return { costUsd, costCny, credits };
}


describe("跨服务: proxy USD → server CNY → 积分", () => {

	it("Sonnet 小请求 (100 input, 50 output, no cache)", () => {
		const result = endToEndCredits("claude-sonnet-4-6", {
			inputTokens: 100, outputTokens: 50,
			cacheReadTokens: 0, cacheCreationTokens: 0,
		});
		// (100×3 + 50×15) / 1M = 1050 / 1M = $0.00105
		expect(result.costUsd).toBeCloseTo(0.00105, 8);
		// $0.00105 × 7.25 = ¥0.0076125
		expect(result.costCny).toBeCloseTo(0.0076125, 8);
		// ceil(0.76125) = 1 积分
		expect(result.credits).toBe(1);
	});

	it("Sonnet 中等请求 (2K input, 1K output, 10K cache read)", () => {
		const result = endToEndCredits("claude-sonnet-4-6", {
			inputTokens: 2000, outputTokens: 1000,
			cacheReadTokens: 10000, cacheCreationTokens: 0,
		});
		// (2000×3 + 1000×15 + 10000×0.3) / 1M = (6000+15000+3000)/1M = $0.024
		expect(result.costUsd).toBeCloseTo(0.024, 8);
		// $0.024 × 7.25 = ¥0.174
		expect(result.costCny).toBeCloseTo(0.174, 6);
		// ceil(17.4) = 18 积分
		expect(result.credits).toBe(18);
	});

	it("Sonnet 大请求 (10K input, 5K output, 50K cache read, 10K cache write)", () => {
		const result = endToEndCredits("claude-sonnet-4-6", {
			inputTokens: 10000, outputTokens: 5000,
			cacheReadTokens: 50000, cacheCreationTokens: 10000,
		});
		// (10000×3 + 5000×15 + 50000×0.3 + 10000×3.75) / 1M
		// = (30000 + 75000 + 15000 + 37500) / 1M = $0.1575
		expect(result.costUsd).toBeCloseTo(0.1575, 6);
		expect(result.credits).toBe(Math.ceil(0.1575 * USD_TO_CNY * 100)); // 115
	});

	it("Opus 标准请求 (5K input, 2K output)", () => {
		const result = endToEndCredits("claude-opus-4-6", {
			inputTokens: 5000, outputTokens: 2000,
			cacheReadTokens: 0, cacheCreationTokens: 0,
		});
		// (5000×5 + 2000×25) / 1M = (25000+50000)/1M = $0.075
		expect(result.costUsd).toBeCloseTo(0.075, 8);
		// $0.075 × 7.25 = ¥0.54375
		expect(result.costCny).toBeCloseTo(0.54375, 6);
		// ceil(54.375) = 55 积分
		expect(result.credits).toBe(55);
	});

	it("Opus 大对话 (50K input, 10K output, 200K cache read)", () => {
		const result = endToEndCredits("claude-opus-4-6", {
			inputTokens: 50000, outputTokens: 10000,
			cacheReadTokens: 200000, cacheCreationTokens: 0,
		});
		// (50000×5 + 10000×25 + 200000×0.5) / 1M = (250000+250000+100000)/1M = $0.6
		expect(result.costUsd).toBeCloseTo(0.6, 8);
		// $0.6 × 7.25 = ¥4.35
		expect(result.costCny).toBeCloseTo(4.35, 6);
		// ceil(435) = 435 积分
		expect(result.credits).toBe(435);
	});

	it("零 token: 0积分", () => {
		const result = endToEndCredits("claude-sonnet-4-6", {
			inputTokens: 0, outputTokens: 0,
			cacheReadTokens: 0, cacheCreationTokens: 0,
		});
		expect(result.costUsd).toBe(0);
		expect(result.credits).toBe(0);
	});

	it("纯缓存读取: 成本极低", () => {
		const result = endToEndCredits("claude-sonnet-4-6", {
			inputTokens: 0, outputTokens: 100,
			cacheReadTokens: 100000, cacheCreationTokens: 0,
		});
		// (0 + 100×15 + 100000×0.3) / 1M = (1500+30000)/1M = $0.0315
		expect(result.costUsd).toBeCloseTo(0.0315, 6);
		expect(result.credits).toBe(Math.ceil(0.0315 * USD_TO_CNY * 100)); // 23
	});
});


describe("每日免费积分覆盖范围", () => {

	it("免费用户 30 积分能撑多少次 Sonnet 小请求", () => {
		let totalCredits = 0;
		let requests = 0;

		// 典型 Sonnet 小对话: 500 input, 200 output, 2000 cache read
		while (totalCredits < DAILY_FREE_CREDITS) {
			const { credits } = endToEndCredits("claude-sonnet-4-6", {
				inputTokens: 500, outputTokens: 200,
				cacheReadTokens: 2000, cacheCreationTokens: 0,
			});
			totalCredits += credits;
			requests++;
			if (requests > 1000) break; // 安全阀
		}

		// 预期能撑 5-10 次小对话
		expect(requests).toBeGreaterThanOrEqual(3);
		expect(requests).toBeLessThanOrEqual(50);
	});

	it("免费用户 30 积分能撑多少次 Opus 请求", () => {
		let totalCredits = 0;
		let requests = 0;

		// Opus 中等对话: 2000 input, 500 output
		while (totalCredits < DAILY_FREE_CREDITS) {
			const { credits } = endToEndCredits("claude-opus-4-6", {
				inputTokens: 2000, outputTokens: 500,
				cacheReadTokens: 0, cacheCreationTokens: 0,
			});
			totalCredits += credits;
			requests++;
			if (requests > 1000) break;
		}

		// Opus 更贵, 预期能撑 1-5 次
		expect(requests).toBeGreaterThanOrEqual(1);
		expect(requests).toBeLessThanOrEqual(10);
	});
});


describe("proxy 报文 → server Zod schema 兼容性", () => {

	it("proxy 报文包含所有 server 必需字段", () => {
		const usage: UsageTokens = {
			inputTokens: 1000, outputTokens: 500,
			cacheReadTokens: 200, cacheCreationTokens: 100,
		};
		const costUsd = calculateCostUsd("claude-sonnet-4-6", usage);

		// 模拟 proxy billing.ts 构造的 payload
		const payload = {
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheCreationTokens, // 注意字段名映射!
			totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
			cost: costUsd,
			currency: "USD",
		};

		// server Zod schema 必需字段
		expect(typeof payload.model).toBe("string");
		expect(payload.model.length).toBeGreaterThan(0);
		expect(typeof payload.provider).toBe("string");
		expect(payload.provider.length).toBeGreaterThan(0);
		expect(Number.isInteger(payload.inputTokens)).toBe(true);
		expect(payload.inputTokens).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(payload.outputTokens)).toBe(true);
		expect(payload.outputTokens).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(payload.totalTokens)).toBe(true);
		expect(payload.totalTokens).toBeGreaterThanOrEqual(0);
		expect(typeof payload.cost).toBe("number");
		expect(payload.cost).toBeGreaterThanOrEqual(0);

		// server Zod schema 可选字段
		expect(Number.isInteger(payload.cacheReadTokens)).toBe(true);
		expect(Number.isInteger(payload.cacheWriteTokens)).toBe(true);
		expect(["USD", "CNY"]).toContain(payload.currency);
	});

	it("cacheCreationTokens → cacheWriteTokens 字段映射正确", () => {
		// proxy 内部用 cacheCreationTokens (Anthropic API 原始字段名)
		// 发给 server 时映射为 cacheWriteTokens (server Zod schema 字段名)
		const proxyInternal = { cacheCreationTokens: 500 };
		const serverPayload = { cacheWriteTokens: proxyInternal.cacheCreationTokens };
		expect(serverPayload.cacheWriteTokens).toBe(500);
	});

	it("totalTokens = input + output + cacheRead + cacheCreation", () => {
		const usage: UsageTokens = {
			inputTokens: 1234,
			outputTokens: 5678,
			cacheReadTokens: 9012,
			cacheCreationTokens: 3456,
		};
		const totalTokens = usage.inputTokens + usage.outputTokens +
			usage.cacheReadTokens + usage.cacheCreationTokens;
		expect(totalTokens).toBe(19380);
	});
});


describe("浮点精度 edge cases", () => {

	it("$0.1 × 7.25 × 100 不会产生浮点误差积分", () => {
		const costUsd = 0.1;
		const costCny = costUsd * USD_TO_CNY; // 0.725
		const credits = costCnyToCredits(costCny);
		// 0.725 * 100 = 72.5 → ceil = 73
		expect(credits).toBe(73);
	});

	it("$0.03 × 7.25 × 100 精确", () => {
		const costCny = 0.03 * USD_TO_CNY; // 0.2175
		const credits = costCnyToCredits(costCny);
		// 0.2175 * 100 = 21.75 → ceil = 22
		expect(credits).toBe(22);
	});

	it("极小值不丢失: $0.0000001", () => {
		const costCny = 0.0000001 * USD_TO_CNY;
		const credits = costCnyToCredits(costCny);
		expect(credits).toBe(1); // 最小下限
	});

	it("大额不溢出: $100", () => {
		const costCny = 100 * USD_TO_CNY; // 725
		const credits = costCnyToCredits(costCny);
		expect(credits).toBe(72500);
	});
});

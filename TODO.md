# Code Review TODO (2026-03-12)

## Critical

- [ ] **代码重复: 抽取公共模块**
  - `readableStreamToNodeReadable` 在 proxy.ts 和 openrouter-proxy.ts 中重复 → 抽到 `stream-utils.ts`
  - JWT 验证逻辑写了 3 遍且不一致（x-api-key / Authorization / 混合） → 统一为 Fastify preHandler hook

- [ ] **scholar-browser.ts 竞态条件**
  - `getContext()` 用 boolean + while 轮询，并发请求可能同时启动浏览器
  - 修复: 用 Promise-based 单例替代 `launching` boolean

- [ ] **学术代理未检查余额**
  - academic-proxy.ts 只验 JWT，不查 balance
  - 零余额用户可无限使用 SerpAPI（按次计费）

- [ ] **SerpAPI key 泄漏到日志**
  - academic-proxy.ts:239 出错时 targetUrl 含 api_key 被直接 log
  - 修复: log 前 strip 敏感 query 参数

## High

- [ ] **parseInt 无 NaN 检查** — academic-proxy.ts:78,122 `parseInt("abc")` → NaN 导致搜索返回空
- [ ] **stream 无 error handler** — proxy.ts:150, openrouter-proxy.ts:153 只监听 `end` 不监听 `error`
- [ ] **错误详情暴露给客户端** — 多处返回 `err.message`，泄漏实现细节

## Medium

- [ ] **硬编码定价** — pricing.ts / openrouter-pricing.ts 模型少，未知模型按默认价计费可能差很远
- [ ] **Playwright 太重** — 生产依赖 400MB+，Scholar 爬虫应拆独立服务或进程
- [ ] **无上游请求超时** — fetch() 无 AbortSignal.timeout，挂起的上游连接永不释放
- [ ] **无优雅关闭** — index.ts 无 graceful shutdown，scholar-browser 的 beforeExit 不 await async
- [ ] **console.log 与 pino 混用** — balance.ts/billing.ts 用 console.*，proxy.ts 用 request.log

## Low

- [ ] **新增 5 文件零测试** — openrouter-proxy/pricing/stream-parser, academic-proxy, scholar-browser
- [ ] **`any` 类型泛滥** — academic-proxy.ts 的 verifyAuth、scholar-browser.ts 的 page.evaluate
- [ ] **魔法数字** — 100, 1000, 10 等应抽为命名常量
- [ ] **balance.ts 注释过期** — 说 "freeTokens" 实际字段是 "claudeBalance"

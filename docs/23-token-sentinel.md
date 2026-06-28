# Token Sentinel — Single-Writer Copilot Token Refresh

> 状态：Design — 待实施
> 范围：`packages/proxy/src/lib/token.ts`, `packages/proxy/src/lib/utils.ts` (cacheModels), 全部 Copilot upstream client
> 关键属性：**单写者** + **single-flight** + **请求路径等待 + 单次重试**

---

## 1. 背景与问题

Raven 代理依赖 `state.copilotToken` 这把 JWT 向 GitHub Copilot 上游发起请求。当前刷新机制是 `scheduleTokenRefresh`：以 `refresh_in - 60s` 为周期定时拉新 token，失败则指数退避。

这套机制有一个无法靠调参消除的缺口：

- 上游 JWT 真实失效时间 vs. 调度 tick 时间，不可能完全对齐。
- LLM 请求是用户驱动、并发、流式、长耗时的——任意请求恰好落在"JWT 已失效、scheduled tick 未到"的窗口内,就会以 401 返回。
- 这类 401 的 body 通常包含 `token expired` / `IDE token expired` 等措辞，对客户端而言是"上游瞬时不可用"，但底层完全可恢复。

把"刷新 + 重试"直接塞进每个 LLM upstream client 是一种朴素做法，但会引入：

- 多个并发请求竞争同一把刷新 → 需要 single-flight 保护。
- 用 response body 文案当唯一判据 → 上游措辞变动时静默失效。
- 刷新职责散落在每个 client → 新增 client 时容易漏。
- LLM 热路径承载运维复杂度 → 不符合单一职责。

本文档定义另一种结构：**把"刷 token"收敛到唯一执行者（哨兵），LLM 路径只 await 哨兵的结果、不写 token、最多重试一次**。这样同时拿到两件事：

1. **架构层免疫并发写问题**（单写者 + single-flight）。
2. **用户无感恢复**（请求路径主动等哨兵结果再重试一次）。

---

## 2. 设计目标

1. **单写者**：`state.copilotToken` 在整个进程生命周期内，只由哨兵模块写入。LLM 路径 grep-verifiable 不写。
2. **架构层免疫并发**：所有刷新尝试（无论来自哨兵 tick 还是 LLM 路径上报）共享同一个 in-flight Promise；同一时刻最多一次 `getCopilotToken()` 在飞。
3. **可恢复 401 用户无感**：LLM 撞到 token-expired 401 时 → await 哨兵刷新 → 用新 token 重试一次 → 成功则用户完全无感。
4. **判据稳健**：是否 await 哨兵由"401 文案命中 token-expired"决定；刷新结果由"哨兵闭环 `/models` 验证"决定。两层判据互不依赖。
5. **侵入最小**：LLM upstream client 只多两件事——上报信号 + 401 时调用 `sentinel.refreshNow()` 并单次重试。

---

## 3. 名词表

| 术语 | 含义 |
|---|---|
| **Sentinel（哨兵）** | 周期性向 Copilot `/models` 发起请求的后台 loop，同时是 `state.copilotToken` 的唯一写者。 |
| **`refreshNow()`** | 哨兵暴露的 single-flight 刷新入口。多个调用方共享同一个 in-flight Promise。 |
| **STEADY** | 哨兵稳态周期，间隔 = `refresh_in - 60s`。 |
| **PROBING** | 哨兵短周期（默认 5s × 3 tick），由信号评分跨阈值触发，用于密集探活。 |
| **Signal（信号）** | LLM 路径上报的"我刚撞到 401"事件。仅用于决定 PROBING 频率档，**不决定是否刷新**。 |
| **Refresh** | 调用 `getCopilotToken()` → 写 `state.copilotToken`。**只有哨兵执行**。 |

---

## 4. 总体架构

```
                 ┌────────────────────────────────────────────────┐
                 │                Sentinel (token-sentinel.ts)    │
                 │                                                │
                 │   tick loop (setTimeout 链):                   │
                 │     cacheModels() / 401 → refreshNow()         │
                 │     signal.decay()                             │
                 │     根据评分选 STEADY / PROBING 间隔            │
                 │                                                │
                 │   refreshNow(reason) — single-flight:          │
                 │     module-level inflight: Promise | null      │
                 │     ─ 多个并发调用复用同一个 Promise            │
                 │     ─ 完成后清空                                │
                 │     ─ 失败用指数退避，但调用方拿到结果即可决策   │
                 └──────────────┬─────────────────────────────────┘
                                │ writes
                                ▼
                 ┌────────────────────────────────────────────────┐
                 │              state.copilotToken                │
                 │              (single writer, many readers)     │
                 └────────────────────▲───────────────────────────┘
                                      │ reads
                                      │
        ┌─────────────────────────────┴─────────────────────────────┐
        │     Copilot upstream clients (openai/native/responses/    │
        │     embeddings)                                            │
        │                                                            │
        │     401 path:                                              │
        │       1. tokenSignal.reportAuthFailure(...)                │
        │       2. body 命中 token-expired 时:                       │
        │            await sentinel.refreshNow("llm-401")           │
        │            tokenWasUpdated → callOnce() 重试一次            │
        │       3. 重试仍失败 / 非 token-expired → 抛 HTTPError      │
        │                                                            │
        │     不做: getCopilotToken / 写 state / 循环重试            │
        └────────────────────────────────────────────────────────────┘
```

---

## 5. 不变量

| ID | 不变量 | 验证方式 |
|---|---|---|
| **I-1** | `state.copilotToken` 写入点只在 `token-sentinel.ts` 内 | grep `state.copilotToken\s*=` |
| **I-2** | 同一时刻最多一个 `getCopilotToken()` 调用在飞 | `inflight: Promise \| null` 单点 + 单测 |
| **I-3** | LLM 路径不调用 `getCopilotToken`、不写 `state.copilotToken` | grep `state.copilotToken\s*=` + import 验证 |
| **I-4** | 哨兵 loop 任何抛错都被 catch，必然调度下一次 tick | 单测注入抛异常的 fetch mock |
| **I-5** | 每个 LLM 请求最多发起 2 次上游 fetch（首次 + 重试） | 代码层显式计数 + 单测 |

---

## 6. 哨兵状态机

```
                ┌─────────────────────────────────────────┐
                │              STEADY                     │
                │   tick = refresh_in - 60s               │
                │   行为:                                  │
                │     ─ cacheModels()                     │
                │     ─ 401 → refreshNow("sentinel-401") │
                │     ─ tokenSignal.decay()               │
                └─────┬──────────────────────────────┬────┘
                      │                              │
       score >= TH    │                              │ score < TH
                      ▼                              ▲
                ┌──────────────────────────────────┐ │
                │            PROBING               │ │
                │   tick = 5s, 最多 N (=3) tick   │ │
                │   行为同 STEADY,                  │ │
                │   N tick 内 score 未再次跨阈     │─┘
                │   则回 STEADY                    │
                └──────────────────────────────────┘

  refreshNow() 不是显式 state — 它是 module-level inflight Promise，
  与 tick 调度并行，由 single-flight 保证唯一性。
```

**简化要点**：v1 设计里把 REFRESHING 列为显式状态，v2 删除——刷新本质是一个 in-flight Promise，与 tick 节奏独立。状态机退化到两态，复杂度更低。

---

## 7. `refreshNow()` 契约（关键）

```ts
// packages/proxy/src/lib/token-sentinel.ts

export type RefreshReason = "llm-401" | "sentinel-401" | "scheduled" | "manual"

export type RefreshResult =
  | { ok: true;  tokenWasUpdated: boolean }   // 包含 "刷新成功但 token 字面没变" 的 case
  | { ok: false; error: unknown }

let inflight: Promise<RefreshResult> | null = null
let lastSuccessAt = 0

export async function refreshNow(reason: RefreshReason): Promise<RefreshResult> {
  // ── 1. single-flight：所有并发调用共享同一个 Promise ──
  if (inflight) return inflight

  // ── 2. min interval 兜底：成功刷新后 N 秒内不重复刷 ──
  const sinceLast = Date.now() - lastSuccessAt
  if (sinceLast < MIN_REFRESH_INTERVAL_MS && lastSuccessAt > 0) {
    return { ok: true, tokenWasUpdated: false }
  }

  inflight = (async () => {
    try {
      const oldToken = state.copilotToken
      const { token } = await getCopilotToken()
      state.copilotToken = token       // I-1 的唯一写入点
      lastSuccessAt = Date.now()
      return { ok: true, tokenWasUpdated: token !== oldToken }
    } catch (error) {
      logger.error("refreshNow failed", { reason, error: String(error) })
      return { ok: false, error }
    } finally {
      inflight = null
    }
  })()

  return inflight
}
```

**关键设计**：

- `tokenWasUpdated` 字段让 LLM 路径精确判断"是否值得重试"——如果哨兵告知刷新成功但 token 字面没变（min-interval 命中 / 上游返回同一把），就别白白重试。
- `MIN_REFRESH_INTERVAL_MS` = 30s 是兜底：即使评分异常或 LLM 路径异常多次触发，也不会让上游被狂打。**这条与 single-flight 是正交保护**。
- `inflight` 在 `finally` 里清空，保证下一次失败也能正常发起新的刷新。

---

## 8. 信号通道契约（v2 缩小到"频率档调节"）

```ts
// packages/proxy/src/lib/token-signal.ts

export type AuthFailureReason = "token-expired" | "other-401"

export interface TokenSignal {
  reportAuthFailure(reason: AuthFailureReason): void
  shouldProbeNow(): boolean
  decay(): void
  readScore(): number
}
```

**实现要点**：

- `reportAuthFailure("token-expired")` → `score += 3`
- `reportAuthFailure("other-401")` → `score += 1`
- `shouldProbeNow()` → `score >= 5`
- `decay()` → `score = max(0, score - 1)`，每个哨兵 tick 调用一次。
- `readScore()` 仅用于测试断言与 dashboard 指标暴露。

**职责边界（v2 严格）**：

- 信号 **只决定 PROBING 频率档**，不决定是否刷新。
- 单次 token-expired 401 的刷新触发**不依赖信号阈值**——由 LLM 路径直接调用 `refreshNow()` 完成。
- 这避免了 v1 设计的硬伤：单次 401 评分 3 < 阈值 5，永远触发不了刷新加速。v2 把"是否刷新"和"是否提高 tick 频率"彻底拆开。

---

## 9. LLM 路径行为（核心改动）

所有 Copilot upstream client（openai / native / responses / embeddings）的 401 处理统一为：

```ts
async function callOnce(): Promise<Response> {
  // 每次调用都重新读 headers，确保拿到最新的 Authorization
  const headers = buildHeaders(this.config.getHeaders())
  return fetch(url, {
    method: "POST",
    headers,
    body,
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  } as RequestInit)
}

let response = await callOnce()

if (response.status === 401) {
  const body = await response.text().catch(() => "")
  const tokenExpired = isTokenExpiredBody(401, body)
  tokenSignal.reportAuthFailure(tokenExpired ? "token-expired" : "other-401")

  if (tokenExpired) {
    const result = await sentinel.refreshNow("llm-401")
    if (result.ok && result.tokenWasUpdated) {
      response = await callOnce()   // I-5: 至多重试一次
    }
    // refresh 失败 / token 没变 / 重试仍非 2xx → 走原错误路径
  } else {
    throw new HTTPError(errorMessage, 401, body)
  }
}

if (!response.ok) {
  throw await HTTPError.fromResponse(errorMessage, response)
}

return response
```

**严格做且只做**：

1. ✅ 上报信号（不区分文案命中与否）
2. ✅ 文案命中 token-expired 时 `await refreshNow()`
3. ✅ 若 `tokenWasUpdated` 为真，**最多一次**重试
4. ❌ 不调用 `getCopilotToken()`（违反 I-3）
5. ❌ 不写 `state.copilotToken`（违反 I-1）
6. ❌ 不循环重试、不嵌套 `refreshNow`（违反 I-5）

**关于"为什么 other-401 不触发 refreshNow"**：

- other-401 可能是 API key 错、scope 错、IP 被封——刷 token 没用。
- 文案命中 token-expired 是已知可恢复信号，触发刷新代价低。
- 误判风险：上游措辞变动导致 token-expired 被识别为 other-401 → 退化到 v1 体验（用户看见 401）。但此时哨兵的 `/models` tick 仍会发现并刷新，下次请求恢复。**不是优雅的零漏出，是有底线的优雅降级**。

---

## 10. 哨兵主循环（与 §7 结合）

```ts
// packages/proxy/src/lib/token-sentinel.ts (草案)

interface SentinelState {
  mode: "steady" | "probing"
  remainingProbeTicks: number
  steadyIntervalMs: number
}

async function sentinelTick(s: SentinelState, timers: TimerFactory) {
  try {
    tokenSignal.decay()

    try {
      await cacheModels()
    } catch (e) {
      if (isAuthError(e)) {
        const result = await refreshNow("sentinel-401")
        if (result.ok) {
          // 闭环验证：刷新后立即重发一次 /models
          try { await cacheModels() } catch { /* 留给下一 tick */ }
        }
      } else {
        logger.warn("sentinel /models failed (non-auth)", { error: String(e) })
      }
    }

    scheduleNext(s, timers)
  } catch (fatal) {
    // I-4: 任何意外异常都不让 loop 死
    logger.error("sentinel tick fatal", { error: String(fatal) })
    timers.setTimeout(() => sentinelTick(s, timers), s.steadyIntervalMs)
  }
}

function scheduleNext(s: SentinelState, timers: TimerFactory) {
  const wantsProbe = tokenSignal.shouldProbeNow()

  if (wantsProbe && s.mode !== "probing") {
    s.mode = "probing"
    s.remainingProbeTicks = PROBE_TICKS
  } else if (s.mode === "probing") {
    s.remainingProbeTicks -= 1
    if (s.remainingProbeTicks <= 0 && !wantsProbe) {
      s.mode = "steady"
    }
  }

  const nextMs = s.mode === "probing" ? PROBE_INTERVAL_MS : s.steadyIntervalMs
  timers.setTimeout(() => sentinelTick(s, timers), nextMs)
}

export function startTokenSentinel(opts: { steadyIntervalMs: number; timers?: TimerFactory }) {
  const s: SentinelState = {
    mode: "steady",
    remainingProbeTicks: 0,
    steadyIntervalMs: opts.steadyIntervalMs,
  }
  const timers = opts.timers ?? defaultTimers
  timers.setTimeout(() => sentinelTick(s, timers), s.steadyIntervalMs)
  return { stop: () => { /* clearTimeout 的句柄管理 */ } }
}
```

**设计要点**：

- **setTimeout 链而非 setInterval**：每个 tick 完整结束才安排下一次，从根本上杜绝重入。
- **闭环验证**：refresh 后立即重发 `/models`，避免"看起来 refresh 成功但 token 实际不可用"。
- **fatal try/catch 双层**：即使 `scheduleNext` 抛异常（不应该发生）也要保证下一次 tick 被安排。

---

## 11. 启动与生命周期

```
proxy startup:
  1. setupGitHubToken()                      ── 现有
  2. setupCopilotToken()                     ── 现有，拿到第一把 JWT + refresh_in
     不再调用 scheduleTokenRefresh
  3. startTokenSentinel({ steadyIntervalMs: (refresh_in - 60) * 1000 })   ── 新增
  4. 其余 cache* 初始化                       ── 现有
```

**关停**：进程退出时调用 `stop()`，`clearTimeout` 下一个待发 tick。无显式 shutdown 协议（与现有 systemd / dev 流程一致）。

---

## 12. 失败与边界

| 场景 | 哨兵行为 | LLM 路径行为 | 用户感知 |
|---|---|---|---|
| `/models` 上游瞬时 5xx | 当前 tick 标记失败 | 不受影响 | 无 |
| `/models` 返回 401 | refreshNow → 闭环验证 | 不受影响 | 无 |
| 单次 LLM 401 + token-expired 文案 | 接收信号；in-flight refresh 复用 | await + 重试一次 | 无（无感） |
| 并发 N 个 LLM 401 + token-expired | 收到 N 条信号；refresh 只跑 1 次 | 全部 await 同一个 Promise → 各自重试 | 无（无感） |
| LLM 401 但文案不命中 token-expired | 接收信号（other-401，权重 1） | 直接抛 401 | 用户看见 401；后续请求由哨兵 tick 兜底 |
| `refreshNow` 失败（网络不通） | 当前 in-flight reject；下次自然重试 | 不重试，原 401 抛出 | 用户看见 401 |
| `refreshNow` 成功但 token 字面没变 | 返回 `tokenWasUpdated=false` | 不重试 | 用户看见 401（防止白重试） |
| LLM 重试仍 401 | 不二次触发 refresh（I-5） | 抛出重试响应的 HTTPError | 用户看见 401 |
| 哨兵 tick 抛任意异常 | 双层 catch，下一 tick 仍被调度（I-4） | 不受影响 | 无 |
| 进程刚启动尚未跑过哨兵 | 第一次 tick 在 `steadyIntervalMs` 后触发 | 使用 setupCopilotToken 的初始 JWT | 与现状一致 |

---

## 13. 与 anti-ban 的兼容性

`CLAUDE.md` 的 anti-ban 协议核心是"不要无节制敲上游"。本方案严格更优：

1. **刷新次数三重保护**：(1) single-flight 让并发请求只能触发一次；(2) `MIN_REFRESH_INTERVAL_MS` 让短时间内重复触发只跑一次；(3) 失败时不立即重试，下一次 tick 才再试。
2. **PROBING 流量可量化**：`PROBE_INTERVAL_MS = 5s`、`PROBE_TICKS = 3`，最坏情况 15 秒内最多 3 次 `/models`。比"每个 LLM 请求自带 retry"低一个数量级。
3. **哨兵成功 = 健康证据**：每次 `/models` 200 都证明 token 健康，可作为推迟"下一次主动 refresh"的依据（阶段 4 可选优化）。

**实施前必须验证**：PROBING 期间连续 3 次 `/models` 调用不会触发 GitHub 侧 abuse detection。开发阶段先以保守参数（`PROBE_INTERVAL_MS = 8s`、`PROBE_TICKS = 2`）跑一周观测。

---

## 14. 实施分阶段

**阶段 1 — 哨兵骨架（独立 PR）**

- 新增 `packages/proxy/src/lib/token-sentinel.ts`，包含 `refreshNow()` + tick loop（STEADY 状态机，PROBING 留空骨架）。
- 删除 `scheduleTokenRefresh` / `retryTokenRefresh`，`setupCopilotToken` 改调 `startTokenSentinel`。
- LLM 路径完全不动。
- 单测：fake timers + mocked fetch，验证 STEADY 周期、refresh-on-401、单 flight、min-interval、I-4 不死锁。
- **本阶段不解决用户体验问题**，只解决并发与单写者问题。可独立合入。

**阶段 2 — 等待 + 重试 + 信号（独立 PR，恢复 PR #129 的用户体验目标）**

- 新增 `packages/proxy/src/lib/token-signal.ts`。
- 四个 upstream client 加 401 → `await sentinel.refreshNow("llm-401")` + 单次重试。
- 哨兵接入 `tokenSignal.shouldProbeNow()` → PROBING 周期切换。
- 单测：信号累积、衰减、阈值边界；LLM 客户端 401 重试矩阵（文案命中/不命中 × 刷新成功/失败 × tokenWasUpdated true/false × 重试 ok/fail）。
- 集测（L2）：并发 N 个 LLM 401 → 上游 `/copilot_internal/v2/token` 只被调用 1 次。
- **本阶段完整覆盖 PR #129 的体验目标**。

**阶段 3 — 可观察性 + 关停**

- 哨兵 mode、score、最后成功 refresh 时间通过现有 logger 输出 + dashboard 暴露。
- 进程退出 graceful shutdown（清理 in-flight refresh + 取消 tick）。

**阶段 4（可选）— 主调度推迟优化**

- 哨兵 STEADY tick 的 `/models` 200 → 推迟下一次主动 refresh 时间。
- 仅在生产数据证实有显著刷新过剩时实施。

---

## 15. 测试策略

### 单元测试

**`token-signal.test.ts`**：
- 初始 score = 0
- token-expired 加 3、other-401 加 1
- decay 单调递减且不破 0
- shouldProbeNow 在阈值边界正确

**`token-sentinel.test.ts`**：注入 `TimerFactory` + mock `getCopilotToken` + mock `getModels`。
- STEADY tick 周期 = refresh_in - 60s
- /models 401 → refreshNow → 闭环 /models
- /models 5xx → 不刷新、tick 继续
- 信号触发 PROBING → 周期切到 PROBE_INTERVAL_MS
- PROBING N tick 内无新信号 → 回 STEADY
- 任意 tick 内部异常 → 下一 tick 仍被调度（I-4）
- **`refreshNow` single-flight**：并发 N 次调用 → `getCopilotToken` 被调用 1 次，所有调用方拿到同一结果
- **`refreshNow` min-interval**：连续两次调用 → 第二次返回 `tokenWasUpdated=false`
- **`refreshNow` 失败 → inflight 被清空**：失败后下一次调用能正常发起新刷新

**`copilot-{openai,native,responses,embeddings}.test.ts`**：每个 client 覆盖完整 401 矩阵。
- 2xx → 不上报信号、不调用 refreshNow
- 401 + 非 token-expired 文案 → 上报 other-401、不调 refreshNow、抛原 401
- 401 + token-expired 文案 + refresh 成功 + tokenWasUpdated=true + 重试 2xx → 返回重试响应
- 401 + token-expired + refresh 成功 + tokenWasUpdated=false → 不重试、抛原 401
- 401 + token-expired + refresh 失败 → 不重试、抛原 401
- 401 + token-expired + 重试仍 401 → 抛重试响应的 HTTPError、**不再次触发 refresh**（I-5）
- 所有 401 路径验证：**不调用 `getCopilotToken`、不写 `state.copilotToken`**（I-1, I-3）

### 集成测试（L2）

- `/models` 哨兵 → `state.copilotToken` 自动刷新（端到端用真实凭据，需手动）。
- 并发 N 个 LLM 请求同时撞 401（mock 上游），断言：
  - 只有 1 次 `/copilot_internal/v2/token` 被调用
  - 所有 LLM 请求都用新 token 重试成功
  - `state.copilotToken` 最终为新值

### 不再需要的测试

- "on-demand refresh + retry 的所有矩阵组合"——契约不存在了，由 `refreshNow` 集中保证。
- "single-flight 并发去重"——单写者结构 + module-level inflight 让它自动成立。

---

## 16. 删除与替换清单

实施后**移除**：

- `scheduleTokenRefresh` / `retryTokenRefresh`（功能被哨兵覆盖）
- `refreshModelsForToken`（其 cacheModels 调用被哨兵 tick 内联覆盖）
- 任何在 LLM upstream client 里的"wrap fetch + 自己刷 token"逻辑（如果届时已存在）

**保留**：

- `setupCopilotToken` 的"首次拿 token + 取得初始 refresh_in"职责
- `cacheModels` 实现本身（被哨兵和路由路径共享）
- `getCopilotToken` 服务（被哨兵唯一调用）

---

## 17. 默认参数（待生产数据校准）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `STEADY_INTERVAL_MS` | `(refresh_in - 60) * 1000` | 与历史调度一致 |
| `PROBE_INTERVAL_MS` | `5_000` | PROBING tick 间隔 |
| `PROBE_TICKS` | `3` | PROBING 持续 tick 数 |
| `SIGNAL_THRESHOLD` | `5` | shouldProbeNow 阈值；只控制 PROBING，不控制刷新 |
| `SIGNAL_TOKEN_EXPIRED_WEIGHT` | `3` | token-expired 信号权重 |
| `SIGNAL_OTHER_401_WEIGHT` | `1` | other-401 信号权重 |
| `MIN_REFRESH_INTERVAL_MS` | `30_000` | 距上次成功 refresh N 秒内不重复刷（兜底） |
| `REFRESH_INITIAL_BACKOFF_MS` | `5_000` | 与现有 retryTokenRefresh 一致 |
| `REFRESH_MAX_BACKOFF_MS` | `5 * 60_000` | 与现有一致 |
| `MIN_REFRESH_MS` | `30_000` | 与现有 STEADY 间隔下限一致 |

---

## 18. 设计取舍小结

| 维度 | 选择 | 原因 |
|---|---|---|
| 刷新者数量 | **1（哨兵）** | I-1；架构层免疫并发问题 |
| LLM 401 重试 | **await + 重试 1 次** | 恢复 PR #129 的用户体验目标 |
| 重试触发判据 | **body 文案 token-expired** | 廉价、明确；误判时由哨兵 tick 兜底 |
| 刷新结果判据 | **`refreshNow` 返回的 tokenWasUpdated** | 避免用同一把死 token 重试 |
| 信号通道作用 | **仅决定 PROBING 频率档** | 与刷新决策完全解耦，修复 v1 评分硬伤 |
| 调度容器 | **setTimeout 链** | 杜绝 setInterval 重入；与单写者契合 |
| 模型缓存刷新 | **由哨兵 tick 自然完成** | 删掉 `refreshModelsForToken` 分支 |
| 重试上限 | **代码层硬编码 1 次** | I-5 显式保证，不依赖运气 |

---

## 19. 验收标准

- [ ] `state.copilotToken` 的所有写入点（grep 验证）只在 `token-sentinel.ts` 内（I-1）
- [ ] LLM upstream client 不导入 `getCopilotToken` 或 `state.copilotToken` 的写入接口（I-3）
- [ ] 单测覆盖 §15 列出的全部场景，包括 single-flight、min-interval、I-4、I-5
- [ ] L2 集成测试（并发 401）显示只有 1 次 `getCopilotToken` 调用，所有 LLM 请求都被无感恢复
- [ ] 生产观测一周：401 漏出率与刷新调用频次符合预期上限
- [ ] `docs/README.md` 增加本文档索引

---

## 20. 与原 PR #129 的关系

PR #129 的"on-demand refresh + retry"在阶段 2 完成时被完整覆盖，且严格更优：

| PR #129 想做 | 本方案 |
|---|---|
| recoverable 401 不漏给 agent | ✅ 阶段 2 完整覆盖（await + 单次重试） |
| 并发请求不重复打刷新接口 | ✅ I-2 single-flight；比 PR #129 的散点 fix 更彻底 |
| token-expired 文案识别脆弱 | ✅ 文案仅作"是否 await refresh"的开关；`/models` 闭环验证兜底 |
| LLM 路径侵入 | 平手（PR #129 wrap fetch，本方案 wrap response handler） |

**操作**：阶段 1 合入后即可 close PR #129；阶段 2 合入后完整恢复其用户体验目标，无功能退化。

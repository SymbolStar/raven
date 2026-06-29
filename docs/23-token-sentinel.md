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
4. **判据稳健**：是否 await 哨兵由"401 文案命中 token-expired"决定；刷新结果以 `getCopilotToken()` 本身返回为准，由哨兵下一次 tick 的 `/models` 调用做**后置**验证；LLM 重试本身也是一次实际验证。两层判据互不依赖、互不阻塞。
5. **侵入最小**：LLM upstream client 只多两件事——上报信号 + 401 时调用 `sentinel.refreshNow()` 并单次重试。
6. **正确处理并发尾部请求**：caller 把"本次请求使用的 token"传给 `refreshNow()`；如果它和当前缓存值已经不同，立刻判定"已被他人刷新"，无需再次访问上游也能让 caller 重试。

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
| **I-1** | `state.copilotToken` 写入点只在 `token-sentinel.ts` 内（**初次启动经由 `setupCopilotToken()` → `sentinel.bootstrap({ token, refreshInSeconds, timers })` 间接写入也算在内**） | `rg --glob 'packages/proxy/src/**' 'state\.copilotToken\s*='`，唯一文件应为 `lib/token-sentinel.ts`（验收范围限定在 `packages/proxy/src/`，排除 `test/` 与 mock 文件） |
| **I-2** | 同一时刻最多一个 `getCopilotToken()` 调用在飞 | `inflight: Promise \| null` 单点 + 单测 |
| **I-3** | LLM 路径不调用 `getCopilotToken`、不写 `state.copilotToken` | `rg --glob 'packages/proxy/src/upstream/**' 'state\.copilotToken\s*=\|getCopilotToken'` 应为空 |
| **I-4** | 哨兵 loop 任何抛错都被 catch，必然调度下一次 tick | 单测注入抛异常的 fetch mock |
| **I-5** | 每个 LLM 请求最多发起 2 次上游 fetch（首次 + 重试） | 代码层显式计数 + 单测 |

**关于 I-1 的处理**：`setupCopilotToken()` 拿到第一把 JWT 后，不再直接写 `state.copilotToken`，而是调用 `sentinel.bootstrap({ token, refreshInSeconds, timers })`，由哨兵模块写入并启动 loop。这样 grep 验收能稳定通过，不变量在代码层完整成立。

---

## 6. 哨兵状态机

```
                ┌─────────────────────────────────────────┐
                │              STEADY                     │
                │   tick = refresh_in - 60s               │
                │   行为（顺序）:                          │
                │     1. refreshNow("scheduled")          │
                │        ─ 主动换 token，承担原 scheduled  │
                │          refresh 的责任                  │
                │     2. cacheModels()                    │
                │        ─ 用新 token 做闭环健康验证       │
                │        ─ 401 → refreshNow("sentinel-401")│
                │     3. tokenSignal.decay()              │
                └─────┬──────────────────────────────┬────┘
                      │                              │
       score >= TH    │                              │ score < TH
                      ▼                              ▲
                ┌──────────────────────────────────┐ │
                │            PROBING               │ │
                │   tick = 5s, 最多 N (=3) tick   │ │
                │   行为:                          │ │
                │     ─ cacheModels() 探活          │ │
                │     ─ 401 → refreshNow(...)      │ │
                │     ─ 不做主动 scheduled refresh │ │
                │   N tick 内 score 未再次跨阈     │─┘
                │   则回 STEADY                    │
                └──────────────────────────────────┘

  refreshNow() 不是显式 state — 它是 module-level inflight Promise，
  与 tick 调度并行，由 single-flight 保证唯一性。
```

**STEADY tick 必须主动 refresh，不只是探活**：

- 旧实现 `scheduleTokenRefresh` 的语义是"到 `refresh_in - 60s` 主动换 token"。本设计必须完整继承这层职责，否则 token 真过期时只能等下一次哨兵 tick 撞 401 才换，窗口会扩到一次完整 tick 周期。
- 主动 refresh 后立即 `cacheModels()` 既刷新模型缓存（保留 `refreshModelsForToken` 原职责），也是新 token 的真实健康验证。
- single-flight 保证：如果 STEADY tick 触发的同时正好有 LLM 401 也调 `refreshNow`，两者共享同一个 in-flight Promise，上游只被打一次。

**PROBING tick 不做主动 refresh**：

- PROBING 是"刚有 LLM 路径上报 401"的应激态——此时 token 大概率刚被 LLM 路径触发的 `refreshNow` 换过，再主动换一次只会浪费上游配额。
- 这里只 cacheModels 探活；如果 PROBING 期间 `/models` 也撞 401，再走 `refreshNow("sentinel-401")` 兜底。

---

## 7. `refreshNow()` 契约（关键）

```ts
// packages/proxy/src/lib/token-sentinel.ts

export type RefreshReason = "llm-401" | "sentinel-401" | "scheduled" | "manual"

export type RefreshResult =
  | { ok: true;  tokenWasUpdated: boolean; refreshInSeconds: number | null }
  | { ok: false; error: unknown; cooldownMs: number }   // cooldownMs = 0 表示无冷却

// ── module-global state（哨兵唯一持有） ──
let inflight: Promise<RefreshResult> | null = null
let lastSuccessAt = 0
let lastRefreshInSeconds: number | null = null      // 上游最近一次返回值

// ── 失败冷却（module-global，所有触发源共享） ──
let failureCooldownUntil = 0
let consecutiveFailures = 0

// ── Timer manager（持有当前挂起 tick handle，支持主动 rearm） ──
let activeTimers: TimerFactory | null = null
let pendingTimeoutHandle: ReturnType<TimerFactory["setTimeout"]> | null = null
let sentinelState: SentinelState | null = null

// ── Tick re-entry guard ──
// tickInProgress 区分"refreshNow 是否在 sentinelTick 同步上下文中被调用"。
//   - tick 外（LLM 路径 / 测试手动 refreshNow）：完成后立即 clear + rearm。
//   - tick 内（scheduled / sentinel-401）：只置 dirty 标志，
//     由 tick 末的 scheduleNext 统一安排——避免在 tick 内 rearm 一次、
//     tick 末再 schedule 一次，导致双挂起 timer。
let tickInProgress = false
let dirtyAfterTick = false

/**
 * 关键：refreshNow 在任何 token 状态变化（成功或失败）后必须让哨兵 timer
 * 按最新的 currentSteadyIntervalMs() / cooldownRemaining 重新计算。
 *
 * 否则会出现两类问题：
 *   - LLM 路径刷新成功并改写了 lastRefreshInSeconds，但 steady timer 仍按
 *     bootstrap 时的旧 refresh_in 等下去；
 *   - LLM 路径刷新失败建立了 5s cooldown，但 steady timer 还要再等数分钟才
 *     发现这一事实。
 *
 * 但 rearm 时机要分清：
 *   - 若当前正在 sentinelTick 内（tickInProgress=true），rearm 会与
 *     tick 末的 scheduleNext 重复发起两次挂起 timer。这种情况只置
 *     dirtyAfterTick=true；scheduleNext 始终会跑，无需额外动作。
 *   - 否则（LLM 路径或测试外部调用），立即 clear 当前挂起 handle
 *     并触发一次 scheduleNext。
 */
function rearmSentinelAfterRefresh() {
  if (!sentinelState || !activeTimers) return
  if (tickInProgress) {
    dirtyAfterTick = true   // 由 tick 末 scheduleNext 收尾
    return
  }
  if (pendingTimeoutHandle) {
    activeTimers.clearTimeout(pendingTimeoutHandle)
    pendingTimeoutHandle = null
  }
  scheduleNext(sentinelState, activeTimers)
}

function noteFailure(): number {
  consecutiveFailures += 1
  const backoff = Math.min(
    REFRESH_INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1),
    REFRESH_MAX_BACKOFF_MS,
  )
  failureCooldownUntil = Date.now() + backoff
  return backoff
}

function noteSuccess(refreshInSeconds: number) {
  consecutiveFailures = 0
  failureCooldownUntil = 0
  lastSuccessAt = Date.now()
  lastRefreshInSeconds = refreshInSeconds
}

/** 哨兵调度查询用：仍在冷却中且还要多久 */
export function getRefreshCooldownRemaining(): number {
  return Math.max(0, failureCooldownUntil - Date.now())
}

/** 哨兵调度查询用：上游最近一次成功的 refresh_in */
export function getLastRefreshInSeconds(): number | null {
  return lastRefreshInSeconds
}

/**
 * 请求哨兵刷新 token。
 *
 * @param reason - 触发原因（用于日志/指标）。
 * @param attemptedToken - **caller 本次请求使用的 token**。当 caller 撞 401
 *   时把它传进来；如果 state.copilotToken 此刻已经不是它，说明在 caller
 *   失败的同时 / 之后已经有人成功刷新过，直接返回 tokenWasUpdated=true
 *   让 caller 重试，不再去敲上游。这是解决"并发尾部请求"被 min-interval
 *   误伤的关键。
 */
export async function refreshNow(
  reason: RefreshReason,
  attemptedToken?: string,
): Promise<RefreshResult> {
  // ── 1. 短路：state 已经比 caller 用的更新 → 直接让其重试 ──
  if (attemptedToken && state.copilotToken !== attemptedToken) {
    // refreshInSeconds=null 表示"没有访问上游、不要据此重排调度"
    return { ok: true, tokenWasUpdated: true, refreshInSeconds: null }
  }

  // ── 2. single-flight：所有并发调用共享同一个 Promise ──
  if (inflight) return inflight

  // ── 3. 失败冷却（全局，无论触发源）：拒绝调用、报告剩余冷却 ──
  //     这阻止了"LLM 路径触发 refreshNow 失败 → 下一个请求立刻又触发"的风暴，
  //     与 scheduled tick 的退避语义统一。
  const cooldownLeft = getRefreshCooldownRemaining()
  if (cooldownLeft > 0) {
    return { ok: false, error: new Error("refresh in cooldown"), cooldownMs: cooldownLeft }
  }

  // ── 4. min-interval 兜底：成功刷新后 N 秒内不重复访问上游 ──
  //     只有当 caller 用的 token 仍是当前 state.copilotToken 时才生效
  //    （步骤 1 已经覆盖了"caller 用的是旧 token"的情形）。
  const sinceLast = Date.now() - lastSuccessAt
  if (sinceLast < MIN_REFRESH_INTERVAL_MS && lastSuccessAt > 0) {
    return { ok: true, tokenWasUpdated: false, refreshInSeconds: null }
  }

  inflight = (async () => {
    try {
      const oldToken = state.copilotToken
      const { token, refresh_in } = await getCopilotToken()
      state.copilotToken = token       // I-1 的唯一写入点
      noteSuccess(refresh_in)
      return {
        ok: true,
        tokenWasUpdated: token !== oldToken,
        refreshInSeconds: refresh_in,
      }
    } catch (error) {
      const cooldownMs = noteFailure()
      logger.error("refreshNow failed", {
        reason,
        consecutiveFailures,
        cooldownMs,
        error: String(error),
      })
      return { ok: false, error, cooldownMs }
    } finally {
      inflight = null
      // 任何状态变化（成功 → lastRefreshInSeconds；失败 → cooldown）
      // 都必须 rearm 哨兵 timer，否则挂起的 tick 仍按旧调度等。
      rearmSentinelAfterRefresh()
    }
  })()

  return inflight
}
```

**关键设计**：

- **`attemptedToken` 参数解决并发尾部**：场景是请求 A、B 都拿旧 token 出发，B 先撞 401 触发刷新成功，A 晚一步才撞 401；此时 A 调 `refreshNow(_, oldToken)` → 短路返回 `tokenWasUpdated=true` → A 拿当前 `state.copilotToken`（已是新 token）重试一次。这避免了"min-interval 命中 → 误判没换 token → A 不重试 → 裸 401 泄漏"。
- **`tokenWasUpdated` 是 caller 的重试开关**：true 才值得重试；false 表示"现在 token 不变，再用一次会得到同样的 401"。
- **失败冷却全局共享（关键）**：`failureCooldownUntil` / `consecutiveFailures` 是模块级、所有触发源（`llm-401` / `sentinel-401` / `scheduled` / `manual`）共享的退避状态。一次失败后无论谁来调用，在冷却窗口内都直接返回 `ok:false, cooldownMs>0`，**不会**敲上游。这统一了旧 `retryTokenRefresh` 的行为，并堵住"LLM 路径触发失败后下一个请求立即又触发"的风暴。冷却 = `5s, 10s, 20s, …` 上限 `5min`，成功后清零。
- **`refreshInSeconds` 由 sentinel 模块内部统一记录**：成功刷新时 `noteSuccess(refresh_in)` 写入 `lastRefreshInSeconds`，与触发来源无关。任何 caller 都能通过 `getLastRefreshInSeconds()` 拿到最新值。这避免了"LLM 路径触发刷新成功 → 但 sentinel 调度仍用 bootstrap 时的旧 refresh_in"。哨兵 `scheduleNext` 直接读这个全局值，不依赖 `result.refreshInSeconds` 是否非 null。`RefreshResult.refreshInSeconds` 字段保留只是给 caller 一个观察值，非协议必需。
- **`refreshNow` 内 rearm 哨兵 timer，分内外两条路径（关键）**：`finally` 调 `rearmSentinelAfterRefresh()`：
  - **tick 外调用**（LLM 路径 / 手动 / 测试）：立刻 clear 当前 `pendingTimeoutHandle` 并跑 `scheduleNext`，把哨兵 timer 按最新 `lastRefreshInSeconds` / `cooldownRemaining` 重排。**这是后台失败后无需 LLM 唤醒就自动恢复的机制**。
  - **tick 内调用**（scheduled / sentinel-401，因为 `sentinelTick` 同步上下文中 await `refreshNow`）：仅置 `dirtyAfterTick=true` 标志，由 tick 末的 `scheduleNext` 统一收尾。这避免了"tick 内 rearm 一次、tick 末 scheduleNext 又一次"导致双挂起 timer。
  - 用 `tickInProgress` 模块标志区分；二者共享同一个 single-flight + cooldown 状态，无竞态。
- **`sentinelTick` 入口清 `pendingTimeoutHandle`**：timer 已经触发，handle 不再代表"未来挂起"。保持 `pendingTimeoutHandle` 语义为"仅指向未来一次挂起 timer"，让 tick 内的 rearm 路径行为可预测。
- **`bootstrap` 防重入**：开头检测已有活动 loop 时先 `teardownInternal()` 清旧 timer 再建新。`setupCopilotToken({force})` 重复初始化或测试套件中反复 bootstrap 不会产生并行 loop。
- **`MIN_REFRESH_INTERVAL_MS = 30s` 是上游访问频次兜底**：与 single-flight 是正交保护。**只在 attemptedToken == 当前 state 时生效**——保证它不会误伤"晚到的尾部请求"。
- **刷新结果不内嵌 `/models` 验证**：`refreshNow()` 拿到新 token 立刻返回。验证由两层独立机制承担：(1) LLM caller 的"用新 token 重试一次"本身就是一次实际验证；(2) 哨兵下一次 tick 的 `cacheModels()` 是后置的健康复核。把验证耦合进 `refreshNow()` 会阻塞所有等待者，得不偿失。

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
async function callOnce(): Promise<{ response: Response; usedToken: string }> {
  // 一次性把 token 和 headers 同源构造，避免 getToken() 与 getHeaders()
  // 之间发生 token 替换导致两者不一致。
  const { token: usedToken, headers } = this.config.snapshotAuth()
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  } as RequestInit)
  return { response, usedToken }
}

let { response, usedToken } = await callOnce()

if (response.status === 401) {
  const body = await response.text().catch(() => "")
  const tokenExpired = isTokenExpiredBody(401, body)
  tokenSignal.reportAuthFailure(tokenExpired ? "token-expired" : "other-401")

  if (!tokenExpired) {
    // 直接抛，不二次读 body
    throw new HTTPError(errorMessage, 401, body)
  }

  // 传入 usedToken：让 refreshNow 区分"本 caller 用的 token 是否已被他人换掉"
  const result = await sentinel.refreshNow("llm-401", usedToken)
  if (!result.ok || !result.tokenWasUpdated) {
    // refresh 失败 / 冷却中 / token 没变 → 不重试，抛已读出的 body
    throw new HTTPError(errorMessage, 401, body)
  }

  // I-5: 至多重试一次。snapshotAuth() 在新 token 下再次原子读取。
  ;({ response, usedToken } = await callOnce())
}

if (!response.ok) {
  throw await HTTPError.fromResponse(errorMessage, response)
}

return response
```

**Config 接口变更（方案的硬性要求）**：

现有 `CopilotXxxConfig` 暴露 `getToken()` 和 `getHeaders()` 两个独立方法；如果 caller 先 `getToken()` 再 `getHeaders()`，中间 `state.copilotToken` 被哨兵换掉，`usedToken` 与 headers 里实际的 `Authorization` 不一致——`refreshNow` 的 `attemptedToken` 短路逻辑会被错误数据污染。

方案要求在 `CopilotXxxConfig` 上新增一个原子方法：

```ts
export interface CopilotXxxConfig {
  // 原有方法保留，给现有非 401 路径继续用
  getToken(): string
  getHeaders(...): Record<string, string>
  // ── 新增：一次性快照本次请求要用的 token 和基于它的 headers ──
  snapshotAuth(options?: SnapshotOptions): { token: string; headers: Record<string, string> }
}
```

`snapshotAuth()` 内部实现一次读 `state.copilotToken` 并就地构造 headers，**不再二次访问 state**。这把"token / headers 必须同源"从约定变成接口保证。

**四个 client 的 `SnapshotOptions` 差异（实施时必须保留各自现有 headers 形状）**：

| Client | SnapshotOptions 字段 | snapshotAuth 内部要构造的 headers（在现有 `copilotHeaders` 之上叠加） |
|---|---|---|
| `copilot-openai` | `{ enableVision: boolean; isAgentCall: boolean }` | `Authorization: Bearer <token>` + 视觉与 `X-Initiator` 由 options 决定（原 `getHeaders(enableVision)` + `X-Initiator` 拼装位置上移） |
| `copilot-responses` | `{ enableVision: boolean; isAgentCall: boolean }` | 同 openai |
| `copilot-native` | `{ anthropicBeta: string \| null; visionRequest: boolean; isAgentCall: boolean }` | `Authorization` + `anthropic-version: 2023-06-01` + 可选 `anthropic-beta` + 可选 `copilot-vision-request` + `X-Initiator`。**与现有 `copilot-native.ts` 内 headers 块完全等价** |
| `copilot-embeddings` | `{}` 或 `undefined`（无差异化字段） | `Authorization` + 基础 copilot headers（与原 `getHeaders()` 等价） |

**实施约束**：

1. `snapshotAuth(options)` 必须返回**与现有路径完全等价**的 headers——只是把"两步读"合成"一步读"。不允许借此机会增删字段。
2. `SnapshotOptions` 字段命名应与各 client 内部已有的派生量（`enableVision` / `isAgentCall` / `anthropicBeta` / `visionRequest`）一致，避免引入新概念。
3. `getHeaders()` / `getToken()` 保留：现有非 401 的同步路径（如 dashboard 查询）仍可继续用，渐进迁移。

默认 factory（`defaultCopilotXxxConfig`）一行实现，单测可以注入 mock 来模拟"两次读取之间 token 变化"的竞态场景。

**为什么 `usedToken` 不直接从 sentinel 模块读**：

- 现有 upstream client 通过 `CopilotXxxConfig` 接受注入，**不直接 import 全局 state**——这是 §11 单元测试能 mock token 的基础。
- 直接读 `state.copilotToken` 会破坏这层抽象，让 client 与全局 state 硬耦合。`snapshotAuth()` 在保留注入边界的同时拿到原子性保证。

**严格做且只做**：

1. ✅ 上报信号（不区分文案命中与否）
2. ✅ 文案命中 token-expired 时 `await refreshNow(_, usedToken)`
3. ✅ 若 `tokenWasUpdated` 为真，**最多一次**重试
4. ✅ 不重试分支用首读 body 构造 HTTPError，**不再次访问 response.body**
5. ❌ 不调用 `getCopilotToken()`（违反 I-3）
6. ❌ 不写 `state.copilotToken`（违反 I-1）
7. ❌ 不循环重试、不嵌套 `refreshNow`（违反 I-5）

**关于 `usedToken` 的作用**：

- 并发请求 A、B 都用旧 token 出发；B 先撞 401 触发刷新成功；A 稍后撞 401 调用 `refreshNow("llm-401", oldToken)`；此时 `state.copilotToken` 已经是新 token、`oldToken !== state.copilotToken`，`refreshNow` 立刻短路返回 `tokenWasUpdated=true`，A 用 `state.copilotToken` 的最新值重试一次。
- 没有这个参数，min-interval 会让 A 拿到 `tokenWasUpdated=false`，A 不重试 → 用户看见 401 → 设计目标失守。

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
}

function intervalFromRefreshIn(refreshInSeconds: number): number {
  return Math.max((refreshInSeconds - 60) * 1000, MIN_REFRESH_MS)
}

function currentSteadyIntervalMs(): number {
  const r = getLastRefreshInSeconds()
  return r != null ? intervalFromRefreshIn(r) : DEFAULT_STEADY_INTERVAL_MS
}

async function sentinelTick(s: SentinelState, timers: TimerFactory) {
  // 进入 tick 即清空 pendingTimeoutHandle —— 该 handle 已经触发，
  // 不再代表"未来挂起 tick"。保持变量语义为"只保存未来 timer"。
  pendingTimeoutHandle = null

  tickInProgress = true
  dirtyAfterTick = false

  try {
    const inCooldown = getRefreshCooldownRemaining() > 0

    // ── STEADY: 主动 scheduled refresh ──
    // ── PROBING: 不主动 refresh ──
    if (s.mode === "steady" && !inCooldown) {
      const result = await refreshNow("scheduled")
      if (!result.ok) {
        logger.warn("scheduled refresh failed in steady tick", {
          error: String(result.error),
          cooldownMs: result.cooldownMs,
        })
        // 失败已写入全局 cooldown。本 tick 直接走 scheduleNext，按 cooldown
        // 间隔安排下一 tick；不访问 /models（防止旧 token 401 再触发一轮无用尝试）。
        scheduleNext(s, timers)
        return
      }
    }

    // ── 闭环验证 / 探活 ──
    // cooldown 期间跳过 cacheModels：旧 token 大概率仍 401，会触发
    // refreshNow("sentinel-401") 立即命中 cooldown 返回 ok:false，
    // 而 cacheModels 自身还是会真实打 /models 给上游（不是 token 接口，
    // 但仍是上游访问）。冷却期不该探活。
    if (!inCooldown) {
      try {
        await cacheModels()
      } catch (e) {
        if (isAuthError(e)) {
          await refreshNow("sentinel-401")
          // tick 内的 refreshNow 只置 dirtyAfterTick；本 tick 不递归 cacheModels。
        } else {
          logger.warn("sentinel /models failed (non-auth)", { error: String(e) })
        }
      }
    }

    // I-Order: 先判 PROBING 再 decay，避免单次跨阈值信号被 tick 头部衰减抵消。
    scheduleNext(s, timers)
    tokenSignal.decay()
  } catch (fatal) {
    // I-4: 任何意外异常都不让 loop 死
    logger.error("sentinel tick fatal", { error: String(fatal) })
    pendingTimeoutHandle = timers.setTimeout(
      () => sentinelTick(s, timers),
      currentSteadyIntervalMs(),
    )
  } finally {
    tickInProgress = false
    // dirtyAfterTick 不需要在这里 act：scheduleNext / fatal 分支已经
    // 在 tick 结束前安排好下一次 timer，dirty 标志只是用来防止
    // tick 内的 refreshNow 重复 schedule。tick 退出后直接丢弃即可。
    dirtyAfterTick = false
  }
}

function scheduleNext(s: SentinelState, timers: TimerFactory) {
  const wantsProbe = tokenSignal.shouldProbeNow()    // 注意：在 decay 之前调用

  if (wantsProbe && s.mode !== "probing") {
    s.mode = "probing"
    s.remainingProbeTicks = PROBE_TICKS
  } else if (s.mode === "probing") {
    s.remainingProbeTicks -= 1
    if (s.remainingProbeTicks <= 0 && !wantsProbe) {
      s.mode = "steady"
    }
  }

  // 优先级：失败冷却 > PROBING > STEADY 周期
  //
  // 把 cooldown 放在 PROBING 之前的原因：
  //   - PROBING 是"密集探活 cacheModels"——如果当前正在 cooldown，探活
  //     大概率会撞 401 但又无法刷 token，纯浪费上游配额。
  //   - cooldown 期间 sentinelTick 内 inCooldown=true 也已跳过 cacheModels
  //     与 scheduled refresh，所以这层选择确保连"以更短间隔再次空跑"也不发生。
  //
  // 周期值都来自 module-global state，不再持有 SentinelState 局部副本。
  let nextMs: number
  const cooldown = getRefreshCooldownRemaining()
  if (cooldown > 0) {
    nextMs = cooldown
  } else if (s.mode === "probing") {
    nextMs = PROBE_INTERVAL_MS
  } else {
    nextMs = currentSteadyIntervalMs()
  }
  pendingTimeoutHandle = timers.setTimeout(() => sentinelTick(s, timers), nextMs)
}

/**
 * 单一入口：写入首把 token + 启动哨兵 loop。
 *
 * 替代旧设计里 bootstrap() + startTokenSentinel() 两个函数的组合。
 * 返回 stop() 句柄给测试与未来 shutdown 用。
 *
 * 重入语义：bootstrap 调用时若已经存在活动 loop（setupCopilotToken 被
 * 重复调用 / 测试重复 init），先内部 stop 掉旧 loop 再新建。这避免
 * 双 timer 并行，且让 setupCopilotToken({ force: true }) 行为可预测。
 */
export interface BootstrapOptions {
  token: string
  refreshInSeconds: number
  timers?: TimerFactory
}

export interface SentinelHandle {
  stop(): void
}

function teardownInternal() {
  if (activeTimers && pendingTimeoutHandle) {
    activeTimers.clearTimeout(pendingTimeoutHandle)
  }
  pendingTimeoutHandle = null
  sentinelState = null
  activeTimers = null
  // tickInProgress 是同步标志，不持久跨调用——不需要这里清。
  // 若有 inflight 刷新仍在跑，那一轮会 finally 中调 rearm，
  // 但因为 sentinelState=null，rearm 会 early return（见
  // rearmSentinelAfterRefresh 第一行 guard）。
}

export function bootstrap(opts: BootstrapOptions): SentinelHandle {
  const timers = opts.timers ?? defaultTimers

  // 防重入：如果已经有活动 loop，先清掉
  if (sentinelState || pendingTimeoutHandle) {
    logger.warn("sentinel.bootstrap called while loop is active; resetting")
    teardownInternal()
  }

  state.copilotToken = opts.token          // I-1 的唯一写入点之一
  noteSuccess(opts.refreshInSeconds)       // 初始化 lastSuccessAt / lastRefreshInSeconds

  sentinelState = {
    mode: "steady",
    remainingProbeTicks: 0,
  }
  activeTimers = timers

  pendingTimeoutHandle = timers.setTimeout(
    () => sentinelTick(sentinelState!, timers),
    currentSteadyIntervalMs(),
  )

  return {
    stop: teardownInternal,
  }
}
```

**设计要点**：

- **STEADY 主动 refresh**：每个 STEADY tick 第一件事就是 `refreshNow("scheduled")`，完整继承旧 `scheduleTokenRefresh` 的"到 `refresh_in - 60s` 换 token"语义。这是修复"光靠探活无法主动换 token"的关键。
- **上游 `refresh_in` 变化即重排（由 sentinel 模块统一记录 + timer rearm）**：哨兵 tick 不再从 `RefreshResult` 直接读 `refreshInSeconds`，而是通过 `getLastRefreshInSeconds()` 读 module-global 状态；同时 `refreshNow` 的 `finally` 主动 `rearmSentinelAfterRefresh()`，clearTimeout 当前挂起 tick 并按新值重排。无论刷新由 `scheduled` / `llm-401` / `sentinel-401` / `manual` 哪个 reason 触发，最新的 `refresh_in` 都会**立即**反映到下一次哨兵 tick——不会等到挂起 tick 自然到期才发现。
- **失败退避走 module-global cooldown + 主动 rearm**：`refreshNow` 内部 `noteFailure()` 维护 `failureCooldownUntil` / `consecutiveFailures`（5s → 10s → … 上限 5min），`finally` 调 `rearmSentinelAfterRefresh()` 让哨兵 timer 按新 cooldown 重新计算。**LLM 路径触发的失败同样写入这个 cooldown 并 rearm**，从而堵住"LLM 失败 → 下一个请求立刻又触发"的风暴，且后台一定会在 cooldown 结束后自动恢复，不依赖下一次 LLM 请求来唤醒。
- **cooldown 优先级最高，期间彻底静默**：`sentinelTick` 进入时若 `inCooldown` 为真则**同时跳过 scheduled refresh 和 cacheModels**；`scheduleNext` 优先级是 cooldown > PROBING > STEADY。这保证冷却期内既不打 token 接口、也不打 `/models`，连 PROBING 上下文都被冷却覆盖——anti-ban 视角下的完整静默。
- **PROBING 不主动 refresh**：避免与 LLM 路径触发的 `refreshNow` 重复访问上游；它的角色是"高频探活，给最近的刷新结果做即时复核"。在 cooldown 期间也不会真的探活（见上一条）。
- **`decay()` 在判 PROBING 之后**：旧顺序"tick 头 decay → 判阈值"会让 score 正好等于阈值的单次 token-expired 信号被衰减后落到阈值之下，无法进入 PROBING。新顺序先用 `shouldProbeNow()` 判断本 tick 的目标 mode，再 decay，让阈值语义保持"score ≥ 5 即触发"。
- **`SentinelState` 极简**：只保留 `mode` 与 `remainingProbeTicks`。所有周期值（`steadyIntervalMs` / 冷却剩余）每次从 module-global 重新计算，避免"local 副本与 global 值不同步"的隐性 bug。
- **单一 bootstrap 入口**：`bootstrap({ token, refreshInSeconds, timers })` 一个函数同时完成写入首把 token + 初始化 timer state + 启动 loop，返回 `{ stop }` 句柄。删除原来 `bootstrap` + `startTokenSentinel` 双入口的歧义。
- **setTimeout 链而非 setInterval**：每个 tick 完整结束才安排下一次，从根本上杜绝重入。挂起 handle 存放在 module-global `pendingTimeoutHandle`，给 `rearmSentinelAfterRefresh` 和 `stop()` 使用。
- **fatal try/catch 双层**：即使 `scheduleNext` 抛异常（不应该发生）也要保证下一次 tick 被安排。

---

## 11. 启动与生命周期

```
proxy startup:
  1. setupGitHubToken()                      ── 现有
  2. setupCopilotToken()                     ── 现有；但内部行为变更:
     ─ 拿到首把 JWT + refresh_in 后
     ─ 调用 sentinel.bootstrap({ token, refreshInSeconds, timers })
       让哨兵一次性完成"写入 + 启动 loop"
     ─ 不再直接写 state.copilotToken
     ─ 不再调用 scheduleTokenRefresh
  3. 其余 cache* 初始化                       ── 现有
```

**`setupCopilotToken` 不再写 state**：

```ts
// 变更后伪代码
let sentinelHandle: SentinelHandle | null = null

export const setupCopilotToken = async (timers: TimerFactory = defaultTimers) => {
  const { token, refresh_in } = await getCopilotToken()
  // 单一入口：写入 + 启动 loop 都交给 sentinel.bootstrap
  sentinelHandle = sentinel.bootstrap({ token, refreshInSeconds: refresh_in, timers })
  logger.debug("GitHub Copilot Token fetched successfully!")
}
```

这样 `state.copilotToken` 在整个代码库中只有一个写入文件（`token-sentinel.ts`），I-1 的 grep 验收稳定通过。

**关停**：测试或 shutdown 调用 `sentinelHandle.stop()`——内部清理 `pendingTimeoutHandle` 和 `sentinelState`。无显式 graceful shutdown 协议（与现有 systemd / dev 流程一致）。

---

## 12. 失败与边界

| 场景 | 哨兵行为 | LLM 路径行为 | 用户感知 |
|---|---|---|---|
| `/models` 上游瞬时 5xx | 当前 tick 标记失败 | 不受影响 | 无 |
| `/models` 返回 401 | refreshNow（single-flight）；本 tick 不再递归 cacheModels，refreshNow rearm 哨兵 timer 让下一 tick 立刻按新状态计算 | 不受影响 | 无 |
| 单次 LLM 401 + token-expired 文案 | 接收信号；in-flight refresh 复用；成功后 rearm timer → 哨兵立刻按新 refresh_in 重排 | await + 重试一次 | 无（无感） |
| 并发 N 个 LLM 401 + token-expired | 收到 N 条信号；refresh 只跑 1 次；rearm 仅触发一次 | 全部 await 同一个 Promise → 各自重试 | 无（无感） |
| LLM 401 但文案不命中 token-expired | 接收信号（other-401，权重 1） | 直接抛 401 | 用户看见 401；后续请求由哨兵 tick 兜底 |
| LLM 路径触发 `refreshNow` 失败 | 进入全局 cooldown（5s 起，×2 上限 5min）；**rearm 哨兵 timer → 下一 tick 在 cooldown 结束时触发，无需等待下一次 LLM 请求** | 不重试，原 401 抛出 | 单次 401，cooldown 后台自动恢复 |
| Scheduled 触发 `refreshNow` 失败 | 同上：cooldown + rearm；本 tick 直接 return，不再 cacheModels | 不受影响 | 无（短暂内部静默） |
| **冷却期内任意触发源调 `refreshNow`** | 直接返回 `ok:false, cooldownMs>0`，**不敲上游** | 不重试，原 401 抛出 | 用户看见 401，但不会引发上游访问风暴 |
| 冷却期内哨兵 tick 到来 | `sentinelTick` 入口检测 cooldown：跳过 scheduled refresh + cacheModels；`scheduleNext` 下一 tick 间隔 = `cooldownMs` | 不受影响 | 无 |
| 冷却 + PROBING 同时存在 | cooldown 优先级高于 PROBING；既不刷 token 也不探活 `/models` | 不受影响 | 无 |
| `refreshNow` 成功但 token 字面没变 | 返回 `tokenWasUpdated=false`；仍 rearm（防止上游变 refresh_in） | 不重试 | 用户看见 401（防止白重试） |
| LLM 重试仍 401 | 不二次触发 refresh（I-5） | 抛出重试响应的 HTTPError | 用户看见 401 |
| 哨兵 tick 抛任意异常 | 双层 catch，下一 tick 仍被调度（I-4） | 不受影响 | 无 |
| 进程刚启动尚未跑过哨兵 | 第一次 tick 在 `currentSteadyIntervalMs()` 后触发 | 使用 bootstrap 的初始 JWT | 与现状一致 |

---

## 13. 与 anti-ban 的兼容性

`CLAUDE.md` 的 anti-ban 协议核心是"不要无节制敲上游"。本方案严格更优：

1. **刷新次数三重保护**：(1) single-flight 让并发请求只能触发一次；(2) `MIN_REFRESH_INTERVAL_MS` 让短时间内重复触发只跑一次；(3) **任何触发源**的失败都写入 module-global cooldown（5s → 10s → … 上限 5min），冷却窗口内所有 caller 都直接被拦回，频次受控。
2. **PROBING 流量可量化**：`PROBE_INTERVAL_MS = 5s`、`PROBE_TICKS = 3`，最坏情况 15 秒内最多 3 次 `/models`。比"每个 LLM 请求自带 retry"低一个数量级。
3. **哨兵成功 = 健康证据**：每次 `/models` 200 都证明 token 健康，可作为推迟"下一次主动 refresh"的依据（阶段 4 可选优化）。

**实施前必须验证**：PROBING 期间连续 3 次 `/models` 调用不会触发 GitHub 侧 abuse detection。开发阶段先以保守参数（`PROBE_INTERVAL_MS = 8s`、`PROBE_TICKS = 2`）跑一周观测。

---

## 14. 实施分阶段

**阶段 1 — 哨兵骨架（独立 PR）**

- 新增 `packages/proxy/src/lib/token-sentinel.ts`，包含 `refreshNow()`（含全局 cooldown + 主动 rearm）+ `noteSuccess/Failure` + tick loop（STEADY 状态机 + 主动 scheduled refresh + cooldown 期间静默，PROBING 留空骨架）+ **单一入口 `bootstrap({ token, refreshInSeconds, timers })`** 返回 `{ stop }` 句柄 + 周期辅助 `getLastRefreshInSeconds` / `getRefreshCooldownRemaining`。
- 删除 `scheduleTokenRefresh` / `retryTokenRefresh` / `refreshModelsForToken`；`setupCopilotToken` 改调 `sentinel.bootstrap(...)`，不再直接写 `state.copilotToken`。
- LLM 路径完全不动。
- 单测：fake timers + mocked fetch，验证 STEADY 周期、**主动 scheduled refresh**、**上游 refresh_in 变化即重排（含 timer rearm）**、**任意触发源失败均进入 module-global cooldown + 主动 rearm**、**cooldown 期间完全静默（不刷 token、不打 /models）**、refresh-on-401、单 flight、min-interval、`attemptedToken` 短路、I-4 不死锁、`stop()` 干净取消挂起 tick。
- **本阶段不解决用户体验问题**，只把单写者 + scheduled refresh 的语义统一到哨兵。可独立合入。

**阶段 2 — 等待 + 重试 + 信号（独立 PR，恢复 PR #129 的用户体验目标）**

- 新增 `packages/proxy/src/lib/token-signal.ts`。
- **在 `CopilotXxxConfig` 上引入 `snapshotAuth()` 原子方法**（见 §9）；保留 `getToken()` / `getHeaders()` 给现有非 401 路径。
- 四个 upstream client 加 401 → `await sentinel.refreshNow("llm-401", usedToken)` + 单次重试，token 与 headers 通过 `snapshotAuth()` 同源读取。
- 哨兵接入 `tokenSignal.shouldProbeNow()` → PROBING 周期切换。
- 单测：信号累积、衰减、阈值边界；LLM 客户端 401 重试矩阵（文案命中/不命中 × 刷新成功/失败/冷却中 × tokenWasUpdated true/false × 重试 ok/fail）；`snapshotAuth` 原子读出 token 与 headers 中的 Authorization 一致；**`snapshotAuth` 输出的 headers 与重构前 fixture 完全等价**（每个 client 的特征 header：openai/responses 的 `X-Initiator`+vision、native 的 `anthropic-*` 系列、embeddings 的 baseline）。
- 集测（L2）：并发 N 个 LLM 401 → 上游 `/copilot_internal/v2/token` 只被调用 1 次；LLM 失败时 cooldown 生效，后续请求不再敲上游。
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
- STEADY tick 周期 = `currentSteadyIntervalMs()`（基于上游最近一次 `refresh_in`）
- **STEADY tick 每轮主动调用 `refreshNow("scheduled")`**（承担旧 scheduleTokenRefresh 职责）
- **上游变更 `refresh_in` → 下一次 STEADY 周期重排**：第一次 refresh 返回 1500s，第二次返回 600s；断言 `currentSteadyIntervalMs()` 跟着变
- **`refresh_in` 跨触发源传播 + timer rearm**：在距下次 steady tick 还有 20 分钟时直接 `await refreshNow("llm-401", ...)` 成功（新 refresh_in=600s）；fake-advance 时间，断言下一次 sentinelTick 在 9 分钟后（不是 20 分钟）触发——证明 rearm 生效
- **`refreshNow` 失败 → 全局 cooldown + timer rearm**：失败后断言下一次 sentinelTick 在 cooldownMs 后触发（而不是等到旧挂起的 steady tick）
- **失败后自动恢复无需 LLM 唤醒**：fake-advance 时间穿过 cooldown，断言哨兵自行触发下一 tick 并成功刷新；过程中 0 个 LLM 请求介入
- **连续失败序列（5s → 10s → 20s）**：每次失败后哨兵 tick 都按当前剩余 cooldown rearm
- **cooldown 期内任意触发源都被拦回**：先让 scheduled 失败建立 cooldown，再调 `refreshNow("llm-401")` → 返回 `ok:false, cooldownMs>0`，**`getCopilotToken` 调用次数不变**
- **cooldown 期间 sentinelTick 完全静默**：cooldown 内手动触发 tick，断言 `getCopilotToken` 与 `getModels` 都未被调用
- **cooldown 优先级高于 PROBING**：先把 score 推到阈值进入 PROBING，再让 refresh 失败建立 cooldown；断言下一 tick 间隔 = cooldown 剩余值（不是 PROBE_INTERVAL_MS），且 tick 内不调 `getModels`
- STEADY `/models` 401 → refreshNow → rearm 后下一 tick 复核
- PROBING tick **不**主动 refresh，仅 cacheModels
- /models 5xx → 不刷新、tick 继续
- 信号触发 PROBING → 周期切到 PROBE_INTERVAL_MS
- **score 正好等于阈值的单次信号必须能进入 PROBING**（断言 decay 顺序正确：先判 mode 再 decay）
- PROBING N tick 内无新信号 → 回 STEADY
- 任意 tick 内部异常 → 下一 tick 仍被调度（I-4）
- **`refreshNow` single-flight**：并发 N 次调用 → `getCopilotToken` 被调用 1 次，所有调用方拿到同一结果；rearm 仅触发 1 次（clearTimeout 次数 = 1）
- **`refreshNow` min-interval**：连续两次调用且 `attemptedToken == state.copilotToken` → 第二次返回 `tokenWasUpdated=false, refreshInSeconds=null`
- **`refreshNow` attemptedToken 短路**：传入的 `attemptedToken` 与当前 state 不同 → 直接返回 `tokenWasUpdated=true, refreshInSeconds=null`，**不访问上游、不 rearm**
- **`refreshNow` 成功返回 `refreshInSeconds` 等于上游 `refresh_in`**
- **`refreshNow` 失败 → inflight 被清空**：失败后下一次调用能正常发起新刷新（前提：cooldown 已过或冷却期为 0）
- **bootstrap 单一入口**：调用后 `state.copilotToken` 被写入、`getLastRefreshInSeconds()` 等于首个 refresh_in、loop 启动、返回的 `stop()` 能干净取消挂起 tick
- **bootstrap 防重入**：连续两次 `bootstrap()` → 第一次的挂起 tick 被 clear，只剩第二次的；断言 `setTimeout` 实际净增量 = 1，`clearTimeout` 被调用 1 次
- **tick 内 refresh 不产生双 timer**：让 sentinelTick 内的 scheduled refresh 成功 → fake-advance 时间，断言下一次 sentinelTick 只触发 **1 次**（不是 2 次）；`setTimeout` 在 tick 范围内净增量 = 1
- **`sentinelTick` 入口清 `pendingTimeoutHandle`**：tick 进入后立刻断言 `pendingTimeoutHandle === null`，直到 `scheduleNext` 末尾才被赋值
- **`stop()` 后 inflight 完成**：在 inflight refresh 仍在跑时调 `stop()`，刷新完成走到 `rearmSentinelAfterRefresh` → 因为 `sentinelState=null` 而 early return，不会偷偷重启 loop

**`copilot-{openai,native,responses,embeddings}.test.ts`**：每个 client 覆盖完整 401 矩阵。
- 2xx → 不上报信号、不调用 refreshNow
- 401 + 非 token-expired 文案 → 上报 other-401、不调 refreshNow、抛原 401（**HTTPError.responseBody 等于首读 body**）
- 401 + token-expired 文案 + refresh 成功 + tokenWasUpdated=true + 重试 2xx → 返回重试响应
- 401 + token-expired + refresh 成功 + tokenWasUpdated=false → 不重试、抛原 401（**responseBody 不丢**）
- 401 + token-expired + refresh 失败 → 不重试、抛原 401（**responseBody 不丢**）
- **401 + token-expired + 命中 cooldown** → refreshNow 返回 `ok:false, cooldownMs>0` → 不重试、抛原 401
- 401 + token-expired + 重试仍 401 → 抛重试响应的 HTTPError、**不再次触发 refresh**（I-5）
- **并发尾部请求场景**：模拟 A、B 都用旧 token；B 先撞 401 触发 refresh 成功；A 再撞 401 → A 调 `refreshNow(_, oldToken)` 时短路返回 → A 用新 token 重试成功
- **`snapshotAuth` 原子性**：mock config 让两次 `getToken` 中间换 token 值；断言 `snapshotAuth()` 返回的 `token` 字段与 headers 中 Authorization 一致（不会发生分裂）
- **`snapshotAuth` 保留原有 fixture headers**：每个 client 的 401 重试测试 + 一个 happy path（2xx）测试，**断言 fetch 实际收到的 headers 与重构前的 fixture 完全等价**：
  - openai/responses：包含 `X-Initiator` 与必要时的 `copilot-vision-request`
  - native：包含 `anthropic-version`、必要时的 `anthropic-beta`、`copilot-vision-request`、`X-Initiator`
  - embeddings：与原 `copilotHeaders(state)` 完全一致
  - 这层断言保证 §9 引入 `snapshotAuth` 不会为了"原子性"而改坏请求形状
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
| `STEADY_INTERVAL_FORMULA` | `max((refresh_in - 60) * 1000, MIN_REFRESH_MS)` | 由 `currentSteadyIntervalMs()` 计算，与历史调度一致 |
| `DEFAULT_STEADY_INTERVAL_MS` | `25 * 60_000` | bootstrap 之前 / `lastRefreshInSeconds == null` 时的兜底周期 |
| `PROBE_INTERVAL_MS` | `5_000` | PROBING tick 间隔 |
| `PROBE_TICKS` | `3` | PROBING 持续 tick 数 |
| `SIGNAL_THRESHOLD` | `5` | shouldProbeNow 阈值；只控制 PROBING，不控制刷新 |
| `SIGNAL_TOKEN_EXPIRED_WEIGHT` | `3` | token-expired 信号权重 |
| `SIGNAL_OTHER_401_WEIGHT` | `1` | other-401 信号权重 |
| `MIN_REFRESH_INTERVAL_MS` | `30_000` | 距上次成功 refresh N 秒内不重复刷（兜底） |
| `REFRESH_INITIAL_BACKOFF_MS` | `5_000` | 失败 cooldown 起始值；与旧 retryTokenRefresh 一致 |
| `REFRESH_MAX_BACKOFF_MS` | `5 * 60_000` | 失败 cooldown 上限；与旧实现一致 |
| `MIN_REFRESH_MS` | `30_000` | STEADY 间隔下限（防止上游返回的 `refresh_in` 过小导致狂刷） |

---

## 18. 设计取舍小结

| 维度 | 选择 | 原因 |
|---|---|---|
| 刷新者数量 | **1（哨兵）** | I-1；架构层免疫并发问题 |
| 失败退避作用域 | **module-global cooldown** | 所有触发源共享，堵住 LLM 路径触发失败的风暴 |
| Cooldown 内行为 | **`sentinelTick` 与 `refreshNow` 都完全静默** | anti-ban：冷却期不打 token 接口，也不打 `/models` |
| Cooldown 自动恢复 | **`refreshNow` 内 `rearmSentinelAfterRefresh()`** | 后台依赖哨兵 timer rearm 自动恢复，不依赖下一次 LLM 请求来唤醒 |
| LLM 401 重试 | **await + 重试 1 次** | 恢复 PR #129 的用户体验目标 |
| 重试触发判据 | **body 文案 token-expired** | 廉价、明确；误判时由哨兵 tick 兜底 |
| 刷新结果判据 | **`refreshNow` 返回的 tokenWasUpdated** | 避免用同一把死 token 重试 |
| `refresh_in` 来源 | **sentinel 模块统一记录（`lastRefreshInSeconds`）+ timer rearm** | 跨触发源传播；新值立即生效，不等下次 tick |
| token/headers 一致性 | **`config.snapshotAuth()` 原子方法** | 杜绝两次 `state` 读之间发生切换导致 `usedToken` 与 Authorization 分裂 |
| 信号通道作用 | **仅决定 PROBING 频率档** | 与刷新决策完全解耦，修复 v1 评分硬伤 |
| 调度容器 | **setTimeout 链 + module-global `pendingTimeoutHandle`；tick 入口清空 handle** | 杜绝 setInterval 重入；保持"handle 仅指向未来 timer"语义 |
| Tick 内 / 外 refresh 区分 | **`tickInProgress` + `dirtyAfterTick` 标志** | tick 外刷新立即 rearm；tick 内仅打标记，由 tick 末统一 scheduleNext，杜绝双挂起 timer |
| 启动入口 | **`bootstrap({ token, refreshInSeconds, timers })` 单一函数；重入时先 teardown** | 消除双入口歧义；重复 init 不产生并行 loop |
| 模型缓存刷新 | **由哨兵 tick 自然完成** | 删掉 `refreshModelsForToken` 分支 |
| 重试上限 | **代码层硬编码 1 次** | I-5 显式保证，不依赖运气 |

---

## 19. 验收标准

- [ ] `state.copilotToken` 的所有写入点在 `packages/proxy/src/` 范围内（`rg --glob 'packages/proxy/src/**'`，排除 `test/` / mock）只出现在 `lib/token-sentinel.ts`（I-1）
- [ ] `packages/proxy/src/upstream/` 下的 client 不 import `getCopilotToken`、不写 `state.copilotToken`（I-3）
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

**操作**：阶段 1 只把刷新职责收敛进哨兵、不改 LLM 行为，本身**不**覆盖 PR #129 的用户体验目标，因此**不要在阶段 1 合入后 close PR #129**。**阶段 2 合入后**才完整恢复并超越 PR #129 的目标，此时再 close / supersede PR #129。

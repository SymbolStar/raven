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
2. **架构层免疫并发**：**所有经由 `sentinel.refreshNow()` 的刷新（无论来自哨兵 tick 还是 LLM 路径上报）共享同一个 in-flight Promise**，同一时刻最多一次 `getCopilotToken()` 在飞。例外仅有一处：`setupCopilotToken` 在 stop 旧 sentinel + bootstrap 新 sentinel 的窗口内，自己直接 `await getCopilotToken()` 取首把 token，此时旧 sentinel 残留的 in-flight 刷新可能与新 setup 的请求短暂并存。这种"setup 重入"由用户显式触发（force-refresh / 切账号），频率受用户行为限制，不会形成上游访问风暴。
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
| **I-2** | 同一时刻最多一个 `getCopilotToken()` 调用在飞——**仅约束 `sentinel.refreshNow()` 路径**；`setupCopilotToken` 重入窗口内的 setup-级 `getCopilotToken()` 不受此约束（见 §11） | `inflight: Promise \| null` 单点 + 单测验证 refreshNow 任意并发触发只发出一次上游调用 |
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
// 任意来源的 refresh 失败后置 true；下一次 sentinelTick 进入时消费，
// 强制把 mode 压回 STEADY，确保 cooldown 一过先走主动 scheduled refresh，
// 而不被 PROBING 接管导致只 cacheModels 不刷 token。成功刷新清零。
let forceSteadyAfterCooldown = false

// ── Timer manager（持有当前挂起 tick handle，支持主动 rearm） ──
let activeTimers: TimerFactory | null = null
let pendingTimeoutHandle: ReturnType<TimerFactory["setTimeout"]> | null = null
let sentinelState: SentinelState | null = null

// ── Generation / epoch ──
// 每次 bootstrap()/teardownInternal() 递增 generation。inflight refresh 完成时
// 校验"当前 generation 仍是发起时的那个"，否则视为来自已废弃的 loop，
// 不写 state.copilotToken、不调 noteSuccess/noteFailure、不 rearm 新 loop。
// 这避免旧 loop 的飞行刷新污染新 bootstrap() 后的状态。
let generation = 0

// ── Rearm 抑制（per-call，绑定在 inflight 上） ──
//
// 设计上为什么不是全局 `let suppressRearm`：
//   Promise 的 finally 在所有 await continuation 恢复之前执行。即使哨兵 tick
//   在 await 完自己的 refreshNow 后才把 suppressRearm 复位为 false，外部 LLM
//   通过 inflight 复用同一个 Promise 时，它的 finally 早已先跑过——届时全局
//   suppressRearm 仍然是 true，LLM 路径"立即 rearm"承诺无法兑现。
//
// 改为 per-call 选项 + inflight 自带标志：
//   - 哨兵自己 await 的那次 refreshNow，opts.fromSentinelTick=true 标记
//     inflight 是"sentinel-owned"。
//   - inflight 的 finally 看自身标志：sentinel-owned → 仅置 dirtyAfterTick；
//     否则 → 立即 clear + rearm。
//   - 外部 LLM 即便 await 同一个 inflight Promise，对它而言"自己发起的 refreshNow"
//     是一次 inflight 复用：它走"快路径"直接返回这个 Promise，不会再额外 rearm；
//     哨兵 tick 末的 scheduleNext 自然把 timer 排好。
//   - 关键：外部 LLM **不复用哨兵的 inflight，自己发起 refreshNow 时**：当时
//     若没有 inflight，会建立一条**新的、非 sentinel-owned 的 inflight**，
//     finally 走"立即 rearm"。
//   这样把"内 vs 外"的判断从全局可变状态换成 per-call 绑定，不再受
//   await/finally 时序影响。
let dirtyAfterTick = false

// 当前 inflight 是否由 sentinel-tick 自己发起。
// 与 inflight 一同生灭，避免跨 Promise 错读。
let inflightFromSentinelTick = false

/**
 * 关键：refreshNow 在任何 token 状态变化（成功或失败）后必须让哨兵 timer
 * 按最新的 currentSteadyIntervalMs() / cooldownRemaining 重新计算。
 *
 * rearm 时机由 inflight 自带的 `fromSentinelTick` 标志决定（见上方注释）：
 *   - sentinel-owned inflight 完成 → 仅置 dirtyAfterTick=true，
 *     tick 末 scheduleNext 收尾
 *   - 非 sentinel-owned inflight 完成 → 立即 clear + 重新 scheduleNext
 */
function rearmSentinelAfterRefresh(fromSentinelTick: boolean) {
  if (!sentinelState || !activeTimers) return
  if (fromSentinelTick) {
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
  // 关键：任意来源的 refresh 失败都设置 forceSteadyAfterCooldown=true。
  // sentinelTick 在 cooldown 结束后的下一个 tick 入口消费它：忽略当前 PROBING
  // 状态，强制 STEADY 走主动 scheduled refresh。否则若 LLM 失败时
  // tokenSignal 已经把哨兵推进 PROBING，cooldown 一过下一 tick 就只 cacheModels
  // 而不刷 token——同 §10 中 scheduled-fail 的死锁。
  forceSteadyAfterCooldown = true
  return backoff
}

function noteSuccess(refreshInSeconds: number) {
  consecutiveFailures = 0
  failureCooldownUntil = 0
  // 成功刷新清掉强制 STEADY 标志，让 PROBING 频率档恢复正常。
  forceSteadyAfterCooldown = false
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
 * @param opts.fromSentinelTick - 仅 sentinelTick 内部调用时传 true，标记
 *   inflight 为 sentinel-owned。inflight 的 finally 据此决定 rearm 行为：
 *   sentinel-owned 走 dirtyAfterTick；否则立即 clear + scheduleNext。
 *   外部调用方（LLM 路径 / 测试 / dashboard）**不要**设置此选项。
 */
export interface RefreshNowOptions {
  fromSentinelTick?: boolean
}

export async function refreshNow(
  reason: RefreshReason,
  attemptedToken?: string,
  opts: RefreshNowOptions = {},
): Promise<RefreshResult> {
  // ── 1. 短路：state 已经比 caller 用的更新 → 直接让其重试 ──
  if (attemptedToken && state.copilotToken !== attemptedToken) {
    // refreshInSeconds=null 表示"没有访问上游、不要据此重排调度"
    return { ok: true, tokenWasUpdated: true, refreshInSeconds: null }
  }

  // ── 2. single-flight：所有并发调用共享同一个 Promise ──
  //     注意：复用现有 inflight 时，opts.fromSentinelTick 被**忽略**。
  //     inflight 的 finally 只看建立它的那一次调用的 fromSentinelTick——
  //     这与 inflightFromSentinelTick 模块变量一致。
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

  // ── 5. Capture generation 与 fromSentinelTick：用于 inflight 完成时判定 ──
  const myGeneration = generation
  const fromSentinelTick = opts.fromSentinelTick === true
  inflightFromSentinelTick = fromSentinelTick

  inflight = (async () => {
    try {
      const { token, refresh_in } = await getCopilotToken()

      // ── 旧 loop 兜底：若 bootstrap()/stop() 已经切到新 generation，
      //    本次刷新视为废弃：不写 state、不调 noteSuccess、不 rearm ──
      if (myGeneration !== generation) {
        logger.debug("refreshNow result discarded (stale generation)", {
          reason,
          myGeneration,
          currentGeneration: generation,
        })
        return { ok: true, tokenWasUpdated: false, refreshInSeconds: null }
      }

      const oldToken = state.copilotToken
      state.copilotToken = token       // I-1 的唯一写入点
      noteSuccess(refresh_in)
      return {
        ok: true,
        tokenWasUpdated: token !== oldToken,
        refreshInSeconds: refresh_in,
      }
    } catch (error) {
      // 失败时同样校验 generation：旧 loop 的失败不该影响新 loop 的 cooldown
      if (myGeneration !== generation) {
        logger.debug("refreshNow failure discarded (stale generation)", {
          reason,
          error: String(error),
        })
        return {
          ok: false,
          error: new Error("stale generation"),
          cooldownMs: 0,
        }
      }
      const cooldownMs = noteFailure()
      logger.error("refreshNow failed", {
        reason,
        consecutiveFailures,
        cooldownMs,
        error: String(error),
      })
      return { ok: false, error, cooldownMs }
    } finally {
      // 注意：清 inflight 与 rearm 只对当前 generation 生效
      if (myGeneration === generation) {
        inflight = null
        inflightFromSentinelTick = false
        // 任何状态变化（成功 → lastRefreshInSeconds；失败 → cooldown）
        // 都必须 rearm 哨兵 timer，否则挂起的 tick 仍按旧调度等。
        rearmSentinelAfterRefresh(fromSentinelTick)
      }
      // 若 generation 已切换：新 loop 的 inflight 已是 null（teardown 时清过），
      // 新 loop 自己的 refreshNow 调用会重新设置；这里不动它。
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
- **`refreshNow` 内 rearm 哨兵 timer，分两条路径（关键）**：`finally` 调 `rearmSentinelAfterRefresh(fromSentinelTick)`：
  - **非 sentinel-owned inflight 完成**（LLM 路径 / 测试外部）：立刻 clear 当前 `pendingTimeoutHandle` 并跑 `scheduleNext`，把哨兵 timer 按最新 `lastRefreshInSeconds` / `cooldownRemaining` 重排。**这是后台失败后无需 LLM 唤醒就自动恢复的机制**。
  - **sentinel-owned inflight 完成**（哨兵自己 await 的那次 refreshNow）：仅置 `dirtyAfterTick=true` 标志，由 tick 末的 `scheduleNext` 统一收尾。避免双挂起 timer。
  - **判据从全局可变状态改为 per-call 绑定**：旧版 `suppressRearm` 是模块全局 `let`，外部 LLM 复用 inflight 的复用路径（Promise finally 早于 await continuation 执行）会读到 `suppressRearm=true`，被误判为"内部调用"——LLM "立即 rearm" 承诺失效。改为 `opts.fromSentinelTick` 由建立 inflight 的调用者传入，inflight 自己持有这个标志（`inflightFromSentinelTick`），不再受 await/finally 时序影响。
  - **外部 LLM 复用 inflight 的语义**：当 inflight 已存在，外部 caller 在第 2 步 single-flight 检查 `if (inflight) return inflight` 处直接拿到 Promise，**不进入** finally 块。整个 inflight 生命周期只跑**一次** finally——按建立者的 `fromSentinelTick` 决定 rearm 行为。这与"sentinel-owned 期间 tick 末统一 scheduleNext"是一致的：tick 末必然跑 `scheduleNext`，timer 不会丢。
- **`forceSteadyAfterCooldown` 让任意来源失败都防 PROBING-cooldown 死锁**：`noteFailure()` 设置该标志，下一次 `sentinelTick` 入口在 cooldown 已过且 mode==probing 时强制压回 STEADY。这覆盖了 `scheduled-fail` / `sentinel-401-fail` / **`llm-401-fail`** / `manual-fail` 全部触发源。`noteSuccess()` 在成功刷新时清零。`tickFailed: true` 仍保留——它处理"同 tick 内 scheduled-fail 后立即排下一 tick"的子场景，与 `forceSteadyAfterCooldown` 是互补的两层。
- **`generation` 兜底 stale loop（关键）**：`bootstrap()` / `teardownInternal()` 递增 `generation`。`refreshNow` 在发起时 capture 当前 generation，inflight 完成时校验 `myGeneration === generation`：
  - 成立：正常写 `state.copilotToken` / `noteSuccess` / `rearm`；
  - 不成立：废弃刷新结果——**不写 state、不调 noteSuccess/noteFailure、不动 cooldown、不 rearm**。
  - 这保证旧 loop 在 `getCopilotToken()` 中飞着时被 `stop()` / `bootstrap()` 切换，旧请求完成不会污染新 loop 的 token / 失败计数 / timer。
- **`sentinelTick` 入口清 `pendingTimeoutHandle`**：timer 已经触发，handle 不再代表"未来挂起"。保持 `pendingTimeoutHandle` 语义为"仅指向未来一次挂起 timer"，让 rearm 路径行为可预测。
- **`bootstrap` 防重入 + generation 递增**：开头检测已有活动 loop 时先 `teardownInternal()` 清旧 timer（`teardownInternal` 内递增 `generation`）再建新。`setupCopilotToken({force})` 重复初始化或测试套件中反复 bootstrap 不会产生并行 loop，旧 inflight 即使飞着也不会污染新 state。
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

**底层 helper 必须新增**：现有 `copilotHeaders(state, vision?)` （`packages/proxy/src/lib/api-config.ts:29`）会在内部直接读 `state.copilotToken` 拼 `Authorization`。如果 `snapshotAuth()` 一边读出 token 一边调用它，仍会发生"读了 token 又被它二次读 state"的分裂。所以方案的硬性要求是：

```ts
// packages/proxy/src/lib/api-config.ts —— 新增

// 参数 token 类型放宽为 string | null：
//   - 保持旧 copilotHeaders(state) 的形为兼容（state.copilotToken 本就是
//     string | null，wrapper 直接转发不需要额外 guard）；
//   - 调用方 snapshotAuth 在自己侧的 missing-token guard 之后传入非空 token,
//     语义不受影响；
//   - 内部用 String(token ?? "") 兜底，确保不会出现 "Bearer null" 这种字面量
//     （即使绕过 guard 直接调到这里，最差也是 "Bearer "，仍会被上游 401 拒，
//     但行为可观察）。
export function copilotHeadersForToken(
  state: State,
  token: string | null,
  vision: boolean = false,
): Record<string, string> {
  // 与 copilotHeaders 完全等价的实现，但 Authorization 用传入的 token，
  // 不再读 state.copilotToken。所有其它 header 仍按 state 派生
  // （version / vision / x-request-id 等）。
  // Authorization: `Bearer ${token ?? ""}`
}

// 原 copilotHeaders 改成调用 copilotHeadersForToken
// （正常 token 场景行为零变化；state.copilotToken == null 时旧实现会拼出
// "Bearer null"，新实现拼出 "Bearer "——两者都是异常路径，但后者更安全。）：
export const copilotHeaders = (state: State, vision: boolean = false) =>
  copilotHeadersForToken(state, state.copilotToken, vision)
```

这样：
- 旧调用方在正常 token 场景行为零变化（`copilotHeaders(state)` 仍按 state 当前 token 拼）；`state.copilotToken == null` 的异常路径从"Bearer null"变为"Bearer "，两者都不可用但后者不会把字面 "null" 当 token 上送。
- `snapshotAuth()` 内部用 `copilotHeadersForToken(state, capturedToken, vision)`，杜绝二次读 state。
- 单测可以验证"传入 token A 后，即使期间换 state.copilotToken = B，返回 headers 中 Authorization 仍是 A"。

**四个 client 的 `SnapshotOptions` 差异（实施时必须保留各自现有 headers 形状）**：

| Client | SnapshotOptions 字段 | snapshotAuth 内部基于 `copilotHeadersForToken(state, token, vision)` 之上叠加 |
|---|---|---|
| `copilot-openai` | `{ enableVision: boolean; isAgentCall: boolean }` | + `X-Initiator: agent\|user` |
| `copilot-responses` | `{ enableVision: boolean; isAgentCall: boolean }` | + `X-Initiator: agent\|user` |
| `copilot-native` | `{ anthropicBeta: string \| null; visionRequest: boolean; isAgentCall: boolean }` | + `anthropic-version: 2023-06-01` + 可选 `anthropic-beta` + `X-Initiator`（vision header 由 `copilotHeadersForToken` 的 `vision` 参数承担） |
| `copilot-embeddings` | `{}` 或 `undefined`（无差异化字段） | 直接 = `copilotHeadersForToken(state, token, false)` |

**实施约束**：

1. `snapshotAuth(options)` 必须返回**与现有路径完全等价**的 headers——只是把"两步读"合成"一步读"。不允许借此机会增删字段。
2. `SnapshotOptions` 字段命名应与各 client 内部已有的派生量（`enableVision` / `isAgentCall` / `anthropicBeta` / `visionRequest`）一致，避免引入新概念。
3. `getHeaders()` / `getToken()` 保留：现有非 401 的同步路径（如 dashboard 查询）仍可继续用，渐进迁移。
4. **新增 `copilotHeadersForToken` 是方案前置条件**：阶段 2 实施时必须先合入 `api-config.ts` 的拆分，再做 client 层迁移。

默认 factory（`defaultCopilotXxxConfig`）：

```ts
snapshotAuth: (options) => {
  const token = state.copilotToken    // 唯一一次读
  // 与现有各 client getToken() 一致的 missing-token guard：
  // state.copilotToken 类型是 string | null，bootstrap 之前 / 强制重置后短暂为 null。
  // 没有这层检查会产生 "Authorization: Bearer null" 发上游，触发难定位的 401。
  if (!token) throw new Error("Copilot token not found")
  return {
    token,
    headers: { ...copilotHeadersForToken(state, token, options?.enableVision ?? false),
               "X-Initiator": options?.isAgentCall ? "agent" : "user" }
  }
}
```

每个 client 的默认 factory 都必须保留这层 guard；mock factory 在测试中可以注入返回 `token: ""` 来覆盖"被 stop 后 LLM 仍尝试请求"的边界场景。

单测可以注入 mock 来模拟"两次读取之间 token 变化"的竞态场景。

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

**TimerFactory 接口必须扩展**：现有 `packages/proxy/src/lib/token.ts:23` 的 `TimerFactory` 是 `{ setInterval, clearInterval, setTimeout }`，**缺 `clearTimeout`**。本设计完全弃用 `setInterval` / `clearInterval`，改用 `setTimeout` 链 + `clearTimeout` 主动重排。阶段 1 实施时必须先：

```ts
// 变更后的 TimerFactory
export interface TimerFactory {
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  // setInterval / clearInterval 不再需要——可以从接口移除
}

const defaultTimers: TimerFactory = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
}
```

测试中的 fake-timer 实现也对应只需 `setTimeout` / `clearTimeout`，不再 mock interval-类 API。

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
  dirtyAfterTick = false

  // 消费 forceSteadyAfterCooldown：上一次任意来源的 refresh 失败后留下的
  // 强制 STEADY 标志。cooldown 已过、此 tick 一定主动 scheduled refresh。
  // 注：本标志只 _覆盖一次_ 进入 PROBING 的判断，由 noteSuccess 在下次
  // 成功后清零；中间若再次失败仍会保持 true。
  const inCooldown = getRefreshCooldownRemaining() > 0
  if (forceSteadyAfterCooldown && !inCooldown && s.mode === "probing") {
    s.mode = "steady"
    s.remainingProbeTicks = 0
  }

  try {
    // ── STEADY: 主动 scheduled refresh ──
    // ── PROBING: 不主动 refresh ──
    //
    // 注意：cooldown 优先级最高——即使本来要 PROBING 探活，也由
    // scheduleNext 的优先级链统一压回 cooldown 间隔；这里直接 short-circuit。
    if (s.mode === "steady" && !inCooldown) {
      // 用 { fromSentinelTick: true } 标记 inflight 为 sentinel-owned。
      // 该标志被 inflight 自己持有（inflightFromSentinelTick），不受
      // await 时序影响：
      //   - 哨兵 await 完毕、tick 末 scheduleNext 收尾——不重复 rearm。
      //   - 外部 LLM 复用同一个 inflight 时，走"快路径"return inflight,
      //     finally 只跑一次，由建立者的 fromSentinelTick 决定行为——
      //     按设计就是 sentinel-owned，置 dirty。
      //   - 外部 LLM 在 inflight 未建立时自己发起 refreshNow，建立的是
      //     非 sentinel-owned inflight，finally 走立即 rearm。
      const result = await refreshNow("scheduled", undefined, { fromSentinelTick: true })
      if (!result.ok) {
        logger.warn("scheduled refresh failed in steady tick", {
          error: String(result.error),
          cooldownMs: result.cooldownMs,
        })
        // 失败已写入全局 cooldown 与 forceSteadyAfterCooldown。本 tick 走
        // scheduleNext，按 cooldown 间隔安排下一 tick；不访问 /models。
        scheduleNext(s, timers, { tickFailed: true })
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
          await refreshNow("sentinel-401", undefined, { fromSentinelTick: true })
          // 本 tick 不递归 cacheModels
        } else {
          logger.warn("sentinel /models failed (non-auth)", { error: String(e) })
        }
      }
    }

    // I-Order: 先判 PROBING 再 decay，避免单次跨阈值信号被 tick 头部衰减抵消。
    scheduleNext(s, timers)
    tokenSignal.decay()
  } catch (fatal) {
    // I-4: 任何意外异常都不让 loop 死。fatal 路径也走 scheduleNext
    // （统一优先级 cooldown > PROBING > STEADY），避免在 cooldown 期间
    // 因 fatal 把下一 tick 错放到 steady 周期，跳过冷却。
    logger.error("sentinel tick fatal", { error: String(fatal) })
    scheduleNext(s, timers, { tickFailed: true })
  } finally {
    dirtyAfterTick = false
  }
}

/**
 * 优先级：失败冷却 > PROBING > STEADY 周期
 *
 * 把 cooldown 放在 PROBING 之前的原因：
 *   - PROBING 是"密集探活 cacheModels"——如果当前正在 cooldown，探活
 *     大概率会撞 401 但又无法刷 token，纯浪费上游配额。
 *   - cooldown 期间 sentinelTick 内 inCooldown=true 也已跳过 cacheModels
 *     与 scheduled refresh，所以这层选择确保连"以更短间隔再次空跑"也不发生。
 *
 * tickFailed 选项：sentinelTick 出现 scheduled refresh 失败或 fatal 异常时
 * 传入。这种 tick 的 mode 切换被强制压回 steady，避免"refresh 失败后被
 * PROBING 接管，cooldown 结束后又只 cacheModels 不刷 token"的死锁。
 */
function computeNextDelay(mode: "steady" | "probing"): number {
  const cooldown = getRefreshCooldownRemaining()
  if (cooldown > 0) return cooldown
  if (mode === "probing") return PROBE_INTERVAL_MS
  return currentSteadyIntervalMs()
}

function scheduleNext(
  s: SentinelState,
  timers: TimerFactory,
  opts: { tickFailed?: boolean } = {},
) {
  if (opts.tickFailed) {
    // refresh 失败或 fatal：强制 STEADY，让 cooldown 结束后下一次 tick
    // 必然走"主动 scheduled refresh"路径，不被 PROBING 截胡。
    s.mode = "steady"
    s.remainingProbeTicks = 0
  } else {
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
  }

  const nextMs = computeNextDelay(s.mode)
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
  // 递增 generation：任何已飞行的 refreshNow inflight 完成时会发现
  // myGeneration !== generation，直接废弃结果，不写 state、不动 cooldown、
  // 不 rearm。这堵住"旧 loop 的飞行刷新污染新 loop"的窗口。
  generation += 1
  // 同时清掉旧 loop 留下的失败状态，让新 loop 从干净状态开始
  failureCooldownUntil = 0
  consecutiveFailures = 0
  forceSteadyAfterCooldown = false
  // 不主动清 inflight：旧 inflight 仍然挂着，但任何外部 await 它的代码
  // 会拿到 stale-generation 包裹的"ok:true, tokenWasUpdated:false" 结果，
  // 安全降级为不重试。新 loop 自己的 refreshNow 调用会重新设置 inflight。
  // 不清 dirtyAfterTick：那是 tick 同步上下文的瞬态。
}

export function bootstrap(opts: BootstrapOptions): SentinelHandle {
  const timers = opts.timers ?? defaultTimers

  // 防重入：如果已经有活动 loop，先清掉（含递增 generation）
  if (sentinelState || pendingTimeoutHandle) {
    logger.warn("sentinel.bootstrap called while loop is active; resetting")
    teardownInternal()
  }

  // 重置 inflight：上一代的 inflight Promise（如有）继续在后台 await
  // getCopilotToken，但它的 finally 因 generation 不匹配会废弃结果。
  // 这里把 module-level inflight 清空，让新 loop 的 refreshNow 能创建
  // 自己的 inflight，不会被旧 Promise 误复用。
  inflight = null
  inflightFromSentinelTick = false
  dirtyAfterTick = false

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
- **cooldown 优先级最高，期间彻底静默**：`sentinelTick` 进入时若 `inCooldown` 为真则**同时跳过 scheduled refresh 和 cacheModels**；`computeNextDelay` 优先级是 cooldown > PROBING > STEADY。这保证冷却期内既不打 token 接口、也不打 `/models`，连 PROBING 上下文都被冷却覆盖——anti-ban 视角下的完整静默。
- **PROBING 不主动 refresh**：避免与 LLM 路径触发的 `refreshNow` 重复访问上游；它的角色是"高频探活，给最近的刷新结果做即时复核"。在 cooldown 期间也不会真的探活（见上一条）。
- **`tickFailed` 强制压回 STEADY（防 PROBING-cooldown 死锁）**：scheduled refresh 失败或 fatal 异常发生时，`scheduleNext` 用 `tickFailed: true` 跳过"信号 → PROBING"的 mode 切换，强制 `s.mode = "steady"`。否则会进入这种死锁：cooldown 结束后下一 tick 因 PROBING 接管而**只 cacheModels 不刷 token**，token 永远不会被主动 refresh，要靠 `/models` 撞 401 才能恢复。`tickFailed` 保证 cooldown 一过就立刻再次尝试 scheduled refresh。
- **fatal 路径走统一的 `scheduleNext({tickFailed: true})`**：抽出 `computeNextDelay()` 复用，保证 fatal 发生在 cooldown 期间时下一 tick 仍按 cooldown 间隔（而非误按 steady 周期）。
- **`decay()` 在判 PROBING 之后**：旧顺序"tick 头 decay → 判阈值"会让 score 正好等于阈值的单次 token-expired 信号被衰减后落到阈值之下，无法进入 PROBING。新顺序先用 `shouldProbeNow()` 判断本 tick 的目标 mode，再 decay，让阈值语义保持"score ≥ 5 即触发"。
- **`SentinelState` 极简**：只保留 `mode` 与 `remainingProbeTicks`。所有周期值（`steadyIntervalMs` / 冷却剩余）每次从 module-global 重新计算，避免"local 副本与 global 值不同步"的隐性 bug。
- **单一 bootstrap 入口**：`bootstrap({ token, refreshInSeconds, timers })` 一个函数同时完成写入首把 token + 初始化 timer state + 启动 loop，返回 `{ stop }` 句柄。删除原来 `bootstrap` + `startTokenSentinel` 双入口的歧义。
- **setTimeout 链而非 setInterval**：每个 tick 完整结束才安排下一次，从根本上杜绝重入。挂起 handle 存放在 module-global `pendingTimeoutHandle`，给 `rearmSentinelAfterRefresh` 和 `stop()` 使用。
- **fatal try/catch 双层**：即使 `scheduleNext` 抛异常（不应该发生）也要保证下一次 tick 被安排（外层 catch 会再调一次 `scheduleNext({tickFailed: true})`）。

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
  // ── 先 stop 旧 handle，让"setup-级 getCopilotToken 与旧 sentinel inflight
  //    短暂并存"的窗口尽量短 ──
  // I-2 已明确把 setupCopilotToken 重入列为显式例外（见 §2 / §5）。
  // teardownInternal() 内部递增 generation，旧 inflight 完成时结果被废弃；
  // 这里再 await getCopilotToken() 是合法的 setup-级请求，不算并发 refresh。
  if (sentinelHandle) {
    sentinelHandle.stop()
    sentinelHandle = null
  }

  const { token, refresh_in } = await getCopilotToken()
  // 单一入口：写入 + 启动 loop 都交给 sentinel.bootstrap
  sentinelHandle = sentinel.bootstrap({ token, refreshInSeconds: refresh_in, timers })
  logger.debug("GitHub Copilot Token fetched successfully!")
}
```

**关于 I-2 在 setupCopilotToken 重入时的保证**：

- I-2（§5）已明确将 single-flight 约束**窄化为"经由 `sentinel.refreshNow()` 的刷新"**。`setupCopilotToken` 在 stop 旧 sentinel + bootstrap 新 sentinel 的窗口内直接 await 的 `getCopilotToken()` 是 setup-级请求，**不在 I-2 的约束范围内**，是该不变量的显式例外。
- 旧 loop 的 scheduled refresh 可能仍 in flight。`stop()` 仅 clear timer + 递增 generation，**不会**取消已发出的 `getCopilotToken()` HTTP 请求——它会跑完，但 finally 校验 generation 不匹配 → 结果被丢弃。
- 紧接着 `setupCopilotToken` 自己 await 的 `getCopilotToken()` 是新的、独立的请求。
- 瞬时确实有"两条 in-flight token 请求"（旧的将要被废弃 + 新的会被新 bootstrap 采纳），但 **module-level inflight 已被 stop 清零**，外部 `refreshNow()` 调用方不会复用旧 Promise。从"上游访问频次"角度看，这是 setupCopilotToken 重入语义下不可避免的成本——可以接受，因为它只在用户显式 force-refresh 时发生，不会形成风暴。
- 如果未来需要把"首次/强制刷新也纳入 sentinel single-flight"（让 I-2 完全无例外），可改造 `setupCopilotToken` 调一个新的 `sentinel.bootstrapAsync({ timers })`——由 sentinel 自己 `refreshNow("manual")` 拿 token 后再启动 loop。本文档暂不引入这层间接，保持现有调用面。

这样 `state.copilotToken` 在整个代码库中只有一个写入文件（`token-sentinel.ts`），I-1 的 grep 验收稳定通过。

**关停**：测试或 shutdown 调用 `sentinelHandle.stop()`——内部清理 `pendingTimeoutHandle` / `sentinelState` 并递增 generation。无显式 graceful shutdown 协议（与现有 systemd / dev 流程一致）。

---

## 12. 失败与边界

| 场景 | 哨兵行为 | LLM 路径行为 | 用户感知 |
|---|---|---|---|
| `/models` 上游瞬时 5xx | 当前 tick 标记失败 | 不受影响 | 无 |
| `/models` 返回 401 | refreshNow（single-flight）；本 tick 不再递归 cacheModels，refreshNow rearm 哨兵 timer 让下一 tick 立刻按新状态计算 | 不受影响 | 无 |
| 单次 LLM 401 + token-expired 文案 | 接收信号；in-flight refresh 复用；成功后 rearm timer → 哨兵立刻按新 refresh_in 重排 | await + 重试一次 | 无（无感） |
| 并发 N 个 LLM 401 + token-expired | 收到 N 条信号；refresh 只跑 1 次；rearm 仅触发一次 | 全部 await 同一个 Promise → 各自重试 | 无（无感） |
| **哨兵 cacheModels 期间外部 LLM 并发 401** | 此时 inflight 已不存在（哨兵 scheduled refresh 已结束）。外部 LLM 调 `refreshNow("llm-401")` 建立新的、非 sentinel-owned inflight → finally 立即 clear + rearm，不等 tick 结束 | await + 重试一次 | 无（无感）；后台立即恢复 |
| **哨兵 scheduled refresh 进行中外部 LLM 并发 401** | LLM 路径复用同一个 sentinel-owned inflight → 不重复建 inflight；finally 跑一次，按"sentinel-owned"置 dirty，tick 末 scheduleNext 收尾 | await 同一 Promise → 拿到刷新结果后重试一次 | 无（无感） |
| LLM 401 但文案不命中 token-expired | 接收信号（other-401，权重 1） | 直接抛 401 | 用户看见 401；后续请求由哨兵 tick 兜底 |
| LLM 路径触发 `refreshNow` 失败 | 进入全局 cooldown（5s 起，×2 上限 5min）+ `forceSteadyAfterCooldown=true`；**rearm 哨兵 timer → 下一 tick 在 cooldown 结束时触发，强制 STEADY 走主动 scheduled refresh，不被 PROBING 截胡** | 不重试，原 401 抛出 | 单次 401，cooldown 后台自动恢复 |
| Scheduled 触发 `refreshNow` 失败 | cooldown + scheduleNext({tickFailed:true}) 强制 mode=steady；本 tick 直接 return，不再 cacheModels；**cooldown 结束后下一 tick 必然走主动 scheduled refresh**（不被 PROBING 截胡） | 不受影响 | 无（短暂内部静默） |
| **冷却期内任意触发源调 `refreshNow`** | 直接返回 `ok:false, cooldownMs>0`，**不敲上游** | 不重试，原 401 抛出 | 用户看见 401，但不会引发上游访问风暴 |
| 冷却期内哨兵 tick 到来 | `sentinelTick` 入口检测 cooldown：跳过 scheduled refresh + cacheModels；`computeNextDelay` 下一 tick 间隔 = `cooldownMs` | 不受影响 | 无 |
| 冷却 + PROBING 同时存在 | cooldown 优先级高于 PROBING；既不刷 token 也不探活 `/models` | 不受影响 | 无 |
| `refreshNow` 成功但 token 字面没变 | 返回 `tokenWasUpdated=false`；仍 rearm（防止上游变 refresh_in） | 不重试 | 用户看见 401（防止白重试） |
| LLM 重试仍 401 | 不二次触发 refresh（I-5） | 抛出重试响应的 HTTPError | 用户看见 401 |
| 哨兵 tick 抛任意异常 (fatal) | 外层 catch 调 `scheduleNext({tickFailed:true})`，下一 tick 按统一优先级（cooldown > PROBING > STEADY）安排；I-4 不死锁 | 不受影响 | 无 |
| **bootstrap 被重复调用 / stop() 触发** | `teardownInternal()` 递增 generation；旧 inflight 完成时 `myGeneration !== generation` → 废弃结果，不写 state、不动 cooldown、不 rearm 新 loop | 旧请求拿到 `tokenWasUpdated=false`，不重试 | 无 |
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

- **TimerFactory 扩展**：现有 `packages/proxy/src/lib/token.ts` 的 `TimerFactory` 改为 `{ setTimeout, clearTimeout }`，删 `setInterval` / `clearInterval`（哨兵不再用）。
- 新增 `packages/proxy/src/lib/token-signal.ts`，但**只提供 no-op 实现**：`reportAuthFailure` / `decay` 为空函数，`shouldProbeNow` 恒返回 `false`，`readScore` 恒返回 `0`。这是为了让阶段 1 的 sentinel 主循环（已经引用 `tokenSignal.shouldProbeNow / decay`）能稳定编译运行，但 PROBING 路径在阶段 1 永不被触发。完整实现留到阶段 2。
- 新增 `packages/proxy/src/lib/token-sentinel.ts`，包含 `refreshNow(reason, attemptedToken?, { fromSentinelTick? })`（含全局 cooldown + generation 校验 + per-call rearm 绑定）+ `noteSuccess/Failure`（含 `forceSteadyAfterCooldown` 跨触发源标志）+ tick loop（STEADY 状态机 + 主动 scheduled refresh + cooldown 期间静默 + 入口消费 `forceSteadyAfterCooldown` + `scheduleNext({tickFailed})` 双层死锁防御；调用 no-op tokenSignal）+ **单一入口 `bootstrap({ token, refreshInSeconds, timers })`** 返回 `{ stop }` 句柄（含 generation 递增）+ 周期辅助 `getLastRefreshInSeconds` / `getRefreshCooldownRemaining` / `computeNextDelay`。
- 删除 `scheduleTokenRefresh` / `retryTokenRefresh` / `refreshModelsForToken`；`setupCopilotToken` 改为**先 stop 旧 sentinelHandle 再** `await getCopilotToken()` 再 `sentinel.bootstrap(...)`（见 §11），不再直接写 `state.copilotToken`。
- LLM 路径完全不动。
- 单测：fake timers（`setTimeout` / `clearTimeout` 双 API）+ mocked fetch，验证 STEADY 周期、**主动 scheduled refresh**、**上游 refresh_in 变化即重排（含 timer rearm）**、**任意触发源失败均进入 module-global cooldown + 设置 forceSteadyAfterCooldown + rearm**、**cooldown 期间完全静默（不刷 token、不打 /models）**、**任意来源失败（scheduled / sentinel-401 / llm-401）后 cooldown 结束的下一 tick 都走 STEADY**、**fatal 路径走统一 scheduleNext（cooldown 期间不误走 steady 周期）**、**bootstrap 重入 / stop 后旧 inflight 走 generation 隔离**、**setupCopilotToken 重入按 stop → await → bootstrap 的顺序串行执行**（断言 stop 在新 `getCopilotToken()` 发起前完成；setup-级请求与旧 sentinel 的 in-flight 刷新短暂并存属预期，旧 inflight 完成时被 generation 隔离丢弃）、**inflight 复用走 sentinel-owned dirty 路径、新建 inflight 走立即 rearm**、refresh-on-401、单 flight、min-interval、`attemptedToken` 短路、I-4 不死锁、`stop()` 干净取消挂起 tick。
- **PROBING 相关测试**（信号累积、阈值进入 PROBING、cooldown 优先级压过 PROBING、forceSteadyAfterCooldown 让 PROBING 不接管 cooldown 后的 STEADY 等）**留到阶段 2**——阶段 1 的 no-op tokenSignal 让 `shouldProbeNow` 恒为 false，相关分支自然走 STEADY，不需要专门覆盖。
- **本阶段不解决用户体验问题**，只把单写者 + scheduled refresh 的语义统一到哨兵。可独立合入。

**阶段 2 — 等待 + 重试 + 信号（独立 PR，恢复 PR #129 的用户体验目标）**

- **`copilotHeadersForToken` 拆分**：在 `packages/proxy/src/lib/api-config.ts` 新增 `copilotHeadersForToken(state, token, vision)`，让原 `copilotHeaders` 调用它。这是 `snapshotAuth` 原子读 token 的前置条件（见 §9）。
- **替换 token-signal.ts 的 no-op 实现为完整版本**：score 累积、decay、阈值判定都接入；保持接口签名不变，所以哨兵 tick 内引用不变。
- **在 `CopilotXxxConfig` 上引入 `snapshotAuth()` 原子方法**（见 §9），底层调 `copilotHeadersForToken`；保留 `getToken()` / `getHeaders()` 给现有非 401 路径。
- 四个 upstream client 加 401 → `await sentinel.refreshNow("llm-401", usedToken)` + 单次重试，token 与 headers 通过 `snapshotAuth()` 同源读取。
- **PROBING 路径自然激活**：阶段 1 已写好的 PROBING 分支因为 no-op tokenSignal 永不进入；阶段 2 替换为真实实现后，`shouldProbeNow` 在阈值跨越时返回 true，PROBING 自然启用，无需新增哨兵代码。
- 单测：信号累积、衰减、阈值边界；**PROBING 状态机**（信号阈值进入 PROBING、N tick 内无新信号回 STEADY、cooldown 优先级压过 PROBING、forceSteadyAfterCooldown 让 PROBING 不接管 cooldown 后的 STEADY、score 正好等于阈值进入 PROBING 的 decay 顺序断言）；LLM 客户端 401 重试矩阵（文案命中/不命中 × 刷新成功/失败/冷却中 × tokenWasUpdated true/false × 重试 ok/fail）；`snapshotAuth` 原子读出 token 与 headers 中的 Authorization 一致；**`snapshotAuth` 输出的 headers 与重构前 fixture 完全等价**（每个 client 的特征 header：openai/responses 的 `X-Initiator`+vision、native 的 `anthropic-*` 系列、embeddings 的 baseline）。
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
- **generation 隔离 stale loop**：bootstrap → 让 `getCopilotToken` mock 挂起（pending）→ 再次 bootstrap（generation+=1）→ 第一次的 `getCopilotToken` resolve；断言 `state.copilotToken` 等于新 bootstrap 的 token（不被旧请求覆盖），`consecutiveFailures` / `failureCooldownUntil` 没被旧请求触动，新 loop 的 `pendingTimeoutHandle` 未被旧请求 rearm 取消
- **generation 隔离 stale failure**：同上但旧 `getCopilotToken` reject；断言新 loop 的 cooldown 仍为 0
- **tick 内 refresh 不产生双 timer**：让 sentinelTick 内的 scheduled refresh 成功 → fake-advance 时间，断言下一次 sentinelTick 只触发 **1 次**（不是 2 次）；`setTimeout` 在 tick 范围内净增量 = 1
- **scheduled refresh 与外部并发 LLM 复用同一 inflight**：让 `getCopilotToken` mock 挂起；哨兵进入 tick 调 `refreshNow("scheduled", _, { fromSentinelTick: true })`；同时外部"LLM"代码也调 `refreshNow("llm-401", oldToken)`；mock resolve；断言 `getCopilotToken` 只被调一次，`clearTimeout` **不**被立即调用（按 sentinel-owned 路径置 dirty，tick 末 scheduleNext 收尾）
- **外部 LLM 在 inflight 已结束时建立新 inflight 走立即 rearm**：哨兵 scheduled refresh 已完成（inflight=null）；外部 LLM 调 `refreshNow("llm-401")` → 建立非 sentinel-owned inflight；resolve 后断言 `clearTimeout` 被立即调用 + 新 `pendingTimeoutHandle` 已建立
- **LLM 失败后 cooldown 结束的下一 tick 走 STEADY**：手动注入 score 触发 PROBING；调 `refreshNow("llm-401")` 让 `getCopilotToken` reject；fake-advance 至 cooldown 结束；断言下一 sentinelTick 触发了 `getCopilotToken("scheduled")`（不只是 cacheModels）。验证 `forceSteadyAfterCooldown` 对 LLM 触发源也生效
- **scheduled refresh 失败后 cooldown 结束的下一 tick 走 STEADY**：失败 → score 此时已超阈值进入 PROBING；fake-advance 至 cooldown 结束；断言下一 sentinelTick 触发了 `getCopilotToken("scheduled")`（不只是 cacheModels）。验证 `tickFailed: true` + `forceSteadyAfterCooldown` 双层死锁防御
- **fatal 在 cooldown 期间发生时下一 tick 走 cooldown 间隔**：注入一个让外层 catch 真正触发的 fatal——例如 mock `timers.setTimeout` 在 `scheduleNext` 中首次调用抛错（注意 `cacheModels` 异常会被内层 catch 吞掉，不会到达外层），或 mock `tokenSignal.decay` 抛错；在已有 cooldown 的状态下断言外层 catch 的 `scheduleNext({tickFailed:true})` 安排的下一 tick 间隔 = cooldownMs（不是 steady 周期）
- **`sentinelTick` 入口清 `pendingTimeoutHandle`**：tick 进入后立刻断言 `pendingTimeoutHandle === null`，直到 `scheduleNext` 末尾才被赋值
- **`stop()` 后 inflight 完成**：在 inflight refresh 仍在跑时调 `stop()`（generation+=1）→ 刷新 resolve 时 generation 不匹配 → 不写 state、不动 cooldown、不 rearm；测试断言 `state.copilotToken` 保持 stop 前的值

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
- **`snapshotAuth` token-missing guard**：把 `state.copilotToken` 设为 `null` / `undefined` / `""` 再调 `snapshotAuth()`，断言抛 `"Copilot token not found"`，**绝不返回 `Authorization: Bearer null`** 这类降级 header
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

### 旧实现下不再需要的测试

本节澄清：**不是不再测 401 重试**，而是不再测**旧分散实现**里的若干场景——刷新职责集中化后，那些场景的覆盖点变了。

- **不再需要**：旧"在每个 upstream client 内 wrap fetch、自己做 token 刷新 + 重试"实现下的 retry 矩阵。哪些 client 各自如何刷新 / 各自如何 single-flight，已经不存在——刷新只由 sentinel 跑。
- **不再需要**：各 client 各自的 single-flight 并发去重测试——module-level inflight + sentinel 单写者天然成立，由 `token-sentinel.test.ts` 集中验证一次即可。
- **仍然需要**（在阶段 2 client 测试矩阵中保留）：client 层"401 → await refreshNow → 至多重试一次"的完整矩阵。这是新设计下 LLM 路径自己的契约，与旧实现的散点 retry 是不同的覆盖点。

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
| Tick 内 / 外 refresh 区分 | **per-call `opts.fromSentinelTick` 绑定到 inflight (`inflightFromSentinelTick`) + `dirtyAfterTick`** | 不再用全局可变 `suppressRearm`，避免 Promise finally / await 时序导致的判读错误；外部 LLM 复用与新建 inflight 都得到正确 rearm 语义 |
| Scheduled-fail 后 mode 控制 | **`tickFailed: true` 同 tick 直接压回 STEADY** | 防止"本 tick 失败 → 末尾被信号推进 PROBING"导致间隔被错放 |
| 任意来源 fail 后跨 tick 防 PROBING-cooldown 死锁 | **`forceSteadyAfterCooldown` 模块标志，由 `noteFailure` 设置 / `noteSuccess` 清零** | 覆盖 scheduled / sentinel-401 / **llm-401** / manual 全部失败源 |
| 旧 loop 隔离 | **`generation` 模块计数器；`bootstrap`/`teardownInternal` 递增；inflight 完成时校验** | 防止旧 loop 飞行刷新污染新 loop 的 token / cooldown / timer |
| Fatal 路径 | **走统一 `scheduleNext({tickFailed:true})` + `computeNextDelay`** | cooldown 期间 fatal 不会误把下一 tick 放到 steady 周期 |
| Scheduled-fail 后 mode 控制 | **`tickFailed: true` 强制 `mode=steady`** | 防止"refresh 失败 → PROBING 接管 → cooldown 结束只 cacheModels 不刷 token"死锁 |
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

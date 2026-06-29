/**
 * Token signal channel — used by upstream clients to report auth failures.
 *
 * 阶段 1 提供 no-op 实现：
 *   - reportAuthFailure / decay 为空函数
 *   - shouldProbeNow 恒返回 false
 *   - readScore 恒返回 0
 *
 * 让 token-sentinel 的主循环可以无条件调用 tokenSignal.shouldProbeNow() /
 * decay() / reportAuthFailure()，但 PROBING 路径在阶段 1 永不触发。
 *
 * 阶段 2 把本文件替换为完整实现（score 累积 / decay / 阈值判定），接口签名
 * 保持不变。
 *
 * 见 docs/23-token-sentinel.md §8。
 */

export type AuthFailureReason = "token-expired" | "other-401"

export interface TokenSignal {
  reportAuthFailure(reason: AuthFailureReason): void
  shouldProbeNow(): boolean
  decay(): void
  /** For tests / metrics only. */
  readScore(): number
}

export const tokenSignal: TokenSignal = {
  reportAuthFailure(_reason: AuthFailureReason): void {
    // no-op (phase 1)
  },
  shouldProbeNow(): boolean {
    return false
  },
  decay(): void {
    // no-op (phase 1)
  },
  readScore(): number {
    return 0
  },
}

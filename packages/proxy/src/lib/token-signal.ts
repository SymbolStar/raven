/**
 * Token signal channel — used by upstream clients to report auth failures.
 *
 * 完整实现（阶段 2）：score 累积 + decay + 阈值判定。
 *
 * 决策语义（docs/23-token-sentinel.md §8）：
 *   - reportAuthFailure("token-expired") → score += 3
 *   - reportAuthFailure("other-401")     → score += 1
 *   - shouldProbeNow() → score >= SIGNAL_THRESHOLD (5)
 *   - decay()         → score = max(0, score - 1)
 *
 * 信号只决定 PROBING 频率档，**不决定**是否触发刷新——刷新决策由
 * client 直接调 refreshNow 完成。
 */

export type AuthFailureReason = "token-expired" | "other-401"

export interface TokenSignal {
  reportAuthFailure(reason: AuthFailureReason): void
  shouldProbeNow(): boolean
  decay(): void
  /** For tests / metrics only. */
  readScore(): number
}

const SIGNAL_THRESHOLD = 5
const SIGNAL_TOKEN_EXPIRED_WEIGHT = 3
const SIGNAL_OTHER_401_WEIGHT = 1

let score = 0

export const tokenSignal: TokenSignal = {
  reportAuthFailure(reason: AuthFailureReason): void {
    score += reason === "token-expired"
      ? SIGNAL_TOKEN_EXPIRED_WEIGHT
      : SIGNAL_OTHER_401_WEIGHT
  },
  shouldProbeNow(): boolean {
    return score >= SIGNAL_THRESHOLD
  },
  decay(): void {
    score = Math.max(0, score - 1)
  },
  readScore(): number {
    return score
  },
}

/** Test-only: reset internal score to 0. Production code never calls this. */
export function _resetTokenSignalForTest(): void {
  score = 0
}

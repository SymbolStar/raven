import { describe, expect, test } from "vitest"

import { tokenSignal } from "../../src/lib/token-signal"

describe("tokenSignal (phase 1: no-op)", () => {
  test("readScore is always 0", () => {
    expect(tokenSignal.readScore()).toBe(0)
  })

  test("shouldProbeNow is always false", () => {
    expect(tokenSignal.shouldProbeNow()).toBe(false)
  })

  test("reportAuthFailure does not change score", () => {
    tokenSignal.reportAuthFailure("token-expired")
    tokenSignal.reportAuthFailure("other-401")
    expect(tokenSignal.readScore()).toBe(0)
    expect(tokenSignal.shouldProbeNow()).toBe(false)
  })

  test("decay does not throw and keeps score at 0", () => {
    tokenSignal.decay()
    expect(tokenSignal.readScore()).toBe(0)
  })
})

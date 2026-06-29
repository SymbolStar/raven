import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"

import { state } from "../../src/lib/state"
import { HTTPError } from "../../src/lib/error"
import type { TimerFactory } from "../../src/lib/token"

// ---------------------------------------------------------------------------
// Mocks — must register BEFORE importing token-sentinel.ts
// ---------------------------------------------------------------------------

const getCopilotTokenMock = vi.fn()
const cacheModelsMock = vi.fn()

vi.mock("../../src/services/github/get-copilot-token", () => ({
  getCopilotToken: (...args: unknown[]) =>
    getCopilotTokenMock(...args) as Promise<{ token: string; refresh_in: number; expires_at: number }>,
}))

vi.mock("../../src/lib/utils", () => ({
  cacheModels: cacheModelsMock,
  sleep: () => Promise.resolve(),
  isNullish: (v: unknown) => v === null || v === undefined,
}))

const {
  refreshNow,
  bootstrap,
  getRefreshCooldownRemaining,
  getLastRefreshInSeconds,
  _debugSnapshot,
} = await import("../../src/lib/token-sentinel")

// ---------------------------------------------------------------------------
// Fake timers — controllable clock + setTimeout/clearTimeout only.
// Date.now is advanced together so token-sentinel's time-based logic
// (min-interval, cooldownRemaining) reacts correctly.
// ---------------------------------------------------------------------------

const REFRESH_INITIAL_BACKOFF_MS_ASSERT = 5_000

interface FakeTimer {
  callback: () => unknown
  ms: number
  scheduledAt: number
  id: number
  cleared: boolean
  fired: boolean
}

interface FakeTimerHarness {
  factory: TimerFactory
  timers: FakeTimer[]
  advance(ms: number): Promise<void>
  flushPending(): Promise<void>
  now(): number
}

function createFakeTimers(): FakeTimerHarness {
  let nextId = 1
  // Anchor at a non-zero base so `lastSuccessAt > 0` guard in refreshNow
  // engages correctly (production never sees Date.now() == 0).
  const CLOCK_BASE = 1_000_000_000_000 // Sep 2001
  let clock = CLOCK_BASE
  const timers: FakeTimer[] = []
  vi.setSystemTime(clock)

  const factory: TimerFactory = {
    setInterval: (() => {
      throw new Error("sentinel must not use setInterval")
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {
      throw new Error("sentinel must not use clearInterval")
    }) as unknown as typeof globalThis.clearInterval,
    setTimeout: ((cb: () => unknown, ms: number) => {
      const id = nextId++
      timers.push({
        callback: cb,
        ms,
        scheduledAt: clock,
        id,
        cleared: false,
        fired: false,
      })
      return id as unknown as ReturnType<typeof globalThis.setTimeout>
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      const t = timers.find((t) => t.id === id)
      if (t) t.cleared = true
    }) as unknown as typeof globalThis.clearTimeout,
  }

  async function setClock(target: number): Promise<void> {
    clock = target
    vi.setSystemTime(target)
  }

  async function fire(t: FakeTimer): Promise<void> {
    if (t.cleared || t.fired) return
    t.fired = true
    await t.callback()
  }

  return {
    factory,
    timers,
    now: () => clock,
    async advance(ms: number) {
      const target = clock + ms
      // Loop: fire any timer whose deadline ≤ target; advancing clock to its
      // exact fire time before invoking the callback so refreshNow's
      // Date.now()-based checks see correct elapsed time.
      while (true) {
        const due = timers.find(
          (t) => !t.cleared && !t.fired && t.scheduledAt + t.ms <= target,
        )
        if (!due) break
        await setClock(due.scheduledAt + due.ms)
        await fire(due)
      }
      await setClock(target)
    },
    async flushPending() {
      const pending = [...timers].reverse().find((t) => !t.cleared && !t.fired)
      if (pending) {
        await setClock(pending.scheduledAt + pending.ms)
        await fire(pending)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedCopilotToken = state.copilotToken
let harness: FakeTimerHarness
let handle: { stop(): void } | null = null

beforeEach(() => {
  state.copilotToken = null
  getCopilotTokenMock.mockReset()
  cacheModelsMock.mockReset()
  cacheModelsMock.mockResolvedValue(undefined)
  harness = createFakeTimers()
})

afterEach(() => {
  if (handle) {
    handle.stop()
    handle = null
  } else {
    // Bump generation + clear state to fully reset module-global
    const h = bootstrap({
      token: "__teardown__",
      refreshInSeconds: 1500,
      timers: createFakeTimers().factory,
    })
    h.stop()
  }
  state.copilotToken = savedCopilotToken
  vi.useRealTimers()
})

function startSentinel(token = "initial-jwt", refreshIn = 1500) {
  handle = bootstrap({
    token,
    refreshInSeconds: refreshIn,
    timers: harness.factory,
  })
  return handle
}

// ===========================================================================
// bootstrap
// ===========================================================================

describe("bootstrap", () => {
  test("writes state.copilotToken; records refresh_in; schedules first tick", () => {
    startSentinel("tok-1", 1500)

    expect(state.copilotToken).toBe("tok-1")
    expect(getLastRefreshInSeconds()).toBe(1500)
    expect(harness.timers).toHaveLength(1)
    expect(harness.timers[0]!.ms).toBe(1440_000)
    expect(_debugSnapshot().pendingTimer).toBe(true)
    expect(_debugSnapshot().mode).toBe("steady")
  })

  test("re-entry: stop old + bump generation + reset failure state", async () => {
    const h1 = startSentinel("tok-1", 1500)
    // Fire first tick → upstream fails → cooldown set
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("fail", 500))
    await harness.flushPending()
    expect(_debugSnapshot().cooldownRemaining).toBeGreaterThan(0)
    const gen1 = _debugSnapshot().generation
    void h1

    handle = bootstrap({
      token: "tok-2",
      refreshInSeconds: 600,
      timers: harness.factory,
    })

    expect(state.copilotToken).toBe("tok-2")
    expect(_debugSnapshot().generation).toBe(gen1 + 1)
    expect(_debugSnapshot().cooldownRemaining).toBe(0)
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(false)
    expect(getLastRefreshInSeconds()).toBe(600)
  })

  test("stop() cancels pending timer", () => {
    const h = startSentinel("tok", 1500)
    expect(_debugSnapshot().pendingTimer).toBe(true)
    h.stop()
    handle = null
    expect(_debugSnapshot().pendingTimer).toBe(false)
    expect(_debugSnapshot().mode).toBe(null)
  })
})

// ===========================================================================
// refreshNow
// ===========================================================================

describe("refreshNow", () => {
  test("attemptedToken short-circuit: state already changed → returns tokenWasUpdated=true, no upstream", async () => {
    startSentinel("current-tok", 1500)
    const r = await refreshNow("llm-401", "old-tok")
    expect(r).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("min-interval: within MIN_REFRESH_INTERVAL_MS of last success → no upstream call", async () => {
    startSentinel("tok-1", 1500)
    const r = await refreshNow("manual")
    expect(r).toEqual({ ok: true, tokenWasUpdated: false, refreshInSeconds: null })
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("single-flight: concurrent attemptedToken short-circuit", async () => {
    startSentinel("fresh-token", 1500)
    const [a, b, c] = await Promise.all([
      refreshNow("llm-401", "stale-token"),
      refreshNow("llm-401", "stale-token"),
      refreshNow("llm-401", "stale-token"),
    ])
    expect(a).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(b).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(c).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("cooldown: after upstream failure → subsequent refreshNow returns ok:false", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("server err", 500))
    await harness.flushPending()
    const cd = _debugSnapshot().cooldownRemaining
    expect(cd).toBeGreaterThan(0)

    getCopilotTokenMock.mockClear()
    const r = await refreshNow("llm-401")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.cooldownMs).toBeGreaterThan(0)
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Sentinel STEADY tick
// ===========================================================================

describe("sentinelTick: STEADY", () => {
  test("scheduled refresh success: updates state + records new refresh_in + reschedules", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 600,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()

    expect(state.copilotToken).toBe("tok-2")
    expect(getLastRefreshInSeconds()).toBe(600)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(540_000)
    expect(cacheModelsMock).toHaveBeenCalled()
  })

  test("scheduled refresh failure: cooldown + forceSteadyAfterCooldown + skip cacheModels", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("fail", 500))
    await harness.flushPending()

    expect(_debugSnapshot().cooldownRemaining).toBeGreaterThan(0)
    expect(_debugSnapshot().consecutiveFailures).toBe(1)
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(true)
    expect(cacheModelsMock).not.toHaveBeenCalled()
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT)
  })

  test("consecutive failures: exponential backoff 5s → 10s → 20s", async () => {
    startSentinel("tok-1", 1500)

    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f1", 500))
    await harness.flushPending()
    expect(_debugSnapshot().consecutiveFailures).toBe(1)
    const cd1 = _debugSnapshot().cooldownRemaining
    expect(cd1).toBeGreaterThan(0)
    expect(cd1).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT)

    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f2", 500))
    await harness.advance(cd1 + 10)
    expect(_debugSnapshot().consecutiveFailures).toBe(2)
    const cd2 = _debugSnapshot().cooldownRemaining
    expect(cd2).toBeGreaterThan(0)
    expect(cd2).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT * 2)

    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f3", 500))
    await harness.advance(cd2 + 10)
    expect(_debugSnapshot().consecutiveFailures).toBe(3)
    const cd3 = _debugSnapshot().cooldownRemaining
    expect(cd3).toBeGreaterThan(0)
    expect(cd3).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT * 4)
  })

  test("after failure cooldown: next tick succeeds → cooldown cleared + back to steady interval", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f1", 500))
    await harness.flushPending()

    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-recovered",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.advance(_debugSnapshot().cooldownRemaining + 10)

    expect(state.copilotToken).toBe("tok-recovered")
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(false)
    expect(getRefreshCooldownRemaining()).toBe(0)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(1440_000)
  })

  test("/models returns 401: triggers sentinel-401 refresh (min-interval blocks upstream)", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    cacheModelsMock.mockRejectedValueOnce(new HTTPError("models 401", 401))
    await harness.flushPending()

    // Scheduled refresh ran once; sentinel-401 hit min-interval (just refreshed)
    expect(getCopilotTokenMock).toHaveBeenCalledTimes(1)
    expect(cacheModelsMock).toHaveBeenCalledTimes(1)
  })

  test("/models 5xx: tick continues, no refresh triggered", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    cacheModelsMock.mockRejectedValueOnce(new Error("server hiccup"))
    await harness.flushPending()

    expect(getCopilotTokenMock).toHaveBeenCalledTimes(1)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(1440_000)
  })

  test("tick fatal (setTimeout throws once): fatal catch reschedules via fallback (I-4)", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })

    const realSetTimeout = harness.factory.setTimeout
    let throwOnce = true
    harness.factory.setTimeout = ((cb: () => unknown, ms: number) => {
      if (throwOnce) {
        throwOnce = false
        throw new Error("setTimeout-induced fatal")
      }
      return realSetTimeout(cb, ms)
    }) as typeof globalThis.setTimeout

    await harness.flushPending()

    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// refresh_in propagation across triggers
// ===========================================================================

describe("refresh_in propagation", () => {
  test("upstream returns new refresh_in → next steady tick uses it", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 600,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()

    expect(getLastRefreshInSeconds()).toBe(600)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(540_000)
  })
})

// ===========================================================================
// generation isolation
// ===========================================================================

describe("generation isolation", () => {
  test("stop() + bootstrap() while old inflight is in flight → old result discarded", async () => {
    startSentinel("tok-1", 1500)

    let resolveOld!: (v: { token: string; refresh_in: number; expires_at: number }) => void
    const oldPromise = new Promise<{ token: string; refresh_in: number; expires_at: number }>(
      (resolve) => {
        resolveOld = resolve
      },
    )
    getCopilotTokenMock.mockReturnValueOnce(oldPromise)

    // Fire first tick — scheduled refresh awaits oldPromise
    void harness.flushPending()
    // Yield microtasks to let the inflight establish
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(_debugSnapshot().hasInflight).toBe(true)

    handle!.stop()
    handle = null
    handle = bootstrap({
      token: "tok-NEW",
      refreshInSeconds: 1500,
      timers: harness.factory,
    })

    expect(state.copilotToken).toBe("tok-NEW")

    // Now resolve the OLD promise — stale generation, result must be discarded
    resolveOld({ token: "tok-OLD-STALE", refresh_in: 1500, expires_at: 9_999_999_999 })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(state.copilotToken).toBe("tok-NEW")
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
  })

  test("stop() + bootstrap() while old inflight fails → no cooldown leak", async () => {
    startSentinel("tok-1", 1500)

    let rejectOld!: (err: unknown) => void
    const oldPromise = new Promise<{ token: string; refresh_in: number; expires_at: number }>(
      (_resolve, reject) => {
        rejectOld = reject
      },
    )
    getCopilotTokenMock.mockReturnValueOnce(oldPromise)

    void harness.flushPending()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(_debugSnapshot().hasInflight).toBe(true)

    handle!.stop()
    handle = null
    handle = bootstrap({
      token: "tok-NEW",
      refreshInSeconds: 1500,
      timers: harness.factory,
    })

    rejectOld(new HTTPError("old failure", 500))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(_debugSnapshot().cooldownRemaining).toBe(0)
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
  })
})

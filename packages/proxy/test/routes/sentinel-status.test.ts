import { describe, expect, test } from "vitest"
import { Hono } from "hono"

import { createSentinelStatusRoute } from "../../src/routes/sentinel-status"

describe("GET /api/sentinel-status", () => {
  test("returns a structured snapshot with counters and live state", async () => {
    const app = new Hono()
    app.route("/api", createSentinelStatusRoute())

    const res = await app.request("/api/sentinel-status")
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    // Top-level live state
    expect(body).toHaveProperty("generation")
    expect(body).toHaveProperty("mode")
    expect(body).toHaveProperty("cooldownRemainingMs")
    expect(body).toHaveProperty("consecutiveFailures")
    expect(body).toHaveProperty("forceSteadyAfterCooldown")
    expect(body).toHaveProperty("lastRefreshInSeconds")
    expect(body).toHaveProperty("lastSuccessAt")
    expect(body).toHaveProperty("hasInflight")
    expect(body).toHaveProperty("pendingTimer")
    expect(body).toHaveProperty("signalScore")

    // Counters
    const counters = body.counters as Record<string, unknown>
    expect(counters).toBeDefined()
    expect(counters).toHaveProperty("refreshRequested")
    expect(counters).toHaveProperty("refreshUpstreamCalls")
    expect(counters).toHaveProperty("refreshSucceededTokenUpdated")
    expect(counters).toHaveProperty("refreshFailed")
    expect(counters).toHaveProperty("llm401TokenExpired")
    expect(counters).toHaveProperty("llm401Other")
    expect(counters).toHaveProperty("cacheModels401")
    expect(counters).toHaveProperty("probingEntered")

    const requested = counters.refreshRequested as Record<string, unknown>
    expect(requested).toEqual(
      expect.objectContaining({
        llm401: expect.any(Number),
        sentinel401: expect.any(Number),
        scheduled: expect.any(Number),
        manual: expect.any(Number),
      }),
    )
  })
})

import { describe, expect, test } from "vitest"

import { authStyleAttempts, buildAuthHeaders } from "../../src/lib/auth-headers"

describe("buildAuthHeaders", () => {
  test("bearer style emits Authorization", () => {
    expect(buildAuthHeaders("sk", "bearer")).toEqual({
      Authorization: "Bearer sk",
      "Content-Type": "application/json",
    })
  })

  test("x-api-key style emits x-api-key + anthropic-version", () => {
    expect(buildAuthHeaders("sk", "x-api-key")).toEqual({
      "x-api-key": "sk",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    })
  })
})

describe("authStyleAttempts", () => {
  test("openai providers only use bearer", () => {
    expect(authStyleAttempts("openai", null)).toEqual(["bearer"])
    expect(authStyleAttempts("openai", "bearer")).toEqual(["bearer"])
    expect(authStyleAttempts("openai", "x-api-key")).toEqual(["bearer"])
  })

  test("anthropic providers honor stored auth_style when set", () => {
    expect(authStyleAttempts("anthropic", "bearer")).toEqual(["bearer"])
    expect(authStyleAttempts("anthropic", "x-api-key")).toEqual(["x-api-key"])
  })

  test("anthropic providers with unknown style try x-api-key first then bearer", () => {
    expect(authStyleAttempts("anthropic", null)).toEqual(["x-api-key", "bearer"])
    expect(authStyleAttempts("anthropic", undefined)).toEqual(["x-api-key", "bearer"])
  })
})

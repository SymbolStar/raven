import { describe, expect, test, beforeEach, afterEach } from "vitest"

import {
  copilotHeaders,
  copilotHeadersForToken,
  githubHeaders,
} from "../../src/lib/api-config"
import { state } from "../../src/lib/state"

const saved = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  vsCodeVersion: state.vsCodeVersion,
  copilotChatVersion: state.copilotChatVersion,
  accountType: state.accountType,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.githubToken = "gh-token"
  state.vsCodeVersion = "1.117.0"
  state.copilotChatVersion = "0.45.1"
  state.accountType = "individual"
})

afterEach(() => {
  state.copilotToken = saved.copilotToken
  state.githubToken = saved.githubToken
  state.vsCodeVersion = saved.vsCodeVersion
  state.copilotChatVersion = saved.copilotChatVersion
  state.accountType = saved.accountType
})

describe("copilotHeaders", () => {
  test("uses x-github-api-version 2025-10-01", () => {
    const headers = copilotHeaders(state)
    expect(headers["x-github-api-version"]).toBe("2025-10-01")
  })

  test("includes x-interaction-type: conversation-panel", () => {
    const headers = copilotHeaders(state)
    expect(headers["x-interaction-type"]).toBe("conversation-panel")
  })

  test("uses configured editor and plugin versions", () => {
    const headers = copilotHeaders(state)
    expect(headers["editor-version"]).toBe("vscode/1.117.0")
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.45.1")
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.45.1")
  })

  test("falls back to 0.45.1 when copilotChatVersion is null", () => {
    state.copilotChatVersion = null
    const headers = copilotHeaders(state)
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.45.1")
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.45.1")
  })

  test("emits stable header set with vision flag added when requested", () => {
    expect(copilotHeaders(state)["copilot-vision-request"]).toBeUndefined()
    expect(copilotHeaders(state, true)["copilot-vision-request"]).toBe("true")
  })
})

describe("githubHeaders", () => {
  test("uses x-github-api-version 2025-10-01", () => {
    expect(githubHeaders(state)["x-github-api-version"]).toBe("2025-10-01")
  })

  test("uses configured editor and plugin versions", () => {
    const headers = githubHeaders(state)
    expect(headers["editor-version"]).toBe("vscode/1.117.0")
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.45.1")
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.45.1")
  })
})

describe("copilotHeadersForToken", () => {
  test("uses caller-supplied token instead of state.copilotToken", () => {
    state.copilotToken = "state-token"
    const headers = copilotHeadersForToken(state, "explicit-token")
    expect(headers.Authorization).toBe("Bearer explicit-token")
  })

  test("ignores state mutation after capture (atomic snapshot)", () => {
    state.copilotToken = "before"
    const captured = state.copilotToken
    state.copilotToken = "after"
    const headers = copilotHeadersForToken(state, captured)
    expect(headers.Authorization).toBe("Bearer before")
  })

  test("null token renders as 'Bearer ' (not literal 'Bearer null')", () => {
    const headers = copilotHeadersForToken(state, null)
    expect(headers.Authorization).toBe("Bearer ")
  })

  test("vision flag adds copilot-vision-request header", () => {
    expect(
      copilotHeadersForToken(state, "tok")["copilot-vision-request"],
    ).toBeUndefined()
    expect(
      copilotHeadersForToken(state, "tok", true)["copilot-vision-request"],
    ).toBe("true")
  })

  test("copilotHeaders is a thin wrapper that delegates to copilotHeadersForToken", () => {
    state.copilotToken = "wrap-token"
    const direct = copilotHeadersForToken(state, "wrap-token")
    const wrapped = copilotHeaders(state)
    // x-request-id differs per call; everything else must match
    expect({ ...wrapped, "x-request-id": undefined }).toEqual({
      ...direct,
      "x-request-id": undefined,
    })
  })
})

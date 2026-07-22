import { describe, expect, test } from "vitest"

import type { RequestContext } from "../../src/core/context"
import { makeCustomResponses, type CustomResponsesUpReq } from "../../src/strategies/custom-responses"
import type { CustomResponsesClient } from "../../src/upstream/custom-responses"
import type { ServerSentEvent } from "../../src/util/sse"

const ctx: RequestContext = {
  requestId: "test", startTime: 0, format: "responses", path: "/v1/responses",
  stream: true, accountName: "test", userAgent: null, anthropicBeta: null,
  sessionId: "test", clientName: "test", clientVersion: null,
}

const req: CustomResponsesUpReq = {
  provider: { id: "carher", name: "CarHer", format: "openai" } as CustomResponsesUpReq["provider"],
  payload: { model: "gpt-5.6-terra", input: "hello", stream: true },
}

function strategy() {
  return makeCustomResponses({ client: { send: async () => ({}) } as unknown as CustomResponsesClient })
}

describe("custom-responses strategy", () => {
  test("uses a standard SSE event name unchanged", () => {
    const stream = strategy()
    const state = stream.initStreamState(req, ctx)
    const chunk: ServerSentEvent = { event: "response.completed", data: "{}", id: null, retry: null }
    expect(stream.adaptChunk(chunk, state, ctx)[0]).toMatchObject({ event: "response.completed" })
  })

  test("uses JSON type when a gateway omits the SSE event field", () => {
    const stream = strategy()
    const state = stream.initStreamState(req, ctx)
    const chunk: ServerSentEvent = {
      event: null,
      data: JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 3 } } }),
      id: null,
      retry: null,
    }
    expect(stream.adaptChunk(chunk, state, ctx)[0]).toMatchObject({ event: "response.completed" })
    expect(stream.describeEndLog({ kind: "stream", req, state }, ctx)).toMatchObject({ inputTokens: 8, outputTokens: 3 })
  })
})

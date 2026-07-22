/** Protocol-preserving Responses strategy for custom OpenAI providers. */

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { CompiledProvider } from "../db/providers"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import type { ServerSentEvent } from "../util/sse"
import {
  extractNonStreamingMeta,
  extractResolvedModel,
  extractUsage,
  isTerminalResponseEvent,
} from "../protocols/responses/stream-state"
import type { ResponsesPayload } from "../upstream/copilot-responses"
import type { CustomResponsesClient } from "../upstream/custom-responses"

export interface CustomResponsesUpReq {
  provider: CompiledProvider
  payload: ResponsesPayload
}

interface StreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ServerSentEvent> {
  return Boolean(value) && typeof (value as AsyncIterable<ServerSentEvent>)[Symbol.asyncIterator] === "function"
}

/** Normalize gateways that encode a Responses event type only in JSON data. */
function resolveEventName(chunk: ServerSentEvent): string | null {
  if (chunk.event) return chunk.event
  try {
    const type = (JSON.parse(chunk.data) as { type?: unknown }).type
    return typeof type === "string" ? type : null
  } catch {
    return null
  }
}

export function makeCustomResponses(deps: { client: CustomResponsesClient }): Strategy<
  CustomResponsesUpReq, CustomResponsesUpReq, unknown, unknown,
  ServerSentEvent, SSEMessage, StreamState
> {
  return {
    name: "custom-responses",
    prepare: (req) => req,
    dispatch: async (up) => {
      const response = await deps.client.send(up)
      return up.payload.stream && isAsyncIterable(response)
        ? { kind: "stream", chunks: response }
        : { kind: "json", body: response }
    },
    adaptJson: (response) => response,
    initStreamState: (req) => ({
      resolvedModel: req.payload.model,
      inputTokens: 0,
      outputTokens: 0,
    }),
    adaptChunk: (chunk, streamState, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: chunk.event, data: chunk.data })
      const eventName = resolveEventName(chunk)
      if (eventName === "response.created") {
        streamState.resolvedModel = extractResolvedModel(chunk.data) ?? streamState.resolvedModel
      }
      if (isTerminalResponseEvent(eventName)) {
        const usage = extractUsage(chunk.data)
        if (usage) {
          streamState.inputTokens = usage.inputTokens
          streamState.outputTokens = usage.outputTokens
        }
      }
      const event: SSEMessage = { data: chunk.data }
      if (eventName) event.event = eventName
      if (chunk.id) event.id = chunk.id
      if (chunk.retry !== null) event.retry = chunk.retry
      return [event]
    },
    adaptStreamError: () => [{
      event: "error",
      data: JSON.stringify({ error: { type: "server_error", code: "stream_error", message: "An upstream error occurred during streaming." } }),
    }],
    describeEndLog: (result) => {
      const provider = result.req.provider
      if (result.kind === "json") {
        const meta = extractNonStreamingMeta(result.resp, result.req.payload.model)
        return { model: result.req.payload.model, resolvedModel: meta.resolvedModel, inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, upstream: provider.name, upstreamFormat: provider.format }
      }
      if (result.kind === "stream") {
        return { model: result.req.payload.model, resolvedModel: result.state.resolvedModel, inputTokens: result.state.inputTokens, outputTokens: result.state.outputTokens, upstream: provider.name, upstreamFormat: provider.format }
      }
      return { model: result.req.payload.model, upstream: provider.name, upstreamFormat: provider.format }
    },
  }
}

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { CompiledProvider } from "../../src/db/providers"
import type { ResponsesPayload } from "../../src/upstream/copilot-responses"
import { CustomResponsesClient } from "../../src/upstream/custom-responses"

let fetchSpy: ReturnType<typeof vi.spyOn>
let captured: { url: string; init?: RequestInit & { proxy?: string } }

beforeEach(() => {
  captured = { url: "" }
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
    captured = { url: input.toString(), init: init as RequestInit & { proxy?: string } }
    return Promise.resolve(new Response(JSON.stringify({ id: "resp_1" }), {
      headers: { "content-type": "application/json" },
    }))
  }) as typeof fetch)
})

afterEach(() => fetchSpy.mockRestore())

const provider = {
  id: "carher", name: "CarHer Pro", base_url: "https://cc.auto-link.com.cn/pro/v1///",
  api_key: "sk-test", format: "openai",
} as CompiledProvider

describe("CustomResponsesClient", () => {
  test("forwards the original Responses payload to the provider", async () => {
    const client = new CustomResponsesClient({ getProxyUrl: () => "socks5://127.0.0.1:1080" })
    const payload = {
      model: "gpt-5.6-luna", input: [{ role: "user", content: "hello" }],
      previous_response_id: "resp_previous", tools: [{ type: "function", name: "lookup", parameters: {} }],
    } as ResponsesPayload
    await expect(client.send({ provider, payload })).resolves.toEqual({ id: "resp_1" })
    expect(captured.url).toBe("https://cc.auto-link.com.cn/pro/v1/responses")
    expect(captured.init?.headers).toMatchObject({ Authorization: "Bearer sk-test" })
    expect(JSON.parse(captured.init?.body as string)).toEqual(payload)
    expect(captured.init?.proxy).toBe("socks5://127.0.0.1:1080")
  })

  test("preserves an SSE response for streaming clients", async () => {
    fetchSpy.mockRestore()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "event: response.completed\ndata: {\"response\":{}}\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ))
    const client = new CustomResponsesClient({ getProxyUrl: () => undefined })
    const result = await client.send({ provider, payload: { model: "gpt-5.6-luna", input: "hello", stream: true } as ResponsesPayload })
    expect(Symbol.asyncIterator in (result as object)).toBe(true)
  })

  test("surfaces custom upstream HTTP errors", async () => {
    fetchSpy.mockRestore()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream failed", { status: 502 }))
    const client = new CustomResponsesClient({ getProxyUrl: () => undefined })
    await expect(client.send({ provider, payload: { model: "gpt-5.6-luna", input: "hello" } as ResponsesPayload })).rejects.toThrow("Upstream CarHer Pro returned 502")
  })
})
